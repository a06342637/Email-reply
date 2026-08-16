import { describe, expect, it, vi } from "vitest";
import { SmtpConfigService } from "./smtp-config.service.js";

const stored = {
  id: "smtp-1",
  name: "Primary SMTP",
  host: "smtp.example.com",
  port: 587,
  security: "STARTTLS" as const,
  username: "service@example.com",
  passwordEncrypted: "encrypted-password",
  fromEmail: "service@example.com",
  fromName: "Service",
  replyToEmail: "reply@example.com",
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("SmtpConfigService", () => {
  it("encrypts passwords with a per-config context and never returns ciphertext", async () => {
    const prisma = {
      smtpConfig: {
        create: vi.fn().mockImplementation(({ data }) => data),
      },
    };
    const crypto = {
      encryptString: vi.fn().mockResolvedValue("encrypted-password"),
    };
    const service = new SmtpConfigService(prisma as never, crypto as never);

    const result = await service.create({
      name: " Primary SMTP ",
      host: "SMTP.EXAMPLE.COM.",
      port: 587,
      security: "STARTTLS",
      username: " service@example.com ",
      password: "app-password",
      fromEmail: "SERVICE@EXAMPLE.COM",
    });

    const createdId = prisma.smtpConfig.create.mock.calls[0]![0].data.id;
    expect(crypto.encryptString).toHaveBeenCalledWith(
      "app-password",
      `smtp-password:${createdId}`,
    );
    expect(prisma.smtpConfig.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: "Primary SMTP",
        host: "smtp.example.com",
        username: "service@example.com",
        fromEmail: "service@example.com",
        passwordEncrypted: "encrypted-password",
      }),
    });
    expect(result).not.toHaveProperty("passwordEncrypted");
    expect(result).toHaveProperty("hasPassword", true);
  });

  it("allows optional sender fields to be cleared without replacing the password", async () => {
    const prisma = {
      smtpConfig: {
        findUnique: vi.fn().mockResolvedValue(stored),
        update: vi
          .fn()
          .mockImplementation(({ data }) => ({ ...stored, ...data })),
      },
    };
    const crypto = { encryptString: vi.fn() };
    const service = new SmtpConfigService(prisma as never, crypto as never);

    await service.update("smtp-1", { fromName: null, replyToEmail: null });

    expect(prisma.smtpConfig.update).toHaveBeenCalledWith({
      where: { id: "smtp-1" },
      data: expect.objectContaining({
        fromName: null,
        replyToEmail: null,
        passwordEncrypted: undefined,
      }),
    });
    expect(crypto.encryptString).not.toHaveBeenCalled();
  });

  it("refuses to delete a config still used by an active task", async () => {
    const prisma = {
      smtpConfig: {
        findUnique: vi.fn().mockResolvedValue({
          id: "smtp-1",
          tasks: [{ id: "task-1", name: "Active task" }],
        }),
        delete: vi.fn(),
      },
    };
    const service = new SmtpConfigService(prisma as never, {} as never);

    await expect(service.delete("smtp-1")).rejects.toMatchObject({
      code: "SMTP_CONFIG_IN_USE",
      status: 409,
    });
    expect(prisma.smtpConfig.delete).not.toHaveBeenCalled();
  });
});
