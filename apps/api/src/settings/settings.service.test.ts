import { describe, expect, it, vi } from "vitest";
import { SettingsService } from "./settings.service.js";

function serviceFixture() {
  const upsert = vi.fn().mockResolvedValue({});
  const prisma = {
    systemSetting: {
      upsert,
      findMany: vi.fn().mockResolvedValue([]),
    },
    microsoftAppConfig: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(async (operations: Array<Promise<unknown>>) =>
      Promise.all(operations),
    ),
  };
  const service = new SettingsService(
    prisma as never,
    {
      version: "0.01",
    } as never,
  );
  return { service, prisma, upsert };
}

describe("SettingsService", () => {
  it("returns defaults for all four visible log and alert retention periods", async () => {
    const { service } = serviceFixture();

    await expect(service.get()).resolves.toMatchObject({
      processingLogDays: 30,
      systemLogDays: 30,
      alertLogDays: 30,
      auditLogDays: 180,
      dedupeDays: 365,
    });
  });

  it("validates the complete payload before writing any setting", async () => {
    const { service, prisma, upsert } = serviceFixture();

    await expect(
      service.update({ siteName: "Changed", timezone: "Invalid/Timezone" }),
    ).rejects.toMatchObject({ code: "TIMEZONE_INVALID" });

    expect(upsert).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("trims UI values and writes them in one transaction", async () => {
    const { service, prisma, upsert } = serviceFixture();

    await service.update({
      siteName: "  Customer Mail  ",
      timezone: " Asia/Shanghai ",
      excludedDomains: [" example.com ", "example.com", ""],
    });

    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: "siteName" },
        update: { value: "Customer Mail" },
      }),
    );
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: "excludedDomains" },
        update: { value: ["example.com"] },
      }),
    );
  });
});
