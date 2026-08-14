import { describe, expect, it } from "vitest";
import { FilterService } from "./filter.service.js";

const prisma = {
  mailbox: { findMany: async () => [{ email: "owner@example.com" }] },
  systemSetting: { findUnique: async () => null },
} as never;

describe("FilterService", () => {
  const service = new FilterService(prisma);

  it("skips explicit automatic response headers", async () => {
    const result = await service.evaluate(
      {
        id: "1",
        receivedDateTime: new Date().toISOString(),
        sender: { emailAddress: { address: "sender@example.net" } },
        internetMessageHeaders: [
          { name: "Auto-Submitted", value: "auto-generated" },
        ],
      },
      "owner@example.com",
    );
    expect(result.skip).toBe("AUTO_SUBMITTED");
  });

  it("does not skip ordinary no-reply marketing mail by address alone", async () => {
    const result = await service.evaluate(
      {
        id: "2",
        receivedDateTime: new Date().toISOString(),
        subject: "Weekly newsletter",
        sender: { emailAddress: { address: "no-reply@shop.example" } },
        internetMessageHeaders: [
          { name: "List-ID", value: "weekly.shop.example" },
        ],
      },
      "owner@example.com",
    );
    expect(result.skip).toBeUndefined();
  });

  it("matches AND across condition classes and OR within one class", () => {
    const matched = service.matchRule(
      {
        id: "3",
        receivedDateTime: new Date().toISOString(),
        subject: "Order delayed #123",
      },
      "agent@support.example",
      "inbox",
      {
        folders: ["inbox"],
        senderDomains: ["support.example", "other.example"],
        subjectContains: ["order", "invoice"],
        subjectNotContains: ["closed"],
      },
    );
    expect(matched).toBe(true);
  });

  it("matches normalized full addresses and subject prefixes", () => {
    expect(
      service.matchRule(
        {
          id: "4",
          receivedDateTime: new Date().toISOString(),
          subject: "  订单：需要帮助",
        },
        "Customer@Example.COM",
        "junkemail",
        {
          folders: ["junkemail"],
          senderAddresses: ["customer@example.com", "other@example.com"],
          subjectPrefixes: ["订单："],
        },
      ),
    ).toBe(false);
    expect(
      service.matchRule(
        {
          id: "5",
          receivedDateTime: new Date().toISOString(),
          subject: "订单：需要帮助",
        },
        "Customer@Example.COM",
        "junkemail",
        {
          folders: ["junkemail"],
          senderAddresses: ["customer@example.com", "other@example.com"],
          subjectPrefixes: ["订单："],
        },
      ),
    ).toBe(true);
  });

  it("skips Microsoft service domains without blocking personal Outlook domains", async () => {
    const microsoft = await service.evaluate(
      {
        id: "6",
        receivedDateTime: new Date().toISOString(),
        sender: { emailAddress: { address: "notice@account.microsoft.com" } },
      },
      "owner@example.com",
    );
    const personal = await service.evaluate(
      {
        id: "7",
        receivedDateTime: new Date().toISOString(),
        sender: { emailAddress: { address: "friend@outlook.com" } },
      },
      "owner@example.com",
    );
    expect(microsoft.skip).toBe("MICROSOFT_SERVICE_DOMAIN");
    expect(personal.skip).toBeUndefined();
  });

  it("uses From for safety and rules while preserving a valid Reply-To target", async () => {
    const result = await service.evaluate(
      {
        id: "8",
        receivedDateTime: new Date().toISOString(),
        from: {
          emailAddress: { name: "Customer", address: "buyer@example.net" },
        },
        replyTo: [
          { emailAddress: { address: "case-123@replies.example.net" } },
        ],
      },
      "owner@example.com",
    );
    expect(result.skip).toBeUndefined();
    expect(result.senderEmail).toBe("buyer@example.net");
    expect(result.replyToEmail).toBe("case-123@replies.example.net");
  });

  it("cannot bypass Microsoft service filtering with an external Reply-To", async () => {
    const result = await service.evaluate(
      {
        id: "9",
        receivedDateTime: new Date().toISOString(),
        from: {
          emailAddress: { address: "notice@account.microsoft.com" },
        },
        replyTo: [{ emailAddress: { address: "external@example.net" } }],
      },
      "owner@example.com",
    );
    expect(result.skip).toBe("MICROSOFT_SERVICE_DOMAIN");
  });

  it("skips an invalid explicit Reply-To instead of falling back silently", async () => {
    const result = await service.evaluate(
      {
        id: "10",
        receivedDateTime: new Date().toISOString(),
        from: { emailAddress: { address: "buyer@example.net" } },
        replyTo: [{ emailAddress: { address: "not-an-address" } }],
      },
      "owner@example.com",
    );
    expect(result.skip).toBe("INVALID_REPLY_ADDRESS");
  });
});
