import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
} from "@nestjs/common";
import type { Request } from "express";
import { MailboxService } from "./mailbox.service.js";
import {
  CreateTaskDto,
  ReplaceRulesDto,
  UpdateTaskDto,
} from "./mailbox.dto.js";
import { AuditService } from "../core/audit.js";

@Controller("api/v1")
export class MailboxController {
  constructor(
    private readonly mailboxes: MailboxService,
    private readonly audit: AuditService,
  ) {}

  @Get("mailboxes")
  list() {
    return this.mailboxes.list();
  }

  @Post("mailboxes/:id/disable")
  async disable(@Param("id") id: string, @Req() req: Request) {
    await this.mailboxes.disable(id);
    await this.audit.write("MAILBOX_DISABLED", req, { type: "Mailbox", id });
    return { ok: true };
  }

  @Post("mailboxes/:id/enable")
  async enable(@Param("id") id: string, @Req() req: Request) {
    await this.mailboxes.enable(id);
    await this.audit.write("MAILBOX_ENABLED", req, { type: "Mailbox", id });
    return { ok: true };
  }

  @Delete("mailboxes/:id")
  async remove(@Param("id") id: string, @Req() req: Request) {
    await this.mailboxes.remove(id);
    await this.audit.write("MAILBOX_REMOVED", req, { type: "Mailbox", id });
    return { ok: true };
  }

  @Post("mailboxes/:mailboxId/task")
  async createTask(
    @Param("mailboxId") mailboxId: string,
    @Body() body: CreateTaskDto,
    @Req() req: Request,
  ) {
    const task = await this.mailboxes.createTask(mailboxId, body);
    await this.audit.write("TASK_CREATED", req, {
      type: "AutoReplyTask",
      id: task.id,
    });
    return task;
  }

  @Patch("tasks/:id")
  async updateTask(
    @Param("id") id: string,
    @Body() body: UpdateTaskDto,
    @Req() req: Request,
  ) {
    const task = await this.mailboxes.updateTask(id, body);
    await this.audit.write("TASK_UPDATED", req, { type: "AutoReplyTask", id });
    return task;
  }

  @Post("tasks/:id/start")
  async start(@Param("id") id: string, @Req() req: Request) {
    const task = await this.mailboxes.startTask(id);
    await this.audit.write("TASK_STARTED", req, { type: "AutoReplyTask", id });
    return task;
  }

  @Post("tasks/:id/pause")
  async pause(@Param("id") id: string, @Req() req: Request) {
    const task = await this.mailboxes.pauseTask(id);
    await this.audit.write("TASK_PAUSED", req, { type: "AutoReplyTask", id });
    return task;
  }

  @Post("tasks/:id/resume")
  async resume(@Param("id") id: string, @Req() req: Request) {
    const task = await this.mailboxes.resumeTask(id);
    await this.audit.write("TASK_RESUMED", req, { type: "AutoReplyTask", id });
    return task;
  }

  @Delete("tasks/:id")
  async deleteTask(@Param("id") id: string, @Req() req: Request) {
    await this.mailboxes.deleteTask(id);
    await this.audit.write("TASK_DELETED", req, { type: "AutoReplyTask", id });
    return { ok: true };
  }

  @Patch("tasks/:id/rules")
  async rules(
    @Param("id") id: string,
    @Body() body: ReplaceRulesDto,
    @Req() req: Request,
  ) {
    const rules = await this.mailboxes.replaceRules(id, body.rules);
    await this.audit.write(
      "TASK_RULES_REPLACED",
      req,
      { type: "AutoReplyTask", id },
      { count: body.rules.length },
    );
    return rules;
  }
}
