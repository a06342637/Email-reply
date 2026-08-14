import { describe, expect, it, vi } from "vitest";
import { AppError } from "../core/http.js";
import { GraphError } from "./graph.service.js";
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
      $executeRaw: vi.fn().mockResolvedValue(1),
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
    expect(tx.mailbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          provider: "MICROSOFT",
          microsoftAuthMode: "MSAL_OAUTH",
        }),
      }),
    );
    expect(tx.autoReplyTask.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it("validates and stores a Client ID + Refresh Token mailbox", async () => {
    const prisma = {
      mailbox: {
        findUnique: vi.fn().mockResolvedValue({
          id: "mailbox-1",
          provider: "MICROSOFT",
          status: "AUTH_REQUIRED",
        }),
        count: vi.fn().mockResolvedValue(0),
        upsert: vi.fn().mockResolvedValue({
          id: "mailbox-1",
          email: "user@example.com",
          displayName: "Example User",
        }),
      },
    };
    const crypto = {
      encryptString: vi.fn().mockResolvedValue("encrypted-token-cache"),
    };
    const graph = {
      exchangeImportedRefreshToken: vi.fn().mockResolvedValue({
        version: 1,
        accessToken: "access-token",
        refreshToken: "rotated-refresh-token",
        expiresAt: Date.now() + 3_600_000,
        scope: "User.Read Mail.ReadWrite Mail.Send",
      }),
      profile: vi.fn().mockResolvedValue({
        id: "profile-1",
        displayName: "Example User",
        mail: "User@Example.com",
      }),
      validateMailboxReadAccess: vi.fn().mockResolvedValue(undefined),
      tokenIdentity: vi.fn().mockReturnValue({
        tenantId: "tenant-1",
        objectId: "object-1",
      }),
    };
    const alerts = { resolve: vi.fn().mockResolvedValue(undefined) };
    const service = new MicrosoftService(
      prisma as never,
      crypto as never,
      {} as never,
      graph as never,
      alerts as never,
    );

    const result = await service.importRefreshToken({
      clientId: "11111111-1111-4111-8111-111111111111",
      refreshToken: "source-refresh-token-value",
    });

    expect(result).toEqual({
      mailboxId: "mailbox-1",
      email: "user@example.com",
      displayName: "Example User",
      authMode: "CLIENT_ID_REFRESH_TOKEN",
    });
    expect(result).not.toHaveProperty("refreshToken");
    expect(graph.validateMailboxReadAccess).toHaveBeenCalledWith(
      "access-token",
    );
    expect(prisma.mailbox.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          microsoftAuthMode: "CLIENT_ID_REFRESH_TOKEN",
          microsoftClientId: "11111111-1111-4111-8111-111111111111",
          tokenCacheEncrypted: "encrypted-token-cache",
        }),
      }),
    );
    expect(crypto.encryptString).toHaveBeenCalledWith(
      expect.stringContaining("rotated-refresh-token"),
      "msal:mailbox-1",
    );
    expect(alerts.resolve).toHaveBeenCalledWith("mailbox-auth:mailbox-1");
  });

  it("rejects an invalid imported Refresh Token before writing a mailbox", async () => {
    const prisma = {
      mailbox: {
        findUnique: vi.fn(),
        count: vi.fn(),
        upsert: vi.fn(),
      },
    };
    const graph = {
      exchangeImportedRefreshToken: vi
        .fn()
        .mockRejectedValue(
          new GraphError(
            400,
            "invalid_grant",
            "The refresh token is invalid or expired",
          ),
        ),
    };
    const service = new MicrosoftService(
      prisma as never,
      {} as never,
      {} as never,
      graph as never,
      {} as never,
    );

    const error = await service
      .importRefreshToken({
        clientId: "11111111-1111-4111-8111-111111111111",
        refreshToken: "invalid-refresh-token-value",
      })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("MICROSOFT_REFRESH_TOKEN_INVALID");
    expect(prisma.mailbox.upsert).not.toHaveBeenCalled();
  });

  it("does not write a mailbox when Graph folder access validation fails", async () => {
    const prisma = {
      mailbox: {
        findUnique: vi.fn(),
        count: vi.fn(),
        upsert: vi.fn(),
      },
    };
    const graph = {
      exchangeImportedRefreshToken: vi.fn().mockResolvedValue({
        version: 1,
        accessToken: "access-token",
        refreshToken: "refresh-token-value",
        scope: "User.Read Mail.ReadWrite Mail.Send",
      }),
      profile: vi.fn().mockResolvedValue({
        id: "profile-1",
        mail: "user@example.com",
      }),
      validateMailboxReadAccess: vi
        .fn()
        .mockRejectedValue(
          new AppError(
            "MICROSOFT_MAILBOX_ACCESS_FAILED",
            "mailbox folders unavailable",
            409,
          ),
        ),
    };
    const service = new MicrosoftService(
      prisma as never,
      {} as never,
      {} as never,
      graph as never,
      {} as never,
    );

    await expect(
      service.importRefreshToken({
        clientId: "11111111-1111-4111-8111-111111111111",
        refreshToken: "refresh-token-value",
      }),
    ).rejects.toMatchObject({ code: "MICROSOFT_MAILBOX_ACCESS_FAILED" });
    expect(prisma.mailbox.findUnique).not.toHaveBeenCalled();
    expect(prisma.mailbox.upsert).not.toHaveBeenCalled();
  });

  it("refuses to overwrite a Gmail mailbox with a Microsoft import", async () => {
    const prisma = {
      mailbox: {
        findUnique: vi.fn().mockResolvedValue({
          id: "gmail-mailbox-1",
          provider: "GOOGLE",
          status: "CONNECTED",
        }),
        count: vi.fn(),
        upsert: vi.fn(),
      },
    };
    const graph = {
      exchangeImportedRefreshToken: vi.fn().mockResolvedValue({
        version: 1,
        accessToken: "access-token",
        refreshToken: "refresh-token-value",
        scope: "User.Read Mail.ReadWrite Mail.Send",
      }),
      profile: vi.fn().mockResolvedValue({
        id: "profile-1",
        mail: "same@example.com",
      }),
      validateMailboxReadAccess: vi.fn().mockResolvedValue(undefined),
    };
    const service = new MicrosoftService(
      prisma as never,
      {} as never,
      {} as never,
      graph as never,
      {} as never,
    );

    await expect(
      service.importRefreshToken({
        clientId: "11111111-1111-4111-8111-111111111111",
        refreshToken: "refresh-token-value",
      }),
    ).rejects.toMatchObject({ code: "MAILBOX_PROVIDER_CONFLICT" });
    expect(prisma.mailbox.upsert).not.toHaveBeenCalled();
  });

  it("allows a removed Gmail record to be reconnected as Microsoft", async () => {
    const prisma = {
      mailbox: {
        findUnique: vi.fn().mockResolvedValue({
          id: "mailbox-1",
          provider: "GOOGLE",
          status: "REMOVED",
        }),
        count: vi.fn().mockResolvedValue(0),
        upsert: vi.fn().mockResolvedValue({
          id: "mailbox-1",
          email: "user@example.com",
          displayName: "Example User",
        }),
      },
    };
    const graph = {
      exchangeImportedRefreshToken: vi.fn().mockResolvedValue({
        version: 1,
        accessToken: "access-token",
        refreshToken: "refresh-token-value",
        scope: "User.Read Mail.ReadWrite Mail.Send",
      }),
      profile: vi.fn().mockResolvedValue({
        id: "profile-1",
        displayName: "Example User",
        mail: "user@example.com",
      }),
      validateMailboxReadAccess: vi.fn().mockResolvedValue(undefined),
      tokenIdentity: vi.fn().mockReturnValue({ objectId: "object-1" }),
    };
    const service = new MicrosoftService(
      prisma as never,
      { encryptString: vi.fn().mockResolvedValue("encrypted") } as never,
      {} as never,
      graph as never,
      { resolve: vi.fn().mockResolvedValue(undefined) } as never,
    );

    await expect(
      service.importRefreshToken({
        clientId: "11111111-1111-4111-8111-111111111111",
        refreshToken: "refresh-token-value",
      }),
    ).resolves.toMatchObject({ mailboxId: "mailbox-1" });
    expect(prisma.mailbox.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          provider: "MICROSOFT",
          microsoftAuthMode: "CLIENT_ID_REFRESH_TOKEN",
        }),
      }),
    );
  });

  it("switches an existing manual mailbox back to MSAL when OAuth succeeds", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "mailbox-1" });
    const prisma = {
      oAuthState: {
        findUnique: vi.fn().mockResolvedValue({
          id: "state-1",
          provider: "MICROSOFT",
          stateHash: "state-hash",
          verifierEncrypted: "encrypted-verifier",
          redirectAfter: "/mailboxes",
          expiresAt: new Date(Date.now() + 60_000),
        }),
        delete: vi.fn().mockResolvedValue({}),
      },
      microsoftAppConfig: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          clientId: "system-client-id",
          clientSecretEncrypted: "encrypted-secret",
        }),
      },
      systemSetting: { findUnique: vi.fn().mockResolvedValue(null) },
      mailbox: {
        findUnique: vi.fn().mockResolvedValue({
          id: "mailbox-1",
          provider: "MICROSOFT",
          status: "CONNECTED",
          microsoftAuthMode: "CLIENT_ID_REFRESH_TOKEN",
        }),
        upsert,
      },
    };
    const crypto = {
      safeEqual: vi.fn().mockReturnValue(true),
      hmac: vi.fn().mockReturnValue("state-hash"),
      decryptString: vi.fn().mockResolvedValue("pkce-verifier"),
      encryptString: vi.fn().mockResolvedValue("encrypted-msal-cache"),
    };
    const graph = {
      createClient: vi.fn().mockResolvedValue({
        acquireTokenByCode: vi.fn().mockResolvedValue({
          accessToken: "access-token",
          account: {
            username: "user@example.com",
            name: "Example User",
            homeAccountId: "home-account-1",
            tenantId: "9188040d-6c67-4c5b-b112-36a304b66dad",
          },
        }),
        getTokenCache: () => ({ serialize: () => "serialized-msal-cache" }),
      }),
      profile: vi.fn().mockResolvedValue({
        id: "profile-1",
        displayName: "Example User",
        mail: "user@example.com",
      }),
      validateMailboxReadAccess: vi.fn().mockResolvedValue(undefined),
    };
    const alerts = { resolve: vi.fn().mockResolvedValue(undefined) };
    const service = new MicrosoftService(
      prisma as never,
      crypto as never,
      { publicUrl: "https://mail.example.com" } as never,
      graph as never,
      alerts as never,
    );

    await expect(
      service.finishOAuth("authorization-code", "state-1.raw-state"),
    ).resolves.toMatchObject({ mailboxId: "mailbox-1" });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          microsoftAuthMode: "MSAL_OAUTH",
          microsoftClientId: null,
          tokenCacheEncrypted: "encrypted-msal-cache",
        }),
      }),
    );
  });
});
