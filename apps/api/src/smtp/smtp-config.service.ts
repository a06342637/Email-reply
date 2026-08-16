import { Injectable } from "@nestjs/common";
import type { SmtpSecurity } from "@prisma/client";
import { PrismaService } from "../core/prisma.js";
import { CryptoService } from "../core/crypto.js";
import { AppError } from "../core/http.js";

export type ResolvedSmtpConfig = {
  id: string;
  name: string;
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  password: string;
  fromEmail: string;
  fromName: string | null;
  replyToEmail: string | null;
};

type CreateInput = {
  name: string;
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  password: string;
  fromEmail: string;
  fromName?: string | null;
  replyToEmail?: string | null;
};

type UpdateInput = Partial<CreateInput>;

@Injectable()
export class SmtpConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async list() {
    const rows = await this.prisma.smtpConfig.findMany({
      include: {
        _count: {
          select: { tasks: { where: { status: { not: "DELETED" } } } },
        },
      },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(({ passwordEncrypted: _, _count, ...row }) => ({
      ...row,
      hasPassword: true,
      taskCount: _count.tasks,
    }));
  }

  async create(input: CreateInput) {
    const normalized = this.normalize(input);
    const id = crypto.randomUUID();
    const row = await this.prisma.smtpConfig.create({
      data: {
        id,
        ...normalized,
        passwordEncrypted: await this.crypto.encryptString(
          input.password,
          this.passwordContext(id),
        ),
      },
    });
    return this.publicRow(row);
  }

  async update(id: string, input: UpdateInput) {
    const current = await this.prisma.smtpConfig.findUnique({ where: { id } });
    if (!current)
      throw new AppError("SMTP_CONFIG_NOT_FOUND", "SMTP 配置不存在", 404);
    const merged = this.normalize({
      name: input.name ?? current.name,
      host: input.host ?? current.host,
      port: input.port ?? current.port,
      security: input.security ?? current.security,
      username: input.username ?? current.username,
      password: input.password ?? "unchanged",
      fromEmail: input.fromEmail ?? current.fromEmail,
      fromName:
        input.fromName === undefined
          ? current.fromName || undefined
          : input.fromName,
      replyToEmail:
        input.replyToEmail === undefined
          ? current.replyToEmail || undefined
          : input.replyToEmail,
    });
    const row = await this.prisma.smtpConfig.update({
      where: { id },
      data: {
        name: merged.name,
        host: merged.host,
        port: merged.port,
        security: merged.security,
        username: merged.username,
        fromEmail: merged.fromEmail,
        fromName: merged.fromName,
        replyToEmail: merged.replyToEmail,
        passwordEncrypted: input.password
          ? await this.crypto.encryptString(
              input.password,
              this.passwordContext(id),
            )
          : undefined,
      },
    });
    return this.publicRow(row);
  }

  async delete(id: string): Promise<void> {
    const config = await this.prisma.smtpConfig.findUnique({
      where: { id },
      select: {
        id: true,
        tasks: {
          where: { status: { not: "DELETED" } },
          select: { id: true, name: true },
        },
      },
    });
    if (!config)
      throw new AppError("SMTP_CONFIG_NOT_FOUND", "SMTP 配置不存在", 404);
    if (config.tasks.length)
      throw new AppError(
        "SMTP_CONFIG_IN_USE",
        "仍有自动回复任务使用此 SMTP 配置，请先更换任务发件通道",
        409,
        { tasks: config.tasks },
      );
    await this.prisma.$transaction([
      this.prisma.autoReplyTask.updateMany({
        where: { smtpConfigId: id, status: "DELETED" },
        data: { smtpConfigId: null, sendTransport: "MAILBOX_API" },
      }),
      this.prisma.smtpConfig.delete({ where: { id } }),
    ]);
  }

  async resolve(id: string): Promise<ResolvedSmtpConfig> {
    const row = await this.prisma.smtpConfig.findUnique({ where: { id } });
    if (!row)
      throw new AppError(
        "SMTP_CONFIG_NOT_FOUND",
        "任务绑定的 SMTP 配置不存在，请重新选择",
        409,
      );
    return {
      id: row.id,
      name: row.name,
      host: row.host,
      port: row.port,
      security: row.security,
      username: row.username,
      password: await this.crypto.decryptString(
        row.passwordEncrypted,
        this.passwordContext(row.id),
      ),
      fromEmail: row.fromEmail,
      fromName: row.fromName,
      replyToEmail: row.replyToEmail,
    };
  }

  async requireExists(id: string): Promise<void> {
    if (
      !(await this.prisma.smtpConfig.findUnique({
        where: { id },
        select: { id: true },
      }))
    )
      throw new AppError(
        "SMTP_CONFIG_NOT_FOUND",
        "请选择有效的 SMTP 发件配置",
        409,
      );
  }

  private normalize(input: CreateInput) {
    const name = input.name.trim();
    const host = input.host.trim().toLowerCase().replace(/\.$/, "");
    const username = input.username.trim();
    const fromEmail = input.fromEmail.trim().toLowerCase();
    const fromName = input.fromName?.trim() || null;
    const replyToEmail = input.replyToEmail?.trim().toLowerCase() || null;
    if (!name)
      throw new AppError("SMTP_NAME_REQUIRED", "SMTP 配置名称不能为空", 400);
    if (
      !host ||
      host.includes("://") ||
      /[\s/@\\]/.test(host) ||
      host.length > 253
    )
      throw new AppError("SMTP_HOST_INVALID", "SMTP 主机名格式无效", 400);
    if (!username)
      throw new AppError("SMTP_USERNAME_REQUIRED", "SMTP 用户名不能为空", 400);
    if (!input.password)
      throw new AppError("SMTP_PASSWORD_REQUIRED", "SMTP 密码不能为空", 400);
    return {
      name,
      host,
      port: input.port,
      security: input.security,
      username,
      fromEmail,
      fromName,
      replyToEmail,
    };
  }

  private publicRow<T extends { passwordEncrypted: string }>(row: T) {
    const visible = { ...row } as Omit<T, "passwordEncrypted"> & {
      passwordEncrypted?: string;
    };
    delete visible.passwordEncrypted;
    return { ...visible, hasPassword: true };
  }

  private passwordContext(id: string): string {
    return `smtp-password:${id}`;
  }
}
