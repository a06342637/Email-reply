import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

describe("runtime dependency layout", () => {
  it("makes Nest validation peers resolvable from @nestjs/common", () => {
    const localRequire = createRequire(import.meta.url);
    const nestRequire = createRequire(localRequire.resolve("@nestjs/common"));

    expect(nestRequire.resolve("class-transformer")).toContain(
      "class-transformer",
    );
    expect(nestRequire.resolve("class-validator")).toContain("class-validator");
  });
});
