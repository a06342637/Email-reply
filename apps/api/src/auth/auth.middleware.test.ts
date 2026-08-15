import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { AppError } from "../core/http.js";
import { AuthMiddleware } from "./auth.middleware.js";

function request(originalUrl: string, method = "GET"): Request {
  // Nest's wildcard middleware may expose `/` as req.path. The original URL
  // is the value the middleware must use for its authentication decision.
  return {
    path: "/",
    url: originalUrl,
    originalUrl,
    method,
  } as unknown as Request;
}

describe("AuthMiddleware route matching", () => {
  it("authenticates API routes using originalUrl when req.path is stripped", async () => {
    const auth = {
      authenticate: vi.fn().mockImplementation(async (req: Request) => {
        req.auth = { admin: { mustChangePassword: false } } as never;
      }),
      verifyCsrf: vi.fn(),
    };
    const middleware = new AuthMiddleware(auth as never);
    const req = request("/api/v1/dashboard?range=24h");
    const next = vi.fn() as unknown as NextFunction;

    await middleware.use(req, {} as Response, next);

    expect(auth.authenticate).toHaveBeenCalledWith(req);
    expect(next).toHaveBeenCalledOnce();
  });

  it("does not authenticate public health routes", async () => {
    const auth = {
      authenticate: vi.fn(),
      verifyCsrf: vi.fn(),
    };
    const middleware = new AuthMiddleware(auth as never);
    const next = vi.fn() as unknown as NextFunction;

    await middleware.use(request("/health/ready"), {} as Response, next);

    expect(auth.authenticate).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it("keeps the first-login exception limited to password routes", async () => {
    const auth = {
      authenticate: vi.fn().mockImplementation(async (req: Request) => {
        req.auth = {
          admin: { mustChangePassword: true },
        } as never;
      }),
      verifyCsrf: vi.fn(),
    };
    const middleware = new AuthMiddleware(auth as never);
    const next = vi.fn() as unknown as NextFunction;

    await expect(
      middleware.use(request("/api/v1/dashboard"), {} as Response, next),
    ).rejects.toMatchObject({
      code: "PASSWORD_CHANGE_REQUIRED",
      status: 403,
    } satisfies Partial<AppError>);

    await middleware.use(
      request("/api/v1/auth/password", "POST"),
      {} as Response,
      next,
    );
    expect(auth.verifyCsrf).toHaveBeenCalled();
  });
});
