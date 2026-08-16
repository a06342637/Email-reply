import { afterEach, describe, expect, it, vi } from "vitest";
import { UpdateService } from "./update.service.js";

afterEach(() => vi.unstubAllGlobals());

const testUpdaterToken = `internal-token-${"x".repeat(32)}`;

function configuredService() {
  return new UpdateService({
    version: "0.06",
    updaterUrl: "http://updater:3001",
    updaterToken: testUpdaterToken,
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
          authorization: `Bearer ${testUpdaterToken}`,
        }),
      }),
    );
  });

  it("derives legacy updater fields internally without requesting them from the browser", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ accepted: true }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await configuredService().apply({ targetVersion: "0.07" });
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as Record<string, string>;
    expect(body.targetVersion).toBe("0.07");
    expect(body.backupPassphrase).toHaveLength(43);
    expect(body.confirmation).toBe("UPGRADE");
    expect(body.backupPassphrase).not.toContain(testUpdaterToken);
  });

  it("maps updater conflicts from click-to-upgrade requests", async () => {
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
      configuredService().apply({ targetVersion: "0.07" }),
    ).rejects.toMatchObject({ code: "UPDATE_BUSY", status: 409 });
  });
});
