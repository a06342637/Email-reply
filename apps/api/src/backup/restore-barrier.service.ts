import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Queue, QueueEvents } from "bullmq";
import { Redis } from "ioredis";
import { AppConfig } from "../core/config.js";
import { AppError } from "../core/http.js";
import { PrismaService } from "../core/prisma.js";

type BarrierValue = {
  id: string;
  owner: string;
  startedAt: string;
};

@Injectable()
export class RestoreBarrierService {
  static readonly settingKey = "workerRestoreBarrier";

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  async assertOpen(): Promise<void> {
    if (await this.isActive())
      throw new AppError(
        "RESTORE_IN_PROGRESS",
        "系统正在恢复备份，邮件检测和发送已暂停",
        503,
      );
  }

  async isActive(): Promise<boolean> {
    return Boolean(await this.current());
  }

  async current(): Promise<BarrierValue | null> {
    const row = await this.prisma.systemSetting.findUnique({
      where: { key: RestoreBarrierService.settingKey },
    });
    if (!row || !row.value || typeof row.value !== "object") return null;
    const value = row.value as Record<string, unknown>;
    if (value.active !== true || typeof value.id !== "string") return null;
    return {
      id: value.id,
      owner: typeof value.owner === "string" ? value.owner : "unknown",
      startedAt:
        typeof value.startedAt === "string"
          ? value.startedAt
          : new Date(0).toISOString(),
    };
  }

  async acquire(): Promise<BarrierValue> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('mailpilot:restore-barrier'))`;
      const existing = await tx.systemSetting.findUnique({
        where: { key: RestoreBarrierService.settingKey },
      });
      if (
        existing?.value &&
        typeof existing.value === "object" &&
        (existing.value as Record<string, unknown>).active === true
      ) {
        throw new AppError(
          "RESTORE_ALREADY_RUNNING",
          "另一项备份恢复正在进行中",
          409,
        );
      }
      const value: BarrierValue = {
        id: randomUUID(),
        owner: this.config.workerId,
        startedAt: new Date().toISOString(),
      };
      await tx.systemSetting.upsert({
        where: { key: RestoreBarrierService.settingKey },
        create: {
          key: RestoreBarrierService.settingKey,
          value: { active: true, ...value },
        },
        update: { value: { active: true, ...value } },
      });
      return value;
    });
  }

  async release(id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('mailpilot:restore-barrier'))`;
      const existing = await tx.systemSetting.findUnique({
        where: { key: RestoreBarrierService.settingKey },
      });
      if (!existing?.value || typeof existing.value !== "object") return;
      const value = existing.value as Record<string, unknown>;
      if (value.id !== id) return;
      await tx.systemSetting.delete({
        where: { key: RestoreBarrierService.settingKey },
      });
    });
  }

  async waitForQuiescence(timeoutMs = 180_000): Promise<void> {
    const connection = new Redis(this.config.redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
    const queue = new Queue("autoreply-jobs", { connection });
    const eventsConnection = connection.duplicate();
    const queueEvents = new QueueEvents("autoreply-jobs", {
      connection: eventsConnection,
    });
    const deadline = Date.now() + timeoutMs;
    let paused = false;
    try {
      await queueEvents.waitUntilReady();
      await queue.pause();
      paused = true;
      await this.removePendingWorkerJobs(queue);
      while (Date.now() < deadline) {
        const [activeJobs, sendLocks, pollLocks, eventsReady] =
          await Promise.all([
            queue.getActiveCount(),
            this.countKeys(connection, "lock:send:*"),
            this.countKeys(connection, "lock:poll:*"),
            queueEvents.waitUntilReady().then(() => true),
          ]);
        if (
          eventsReady &&
          activeJobs === 0 &&
          sendLocks === 0 &&
          pollLocks === 0
        )
          return;
        await sleep(1_000);
      }
      throw new AppError(
        "RESTORE_WORKER_BUSY",
        "Worker 仍有在途邮件操作，已安全取消恢复；请稍后重试并检查系统日志",
        409,
      );
    } finally {
      if (paused && !(await this.isActive().catch(() => false)))
        await queue.resume().catch(() => undefined);
      await queueEvents.close().catch(() => undefined);
      await eventsConnection.quit().catch(() => undefined);
      await queue.close().catch(() => undefined);
      await connection.quit().catch(() => undefined);
    }
  }

  private async countKeys(connection: Redis, pattern: string): Promise<number> {
    let cursor = "0";
    let count = 0;
    do {
      const result = await connection.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        100,
      );
      cursor = result[0];
      count += result[1].length;
      if (count) return count;
    } while (cursor !== "0");
    return count;
  }

  private async removePendingWorkerJobs(queue: Queue): Promise<void> {
    const jobs = await queue.getJobs(
      ["delayed", "waiting", "prioritized", "paused"],
      0,
      50_000,
      true,
    );
    for (const job of jobs) {
      if (!["PROCESS_MESSAGE", "VERIFY_SEND"].includes(job.name)) continue;
      await job.remove().catch(() => undefined);
    }
  }

  async resumeQueue(): Promise<void> {
    const connection = new Redis(this.config.redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
    const queue = new Queue("autoreply-jobs", { connection });
    try {
      await queue.resume();
    } finally {
      await queue.close().catch(() => undefined);
      await connection.quit().catch(() => undefined);
    }
  }
}
