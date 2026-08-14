import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { Redis } from "ioredis";
import { PrismaService } from "../core/prisma.js";
import { AppConfig } from "../core/config.js";

@Controller("health")
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  @Get("live") live() {
    return {
      status: "ok",
      version: this.config.version,
      time: new Date().toISOString(),
    };
  }

  @Get("ready")
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException("Database is unavailable");
    }
    const redis = new Redis(this.config.redisUrl, {
      lazyConnect: true,
      connectTimeout: 2_000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    try {
      await redis.connect();
      if ((await redis.ping()) !== "PONG")
        throw new Error("Unexpected Redis response");
    } catch {
      throw new ServiceUnavailableException("Redis is unavailable");
    } finally {
      redis.disconnect();
    }
    const recentWorker = await this.prisma.workerHeartbeat.findFirst({
      where: {
        id: this.config.workerId,
        role: "worker",
        updatedAt: { gte: new Date(Date.now() - 60_000) },
      },
      orderBy: { updatedAt: "desc" },
    });
    if (!recentWorker)
      throw new ServiceUnavailableException(
        "Worker heartbeat is stale or missing",
      );
    return {
      status: "ready",
      database: true,
      redis: true,
      worker: true,
      version: this.config.version,
    };
  }
}
