import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { Request } from "express";

function integer(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

export function normalizePublicUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("PUBLIC_URL must be a valid HTTPS origin");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !["", "/"].includes(parsed.pathname)
  )
    throw new Error("PUBLIC_URL must be a valid HTTPS origin");
  return parsed.origin;
}

export function contentSecurityPolicyDirectives(): Record<
  string,
  string[] | null
> {
  return {
    defaultSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", "data:", "blob:", "cid:"],
    connectSrc: ["'self'"],
    scriptSrc: ["'self'"],
    objectSrc: ["'none'"],
    frameAncestors: ["'none'"],
    // 后台既可能通过 HTTPS 域名打开，也可能通过 IP 直连的明文 HTTP 打开。
    // Helmet 通过 useDefaults 附带的 upgrade-insecure-requests 会让浏览器把首页
    // 引用的同源 JS 与 CSS 升级到并不存在的 HTTPS 端口，明文访问时只剩空白页面。
    // 前端只使用同源相对路径资源，通过 HTTPS 打开时这些请求天然就是 HTTPS，
    // 该指令没有可保护的混合内容，因此统一不下发。
    upgradeInsecureRequests: null,
  };
}

// 实例不再要求预先配置公开地址：没有显式配置时，按管理员当前访问后台所用的
// 协议与主机推导出公开来源。反向代理与 Cloudflare Tunnel 都会转发原始主机，
// 并用 X-Forwarded-Proto 标出外层协议。只有 HTTPS 来源会被接受，OAuth 回调
// 因此不会退回到明文地址。
export function requestPublicOrigin(req: Request): string {
  const forwardedHost = req.header("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || req.header("host")?.trim();
  if (!host) return "";
  const forwardedProto = req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProto || (req.secure ? "https" : "http");
  try {
    return normalizePublicUrl(`${protocol}://${host}`);
  } catch {
    return "";
  }
}

@Injectable()
export class AppConfig {
  readonly nodeEnv = process.env.NODE_ENV ?? "development";
  readonly version = process.env.APP_VERSION ?? "0.20";
  readonly host = process.env.APP_HOST ?? "0.0.0.0";
  readonly port = integer("APP_PORT", 3000);
  readonly databaseUrl = process.env.DATABASE_URL ?? "";
  readonly redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
  readonly instanceKey = process.env.INSTANCE_KEY ?? "";
  readonly sessionSecret = process.env.SESSION_SECRET ?? "";
  readonly publicUrl = normalizePublicUrl(process.env.PUBLIC_URL ?? "");
  readonly timezone = process.env.TZ ?? "Asia/Shanghai";
  readonly trustProxy = integer("TRUST_PROXY", 0);
  readonly bootstrapFile =
    process.env.BOOTSTRAP_FILE ?? "/bootstrap/admin.json";
  readonly workerId = process.env.WORKER_ID ?? `worker-${process.pid}`;
  readonly updaterUrl = (process.env.UPDATER_URL ?? "").replace(/\/$/, "");
  readonly updaterToken =
    process.env.UPDATER_TOKEN ||
    (this.instanceKey
      ? createHash("sha256")
          .update(`mailpilot-updater:${this.instanceKey}`)
          .digest("hex")
      : "");

  validate(): void {
    const missing: string[] = [];
    if (!this.databaseUrl) missing.push("DATABASE_URL");
    if (!this.instanceKey) missing.push("INSTANCE_KEY");
    if (!this.sessionSecret) missing.push("SESSION_SECRET");
    if (missing.length)
      throw new Error(
        `Missing required environment variables: ${missing.join(", ")}`,
      );
    const key = Buffer.from(this.instanceKey, "base64");
    if (key.length !== 32)
      throw new Error("INSTANCE_KEY must be a base64 encoded 32-byte key");
    if (this.sessionSecret.length < 32)
      throw new Error("SESSION_SECRET must contain at least 32 characters");
    try {
      new Intl.DateTimeFormat("en", { timeZone: this.timezone }).format();
    } catch {
      throw new Error("TZ must be a valid IANA timezone");
    }
  }
}
