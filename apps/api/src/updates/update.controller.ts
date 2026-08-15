import { Body, Controller, Get, HttpCode, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { AuditService } from "../core/audit.js";
import { ApplyUpdateDto } from "./update.dto.js";
import { UpdateService } from "./update.service.js";

@Controller("api/v1/update")
export class UpdateController {
  constructor(
    private readonly updates: UpdateService,
    private readonly audit: AuditService,
  ) {}

  @Get("status")
  status() {
    return this.updates.status();
  }

  @Post("check")
  @HttpCode(200)
  async check(@Req() req: Request) {
    const result = await this.updates.check();
    await this.audit.write("SYSTEM_UPDATE_CHECKED", req, undefined, {
      latestVersion: result.latestVersion,
      updateAvailable: result.updateAvailable,
    });
    return result;
  }

  @Post("apply")
  @HttpCode(202)
  async apply(@Body() body: ApplyUpdateDto, @Req() req: Request) {
    await this.audit.write("SYSTEM_UPDATE_REQUESTED", req, undefined, {
      targetVersion: body.targetVersion,
    });
    return this.updates.apply(body);
  }
}
