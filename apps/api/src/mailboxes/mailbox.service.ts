import { Injectable } from "@nestjs/common";
import type { Prisma, SendTransport } from "@prisma/client";
import { PrismaService } from "../core/prisma.js";
import { CryptoService } from "../core/crypto.js";
import { AppError } from "../core/http.js";
import type { RuleConditions } from "@autoreply/shared";

@Injectable()
export class MailboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async list() {
    const rows = await this.prisma.mailbox.findMany({
      where: { status: { not: "REMOVED" } },
      select: {
        id: true,
        email: true,
        provider: true,
        microsoftAuthMode: true,
        microsoftClientId: true,
        microsoftAppConfigId: true,
        googleAppConfigId: true,
        microsoftAppConfig: { select: { id: true, name: true } },
        googleAppConfig: { select: { id: true, name: true } },
        displayName: true,
        tenantId: true,
        accountType: true,
        status: true,
        lastTokenRefreshAt: true,
        lastErrorCode: true,
        lastErrorMessage: true,
        createdAt: true,
        updatedAt: true,
        task: {
          include: {
            _count: {
              select: {
                receipts: {
                  where: {
                    state: {
                      in: [
                        "QUEUED",
                        "CREATING_DRAFT",
                        "DRAFT_READY",
                        "SENDING",
                      ],
                    },
                  },
                },
              },
            },
            defaultTemplate: {
              select: { id: true, name: true, publishedRevisionId: true },
            },
            smtpConfig: {
              select: {
                id: true,
                name: true,
                fromEmail: true,
                fromName: true,
              },
            },
            rules: {
              orderBy: { priority: "asc" },
              include: {
                template: {
                  select: { id: true, name: true, publishedRevisionId: true },
                },
              },
            },
          },
        },
        cursors: {
          select: {
            folder: true,
            lastSuccessfulAt: true,
            initializedAt: true,
            highWaterAt: true,
          },
        },
        gmailCursor: {
          select: {
            lastSuccessfulAt: true,
            initializedAt: true,
            highWaterAt: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((row) =>
      row.task?.status === "DELETED" ? { ...row, task: null } : row,
    );
  }

  async disable(id: string): Promise<void> {
    const mailbox = await this.prisma.mailbox.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!mailbox || mailbox.status !== "CONNECTED")
      throw new AppError(
        "MAILBOX_DISABLE_INVALID",
        "只有已连接邮箱可以停用",
        409,
      );
    await this.prisma.$transaction([
      this.prisma.mailbox.update({
        where: { id },
        data: { status: "DISABLED" },
      }),
      this.prisma.autoReplyTask.updateMany({
        where: { mailboxId: id, status: { not: "DELETED" } },
        data: { status: "PAUSED", pausedAt: new Date(), nextPollAt: null },
      }),
      this.prisma.$executeRaw`
        DELETE FROM "TransactionalOutbox" AS outbox
        USING "MessageReceipt" AS receipt
        WHERE outbox."aggregateId" = receipt."id"
          AND receipt."mailboxId" = ${id}
          AND outbox."kind" IN ('PROCESS_MESSAGE', 'VERIFY_SEND')
      `,
    ]);
  }

  async enable(id: string): Promise<void> {
    const mailbox = await this.prisma.mailbox.findUniqueOrThrow({
      where: { id },
    });
    if (mailbox.status !== "DISABLED")
      throw new AppError(
        "MAILBOX_ENABLE_INVALID",
        "只有已停用邮箱可以重新启用",
        409,
      );
    if (!mailbox.tokenCacheEncrypted)
      throw new AppError("MAILBOX_AUTH_REQUIRED", "请重新连接邮箱提供商", 409);
    await this.prisma.mailbox.update({
      where: { id },
      data: { status: "CONNECTED" },
    });
  }

  async remove(id: string): Promise<void> {
    const mailbox = await this.prisma.mailbox.findUniqueOrThrow({
      where: { id },
    });
    await this.prisma.$transaction([
      this.prisma.autoReplyTask.updateMany({
        where: { mailboxId: id },
        data: { status: "DELETED", deletedAt: new Date(), nextPollAt: null },
      }),
      this.prisma.folderCursor.deleteMany({ where: { mailboxId: id } }),
      this.prisma.gmailCursor.deleteMany({ where: { mailboxId: id } }),
      this.prisma.replyRule.deleteMany({ where: { task: { mailboxId: id } } }),
      this.prisma.$executeRaw`
        DELETE FROM "TransactionalOutbox" AS outbox
        USING "MessageReceipt" AS receipt
        WHERE outbox."aggregateId" = receipt."id"
          AND receipt."mailboxId" = ${id}
          AND outbox."kind" IN ('PROCESS_MESSAGE', 'VERIFY_SEND')
      `,
      this.prisma.messageReceipt.updateMany({
        where: {
          mailboxId: id,
          state: { in: ["QUEUED", "CREATING_DRAFT", "DRAFT_READY"] },
        },
        data: {
          state: "FILTERED",
          filterReason: "MAILBOX_REMOVED",
          completedAt: new Date(),
        },
      }),
      this.prisma.messageReceipt.updateMany({
        where: { mailboxId: id, state: "SENDING" },
        data: {
          state: "UNCERTAIN",
          lastErrorCode: "MAILBOX_REMOVED_DURING_SEND",
          lastErrorMessage: "邮箱在发送核验完成前被移除，发送状态需要人工核查",
          completedAt: new Date(),
        },
      }),
      this.prisma.mailbox.update({
        where: { id },
        data: {
          status: "REMOVED",
          microsoftAuthMode: "MSAL_OAUTH",
          microsoftClientId: null,
          microsoftAppConfigId: null,
          googleAppConfigId: null,
          homeAccountId: `removed:${id}`,
          tokenCacheEncrypted: await this.crypto.encryptString(
            "{}",
            mailbox.provider === "GOOGLE" ? `google-token:${id}` : `msal:${id}`,
          ),
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      }),
    ]);
    await this.prisma.processingLog.create({
      data: {
        mailboxEmail: mailbox.email,
        event: "MAILBOX_REMOVED",
        reason: "Mailbox credentials and cursors removed",
      },
    });
  }

  async createTask(
    mailboxId: string,
    input: {
      name: string;
      pollIntervalSeconds: number;
      backlogPerMinute: number;
      defaultTemplateId: string;
      sendTransport: SendTransport;
      smtpConfigId?: string | null;
    },
  ) {
    const name = input.name.trim();
    if (!name)
      throw new AppError("TASK_NAME_REQUIRED", "任务名称不能为空", 400);
    await this.requirePublishedTemplate(input.defaultTemplateId);
    const smtpConfigId = await this.validateTransport(
      input.sendTransport,
      input.smtpConfigId,
    );
    const mailbox = await this.prisma.mailbox.findUniqueOrThrow({
      where: { id: mailboxId },
    });
    if (mailbox.status !== "CONNECTED")
      throw new AppError(
        "MAILBOX_NOT_CONNECTED",
        "邮箱必须已连接才能创建任务",
        409,
      );
    const existing = await this.prisma.autoReplyTask.findUnique({
      where: { mailboxId },
    });
    if (existing && existing.status !== "DELETED")
      throw new AppError("TASK_EXISTS", "该邮箱已经有自动回复任务", 409);
    if (existing) {
      await this.prisma.folderCursor.deleteMany({ where: { mailboxId } });
      await this.prisma.gmailCursor.deleteMany({ where: { mailboxId } });
      return this.prisma.autoReplyTask.update({
        where: { id: existing.id },
        data: {
          name,
          pollIntervalSeconds: input.pollIntervalSeconds,
          backlogPerMinute: input.backlogPerMinute,
          defaultTemplateId: input.defaultTemplateId,
          sendTransport: input.sendTransport,
          smtpConfigId,
          status: "DRAFT",
          activationAt: null,
          pausedAt: null,
          nextPollAt: null,
          deletedAt: null,
          consecutiveFailures: 0,
          circuitOpenedAt: null,
        },
      });
    }
    return this.prisma.autoReplyTask.create({
      data: { mailboxId, ...input, name, smtpConfigId },
    });
  }

  async updateTask(
    id: string,
    input: {
      name?: string;
      pollIntervalSeconds?: number;
      backlogPerMinute?: number;
      defaultTemplateId?: string;
      sendTransport?: SendTransport;
      smtpConfigId?: string | null;
    },
  ) {
    const task = await this.prisma.autoReplyTask.findUnique({
      where: { id },
      select: { status: true, sendTransport: true, smtpConfigId: true },
    });
    if (!task || task.status === "DELETED")
      throw new AppError("TASK_NOT_EDITABLE", "任务不存在或已删除", 409);
    if (input.name !== undefined) {
      input.name = input.name.trim();
      if (!input.name)
        throw new AppError("TASK_NAME_REQUIRED", "任务名称不能为空", 400);
    }
    if (input.defaultTemplateId)
      await this.requirePublishedTemplate(input.defaultTemplateId);
    const sendTransport = input.sendTransport ?? task.sendTransport;
    const smtpConfigId = await this.validateTransport(
      sendTransport,
      input.smtpConfigId === undefined ? task.smtpConfigId : input.smtpConfigId,
    );
    return this.prisma.autoReplyTask.update({
      where: { id },
      data: { ...input, sendTransport, smtpConfigId },
    });
  }

  async startTask(id: string) {
    const task = await this.prisma.autoReplyTask.findUniqueOrThrow({
      where: { id },
      include: { mailbox: true, defaultTemplate: true, smtpConfig: true },
    });
    if (task.status !== "DRAFT")
      throw new AppError("TASK_START_INVALID", "只有草稿任务可以首次运行", 409);
    if (task.mailbox.status !== "CONNECTED")
      throw new AppError(
        "MAILBOX_NOT_CONNECTED",
        "邮箱未连接或需要重新授权",
        409,
      );
    if (!task.defaultTemplateId || !task.defaultTemplate?.publishedRevisionId)
      throw new AppError(
        "DEFAULT_TEMPLATE_REQUIRED",
        "请选择已发布的默认模板",
        409,
      );
    this.assertTaskTransport(task);
    const hasCursors = await this.hasInitializedCursor(
      task.mailboxId,
      task.mailbox.provider,
    );
    const now = new Date();
    const result = await this.prisma.autoReplyTask.update({
      where: { id },
      data: {
        status: hasCursors ? "RUNNING" : "INITIALIZING",
        activationAt: task.activationAt ?? now,
        pausedAt: null,
        nextPollAt: now,
        deletedAt: null,
      },
    });
    await this.requeuePending(id, "start");
    return result;
  }

  async pauseTask(id: string) {
    const updated = await this.prisma.autoReplyTask.updateMany({
      where: { id, status: { in: ["INITIALIZING", "RUNNING"] } },
      data: { status: "PAUSED", pausedAt: new Date(), nextPollAt: null },
    });
    if (!updated.count)
      throw new AppError(
        "TASK_PAUSE_INVALID",
        "只有正在初始化或运行的任务可以暂停",
        409,
      );
    await this.clearTaskOutbox(id);
    return this.prisma.autoReplyTask.findUniqueOrThrow({ where: { id } });
  }

  async resumeTask(id: string) {
    const task = await this.prisma.autoReplyTask.findUniqueOrThrow({
      where: { id },
      include: { mailbox: true, defaultTemplate: true, smtpConfig: true },
    });
    if (!["PAUSED", "CIRCUIT_OPEN"].includes(task.status))
      throw new AppError(
        "TASK_RESUME_INVALID",
        "只有暂停或熔断的任务可以恢复",
        409,
      );
    if (task.mailbox.status !== "CONNECTED")
      throw new AppError(
        "MAILBOX_NOT_CONNECTED",
        "邮箱未连接或需要重新授权",
        409,
      );
    if (!task.defaultTemplate?.publishedRevisionId)
      throw new AppError(
        "DEFAULT_TEMPLATE_REQUIRED",
        "请选择已发布的默认模板",
        409,
      );
    this.assertTaskTransport(task);
    const hasCursors = await this.hasInitializedCursor(
      task.mailboxId,
      task.mailbox.provider,
    );
    const now = new Date();
    const resumeFrom = hasCursors
      ? await this.resumeScanFrom(
          task.mailboxId,
          task.mailbox.provider,
          task.activationAt,
          task.pausedAt,
        )
      : null;
    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.autoReplyTask.update({
        where: { id },
        data: {
          status: hasCursors ? "RUNNING" : "INITIALIZING",
          activationAt: task.activationAt ?? now,
          pausedAt: null,
          nextPollAt: now,
          consecutiveFailures: 0,
          circuitOpenedAt: null,
        },
      });
      if (resumeFrom && task.mailbox.provider === "MICROSOFT")
        await tx.folderCursor.updateMany({
          where: { mailboxId: task.mailboxId },
          data: {
            deltaLinkEncrypted: null,
            nextLinkEncrypted: null,
            initializedAt: null,
            highWaterAt: resumeFrom,
          },
        });
      if (resumeFrom && task.mailbox.provider === "GOOGLE")
        await tx.gmailCursor.updateMany({
          where: { mailboxId: task.mailboxId },
          data: {
            historyIdEncrypted: null,
            pageTokenEncrypted: null,
            initializedAt: null,
            highWaterAt: resumeFrom,
          },
        });
      return updated;
    });
    await this.requeuePending(id, "resume");
    return result;
  }

  async deleteTask(id: string): Promise<void> {
    const task = await this.prisma.autoReplyTask.findUniqueOrThrow({
      where: { id },
    });
    await this.prisma.$transaction([
      this.prisma.replyRule.deleteMany({ where: { taskId: id } }),
      this.prisma.folderCursor.deleteMany({
        where: { mailboxId: task.mailboxId },
      }),
      this.prisma.gmailCursor.deleteMany({
        where: { mailboxId: task.mailboxId },
      }),
      this.prisma.autoReplyTask.update({
        where: { id },
        data: {
          status: "DELETED",
          deletedAt: new Date(),
          nextPollAt: null,
          defaultTemplateId: null,
          sendTransport: "MAILBOX_API",
          smtpConfigId: null,
          activationAt: null,
        },
      }),
      this.prisma.$executeRaw`
        DELETE FROM "TransactionalOutbox" AS outbox
        USING "MessageReceipt" AS receipt
        WHERE outbox."aggregateId" = receipt."id"
          AND receipt."taskId" = ${id}
          AND outbox."kind" IN ('PROCESS_MESSAGE', 'VERIFY_SEND')
      `,
      this.prisma.messageReceipt.updateMany({
        where: {
          taskId: id,
          state: { in: ["QUEUED", "CREATING_DRAFT", "DRAFT_READY"] },
        },
        data: {
          state: "FILTERED",
          filterReason: "TASK_DELETED",
          completedAt: new Date(),
        },
      }),
      this.prisma.messageReceipt.updateMany({
        where: { taskId: id, state: "SENDING" },
        data: {
          state: "UNCERTAIN",
          lastErrorCode: "TASK_DELETED_DURING_SEND",
          lastErrorMessage: "任务在发送核验完成前被删除，发送状态需要人工核查",
          completedAt: new Date(),
        },
      }),
    ]);
  }

  async replaceRules(
    taskId: string,
    rules: Array<{
      id?: string;
      name: string;
      enabled: boolean;
      templateId: string;
      conditions: Record<string, unknown>;
    }>,
  ) {
    if (rules.length > 100)
      throw new AppError("RULE_LIMIT", "每个任务最多 100 条规则", 400);
    const task = await this.prisma.autoReplyTask.findUnique({
      where: { id: taskId },
      select: { status: true },
    });
    if (!task || task.status === "DELETED")
      throw new AppError("TASK_NOT_EDITABLE", "任务不存在或已删除", 409);
    const normalizedRules = rules.map((rule) => ({
      ...rule,
      name: rule.name?.trim(),
      conditions: this.normalizeConditions(rule.conditions),
    }));
    for (const rule of normalizedRules) {
      await this.requirePublishedTemplate(rule.templateId);
      if (!rule.name)
        throw new AppError("RULE_NAME_REQUIRED", "规则名称不能为空", 400);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.replyRule.deleteMany({ where: { taskId } });
      for (const [priority, rule] of normalizedRules.entries()) {
        await tx.replyRule.create({
          data: {
            taskId,
            name: rule.name,
            enabled: rule.enabled,
            templateId: rule.templateId,
            conditions: rule.conditions as Prisma.InputJsonValue,
            priority,
          },
        });
      }
    });
    return this.prisma.replyRule.findMany({
      where: { taskId },
      orderBy: { priority: "asc" },
      include: { template: true },
    });
  }

  private async requirePublishedTemplate(id: string): Promise<void> {
    const template = await this.prisma.replyTemplate.findUnique({
      where: { id },
    });
    if (!template || !template.publishedRevisionId) {
      throw new AppError(
        "TEMPLATE_NOT_PUBLISHED",
        "所选模板不存在或尚未发布",
        409,
      );
    }
  }

  private async validateTransport(
    sendTransport: SendTransport,
    smtpConfigId?: string | null,
  ): Promise<string | null> {
    if (sendTransport === "MAILBOX_API") return null;
    if (!smtpConfigId)
      throw new AppError(
        "SMTP_CONFIG_REQUIRED",
        "使用 SMTP 发件时必须选择 SMTP 配置",
        409,
      );
    const config = await this.prisma.smtpConfig.findUnique({
      where: { id: smtpConfigId },
      select: { id: true },
    });
    if (!config)
      throw new AppError(
        "SMTP_CONFIG_NOT_FOUND",
        "选择的 SMTP 配置不存在",
        409,
      );
    return config.id;
  }

  private assertTaskTransport(task: {
    sendTransport: SendTransport;
    smtpConfigId: string | null;
    smtpConfig: { id: string } | null;
  }): void {
    if (
      task.sendTransport === "SMTP" &&
      (!task.smtpConfigId || !task.smtpConfig)
    )
      throw new AppError(
        "SMTP_CONFIG_REQUIRED",
        "任务的 SMTP 配置不可用，请先重新选择发件配置",
        409,
      );
  }

  private async resumeScanFrom(
    mailboxId: string,
    provider: "MICROSOFT" | "GOOGLE",
    activationAt: Date | null,
    pausedAt: Date | null,
  ): Promise<Date> {
    const successfulAt =
      provider === "GOOGLE"
        ? (
            await this.prisma.gmailCursor.findUnique({
              where: { mailboxId },
              select: { lastSuccessfulAt: true },
            })
          )?.lastSuccessfulAt
        : (
            await this.prisma.folderCursor.findFirst({
              where: { mailboxId, lastSuccessfulAt: { not: null } },
              orderBy: { lastSuccessfulAt: "asc" },
              select: { lastSuccessfulAt: true },
            })
          )?.lastSuccessfulAt;
    const earliest = Math.min(
      pausedAt?.getTime() ?? Date.now(),
      successfulAt?.getTime() ?? pausedAt?.getTime() ?? Date.now(),
    );
    return new Date(
      Math.max(activationAt?.getTime() ?? 0, earliest - 2 * 60_000),
    );
  }

  private normalizeConditions(raw: Record<string, unknown>): RuleConditions {
    const conditions = raw as RuleConditions;
    const allowed = new Set([
      "folders",
      "senderAddresses",
      "senderDomains",
      "subjectContains",
      "subjectNotContains",
      "subjectPrefixes",
    ]);
    for (const key of Object.keys(raw))
      if (!allowed.has(key))
        throw new AppError(
          "RULE_CONDITION_INVALID",
          `不支持的规则条件：${key}`,
          400,
        );
    for (const [key, value] of Object.entries(conditions)) {
      if (
        !Array.isArray(value) ||
        value.some((item) => typeof item !== "string")
      )
        throw new AppError(
          "RULE_CONDITION_INVALID",
          `${key} 必须是字符串数组`,
          400,
        );
      if (value.length > 100)
        throw new AppError(
          "RULE_CONDITION_LIMIT",
          `${key} 最多包含 100 个值`,
          400,
        );
    }
    if (
      conditions.folders?.some((item) => !["inbox", "junkemail"].includes(item))
    )
      throw new AppError("RULE_FOLDER_INVALID", "文件夹条件无效", 400);
    return Object.fromEntries(
      Object.entries(conditions).map(([key, value]) => [
        key,
        [
          ...new Set((value ?? []).map((item) => item.trim()).filter(Boolean)),
        ].map((item) => item.slice(0, 320)),
      ]),
    ) as RuleConditions;
  }

  private async requeuePending(taskId: string, reason: string): Promise<void> {
    const rows = await this.prisma.messageReceipt.findMany({
      where: {
        taskId,
        state: { in: ["QUEUED", "CREATING_DRAFT", "DRAFT_READY", "SENDING"] },
      },
      include: { attempts: { orderBy: { number: "desc" }, take: 1 } },
    });
    const batch = `${reason}:${Date.now()}`;
    for (const row of rows) {
      const attempt = row.attempts[0];
      if (row.state === "QUEUED" || !attempt) {
        if (!attempt && row.state !== "QUEUED")
          await this.prisma.messageReceipt.update({
            where: { id: row.id },
            data: { state: "QUEUED" },
          });
        await this.prisma.transactionalOutbox.create({
          data: {
            kind: "PROCESS_MESSAGE",
            aggregateId: row.id,
            dedupeKey: `${batch}:process:${row.id}`,
            payload: { receiptId: row.id },
          },
        });
        continue;
      }
      const phase =
        attempt.verificationPhase ||
        (attempt.draftMessageId && row.state === "SENDING" ? "SEND" : "CREATE");
      const stage = Math.min(2, Math.max(0, attempt.verificationStage));
      await this.prisma.transactionalOutbox.create({
        data: {
          kind: "VERIFY_SEND",
          aggregateId: row.id,
          dedupeKey: `${batch}:verify:${attempt.id}:${phase}:${stage}`,
          payload: {
            receiptId: row.id,
            attemptId: attempt.id,
            stage,
            phase,
          },
          availableAt: new Date(Date.now() + 5_000),
        },
      });
    }
  }

  private async clearTaskOutbox(taskId: string): Promise<void> {
    await this.prisma.$executeRaw`
      DELETE FROM "TransactionalOutbox" AS outbox
      USING "MessageReceipt" AS receipt
      WHERE outbox."aggregateId" = receipt."id"
        AND receipt."taskId" = ${taskId}
        AND outbox."kind" IN ('PROCESS_MESSAGE', 'VERIFY_SEND')
    `;
  }

  private async hasInitializedCursor(
    mailboxId: string,
    provider: "MICROSOFT" | "GOOGLE",
  ): Promise<boolean> {
    if (provider === "GOOGLE")
      return Boolean(
        await this.prisma.gmailCursor.findFirst({
          where: { mailboxId, initializedAt: { not: null } },
          select: { id: true },
        }),
      );
    return (
      (await this.prisma.folderCursor.count({
        where: { mailboxId, initializedAt: { not: null } },
      })) === 2
    );
  }
}
