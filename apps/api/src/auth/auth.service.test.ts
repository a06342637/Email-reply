import { describe, expect, it, vi } from "vitest";
import { AuthService } from "./auth.service.js";

describe("AuthService session refresh", () => {
  it("refreshes a five-minute idle session before it can expire", async () => {
    const now = Date.now();
    const session = {
      id: "session-1",
      csrfHash: "csrf-hash",
      lastSeenAt: new Date(now - 3 * 60_000),
      expiresAt: new Date(now + 2 * 60_000),
      absoluteExpiresAt: new Date(now + 60 * 60_000),
      admin: {
        id: "admin-1",
        username: "admin",
        mustChangePassword: false,
        theme: "system",
      },
    };
    const prisma = {
      adminSession: {
        findUnique: vi.fn().mockResolvedValue(session),
        update: vi.fn().mockResolvedValue({}),
      },
      systemSetting: {
        findMany: vi.fn().mockResolvedValue([
          { key: "sessionIdleMinutes", value: 5 },
          { key: "sessionAbsoluteMinutes", value: 60 },
        ]),
      },
    };
    const service = new AuthService(
      prisma as never,
      { hmac: vi.fn().mockReturnValue("session-hash") } as never,
      {} as never,
    );
    const request = {
      cookies: { autoreply_session: "raw-session" },
    };

    await service.authenticate(request as never);

    expect(prisma.adminSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "session-1" },
        data: expect.objectContaining({ lastSeenAt: expect.any(Date) }),
      }),
    );
  });
});
