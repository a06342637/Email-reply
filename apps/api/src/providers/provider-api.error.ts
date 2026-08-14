import type { MailProvider } from "@prisma/client";

export class ProviderApiError extends Error {
  constructor(
    readonly provider: MailProvider,
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
    readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = `${provider}ApiError`;
  }
}
