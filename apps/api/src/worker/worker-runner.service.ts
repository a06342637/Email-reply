import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Worker, type Job } from "bullmq";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../core/prisma.js";
import { MailProcessorService } from "./mail-processor.service.js";
import {
  OutboxDispatcherService,
  QUEUE_NAME,
  QueueService,
} from "./queue.service.js";
import { WebhookService } from "../observability/webhook.service.js";
import { RestoreBarrierService } from "../backup/restore-barrier.service.js";

const REDACT_JOB_KEY = /secret|token|password|passphrase|authorization|cookie/i;

function safeJobMetadata(
  job: Job | undefined,
): Prisma.InputJsonValue | undefined {
  if (!job) return undefined;
  const data = Object.fromEntries(
    Object.entries(job.data ?? {}).map(([key, value]) => [
      key,
      REDACT_JOB_KEY.test(key)
        ? "[REDACTED]"
        : value === undefined
          ? null
          : value,
    ]),
  ) as Prisma.InputJsonObject;
  return { jobName: job.name, jobId: job.id ?? null, data };
}

@Injectable()
export class WorkerRunnerService implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
    private readonly outbox: OutboxDispatcherService,
    private readonly processor: MailProcessorService,
    private readonly webhooks: WebhookService,
    private readonly restoreBarrier: RestoreBarrierService,
  ) {}

  onModuleInit(): void {
    this.worker = new Worker(QUEUE_NAME, (job) => this.handle(job), {
      connection: this.queues.connection,
      concurrency: 10,
      settings: {
        backoffStrategy: (attempts) =>
          [60_000, 300_000, 900_000][Math.min(attempts - 1, 2)]!,
      },
    });
    this.worker.on("failed", (job, error) => {
      void this.prisma.systemLog
        .create({
          data: {
            level: "ERROR",
            component: "worker",
            event: "JOB_FAILED",
            message: (error?.message ?? "BullMQ job failed").slice(0, 1_000),
            metadata: safeJobMetadata(job),
          },
        })
        .catch(() => undefined);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }

  private async handle(job: Job): Promise<void> {
    if (await this.deferForRestore(job)) return;
    if (job.name === "PROCESS_MESSAGE") {
      const receipt = await this.prisma.messageReceipt.findUnique({
        where: { id: String(job.data.receiptId) },
        include: { task: true },
      });
      if (!receipt) {
        if (job.data.outboxId)
          await this.outbox.acknowledge(
            String(job.data.outboxId),
            "PROCESS_MESSAGE",
            String(job.data.receiptId),
          );
        return;
      }
      if (
        !(["RUNNING", "INITIALIZING"] as string[]).includes(receipt.task.status)
      ) {
        await this.deferInactiveTask(job);
        return;
      }
      const lockKey = `lock:send:${receipt.mailboxId}`;
      const lockValue = `${job.id}:${Date.now()}`;
      const lockTtlMs = 900_000;
      const acquired = await this.queues.connection.set(
        lockKey,
        lockValue,
        "PX",
        lockTtlMs,
        "NX",
      );
      if (!acquired) {
        await this.queues.queue.add(job.name, job.data, {
          delay: 5_000,
          jobId: `${job.id}:lock:${Date.now()}`,
        });
        if (job.data.outboxId)
          await this.outbox.touch(String(job.data.outboxId), 30_000);
        return;
      }
      const renewal = this.renewLock(lockKey, lockValue, lockTtlMs);
      try {
        if (await this.deferForRestore(job)) return;
        const limiterKey = `rate:send:${receipt.mailboxId}:${Math.floor(Date.now() / 60_000)}`;
        const count = await this.queues.connection.incr(limiterKey);
        if (count === 1) await this.queues.connection.expire(limiterKey, 90);
        if (count > receipt.task.backlogPerMinute) {
          await this.queues.queue.add(job.name, job.data, {
            delay: 60_000,
            jobId: `${job.id}:rate:${Date.now()}`,
          });
          if (job.data.outboxId)
            await this.outbox.touch(String(job.data.outboxId), 90_000);
          return;
        }
        await this.processor.process(receipt.id);
        if (job.data.outboxId)
          await this.outbox.acknowledge(
            String(job.data.outboxId),
            "PROCESS_MESSAGE",
            receipt.id,
          );
      } finally {
        clearInterval(renewal);
        const current = await this.queues.connection
          .get(lockKey)
          .catch(() => null);
        if (current === lockValue)
          await this.queues.connection.del(lockKey).catch(() => undefined);
      }
      return;
    }
    if (job.name === "VERIFY_SEND") {
      const receipt = await this.prisma.messageReceipt.findUnique({
        where: { id: String(job.data.receiptId) },
        include: { task: { select: { status: true } } },
      });
      if (!receipt) {
        if (job.data.outboxId)
          await this.outbox.acknowledge(
            String(job.data.outboxId),
            "VERIFY_SEND",
            String(job.data.receiptId),
          );
        return;
      }
      if (
        !(["RUNNING", "INITIALIZING"] as string[]).includes(receipt.task.status)
      ) {
        await this.deferInactiveTask(job);
        return;
      }
      const lockKey = `lock:send:${receipt.mailboxId}`;
      const lockValue = `${job.id}:${Date.now()}`;
      const acquired = await this.queues.connection.set(
        lockKey,
        lockValue,
        "PX",
        900_000,
        "NX",
      );
      if (!acquired) {
        await this.queues.queue.add(job.name, job.data, {
          delay: 5_000,
          jobId: `${job.id}:verify-lock:${Date.now()}`,
        });
        if (job.data.outboxId)
          await this.outbox.touch(String(job.data.outboxId), 30_000);
        return;
      }
      const renewal = this.renewLock(lockKey, lockValue, 900_000);
      try {
        if (await this.deferForRestore(job)) return;
        await this.processor.verify(
          String(job.data.receiptId),
          String(job.data.attemptId),
          Number(job.data.stage),
          String(job.data.phase),
        );
        if (job.data.outboxId)
          await this.outbox.acknowledge(
            String(job.data.outboxId),
            "VERIFY_SEND",
            String(job.data.receiptId),
          );
      } finally {
        clearInterval(renewal);
        const current = await this.queues.connection
          .get(lockKey)
          .catch(() => null);
        if (current === lockValue)
          await this.queues.connection.del(lockKey).catch(() => undefined);
      }
      return;
    }
    if (job.name === "WEBHOOK") {
      await this.webhooks.deliver(String(job.data.outboxId));
      await this.outbox.acknowledge(
        String(job.data.outboxId),
        "WEBHOOK",
        String(job.data.alertId ?? ""),
      );
    }
  }

  private async deferForRestore(job: Job): Promise<boolean> {
    if (!(await this.restoreBarrier.isActive())) return false;
    await this.queues.queue.add(job.name, job.data, {
      delay: 10_000,
      jobId: `${job.id}:restore:${Date.now()}`,
    });
    if (job.data.outboxId)
      await this.outbox.touch(String(job.data.outboxId), 30_000);
    return true;
  }

  private async deferInactiveTask(job: Job): Promise<void> {
    // The task can be paused after BullMQ has already claimed a job. Keep the
    // PostgreSQL outbox row as the durable recovery point and remove this
    // transient job; resumeTask rebuilds PROCESS/VERIFY work from receipt state.
    if (job.data.outboxId)
      await this.outbox.removeIfExists(String(job.data.outboxId));
  }

  private renewLock(key: string, value: string, ttlMs: number): NodeJS.Timeout {
    const timer = setInterval(
      () => {
        void this.queues.connection
          .eval(
            "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
            1,
            key,
            value,
            ttlMs,
          )
          .catch(() => undefined);
      },
      Math.max(1_000, Math.floor(ttlMs / 3)),
    );
    timer.unref();
    return timer;
  }
}
