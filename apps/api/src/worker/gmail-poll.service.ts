import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { FolderKind, Prisma } from "@prisma/client";
import type { RuleConditions } from "@autoreply/shared";
import { PrismaService } from "../core/prisma.js";
import { CryptoService } from "../core/crypto.js";
import {
  GmailApiService,
  GoogleApiError,
} from "../google/gmail-api.service.js";
import { AlertService } from "../observability/alert.service.js";
import { ProviderApiError } from "../providers/provider-api.error.js";
import { FilterService, type IncomingMessage } from "./filter.service.js";

type GmailProfile = { emailAddress: string; historyId: string };
type GmailHistoryPage = {
  history?: Array<{
    messagesAdded?: Array<{ message?: { id?: string } }>;
    labelsAdded?: Array<{
      message?: { id?: string };
      labelIds?: string[];
    }>;
  }>;
  nextPageToken?: string;
  historyId?: string;
};
type GmailMessagePage = {
  messages?: Array<{ id: string; threadId?: string }>;
  nextPageToken?: string;
};
type GmailMessage = {
  id: string;
  threadId?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
  };
};
type TaskPayload = NonNullable<
  Awaited<ReturnType<GmailPollService["loadTask"]>>
>;
type PreparedMessage = {
  folder: FolderKind;
  message: IncomingMessage;
  receivedAt: Date;
  senderName: string;
  senderEmail: string;
  replyToEmail: string;
  filterReason?: string;
  rule: TaskPayload["rules"][number] | null;
  revisionId: string | null;
};

const METADATA_HEADERS = [
  "Message-ID",
  "Subject",
  "From",
  "Sender",
  "Reply-To",
  "Return-Path",
  "Auto-Submitted",
  "X-Auto-Response-Suppress",
  "X-AutoReply-Tracking",
  "X-AutoReply-Instance",
  "Content-Type",
  "Disposition-Notification-To",
  "Return-Receipt-To",
  "Original-Recipient",
  "Final-Recipient",
  "Reporting-MTA",
  "List-ID",
  "List-Unsubscribe",
  "Precedence",
];
const MAX_HISTORY_PAGES = 200;
const MAX_SCAN_PAGES = 200;

class GmailPollInactiveError extends Error {}

