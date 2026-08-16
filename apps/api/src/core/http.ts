import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
  NestMiddleware,
} from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { PrismaService } from "./prisma.js";
import { ProviderApiError } from "../providers/provider-api.error.js";

const SENSITIVE_KEY =
  /password|passphrase|secret|token|authorization|cookie|code/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[TRUNCATED]";
  if (Array.isArray(value))
    return value.slice(0, 50).map((item) => redact(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 100)
      .map(([key, item]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(item, depth + 1),
      ]),
  );
}

export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = HttpStatus.BAD_REQUEST,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.header("x-request-id");
    req.requestId = incoming?.slice(0, 128) || randomUUID();
    res.setHeader("x-request-id", req.requestId);
    next();
  }
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(private readonly prisma?: PrismaService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<Request>();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = "INTERNAL_ERROR";
    let message = "服务器内部错误";
    let details: unknown;

    if (exception instanceof AppError) {
      status = exception.status;
      code = exception.code;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof ProviderApiError) {
      const suspended =
        exception.provider === "MICROSOFT" &&
        /ErrorAccountSuspend|Account suspended|verdict is Suspend/i.test(
          `${exception.code} ${exception.message}`,
        );
      status =
        exception.status === 429
          ? 429
          : suspended || (exception.status >= 400 && exception.status < 500)
            ? 409
            : 502;
      code = suspended ? "MICROSOFT_ACCOUNT_SUSPENDED" : exception.code;
      message = suspended
        ? "Microsoft 已暂停此邮箱的发信能力。请登录 Outlook 网页版，按收件箱中的提示验证账户或解除限制后再测试；也可以为任务改用 SMTP 发件。"
        : exception.message.replace(/[\r\n]+/g, " ").slice(0, 1_000);
      details = {
        provider: exception.provider,
        providerStatus: exception.status || undefined,
        retryAfterSeconds: exception.retryAfterSeconds,
      };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code =
        status === 401
          ? "UNAUTHORIZED"
          : status === 403
            ? "FORBIDDEN"
            : "HTTP_ERROR";
      const body = exception.getResponse();
      message =
        typeof body === "string"
          ? body
          : String(
              (body as { message?: unknown }).message ?? exception.message,
            );
    } else if (
      exception instanceof Prisma.PrismaClientKnownRequestError &&
      exception.code === "P2025"
    ) {
      status = HttpStatus.NOT_FOUND;
      code = "NOT_FOUND";
      message = "请求的记录不存在";
    } else if (
      exception instanceof Prisma.PrismaClientKnownRequestError &&
      ["P2002", "P2003"].includes(exception.code)
    ) {
      status = HttpStatus.CONFLICT;
      code =
        exception.code === "P2002" ? "UNIQUE_CONFLICT" : "RELATION_CONFLICT";
      message =
        exception.code === "P2002"
          ? "存在重复记录，无法完成操作"
          : "记录仍被其他数据引用，无法完成操作";
    } else if (
      typeof exception === "object" &&
      exception &&
      "type" in exception &&
      (exception as { type?: unknown }).type === "entity.parse.failed"
    ) {
      status = HttpStatus.BAD_REQUEST;
      code = "INVALID_JSON";
      message = "请求 JSON 格式无效";
    } else if (
      typeof exception === "object" &&
      exception &&
      (("type" in exception &&
        (exception as { type?: unknown }).type === "entity.too.large") ||
        ("status" in exception &&
          (exception as { status?: unknown }).status === 413))
    ) {
      status = HttpStatus.PAYLOAD_TOO_LARGE;
      code = "PAYLOAD_TOO_LARGE";
      message = "请求内容超过允许大小";
    } else if (
      typeof exception === "object" &&
      exception &&
      "code" in exception &&
      (exception as { code?: unknown }).code === "LIMIT_FILE_SIZE"
    ) {
      status = HttpStatus.PAYLOAD_TOO_LARGE;
      code = "FILE_TOO_LARGE";
      message = "上传文件超过允许大小";
    } else if (exception instanceof Error) {
      console.error(
        `[${request.requestId}]`,
        exception.stack ?? exception.message,
      );
      void this.prisma?.systemLog
        .create({
          data: {
            level: "ERROR",
            component: "http",
            event: "UNHANDLED_EXCEPTION",
            message: exception.message.slice(0, 1_000),
            requestId: request.requestId,
            metadata: redact({
              method: request.method,
              path: request.path,
              query: request.query,
            }) as never,
          },
        })
        .catch(() => undefined);
    }

    response.status(status).json({
      error: {
        code,
        message,
        requestId: request.requestId,
        ...(details === undefined ? {} : { details }),
      },
    });
  }
}
