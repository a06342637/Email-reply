import { Body, Controller, Get, Patch, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import {
  LoginDto,
  ChangePasswordDto,
  DisableTotpDto,
  TotpCodeDto,
  ThemeDto,
} from "./auth.dto.js";
import { AuthService } from "./auth.service.js";
import { PrismaService } from "../core/prisma.js";
import { AuditService } from "../core/audit.js";

@Controller("api/v1/auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Post("login")
  async login(
    @Body() body: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(
      body.username,
      body.password,
      body.totpCode,
      req,
      res,
    );
    await this.audit.write(
      "AUTH_LOGIN",
      req,
      {
        type: "AdminUser",
        id: result.admin.id,
      },
      undefined,
      result.admin.id,
    );
    return result;
  }

  @Post("logout")
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.audit.write("AUTH_LOGOUT", req);
    await this.auth.logout(req, res);
    return { ok: true };
  }

  @Get("me")
  async me(@Req() req: Request) {
    const totp = await this.prisma.totpCredential.findUnique({
      where: { adminId: req.auth!.admin.id },
    });
    return {
      admin: {
        ...this.auth.publicAdmin(req.auth!.admin),
        totpEnabled: Boolean(totp),
      },
      totpEnabled: Boolean(totp),
    };
  }

  @Post("password")
  async changePassword(@Body() body: ChangePasswordDto, @Req() req: Request) {
    await this.auth.changePassword(
      req.auth!.admin.id,
      body.currentPassword,
      body.newPassword,
    );
    return { ok: true, reloginRequired: true };
  }

  @Post("totp/setup")
  async setupTotp(@Req() req: Request) {
    return this.auth.beginTotp(req.auth!.admin.id, req.auth!.admin.username);
  }

  @Post("totp/confirm")
  async confirmTotp(@Body() body: TotpCodeDto, @Req() req: Request) {
    const result = await this.auth.confirmTotp(
      req.auth!.admin.id,
      req.auth!.session.id,
      body.code,
    );
    await this.audit.write("AUTH_TOTP_ENABLED", req);
    return result;
  }

  @Post("totp/disable")
  async disableTotp(@Body() body: DisableTotpDto, @Req() req: Request) {
    await this.auth.disableTotp(req.auth!.admin.id, body.password);
    await this.audit.write("AUTH_TOTP_DISABLED", req);
    return { ok: true };
  }

  @Patch("theme")
  async theme(@Body() body: ThemeDto, @Req() req: Request) {
    await this.prisma.adminUser.update({
      where: { id: req.auth!.admin.id },
      data: { theme: body.theme },
    });
    return { theme: body.theme };
  }
}
