import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import type { Prisma } from "@prisma/client";
import { AppConfig } from "../core/config.js";
import { PrismaService } from "../core/prisma.js";

export const QUEUE_NAME = "autoreply-jobs";
const ACTIVE_JOB_STATES = new Set([
  "waiting",
  "waiting-children",
  "delayed",
  "active",
  "prioritized",
  "paused",
]);
const MAX_STALE_PUBLISH_MS = 10 * 60_000;
const TERMINAL_RECEIPT_STATES = new Set([
  "SENT",
  "FILTERED",
  "FAILED_CONFIRMED",
  "UNCERTAIN",
]);

@Injectable()
export class QueueService implements OnModuleDestroy {
  readonly connection: Redis;
  readonly queue: Queue;

  constructor(config: AppConfig) {
    this.connection = new Redis(config.redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
    this.queue = new Queue(QUEUE_NAME, {
      connection: this.connection,
      defaultJobOptions: { removeOnComplete: 1_000, removeOnFail: 2_000 },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
    await this.connection.quit();
  }
}

@Injectable()
export class OutboxDispatcherService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
  ) {}

  async dispatch(limit = 200): Promise<number> {
    // `publishedAt` is an enqueue watermark, not an acknowledgement.  A
    // process can die after BullMQ accepts a job but before the worker has
    // acknowledged the outbox row.  Revisit old published rows so a missing
    // Redis job is rebuilt from PostgreSQL.
    const now = new Date();
    const staleBefore = new Date(Date.now() - MAX_STALE_PUBLISH_MS);
    const restoreBarrier = await this.prisma.systemSetting.findUnique({
      where: { key: "workerRestoreBarrier" },
      select: { value: true },
    });
    const restoreActive = Boolean(
      restoreBarrier?.value &&
      typeof restoreBarrier.value === "object" &&
      (restoreBarrier.value as Prisma.JsonObject).active === true,
    );
    if (restoreActive) return 0;
    const rows = await this.prisma.transactionalOutbox.findMany({
      where: {
        availableAt: { lte: now },
        OR: [{ publishedAt: null }, { publishedAt: { lt: staleBefore } }],
      },
      orderBy: { createdAt: "asc" },
      take: limit,
    });
    let published = 0;
    for (const row of rows) {
      try {
        const existingJob = await this.queues.queue.getJob(row.id);
        if (existingJob) {
          const state = await existingJob.getState();
          if (ACTIVE_JOB_STATES.has(state)) {
            // The job is still owned by BullMQ.  Keeping the watermark avoids
            // adding a second job with a different id during a restart.
            continue;
          }
          if (state === "completed") {
            if (
              await this.canAcknowledge({
                ...row,
                outboxId: row.id,
              })
            ) {
              await this.prisma.transactionalOutbox.delete({
                where: { id: row.id },
              });
              published += 1;
              continue;
            }
            // A completed job can be a lock/rate-limit hand-off.  Remove the
            // terminal BullMQ record and recreate the same outbox job only
            // after the stale watermark proves no successor survived.
            await existingJob.remove().catch(() => undefined);
          }
          if (state === "failed") {
            await existingJob.remove().catch(() => undefined);
            const delay = this.retryDelay(row.kind, row.attempts + 1);
            await this.release(row.id, "BullMQ job failed", delay);
            continue;
          }
        }
        const payload = row.payload as Prisma.JsonObject;
        await this.queues.queue.add(
          row.kind,
          { outboxId: row.id, ...payload },
          {
            jobId: row.id,
            attempts: row.kind === "WEBHOOK" ? 4 : 1,
            backoff: row.kind === "WEBHOOK" ? { type: "custom" } : undefined,
          },
        );
        await this.prisma.transactionalOutbox.update({
          where: { id: row.id },
          data: { publishedAt: new Date(), lastError: null },
        });
        published += 1;
      } catch (error) {
        await this.prisma.transactionalOutbox.update({
          where: { id: row.id },
          data: {
            attempts: { increment: 1 },
            lastError: (error instanceof Error
              ? error.message
              : String(error)
            ).slice(0, 1_000),
          },
        });
      }
    }
    return published;
  }

  private async canAcknowledge(row: {
    kind: string;
    aggregateId: string;
    outboxId?: string;
  }): Promise<boolean> {
    if (row.kind === "WEBHOOK") return true;
    const receipt = await this.prisma.messageReceipt.findUnique({
      where: { id: row.aggregateId },
      select: { state: true },
    });
    if (!receipt || TERMINAL_RECEIPT_STATES.has(receipt.state)) return true;
    if (row.kind === "PROCESS_MESSAGE") {
      return (
        (await this.prisma.transactionalOutbox.count({
          where: {
            aggregateId: row.aggregateId,
            kind: "VERIFY_SEND",
          },
        })) > 0
      );
    }
    if (row.kind === "VERIFY_SEND") {
      return (
        (await this.prisma.transactionalOutbox.count({
          where: {
            aggregateId: row.aggregateId,
            kind: "VERIFY_SEND",
            ...(row.outboxId ? { id: { not: row.outboxId } } : {}),
          },
        })) > 0
      );
    }
    return false;
  }

  async acknowledge(
    outboxId: string,
    kind: string,
    aggregateId: string,
  ): Promise<void> {
    if (
      kind === "WEBHOOK" ||
      (await this.canAcknowledge({ kind, aggregateId, outboxId }))
    ) {
      await this.prisma.transactionalOutbox
        .delete({ where: { id: outboxId } })
        .catch(() => undefined);
      return;
    }
    await this.release(outboxId, "receipt is not terminal", 5_000);
  }

  async release(
    outboxId: string,
    error: string,
    delayMs = 5_000,
  ): Promise<void> {
    await this.prisma.transactionalOutbox
      .update({
        where: { id: outboxId },
        data: {
          publishedAt: null,
          availableAt: new Date(Date.now() + Math.max(0, delayMs)),
          attempts: { increment: 1 },
          lastError: error.slice(0, 1_000),
        },
      })
      .catch(() => undefined);
  }

  async touch(outboxId: string, delayMs: number): Promise<void> {
    await this.prisma.transactionalOutbox
      .update({
        where: { id: outboxId },
        data: {
          publishedAt: new Date(),
          availableAt: new Date(Date.now() + Math.max(0, delayMs)),
          lastError: null,
        },
      })
      .catch(() => undefined);
  }

  async removeIfExists(outboxId: string): Promise<void> {
    await this.prisma.transactionalOutbox
      .delete({ where: { id: outboxId } })
      .catch(() => undefined);
  }

  async recoverInterruptedReceipt(
    receiptId: string,
    currentOutboxId?: string,
  ): Promise<boolean> {
    const receipt = await this.prisma.messageReceipt.findUnique({
      where: { id: receiptId },
      include: { attempts: { orderBy: { number: "desc" }, take: 1 } },
    });
    if (
      !receipt ||
      !["CREATING_DRAFT", "DRAFT_READY", "SENDING"].includes(receipt.state)
    )
      return false;

    const attempt = receipt.attempts[0];
    if (!attempt) {
      const recoveryKey = `recovery-process:${receiptId}:${currentOutboxId ?? "runtime"}`;
      await this.prisma.$transaction([
        this.prisma.messageReceipt.updateMany({
          where: {
            id: receiptId,
            state: { in: ["CREATING_DRAFT", "DRAFT_READY", "SENDING"] },
          },
          data: { state: "QUEUED" },
        }),
        this.prisma.transactionalOutbox.upsert({
          where: { dedupeKey: recoveryKey },
          create: {
            kind: "PROCESS_MESSAGE",
            aggregateId: receiptId,
            dedupeKey: recoveryKey,
            payload: { receiptId },
          },
          update: {},
        }),
      ]);
      return true;
    }

    const phase =
      attempt.verificationPhase ||
      (attempt.draftMessageId && receipt.state === "SENDING"
        ? "SEND"
        : "CREATE");
    const stage = Math.min(2, Math.max(0, attempt.verificationStage));
    await this.prisma.transactionalOutbox.upsert({
      where: { dedupeKey: `verify:${attempt.id}:${stage}:${phase}` },
      create: {
        kind: "VERIFY_SEND",
        aggregateId: receiptId,
        dedupeKey: `verify:${attempt.id}:${stage}:${phase}`,
        payload: { receiptId, attemptId: attempt.id, stage, phase },
        availableAt: new Date(Date.now() + 5_000),
      },
      update: {},
    });
    return true;
  }

  private retryDelay(kind: string, attempt: number): number {
    if (kind === "WEBHOOK") {
      if (attempt <= 1) return 60_000;
      if (attempt === 2) return 300_000;
      if (attempt === 3) return 900_000;
      return 86_400_000;
    }
    return Math.min(900_000, 5_000 * 2 ** Math.min(attempt, 8));
  }

  async rebuild(): Promise<number> {
    const receipts = await this.prisma.messageReceipt.findMany({
      where: {
        state: "QUEUED",
        task: { status: { in: ["RUNNING", "INITIALIZING"] } },
        mailbox: { status: "CONNECTED" },
      },
      select: { id: true },
    });
    for (const receipt of receipts) {
      await this.prisma.transactionalOutbox.upsert({
        where: { dedupeKey: `process:${receipt.id}` },
        create: {
          kind: "PROCESS_MESSAGE",
          aggregateId: receipt.id,
          dedupeKey: `process:${receipt.id}`,
          payload: { receiptId: receipt.id },
        },
        update: {},
      });
    }
    const interrupted = await this.prisma.messageReceipt.findMany({
      where: {
        state: { in: ["CREATING_DRAFT", "DRAFT_READY", "SENDING"] },
        task: { status: { in: ["RUNNING", "INITIALIZING"] } },
        mailbox: { status: "CONNECTED" },
      },
      include: { attempts: { orderBy: { number: "desc" }, take: 1 } },
    });
    for (const receipt of interrupted) {
      const attempt = receipt.attempts[0];
      if (!attempt) {
        await this.prisma.messageReceipt.update({
          where: { id: receipt.id },
          data: { state: "QUEUED" },
        });
        await this.prisma.transactionalOutbox.upsert({
          where: { dedupeKey: `recovery-process:${receipt.id}` },
          create: {
            kind: "PROCESS_MESSAGE",
            aggregateId: receipt.id,
            dedupeKey: `recovery-process:${receipt.id}`,
            payload: { receiptId: receipt.id },
          },
          update: {},
        });
        continue;
      }
      const phase =
        attempt.verificationPhase ||
        (attempt.draftMessageId
          ? receipt.state === "SENDING"
            ? "SEND"
            : "CREATE"
          : "CREATE");
      const stage = Math.min(2, Math.max(0, attempt.verificationStage));
      await this.prisma.transactionalOutbox.upsert({
        where: { dedupeKey: `recovery-verify:${attempt.id}:${phase}:${stage}` },
        create: {
          kind: "VERIFY_SEND",
          aggregateId: receipt.id,
          dedupeKey: `recovery-verify:${attempt.id}:${phase}:${stage}`,
          payload: {
            receiptId: receipt.id,
            attemptId: attempt.id,
            stage,
            phase,
          },
          availableAt: new Date(Date.now() + 5_000),
        },
        update: {},
      });
    }
    return receipts.length + interrupted.length;
  }
}
