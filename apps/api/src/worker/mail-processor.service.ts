import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { TemplateVariables } from "@autoreply/shared";
import { PrismaService } from "../core/prisma.js";
import { AppConfig } from "../core/config.js";
import { TemplateService } from "../templates/template.service.js";
import { MailProviderService } from "../providers/mail-provider.service.js";
import { AlertService } from "../observability/alert.service.js";
import { ProviderApiError } from "../providers/provider-api.error.js";
import { RestoreBarrierService } from "../backup/restore-barrier.service.js";
import { AppError } from "../core/http.js";
import {
  SmtpDeliveryError,
  SmtpDeliveryService,
} from "../smtp/smtp-delivery.service.js";

const VERIFY_DELAYS_SECONDS = [15, 60, 300];

@Injectable()
export class MailProcessorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly templates: TemplateService,
    private readonly transport: MailProviderService,
    private readonly alerts: AlertService,
    private readonly restoreBarrier: RestoreBarrierService,
    private readonly smtp: SmtpDeliveryService,
  ) {}

  async process(receiptId: string): Promise<void> {
    await this.restoreBarrier.assertOpen();
    const initial = await this.loadReceipt(receiptId);
    if (!initial || initial.state !== "QUEUED") return;
    if (
      !["RUNNING", "INITIALIZING"].includes(initial.task.status) ||
      initial.mailbox.status !== "CONNECTED"
    )
      return;
    const attempt = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.messageReceipt.updateMany({
        where: { id: receiptId, state: "QUEUED" },
        data: { state: "CREATING_DRAFT" },
      });
      if (!claimed.count) return null;
      const attemptNumber =
        (await tx.replyAttempt.count({ where: { receiptId } })) + 1;
      return tx.replyAttempt.create({
        data: {
          receiptId,
          number: attemptNumber,
          state: "CREATING_DRAFT",
          transport: initial.task.sendTransport,
        },
      });
    });
    if (!attempt) return;

    const receipt = await this.loadReceipt(receiptId);
    if (!receipt) return;
    if (!receipt.templateRevisionId) {
      await this.failConfirmed(
        receiptId,
        "RECEIPT_NOT_SENDABLE",
        "邮件没有可用的已锁定模板修订",
        attempt.id,
      );
      return;
    }
    if (
      !["RUNNING", "INITIALIZING"].includes(receipt.task.status) ||
      receipt.mailbox.status !== "CONNECTED"
    ) {
      if (receipt.task.status === "DELETED")
        await this.finishInactiveReceipt(receiptId, attempt.id);
      else
        await this.deferUnsent(
          receiptId,
          attempt.id,
          undefined,
          "SEND_DEFERRED_INACTIVE",
          "任务或邮箱在创建草稿前被暂停，邮件将在恢复后继续处理",
        );
      return;
    }

    let rendered: Awaited<ReturnType<TemplateService["renderForReply"]>>;
    try {
      rendered = await this.templates.renderForReply(
        receipt.templateRevisionId,
        await this.variables(receipt),
      );
    } catch (error) {
      await this.failConfirmed(
        receiptId,
        "TEMPLATE_RENDER_FAILED",
        this.errorMessage(error),
        attempt.id,
      );
      return;
    }
    if (!(await this.sendAllowed(receiptId))) {
      const status = await this.taskStatus(receiptId);
      await this.prisma.messageReceipt.updateMany({
        where: { id: receiptId, state: "CREATING_DRAFT" },
        data:
          status === "DELETED"
            ? {
                state: "FILTERED",
                filterReason: "TASK_DELETED",
                completedAt: new Date(),
              }
            : { state: "QUEUED" },
      });
      return;
    }
    if (receipt.task.sendTransport === "SMTP") {
      await this.processSmtp(receipt, attempt.id, rendered);
      return;
    }
    let draftId: string | undefined;
    let sendStarted = false;

    try {
      const draft = await this.transport.createReplyDraft({
        mailboxId: receipt.mailboxId,
        sourceMessageId: receipt.graphMessageId,
        sourceInternetMessageId: receipt.internetMessageId,
        conversationId: receipt.conversationId,
        mailboxEmail: receipt.mailbox.email,
        recipient: receipt.replyToEmail || receipt.senderEmail,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        assets: rendered.assets,
        trackingId: receipt.trackingId,
        instanceId: await this.instanceId(),
      });
      draftId = draft.id;
      await this.prisma.$transaction([
        this.prisma.replyAttempt.update({
          where: { id: attempt.id },
          data: {
            state: "DRAFT_READY",
            draftMessageId: draft.id,
            draftInternetId: draft.internetMessageId,
          },
        }),
        this.prisma.messageReceipt.update({
          where: { id: receiptId },
          data: { state: "DRAFT_READY" },
        }),
      ]);

      await this.transport.uploadAssets(
        receipt.mailboxId,
        draft.id,
        rendered.assets,
      );
      await this.prisma.replyAttempt.update({
        where: { id: attempt.id },
        data: {
          uploadedAssetIds: rendered.assets.map(
            (asset) => asset.id,
          ) as Prisma.InputJsonValue,
        },
      });
      if (!(await this.sendAllowed(receiptId))) {
        await this.finishInactiveReceipt(receiptId, attempt.id);
        return;
      }
      await this.prisma.$transaction([
        this.prisma.replyAttempt.update({
          where: { id: attempt.id },
          data: { state: "SENDING" },
        }),
        this.prisma.messageReceipt.update({
          where: { id: receiptId },
          data: { state: "SENDING" },
        }),
      ]);
      sendStarted = true;

      try {
        await this.transport.sendDraft(receipt.mailboxId, draft.id);
        await this.prisma.replyAttempt.update({
          where: { id: attempt.id },
          data: { sentAcceptedAt: new Date() },
        });
      } catch (error) {
        if (!this.isUncertainTransportError(error)) throw error;
      }
      await this.enqueueVerification(receiptId, attempt.id, 0, "SEND");
    } catch (error) {
      if (this.isAuthorizationError(error)) {
        await this.deferUnsent(
          receiptId,
          attempt.id,
          draftId,
          this.errorCode(error),
          this.errorMessage(error),
        );
        return;
      }
      if (!draftId) {
        if (this.isUncertainTransportError(error))
          await this.enqueueVerification(receiptId, attempt.id, 0, "CREATE");
        else
          await this.failConfirmed(
            receiptId,
            this.errorCode(error),
            this.errorMessage(error),
            attempt.id,
          );
        return;
      }
      if (!sendStarted) {
        if (this.isConfirmedFailure(error))
          await this.failConfirmed(
            receiptId,
            this.errorCode(error),
            this.errorMessage(error),
            attempt.id,
          );
        else await this.enqueueVerification(receiptId, attempt.id, 0, "CREATE");
        return;
      }
      if (this.isConfirmedFailure(error)) {
        await this.failConfirmed(
          receiptId,
          this.errorCode(error),
          this.errorMessage(error),
          attempt.id,
        );
        return;
      }
      // A database/write failure after the send phase began must still enter
      // the normal 15s/60s/5m verification path. Marking it uncertain here
      // would skip the evidence checks even though the draft ID is durable.
      await this.enqueueVerification(receiptId, attempt.id, 0, "SEND");
    }
  }

  async verify(
    receiptId: string,
    attemptId: string,
    stage: number,
    phase: string,
  ): Promise<void> {
    await this.restoreBarrier.assertOpen();
    const receipt = await this.loadReceipt(receiptId);
    const attempt = await this.prisma.replyAttempt.findUnique({
      where: { id: attemptId },
    });
    if (
      !receipt ||
      !attempt ||
      ["SENT", "FAILED_CONFIRMED", "UNCERTAIN"].includes(receipt.state)
    )
      return;
    if (
      !["RUNNING", "INITIALIZING"].includes(receipt.task.status) ||
      receipt.mailbox.status !== "CONNECTED"
    )
      return;

    if (attempt.transport === "SMTP") {
      if (!attempt.smtpSendStartedAt) {
        await this.prisma.$transaction([
          this.prisma.replyAttempt.update({
            where: { id: attempt.id },
            data: {
              state: "FAILED_CONFIRMED",
              errorCode: "SMTP_SEND_NOT_STARTED",
              errorMessage:
                "Worker 中断发生在 SMTP 发送开始之前，已安全重新排队",
              verifiedAt: new Date(),
            },
          }),
          this.prisma.messageReceipt.update({
            where: { id: receipt.id },
            data: { state: "QUEUED" },
          }),
          this.prisma.transactionalOutbox.upsert({
            where: { dedupeKey: `smtp-recovery:${receipt.id}:${attempt.id}` },
            create: {
              kind: "PROCESS_MESSAGE",
              aggregateId: receipt.id,
              dedupeKey: `smtp-recovery:${receipt.id}:${attempt.id}`,
              payload: { receiptId: receipt.id } as Prisma.InputJsonValue,
            },
            update: {},
          }),
        ]);
      } else
        await this.markUncertain(
          receipt.id,
          attempt.id,
          "SMTP_SEND_STATUS_UNCERTAIN",
          "Worker 在 SMTP 服务器响应持久化前中断，无法安全确认邮件是否已经被服务器接受",
        );
      return;
    }

    if (
      phase === "CREATE" &&
      (attempt.state === "SENDING" || attempt.sentAcceptedAt)
    )
      phase = "SEND";

    try {
      const message = attempt.draftMessageId
        ? await this.transport.getMessage(
            receipt.mailboxId,
            attempt.draftMessageId,
          )
        : await this.transport.findDraftByTracking(
            receipt.mailboxId,
            receipt.trackingId,
            receipt.conversationId,
            attempt.startedAt,
          );

      if (message && !attempt.draftMessageId) {
        await this.prisma.replyAttempt.update({
          where: { id: attemptId },
          data: {
            draftMessageId: message.id,
            draftInternetId: message.internetMessageId,
            state: message.isDraft
              ? "DRAFT_READY"
              : message.sentDateTime
                ? "SENT"
                : "SENDING",
          },
        });
      }

      if (
        message &&
        message.isDraft === false &&
        Boolean(message.sentDateTime)
      ) {
        await this.markSent(receiptId, attemptId, message.internetMessageId);
        return;
      }

      if (
        !message &&
        attempt.draftMessageId &&
        (attempt.sentAcceptedAt || phase === "SEND")
      ) {
        const sent = await this.transport.findSentByTracking(
          receipt.mailboxId,
          receipt.trackingId,
          receipt.conversationId,
          attempt.sentAcceptedAt ?? attempt.startedAt,
        );
        if (sent) {
          await this.markSent(receiptId, attemptId, sent.internetMessageId);
          return;
        }
      }

      if (message?.isDraft && phase === "CREATE") {
        const rendered = await this.templates.renderForReply(
          receipt.templateRevisionId!,
          await this.variables(receipt),
        );
        const uploaded = new Set(
          Array.isArray(attempt.uploadedAssetIds)
            ? (attempt.uploadedAssetIds as string[])
            : [],
        );
        const remaining = rendered.assets.filter(
          (asset) => !uploaded.has(asset.id),
        );
        if (remaining.length)
          await this.transport.uploadAssets(
            receipt.mailboxId,
            message.id,
            remaining,
          );
        if (!(await this.sendAllowed(receiptId))) {
          await this.finishInactiveReceipt(receiptId, attemptId);
          return;
        }
        await this.prisma.replyAttempt.update({
          where: { id: attemptId },
          data: {
            draftMessageId: message.id,
            state: "SENDING",
            uploadedAssetIds: rendered.assets.map(
              (asset) => asset.id,
            ) as Prisma.InputJsonValue,
          },
        });
        await this.prisma.messageReceipt.update({
          where: { id: receiptId },
          data: { state: "SENDING" },
        });
        try {
          await this.transport.sendDraft(receipt.mailboxId, message.id);
          await this.prisma.replyAttempt.update({
            where: { id: attemptId },
            data: { sentAcceptedAt: new Date() },
          });
        } catch (error) {
          if (!this.isUncertainTransportError(error)) throw error;
        }
        phase = "SEND";
      }

      if (stage + 1 < VERIFY_DELAYS_SECONDS.length) {
        await this.enqueueVerification(receiptId, attemptId, stage + 1, phase);
        return;
      }
      await this.markUncertain(
        receiptId,
        attemptId,
        "SEND_STATUS_UNCERTAIN",
        "多次核验后仍无法确认邮件是否已发送",
      );
    } catch (error) {
      if (this.isAuthorizationError(error)) {
        if (
          phase === "CREATE" &&
          attempt.state !== "SENDING" &&
          !attempt.sentAcceptedAt
        )
          await this.deferUnsent(
            receiptId,
            attemptId,
            attempt.draftMessageId ?? undefined,
            this.errorCode(error),
            this.errorMessage(error),
          );
        else
          await this.deferVerificationForAuthorization(
            receiptId,
            attemptId,
            this.errorCode(error),
            this.errorMessage(error),
          );
        return;
      }
      if (stage + 1 < VERIFY_DELAYS_SECONDS.length) {
        await this.enqueueVerification(receiptId, attemptId, stage + 1, phase);
      } else {
        await this.markUncertain(
          receiptId,
          attemptId,
          this.errorCode(error),
          this.errorMessage(error),
        );
      }
    }
  }

  async retryConfirmed(receiptId: string): Promise<void> {
    const receipt = await this.prisma.messageReceipt.findUnique({
      where: { id: receiptId },
    });
    if (!receipt || receipt.state !== "FAILED_CONFIRMED")
      throw new Error("Only confirmed failures can be retried");
    await this.prisma.$transaction([
      this.prisma.messageReceipt.update({
        where: { id: receiptId },
        data: {
          state: "QUEUED",
          retryCount: { increment: 1 },
          lastErrorCode: null,
          lastErrorMessage: null,
          completedAt: null,
        },
      }),
      this.prisma.transactionalOutbox.create({
        data: {
          kind: "PROCESS_MESSAGE",
          aggregateId: receiptId,
          dedupeKey: `retry:${receiptId}:${receipt.retryCount + 1}`,
          payload: { receiptId } as Prisma.InputJsonValue,
        },
      }),
    ]);
  }

  private loadReceipt(receiptId: string) {
    return this.prisma.messageReceipt.findUnique({
      where: { id: receiptId },
      include: {
        mailbox: true,
        task: true,
        rule: true,
        templateRevision: { include: { template: true } },
      },
    });
  }

  private async processSmtp(
    receipt: NonNullable<
      Awaited<ReturnType<MailProcessorService["loadReceipt"]>>
    >,
    attemptId: string,
    rendered: Awaited<ReturnType<TemplateService["renderForReply"]>>,
  ): Promise<void> {
    if (!receipt.task.smtpConfigId) {
      await this.failConfirmed(
        receipt.id,
        "SMTP_CONFIG_REQUIRED",
        "任务没有可用的 SMTP 发件配置",
        attemptId,
      );
      return;
    }
    const startedAt = new Date();
    await this.prisma.$transaction([
      this.prisma.replyAttempt.update({
        where: { id: attemptId },
        data: {
          state: "SENDING",
          transport: "SMTP",
          smtpSendStartedAt: startedAt,
        },
      }),
      this.prisma.messageReceipt.update({
        where: { id: receipt.id },
        data: { state: "SENDING" },
      }),
    ]);
    try {
      const result = await this.smtp.sendReply({
        smtpConfigId: receipt.task.smtpConfigId,
        recipient: receipt.replyToEmail || receipt.senderEmail,
        replyToFallback: receipt.mailbox.email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        assets: rendered.assets,
        sourceInternetMessageId: receipt.internetMessageId,
        trackingId: receipt.trackingId,
        instanceId: await this.instanceId(),
      });
      await this.prisma.replyAttempt.update({
        where: { id: attemptId },
        data: {
          sentAcceptedAt: new Date(),
          draftInternetId: result.messageId,
        },
      });
      await this.markSent(receipt.id, attemptId, result.messageId);
    } catch (error) {
      if (error instanceof SmtpDeliveryError && !error.uncertain) {
        await this.failConfirmed(
          receipt.id,
          error.code,
          error.message,
          attemptId,
        );
        return;
      }
      await this.markUncertain(
        receipt.id,
        attemptId,
        error instanceof SmtpDeliveryError
          ? error.code
          : "SMTP_SEND_STATUS_UNCERTAIN",
        error instanceof Error ? error.message : "SMTP 发送状态无法确认",
      );
    }
  }

  private async variables(
    receipt: NonNullable<
      Awaited<ReturnType<MailProcessorService["loadReceipt"]>>
    >,
  ): Promise<TemplateVariables> {
    const now = new Date();
    const timeZone = await this.timezone();
    return {
      sender: { name: receipt.senderName ?? "", email: receipt.senderEmail },
      mailbox: {
        name: receipt.mailbox.displayName,
        email: receipt.mailbox.email,
      },
      message: {
        subject: receipt.subject,
        received_at: receipt.receivedAt.toISOString(),
        folder: receipt.folder === "INBOX" ? "inbox" : "junkemail",
      },
      rule: { name: receipt.rule?.name ?? "默认模板" },
      system: {
        current_date: now.toLocaleDateString("zh-CN", {
          timeZone,
        }),
        current_time: now.toLocaleTimeString("zh-CN", {
          timeZone,
        }),
        current_datetime: now.toLocaleString("zh-CN", {
          timeZone,
        }),
      },
    };
  }

  private async timezone(): Promise<string> {
    const setting = await this.prisma.systemSetting.findUnique({
      where: { key: "timezone" },
      select: { value: true },
    });
    const value =
      typeof setting?.value === "string" ? setting.value : this.config.timezone;
    try {
      new Intl.DateTimeFormat("zh-CN", { timeZone: value }).format();
      return value;
    } catch {
      return this.config.timezone;
    }
  }

  private async enqueueVerification(
    receiptId: string,
    attemptId: string,
    stage: number,
    phase: string,
  ): Promise<void> {
    const seconds =
      VERIFY_DELAYS_SECONDS[stage] ?? VERIFY_DELAYS_SECONDS.at(-1)!;
    await this.prisma.$transaction([
      this.prisma.replyAttempt.update({
        where: { id: attemptId },
        data: { verificationPhase: phase, verificationStage: stage },
      }),
      this.prisma.transactionalOutbox.upsert({
        where: { dedupeKey: `verify:${attemptId}:${stage}:${phase}` },
        create: {
          kind: "VERIFY_SEND",
          aggregateId: receiptId,
          dedupeKey: `verify:${attemptId}:${stage}:${phase}`,
          payload: {
            receiptId,
            attemptId,
            stage,
            phase,
          } as Prisma.InputJsonValue,
          availableAt: new Date(Date.now() + seconds * 1_000),
        },
        update: {},
      }),
    ]);
  }

  private async markSent(
    receiptId: string,
    attemptId: string,
    internetId?: string,
  ): Promise<void> {
    const receipt = await this.prisma.messageReceipt.findUniqueOrThrow({
      where: { id: receiptId },
      include: {
        mailbox: true,
        task: true,
        templateRevision: { include: { template: true } },
        rule: true,
      },
    });
    const now = new Date();
    const claimed = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.messageReceipt.updateMany({
        where: {
          id: receiptId,
          state: { notIn: ["SENT", "FAILED_CONFIRMED", "UNCERTAIN"] },
        },
        data: {
          state: "SENT",
          completedAt: now,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });
      if (!updated.count) return false;
      await tx.replyAttempt.update({
        where: { id: attemptId },
        data: { state: "SENT", draftInternetId: internetId, verifiedAt: now },
      });
      await tx.processingLog.create({
        data: {
          mailboxId: receipt.mailboxId,
          mailboxEmail: receipt.mailbox.email,
          receiptId,
          event: "REPLY_SENT",
          senderEmail: receipt.senderEmail,
          subject: receipt.subject,
          folder: receipt.folder,
          ruleName: receipt.rule?.name,
          templateName: receipt.templateRevision?.template.name,
          status: "SENT",
          reason:
            receipt.task.sendTransport === "SMTP"
              ? "SMTP 服务器已接受邮件；这不是目标邮箱的最终送达回执"
              : receipt.mailbox.provider === "GOOGLE"
                ? "Gmail API 已确认邮件进入已发送；这不是目标邮箱的最终送达回执"
                : "Microsoft Graph 已确认邮件进入已发送邮件；这不是目标邮箱的最终送达回执",
        },
      });
      return true;
    });
    if (!claimed) return;
    await this.alerts.resolve(`send:${receiptId}`);
  }

  private async failConfirmed(
    receiptId: string,
    code: string,
    message: string,
    attemptId?: string,
  ): Promise<void> {
    const receipt = await this.prisma.messageReceipt.findUnique({
      where: { id: receiptId },
      include: { mailbox: true },
    });
    if (!receipt) return;
    const now = new Date();
    await this.prisma.$transaction([
      ...(attemptId
        ? [
            this.prisma.replyAttempt.update({
              where: { id: attemptId },
              data: {
                state: "FAILED_CONFIRMED",
                errorCode: code,
                errorMessage: message.slice(0, 1000),
              },
            }),
          ]
        : []),
      this.prisma.messageReceipt.update({
        where: { id: receiptId },
        data: {
          state: "FAILED_CONFIRMED",
          lastErrorCode: code,
          lastErrorMessage: message.slice(0, 1000),
          completedAt: now,
        },
      }),
      this.prisma.processingLog.create({
        data: {
          mailboxId: receipt.mailboxId,
          mailboxEmail: receipt.mailbox.email,
          receiptId,
          event: "REPLY_FAILED_CONFIRMED",
          senderEmail: receipt.senderEmail,
          subject: receipt.subject,
          folder: receipt.folder,
          status: "FAILED_CONFIRMED",
          errorCode: code,
          reason: message.slice(0, 1000),
        },
      }),
    ]);
    if (
      /ErrorAccountSuspend|MICROSOFT_ACCOUNT_SUSPENDED/i.test(code) ||
      /Account suspended|verdict is Suspend/i.test(message)
    ) {
      await this.prisma.autoReplyTask.updateMany({
        where: {
          id: receipt.taskId,
          status: { in: ["RUNNING", "INITIALIZING"] },
        },
        data: { status: "PAUSED", pausedAt: new Date(), nextPollAt: null },
      });
      await this.alerts.open({
        fingerprint: `mailbox-send-suspended:${receipt.mailboxId}`,
        type: "MICROSOFT_ACCOUNT_SUSPENDED",
        severity: "CRITICAL",
        title: "Microsoft 邮箱发信能力已暂停",
        message:
          "Microsoft 已限制此邮箱发信，自动回复任务已暂停。请登录 Outlook 网页版按收件箱提示验证账户，或把任务改为 SMTP 发件后恢复。",
        metadata: {
          mailboxId: receipt.mailboxId,
          taskId: receipt.taskId,
          code,
        },
      });
    }
  }

  private async markUncertain(
    receiptId: string,
    attemptId: string,
    code: string,
    message: string,
  ): Promise<void> {
    const receipt = await this.prisma.messageReceipt.findUnique({
      where: { id: receiptId },
      include: { mailbox: true },
    });
    if (!receipt) return;
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.replyAttempt.update({
        where: { id: attemptId },
        data: {
          state: "UNCERTAIN",
          errorCode: code,
          errorMessage: message.slice(0, 1000),
          verifiedAt: now,
        },
      }),
      this.prisma.messageReceipt.update({
        where: { id: receiptId },
        data: {
          state: "UNCERTAIN",
          lastErrorCode: code,
          lastErrorMessage: message.slice(0, 1000),
          completedAt: now,
        },
      }),
      this.prisma.processingLog.create({
        data: {
          mailboxId: receipt.mailboxId,
          mailboxEmail: receipt.mailbox.email,
          receiptId,
          event: "REPLY_STATUS_UNCERTAIN",
          senderEmail: receipt.senderEmail,
          subject: receipt.subject,
          folder: receipt.folder,
          status: "UNCERTAIN",
          errorCode: code,
          reason: message.slice(0, 1000),
        },
      }),
    ]);
    await this.alerts.open({
      fingerprint: `send:${receiptId}`,
      type: "SEND_STATUS_UNCERTAIN",
      severity: "CRITICAL",
      title: "回复发送状态无法确认",
      message:
        "系统无法安全确认此邮件是否已发送，因此不会自动重发，请人工核查对应邮箱的已发送邮件。",
      metadata: { receiptId, mailboxId: receipt.mailboxId },
    });
  }

  private async instanceId(): Promise<string> {
    const setting = await this.prisma.systemSetting.findUnique({
      where: { key: "instanceId" },
    });
    return typeof setting?.value === "string"
      ? setting.value
      : "autoreply-instance";
  }

  private async sendAllowed(receiptId: string): Promise<boolean> {
    const receipt = await this.prisma.messageReceipt.findUnique({
      where: { id: receiptId },
      select: {
        task: { select: { status: true } },
        mailbox: { select: { status: true } },
      },
    });
    return Boolean(
      receipt &&
      ["RUNNING", "INITIALIZING"].includes(receipt.task.status) &&
      receipt.mailbox.status === "CONNECTED",
    );
  }

  private async taskStatus(receiptId: string): Promise<string | undefined> {
    return (
      await this.prisma.messageReceipt.findUnique({
        where: { id: receiptId },
        select: { task: { select: { status: true } } },
      })
    )?.task.status;
  }

  private async finishInactiveReceipt(
    receiptId: string,
    attemptId: string,
  ): Promise<void> {
    const receipt = await this.prisma.messageReceipt.findUnique({
      where: { id: receiptId },
      select: { state: true, task: { select: { status: true } } },
    });
    if (!receipt || receipt.task.status !== "DELETED") return;
    await this.prisma.$transaction([
      this.prisma.replyAttempt.update({
        where: { id: attemptId },
        data: {
          state: "FILTERED",
          errorCode: "TASK_DELETED",
          errorMessage: "任务已删除，草稿未发送",
          verifiedAt: new Date(),
        },
      }),
      this.prisma.messageReceipt.update({
        where: { id: receiptId },
        data: {
          state: "FILTERED",
          filterReason: "TASK_DELETED",
          completedAt: new Date(),
        },
      }),
    ]);
  }

  private async deferUnsent(
    receiptId: string,
    attemptId: string,
    draftId: string | undefined,
    code: string,
    message: string,
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.replyAttempt.update({
        where: { id: attemptId },
        data: {
          state: draftId ? "DRAFT_READY" : "FAILED_CONFIRMED",
          draftMessageId: draftId,
          errorCode: code,
          errorMessage: message.slice(0, 1_000),
        },
      }),
      this.prisma.messageReceipt.update({
        where: { id: receiptId },
        data: {
          state: draftId ? "DRAFT_READY" : "QUEUED",
          lastErrorCode: code,
          lastErrorMessage: message.slice(0, 1_000),
          completedAt: null,
        },
      }),
    ]);
  }

  private async deferVerificationForAuthorization(
    receiptId: string,
    attemptId: string,
    code: string,
    message: string,
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.replyAttempt.update({
        where: { id: attemptId },
        data: {
          errorCode: code,
          errorMessage: message.slice(0, 1_000),
        },
      }),
      this.prisma.messageReceipt.update({
        where: { id: receiptId },
        data: {
          lastErrorCode: code,
          lastErrorMessage: message.slice(0, 1_000),
          completedAt: null,
        },
      }),
    ]);
  }

  private isUncertainTransportError(error: unknown): boolean {
    return (
      error instanceof ProviderApiError &&
      (error.status === 0 || error.status >= 500 || error.status === 429)
    );
  }

  private isAuthorizationError(error: unknown): boolean {
    return (
      (error instanceof AppError &&
        ["MAILBOX_AUTH_REQUIRED", "MAILBOX_NOT_CONNECTED"].includes(
          error.code,
        )) ||
      (error instanceof ProviderApiError &&
        (error.status === 401 ||
          (error.status === 403 &&
            (error.provider === "MICROSOFT"
              ? /InvalidAuthenticationToken|AuthenticationError|InvalidToken|TokenExpired|token.+(?:expired|invalid|revoked)|(?:expired|invalid|revoked).+token/i.test(
                  `${error.code} ${error.message}`,
                )
              : /authError|insufficientPermissions|invalidCredentials|unauthorized/i.test(
                  error.code,
                )))))
    );
  }

  private isConfirmedFailure(error: unknown): boolean {
    return (
      (error instanceof AppError &&
        error.status >= 400 &&
        error.status < 500 &&
        ![408, 429].includes(error.status)) ||
      (error instanceof ProviderApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        ![408, 409, 429].includes(error.status))
    );
  }

  private errorCode(error: unknown): string {
    return error instanceof ProviderApiError
      ? error.code
      : error instanceof Error
        ? error.name
        : "UNKNOWN_ERROR";
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Unknown processing error";
  }
}
