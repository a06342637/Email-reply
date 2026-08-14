import { describe, expect, it, vi } from "vitest";
import { MicrosoftService } from "./microsoft.service.js";

describe("MicrosoftService", () => {
  it("changes the client ID and pauses affected work in one transaction", async () => {
    const tx = {
      microsoftAppConfig: {
        upsert: vi.fn().mockResolvedValue({
          clientId: "new-client",
          secretExpiresAt: null,
        }),
      },
      mailbox: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      autoReplyTask: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      transactionalOutbox: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      microsoftAppConfig: {
        findUnique: vi.fn().mockResolvedValue({
          clientId: "old-client",
          clientSecretEncrypted: "old-secret",
        }),
      },
      mailbox: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn((callback) => callback(tx)),
    };
    const crypto = {
      encryptString: vi.fn().mockResolvedValue("new-secret-encrypted"),
    };
    const service = new MicrosoftService(
      prisma as never,
      crypto as never,
      {} as never,
      {} as never,
      { open: vi.fn() } as never,
    );

    await expect(
      service.saveConfig({
        clientId: "new-client",
        clientSecret: "new-secret",
      }),
    ).resolves.toMatchObject({ clientId: "new-client", clientChanged: true });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.microsoftAppConfig.upsert).toHaveBeenCalledTimes(1);
    expect(tx.mailbox.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.autoReplyTask.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.transactionalOutbox.deleteMany).toHaveBeenCalledTimes(1);
  });
});
