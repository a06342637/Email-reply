import { Injectable } from "@nestjs/common";
import type { AlertSeverity, Prisma } from "@prisma/client";
import { PrismaService } from "../core/prisma.js";
import { EventBus } from "../core/events.js";

@Injectable()
export class AlertService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventBus,
  ) {}

  async open(input: {
    fingerprint: string;
    type: string;
    severity: AlertSeverity;
    title: string;
    message: string;
    metadata?: Record<string, unknown>;
  }) {
    const alert = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`mailpilot:alert:${input.fingerprint}`}))`;
      const existing = await tx.alert.findFirst({
        where: {
          fingerprint: input.fingerprint,
          status: { in: ["OPEN", "ACKNOWLEDGED"] },
        },
        orderBy: { lastSeenAt: "desc" },
      });
      const row = existing
        ? await tx.alert.update({
            where: { id: existing.id },
            data: {
              severity: input.severity,
              title: input.title,
              message: input.message,
              metadata: input.metadata as Prisma.InputJsonValue,
              lastSeenAt: new Date(),
              status: existing.status,
            },
          })
        : await tx.alert.create({
            data: {
              ...input,
              metadata: input.metadata as Prisma.InputJsonValue,
            },
          });
      if (!existing)
        await tx.transactionalOutbox.create({
          data: {
            kind: "WEBHOOK",
            aggregateId: row.id,
            dedupeKey: `alert-opened:${row.id}`,
            payload: {
              event: input.type,
              alertId: row.id,
            } as Prisma.InputJsonValue,
          },
        });
      return row;
    });
    this.events.emit("alert.changed", { id: alert.id, status: alert.status });
    return alert;
  }

  async resolve(fingerprint: string): Promise<void> {
    const alerts = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`mailpilot:alert:${fingerprint}`}))`;
      const rows = await tx.alert.findMany({
        where: { fingerprint, status: { in: ["OPEN", "ACKNOWLEDGED"] } },
        select: { id: true },
      });
      if (!rows.length) return rows;
      await tx.alert.updateMany({
        where: { id: { in: rows.map((item) => item.id) } },
        data: {
          status: "RESOLVED",
          resolvedAt: new Date(),
          lastSeenAt: new Date(),
        },
      });
      for (const alert of rows)
        await tx.transactionalOutbox.upsert({
          where: { dedupeKey: `alert-resolved:${alert.id}` },
          create: {
            kind: "WEBHOOK",
            aggregateId: alert.id,
            dedupeKey: `alert-resolved:${alert.id}`,
            payload: {
              event: "ALERT_RESOLVED",
              alertId: alert.id,
            } as Prisma.InputJsonValue,
          },
          update: {},
        });
      return rows;
    });
    if (!alerts.length) return;
    this.events.emit("alert.changed", { fingerprint, status: "RESOLVED" });
  }
}
