import { Injectable } from "@nestjs/common";
import { statfs } from "node:fs/promises";
import { Redis } from "ioredis";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../core/prisma.js";
import { AppConfig } from "../core/config.js";
import { AppError } from "../core/http.js";

const DEFAULTS: Record<string, unknown> = {
  siteName: "MailPilot 自动回复",
  timezone: "Asia/Shanghai",
  defaultPollIntervalSeconds: 30,
  defaultBacklogPerMinute: 20,
  excludedAddresses: [],
  excludedDomains: [],
  attachmentLimitMb: 10,
  processingLogDays: 30,
  systemLogDays: 30,
  alertLogDays: 30,
  auditLogDays: 180,
  dedupeDays: 365,
  sessionIdleMinutes: 120,
  sessionAbsoluteMinutes: 720,
};

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  async get() {
    const rows = await this.prisma.systemSetting.findMany();
    const values = {
      ...DEFAULTS,
      ...Object.fromEntries(rows.map((item) => [item.key, item.value])),
    };
    const microsoft = await this.prisma.microsoftAppConfig.findUnique({
      where: { id: "singleton" },
    });
    return {
      ...values,
      version: this.config.version,
      microsoftSecretExpiresAt: microsoft?.secretExpiresAt ?? null,
    };
  }

  async update(input: Record<string, unknown>) {
    const allowed = new Set(Object.keys(DEFAULTS));
    const entries = Object.entries(input)
      .filter(([key]) => allowed.has(key))
      .map(([key, original]) => {
        let value = original;
        if (key === "siteName") {
          value = String(value).trim();
          if (!value)
            throw new AppError("SITE_NAME_REQUIRED", "站点名称不能为空", 400);
        }
        if (key === "timezone") value = String(value).trim();
        if (["excludedAddresses", "excludedDomains"].includes(key)) {
          value = [
            ...new Set(
              (value as unknown[])
                .map((item) => String(item).trim())
                .filter(Boolean),
            ),
          ];
        }
        return [key, value] as const;
      });
    for (const [key, value] of entries) {
      if (key === "timezone") {
        try {
          new Intl.DateTimeFormat("zh-CN", {
            timeZone: String(value),
          }).format();
        } catch {
          throw new AppError("TIMEZONE_INVALID", "时区名称无效", 400);
        }
      }
    }
    if (
      entries.some(([key]) =>
        ["sessionIdleMinutes", "sessionAbsoluteMinutes"].includes(key),
      )
    ) {
      const current = await this.prisma.systemSetting.findMany({
        where: {
          key: { in: ["sessionIdleMinutes", "sessionAbsoluteMinutes"] },
        },
      });
      const merged = new Map<string, number>([
        ["sessionIdleMinutes", Number(DEFAULTS.sessionIdleMinutes)],
        ["sessionAbsoluteMinutes", Number(DEFAULTS.sessionAbsoluteMinutes)],
        ...current.map((item) => [item.key, Number(item.value)] as const),
        ...entries
          .filter(([key]) =>
            ["sessionIdleMinutes", "sessionAbsoluteMinutes"].includes(key),
          )
          .map(([key, value]) => [key, Number(value)] as const),
      ]);
      if (
        merged.get("sessionAbsoluteMinutes")! <
        merged.get("sessionIdleMinutes")!
      )
        throw new AppError(
          "SESSION_DURATION_INVALID",
          "会话最长时间不能小于空闲超时时间",
          400,
        );
    }
    await this.prisma.$transaction(
      entries.map(([key, value]) =>
        this.prisma.systemSetting.upsert({
          where: { key },
          create: { key, value: value as Prisma.InputJsonValue },
          update: { value: value as Prisma.InputJsonValue },
        }),
      ),
    );
    return this.get();
  }

  async systemInfo() {
    const [
      database,
      redis,
      redisHeartbeat,
      workers,
      taskBacklog,
      disk,
      databaseSize,
    ] = await Promise.all([
      this.prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
      this.redisHealth(),
      this.prisma.workerHeartbeat.count({
        where: {
          role: "worker",
          updatedAt: { gte: new Date(Date.now() - 60_000) },
        },
      }),
      this.prisma.workerHeartbeat.findMany({
        orderBy: { updatedAt: "desc" },
        take: 20,
      }),
      this.prisma.messageReceipt.count({
        where: {
          state: {
            in: ["QUEUED", "CREATING_DRAFT", "DRAFT_READY", "SENDING"],
          },
        },
      }),
      statfs(process.cwd()).catch(() => null),
      this.prisma.$queryRaw<
        Array<{ bytes: bigint }>
      >`SELECT pg_database_size(current_database()) AS bytes`
        .then((rows) => Number(rows[0]?.bytes ?? 0))
        .catch(() => null),
    ]);
    return {
      version: this.config.version,
      node: process.version,
      database,
      redis,
      healthyWorkers: redisHeartbeat,
      workers,
      taskBacklog,
      databaseSize,
      disk: disk
        ? {
            total: Number(disk.blocks * disk.bsize),
            free: Number(disk.bavail * disk.bsize),
          }
        : null,
    };
  }

  private async redisHealth(): Promise<boolean> {
    const redis = new Redis(this.config.redisUrl, {
      lazyConnect: true,
      connectTimeout: 2_000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    try {
      await redis.connect();
      return (await redis.ping()) === "PONG";
    } catch {
      return false;
    } finally {
      redis.disconnect();
    }
  }
}
