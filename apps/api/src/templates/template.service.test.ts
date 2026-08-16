import { describe, expect, it, vi } from "vitest";
import { Liquid } from "liquidjs";
import { TemplateService } from "./template.service.js";

describe("Liquid template restrictions", () => {
  it("escapes dynamic HTML output by default", async () => {
    const liquid = new Liquid({
      outputEscape: "escape",
      strictFilters: true,
      dynamicPartials: false,
    });
    const output = await liquid.parseAndRender("<p>{{ sender.name }}</p>", {
      sender: { name: "<script>alert(1)</script>" },
    });
    expect(output).not.toContain("<script>");
    expect(output).toContain("&lt;script&gt;");
  });

  it("supports safe if conditions", async () => {
    const liquid = new Liquid({
      outputEscape: "escape",
      strictFilters: true,
      dynamicPartials: false,
    });
    const output = await liquid.parseAndRender(
      '{% if message.folder == "junkemail" %}垃圾箱{% else %}收件箱{% endif %}',
      { message: { folder: "junkemail" } },
    );
    expect(output).toBe("垃圾箱");
  });

  it("removes executable HTML, event handlers and unsafe image URLs", () => {
    const service = new TemplateService({} as never);
    const output = service.sanitize(
      '<script>alert(1)</script><iframe src="https://evil.example"></iframe><img src="javascript:alert(1)" onerror="alert(2)"><a href="javascript:alert(3)">link</a>',
    );
    expect(output).not.toContain("script");
    expect(output).not.toContain("iframe");
    expect(output).not.toContain("onerror");
    expect(output).not.toContain("javascript:");
  });

  it("escapes HTML variables without leaking entities into subject or plain text", async () => {
    const service = new TemplateService({} as never);
    const result = await service.preview({
      subjectTemplate: "Re: {{ message.subject }}",
      htmlContent: "<p>{{ message.subject }}</p>",
      textContent: "{{ message.subject }}",
      variables: {
        sender: { name: "Buyer", email: "buyer@example.net" },
        mailbox: { name: "Service", email: "service@example.com" },
        message: {
          subject: "A & B <test>",
          received_at: new Date().toISOString(),
          folder: "inbox",
        },
        rule: { name: "Default" },
        system: {
          current_date: "2026/8/14",
          current_time: "10:00:00",
          current_datetime: "2026/8/14 10:00:00",
        },
      },
    });

    expect(result.subject).toBe("Re: A & B <test>");
    expect(result.html).toContain("A &amp; B &lt;test&gt;");
    expect(result.text).toBe("A & B <test>");
  });

  it("rejects Liquid tags that try to load an external file", async () => {
    const service = new TemplateService({} as never);
    await expect(
      service.preview({
        subjectTemplate: "Test",
        htmlContent: "{% include 'secret' %}",
        variables: {
          sender: { name: "", email: "sender@example.net" },
          mailbox: { name: "", email: "mailbox@example.com" },
          message: { subject: "", received_at: "", folder: "inbox" },
          rule: { name: "" },
          system: {
            current_date: "",
            current_time: "",
            current_datetime: "",
          },
        },
      }),
    ).rejects.toMatchObject({ code: "TEMPLATE_SYNTAX_INVALID" });
  });

  it("regenerates plain text from rich HTML when automatic text is enabled", async () => {
    const service = new TemplateService({
      templateRevision: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "revision-1",
          version: 1,
          subjectTemplate: "Re: {{ message.subject }}",
          sanitizedHtml: "<p>Hello {{ sender.name }}</p>",
          textContent: "stale plain text",
          autoTextContent: true,
          assets: [],
          template: { name: "Rich template" },
        }),
      },
    } as never);

    const result = await service.render("revision-1", {
      sender: { name: "Buyer", email: "buyer@example.net" },
      mailbox: { name: "Service", email: "service@example.com" },
      message: {
        subject: "Order",
        received_at: new Date().toISOString(),
        folder: "inbox",
      },
      rule: { name: "Default" },
      system: {
        current_date: "2026/8/16",
        current_time: "10:00:00",
        current_datetime: "2026/8/16 10:00:00",
      },
    });

    expect(result.text).toContain("Hello Buyer");
    expect(result.text).not.toContain("stale plain text");
  });

  it("warns about promotional wording commonly found in link-heavy templates", () => {
    const service = new TemplateService({} as never);

    expect(
      service.deliverabilityWarnings(
        '<p><a href="https://example.com">唯一永久官方导航</a></p>',
        "唯一永久官方导航",
      ),
    ).toContain("正文包含常见营销词，最终投递可能受发件信誉影响");
  });
});

describe("TemplateService deletion", () => {
  it("shows templates created by the old archive action so they can be deleted", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new TemplateService({
      replyTemplate: { findMany },
    } as never);

    await service.list();

    expect(findMany).toHaveBeenCalledWith(
      expect.not.objectContaining({ where: { archivedAt: null } }),
    );
  });

  it("permanently deletes an unused template and all of its revisions", async () => {
    const prisma = {
      replyTemplate: {
        findUnique: vi.fn().mockResolvedValue({
          id: "template-1",
          revisions: [{ id: "revision-1" }, { id: "revision-2" }],
          defaultForTasks: [],
          rules: [],
        }),
        delete: vi.fn().mockResolvedValue({}),
      },
      replyRule: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      autoReplyTask: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      messageReceipt: { count: vi.fn().mockResolvedValue(0) },
      $transaction: vi.fn((operations: Array<Promise<unknown>>) =>
        Promise.all(operations),
      ),
    };
    const service = new TemplateService(prisma as never);

    await expect(service.delete("template-1")).resolves.toEqual({
      revisionCount: 2,
    });
    expect(prisma.replyTemplate.delete).toHaveBeenCalledWith({
      where: { id: "template-1" },
    });
  });

  it("refuses to delete a template still assigned to tasks or rules", async () => {
    const prisma = {
      replyTemplate: {
        findUnique: vi.fn().mockResolvedValue({
          id: "template-1",
          revisions: [{ id: "revision-1" }],
          defaultForTasks: [{ id: "task-1", name: "Active task" }],
          rules: [
            {
              id: "rule-1",
              name: "Priority rule",
              task: { id: "task-2", name: "Second task" },
            },
          ],
        }),
        delete: vi.fn(),
      },
      messageReceipt: { count: vi.fn() },
    };
    const service = new TemplateService(prisma as never);

    await expect(service.delete("template-1")).rejects.toMatchObject({
      code: "TEMPLATE_IN_USE",
      status: 409,
    });
    expect(prisma.replyTemplate.delete).not.toHaveBeenCalled();
  });

  it("refuses to delete a template while a reply is still in progress", async () => {
    const prisma = {
      replyTemplate: {
        findUnique: vi.fn().mockResolvedValue({
          id: "template-1",
          revisions: [{ id: "revision-1" }],
          defaultForTasks: [],
          rules: [],
        }),
        delete: vi.fn(),
      },
      messageReceipt: { count: vi.fn().mockResolvedValue(1) },
    };
    const service = new TemplateService(prisma as never);

    await expect(service.delete("template-1")).rejects.toMatchObject({
      code: "TEMPLATE_PROCESSING",
      status: 409,
    });
    expect(prisma.replyTemplate.delete).not.toHaveBeenCalled();
  });
});
