import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  Sse,
} from "@nestjs/common";
import type { Request } from "express";
import type { Response } from "express";
import { interval, map, merge, type Observable } from "rxjs";
import { PrismaService } from "../core/prisma.js";
import { AuditService } from "../core/audit.js";
import { EventBus } from "../core/events.js";
import { CryptoService } from "../core/crypto.js";
import { AppError } from "../core/http.js";
import type { Prisma } from "@prisma/client";
import { CreateWebhookDto, UpdateWebhookDto } from "./observability.dto.js";

@Controller("api/v1")
export class ObservabilityController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly crypto: CryptoService,
  ) {}

  @Get("dashboard")
  async dashboard() {
    const now = Date.now();
    const since24h = new Date(now - 24 * 60 * 60_000);
    const since7d = new Date(now - 7 * 24 * 60 * 60_000);
    const [
      mailboxes,
      taskGroups,
      state24h,
      state7d,
      stats24h,
      stats7d,
      openAlerts,
      workers,
      recent,
      pendingOutbox,
    ] = await Promise.all([
      this.prisma.mailbox.groupBy({ by: ["status"], _count: { _all: true } }),
      this.prisma.autoReplyTask.groupBy({
        by: ["status"],
        where: { status: { not: "DELETED" } },
        _count: { _all: true },
      }),
      this.prisma.messageReceipt.groupBy({
        by: ["state"],
        where: { createdAt: { gte: since24h } },
        _count: { _all: true },
      }),
      this.prisma.messageReceipt.groupBy({
        by: ["state"],
        where: { createdAt: { gte: since7d } },
        _count: { _all: true },
      }),
      this.processingStats(since24h),
      this.processingStats(since7d),
      this.prisma.alert.count({
        where: { status: "OPEN" },
      }),
      this.prisma.workerHeartbeat.findMany({
        orderBy: { updatedAt: "desc" },
        take: 10,
      }),
      this.prisma.processingLog.findMany({
        orderBy: { occurredAt: "desc" },
        take: 12,
      }),
      this.prisma.transactionalOutbox.count({
        where: { kind: { in: ["PROCESS_MESSAGE", "VERIFY_SEND"] } },
      }),
    ]);
    return {
      mailboxes,
      tasks: taskGroups,
      states24h: state24h,
      states7d: state7d,
      stats24h,
      stats7d,
      openAlerts,
      workers: workers.map((worker) => ({
        ...worker,
        healthy: worker.updatedAt >= new Date(now - 60_000),
      })),
      recent,
      pendingOutbox,
    };
  }

  @Get("alerts")
  alerts(@Query("status") status?: string) {
    if (status && !["OPEN", "ACKNOWLEDGED", "RESOLVED"].includes(status))
      throw new AppError("ALERT_STATUS_INVALID", "告警状态筛选无效", 400);
    return this.prisma.alert.findMany({
      where: status ? { status: status as never } : undefined,
      orderBy: [{ status: "asc" }, { lastSeenAt: "desc" }],
      take: 500,
    });
  }

  @Patch("alerts/:id/acknowledge")
  async acknowledge(@Param("id") id: string, @Req() req: Request) {
    const updated = await this.prisma.alert.updateMany({
      where: { id, status: "OPEN" },
      data: { status: "ACKNOWLEDGED", acknowledgedAt: new Date() },
    });
    if (!updated.count)
      throw new AppError(
        "ALERT_ACKNOWLEDGE_INVALID",
        "只有未处理告警可以确认",
        409,
      );
    await this.audit.write("ALERT_ACKNOWLEDGED", req, { type: "Alert", id });
    return this.prisma.alert.findUniqueOrThrow({ where: { id } });
  }

  @Get("processing-logs")
  async processingLogs(
    @Query("page") pageRaw = "1",
    @Query("pageSize") sizeRaw = "50",
    @Query("status") status?: string,
    @Query("mailboxId") mailboxId?: string,
    @Query("sender") sender?: string,
    @Query("subject") subject?: string,
    @Query("from") fromRaw?: string,
    @Query("to") toRaw?: string,
  ) {
    const page = this.positiveInt(pageRaw, 1, 1_000_000);
    const pageSize = this.positiveInt(sizeRaw, 50, 200);
    const where = this.processingLogWhere({
      status,
      mailboxId,
      sender,
      subject,
      fromRaw,
      toRaw,
    });
    const [items, total] = await this.prisma.$transaction([
      this.prisma.processingLog.findMany({
        where,
        orderBy: { occurredAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.processingLog.count({ where }),
    ]);
    return { items, page, pageSize, total };
  }

  @Get("processing-logs/export")
  async exportProcessingLogs(
    @Query("format") format = "csv",
    @Query("status") status: string | undefined,
    @Query("mailboxId") mailboxId: string | undefined,
    @Query("sender") sender: string | undefined,
    @Query("subject") subject: string | undefined,
    @Query("from") fromRaw: string | undefined,
    @Query("to") toRaw: string | undefined,
    @Res() res: Response,
  ) {
    const where = this.processingLogWhere({
      status,
      mailboxId,
      sender,
      subject,
      fromRaw,
      toRaw,
    });
    const rows = await this.prisma.processingLog.findMany({
      where,
      orderBy: { occurredAt: "desc" },
      take: 50_000,
    });
    if (format === "json") {
      res.setHeader(
        "content-disposition",
        'attachment; filename="processing-logs.json"',
      );
      res.setHeader("content-type", "application/json; charset=utf-8");
      return res.json(rows);
    }
    const columns = [
      "occurredAt",
      "mailboxEmail",
      "senderEmail",
      "subject",
      "folder",
      "event",
      "status",
      "reason",
      "errorCode",
      "requestId",
    ] as const;
    const escape = (value: unknown) =>
      `"${this.safeSpreadsheetCell(value).replace(/"/g, '""')}"`;
    const csv = [
      columns.join(","),
      ...rows.map((row) => columns.map((key) => escape(row[key])).join(",")),
    ].join("\r\n");
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader(
      "content-disposition",
      'attachment; filename="processing-logs.csv"',
    );
    return res.send(`\uFEFF${csv}`);
  }

  @Get("system-logs")
  async systemLogs(
    @Query("page") pageRaw = "1",
    @Query("pageSize") sizeRaw = "50",
    @Query("level") level?: string,
    @Query("component") component?: string,
    @Query("query") query?: string,
    @Query("from") fromRaw?: string,
    @Query("to") toRaw?: string,
  ) {
    const page = this.positiveInt(pageRaw, 1, 1_000_000);
    const pageSize = this.positiveInt(sizeRaw, 50, 200);
    const where = this.systemLogWhere({
      level,
      component,
      query,
      fromRaw,
      toRaw,
    });
    const [items, total, components] = await this.prisma.$transaction([
      this.prisma.systemLog.findMany({
        where,
        orderBy: { occurredAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.systemLog.count({ where }),
      this.prisma.systemLog.findMany({
        distinct: ["component"],
        select: { component: true },
        orderBy: { component: "asc" },
      }),
    ]);
    return {
      items,
      page,
      pageSize,
      total,
      components: components.map((item) => item.component),
    };
  }

  @Get("system-logs/export")
  async exportSystemLogs(
    @Query("format") format = "csv",
    @Query("level") level: string | undefined,
    @Query("component") component: string | undefined,
    @Query("query") query: string | undefined,
    @Query("from") fromRaw: string | undefined,
    @Query("to") toRaw: string | undefined,
    @Res() res: Response,
  ) {
    const rows = await this.prisma.systemLog.findMany({
      where: this.systemLogWhere({
        level,
        component,
        query,
        fromRaw,
        toRaw,
      }),
      orderBy: { occurredAt: "desc" },
      take: 50_000,
    });
    if (format === "json") {
      res.setHeader(
        "content-disposition",
        'attachment; filename="system-logs.json"',
      );
      res.setHeader("content-type", "application/json; charset=utf-8");
      return res.json(rows);
    }
    const columns = [
      "occurredAt",
      "level",
      "component",
      "event",
      "message",
      "requestId",
      "metadata",
    ] as const;
    const escape = (value: unknown) =>
      `"${this.safeSpreadsheetCell(
        value && typeof value === "object" ? JSON.stringify(value) : value,
      ).replace(/"/g, '""')}"`;
    const csv = [
      columns.join(","),
      ...rows.map((row) => columns.map((key) => escape(row[key])).join(",")),
    ].join("\r\n");
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader(
      "content-disposition",
      'attachment; filename="system-logs.csv"',
    );
    return res.send(`\uFEFF${csv}`);
  }

  @Post("processing-logs/:id/retry")
  async retry(@Param("id") id: string, @Req() req: Request) {
    const log = await this.prisma.processingLog.findUnique({
      where: { id },
      select: { receiptId: true },
    });
    const receiptId = log?.receiptId || id;
    const receipt = await this.prisma.messageReceipt.findUnique({
      where: { id: receiptId },
      select: {
        state: true,
        retryCount: true,
        templateRevisionId: true,
        task: { select: { status: true } },
        mailbox: { select: { status: true } },
      },
    });
    if (!receipt || receipt.state !== "FAILED_CONFIRMED")
      throw new AppError(
        "RETRY_NOT_ALLOWED",
        "只有确认未发送的失败记录可以重试",
        409,
      );
    if (
      !["RUNNING", "INITIALIZING"].includes(receipt.task.status) ||
      receipt.mailbox.status !== "CONNECTED"
    )
      throw new AppError(
        "RETRY_TASK_INACTIVE",
        "请先连接邮箱并恢复自动回复任务，再重试此邮件",
        409,
      );
    if (!receipt.templateRevisionId)
      throw new AppError(
        "RETRY_TEMPLATE_MISSING",
        "首次锁定的模板修订已不可用，无法安全重试",
        409,
      );
    await this.prisma.$transaction([
      this.prisma.messageReceipt.update({
        where: { id: receiptId },
        data: {
          state: "QUEUED",
          retryCount: { increment: 1 },
          completedAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      }),
      this.prisma.transactionalOutbox.create({
        data: {
          kind: "PROCESS_MESSAGE",
          aggregateId: receiptId,
          dedupeKey: `manual-retry:${receiptId}:${receipt.retryCount + 1}`,
          payload: { receiptId },
        },
      }),
    ]);
    await this.audit.write("PROCESSING_RETRY_QUEUED", req, {
      type: "MessageReceipt",
      id: receiptId,
    });
    return { ok: true };
  }

  @Get("audit-logs")
  async auditLogs(@Query("page") pageRaw = "1") {
    const page = this.positiveInt(pageRaw, 1, 1_000_000);
    const pageSize = 50;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        orderBy: { occurredAt: "desc" },
        include: { admin: { select: { username: true } } },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.auditLog.count(),
    ]);
    return { items, page, pageSize, total };
  }

  @Get("webhooks")
  async webhooks() {
    const rows = await this.prisma.webhookEndpoint.findMany({
      orderBy: { createdAt: "desc" },
    });
    return rows.map(({ secretEncrypted: _, ...row }) => ({
      ...row,
      hasSecret: true,
    }));
  }

  @Post("webhooks")
  async createWebhook(@Body() body: CreateWebhookDto, @Req() req: Request) {
    if (!body.name.trim())
      throw new AppError("WEBHOOK_NAME_REQUIRED", "Webhook 名称不能为空", 400);
    if (!/^https:\/\//i.test(body.url))
      throw new AppError(
        "WEBHOOK_HTTPS_REQUIRED",
        "Webhook 地址必须使用 HTTPS",
        400,
      );
    const id = crypto.randomUUID();
    const secret = body.secret || this.crypto.randomToken(32);
    const row = await this.prisma.webhookEndpoint.create({
      data: {
        id,
        name: body.name.trim(),
        url: body.url,
        secretEncrypted: await this.crypto.encryptString(
          secret,
          `webhook:${id}`,
        ),
        eventTypes: body.eventTypes ?? ["*"],
      },
    });
    await this.audit.write("WEBHOOK_CREATED", req, {
      type: "WebhookEndpoint",
      id,
    });
    return { id: row.id, secret };
  }

  @Patch("webhooks/:id")
  async updateWebhook(
    @Param("id") id: string,
    @Body() body: UpdateWebhookDto,
    @Req() req: Request,
  ) {
    if (body.name !== undefined && !body.name.trim())
      throw new AppError("WEBHOOK_NAME_REQUIRED", "Webhook 名称不能为空", 400);
    if (body.url && !/^https:\/\//i.test(body.url))
      throw new AppError(
        "WEBHOOK_HTTPS_REQUIRED",
        "Webhook 地址必须使用 HTTPS",
        400,
      );
    await this.prisma.webhookEndpoint.update({
      where: { id },
      data: {
        name: body.name?.trim(),
        url: body.url,
        enabled: body.enabled,
        eventTypes: body.eventTypes,
        secretEncrypted: body.secret
          ? await this.crypto.encryptString(body.secret, `webhook:${id}`)
          : undefined,
      },
    });
    await this.audit.write("WEBHOOK_UPDATED", req, {
      type: "WebhookEndpoint",
      id,
    });
    return { ok: true };
  }

  @Post("webhooks/:id/test")
  async testWebhook(@Param("id") id: string, @Req() req: Request) {
    const endpoint = await this.prisma.webhookEndpoint.findUniqueOrThrow({
      where: { id },
    });
    const testAlert = await this.prisma.alert.create({
      data: {
        fingerprint: `webhook-test:${id}:${Date.now()}`,
        type: "WEBHOOK_TEST",
        severity: "INFO",
        title: "MailPilot Webhook 测试",
        message: "这是一条不包含邮件元数据的测试告警。",
        status: "RESOLVED",
        resolvedAt: new Date(),
      },
    });
    const outbox = await this.prisma.transactionalOutbox.create({
      data: {
        kind: "WEBHOOK",
        aggregateId: testAlert.id,
        payload: {
          event: "WEBHOOK_TEST",
          alertId: testAlert.id,
          endpointId: id,
        },
      },
    });
    await this.audit.write("WEBHOOK_TEST_QUEUED", req, {
      type: "WebhookEndpoint",
      id,
    });
    return { queued: true, endpoint: endpoint.name, outboxId: outbox.id };
  }

  @Delete("webhooks/:id")
  async deleteWebhook(@Param("id") id: string, @Req() req: Request) {
    await this.prisma.webhookEndpoint.delete({ where: { id } });
    await this.audit.write("WEBHOOK_DELETED", req, {
      type: "WebhookEndpoint",
      id,
    });
    return { ok: true };
  }

  @Sse("events")
  stream(): Observable<{ data: unknown }> {
    return merge(
      this.events.stream.pipe(map((event) => ({ data: event }))),
      interval(20_000).pipe(
        map(() => ({
          data: { type: "heartbeat", at: new Date().toISOString() },
        })),
      ),
    );
  }

  private systemLogWhere(input: {
    level?: string;
    component?: string;
    query?: string;
    fromRaw?: string;
    toRaw?: string;
  }): Prisma.SystemLogWhereInput {
    const from = this.optionalDate(input.fromRaw, false);
    const to = this.optionalDate(input.toRaw, true);
    const query = input.query?.trim().slice(0, 200);
    return {
      ...(input.level ? { level: input.level.slice(0, 32) } : {}),
      ...(input.component ? { component: input.component.slice(0, 100) } : {}),
      ...(from || to
        ? {
            occurredAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
      ...(query
        ? {
            OR: [
              { event: { contains: query, mode: "insensitive" } },
              { message: { contains: query, mode: "insensitive" } },
              { requestId: { contains: query, mode: "insensitive" } },
            ],
          }
        : {}),
    };
  }

  private async processingStats(since: Date) {
    const [discovered, sent, filtered, failed] = await Promise.all([
      this.prisma.messageReceipt.count({
        where: { createdAt: { gte: since } },
      }),
      this.prisma.messageReceipt.count({
        where: { state: "SENT", completedAt: { gte: since } },
      }),
      this.prisma.messageReceipt.count({
        where: { state: "FILTERED", completedAt: { gte: since } },
      }),
      this.prisma.messageReceipt.count({
        where: {
          state: { in: ["FAILED_CONFIRMED", "UNCERTAIN"] },
          completedAt: { gte: since },
        },
      }),
    ]);
    return { discovered, sent, filtered, failed };
  }

  private processingLogWhere(input: {
    status?: string;
    mailboxId?: string;
    sender?: string;
    subject?: string;
    fromRaw?: string;
    toRaw?: string;
  }): Prisma.ProcessingLogWhereInput {
    const from = this.optionalDate(input.fromRaw, false);
    const to = this.optionalDate(input.toRaw, true);
    const sender = input.sender?.trim().slice(0, 320);
    const subject = input.subject?.trim().slice(0, 200);
    if (
      input.status &&
      ![
        "DISCOVERED",
        "FILTERED",
        "QUEUED",
        "CREATING_DRAFT",
        "DRAFT_READY",
        "SENDING",
        "SENT",
        "FAILED_CONFIRMED",
        "UNCERTAIN",
      ].includes(input.status)
    )
      throw new AppError("LOG_STATUS_INVALID", "处理日志状态筛选无效", 400);
    return {
      ...(input.status ? { status: input.status as never } : {}),
      ...(input.mailboxId ? { mailboxId: input.mailboxId } : {}),
      ...(sender
        ? { senderEmail: { contains: sender, mode: "insensitive" } }
        : {}),
      ...(subject
        ? { subject: { contains: subject, mode: "insensitive" } }
        : {}),
      ...(from || to
        ? {
            occurredAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
    };
  }

  private optionalDate(value: string | undefined, endOfDay: boolean) {
    if (!value) return undefined;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? new Date(`${value}${endOfDay ? "T23:59:59.999" : "T00:00:00.000"}`)
      : new Date(value);
    if (!Number.isFinite(date.getTime()))
      throw new AppError("DATE_FILTER_INVALID", "日志日期筛选无效", 400);
    return date;
  }

  private safeSpreadsheetCell(value: unknown): string {
    const text = String(value ?? "");
    // CSV exports are often opened directly in Excel/LibreOffice. Prefix
    // formula-looking user-controlled values (including leading whitespace
    // and control characters) so they remain inert text.
    return /^\s*[=+\-@]/.test(text) ? `'${text}` : text;
  }

  private positiveInt(value: string, fallback: number, max: number): number {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed)
      ? Math.min(max, Math.max(1, parsed))
      : fallback;
  }
}
