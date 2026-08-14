import { Injectable } from "@nestjs/common";
import { hash, verify } from "@node-rs/argon2";
import { authenticator } from "otplib";
import { nanoid } from "nanoid";
import type { Request, Response } from "express";
import { AppError } from "../core/http.js";
import { PrismaService } from "../core/prisma.js";
import { CryptoService } from "../core/crypto.js";
import { AppConfig } from "../core/config.js";

const SESSION_COOKIE = "autoreply_session";
const CSRF_COOKIE = "autoreply_csrf";

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: AppConfig,
  ) {}

  async hashPassword(password: string): Promise<string> {
    return hash(password, {
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
      outputLen: 32,
    });
  }

  async login(
    username: string,
    password: string,
    totpCode: string | undefined,
    req: Request,
    res: Response,
  ): Promise<{
    admin: ReturnType<AuthService["publicAdmin"]> & { totpEnabled: boolean };
    csrfToken: string;
  }> {
    const admin = await this.prisma.adminUser.findUnique({
      where: { username },
    });
    const now = new Date();
    if (!admin || (admin.lockedUntil && admin.lockedUntil > now)) {
      await this.auditLoginFailure(
        req,
        admin?.id,
        admin?.lockedUntil && admin.lockedUntil > now
          ? "ACCOUNT_LOCKED"
          : "UNKNOWN_USERNAME",
      );
      throw new AppError(
        "INVALID_CREDENTIALS",
        "用户名、密码或验证码错误",
        401,
      );
    }

    const valid = await verify(admin.passwordHash, password).catch(() => false);
    if (!valid) {
      const failures = admin.failedLoginCount + 1;
      await this.prisma.adminUser.update({
        where: { id: admin.id },
        data: {
          failedLoginCount: failures >= 5 ? 0 : failures,
          lockedUntil:
            failures >= 5 ? new Date(Date.now() + 15 * 60_000) : null,
        },
      });
      await this.auditLoginFailure(req, admin.id, "INVALID_PASSWORD", {
        locked: failures >= 5,
      });
      throw new AppError(
        "INVALID_CREDENTIALS",
        "用户名、密码或验证码错误",
        401,
      );
    }

    const totp = await this.prisma.totpCredential.findUnique({
      where: { adminId: admin.id },
    });
    if (totp) {
      if (!totpCode) {
        await this.auditLoginFailure(req, admin.id, "TOTP_REQUIRED");
        throw new AppError("TOTP_REQUIRED", "请输入双重验证代码", 401);
      }
      const secret = await this.crypto.decryptString(
        totp.secretEncrypted,
        `totp:${admin.id}`,
      );
      let totpValid = authenticator.check(totpCode.replace(/\s/g, ""), secret);
      if (!totpValid) {
        const hashes = totp.recoveryCodeHashes as string[];
        const match = hashes.find((item) =>
          this.crypto.safeEqual(
            item,
            this.crypto.hmac(totpCode.trim().toUpperCase()),
          ),
        );
        if (match) {
          totpValid = true;
          await this.prisma.totpCredential.update({
            where: { adminId: admin.id },
            data: {
              recoveryCodeHashes: hashes.filter((item) => item !== match),
            },
          });
        }
      }
      if (!totpValid) {
        const failures = admin.failedLoginCount + 1;
        await this.prisma.adminUser.update({
          where: { id: admin.id },
          data: {
            failedLoginCount: failures >= 5 ? 0 : failures,
            lockedUntil:
              failures >= 5 ? new Date(Date.now() + 15 * 60_000) : null,
          },
        });
        await this.auditLoginFailure(req, admin.id, "INVALID_TOTP");
        throw new AppError(
          "INVALID_CREDENTIALS",
          "用户名、密码或验证码错误",
          401,
        );
      }
    }

    await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: { failedLoginCount: 0, lockedUntil: null },
    });
    const { rawToken, csrfToken, absoluteMs } = await this.createSession(
      admin.id,
      req,
    );
    this.setCookies(req, res, rawToken, csrfToken, absoluteMs);
    return {
      admin: { ...this.publicAdmin(admin), totpEnabled: Boolean(totp) },
      csrfToken,
    };
  }

  async authenticate(req: Request): Promise<void> {
    const raw = req.cookies?.[SESSION_COOKIE] as string | undefined;
    if (!raw) throw new AppError("UNAUTHORIZED", "请先登录", 401);
    const session = await this.prisma.adminSession.findUnique({
      where: { tokenHash: this.crypto.hmac(raw) },
      include: { admin: true },
    });
    const now = Date.now();
    if (
      !session ||
      session.expiresAt.getTime() < now ||
      session.absoluteExpiresAt.getTime() < now
    ) {
      if (session)
        await this.prisma.adminSession.delete({ where: { id: session.id } });
      throw new AppError("SESSION_EXPIRED", "登录会话已过期", 401);
    }
    req.auth = { admin: session.admin, session };
    const { idleMs } = await this.sessionDurations();
    if (now - session.lastSeenAt.getTime() > 5 * 60_000) {
      await this.prisma.adminSession.update({
        where: { id: session.id },
        data: {
          lastSeenAt: new Date(),
          expiresAt: new Date(
            Math.min(now + idleMs, session.absoluteExpiresAt.getTime()),
          ),
        },
      });
    }
  }

  verifyCsrf(req: Request): void {
    const provided = req.header("x-csrf-token");
    const cookie = req.cookies?.[CSRF_COOKIE] as string | undefined;
    if (!req.auth || !provided || !cookie || provided !== cookie) {
      throw new AppError(
        "CSRF_INVALID",
        "请求安全令牌无效，请刷新页面重试",
        403,
      );
    }
    if (
      !this.crypto.safeEqual(
        req.auth.session.csrfHash,
        this.crypto.hmac(provided),
      )
    ) {
      throw new AppError(
        "CSRF_INVALID",
        "请求安全令牌无效，请刷新页面重试",
        403,
      );
    }
  }

  async logout(req: Request, res: Response): Promise<void> {
    if (req.auth)
      await this.prisma.adminSession
        .delete({ where: { id: req.auth.session.id } })
        .catch(() => undefined);
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.clearCookie(CSRF_COOKIE, { path: "/" });
  }

  async changePassword(
    adminId: string,
    current: string,
    next: string,
  ): Promise<void> {
    const admin = await this.prisma.adminUser.findUniqueOrThrow({
      where: { id: adminId },
    });
    if (!(await verify(admin.passwordHash, current).catch(() => false))) {
      throw new AppError("CURRENT_PASSWORD_INVALID", "当前密码错误", 400);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.adminUser.update({
        where: { id: adminId },
        data: {
          passwordHash: await this.hashPassword(next),
          mustChangePassword: false,
        },
      });
      await tx.adminSession.deleteMany({ where: { adminId } });
      await tx.auditLog.create({
        data: { adminId, action: "AUTH_PASSWORD_CHANGED" },
      });
    });
  }

  async beginTotp(
    adminId: string,
    username: string,
  ): Promise<{ uri: string; secret: string }> {
    const secret = authenticator.generateSecret();
    const encrypted = await this.crypto.encryptString(
      secret,
      `totp-pending:${adminId}`,
    );
    await this.prisma.adminSession.updateMany({
      where: { adminId },
      data: { pendingTotpEncrypted: encrypted },
    });
    return {
      secret,
      uri: authenticator.keyuri(username, "Microsoft Mail AutoReply", secret),
    };
  }

  async confirmTotp(
    adminId: string,
    sessionId: string,
    code: string,
  ): Promise<{ recoveryCodes: string[] }> {
    const session = await this.prisma.adminSession.findUniqueOrThrow({
      where: { id: sessionId },
    });
    if (!session.pendingTotpEncrypted)
      throw new AppError("TOTP_SETUP_MISSING", "请先开始绑定验证器", 400);
    const secret = await this.crypto.decryptString(
      session.pendingTotpEncrypted,
      `totp-pending:${adminId}`,
    );
    if (!authenticator.check(code, secret))
      throw new AppError("TOTP_INVALID", "验证码无效", 400);
    const recoveryCodes = Array.from({ length: 10 }, () =>
      `${nanoid(5)}-${nanoid(5)}`.toUpperCase(),
    );
    await this.prisma.$transaction([
      this.prisma.totpCredential.upsert({
        where: { adminId },
        create: {
          adminId,
          secretEncrypted: await this.crypto.encryptString(
            secret,
            `totp:${adminId}`,
          ),
          recoveryCodeHashes: recoveryCodes.map((codeItem) =>
            this.crypto.hmac(codeItem),
          ),
        },
        update: {
          secretEncrypted: await this.crypto.encryptString(
            secret,
            `totp:${adminId}`,
          ),
          recoveryCodeHashes: recoveryCodes.map((codeItem) =>
            this.crypto.hmac(codeItem),
          ),
          enabledAt: new Date(),
        },
      }),
      this.prisma.adminSession.updateMany({
        where: { adminId },
        data: { pendingTotpEncrypted: null },
      }),
    ]);
    return { recoveryCodes };
  }

  async disableTotp(adminId: string, password: string): Promise<void> {
    const admin = await this.prisma.adminUser.findUniqueOrThrow({
      where: { id: adminId },
    });
    if (!(await verify(admin.passwordHash, password).catch(() => false))) {
      throw new AppError("CURRENT_PASSWORD_INVALID", "当前密码错误", 400);
    }
    await this.prisma.totpCredential.deleteMany({ where: { adminId } });
  }

  publicAdmin(admin: {
    id: string;
    username: string;
    mustChangePassword: boolean;
    theme: string;
  }) {
    return {
      id: admin.id,
      username: admin.username,
      mustChangePassword: admin.mustChangePassword,
      theme: admin.theme,
    };
  }

  private async createSession(
    adminId: string,
    req: Request,
  ): Promise<{ rawToken: string; csrfToken: string; absoluteMs: number }> {
    const rawToken = this.crypto.randomToken();
    const csrfToken = this.crypto.randomToken();
    const now = Date.now();
    const { idleMs, absoluteMs } = await this.sessionDurations();
    await this.prisma.adminSession.create({
      data: {
        adminId,
        tokenHash: this.crypto.hmac(rawToken),
        csrfHash: this.crypto.hmac(csrfToken),
        ipAddress: req.ip,
        userAgent: req.header("user-agent")?.slice(0, 512),
        expiresAt: new Date(now + idleMs),
        absoluteExpiresAt: new Date(now + absoluteMs),
      },
    });
    return { rawToken, csrfToken, absoluteMs };
  }

  private setCookies(
    req: Request,
    res: Response,
    rawToken: string,
    csrfToken: string,
    maxAge: number,
  ): void {
    const secure =
      req.secure ||
      req.header("x-forwarded-proto")?.split(",")[0]?.trim() === "https" ||
      this.config.publicUrl.startsWith("https://");
    res.cookie(SESSION_COOKIE, rawToken, {
      httpOnly: true,
      secure,
      sameSite: "lax",
      path: "/",
      maxAge,
    });
    res.cookie(CSRF_COOKIE, csrfToken, {
      httpOnly: false,
      secure,
      sameSite: "lax",
      path: "/",
      maxAge,
    });
  }

  private async sessionDurations(): Promise<{
    idleMs: number;
    absoluteMs: number;
  }> {
    const rows = await this.prisma.systemSetting.findMany({
      where: { key: { in: ["sessionIdleMinutes", "sessionAbsoluteMinutes"] } },
    });
    const values = new Map(rows.map((item) => [item.key, Number(item.value)]));
    const idle = Math.min(
      1_440,
      Math.max(5, values.get("sessionIdleMinutes") || 120),
    );
    const absolute = Math.max(
      idle,
      Math.min(
        10_080,
        Math.max(10, values.get("sessionAbsoluteMinutes") || 720),
      ),
    );
    return { idleMs: idle * 60_000, absoluteMs: absolute * 60_000 };
  }

  private async auditLoginFailure(
    req: Request,
    adminId: string | undefined,
    reason: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditLog
      .create({
        data: {
          adminId,
          action: "AUTH_LOGIN_FAILED",
          entityType: "AdminUser",
          entityId: adminId,
          ipAddress: req.ip,
          requestId: req.requestId,
          metadata: { reason, ...metadata },
        },
      })
      .catch(() => undefined);
  }
}
