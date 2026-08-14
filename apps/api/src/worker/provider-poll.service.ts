import { Injectable } from "@nestjs/common";
import { PrismaService } from "../core/prisma.js";
import { DeltaService } from "./delta.service.js";
import { GmailPollService } from "./gmail-poll.service.js";

@Injectable()
export class ProviderPollService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly microsoft: DeltaService,
    private readonly google: GmailPollService,
  ) {}

  async pollTask(taskId: string): Promise<void> {
    const task = await this.prisma.autoReplyTask.findUnique({
      where: { id: taskId },
      select: { mailbox: { select: { provider: true } } },
    });
    if (!task) return;
    if (task.mailbox.provider === "GOOGLE") return this.google.pollTask(taskId);
    return this.microsoft.pollTask(taskId);
  }
}
