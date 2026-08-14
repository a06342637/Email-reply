import { describe, expect, it } from "vitest";
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
});