@Injectable()
export class GmailPollService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly gmail: GmailApiService,
    private readonly filters: FilterService,
    private readonly alerts: AlertService,
  ) {}

  async pollTask(taskId: string): Promise<void> {
    const task = await this.loadTask(taskId);
    if (
      !task ||
      !["INITIALIZING", "RUNNING"].includes(task.status) ||
      task.mailbox.status !== "CONNECTED" ||
      task.mailbox.provider !== "GOOGLE"
    )
      return;
    const startedAt = Date.now();
    await this.prisma.autoReplyTask.update({
      where: { id: task.id },
      data: { lastPollStartedAt: new Date() },
    });
    try {
      await this.pollHistory(task);
      const completedAt = new Date();
      const latency = Date.now() - startedAt;
      await this.prisma.autoReplyTask.updateMany({
        where: {
          id: task.id,
          status: { in: ["INITIALIZING", "RUNNING"] },
          mailbox: { status: "CONNECTED", provider: "GOOGLE" },
        },
        data: {
          status: "RUNNING",
          lastPollCompletedAt: completedAt,
          averagePollLatencyMs: task.averagePollLatencyMs
            ? Math.round(task.averagePollLatencyMs * 0.8 + latency * 0.2)
            : latency,
          nextPollAt: new Date(Date.now() + task.pollIntervalSeconds * 1_000),
          consecutiveFailures: 0,
          circuitOpenedAt: null,
          graphBackoffUntil: null,
        },
      });
      await this.alerts.resolve(`task-poll:${task.id}`);
      await this.alerts.resolve(`provider-throttle:${task.id}`);
    } catch (error) {
      if (error instanceof GmailPollInactiveError) return;
      const failures = task.consecutiveFailures + 1;
      const retryAfter =
        error instanceof ProviderApiError ? error.retryAfterSeconds : undefined;
      const [latestMailbox, latestTask] = await Promise.all([
        this.prisma.mailbox.findUnique({
          where: { id: task.mailboxId },
          select: { status: true },
        }),
        this.prisma.autoReplyTask.findUnique({
          where: { id: task.id },
          select: { status: true },
        }),
      ]);
      if (
        !latestTask ||
        !["INITIALIZING", "RUNNING"].includes(latestTask.status) ||
        latestMailbox?.status !== "CONNECTED"
      )
        return;
      const authentication = this.isAuthenticationError(error);
      const openCircuit = !authentication && failures >= 8;
      const delaySeconds = retryAfter ?? Math.min(300, 2 ** failures);
      await this.prisma.autoReplyTask.updateMany({
        where: { id: task.id, status: { in: ["INITIALIZING", "RUNNING"] } },
        data: {
          status: openCircuit ? "CIRCUIT_OPEN" : task.status,
          consecutiveFailures: failures,
          circuitOpenedAt: openCircuit ? new Date() : null,
          nextPollAt:
            openCircuit || authentication
              ? null
              : new Date(Date.now() + delaySeconds * 1_000),
          graphBackoffUntil: retryAfter
            ? new Date(Date.now() + retryAfter * 1_000)
            : null,
        },
      });
      if (error instanceof ProviderApiError && error.status === 429)
        await this.alerts.open({
          fingerprint: `provider-throttle:${task.id}`,
          type: "PROVIDER_THROTTLED",
          severity: "WARNING",
          title: "Gmail API 正在限流",
          message:
            "系统已遵守 Retry-After 暂停此任务，请降低检测频率或等待 Google 限流恢复。",
          metadata: {
            provider: "GOOGLE",
            taskId: task.id,
            mailboxId: task.mailboxId,
            retryAfterSeconds: retryAfter ?? null,
          },
        });
      if (openCircuit)
        await this.alerts.open({
          fingerprint: `task-poll:${task.id}`,
          type: "TASK_CIRCUIT_OPEN",
          severity: "CRITICAL",
          title: "自动回复任务已熔断",
          message:
            "邮件检测连续失败，任务已停止，请检查 Google 授权和系统日志。",
          metadata: {
            provider: "GOOGLE",
            taskId: task.id,
            mailboxId: task.mailboxId,
          },
        });
      throw error;
    }
  }

  private loadTask(taskId: string) {
    return this.prisma.autoReplyTask.findUnique({
      where: { id: taskId },
      include: {
        mailbox: true,
        defaultTemplate: { include: { publishedRevision: true } },
        rules: {
          where: { enabled: true },
          orderBy: { priority: "asc" },
          include: { template: { include: { publishedRevision: true } } },
        },
      },
    });
  }

  private async pollHistory(task: TaskPayload): Promise<void> {
    await this.assertRestoreOpen();
    await this.assertTaskActive(task.id);
    const cursor = await this.prisma.gmailCursor.upsert({
      where: { mailboxId: task.mailboxId },
      create: { mailboxId: task.mailboxId },
      update: {},
    });
    if (!cursor.historyIdEncrypted) {
      await this.initialize(task, cursor.highWaterAt);
      return;
    }
    if (!cursor.initializedAt) {
      const baseline = await this.crypto.decryptString(
        cursor.historyIdEncrypted,
        this.historyContext(task.mailboxId),
      );
      await this.scanWindow(
        task,
        cursor.highWaterAt ?? task.activationAt ?? new Date(),
        baseline,
        cursor.pageTokenEncrypted,
      );
      return;
    }

    const startHistoryId = await this.crypto.decryptString(
      cursor.historyIdEncrypted,
      this.historyContext(task.mailboxId),
    );
    let pageToken = cursor.pageTokenEncrypted
      ? await this.crypto.decryptString(
          cursor.pageTokenEncrypted,
          this.pageContext(task.mailboxId),
        )
      : undefined;
    let pages = 0;
    let restartedWithoutPageToken = false;
    while (true) {
      if (pages++ >= MAX_HISTORY_PAGES)
        throw new Error("Gmail history pagination exceeded safety limit");
      await this.assertRestoreOpen();
      await this.assertTaskActive(task.id);
      const params = new URLSearchParams({ startHistoryId, maxResults: "100" });
      params.append("historyTypes", "messageAdded");
      params.append("historyTypes", "labelAdded");
      if (pageToken) params.set("pageToken", pageToken);
      let page: GmailHistoryPage;
      try {
        page = await this.gmail.request<GmailHistoryPage>(
          task.mailboxId,
          `/history?${params.toString()}`,
          {},
          { maxRetries: 3, expected: [200] },
        );
      } catch (error) {
        if (
          pageToken &&
          !restartedWithoutPageToken &&
          this.isInvalidPageToken(error)
        ) {
          restartedWithoutPageToken = true;
          pageToken = undefined;
          pages = 0;
          await this.prisma.gmailCursor.update({
            where: { mailboxId: task.mailboxId },
            data: { pageTokenEncrypted: null },
          });
          continue;
        }
        if (
          error instanceof GoogleApiError &&
          error.status === 404 &&
          /history|notFound|invalidArgument/i.test(
            `${error.code} ${error.message}`,
          )
        ) {
          await this.recoverCursor(task, cursor.lastSuccessfulAt);
          return;
        }
        throw error;
      }
      const ids = this.historyMessageIds(page);
      const messages = await this.fetchMessages(task.mailboxId, ids);
      const next = page.nextPageToken;
      const finalHistoryId = page.historyId || startHistoryId;
      await this.ingestPage(task, messages, {
        historyIdEncrypted: next
          ? undefined
          : await this.crypto.encryptString(
              finalHistoryId,
              this.historyContext(task.mailboxId),
            ),
        pageTokenEncrypted: next
          ? await this.crypto.encryptString(
              next,
              this.pageContext(task.mailboxId),
            )
          : null,
        initializedAt: cursor.initializedAt,
        lastSuccessfulAt: next ? undefined : new Date(),
      });
      if (!next) break;
      pageToken = next;
    }
  }

  private async initialize(
    task: TaskPayload,
    resumeFrom: Date | null,
  ): Promise<void> {
    const profile = await this.gmail.request<GmailProfile>(
      task.mailboxId,
      "/profile",
      {},
      { maxRetries: 3, expected: [200] },
    );
    const from = resumeFrom ?? task.activationAt ?? new Date();
    await this.prisma.gmailCursor.update({
      where: { mailboxId: task.mailboxId },
      data: {
        historyIdEncrypted: await this.crypto.encryptString(
          profile.historyId,
          this.historyContext(task.mailboxId),
        ),
        pageTokenEncrypted: null,
        initializedAt: null,
        highWaterAt: from,
      },
    });
    await this.scanWindow(task, from, profile.historyId, null);
  }

  private async recoverCursor(
    task: TaskPayload,
    lastSuccessfulAt: Date | null,
  ): Promise<void> {
    const profile = await this.gmail.request<GmailProfile>(
      task.mailboxId,
      "/profile",
      {},
      { maxRetries: 3, expected: [200] },
    );
    const overlapStart = new Date(
      Math.max(
        task.activationAt?.getTime() ?? Date.now(),
        (lastSuccessfulAt?.getTime() ??
          task.activationAt?.getTime() ??
          Date.now()) -
          5 * 60_000,
      ),
    );
    await this.prisma.gmailCursor.update({
      where: { mailboxId: task.mailboxId },
      data: {
        historyIdEncrypted: await this.crypto.encryptString(
          profile.historyId,
          this.historyContext(task.mailboxId),
        ),
        pageTokenEncrypted: null,
        initializedAt: null,
        highWaterAt: overlapStart,
      },
    });
    await this.scanWindow(task, overlapStart, profile.historyId, null);
  }

  private async scanWindow(
    task: TaskPayload,
    from: Date,
    baselineHistoryId: string,
    encryptedPageToken: string | null,
  ): Promise<void> {
    let pageToken = encryptedPageToken
      ? await this.crypto.decryptString(
          encryptedPageToken,
          this.pageContext(task.mailboxId),
        )
      : undefined;
    let pages = 0;
    let restartedWithoutPageToken = false;
    while (true) {
      if (pages++ >= MAX_SCAN_PAGES)
        throw new Error("Gmail recovery scan pagination exceeded safety limit");
      await this.assertRestoreOpen();
      await this.assertTaskActive(task.id);
      const params = new URLSearchParams({
        maxResults: "100",
        includeSpamTrash: "true",
        q: `after:${Math.max(0, Math.floor(from.getTime() / 1_000) - 1)} {in:inbox in:spam}`,
      });
      if (pageToken) params.set("pageToken", pageToken);
      let page: GmailMessagePage;
      try {
        page = await this.gmail.request<GmailMessagePage>(
          task.mailboxId,
          `/messages?${params.toString()}`,
          {},
          { maxRetries: 3, expected: [200] },
        );
      } catch (error) {
        if (
          pageToken &&
          !restartedWithoutPageToken &&
          this.isInvalidPageToken(error)
        ) {
          restartedWithoutPageToken = true;
          pageToken = undefined;
          pages = 0;
          await this.prisma.gmailCursor.update({
            where: { mailboxId: task.mailboxId },
            data: { pageTokenEncrypted: null },
          });
          continue;
        }
        throw error;
      }
      const messages = await this.fetchMessages(
        task.mailboxId,
        (page.messages ?? []).map((message) => message.id),
      );
      const next = page.nextPageToken;
      await this.ingestPage(task, messages, {
        historyIdEncrypted: next
          ? undefined
          : await this.crypto.encryptString(
              baselineHistoryId,
              this.historyContext(task.mailboxId),
            ),
        pageTokenEncrypted: next
          ? await this.crypto.encryptString(
              next,
              this.pageContext(task.mailboxId),
            )
          : null,
        initializedAt: next ? undefined : new Date(),
        lastSuccessfulAt: next ? undefined : new Date(),
        recoveryScan: true,
      });
      if (!next) break;
      pageToken = next;
    }
  }

  private historyMessageIds(page: GmailHistoryPage): string[] {
    const ids = new Set<string>();
    for (const item of page.history ?? []) {
      for (const added of item.messagesAdded ?? []) {
        if (added.message?.id) ids.add(added.message.id);
      }
      for (const labeled of item.labelsAdded ?? []) {
        if (
          labeled.message?.id &&
          labeled.labelIds?.some((label) => ["INBOX", "SPAM"].includes(label))
        )
          ids.add(labeled.message.id);
      }
    }
    return [...ids];
  }

  private async fetchMessages(
    mailboxId: string,
    ids: string[],
  ): Promise<Array<{ folder: FolderKind; message: IncomingMessage }>> {
    const results: Array<{ folder: FolderKind; message: IncomingMessage }> = [];
    for (let offset = 0; offset < ids.length; offset += 5) {
      const batch = await Promise.all(
        ids.slice(offset, offset + 5).map(async (id) => {
          try {
            const metadata = await this.gmail.request<GmailMessage>(
              mailboxId,
              `/messages/${encodeURIComponent(id)}?${this.metadataParams()}`,
              {},
              { maxRetries: 3, expected: [200] },
            );
            return this.toIncoming(metadata);
          } catch (error) {
            if (error instanceof GoogleApiError && error.status === 404)
              return null;
            throw error;
          }
        }),
      );
      for (const item of batch) if (item) results.push(item);
    }
    return results;
  }

  private metadataParams(): string {
    const params = new URLSearchParams({ format: "metadata" });
    for (const name of METADATA_HEADERS) params.append("metadataHeaders", name);
    return params.toString();
  }

  private toIncoming(
    source: GmailMessage,
  ): { folder: FolderKind; message: IncomingMessage } | null {
    const labels = new Set(source.labelIds ?? []);
    const folder: FolderKind | null = labels.has("SPAM")
      ? "JUNKEMAIL"
      : labels.has("INBOX")
        ? "INBOX"
        : null;
    if (!folder || !source.id || !source.internalDate) return null;
    const receivedAt = new Date(Number(source.internalDate));
    if (!Number.isFinite(receivedAt.getTime())) return null;
    const headers = source.payload?.headers ?? [];
    const header = (name: string) =>
      headers.find((item) => item.name.toLowerCase() === name.toLowerCase())
        ?.value;
    const from = this.parseAddress(header("From") || header("Sender") || "");
    const sender = this.parseAddress(header("Sender") || header("From") || "");
    const replyTo = this.parseAddress(header("Reply-To") || "");
    return {
      folder,
      message: {
        id: source.id,
        internetMessageId: header("Message-ID")?.trim() || null,
        conversationId: source.threadId || null,
        subject: this.decodeHeader(header("Subject") || ""),
        receivedDateTime: receivedAt.toISOString(),
        from: { emailAddress: from },
        sender: { emailAddress: sender },
        replyTo: replyTo.address ? [{ emailAddress: replyTo }] : [],
        internetMessageHeaders: headers,
      },
    };
  }

  private async ingestPage(
    task: TaskPayload,
    messages: Array<{ folder: FolderKind; message: IncomingMessage }>,
    cursor: {
      historyIdEncrypted?: string;
      pageTokenEncrypted: string | null;
      initializedAt?: Date | null;
      lastSuccessfulAt?: Date;
      recoveryScan?: boolean;
    },
  ): Promise<void> {
    const prepared = await this.prepareMessages(task, messages);
    const now = new Date();
    await this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<Array<{ status: string }>>`
          SELECT "status"::text AS "status"
          FROM "AutoReplyTask"
          WHERE "id" = ${task.id}
          FOR UPDATE
        `;
        if (!rows[0] || !["INITIALIZING", "RUNNING"].includes(rows[0].status))
          throw new GmailPollInactiveError();
        for (const item of prepared) {
          const message = item.message;
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${task.mailboxId}:message:${message.id}`}))`;
          if (message.internetMessageId) {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${task.mailboxId}:${message.internetMessageId}`}))`;
          }
          const duplicate = await tx.messageReceipt.findFirst({
            where: {
              mailboxId: task.mailboxId,
              OR: [
                { graphMessageId: message.id },
                ...(message.internetMessageId
                  ? [{ internetMessageId: message.internetMessageId }]
                  : []),
              ],
            },
            select: { id: true },
          });
          if (duplicate) continue;
          const receipt = await tx.messageReceipt.create({
            data: {
              mailboxId: task.mailboxId,
              taskId: task.id,
              graphMessageId: message.id,
              internetMessageId: message.internetMessageId,
              conversationId: message.conversationId,
              folder: item.folder,
              senderName: item.senderName,
              senderEmail: item.senderEmail || "unknown",
              replyToEmail: item.replyToEmail || null,
              subject: (message.subject || "(无主题)").slice(0, 998),
              receivedAt: item.receivedAt,
              state: item.filterReason ? "FILTERED" : "QUEUED",
              filterReason: item.filterReason,
              ruleId: item.rule?.id,
              templateRevisionId: item.filterReason ? null : item.revisionId,
              trackingId: randomUUID(),
              completedAt: item.filterReason ? now : null,
            },
          });
          await tx.processingLog.create({
            data: {
              mailboxId: task.mailboxId,
              mailboxEmail: task.mailbox.email,
              receiptId: receipt.id,
              event: item.filterReason ? "MESSAGE_FILTERED" : "MESSAGE_QUEUED",
              senderEmail: item.senderEmail,
              subject: receipt.subject,
              folder: item.folder,
              ruleName: item.rule?.name,
              templateName:
                item.rule?.template.name ?? task.defaultTemplate?.name,
              status: receipt.state,
              reason: item.filterReason,
            },
          });
          if (!item.filterReason)
            await tx.transactionalOutbox.create({
              data: {
                kind: "PROCESS_MESSAGE",
                aggregateId: receipt.id,
                dedupeKey: `process:${receipt.id}`,
                payload: { receiptId: receipt.id } as Prisma.InputJsonValue,
              },
            });
        }
        const pageHighWater = prepared.reduce<Date | null>(
          (latest, item) =>
            !latest || item.receivedAt > latest ? item.receivedAt : latest,
          null,
        );
        const stored = pageHighWater
          ? await tx.gmailCursor.findUnique({
              where: { mailboxId: task.mailboxId },
              select: { highWaterAt: true },
            })
          : null;
        await tx.gmailCursor.update({
          where: { mailboxId: task.mailboxId },
          data: {
            ...(cursor.historyIdEncrypted !== undefined
              ? { historyIdEncrypted: cursor.historyIdEncrypted }
              : {}),
            pageTokenEncrypted: cursor.pageTokenEncrypted,
            ...(cursor.initializedAt !== undefined
              ? { initializedAt: cursor.initializedAt }
              : {}),
            ...(cursor.lastSuccessfulAt
              ? { lastSuccessfulAt: cursor.lastSuccessfulAt }
              : {}),
            highWaterAt:
              pageHighWater &&
              (!cursor.recoveryScan || cursor.initializedAt instanceof Date) &&
              (!stored?.highWaterAt || pageHighWater > stored.highWaterAt)
                ? pageHighWater
                : undefined,
          },
        });
      },
      { timeout: 60_000 },
    );
  }

  private async prepareMessages(
    task: TaskPayload,
    messages: Array<{ folder: FolderKind; message: IncomingMessage }>,
  ): Promise<PreparedMessage[]> {
    const prepared: PreparedMessage[] = [];
    for (const item of messages) {
      const message = item.message;
      if (!message.id || message["@removed"] || !message.receivedDateTime)
        continue;
      const receivedAt = new Date(message.receivedDateTime);
      if (!Number.isFinite(receivedAt.getTime())) continue;
      const filter = await this.filters.evaluate(message, task.mailbox.email);
      let filterReason = filter.skip;
      if (!filterReason && receivedAt < (task.activationAt ?? receivedAt))
        filterReason = "BEFORE_TASK_ACTIVATION";
      let rule: TaskPayload["rules"][number] | null = null;
      if (!filterReason)
        rule =
          task.rules.find((candidate) =>
            this.filters.matchRule(
              message,
              filter.senderEmail,
              item.folder === "INBOX" ? "inbox" : "junkemail",
              candidate.conditions as RuleConditions,
            ),
          ) ?? null;
      const revisionId =
        rule?.template.publishedRevisionId ??
        task.defaultTemplate?.publishedRevisionId ??
        null;
      if (!filterReason && !revisionId) filterReason = "NO_PUBLISHED_TEMPLATE";
      prepared.push({
        folder: item.folder,
        message,
        receivedAt,
        senderName: filter.senderName,
        senderEmail: filter.senderEmail,
        replyToEmail: filter.replyToEmail,
        filterReason,
        rule,
        revisionId,
      });
    }
    return prepared;
  }

  private parseAddress(value: string): { name: string; address: string } {
    const normalized = value.replace(/[\r\n]/g, " ").trim();
    const angle = normalized.match(/^(.*?)<\s*([^<>\s]+@[^<>\s]+)\s*>/);
    const bare = normalized.match(/([^\s<>,;]+@[^\s<>,;]+)/);
    const address = (angle?.[2] || bare?.[1] || "")
      .replace(/^mailto:/i, "")
      .trim();
    const rawName = angle?.[1]?.trim().replace(/^"|"$/g, "") || "";
    return { name: this.decodeHeader(rawName), address };
  }

  private decodeHeader(value: string): string {
    return value.replace(
      /=\?([^?]+)\?([bq])\?([^?]*)\?=/gi,
      (_match, charset: string, encoding: string, content: string) => {
        try {
          const bytes =
            encoding.toLowerCase() === "b"
              ? Buffer.from(content, "base64")
              : Buffer.from(
                  content
                    .replace(/_/g, " ")
                    .replace(/=([0-9a-f]{2})/gi, (_m: string, hex: string) =>
                      String.fromCharCode(Number.parseInt(hex, 16)),
                    ),
                  "latin1",
                );
          return /iso-8859-1|latin1/i.test(charset)
            ? bytes.toString("latin1")
            : bytes.toString("utf8");
        } catch {
          return content;
        }
      },
    );
  }

  private historyContext(mailboxId: string): string {
    return `gmail-history:${mailboxId}`;
  }

  private pageContext(mailboxId: string): string {
    return `gmail-page:${mailboxId}`;
  }

  private isInvalidPageToken(error: unknown): boolean {
    return (
      error instanceof GoogleApiError &&
      [400, 404].includes(error.status) &&
      /page.?token|invalid.*token|invalidArgument/i.test(
        `${error.code} ${error.message}`,
      )
    );
  }

  private isAuthenticationError(error: unknown): boolean {
    return (
      error instanceof ProviderApiError &&
      (error.status === 401 ||
        (error.status === 403 &&
          /authError|insufficientPermissions|invalidCredentials|unauthorized/i.test(
            `${error.code} ${error.message}`,
          )))
    );
  }

  private async assertRestoreOpen(): Promise<void> {
    const barrier = await this.prisma.systemSetting.findUnique({
      where: { key: "workerRestoreBarrier" },
      select: { value: true },
    });
    if (
      barrier?.value &&
      typeof barrier.value === "object" &&
      (barrier.value as Prisma.JsonObject).active === true
    )
      throw new Error("Backup restore barrier is active");
  }

  private async assertTaskActive(taskId: string): Promise<void> {
    const task = await this.prisma.autoReplyTask.findUnique({
      where: { id: taskId },
      select: {
        status: true,
        mailbox: { select: { status: true, provider: true } },
      },
    });
    if (
      !task ||
      !["INITIALIZING", "RUNNING"].includes(task.status) ||
      task.mailbox.status !== "CONNECTED" ||
      task.mailbox.provider !== "GOOGLE"
    )
      throw new GmailPollInactiveError();
  }
}
