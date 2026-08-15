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

describe("updater container packaging", () => {
  it("keeps Buildx state on the writable tmpfs of the read-only container", () => {
    expect(dockerfile).toContain("docker-cli-buildx");
    expect(dockerfile).toContain("DOCKER_CONFIG=/tmp/docker");
    expect(compose).toContain("DOCKER_CONFIG: /tmp/docker");
    expect(compose).toContain("/tmp:size=128m,mode=1777");
  });
});
