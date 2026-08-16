import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";

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

@Injectable()
export class AppConfig {
  readonly nodeEnv = process.env.NODE_ENV ?? "development";
  readonly version = process.env.APP_VERSION ?? "0.18";
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
