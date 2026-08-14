import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { FolderKind, Prisma } from "@prisma/client";
import type { RuleConditions } from "@autoreply/shared";
import { GraphError, GraphService } from "../microsoft/graph.service.js";
import { PrismaService } from "../core/prisma.js";
import { CryptoService } from "../core/crypto.js";
import { FilterService, type IncomingGraphMessage } from "./filter.service.js";
import { AlertService } from "../observability/alert.service.js";

type DeltaResponse = {
  value: IncomingGraphMessage[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
};

type TaskPayload = NonNullable<Awaited<ReturnType<DeltaService["loadTask"]>>>;

type PreparedMessage = {
  message: IncomingGraphMessage;
  receivedAt: Date;
  senderName: string;
  senderEmail: string;
  replyToEmail: string;
  filterReason?: string;
  rule: TaskPayload["rules"][number] | null;
  revisionId: string | null;
};

const SELECT_FIELDS =
  "id,internetMessageId,conversationId,subject,receivedDateTime,sender,from,replyTo,internetMessageHeaders";
const MAX_DELTA_PAGES = 200;

class PollInactiveError extends Error {}

@Injectable()
export class DeltaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly graph: GraphService,
    private readonly filters: FilterService,
    private readonly alerts: AlertService,
  ) {}

  async pollTask(taskId: string): Promise<void> {
    const task = await this.loadTask(taskId);
    if (
      !task ||
      !["INITIALIZING", "RUNNING"].includes(task.status) ||
      task.mailbox.status !== "CONNECTED" ||
      (task.mailbox.provider && task.mailbox.provider !== "MICROSOFT")
    )
      return;
    const startedAt = Date.now();
    await this.prisma.autoReplyTask.update({
      where: { id: task.id },
      data: { lastPollStartedAt: new Date() },
    });
    try {
      for (const folder of ["INBOX", "JUNKEMAIL"] as FolderKind[])
        await this.pollFolder(task, folder);
      const completedAt = new Date();
      const latency = Date.now() - startedAt;
      await this.prisma.autoReplyTask.updateMany({
        where: {
          id: task.id,
          status: { in: ["INITIALIZING", "RUNNING"] },
          mailbox: { status: "CONNECTED" },
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
      await this.alerts.resolve(`graph-throttle:${task.id}`);
    } catch (error) {
      if (error instanceof PollInactiveError) return;
      const failures = task.consecutiveFailures + 1;
      const retryAfter =
        error instanceof GraphError ? error.retryAfterSeconds : undefined;
      const latestMailbox = await this.prisma.mailbox.findUnique({
        where: { id: task.mailboxId },
        select: { status: true },
      });
      const latestTask = await this.prisma.autoReplyTask.findUnique({
        where: { id: task.id },
        select: { status: true },
      });
      if (
        !latestTask ||
        !["INITIALIZING", "RUNNING"].includes(latestTask.status) ||
        latestMailbox?.status !== "CONNECTED"
      )
        return;
      const authentication =
        error instanceof GraphError && [401, 403].includes(error.status);
      const openCircuit = !authentication && failures >= 8;
      const delaySeconds = retryAfter ?? Math.min(300, 2 ** failures);
      await this.prisma.autoReplyTask.updateMany({
        where: {
          id: task.id,
          status: { in: ["INITIALIZING", "RUNNING"] },
        },
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
      if (error instanceof GraphError && error.status === 429) {
        await this.alerts.open({
          fingerprint: `graph-throttle:${task.id}`,
          type: "GRAPH_THROTTLED",
          severity: "WARNING",
          title: "Microsoft Graph 正在限流",
          message:
            "系统已遵守 Retry-After 暂停此任务，请降低检测频率或等待 Microsoft 限流恢复。",
          metadata: {
            taskId: task.id,
            mailboxId: task.mailboxId,
            retryAfterSeconds: retryAfter ?? null,
          },
        });
      }
      if (openCircuit) {
        await this.alerts.open({
          fingerprint: `task-poll:${task.id}`,
          type: "TASK_CIRCUIT_OPEN",
          severity: "CRITICAL",
          title: "自动回复任务已熔断",
          message:
            "邮件检测连续失败，任务已停止，请检查 Microsoft 授权和系统日志。",
          metadata: { taskId: task.id, mailboxId: task.mailboxId },
        });
      }
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

  private async pollFolder(
    task: TaskPayload,
    folder: FolderKind,
  ): Promise<void> {
    await this.assertRestoreOpen();
    await this.assertTaskActive(task.id);
    const cursor = await this.prisma.folderCursor.upsert({
      where: { mailboxId_folder: { mailboxId: task.mailboxId, folder } },
      create: { mailboxId: task.mailboxId, folder },
      update: {},
    });
    let url: string;
    if (cursor.nextLinkEncrypted)
      url = await this.crypto.decryptString(
        cursor.nextLinkEncrypted,
        this.cursorContext(task.mailboxId, folder),
      );
    else if (cursor.deltaLinkEncrypted)
      url = await this.crypto.decryptString(
        cursor.deltaLinkEncrypted,
        this.cursorContext(task.mailboxId, folder),
      );
    else url = this.initialDeltaUrl(folder, task.activationAt ?? new Date());

    let pages = 0;
    while (url) {
      if (pages >= MAX_DELTA_PAGES)
        throw new Error(`Delta pagination exceeded safety limit for ${folder}`);
      pages += 1;
      await this.assertRestoreOpen();
      await this.assertTaskActive(task.id);
      let page: DeltaResponse;
      try {
        page = await this.graph.request<DeltaResponse>(task.mailboxId, url, {
          headers: { Prefer: 'IdType="ImmutableId", odata.maxpagesize=100' },
        });
      } catch (error) {
        if (
          error instanceof GraphError &&
          (error.status === 410 ||
            /syncstate|resyncrequired|deltatoken/i.test(error.code))
        ) {
          await this.recoverCursor(task, folder, cursor.lastSuccessfulAt);
          return;
        }
        throw error;
      }
      const next = page["@odata.nextLink"];
      const delta = page["@odata.deltaLink"];
      await this.ingestPage(task, folder, page.value ?? [], {
        nextEncrypted: next
          ? await this.crypto.encryptString(
              next,
              this.cursorContext(task.mailboxId, folder),
            )
          : null,
        deltaEncrypted: delta
          ? await this.crypto.encryptString(
              delta,
              this.cursorContext(task.mailboxId, folder),
            )
          : null,
      });
      if (next) url = next;
      else break;
    }
  }

  private async recoverCursor(
    task: TaskPayload,
    folder: FolderKind,
    lastSuccess: Date | null,
  ): Promise<void> {
    const overlapStart = new Date(
      Math.max(
        task.activationAt?.getTime() ?? Date.now(),
        (lastSuccess?.getTime() ?? task.activationAt?.getTime() ?? Date.now()) -
          5 * 60_000,
      ),
    );
    await this.prisma.folderCursor.update({
      where: { mailboxId_folder: { mailboxId: task.mailboxId, folder } },
      data: {
        nextLinkEncrypted: null,
        deltaLinkEncrypted: null,
        initializedAt: null,
        highWaterAt: overlapStart,
      },
    });
    let url = this.initialDeltaUrl(folder, overlapStart);
    let pages = 0;
    while (url) {
      if (pages >= MAX_DELTA_PAGES)
        throw new Error(
          `Delta recovery pagination exceeded safety limit for ${folder}`,
        );
      pages += 1;
      await this.assertRestoreOpen();
      await this.assertTaskActive(task.id);
      const page = await this.graph.request<DeltaResponse>(
        task.mailboxId,
        url,
        {
          headers: { Prefer: 'IdType="ImmutableId", odata.maxpagesize=100' },
        },
      );
      const next = page["@odata.nextLink"];
      const delta = page["@odata.deltaLink"];
      await this.ingestPage(task, folder, page.value ?? [], {
        nextEncrypted: next
          ? await this.crypto.encryptString(
              next,
              this.cursorContext(task.mailboxId, folder),
            )
          : null,
        deltaEncrypted: delta
          ? await this.crypto.encryptString(
              delta,
              this.cursorContext(task.mailboxId, folder),
            )
          : null,
      });
      if (!next) break;
      url = next;
    }
  }

  private async ingestPage(
    task: TaskPayload,
    folder: FolderKind,
    messages: IncomingGraphMessage[],
    links: { nextEncrypted: string | null; deltaEncrypted: string | null },
  ): Promise<void> {
    const prepared = await this.prepareMessages(task, folder, messages);
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
          throw new PollInactiveError();
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
              folder,
              senderName: item.senderName,
              senderEmail: item.senderEmail || "unknown",
              replyToEmail: item.replyToEmail || null,
              subject: (message.subject ?? "(无主题)").slice(0, 998),
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
              folder,
              ruleName: item.rule?.name,
              templateName:
                item.rule?.template.name ?? task.defaultTemplate?.name,
              status: receipt.state,
              reason: item.filterReason,
            },
          });
          if (!item.filterReason) {
            await tx.transactionalOutbox.create({
              data: {
                kind: "PROCESS_MESSAGE",
                aggregateId: receipt.id,
                dedupeKey: `process:${receipt.id}`,
                payload: { receiptId: receipt.id } as Prisma.InputJsonValue,
              },
            });
          }
        }
        const pageHighWater = prepared.reduce<Date | null>(
          (latest, item) =>
            !latest || item.receivedAt > latest ? item.receivedAt : latest,
          null,
        );
        const storedCursor = pageHighWater
          ? await tx.folderCursor.findUnique({
              where: {
                mailboxId_folder: { mailboxId: task.mailboxId, folder },
              },
              select: { highWaterAt: true },
            })
          : null;
        await tx.folderCursor.update({
          where: { mailboxId_folder: { mailboxId: task.mailboxId, folder } },
          data: {
            nextLinkEncrypted: links.nextEncrypted,
            ...(links.deltaEncrypted
              ? { deltaLinkEncrypted: links.deltaEncrypted }
              : {}),
            lastSuccessfulAt: links.deltaEncrypted ? now : undefined,
            highWaterAt:
              pageHighWater &&
              (!storedCursor?.highWaterAt ||
                pageHighWater > storedCursor.highWaterAt)
                ? pageHighWater
                : undefined,
            initializedAt: links.deltaEncrypted ? now : undefined,
          },
        });
      },
      { timeout: 60_000 },
    );
  }

  private async prepareMessages(
    task: TaskPayload,
    folder: FolderKind,
    messages: IncomingGraphMessage[],
  ): Promise<PreparedMessage[]> {
    const prepared: PreparedMessage[] = [];
    for (const message of messages) {
      if (!message.id || message["@removed"] || !message.receivedDateTime)
        continue;
      const receivedAt = new Date(message.receivedDateTime);
      if (!Number.isFinite(receivedAt.getTime())) continue;
      const filter = await this.filters.evaluate(message, task.mailbox.email);
      let filterReason = filter.skip;
      // Graph delta can emit updates/moves that do not satisfy the initial
      // filter.  Keep the activation guard local as a second line of defense,
      // especially when a historical item is later moved into Inbox/Junk.
      if (!filterReason && receivedAt < (task.activationAt ?? receivedAt))
        filterReason = "BEFORE_TASK_ACTIVATION";
      let rule: TaskPayload["rules"][number] | null = null;
      if (!filterReason) {
        rule =
          task.rules.find((candidate) =>
            this.filters.matchRule(
              message,
              filter.senderEmail,
              folder === "INBOX" ? "inbox" : "junkemail",
              candidate.conditions as RuleConditions,
            ),
          ) ?? null;
      }
      const revisionId =
        rule?.template.publishedRevisionId ??
        task.defaultTemplate?.publishedRevisionId ??
        null;
      if (!filterReason && !revisionId) filterReason = "NO_PUBLISHED_TEMPLATE";
      prepared.push({
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

  private initialDeltaUrl(folder: FolderKind, from: Date): string {
    const params = new URLSearchParams({
      changeType: "created",
      $filter: `receivedDateTime ge ${from.toISOString()}`,
      $orderby: "receivedDateTime desc",
      $select: SELECT_FIELDS,
    });
    const wellKnown = folder === "INBOX" ? "inbox" : "junkemail";
    return `/me/mailFolders/${wellKnown}/messages/delta?${params.toString()}`;
  }

  private cursorContext(mailboxId: string, folder: FolderKind): string {
    return `delta:${mailboxId}:${folder}`;
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
    ) {
      throw new Error("Backup restore barrier is active");
    }
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
      (task.mailbox.provider && task.mailbox.provider !== "MICROSOFT")
    )
      throw new PollInactiveError();
  }
}
