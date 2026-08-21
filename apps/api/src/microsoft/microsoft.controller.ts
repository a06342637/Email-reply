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
} from "@nestjs/common";
import type { Request, Response } from "express";
import {
  MicrosoftAppDto,
  MicrosoftConfigDto,
  MicrosoftRefreshTokenImportDto,
  OAuthStartDto,
  PublicUrlDto,
} from "./microsoft.dto.js";
import { MicrosoftService } from "./microsoft.service.js";
import { AuditService } from "../core/audit.js";

@Controller("api/v1/microsoft")
export class MicrosoftController {
  constructor(
    private readonly microsoft: MicrosoftService,
    private readonly audit: AuditService,
  ) {}

  @Get("config")
  getConfig(@Req() req: Request) {
    return this.microsoft.getConfig(req);
  }

  @Patch("config")
  async saveConfig(@Body() body: MicrosoftConfigDto, @Req() req: Request) {
    const result = await this.microsoft.saveConfig(body);
    await this.audit.write("MICROSOFT_CONFIG_UPDATED", req, undefined, {
      clientId: body.clientId,
      secretReplaced: Boolean(body.clientSecret),
    });
    return result;
  }

  @Post("apps")
  async createApp(@Body() body: MicrosoftAppDto, @Req() req: Request) {
    const result = await this.microsoft.createApp(body);
    await this.audit.write(
      "MICROSOFT_APP_CREATED",
      req,
      { type: "MicrosoftAppConfig", id: result.id },
      { name: result.name, clientId: result.clientId },
    );
    return result;
  }

  @Patch("apps/:id")
  async updateApp(
    @Param("id") id: string,
    @Body() body: MicrosoftAppDto,
    @Req() req: Request,
  ) {
    const result = await this.microsoft.updateApp(id, body);
    await this.audit.write(
      "MICROSOFT_APP_UPDATED",
      req,
      { type: "MicrosoftAppConfig", id },
      {
        name: result.name,
        clientId: result.clientId,
        secretReplaced: Boolean(body.clientSecret),
      },
    );
    return result;
  }

  @Delete("apps/:id")
  async deleteApp(@Param("id") id: string, @Req() req: Request) {
    const result = await this.microsoft.deleteApp(id);
    await this.audit.write(
      "MICROSOFT_APP_DELETED",
      req,
      { type: "MicrosoftAppConfig", id },
      result,
    );
    return { ok: true };
  }

  @Patch("public-url")
  async publicUrl(@Body() body: PublicUrlDto, @Req() req: Request) {
    await this.microsoft.setPublicUrl(body.publicUrl);
    await this.audit.write("PUBLIC_URL_UPDATED", req, undefined, {
      publicUrl: body.publicUrl,
    });
    return { publicUrl: body.publicUrl };
  }

  @Post("oauth/start")
  async start(@Body() body: OAuthStartDto, @Req() req: Request) {
    const result = await this.microsoft.startOAuth(
      body.appConfigId,
      body.redirectAfter,
      req,
    );
    await this.audit.write("MICROSOFT_OAUTH_STARTED", req, undefined, {
      appConfigId: body.appConfigId,
    });
    return result;
  }

  @Post("import-refresh-token")
  async importRefreshToken(
    @Body() body: MicrosoftRefreshTokenImportDto,
    @Req() req: Request,
  ) {
    const result = await this.microsoft.importRefreshToken(body, {
      requestId: req.requestId,
    });
    await this.audit.write(
      "MICROSOFT_REFRESH_TOKEN_IMPORTED",
      req,
      { type: "Mailbox", id: result.mailboxId },
      {
        appConfigId: body.appConfigId,
        clientId: body.clientId,
        email: result.email,
        authMode: result.authMode,
      },
    );
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
    const publicUrl = await this.microsoft.publicUrl(req);
    const fallbackUrl = publicUrl || "/";
    if (error || !code || !state) {
      await this.audit
        .write("MICROSOFT_OAUTH_FAILED", req, undefined, {
          providerError: (error || "MISSING_CODE_OR_STATE").slice(0, 100),
        })
        .catch(() => undefined);
      const reason = encodeURIComponent(
        (description || error || "Microsoft authorization failed").slice(
          0,
          300,
        ),
      );
      return res.redirect(
        `${fallbackUrl.replace(/\/$/, "")}/mailboxes?oauth=error&provider=microsoft&reason=${reason}`,
      );
    }
    try {
      const result = await this.microsoft.finishOAuth(code, state, req);
      await this.audit
        .write("MICROSOFT_MAILBOX_CONNECTED", req, {
          type: "Mailbox",
          id: result.mailboxId,
        })
        .catch(() => undefined);
      return res.redirect(
        `${publicUrl}${result.redirectTo}?oauth=success&provider=microsoft&mailbox=${encodeURIComponent(result.mailboxId)}`,
      );
    } catch (caught) {
      await this.audit
        .write("MICROSOFT_OAUTH_FAILED", req, undefined, {
          error:
            caught instanceof Error
              ? caught.name.slice(0, 100)
              : "UNKNOWN_ERROR",
        })
        .catch(() => undefined);
      const reason = encodeURIComponent(
        caught instanceof Error
          ? caught.message.slice(0, 300)
          : "Microsoft authorization failed",
      );
      return res.redirect(
        `${publicUrl}/mailboxes?oauth=error&provider=microsoft&reason=${reason}`,
      );
    }
  }
}
