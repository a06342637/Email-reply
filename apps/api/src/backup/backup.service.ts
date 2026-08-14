import { Injectable } from "@nestjs/common";
import { hashRaw } from "@node-rs/argon2";
import sodium from "libsodium-wrappers-sumo";
import { randomBytes } from "node:crypto";
import { PrismaService } from "../core/prisma.js";
import { CryptoService } from "../core/crypto.js";
import { AppConfig } from "../core/config.js";
import { AppError } from "../core/http.js";
import { RestoreBarrierService } from "./restore-barrier.service.js";

type BackupEnvelope = {
  magic: "MAILPILOT-BACKUP";
  version: 2;
  salt: string;
  header: string;
  chunks: string[];
};

@Injectable()
export class BackupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: AppConfig,
    private readonly barrier: RestoreBarrierService,
  ) {}

  async export(passphrase: string): Promise<Buffer> {
    this.validatePassphrase(passphrase);
    const data = await this.collect();
    return this.encrypt(data, passphrase);
  }

  async inspect(buffer: Buffer, passphrase: string) {
    const data = await this.decrypt(buffer, passphrase);
    this.validatePayload(data);
    return {
      formatVersion: data.formatVersion,
      appVersion: data.appVersion,
      createdAt: data.createdAt,
      counts: Object.fromEntries(
        Object.entries(data.tables).map(([key, value]) => [
          key,
          Array.isArray(value) ? value.length : value ? 1 : 0,
        ]),
      ),
      mailboxes: (
        data.tables.mailboxes as Array<{
          id: string;
          email: string;
          displayName: string;
          status: string;
          provider?: string;
          microsoftAuthMode?: string;
        }>
      ).map(
        ({ id, email, displayName, status, provider, microsoftAuthMode }) => {
          const normalizedProvider = provider ?? "MICROSOFT";
          return {
            id,
            email,
            displayName,
            status,
            provider: normalizedProvider,
            microsoftAuthMode:
              normalizedProvider === "MICROSOFT"
                ? microsoftAuthMode === "CLIENT_ID_REFRESH_TOKEN"
                  ? "CLIENT_ID_REFRESH_TOKEN"
                  : "MSAL_OAUTH"
                : undefined,
          };
        },
      ),
      tasks: (
        data.tables.tasks as Array<{
          id: string;
          mailboxId: string;
          name: string;
          status: string;
        }>
      ).map(({ id, mailboxId, name, status }) => ({
        id,
        mailboxId,
        name,
        status,
      })),
    };
  }

  async restore(
    buffer: Buffer,
    passphrase: string,
  ): Promise<{ restored: true; mailboxes: number; tasks: number }> {
    const data = await this.decrypt(buffer, passphrase);
    this.validatePayload(data);
    await this.assertTargetCompatible(data);
    const tables = data.tables as Record<string, any>;
    const barrier = await this.barrier.acquire();
    try {
      // The shared barrier is checked immediately before every poll, process
      // and verification job. Existing in-flight work finishes through the
      // normal idempotent verification path; no new send begins during restore.
      await this.barrier.waitForQuiescence();
      await this.prisma.autoReplyTask.updateMany({
        where: { status: { in: ["RUNNING", "INITIALIZING"] } },
        data: { status: "PAUSED", pausedAt: new Date(), nextPollAt: null },
      });
      await this.prisma.transactionalOutbox.deleteMany({
        where: { kind: { in: ["PROCESS_MESSAGE", "VERIFY_SEND"] } },
      });
      await this.prisma.$transaction(
        async (tx) => {
          for (const row of tables.settings ?? []) {
            if (row.key === RestoreBarrierService.settingKey) continue;
            await tx.systemSetting.upsert({
              where: { key: row.key },
              create: row,
              update: { value: row.value },
            });
          }
          for (const row of tables.microsoftConfig
            ? [tables.microsoftConfig]
            : []) {
            const secret = row.clientSecretPlain as string;
            await tx.microsoftAppConfig.upsert({
              where: { id: "singleton" },
              create: {
                id: "singleton",
                clientId: row.clientId,
                clientSecretEncrypted: await this.crypto.encryptString(
                  secret,
                  "microsoft-client-secret",
                ),
                secretExpiresAt: this.date(row.secretExpiresAt),
              },
              update: {
                clientId: row.clientId,
                clientSecretEncrypted: await this.crypto.encryptString(
                  secret,
                  "microsoft-client-secret",
                ),
                secretExpiresAt: this.date(row.secretExpiresAt),
              },
            });
          }
          for (const row of tables.googleConfig ? [tables.googleConfig] : []) {
            const secret = row.clientSecretPlain as string;
            await tx.googleAppConfig.upsert({
              where: { id: "singleton" },
              create: {
                id: "singleton",
                clientId: row.clientId,
                clientSecretEncrypted: await this.crypto.encryptString(
                  secret,
                  "google-client-secret",
                ),
              },
              update: {
                clientId: row.clientId,
                clientSecretEncrypted: await this.crypto.encryptString(
                  secret,
                  "google-client-secret",
                ),
              },
            });
          }
          for (const row of tables.mailboxes ?? []) {
            const mailboxRow = this.withDates(row);
            delete mailboxRow.tokenCachePlain;
            const provider = row.provider === "GOOGLE" ? "GOOGLE" : "MICROSOFT";
            const microsoftAuthMode =
              provider === "MICROSOFT" &&
              row.microsoftAuthMode === "CLIENT_ID_REFRESH_TOKEN"
                ? "CLIENT_ID_REFRESH_TOKEN"
                : "MSAL_OAUTH";
            const microsoftClientId =
              microsoftAuthMode === "CLIENT_ID_REFRESH_TOKEN"
                ? row.microsoftClientId
                : null;
            const restoredMailboxStatus = [
              "CONNECTED",
              "AUTH_REQUIRED",
              "DISABLED",
              "REMOVED",
            ].includes(row.status)
              ? row.status
              : "AUTH_REQUIRED";
            await tx.mailbox.upsert({
              where: { id: row.id },
              create: {
                ...mailboxRow,
                provider,
                microsoftAuthMode,
                microsoftClientId,
                tokenCacheEncrypted: await this.crypto.encryptString(
                  row.tokenCachePlain,
                  provider === "GOOGLE"
                    ? `google-token:${row.id}`
                    : `msal:${row.id}`,
                ),
                status: restoredMailboxStatus,
                createdAt: this.date(row.createdAt)!,
                updatedAt: this.date(row.updatedAt)!,
              },
              update: {
                ...mailboxRow,
                provider,
                microsoftAuthMode,
                microsoftClientId,
                tokenCacheEncrypted: await this.crypto.encryptString(
                  row.tokenCachePlain,
                  provider === "GOOGLE"
                    ? `google-token:${row.id}`
                    : `msal:${row.id}`,
                ),
                status: restoredMailboxStatus,
                createdAt: this.date(row.createdAt)!,
                updatedAt: this.date(row.updatedAt)!,
              },
            });
          }
          for (const row of tables.templates ?? []) {
            const templateRow = this.withDates(row);
            const publishedRevisionId = templateRow.publishedRevisionId;
            templateRow.publishedRevisionId = null;
            await tx.replyTemplate.upsert({
              where: { id: row.id },
              create: templateRow,
              update: templateRow,
            });
            row.__publishedRevisionId = publishedRevisionId;
          }
          for (const row of tables.revisions ?? [])
            await tx.templateRevision.upsert({
              where: { id: row.id },
              create: this.withDates(row),
              update: this.withDates(row),
            });
          for (const row of tables.assets ?? [])
            await tx.templateAsset.upsert({
              where: { id: row.id },
              create: {
                ...this.withDates(row),
                data: Buffer.from(row.dataBase64, "base64"),
                dataBase64: undefined,
              },
              update: {
                ...this.withDates(row),
                data: Buffer.from(row.dataBase64, "base64"),
                dataBase64: undefined,
              },
            });
          for (const row of tables.templates ?? []) {
            if (row.__publishedRevisionId) {
              await tx.replyTemplate.update({
                where: { id: row.id },
                data: { publishedRevisionId: row.__publishedRevisionId },
              });
            }
          }
          for (const row of tables.tasks ?? [])
            await tx.autoReplyTask.upsert({
              where: { id: row.id },
              create: {
                ...this.withDates(row),
                status: row.status === "DELETED" ? "DELETED" : "PAUSED",
                pausedAt:
                  row.status === "DELETED"
                    ? this.date(row.pausedAt)
                    : new Date(),
                nextPollAt: null,
              },
              update: {
                ...this.withDates(row),
                status: row.status === "DELETED" ? "DELETED" : "PAUSED",
                pausedAt:
                  row.status === "DELETED"
                    ? this.date(row.pausedAt)
                    : new Date(),
                nextPollAt: null,
              },
            });
          for (const row of tables.rules ?? [])
            await tx.replyRule.upsert({
              where: { id: row.id },
              create: this.withDates(row),
              update: this.withDates(row),
            });
          for (const row of tables.cursors ?? [])
            await tx.folderCursor.upsert({
              where: {
                mailboxId_folder: {
                  mailboxId: row.mailboxId,
                  folder: row.folder,
                },
              },
              create: {
                ...this.withoutPlainCursorFields(row),
                deltaLinkEncrypted: row.deltaLinkPlain
                  ? await this.crypto.encryptString(
                      row.deltaLinkPlain,
                      `delta:${row.mailboxId}:${row.folder}`,
                    )
                  : null,
                nextLinkEncrypted: row.nextLinkPlain
                  ? await this.crypto.encryptString(
                      row.nextLinkPlain,
                      `delta:${row.mailboxId}:${row.folder}`,
                    )
                  : null,
              },
              update: {
                ...this.withoutPlainCursorFields(row),
                deltaLinkEncrypted: row.deltaLinkPlain
                  ? await this.crypto.encryptString(
                      row.deltaLinkPlain,
                      `delta:${row.mailboxId}:${row.folder}`,
                    )
                  : null,
                nextLinkEncrypted: row.nextLinkPlain
                  ? await this.crypto.encryptString(
                      row.nextLinkPlain,
                      `delta:${row.mailboxId}:${row.folder}`,
                    )
                  : null,
              },
            });
          for (const row of tables.gmailCursors ?? [])
            await tx.gmailCursor.upsert({
              where: { mailboxId: row.mailboxId },
              create: {
                ...this.withoutPlainGmailCursorFields(row),
                historyIdEncrypted: row.historyIdPlain
                  ? await this.crypto.encryptString(
                      row.historyIdPlain,
                      `gmail-history:${row.mailboxId}`,
                    )
                  : null,
                pageTokenEncrypted: row.pageTokenPlain
                  ? await this.crypto.encryptString(
                      row.pageTokenPlain,
                      `gmail-page:${row.mailboxId}`,
                    )
                  : null,
              },
              update: {
                ...this.withoutPlainGmailCursorFields(row),
                historyIdEncrypted: row.historyIdPlain
                  ? await this.crypto.encryptString(
                      row.historyIdPlain,
                      `gmail-history:${row.mailboxId}`,
                    )
                  : null,
                pageTokenEncrypted: row.pageTokenPlain
                  ? await this.crypto.encryptString(
                      row.pageTokenPlain,
                      `gmail-page:${row.mailboxId}`,
                    )
                  : null,
              },
            });
          for (const row of tables.receipts ?? []) {
            if (
              row.ruleId &&
              !(tables.rules ?? []).some(
                (rule: { id: string }) => rule.id === row.ruleId,
              )
            )
              row.ruleId = null;
            if (
              row.templateRevisionId &&
              !(tables.revisions ?? []).some(
                (revision: { id: string }) =>
                  revision.id === row.templateRevisionId,
              )
            )
              row.templateRevisionId = null;
          }
          for (const row of tables.receipts ?? [])
            await tx.messageReceipt.upsert({
              where: { id: row.id },
              create: this.withDates(row),
              update: this.withDates(row),
            });
          for (const row of tables.attempts ?? [])
            await tx.replyAttempt.upsert({
              where: { id: row.id },
              create: this.withDates(row),
              update: this.withDates(row),
            });
          for (const row of tables.processingLogs ?? [])
            await tx.processingLog.upsert({
              where: { id: row.id },
              create: this.withDates(row),
              update: this.withDates(row),
            });
          for (const row of tables.systemLogs ?? [])
            await tx.systemLog.upsert({
              where: { id: row.id },
              create: this.withDates(row),
              update: this.withDates(row),
            });
          for (const row of tables.auditLogs ?? [])
            await tx.auditLog.upsert({
              where: { id: row.id },
              create: { ...this.withDates(row), adminId: null },
              update: { ...this.withDates(row), adminId: null },
            });
          for (const row of tables.alerts ?? [])
            await tx.alert.upsert({
              where: { id: row.id },
              create: this.withDates(row),
              update: this.withDates(row),
            });
          for (const row of tables.webhooks ?? [])
            await tx.webhookEndpoint.upsert({
              where: { id: row.id },
              create: {
                ...this.withDates(row),
                secretEncrypted: await this.crypto.encryptString(
                  row.secretPlain,
                  `webhook:${row.id}`,
                ),
              },
              update: {
                ...this.withDates(row),
                secretEncrypted: await this.crypto.encryptString(
                  row.secretPlain,
                  `webhook:${row.id}`,
                ),
              },
            });
        },
        { timeout: 120_000 },
      );
      return {
        restored: true,
        mailboxes: tables.mailboxes?.length ?? 0,
        tasks: tables.tasks?.length ?? 0,
      };
    } finally {
      await this.barrier.release(barrier.id).catch(() => undefined);
      await this.barrier.resumeQueue().catch(() => undefined);
    }
  }

  private async collect() {
    const [
      microsoftConfig,
      googleConfig,
      mailboxes,
      tasks,
      cursors,
      gmailCursors,
      rules,
      templates,
      revisions,
      assets,
      receipts,
      attempts,
      processingLogs,
      auditLogs,
      alerts,
      webhooks,
      settings,
      systemLogs,
    ] = await this.prisma.$transaction(
      (tx) =>
        Promise.all([
          tx.microsoftAppConfig.findUnique({ where: { id: "singleton" } }),
          tx.googleAppConfig.findUnique({ where: { id: "singleton" } }),
          tx.mailbox.findMany(),
          tx.autoReplyTask.findMany(),
          tx.folderCursor.findMany(),
          tx.gmailCursor.findMany(),
          tx.replyRule.findMany(),
          tx.replyTemplate.findMany(),
          tx.templateRevision.findMany(),
          tx.templateAsset.findMany(),
          tx.messageReceipt.findMany(),
          tx.replyAttempt.findMany(),
          tx.processingLog.findMany(),
          tx.auditLog.findMany(),
          tx.alert.findMany(),
          tx.webhookEndpoint.findMany(),
          tx.systemSetting.findMany(),
          tx.systemLog.findMany(),
        ]),
      { isolationLevel: "RepeatableRead", timeout: 120_000 },
    );
    return {
      formatVersion: 2,
      appVersion: this.config.version,
      createdAt: new Date().toISOString(),
      tables: {
        microsoftConfig: microsoftConfig
          ? {
              clientId: microsoftConfig.clientId,
              secretExpiresAt: microsoftConfig.secretExpiresAt,
              clientSecretPlain: await this.crypto.decryptString(
                microsoftConfig.clientSecretEncrypted,
                "microsoft-client-secret",
              ),
            }
          : null,
        googleConfig: googleConfig
          ? {
              clientId: googleConfig.clientId,
              clientSecretPlain: await this.crypto.decryptString(
                googleConfig.clientSecretEncrypted,
                "google-client-secret",
              ),
            }
          : null,
        mailboxes: await Promise.all(
          mailboxes.map(async ({ tokenCacheEncrypted, ...row }) => ({
            ...row,
            tokenCachePlain: await this.crypto.decryptString(
              tokenCacheEncrypted,
              row.provider === "GOOGLE"
                ? `google-token:${row.id}`
                : `msal:${row.id}`,
            ),
          })),
        ),
        tasks,
        cursors: await Promise.all(
          cursors.map(
            async ({ deltaLinkEncrypted, nextLinkEncrypted, ...row }) => ({
              ...row,
              deltaLinkPlain: deltaLinkEncrypted
                ? await this.crypto.decryptString(
                    deltaLinkEncrypted,
                    `delta:${row.mailboxId}:${row.folder}`,
                  )
                : null,
              nextLinkPlain: nextLinkEncrypted
                ? await this.crypto.decryptString(
                    nextLinkEncrypted,
                    `delta:${row.mailboxId}:${row.folder}`,
                  )
                : null,
            }),
          ),
        ),
        gmailCursors: await Promise.all(
          gmailCursors.map(
            async ({ historyIdEncrypted, pageTokenEncrypted, ...row }) => ({
              ...row,
              historyIdPlain: historyIdEncrypted
                ? await this.crypto.decryptString(
                    historyIdEncrypted,
                    `gmail-history:${row.mailboxId}`,
                  )
                : null,
              pageTokenPlain: pageTokenEncrypted
                ? await this.crypto.decryptString(
                    pageTokenEncrypted,
                    `gmail-page:${row.mailboxId}`,
                  )
                : null,
            }),
          ),
        ),
        rules,
        templates,
        revisions,
        assets: assets.map(({ data: bytes, ...row }) => ({
          ...row,
          dataBase64: Buffer.from(bytes).toString("base64"),
        })),
        receipts,
        attempts,
        processingLogs,
        auditLogs,
        systemLogs,
        alerts,
        webhooks: await Promise.all(
          webhooks.map(async ({ secretEncrypted, ...row }) => ({
            ...row,
            secretPlain: await this.crypto.decryptString(
              secretEncrypted,
              `webhook:${row.id}`,
            ),
          })),
        ),
        settings: settings.filter(
          (row) => row.key !== RestoreBarrierService.settingKey,
        ),
      },
    };
  }

  private async encrypt(value: unknown, passphrase: string): Promise<Buffer> {
    await sodium.ready;
    const salt = randomBytes(16);
    const key = await hashRaw(passphrase, {
      salt,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
      outputLen: 32,
    });
    const { state, header } =
      sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
    const plain = Buffer.from(JSON.stringify(value));
    const chunks: string[] = [];
    // Chunking keeps memory bounded for backups containing many attachments;
    // every chunk is authenticated and the final tag authenticates EOF.
    const chunkSize = 1024 * 1024;
    for (
      let offset = 0;
      offset < plain.length || offset === 0;
      offset += chunkSize
    ) {
      const end = Math.min(plain.length, offset + chunkSize);
      const final = end >= plain.length;
      const cipher = sodium.crypto_secretstream_xchacha20poly1305_push(
        state,
        plain.subarray(offset, end),
        null,
        final
          ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
          : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE,
      );
      chunks.push(Buffer.from(cipher).toString("base64url"));
      if (final) break;
    }
    const envelope: BackupEnvelope = {
      magic: "MAILPILOT-BACKUP",
      version: 2,
      salt: salt.toString("base64url"),
      header: Buffer.from(header).toString("base64url"),
      chunks,
    };
    return Buffer.from(JSON.stringify(envelope));
  }

  private async decrypt(buffer: Buffer, passphrase: string): Promise<any> {
    this.validatePassphrase(passphrase);
    await sodium.ready;
    let envelope: BackupEnvelope;
    try {
      envelope = JSON.parse(buffer.toString("utf8")) as BackupEnvelope;
    } catch {
      throw new AppError("BACKUP_INVALID", "备份文件格式无效", 400);
    }
    if (envelope.magic !== "MAILPILOT-BACKUP" || envelope.version !== 2)
      throw new AppError(
        "BACKUP_VERSION_UNSUPPORTED",
        "不支持的备份格式版本",
        400,
      );
    try {
      const salt = Buffer.from(envelope.salt, "base64url");
      const key = await hashRaw(passphrase, {
        salt,
        memoryCost: 65_536,
        timeCost: 3,
        parallelism: 1,
        outputLen: 32,
      });
      if (!Array.isArray(envelope.chunks) || !envelope.chunks.length)
        throw new Error("backup chunks missing");
      const state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(
        Buffer.from(envelope.header, "base64url"),
        key,
      );
      const plainChunks: Buffer[] = [];
      let final = false;
      for (const encoded of envelope.chunks) {
        if (final) throw new Error("data after final chunk");
        const result = sodium.crypto_secretstream_xchacha20poly1305_pull(
          state,
          Buffer.from(encoded, "base64url"),
          null,
        );
        plainChunks.push(Buffer.from(result.message));
        final =
          result.tag === sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL;
      }
      if (!final) throw new Error("final chunk missing");
      const parsed = JSON.parse(
        Buffer.concat(plainChunks).toString("utf8"),
      ) as any;
      if (!parsed || typeof parsed !== "object" || !parsed.tables)
        throw new Error("backup payload invalid");
      if (parsed.formatVersion !== 2)
        throw new Error("backup payload version unsupported");
      return parsed;
    } catch {
      throw new AppError(
        "BACKUP_DECRYPT_FAILED",
        "备份口令错误或文件已损坏",
        400,
      );
    }
  }

  private validatePassphrase(value: string): void {
    if (!value || value.length < 12)
      throw new AppError(
        "BACKUP_PASSPHRASE_WEAK",
        "备份口令至少需要 12 个字符",
        400,
      );
  }

  private validatePayload(data: any): void {
    const tables = data?.tables as Record<string, unknown> | undefined;
    if (!tables) throw new AppError("BACKUP_INVALID", "备份内容无效", 400);
    const requiredArrays = [
      "mailboxes",
      "tasks",
      "cursors",
      "rules",
      "templates",
      "revisions",
      "assets",
      "receipts",
      "attempts",
      "processingLogs",
      "auditLogs",
      "systemLogs",
      "alerts",
      "webhooks",
      "settings",
    ];
    for (const key of requiredArrays) {
      if (!Array.isArray(tables[key]))
        throw new AppError("BACKUP_INVALID", `备份缺少有效数据表：${key}`, 400);
    }
    if (
      tables.gmailCursors !== undefined &&
      !Array.isArray(tables.gmailCursors)
    )
      throw new AppError("BACKUP_INVALID", "备份包含无效的 Gmail 游标表", 400);

    const rows = (key: string) => tables[key] as Array<Record<string, any>>;
    const duplicates = (values: string[]) =>
      values.filter((value, index) => values.indexOf(value) !== index);
    const duplicateIds = duplicates(
      [
        ...requiredArrays,
        ...(tables.gmailCursors ? ["gmailCursors"] : []),
      ].flatMap((key) =>
        rows(key).map((row) => `${key}:${String(row.id ?? row.key ?? "")}`),
      ),
    );
    if (duplicateIds.length)
      throw new AppError(
        "BACKUP_DUPLICATE_IDS",
        "备份中存在重复记录，无法安全恢复",
        400,
      );

    const mailboxIds = new Set(rows("mailboxes").map((row) => row.id));
    const mailboxProviders = new Map(
      rows("mailboxes").map((row) => [
        row.id,
        row.provider === "GOOGLE" ? "GOOGLE" : "MICROSOFT",
      ]),
    );
    const taskIds = new Set(rows("tasks").map((row) => row.id));
    const templateIds = new Set(rows("templates").map((row) => row.id));
    const revisionIds = new Set(rows("revisions").map((row) => row.id));
    const ruleIds = new Set(rows("rules").map((row) => row.id));
    const receiptIds = new Set(rows("receipts").map((row) => row.id));
    for (const row of rows("mailboxes")) {
      const provider = row.provider ?? "MICROSOFT";
      if (!["MICROSOFT", "GOOGLE"].includes(provider))
        throw new AppError(
          "BACKUP_PROVIDER_INVALID",
          "备份包含不支持的邮箱提供商",
          400,
        );
      if (typeof row.tokenCachePlain !== "string")
        throw new AppError(
          "BACKUP_TOKEN_INVALID",
          "备份中的邮箱授权缓存无效",
          400,
        );
      const microsoftAuthMode = row.microsoftAuthMode ?? "MSAL_OAUTH";
      if (
        !["MSAL_OAUTH", "CLIENT_ID_REFRESH_TOKEN"].includes(
          microsoftAuthMode,
        ) ||
        (provider === "GOOGLE" &&
          microsoftAuthMode === "CLIENT_ID_REFRESH_TOKEN")
      )
        throw new AppError(
          "BACKUP_MICROSOFT_AUTH_MODE_INVALID",
          "备份包含无效的 Microsoft 授权方式",
          400,
        );
      if (microsoftAuthMode === "CLIENT_ID_REFRESH_TOKEN") {
        if (
          typeof row.microsoftClientId !== "string" ||
          !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
            row.microsoftClientId,
          )
        )
          throw new AppError(
            "BACKUP_MICROSOFT_CLIENT_ID_INVALID",
            "备份中的 Microsoft Client ID 无效",
            400,
          );
        try {
          const token = JSON.parse(row.tokenCachePlain) as {
            version?: unknown;
            refreshToken?: unknown;
            scope?: unknown;
          };
          if (
            token.version !== 1 ||
            typeof token.refreshToken !== "string" ||
            !token.refreshToken ||
            typeof token.scope !== "string"
          )
            throw new Error("invalid token cache");
        } catch {
          throw new AppError(
            "BACKUP_TOKEN_INVALID",
            "备份中的 Microsoft Refresh Token 授权缓存无效",
            400,
          );
        }
      }
    }
    const requireReference = (
      source: string,
      row: Record<string, any>,
      field: string,
      targets: Set<unknown>,
      optional = false,
    ) => {
      const value = row[field];
      if ((value === null || value === undefined) && optional) return;
      if (!targets.has(value))
        throw new AppError(
          "BACKUP_REFERENCE_INVALID",
          `备份关联无效：${source}.${field}`,
          400,
        );
    };
    for (const row of rows("tasks")) {
      requireReference("tasks", row, "mailboxId", mailboxIds);
      requireReference("tasks", row, "defaultTemplateId", templateIds, true);
    }
    for (const row of rows("cursors")) {
      requireReference("cursors", row, "mailboxId", mailboxIds);
      if (mailboxProviders.get(row.mailboxId) !== "MICROSOFT")
        throw new AppError(
          "BACKUP_PROVIDER_CURSOR_MISMATCH",
          "Google 邮箱不能恢复 Microsoft Delta 游标",
          400,
        );
    }
    for (const row of (tables.gmailCursors ?? []) as Array<
      Record<string, any>
    >) {
      requireReference("gmailCursors", row, "mailboxId", mailboxIds);
      if (mailboxProviders.get(row.mailboxId) !== "GOOGLE")
        throw new AppError(
          "BACKUP_PROVIDER_CURSOR_MISMATCH",
          "Microsoft 邮箱不能恢复 Gmail History 游标",
          400,
        );
    }
    for (const row of rows("revisions"))
      requireReference("revisions", row, "templateId", templateIds);
    for (const row of rows("assets"))
      requireReference("assets", row, "revisionId", revisionIds);
    for (const row of rows("rules")) {
      requireReference("rules", row, "taskId", taskIds);
      requireReference("rules", row, "templateId", templateIds);
    }
    for (const row of rows("templates"))
      requireReference(
        "templates",
        row,
        "publishedRevisionId",
        revisionIds,
        true,
      );
    for (const row of rows("receipts")) {
      requireReference("receipts", row, "mailboxId", mailboxIds);
      requireReference("receipts", row, "taskId", taskIds);
      requireReference("receipts", row, "ruleId", ruleIds, true);
      requireReference(
        "receipts",
        row,
        "templateRevisionId",
        revisionIds,
        true,
      );
    }
    for (const row of rows("attempts"))
      requireReference("attempts", row, "receiptId", receiptIds);
  }

  private async assertTargetCompatible(data: any): Promise<void> {
    const tables = data.tables as Record<string, any[]>;
    const incomingMailboxes = new Map(
      (tables.mailboxes ?? []).map((row) => [
        String(row.email).trim().toLowerCase(),
        String(row.id),
      ]),
    );
    const incomingTasks = new Map(
      (tables.tasks ?? []).map((row) => [
        String(row.mailboxId),
        String(row.id),
      ]),
    );
    const incomingTracking = new Map(
      (tables.receipts ?? []).map((row) => [
        String(row.trackingId),
        String(row.id),
      ]),
    );
    const incomingWebhookNames = new Map(
      (tables.webhooks ?? []).map((row) => [String(row.name), String(row.id)]),
    );

    const [mailboxes, tasks, receipts, webhooks] = await Promise.all([
      this.prisma.mailbox.findMany({ select: { id: true, email: true } }),
      this.prisma.autoReplyTask.findMany({
        select: { id: true, mailboxId: true },
      }),
      this.prisma.messageReceipt.findMany({
        select: { id: true, trackingId: true },
      }),
      this.prisma.webhookEndpoint.findMany({
        select: { id: true, name: true },
      }),
    ]);
    const conflicts: string[] = [];
    for (const row of mailboxes) {
      const incomingId = incomingMailboxes.get(row.email.trim().toLowerCase());
      if (incomingId && incomingId !== row.id)
        conflicts.push(`邮箱 ${row.email} 已使用不同内部 ID`);
    }
    for (const row of tasks) {
      const incomingId = incomingTasks.get(row.mailboxId);
      if (incomingId && incomingId !== row.id)
        conflicts.push(`邮箱 ${row.mailboxId} 已存在不同任务记录`);
    }
    for (const row of receipts) {
      const incomingId = incomingTracking.get(row.trackingId);
      if (incomingId && incomingId !== row.id)
        conflicts.push(`邮件追踪记录 ${row.trackingId} 冲突`);
    }
    for (const row of webhooks) {
      const incomingId = incomingWebhookNames.get(row.name);
      if (incomingId && incomingId !== row.id)
        conflicts.push(`Webhook 名称 ${row.name} 已使用不同内部 ID`);
    }
    if (conflicts.length)
      throw new AppError(
        "BACKUP_TARGET_CONFLICT",
        "目标服务器存在与备份同名但内部 ID 不同的数据，请先在干净实例恢复，或移除冲突配置后重试",
        409,
        { conflicts: conflicts.slice(0, 20) },
      );
  }

  private date(value: unknown): Date | null {
    return value ? new Date(String(value)) : null;
  }

  private withDates(row: Record<string, any>): any {
    const clean: Record<string, any> = { ...row };
    for (const key of Object.keys(clean)) {
      if ((key.endsWith("At") || key.endsWith("Until")) && clean[key])
        clean[key] = new Date(clean[key]);
      if (
        [
          "tokenCachePlain",
          "deltaLinkPlain",
          "nextLinkPlain",
          "secretPlain",
          "dataBase64",
        ].includes(key)
      )
        delete clean[key];
    }
    return clean;
  }

  private withoutPlainCursorFields(row: Record<string, any>): any {
    const clean = this.withDates(row);
    delete clean.deltaLinkPlain;
    delete clean.nextLinkPlain;
    return clean;
  }

  private withoutPlainGmailCursorFields(row: Record<string, any>): any {
    const clean = this.withDates(row);
    delete clean.historyIdPlain;
    delete clean.pageTokenPlain;
    return clean;
  }
}
