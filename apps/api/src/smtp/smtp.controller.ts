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
import { AuditService } from "../core/audit.js";
import {
  CreateSmtpConfigDto,
  TestSmtpConfigDto,
  UpdateSmtpConfigDto,
} from "./smtp.dto.js";
import { SmtpConfigService } from "./smtp-config.service.js";
import { SmtpDeliveryService } from "./smtp-delivery.service.js";

@Controller("api/v1/smtp")
export class SmtpController {
  constructor(
    private readonly configs: SmtpConfigService,
    private readonly delivery: SmtpDeliveryService,
    private readonly audit: AuditService,
  ) {}

  @Get("configs")
  list() {
    return this.configs.list();
  }

  @Post("configs")
  async create(@Body() body: CreateSmtpConfigDto, @Req() req: Request) {
    const row = await this.configs.create(body);
    await this.audit.write("SMTP_CONFIG_CREATED", req, {
      type: "SmtpConfig",
      id: row.id,
    });
    return row;
  }

  @Patch("configs/:id")
  async update(
    @Param("id") id: string,
    @Body() body: UpdateSmtpConfigDto,
    @Req() req: Request,
  ) {
    const row = await this.configs.update(id, body);
    await this.audit.write("SMTP_CONFIG_UPDATED", req, {
      type: "SmtpConfig",
      id,
    });
    return row;
  }

  @Delete("configs/:id")
  async remove(@Param("id") id: string, @Req() req: Request) {
    await this.configs.delete(id);
    await this.audit.write("SMTP_CONFIG_DELETED", req, {
      type: "SmtpConfig",
      id,
    });
    return { ok: true };
  }

  @Post("configs/:id/test")
  async test(
    @Param("id") id: string,
    @Body() body: TestSmtpConfigDto,
    @Req() req: Request,
  ) {
    const result = body.recipient
      ? await this.delivery.sendTest(id, body.recipient)
      : await this.delivery.verify(id);
    await this.audit.write("SMTP_CONFIG_TESTED", req, {
      type: "SmtpConfig",
      id,
    });
    return result;
  }
}
