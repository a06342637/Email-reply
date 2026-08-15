import { afterEach, describe, expect, it, vi } from "vitest";
import { UpdateService } from "./update.service.js";

afterEach(() => vi.unstubAllGlobals());

function configuredService() {
  return new UpdateService({
    version: "0.06",
    updaterUrl: "http://updater:3001",
    updaterToken: "internal-token",
  } as never);
}

describe("UpdateService", () => {
  it("returns a safe disabled state without leaking configuration details", async () => {
    const service = new UpdateService({
      version: "0.06",
      updaterUrl: "",
      updaterToken: "",
    } as never);
    await expect(service.status()).resolves.toMatchObject({
      phase: "DISABLED",
      currentVersion: "0.06",
    });
  });

  it("authenticates requests to the internal updater", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ phase: "UP_TO_DATE" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await configuredService().check();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://updater:3001/v1/check",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer internal-token",
        }),
      }),
    );
  });

  it("maps updater conflicts without exposing the backup passphrase", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: "UPDATE_BUSY", message: "已有升级任务正在运行" },
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    await expect(
      configuredService().apply({
        targetVersion: "0.07",
        backupPassphrase: "do-not-log-this-password",
        confirmation: "UPGRADE",
      }),
    ).rejects.toMatchObject({ code: "UPDATE_BUSY", status: 409 });
  });
});
