import { describe, expect, it, vi } from "vitest";
import { GoogleService } from "./google.service.js";

describe("GoogleService", () => {
  it("creates a PKCE OAuth URL and provider-bound state", async () => {
    const prisma = {
      systemSetting: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ value: "https://mail.example.com" }),
      },
      googleAppConfig: {
        findUnique: vi.fn().mockResolvedValue({
          clientId: "client.apps.googleusercontent.com",
        }),
      },
      oAuthState: { create: vi.fn().mockResolvedValue({}) },
    };
    const crypto = {
      randomToken: vi
        .fn()
        .mockReturnValueOnce("raw-state")
        .mockReturnValueOnce("pkce-verifier"),
      hmac: vi.fn().mockReturnValue("state-hash"),
      encryptString: vi.fn().mockResolvedValue("encrypted-verifier"),
    };
    const service = new GoogleService(
      prisma as never,
      crypto as never,
      { publicUrl: "" } as never,
      {} as never,
      {} as never,
    );

    const result = await service.startOAuth("/mailboxes");
    const url = new URL(result.authorizationUrl);

    expect(url.hostname).toBe("accounts.google.com");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toContain("gmail.readonly");
    expect(prisma.oAuthState.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ provider: "GOOGLE" }),
      }),
    );
  });

  it("persists a connected Gmail mailbox with encrypted portable tokens", async () => {
    const state = {
      id: "state-1",
      provider: "GOOGLE",
      stateHash: "hash",
      verifierEncrypted: "encrypted-verifier",
      redirectAfter: "/mailboxes",
      expiresAt: new Date(Date.now() + 60_000),
    };
    const prisma = {
      systemSetting: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ value: "https://mail.example.com" }),
      },
      oAuthState: {
        findUnique: vi.fn().mockResolvedValue(state),
        delete: vi.fn().mockResolvedValue({}),
      },
      mailbox: {
        findUnique: vi.fn().mockResolvedValue(null),
        count: vi.fn().mockResolvedValue(0),
        upsert: vi
          .fn()
          .mockImplementation(({ create }) =>
            Promise.resolve({ id: create.id }),
          ),
      },
    };
    const crypto = {
      safeEqual: vi.fn().mockReturnValue(true),
      hmac: vi.fn().mockReturnValue("hash"),
      decryptString: vi.fn().mockResolvedValue("verifier"),
      encryptString: vi.fn().mockResolvedValue("encrypted-google-token"),
    };
    const gmail = {
      exchangeAuthorizationCode: vi.fn().mockResolvedValue({
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: Date.now() + 3_600_000,
      }),
      gmailProfile: vi.fn().mockResolvedValue({
        emailAddress: "owner@gmail.com",
        historyId: "100",
      }),
      userInfo: vi
        .fn()
        .mockResolvedValue({ sub: "google-user-1", name: "Owner" }),
    };
    const alerts = { resolve: vi.fn().mockResolvedValue(undefined) };
    const service = new GoogleService(
      prisma as never,
      crypto as never,
      { publicUrl: "" } as never,
      gmail as never,
      alerts as never,
    );

    await expect(
      service.finishOAuth("code", "state-1.raw"),
    ).resolves.toMatchObject({
      redirectTo: "/mailboxes",
    });
    expect(crypto.encryptString).toHaveBeenCalledWith(
      expect.stringContaining('"refreshToken":"refresh"'),
      expect.stringMatching(/^google-token:/),
    );
    expect(prisma.mailbox.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          provider: "GOOGLE",
          accountType: "GMAIL_PERSONAL",
          status: "CONNECTED",
        }),
      }),
    );
  });

  it("allows a removed Microsoft record to be reconnected as Gmail", async () => {
    const state = {
      id: "state-1",
      provider: "GOOGLE",
      stateHash: "hash",
      verifierEncrypted: "encrypted-verifier",
      redirectAfter: "/mailboxes",
      expiresAt: new Date(Date.now() + 60_000),
    };
    const prisma = {
      systemSetting: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ value: "https://mail.example.com" }),
      },
      oAuthState: {
        findUnique: vi.fn().mockResolvedValue(state),
        delete: vi.fn().mockResolvedValue({}),
      },
      mailbox: {
        findUnique: vi.fn().mockResolvedValue({
          id: "mailbox-1",
          provider: "MICROSOFT",
          status: "REMOVED",
        }),
        count: vi.fn().mockResolvedValue(0),
        upsert: vi.fn().mockResolvedValue({ id: "mailbox-1" }),
      },
    };
    const service = new GoogleService(
      prisma as never,
      {
        safeEqual: vi.fn().mockReturnValue(true),
        hmac: vi.fn().mockReturnValue("hash"),
        decryptString: vi.fn().mockResolvedValue("verifier"),
        encryptString: vi.fn().mockResolvedValue("encrypted-google-token"),
      } as never,
      { publicUrl: "" } as never,
      {
        exchangeAuthorizationCode: vi.fn().mockResolvedValue({
          accessToken: "access",
          refreshToken: "refresh",
        }),
        gmailProfile: vi.fn().mockResolvedValue({
          emailAddress: "owner@example.com",
          historyId: "100",
        }),
        userInfo: vi.fn().mockResolvedValue({
          sub: "google-user-1",
          name: "Owner",
        }),
      } as never,
      { resolve: vi.fn().mockResolvedValue(undefined) } as never,
    );

    await expect(
      service.finishOAuth("code", "state-1.raw"),
    ).resolves.toMatchObject({ mailboxId: "mailbox-1" });
    expect(prisma.mailbox.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          provider: "GOOGLE",
          microsoftAuthMode: "MSAL_OAUTH",
          microsoftClientId: null,
        }),
      }),
    );
  });
});
