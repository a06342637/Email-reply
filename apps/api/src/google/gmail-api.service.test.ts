import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../core/http.js";
import { GmailApiService, GoogleApiError } from "./gmail-api.service.js";

function fixture(tokenResponse: Record<string, unknown>) {
  const prisma = {
    mailbox: {
      findUnique: vi.fn().mockResolvedValue({
        id: "gmail-1",
        provider: "GOOGLE",
        status: "CONNECTED",
        tokenCacheEncrypted: "encrypted-token",
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    googleAppConfig: {
      findUnique: vi.fn().mockResolvedValue({
        clientId: "client.apps.googleusercontent.com",
        clientSecretEncrypted: "encrypted-secret",
      }),
    },
    autoReplyTask: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    $executeRaw: vi.fn().mockResolvedValue(0),
  };
  const crypto = {
    decryptString: vi.fn((value: string) =>
      Promise.resolve(
        value === "encrypted-token"
          ? JSON.stringify({
              accessToken: "old-access",
              refreshToken: "refresh-token",
              expiresAt: 1,
            })
          : "client-secret",
      ),
    ),
    encryptString: vi.fn().mockResolvedValue("updated-encrypted-token"),
  };
  const alerts = { open: vi.fn().mockResolvedValue({}) };
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(tokenResponse), {
        status: tokenResponse.error ? 400 : 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
  return {
    service: new GmailApiService(
      prisma as never,
      crypto as never,
      alerts as never,
    ),
    prisma,
    crypto,
    alerts,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("GmailApiService", () => {
  it("refreshes and persists Google tokens with optimistic concurrency", async () => {
    const { service, prisma, crypto } = fixture({
      access_token: "new-access",
      expires_in: 3600,
      token_type: "Bearer",
    });

    await expect(service.accessToken("gmail-1")).resolves.toBe("new-access");
    expect(crypto.encryptString).toHaveBeenCalledWith(
      expect.stringContaining('"refreshToken":"refresh-token"'),
      "google-token:gmail-1",
    );
    expect(prisma.mailbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          provider: "GOOGLE",
          tokenCacheEncrypted: "encrypted-token",
        }),
      }),
    );
  });

  it("marks the mailbox for reauthorization when a refresh token is revoked", async () => {
    const { service, prisma, alerts } = fixture({
      error: "invalid_grant",
      error_description: "Token has been revoked",
    });

    const error = await service
      .accessToken("gmail-1")
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

  it("rejects an OAuth grant that omits a required Gmail permission", async () => {
    const { service } = fixture({
      access_token: "access-token",
      refresh_token: "refresh-token",
      scope: "openid email https://www.googleapis.com/auth/gmail.readonly",
    });

    const error = await service
      .exchangeAuthorizationCode(
        "authorization-code",
        "pkce-verifier",
        "https://mail.example.com/api/v1/google/oauth/callback",
      )
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("GOOGLE_SCOPES_MISSING");
  });

  it("rejects non-Gmail absolute URLs before obtaining an access token", async () => {
    const { service } = fixture({ access_token: "unused" });
    const accessToken = vi.spyOn(service, "accessToken");

    await expect(
      service.request("gmail-1", "https://example.com/steal-token"),
    ).rejects.toBeInstanceOf(GoogleApiError);
    expect(accessToken).not.toHaveBeenCalled();
  });

  it("does not invalidate mailbox authorization when Gmail API is disabled for the project", async () => {
    const { service, prisma, alerts } = fixture({ access_token: "unused" });
    vi.spyOn(service, "accessToken").mockResolvedValue("access-token");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              status: "PERMISSION_DENIED",
              message: "Gmail API has not been used in this project",
              errors: [{ reason: "accessNotConfigured" }],
            },
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const error = await service
      .request("gmail-1", "/profile", {}, { maxRetries: 0 })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(GoogleApiError);
    expect((error as GoogleApiError).code).toBe("accessNotConfigured");
    expect(prisma.mailbox.updateMany).not.toHaveBeenCalled();
    expect(alerts.open).not.toHaveBeenCalled();
  });
});
