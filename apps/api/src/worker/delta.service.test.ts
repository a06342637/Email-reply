import { describe, expect, it, vi } from "vitest";
import { DeltaService } from "./delta.service.js";

const task = {
  id: "task-1",
  mailboxId: "mailbox-1",
  activationAt: new Date("2026-01-01T00:00:00.000Z"),
};

function createService(finalPage: number, keepNextLink = false) {
  let pageNumber = 0;
  const prisma = {
    systemSetting: { findUnique: vi.fn().mockResolvedValue(null) },
    autoReplyTask: {
      findUnique: vi.fn().mockResolvedValue({
        status: "RUNNING",
        mailbox: { status: "CONNECTED" },
      }),
    },
    folderCursor: {
      upsert: vi.fn().mockResolvedValue({
        nextLinkEncrypted: null,
        deltaLinkEncrypted: null,
        lastSuccessfulAt: null,
      }),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  const graph = {
    request: vi.fn().mockImplementation(async () => {
      pageNumber += 1;
      const hasNext = pageNumber < finalPage || keepNextLink;
      return {
        value: [],
        ...(hasNext
          ? {
              "@odata.nextLink": `https://graph.microsoft.com/page/${pageNumber + 1}`,
            }
          : { "@odata.deltaLink": "https://graph.microsoft.com/delta/final" }),
      };
    }),
  };
  const crypto = {
    encryptString: vi.fn(async (value: string) => `encrypted:${value}`),
    decryptString: vi.fn(async (value: string) => value),
  };
  const service = new DeltaService(
    prisma as never,
    crypto as never,
    graph as never,
    {} as never,
    {} as never,
  );
  vi.spyOn(service as any, "ingestPage").mockResolvedValue(undefined);
  return { service, graph };
}

describe("DeltaService pagination safety limit", () => {
  it("accepts a normal delta whose 200th page is the final page", async () => {
    const { service, graph } = createService(200);

    await (service as any).pollFolder(task, "INBOX");

    expect(graph.request).toHaveBeenCalledTimes(200);
  });

  it("accepts a recovery delta whose 200th page is the final page", async () => {
    const { service, graph } = createService(200);

    await (service as any).recoverCursor(task, "JUNKEMAIL", null);

    expect(graph.request).toHaveBeenCalledTimes(200);
  });

  it("rejects a normal delta only when a 201st page would be required", async () => {
    const { service, graph } = createService(200, true);

    await expect((service as any).pollFolder(task, "INBOX")).rejects.toThrow(
      "Delta pagination exceeded safety limit for INBOX",
    );
    expect(graph.request).toHaveBeenCalledTimes(200);
  });

  it("rejects a recovery delta only when a 201st page would be required", async () => {
    const { service, graph } = createService(200, true);

    await expect(
      (service as any).recoverCursor(task, "JUNKEMAIL", null),
    ).rejects.toThrow(
      "Delta recovery pagination exceeded safety limit for JUNKEMAIL",
    );
    expect(graph.request).toHaveBeenCalledTimes(200);
  });
});

describe("DeltaService cursor commits", () => {
  it("only advances the successful-check timestamp on the final delta page", async () => {
    const update = vi.fn().mockResolvedValue({});
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ status: "RUNNING" }]),
      folderCursor: { update },
    };
    const prisma = {
      $transaction: vi.fn((callback) => callback(tx)),
    };
    const service = new DeltaService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    vi.spyOn(service as any, "prepareMessages").mockResolvedValue([]);

    await (service as any).ingestPage(task, "INBOX", [], {
      nextEncrypted: "next-page",
      deltaEncrypted: null,
    });
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastSuccessfulAt: undefined,
          initializedAt: undefined,
        }),
      }),
    );

    await (service as any).ingestPage(task, "INBOX", [], {
      nextEncrypted: null,
      deltaEncrypted: "final-delta",
    });
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastSuccessfulAt: expect.any(Date),
          initializedAt: expect.any(Date),
        }),
      }),
    );
  });
});
