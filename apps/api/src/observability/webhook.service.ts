import { Injectable } from "@nestjs/common";
import { createHmac } from "node:crypto";
import { PrismaService } from "../core/prisma.js";
import { CryptoService } from "../core/crypto.js";

@Injectable()
export class WebhookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async deliver(outboxId: string): Promise<void> {
    const outbox = await this.prisma.transactionalOutbox.findUnique({
      where: { id: outboxId },
    });
    if (!outbox || outbox.kind !== "WEBHOOK") return;
    const claimedAt = new Date();
    const claimed = await this.prisma.transactionalOutbox.updateMany({
      where: { id: outbox.id, availableAt: { lte: claimedAt } },
      data: {
        // This database lease also covers the app's direct-delivery fallback,
        // preventing it from racing the BullMQ Worker during recovery.
        availableAt: new Date(claimedAt.getTime() + 60_000),
        publishedAt: claimedAt,
      },
    });
    if (!claimed.count)
      throw new Error("Webhook delivery is already in progress");
    const payloadRef = outbox.payload as {
      event: string;
      alertId: string;
      endpointId?: string;
    };
    const alert = await this.prisma.alert.findUnique({
      where: { id: payloadRef.alertId },
    });
    if (!alert) {
      await this.prisma.transactionalOutbox
        .delete({ where: { id: outboxId } })
        .catch(() => undefined);
      return;
    }
    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: { enabled: true },
    });
    if (!payloadRef.endpointId) {
      const targets = endpoints.filter((endpoint) =>
        this.acceptsEvent(endpoint.eventTypes, payloadRef.event),
      );
      await this.prisma.$transaction(async (tx) => {
        for (const endpoint of targets) {
          const dedupeKey = `webhook-delivery:${outbox.id}:${endpoint.id}`;
          await tx.transactionalOutbox.upsert({
            where: { dedupeKey },
            create: {
              kind: "WEBHOOK",
              aggregateId: alert.id,
              dedupeKey,
              payload: {
                event: payloadRef.event,
                alertId: alert.id,
                endpointId: endpoint.id,
              },
            },
            update: {},
          });
        }
        await tx.transactionalOutbox.deleteMany({ where: { id: outbox.id } });
      });
      return;
    }
    if (payloadRef.endpointId) {
      const endpointExists = endpoints.some(
        (endpoint) => endpoint.id === payloadRef.endpointId,
      );
      if (!endpointExists) {
        await this.prisma.transactionalOutbox
          .delete({ where: { id: outboxId } })
          .catch(() => undefined);
        return;
      }
    }
    const safePayload = {
      id: alert.id,
      event: payloadRef.event,
      severity: alert.severity,
      status: alert.status,
      title: alert.title,
      message: alert.message,
      occurredAt: alert.lastSeenAt.toISOString(),
    };
    const body = JSON.stringify(safePayload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    for (const endpoint of endpoints) {
      if (payloadRef.endpointId && payloadRef.endpointId !== endpoint.id)
        continue;
      if (!this.acceptsEvent(endpoint.eventTypes, payloadRef.event)) continue;
      const secret = await this.crypto.decryptString(
        endpoint.secretEncrypted,
        `webhook:${endpoint.id}`,
      );
      const signature = createHmac("sha256", secret)
        .update(`${timestamp}.${body}`)
        .digest("hex");
      try {
        const response = await fetch(endpoint.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-autoreply-timestamp": timestamp,
            "x-autoreply-signature": `sha256=${signature}`,
          },
          body,
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        await this.prisma.webhookEndpoint.update({
          where: { id: endpoint.id },
          data: { lastSuccessAt: new Date() },
        });
      } catch (error) {
        await this.prisma.webhookEndpoint.update({
          where: { id: endpoint.id },
          data: { lastFailureAt: new Date() },
        });
        throw error;
      }
    }
    await this.prisma.transactionalOutbox
      .delete({ where: { id: outboxId } })
      .catch(() => undefined);
  }

  private acceptsEvent(eventTypes: unknown, event: string): boolean {
    const events = Array.isArray(eventTypes) ? (eventTypes as string[]) : [];
    return !events.length || events.includes("*") || events.includes(event);
  }
}
