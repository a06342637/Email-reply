import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync(
  fileURLToPath(new URL("../../../../Dockerfile", import.meta.url)),
  "utf8",
);
const compose = readFileSync(
  fileURLToPath(new URL("../../../../compose.yml", import.meta.url)),
  "utf8",
);
const updateScript = readFileSync(
  fileURLToPath(new URL("../../../../update.sh", import.meta.url)),
  "utf8",
);
const updaterSource = readFileSync(
  fileURLToPath(new URL("../updater.ts", import.meta.url)),
  "utf8",
);

describe("updater container packaging", () => {
  it("keeps Buildx state on the writable tmpfs of the read-only container", () => {
    expect(dockerfile).toContain("docker-cli-buildx");
    expect(dockerfile).toContain("DOCKER_CONFIG=/tmp/docker");
    expect(compose).toContain("DOCKER_CONFIG: /tmp/docker");
    expect(compose).toContain("/tmp:size=128m,mode=1777");
  });

  it("restricts command-line updates to the official origin and main branch", () => {
    expect(updateScript).toContain(
      'OFFICIAL_REPOSITORY="https://github.com/a06342637/Email-reply"',
    );
    expect(updateScript).toContain("normalize_repository_url");
    expect(updateScript).toContain("git remote get-url origin");
    expect(updateScript).toContain("git symbolic-ref --quiet --short HEAD");
    expect(updateScript).toContain('[[ "$CURRENT_BRANCH" != "main" ]]');
    expect(updateScript.indexOf("git remote get-url origin")).toBeLessThan(
      updateScript.indexOf("git fetch --force"),
    );
    expect(
      updateScript.indexOf("git symbolic-ref --quiet --short HEAD"),
    ).toBeLessThan(updateScript.indexOf("git fetch --force"));
  });

  it("keeps browser upgrades click-only while retaining encrypted backups", () => {
    expect(updaterSource).toContain("deriveUpdateBackupPassphrase(token)");
    expect(updaterSource).not.toContain("body.backupPassphrase");
    expect(updaterSource).not.toContain('body.confirmation !== "UPGRADE"');
  });
});
