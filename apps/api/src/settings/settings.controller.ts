import { Body, Controller, Get, Patch, Req } from "@nestjs/common";
import type { Request } from "express";
import { SettingsService } from "./settings.service.js";
import { UpdateSettingsDto } from "./settings.dto.js";
import { AuditService } from "../core/audit.js";

@Controller("api/v1")
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  @Get("settings") get() {
    return this.settings.get();
  }

  @Patch("settings")
  async update(@Body() body: UpdateSettingsDto, @Req() req: Request) {
    const result = await this.settings.update(
      body as unknown as Record<string, unknown>,
    );
    await this.audit.write("SETTINGS_UPDATED", req, undefined, {
      keys: Object.keys(body),
    });
    return result;
  }

  @Get("system/info") info() {
    return this.settings.systemInfo();
  }
}
