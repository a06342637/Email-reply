import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { statfs } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { AppConfig } from "../core/config.js";
import { PrismaService } from "../core/prisma.js";
import { AlertService } from "./alert.service.js";
import { WebhookService } from "./webhook.service.js";

@Injectable()
export class AppMonitorService implements OnModuleInit, OnModuleDestroy {
  private stopping = false;
  private readonly startedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly alerts: AlertService,
    private readonly webhooks: WebhookService,
  ) {}

  onModuleInit(): void {
    void this.loop();
  }

  onModuleDestroy(): void {
    this.stopping = true;
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        await Promise.all([this.checkWorker(), this.checkDisk()]);
      } catch (error) {
        await this.prisma.systemLog
          .create({
            data: {
              level: "ERROR",
              component: "app-monitor",
              event: "APP_MONITOR_FAILED",
              message: (error instanceof Error
                ? error.message
                : String(error)
              ).slice(0, 1_000),
            },
          })
          .catch(() => undefined);
      }
      await sleep(30_000);
    }
  }

  private async checkWorker(): Promise<void> {
    // App and Worker start concurrently during installs and upgrades. Give the
    // Worker enough time to migrate, boot and publish its first heartbeat so a
    // normal deployment does not create a false critical alert/webhook.
    if (Date.now() - this.startedAt < 90_000) return;
    const heartbeat = await this.prisma.workerHeartbeat.findUnique({
      where: { id: this.config.workerId },
      select: { role: true, updatedAt: true },
    });
    const stale =
      !heartbeat ||
      heartbeat.role !== "worker" ||
      heartbeat.updatedAt < new Date(Date.now() - 60_000);
    if (!stale) {
      await this.alerts.resolve("worker-heartbeat");
      return;
    }
    const alert = await this.alerts.open({
      fingerprint: "worker-heartbeat",
      type: "WORKER_HEARTBEAT_LOST",
      severity: "CRITICAL",
      title: "Worker 心跳丢失",
      message: "检测到 Worker 超过 60 秒未上报心跳，邮件检测和发送可能已停止。",
      metadata: { workerId: this.config.workerId },
    });
    // The normal Webhook consumer lives in the Worker. When the Worker itself
    // is down, the app attempts delivery directly and leaves failed Outbox
    // rows intact so they can be retried after recovery.
    await this.deliverDirect(alert.id);
  }

  private async checkDisk(): Promise<void> {
    const disk = await statfs(process.cwd()).catch(() => null);
    if (!disk) return;
    const total = Number(disk.blocks * disk.bsize);
    const free = Number(disk.bavail * disk.bsize);
    const low = free < 1024 ** 3 || (total > 0 && free / total < 0.1);
    if (low) {
      const alert = await this.alerts.open({
        fingerprint: "disk-space",
        type: "DISK_SPACE_LOW",
        severity: "CRITICAL",
        title: "磁盘可用空间不足",
        message: "应用可见文件系统剩余空间低于 1GB 或 10%，请尽快清理。",
        metadata: { total, free },
      });
      await this.deliverDirect(alert.id);
    } else await this.alerts.resolve("disk-space");
  }

  private async deliverDirect(alertId: string): Promise<void> {
    const rows = await this.prisma.transactionalOutbox.findMany({
      where: { kind: "WEBHOOK", aggregateId: alertId },
      select: { id: true },
      take: 20,
    });
    for (const row of rows)
      await this.webhooks.deliver(row.id).catch(() => undefined);
  }
}
