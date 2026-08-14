import { Injectable } from "@nestjs/common";
import { domainToASCII } from "node:url";
import { PrismaService } from "../core/prisma.js";
import type { RuleConditions } from "@autoreply/shared";

export type IncomingMessage = {
  id: string;
  internetMessageId?: string | null;
  conversationId?: string | null;
  subject?: string | null;
  receivedDateTime: string;
  sender?: { emailAddress?: { name?: string; address?: string } };
  from?: { emailAddress?: { name?: string; address?: string } };
  replyTo?: Array<{ emailAddress?: { name?: string; address?: string } }>;
  internetMessageHeaders?: Array<{ name: string; value: string }>;
  "@removed"?: { reason?: string };
};

/** @deprecated Use IncomingMessage. Kept for legacy source compatibility. */
export type IncomingGraphMessage = IncomingMessage;

const MICROSOFT_CORE_DOMAINS = [
  "microsoft.com",
  "microsoftonline.com",
  "microsoftsupport.com",
  "accountprotection.microsoft.com",
  "office.com",
  "office365.com",
  "azure.com",
  "windows.com",
  "xbox.com",
];

@Injectable()
export class FilterService {
  constructor(private readonly prisma: PrismaService) {}

  async evaluate(
    message: IncomingMessage,
    mailboxEmail: string,
  ): Promise<{
    skip?: string;
    senderName: string;
    senderEmail: string;
    replyToEmail: string;
  }> {
    const sender = message.from?.emailAddress ?? message.sender?.emailAddress;
    const senderEmail = this.normalizeEmail(sender?.address ?? "");
    const senderName = (sender?.name ?? "").trim();
    const explicitReplyTo = message.replyTo?.[0]?.emailAddress;
    const replyToEmail = this.normalizeEmail(
      explicitReplyTo?.address ?? sender?.address ?? "",
    );
    if (!senderEmail || !this.validEmail(senderEmail))
      return {
        skip: "INVALID_OR_MISSING_SENDER",
        senderName,
        senderEmail,
        replyToEmail,
      };
    if (!replyToEmail || !this.validEmail(replyToEmail))
      return {
        skip: "INVALID_REPLY_ADDRESS",
        senderName,
        senderEmail,
        replyToEmail,
      };

    const safetyContext = await this.safetyContext();
    if (
      safetyContext.connectedAddresses.has(senderEmail) ||
      senderEmail === this.normalizeEmail(mailboxEmail)
    ) {
      return {
        skip: "CONNECTED_MAILBOX_SENDER",
        senderName,
        senderEmail,
        replyToEmail,
      };
    }
    if (safetyContext.connectedAddresses.has(replyToEmail)) {
      return {
        skip: "CONNECTED_MAILBOX_REPLY_TARGET",
        senderName,
        senderEmail,
        replyToEmail,
      };
    }

    const headers = this.headers(message);
    if (
      headers.has("x-autoreply-instance") ||
      headers.has("x-autoreply-tracking")
    )
      return {
        skip: "SYSTEM_GENERATED_REPLY",
        senderName,
        senderEmail,
        replyToEmail,
      };
    const autoSubmitted = headers.get("auto-submitted")?.trim().toLowerCase();
    if (autoSubmitted && autoSubmitted !== "no")
      return {
        skip: "AUTO_SUBMITTED",
        senderName,
        senderEmail,
        replyToEmail,
      };
    const suppress = headers
      .get("x-auto-response-suppress")
      ?.trim()
      .toLowerCase();
    if (suppress && !["none", "no"].includes(suppress))
      return {
        skip: "AUTO_RESPONSE_SUPPRESSED",
        senderName,
        senderEmail,
        replyToEmail,
      };
    const returnPath = headers.get("return-path")?.trim();
    if (returnPath === "<>" || returnPath === "")
      return {
        skip: "EMPTY_RETURN_PATH",
        senderName,
        senderEmail,
        replyToEmail,
      };

    const contentType = headers.get("content-type")?.toLowerCase() ?? "";
    const subject = (message.subject ?? "").toLowerCase();
    if (
      contentType.includes("multipart/report") ||
      contentType.includes("message/delivery-status") ||
      /^(mailer-daemon|postmaster)@/.test(senderEmail) ||
      /undeliverable|delivery status notification|returned mail|mail delivery failed|无法送达|投递失败|传递状态通知/i.test(
        subject,
      )
    )
      return {
        skip: "DELIVERY_REPORT",
        senderName,
        senderEmail,
        replyToEmail,
      };
    if (
      headers.has("disposition-notification-to") ||
      headers.has("return-receipt-to") ||
      headers.has("original-recipient") ||
      headers.has("final-recipient") ||
      headers.has("reporting-mta")
    ) {
      return {
        skip: "READ_RECEIPT",
        senderName,
        senderEmail,
        replyToEmail,
      };
    }

    const domain = this.emailDomain(senderEmail);
    if (
      MICROSOFT_CORE_DOMAINS.some(
        (item) => domain === item || domain.endsWith(`.${item}`),
      )
    ) {
      return {
        skip: "MICROSOFT_SERVICE_DOMAIN",
        senderName,
        senderEmail,
        replyToEmail,
      };
    }

    if (safetyContext.excludedAddresses.has(senderEmail))
      return {
        skip: "CUSTOM_EXCLUDED_ADDRESS",
        senderName,
        senderEmail,
        replyToEmail,
      };
    if (
      safetyContext.excludedDomains.some(
        (item) => domain === item || domain.endsWith(`.${item}`),
      )
    )
      return {
        skip: "CUSTOM_EXCLUDED_DOMAIN",
        senderName,
        senderEmail,
        replyToEmail,
      };
    return { senderName, senderEmail, replyToEmail };
  }

