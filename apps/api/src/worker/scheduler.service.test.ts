import { describe, expect, it, vi } from "vitest";
import { SchedulerService } from "./scheduler.service.js";

describe("SchedulerService secret expiry", () => {
  it("reports a Client Secret as expired immediately after its timestamp", async () => {
    const alerts = {
      open: vi.fn().mockResolvedValue({}),
      resolve: vi.fn().mockResolvedValue(undefined),
    };
    const prisma = {
      microsoftAppConfig: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "app-1",
            name: "Primary Microsoft",
            secretExpiresAt: new Date(Date.now() - 60_000),
          },
        ]),
      },
    };
    const service = new SchedulerService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      alerts as never,
      {} as never,
    );

    await (service as any).checkSecretExpiry();

    expect(alerts.open).toHaveBeenCalledWith(
      expect.objectContaining({
        fingerprint: "microsoft-secret:app-1:expired",
        type: "CLIENT_SECRET_EXPIRED",
      }),
    );
    expect(alerts.open).toHaveBeenCalledTimes(1);
    expect(alerts.resolve).toHaveBeenCalledWith("microsoft-secret:app-1:30");
    expect(alerts.resolve).toHaveBeenCalledWith("microsoft-secret:app-1:7");
    expect(alerts.resolve).toHaveBeenCalledWith("microsoft-secret:app-1:1");
  });

  it("deletes only resolved alerts after the configured retention period", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T00:00:00.000Z"));
    try {
      const prisma = {
        systemSetting: {
          findMany: vi
            .fn()
            .mockResolvedValue([{ key: "alertLogDays", value: 14 }]),
        },
        processingLog: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        systemLog: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        alert: { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) },
        auditLog: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        messageReceipt: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        adminSession: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        oAuthState: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        $executeRaw: vi.fn().mockResolvedValue(0),
      };
      const service = new SchedulerService(
        prisma as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );

      await (service as any).cleanup();

      expect(prisma.systemSetting.findMany).toHaveBeenCalledWith({
        where: {
          key: {
            in: expect.arrayContaining(["alertLogDays"]),
          },
        },
      });
      expect(prisma.alert.deleteMany).toHaveBeenCalledWith({
        where: {
          status: "RESOLVED",
          lastSeenAt: { lt: new Date("2026-08-02T00:00:00.000Z") },
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
