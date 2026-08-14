import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../core/http.js";
import { GraphError, GraphService } from "./graph.service.js";

function fixture(tokenError?: unknown) {
  const prisma = {
    mailbox: {
      findUnique: vi.fn().mockResolvedValue({
        id: "mailbox-1",
        provider: "MICROSOFT",
        status: "CONNECTED",
        microsoftAuthMode: "MSAL_OAUTH",
        microsoftClientId: null,
        tokenCacheEncrypted: "encrypted-cache",
        homeAccountId: "home-1",
      }),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    microsoftAppConfig: {
      findUnique: vi.fn().mockResolvedValue({
        id: "singleton",
        clientId: "client-id",
        clientSecretEncrypted: "encrypted-secret",
      }),
    },
    autoReplyTask: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    messageReceipt: { findMany: vi.fn().mockResolvedValue([]) },
    transactionalOutbox: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    $executeRaw: vi.fn().mockResolvedValue(0),
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(
    async (callback: (tx: typeof prisma) => Promise<unknown>) =>
      callback(prisma),
  );
  const crypto = {
    decryptString: vi.fn().mockResolvedValue("serialized-cache"),
    encryptString: vi.fn().mockResolvedValue("updated-encrypted-cache"),
  };
  const alerts = {
    open: vi.fn().mockResolvedValue({}),
    resolve: vi.fn().mockResolvedValue(undefined),
  };
  const tokenCache = {
    deserialize: vi.fn(),
    getAccountByHomeId: vi.fn().mockResolvedValue({ homeAccountId: "home-1" }),
    serialize: vi.fn().mockReturnValue("updated-cache"),
  };
  const service = new GraphService(
    prisma as never,
    crypto as never,
    alerts as never,
  );
  const acquireTokenSilent = tokenError
    ? vi.fn().mockRejectedValue(tokenError)
    : vi.fn().mockResolvedValue({ accessToken: "access-token" });
  vi.spyOn(service, "createClient").mockResolvedValue({
    getTokenCache: () => tokenCache,
    acquireTokenSilent,
  } as never);
  return {
    service,
    prisma,
    crypto,
    alerts,
    acquireTokenSilent,
    tokenCache,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GraphService token handling", () => {
  it("uses optimistic concurrency when persisting the MSAL cache", async () => {
    const { service, prisma } = fixture();

    await expect(service.accessToken("mailbox-1")).resolves.toBe(
      "access-token",
    );
    expect(prisma.mailbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "mailbox-1",
          status: "CONNECTED",
          tokenCacheEncrypted: "encrypted-cache",
        }),
        data: expect.objectContaining({
          tokenCacheEncrypted: "updated-encrypted-cache",
        }),
      }),
    );
  });

  it("does not rewrite an unchanged MSAL cache on every Graph request", async () => {
    const { service, prisma, crypto, tokenCache } = fixture();
    tokenCache.serialize.mockReturnValue("serialized-cache");

    await expect(service.accessToken("mailbox-1")).resolves.toBe(
      "access-token",
    );

    expect(crypto.encryptString).not.toHaveBeenCalled();
    expect(prisma.mailbox.updateMany).not.toHaveBeenCalled();
  });

  it("keeps the mailbox connected for transient MSAL failures", async () => {
    const { service, prisma, alerts } = fixture({
      errorCode: "temporarily_unavailable",
      message: "identity provider temporarily unavailable",
    });

    const error = await service
      .accessToken("mailbox-1")
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(GraphError);
    expect((error as GraphError).status).toBe(0);
    expect(prisma.mailbox.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "AUTH_REQUIRED" }),
      }),
    );
    expect(alerts.open).not.toHaveBeenCalled();
  });

  it("marks the mailbox for reauthorization on invalid grants", async () => {
    const { service, prisma, alerts } = fixture({
      errorCode: "invalid_grant",
      message: "refresh token revoked",
    });

    const error = await service
      .accessToken("mailbox-1")
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("MAILBOX_AUTH_REQUIRED");
    expect(prisma.mailbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "AUTH_REQUIRED" }),
      }),
    );
    expect(alerts.open).toHaveBeenCalledOnce();
  });

  it("does not let a stale token failure invalidate replacement credentials", async () => {
    const { service, prisma, alerts } = fixture();
    prisma.mailbox.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      service.requireAuthorization(
        "mailbox-1",
        "invalid_grant",
        "old refresh token revoked",
        {
          id: "mailbox-1",
          provider: "MICROSOFT",
          status: "CONNECTED",
          microsoftAuthMode: "CLIENT_ID_REFRESH_TOKEN",
          microsoftClientId: "11111111-1111-4111-8111-111111111111",
          homeAccountId: "refresh:user-1",
          tokenCacheEncrypted: "stale-encrypted-cache",
        },
      ),
    ).resolves.toBe(false);
    expect(prisma.mailbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tokenCacheEncrypted: "stale-encrypted-cache",
          status: "CONNECTED",
        }),
      }),
    );
    expect(prisma.autoReplyTask.updateMany).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(alerts.open).not.toHaveBeenCalled();
  });

  it("refreshes an imported token without requiring the system app config", async () => {
    const { service, prisma, crypto } = fixture();
    prisma.mailbox.findUnique.mockResolvedValue({
      id: "mailbox-1",
      provider: "MICROSOFT",
      status: "CONNECTED",
      microsoftAuthMode: "CLIENT_ID_REFRESH_TOKEN",
      microsoftClientId: "11111111-1111-4111-8111-111111111111",
      tokenCacheEncrypted: "encrypted-cache",
      homeAccountId: "refresh:user-1",
    });
    crypto.decryptString.mockResolvedValue(
      JSON.stringify({
        version: 1,
        accessToken: "expired-access",
        refreshToken: "old-refresh-token-value",
        expiresAt: 0,
        scope: "User.Read Mail.ReadWrite Mail.Send",
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: "new-access",
            refresh_token: "rotated-refresh-token-value",
            expires_in: 3600,
            scope: "User.Read Mail.ReadWrite Mail.Send",
            token_type: "Bearer",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );

    await expect(service.accessToken("mailbox-1")).resolves.toBe("new-access");
    expect(prisma.microsoftAppConfig.findUnique).not.toHaveBeenCalled();
    const saved = JSON.parse(String(crypto.encryptString.mock.calls[0]?.[0]));
    expect(saved.refreshToken).toBe("rotated-refresh-token-value");
    expect(saved.accessToken).toBe("new-access");
  });

  it("marks an imported mailbox auth-required when its Refresh Token is revoked", async () => {
    const { service, prisma, crypto, alerts } = fixture();
    prisma.mailbox.findUnique.mockResolvedValue({
      id: "mailbox-1",
      provider: "MICROSOFT",
      status: "CONNECTED",
      microsoftAuthMode: "CLIENT_ID_REFRESH_TOKEN",
      microsoftClientId: "11111111-1111-4111-8111-111111111111",
      tokenCacheEncrypted: "encrypted-cache",
      homeAccountId: "refresh:user-1",
    });
    crypto.decryptString.mockResolvedValue(
      JSON.stringify({
        version: 1,
        refreshToken: "revoked-refresh-token-value",
        expiresAt: 0,
        scope: "User.Read Mail.ReadWrite Mail.Send",
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: "invalid_grant",
            error_description: "The refresh token was revoked",
          }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );

    await expect(service.accessToken("mailbox-1")).rejects.toMatchObject({
      code: "MAILBOX_AUTH_REQUIRED",
    });
    expect(prisma.mailbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "AUTH_REQUIRED" }),
      }),
    );
    expect(alerts.open).toHaveBeenCalledOnce();
  });

  it("rejects imported tokens that lack required delegated scopes", async () => {
    const { service } = fixture();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: "access",
            refresh_token: "refresh-token-value-that-is-long-enough",
            expires_in: 3600,
            scope: "User.Read Mail.ReadWrite",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );

    await expect(
      service.exchangeImportedRefreshToken(
        "11111111-1111-4111-8111-111111111111",
        "refresh-token-value-that-is-long-enough",
      ),
    ).rejects.toMatchObject({ code: "MICROSOFT_SCOPES_MISSING" });
  });

  it("does not mark a mailbox auth-required for an unrelated Graph 403", async () => {
    const { service } = fixture();
    vi.spyOn(service, "accessToken").mockResolvedValue("access-token");
    const requireAuthorization = vi
      .spyOn(service, "requireAuthorization")
      .mockResolvedValue();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "ErrorAccessDenied",
              message: "Operation is not allowed for this message",
            },
          }),
          {
            status: 403,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );

    await expect(
      service.request("mailbox-1", "/me/messages/message-1"),
    ).rejects.toBeInstanceOf(GraphError);
    expect(requireAuthorization).not.toHaveBeenCalled();
  });

  it("forces one token refresh after a Graph 401 before failing auth", async () => {
    const { service, acquireTokenSilent } = fixture();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response("", {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ value: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
    );

    await expect(service.request("mailbox-1", "/me/messages")).resolves.toEqual(
      { value: [] },
    );
    expect(acquireTokenSilent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ forceRefresh: false }),
    );
    expect(acquireTokenSilent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ forceRefresh: true }),
    );
  });

  it("never forwards mailbox authorization to a non-Graph absolute URL", async () => {
    const { service } = fixture(new Error("must not request a token"));
    const createClient = vi.spyOn(service, "createClient");

    await expect(
      service.request("mailbox-1", "https://example.com/steal-token"),
    ).rejects.toMatchObject({ code: "GRAPH_URL_REJECTED" });
    expect(createClient).not.toHaveBeenCalled();
  });
});
