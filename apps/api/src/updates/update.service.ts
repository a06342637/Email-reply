import { Injectable } from "@nestjs/common";
import { AppConfig } from "../core/config.js";
import { AppError } from "../core/http.js";

type UpdaterErrorBody = {
  error?: { code?: string; message?: string };
};

@Injectable()
export class UpdateService {
  constructor(private readonly config: AppConfig) {}

  async status(): Promise<Record<string, unknown>> {
    if (!this.config.updaterUrl || !this.config.updaterToken)
      return {
        phase: "DISABLED",
        busy: false,
        currentVersion: this.config.version,
        updateAvailable: false,
        message: "在线升级服务尚未配置，请先按 README 完成升级器初始化。",
      };
    try {
      return await this.request("/v1/status", "GET", undefined, 5_000);
    } catch (error) {
      return {
        phase: "UNAVAILABLE",
        busy: false,
        currentVersion: this.config.version,
        updateAvailable: false,
        message:
          error instanceof Error ? error.message : "暂时无法连接在线升级服务",
      };
    }
  }

  check(): Promise<Record<string, unknown>> {
    this.assertConfigured();
    return this.request("/v1/check", "POST", {}, 60_000);
  }

  apply(input: {
    targetVersion: string;
    backupPassphrase: string;
    confirmation: string;
  }): Promise<Record<string, unknown>> {
    this.assertConfigured();
    return this.request("/v1/apply", "POST", input, 15_000);
  }

  private assertConfigured(): void {
    if (!this.config.updaterUrl || !this.config.updaterToken)
      throw new AppError(
        "UPDATER_NOT_CONFIGURED",
        "在线升级服务尚未配置，请先按 README 完成升级器初始化",
        503,
      );
  }

  private async request(
    path: string,
    method: "GET" | "POST",
    body: unknown,
    timeout: number,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(`${this.config.updaterUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.config.updaterToken}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch {
      throw new AppError(
        "UPDATER_UNAVAILABLE",
        "无法连接在线升级服务，请检查 updater 容器状态",
        503,
      );
    }
    const payload = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    > &
      UpdaterErrorBody;
    if (!response.ok) {
      const upstream = payload.error;
      throw new AppError(
        upstream?.code || "UPDATER_REQUEST_FAILED",
        upstream?.message || "在线升级服务请求失败",
        response.status === 409 ? 409 : 502,
      );
    }
    return payload;
  }
}
