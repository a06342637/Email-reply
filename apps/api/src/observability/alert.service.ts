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
    const existing = await this.prisma.alert.findFirst({
      where: {
        fingerprint: input.fingerprint,
        status: { in: ["OPEN", "ACKNOWLEDGED"] },
      },
      orderBy: { lastSeenAt: "desc" },
    });
    const alert = existing
      ? await this.prisma.alert.update({
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
      : await this.prisma.alert.create({
          data: {
            ...input,
            metadata: input.metadata as Prisma.InputJsonValue,
          },
        });
    if (!existing) {
      await this.prisma.transactionalOutbox.create({
        data: {
          kind: "WEBHOOK",
          aggregateId: alert.id,
          dedupeKey: `alert-opened:${alert.id}`,
          payload: {
            event: input.type,
            alertId: alert.id,
          } as Prisma.InputJsonValue,
        },
      });
    }
    this.events.emit("alert.changed", { id: alert.id, status: alert.status });
    return alert;
  }

  async resolve(fingerprint: string): Promise<void> {
    const alerts = await this.prisma.alert.findMany({
      where: { fingerprint, status: { in: ["OPEN", "ACKNOWLEDGED"] } },
      select: { id: true },
    });
    if (!alerts.length) return;
    await this.prisma.alert.updateMany({
      where: { id: { in: alerts.map((item) => item.id) } },
      data: {
        status: "RESOLVED",
        resolvedAt: new Date(),
        lastSeenAt: new Date(),
      },
    });
    for (const alert of alerts)
      await this.prisma.transactionalOutbox
        .create({
          data: {
            kind: "WEBHOOK",
            aggregateId: alert.id,
            dedupeKey: `alert-resolved:${alert.id}`,
            payload: {
              event: "ALERT_RESOLVED",
              alertId: alert.id,
            } as Prisma.InputJsonValue,
          },
        })
        .catch((error) => {
          if (
            typeof error === "object" &&
            error &&
            "code" in error &&
            (error as { code: unknown }).code === "P2002"
          )
            return;
          throw error;
        });
    this.events.emit("alert.changed", { fingerprint, status: "RESOLVED" });
  }
}
