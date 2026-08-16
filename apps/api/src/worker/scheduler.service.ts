import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { AppConfig } from "../core/config.js";
import { PrismaService } from "../core/prisma.js";
import { ProviderPollService } from "./provider-poll.service.js";
import { OutboxDispatcherService, QueueService } from "./queue.service.js";
import { AlertService } from "../observability/alert.service.js";
import { RestoreBarrierService } from "../backup/restore-barrier.service.js";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezone);

@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private stopping = false;
  private readonly heldLocks = new Set<string>();
  private lastCleanupDay = "";

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly polling: ProviderPollService,
    private readonly outbox: OutboxDispatcherService,
    private readonly queues: QueueService,
    private readonly alerts: AlertService,
    private readonly restoreBarrier: RestoreBarrierService,
  ) {}

  onModuleInit(): void {
    void this.schedulerLoop();
    void this.outboxLoop();
    void this.heartbeatLoop();
    void this.maintenanceLoop();
  }

  onModuleDestroy(): void {
    this.stopping = true;
  }

  private async schedulerLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        if (await this.restoreBarrier.isActive()) {
          await sleep(1_000);
          continue;
        }
        const due = await this.prisma.autoReplyTask.findMany({
          where: {
            status: { in: ["INITIALIZING", "RUNNING"] },
            nextPollAt: { lte: new Date() },
            mailbox: { status: "CONNECTED" },
          },
          select: { id: true, mailboxId: true, pollIntervalSeconds: true },
          orderBy: { nextPollAt: "asc" },
          take: 20,
        });
        await Promise.all(
          due.map((task) =>
            this.withLock(
              `lock:poll:${task.mailboxId}`,
              Math.max(15_000, task.pollIntervalSeconds * 4_000),
              () => this.polling.pollTask(task.id),
            ),
          ),
        );
      } catch (error) {
        await this.writeSystemLog("scheduler", "SCHEDULER_LOOP_FAILED", error);
      }
      await sleep(1_000);
    }
  }

  private async outboxLoop(): Promise<void> {
    await this.outbox.rebuild().catch(() => 0);
    while (!this.stopping) {
      await this.outbox
        .dispatch()
        .catch((error) =>
          this.writeSystemLog("outbox", "OUTBOX_DISPATCH_FAILED", error),
        );
      await sleep(1_000);
    }
  }

  private async heartbeatLoop(): Promise<void> {
    while (!this.stopping) {
      await this.prisma.workerHeartbeat
        .upsert({
          where: { id: this.config.workerId },
          create: {
            id: this.config.workerId,
            role: "worker",
            hostname: hostname(),
            pid: process.pid,
            metadata: { version: this.config.version },
          },
          update: {
            hostname: hostname(),
            pid: process.pid,
            metadata: { version: this.config.version },
          },
        })
        .catch((error) =>
          this.writeSystemLog("heartbeat", "HEARTBEAT_FAILED", error),
        );
      await sleep(10_000);
    }
  }

  private async maintenanceLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        if (await this.restoreBarrier.isActive()) {
          await sleep(1_000);
          continue;
        }
        const cleanupDay = await this.cleanupDayKey();
        if (this.lastCleanupDay !== cleanupDay) {
          await this.cleanup();
          this.lastCleanupDay = cleanupDay;
        }
        await this.checkSecretExpiry();
      } catch (error) {
        await this.writeSystemLog("maintenance", "MAINTENANCE_FAILED", error);
      }
      await sleep(60_000);
    }
  }

  private async cleanup(): Promise<void> {
    const settings = await this.prisma.systemSetting.findMany({
      where: {
        key: {
          in: [
            "processingLogDays",
            "systemLogDays",
            "alertLogDays",
            "auditLogDays",
            "dedupeDays",
            "timezone",
          ],
        },
      },
    });
    const values = new Map(
      settings.map((item) => [item.key, Number(item.value)]),
    );
    const configuredTimezone = settings.find(
      (item) => item.key === "timezone",
    )?.value;
    const zone =
      typeof configuredTimezone === "string"
        ? configuredTimezone
        : this.config.timezone;
    const cutoff = (days: number) =>
      dayjs()
        .tz(zone)
        .startOf("day")
        .subtract(Math.min(3650, Math.max(1, days)) - 1, "day")
        .toDate();
    await this.prisma.processingLog.deleteMany({
      where: {
        occurredAt: { lt: cutoff(values.get("processingLogDays") || 30) },
      },
    });
    await this.prisma.systemLog.deleteMany({
      where: { occurredAt: { lt: cutoff(values.get("systemLogDays") || 30) } },
    });
    const alertCutoff = cutoff(values.get("alertLogDays") || 30);
    await this.prisma.$executeRaw`
      DELETE FROM "TransactionalOutbox" AS outbox
      USING "Alert" AS alert
      WHERE outbox."aggregateId" = alert."id"
        AND outbox."kind" = 'WEBHOOK'
        AND alert."lastSeenAt" < ${alertCutoff}
    `;
    await this.prisma.alert.deleteMany({
      where: {
        lastSeenAt: { lt: alertCutoff },
      },
    });
    await this.prisma.auditLog.deleteMany({
      where: { occurredAt: { lt: cutoff(values.get("auditLogDays") || 180) } },
    });
    const dedupeCutoff = cutoff(values.get("dedupeDays") || 365);
    await this.prisma.$executeRaw`
      DELETE FROM "TransactionalOutbox" AS outbox
      USING "MessageReceipt" AS receipt
      WHERE outbox."aggregateId" = receipt."id"
        AND receipt."createdAt" < ${dedupeCutoff}
        AND receipt."state" IN ('SENT', 'FAILED_CONFIRMED', 'UNCERTAIN', 'FILTERED')
    `;
    await this.prisma.messageReceipt.deleteMany({
      where: {
        createdAt: { lt: dedupeCutoff },
        state: { in: ["SENT", "FAILED_CONFIRMED", "UNCERTAIN", "FILTERED"] },
      },
    });
    const expiredAt = new Date();
    await this.prisma.adminSession.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: expiredAt } },
          { absoluteExpiresAt: { lt: expiredAt } },
        ],
      },
    });
    await this.prisma.oAuthState.deleteMany({
      where: { expiresAt: { lt: expiredAt } },
    });
    const staleOutboxCutoff = cutoff(7);
    await this.prisma.$executeRaw`
      DELETE FROM "TransactionalOutbox" AS outbox
      WHERE outbox."publishedAt" < ${staleOutboxCutoff}
        AND (
          outbox."kind" = 'WEBHOOK'
          OR (
            outbox."kind" IN ('PROCESS_MESSAGE', 'VERIFY_SEND')
            AND (
              NOT EXISTS (
                SELECT 1 FROM "MessageReceipt" AS receipt
                WHERE receipt."id" = outbox."aggregateId"
              )
              OR EXISTS (
                SELECT 1 FROM "MessageReceipt" AS receipt
                WHERE receipt."id" = outbox."aggregateId"
                  AND receipt."state" IN ('SENT', 'FAILED_CONFIRMED', 'UNCERTAIN', 'FILTERED')
              )
            )
          )
        )
    `;
  }

  private async cleanupDayKey(): Promise<string> {
    const setting = await this.prisma.systemSetting.findUnique({
      where: { key: "timezone" },
      select: { value: true },
    });
    const zone =
      typeof setting?.value === "string" ? setting.value : this.config.timezone;
    return dayjs().tz(zone).format("YYYY-MM-DD");
  }

  private async checkSecretExpiry(): Promise<void> {
    const apps = await this.prisma.microsoftAppConfig.findMany();
    for (const threshold of [30, 7, 1])
      await this.alerts.resolve(`microsoft-secret:${threshold}`);
    await this.alerts.resolve("microsoft-secret:expired");
    for (const app of apps) {
      const prefix = `microsoft-secret:${app.id}`;
      if (!app.secretExpiresAt) {
        for (const threshold of [30, 7, 1])
          await this.alerts.resolve(`${prefix}:${threshold}`);
        await this.alerts.resolve(`${prefix}:expired`);
        continue;
      }
      const remainingMs = app.secretExpiresAt.getTime() - Date.now();
      const days = Math.ceil(remainingMs / 86_400_000);
      if (remainingMs <= 0) {
        await this.alerts.open({
          fingerprint: `${prefix}:expired`,
          type: "CLIENT_SECRET_EXPIRED",
          severity: "CRITICAL",
          title: `${app.name} 的 Client Secret 已到期`,
          message:
            "请立即在 Microsoft Entra 应用注册中创建新 Secret，并在对应应用配置中替换。",
          metadata: {
            appConfigId: app.id,
            appName: app.name,
            expiresAt: app.secretExpiresAt.toISOString(),
            days,
          },
        });
        for (const threshold of [30, 7, 1])
          await this.alerts.resolve(`${prefix}:${threshold}`);
        continue;
      }
      await this.alerts.resolve(`${prefix}:expired`);
      for (const threshold of [30, 7, 1]) {
        const fingerprint = `${prefix}:${threshold}`;
        if (days <= threshold) {
          await this.alerts.open({
            fingerprint,
            type: "CLIENT_SECRET_EXPIRING",
            severity: days <= 1 ? "CRITICAL" : "WARNING",
            title: `${app.name} 的 Client Secret 将在 ${days} 天内到期`,
            message:
              "请在 Microsoft Entra 应用注册中创建新 Secret，并在对应应用配置中替换。",
            metadata: {
              appConfigId: app.id,
              appName: app.name,
              expiresAt: app.secretExpiresAt.toISOString(),
              days,
            },
          });
        } else await this.alerts.resolve(fingerprint);
      }
    }
  }

  private async writeSystemLog(
    component: string,
    event: string,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.prisma.systemLog
      .create({
        data: {
          level: "ERROR",
          component,
          event,
          message: message.slice(0, 1_000),
          metadata: { workerId: this.config.workerId },
        },
      })
      .catch(() => undefined);
  }

  private async withLock(
    key: string,
    ttlMs: number,
    action: () => Promise<void>,
  ): Promise<void> {
    if (this.heldLocks.has(key)) return;
    const value = `${this.config.workerId}:${process.pid}:${Date.now()}`;
    const acquired = await this.queues.connection.set(
      key,
      value,
      "PX",
      ttlMs,
      "NX",
    );
    if (!acquired) return;
    this.heldLocks.add(key);
    const renewEvery = Math.max(1_000, Math.floor(ttlMs / 3));
    const renewal = setInterval(() => {
      void this.queues.connection
        .eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
          1,
          key,
          value,
          ttlMs,
        )
        .catch(() => undefined);
    }, renewEvery);
    renewal.unref();
    try {
      await action();
    } finally {
      clearInterval(renewal);
      this.heldLocks.delete(key);
      const current = await this.queues.connection.get(key).catch(() => null);
      if (current === value)
        await this.queues.connection.del(key).catch(() => undefined);
    }
  }
}
