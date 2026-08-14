import { Injectable } from "@nestjs/common";
import type { Request } from "express";
import { PrismaService } from "./prisma.js";

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async write(
    action: string,
    req?: Request,
    entity?: { type: string; id: string },
    metadata?: Record<string, unknown>,
    adminId?: string,
  ): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        action,
        adminId: adminId ?? req?.auth?.admin.id,
        entityType: entity?.type,
        entityId: entity?.id,
        ipAddress: req?.ip,
        requestId: req?.requestId,
        metadata: metadata as never,
      },
    });
  }
}
