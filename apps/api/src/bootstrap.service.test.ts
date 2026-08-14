import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BootstrapService } from "./bootstrap.service.js";

describe("BootstrapService", () => {
  it("removes a stale plaintext bootstrap file when an admin already exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mailpilot-bootstrap-"));
    const file = join(directory, "admin.json");
    await writeFile(
      file,
      JSON.stringify({ username: "admin", password: "secret" }),
    );
    const prisma = {
      systemSetting: { upsert: vi.fn().mockResolvedValue({}) },
      adminUser: { count: vi.fn().mockResolvedValue(1) },
    };
    const service = new BootstrapService(
      prisma as never,
      {
        bootstrapFile: file,
        timezone: "Asia/Shanghai",
      } as never,
    );

    await service.onApplicationBootstrap();

    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
    await rm(directory, { recursive: true, force: true });
  });
});