  matchRule(
    message: IncomingMessage,
    senderEmail: string,
    folder: "inbox" | "junkemail",
    conditions: RuleConditions,
  ): boolean {
    const normalizedAddress = this.normalizeEmail(senderEmail);
    const domain = this.emailDomain(normalizedAddress);
    const subject = (message.subject ?? "")
      .normalize("NFKC")
      .toLocaleLowerCase("zh-CN");
    const every = (
      values: string[] | undefined,
      predicate: (normalized: string) => boolean,
    ) =>
      !values?.length ||
      values.some((value) =>
        predicate(value.normalize("NFKC").toLocaleLowerCase("zh-CN").trim()),
      );

    if (conditions.folders?.length && !conditions.folders.includes(folder))
      return false;
    if (
      !every(
        conditions.senderAddresses,
        (value) => this.normalizeEmail(value) === normalizedAddress,
      )
    )
      return false;
    if (
      !every(conditions.senderDomains, (value) => {
        const expected = this.normalizeDomain(value);
        return domain === expected || domain.endsWith(`.${expected}`);
      })
    )
      return false;
    if (!every(conditions.subjectContains, (value) => subject.includes(value)))
      return false;
    if (
      conditions.subjectNotContains?.some((value) =>
        subject.includes(
          value.normalize("NFKC").toLocaleLowerCase("zh-CN").trim(),
        ),
      )
    )
      return false;
    if (
      !every(conditions.subjectPrefixes, (value) => subject.startsWith(value))
    )
      return false;
    return true;
  }

  private headers(message: IncomingMessage): Map<string, string> {
    const map = new Map<string, string>();
    for (const header of message.internetMessageHeaders ?? [])
      map.set(header.name.toLowerCase(), header.value);
    return map;
  }

  private normalizeEmail(value: string): string {
    const trimmed = value
      .trim()
      .replace(/^<|>$/g, "")
      .normalize("NFKC")
      .toLocaleLowerCase("en-US");
    const at = trimmed.lastIndexOf("@");
    if (at < 1) return trimmed;
    return `${trimmed.slice(0, at)}@${this.normalizeDomain(trimmed.slice(at + 1))}`;
  }

  private normalizeDomain(value: string): string {
    return (
      domainToASCII(
        value
          .trim()
          .replace(/^@/, "")
          .replace(/\.$/, "")
          .toLocaleLowerCase("en-US"),
      ) || value.trim().toLocaleLowerCase("en-US")
    );
  }

  private emailDomain(address: string): string {
    return this.normalizeDomain(address.slice(address.lastIndexOf("@") + 1));
  }

  private validEmail(value: string): boolean {
    return /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value);
  }

  private async safetyContext(): Promise<{
    connectedAddresses: Set<string>;
    excludedAddresses: Set<string>;
    excludedDomains: string[];
  }> {
    const [allMailboxes, addressesSetting, domainsSetting] = await Promise.all([
      this.prisma.mailbox.findMany({
        where: { status: { not: "REMOVED" } },
        select: { email: true },
      }),
      this.prisma.systemSetting.findUnique({
        where: { key: "excludedAddresses" },
      }),
      this.prisma.systemSetting.findUnique({
        where: { key: "excludedDomains" },
      }),
    ]);
    return {
      connectedAddresses: new Set(
        allMailboxes.map((item) => this.normalizeEmail(item.email)),
      ),
      excludedAddresses: new Set(
        Array.isArray(addressesSetting?.value)
          ? (addressesSetting.value as string[]).map((item) =>
              this.normalizeEmail(item),
            )
          : [],
      ),
      excludedDomains: Array.isArray(domainsSetting?.value)
        ? (domainsSetting.value as string[]).map((item) =>
            this.normalizeDomain(item),
          )
        : [],
    };
  }
}
