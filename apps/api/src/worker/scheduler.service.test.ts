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
        findUnique: vi.fn().mockResolvedValue({
          secretExpiresAt: new Date(Date.now() - 60_000),
        }),
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
        fingerprint: "microsoft-secret:expired",
        type: "CLIENT_SECRET_EXPIRED",
      }),
    );
    expect(alerts.open).toHaveBeenCalledTimes(1);
    expect(alerts.resolve).toHaveBeenCalledWith("microsoft-secret:30");
    expect(alerts.resolve).toHaveBeenCalledWith("microsoft-secret:7");
    expect(alerts.resolve).toHaveBeenCalledWith("microsoft-secret:1");
  });
});
