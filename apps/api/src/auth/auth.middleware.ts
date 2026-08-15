import { Injectable, NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { AuthService } from "./auth.service.js";
import { AppError } from "../core/http.js";

const PUBLIC_PATHS = new Set([
  "/api/v1/auth/login",
  "/api/v1/microsoft/oauth/callback",
  "/api/v1/google/oauth/callback",
  "/health/live",
  "/health/ready",
]);
const PASSWORD_CHANGE_PATHS = new Set([
  "/api/v1/auth/me",
  "/api/v1/auth/password",
  "/api/v1/auth/logout",
]);

/**
 * Nest's wildcard middleware can mount Express with `req.path` set to `/`.
 * Always derive the route from the original URL so authentication cannot be
 * skipped when the middleware is mounted through a wildcard path.
 */
function requestPath(req: Request): string {
  const raw = req.originalUrl || req.url || req.path || "/";
  return raw.split("?", 1)[0] || "/";
}

@Injectable()
export class AuthMiddleware implements NestMiddleware {
  constructor(private readonly auth: AuthService) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const path = requestPath(req);
    if (!path.startsWith("/api/") || PUBLIC_PATHS.has(path)) return next();
    await this.auth.authenticate(req);
    if (!req.auth) throw new AppError("UNAUTHORIZED", "请先登录", 401);
    if (req.auth.admin.mustChangePassword && !PASSWORD_CHANGE_PATHS.has(path)) {
      throw new AppError(
        "PASSWORD_CHANGE_REQUIRED",
        "首次登录必须先修改临时密码",
        403,
      );
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method))
      this.auth.verifyCsrf(req);
    next();
  }
}
