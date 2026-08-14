import { describe, expect, it, vi } from "vitest";
import { AppError } from "../core/http.js";
import { GraphError, GraphService } from "./graph.service.js";

function fixture(tokenError?: unknown) {
  const prisma = {
    mailbox: {
      findUnique: vi.fn().mockResolvedValue({
        id: "mailbox-1",
        status: "CONNECTED",
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
  };
  const crypto = {
    decryptString: vi.fn().mockResolvedValue("serialized-cache"),
    encryptString: vi.fn().mockResolvedValue("updated-encrypted-cache"),
  };
  const alerts = { open: vi.fn().mockResolvedValue({}) };
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
  return { service, prisma, alerts };
}

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
    expect(prisma.mailbox.update).not.toHaveBeenCalled();
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
    expect(prisma.mailbox.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "AUTH_REQUIRED" }),
      }),
    );
    expect(alerts.open).toHaveBeenCalledOnce();
  });

  it("never forwards mailbox authorization to a non-Graph absolute URL", async () => {
    const { service } = fixture(new Error("must not request a token"));
    const accessToken = vi.spyOn(service, "accessToken");

    await expect(
      service.request("mailbox-1", "https://example.com/steal-token"),
    ).rejects.toMatchObject({ code: "GRAPH_URL_REJECTED" });
    expect(accessToken).not.toHaveBeenCalled();
  });
});
