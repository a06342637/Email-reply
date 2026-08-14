import { describe, expect, it, vi } from "vitest";
import { MailboxService } from "./mailbox.service.js";

describe("MailboxService list", () => {
  it("hides a soft-deleted task so the mailbox can create a new one", async () => {
    const rows = [
      {
        id: "mailbox-1",
        email: "one@example.com",
        task: { status: "DELETED" },
      },
      {
        id: "mailbox-2",
        email: "two@example.com",
        task: { status: "RUNNING" },
      },
    ];
    const prisma = {
      mailbox: { findMany: vi.fn().mockResolvedValue(rows) },
    };
    const service = new MailboxService(prisma as never, {} as never);

    const result = await service.list();

    expect(result[0]?.task).toBeNull();
    expect(result[1]?.task).toEqual({ status: "RUNNING" });
  });
});
