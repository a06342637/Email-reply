import { Injectable, OnApplicationBootstrap } from "@nestjs/common";
import { readFile, unlink } from "node:fs/promises";
import { hash } from "@node-rs/argon2";
import { PrismaService } from "./core/prisma.js";
import { AppConfig } from "./core/config.js";

type BootstrapCredentials = {
  username: string;
  password: string;
  randomUsername?: boolean;
  randomPassword?: boolean;
};

@Injectable()
export class BootstrapService implements OnApplicationBootstrap {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.ensureSettings();
    if (await this.prisma.adminUser.count()) {
      // A crash can happen after the administrator transaction commits but
      // before the bootstrap file is removed.  Never leave reusable plaintext
      // credentials on the persistent volume once an administrator exists.
      await unlink(this.config.bootstrapFile).catch(() => undefined);
      return;
    }
    let credentials: BootstrapCredentials;
    try {
      credentials = JSON.parse(
        await readFile(this.config.bootstrapFile, "utf8"),
      ) as BootstrapCredentials;
    } catch {
      throw new Error(
        `Administrator is not initialized. Run install.sh or provide ${this.config.bootstrapFile}`,
      );
    }
    const passwordHash = await hash(credentials.password, {
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
      outputLen: 32,
    });
    await this.prisma.adminUser.create({
      data: {
        username: credentials.username,
        passwordHash,
        mustChangePassword: Boolean(credentials.randomPassword),
      },
    });
    if (credentials.randomUsername || credentials.randomPassword) {
      console.log(
        "============================================================",
      );
      console.log("MailPilot 首次随机管理员凭据（仅显示本次）");
      if (credentials.randomUsername)
        console.log(`用户名: ${credentials.username}`);
      if (credentials.randomPassword)
        console.log(`临时密码: ${credentials.password}`);
      console.log("首次登录后必须修改临时密码。");
      console.log(
        "============================================================",
      );
      await this.prisma.adminUser.updateMany({
        data: { bootstrapLoggedAt: new Date() },
      });
    }
    await unlink(this.config.bootstrapFile).catch(() => undefined);
  }

  private async ensureSettings(): Promise<void> {
    const defaults: Record<string, unknown> = {
      instanceId: crypto.randomUUID(),
      siteName: "MailPilot 自动回复",
      timezone: this.config.timezone,
      defaultPollIntervalSeconds: 30,
      defaultBacklogPerMinute: 20,
      excludedAddresses: [],
      excludedDomains: [],
      attachmentLimitMb: 10,
      processingLogDays: 30,
      systemLogDays: 30,
      auditLogDays: 180,
      dedupeDays: 365,
      sessionIdleMinutes: 120,
      sessionAbsoluteMinutes: 720,
    };
    for (const [key, value] of Object.entries(defaults)) {
      await this.prisma.systemSetting.upsert({
        where: { key },
        create: { key, value: value as never },
        update: {},
      });
    }
  }
}
