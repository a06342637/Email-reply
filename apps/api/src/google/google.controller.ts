import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { AuditService } from "../core/audit.js";
import {
  GoogleConfigDto,
  GoogleOAuthStartDto,
  GooglePublicUrlDto,
} from "./google.dto.js";
import { GoogleService } from "./google.service.js";

@Controller("api/v1/google")
export class GoogleController {
  constructor(
    private readonly google: GoogleService,
    private readonly audit: AuditService,
  ) {}

  @Get("config")
  getConfig() {
    return this.google.getConfig();
  }

  @Patch("config")
  async saveConfig(@Body() body: GoogleConfigDto, @Req() req: Request) {
    const result = await this.google.saveConfig(body);
    await this.audit.write("GOOGLE_CONFIG_UPDATED", req, undefined, {
      clientId: body.clientId,
      secretReplaced: Boolean(body.clientSecret),
    });
    return result;
  }

  @Patch("public-url")
  async publicUrl(@Body() body: GooglePublicUrlDto, @Req() req: Request) {
    await this.google.setPublicUrl(body.publicUrl);
    await this.audit.write("PUBLIC_URL_UPDATED", req, undefined, {
      publicUrl: body.publicUrl,
    });
    return { publicUrl: body.publicUrl };
  }

  @Post("oauth/start")
  async start(@Body() body: GoogleOAuthStartDto, @Req() req: Request) {
    const result = await this.google.startOAuth(body.redirectAfter);
    await this.audit.write("GOOGLE_OAUTH_STARTED", req);
    return result;
  }

  @Get("oauth/callback")
  async callback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Query("error") error: string | undefined,
    @Query("error_description") description: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const publicUrl = await this.google.publicUrl();
    const fallbackUrl = publicUrl || "/";
    if (error || !code || !state) {
      await this.audit
        .write("GOOGLE_OAUTH_FAILED", req, undefined, {
          providerError: (error || "MISSING_CODE_OR_STATE").slice(0, 100),
        })
        .catch(() => undefined);
      const reason = encodeURIComponent(
        (description || error || "Google authorization failed").slice(0, 300),
      );
      return res.redirect(
        `${fallbackUrl.replace(/\/$/, "")}/mailboxes?oauth=error&provider=google&reason=${reason}`,
      );
    }
    try {
      const result = await this.google.finishOAuth(code, state);
      await this.audit
        .write("GOOGLE_MAILBOX_CONNECTED", req, {
          type: "Mailbox",
          id: result.mailboxId,
        })
        .catch(() => undefined);
      return res.redirect(
        `${publicUrl}${result.redirectTo}?oauth=success&provider=google&mailbox=${encodeURIComponent(result.mailboxId)}`,
      );
    } catch (caught) {
      await this.audit
        .write("GOOGLE_OAUTH_FAILED", req, undefined, {
          error:
            caught instanceof Error
              ? caught.name.slice(0, 100)
              : "UNKNOWN_ERROR",
        })
        .catch(() => undefined);
      const reason = encodeURIComponent(
        caught instanceof Error
          ? caught.message.slice(0, 300)
          : "Google authorization failed",
      );
      return res.redirect(
        `${publicUrl}/mailboxes?oauth=error&provider=google&reason=${reason}`,
      );
    }
  }
}
