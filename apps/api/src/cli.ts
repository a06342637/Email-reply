import "reflect-metadata";
import { hash } from "@node-rs/argon2";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Redis } from "ioredis";
import { writeFile } from "node:fs/promises";
import { PrismaService } from "./core/prisma.js";
import { AppConfig } from "./core/config.js";
import { CryptoService } from "./core/crypto.js";
import { BackupService } from "./backup/backup.service.js";
import { RestoreBarrierService } from "./backup/restore-barrier.service.js";
import { deriveUpdateBackupPassphrase } from "./updates/updater-core.js";

const prisma = new PrismaService();
const config = new AppConfig();
const args = process.argv.slice(2);

function randomPassword(): string {
  return randomBytes(24).toString("base64url");
}

async function promptHidden(question: string): Promise<string> {
  if (!stdin.isTTY) return "";
  stdout.write(question);
  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve) => {
    let value = "";
    const handler = (char: string) => {
      if (char === "\r" || char === "\n") {
        stdin.setRawMode?.(false);
        stdin.pause();
        stdin.off("data", handler);
        stdout.write("\n");
        resolve(value);
        return;
      }
      if (char === "\u0003") process.exit(130);
      if (char === "\u007f") {
        value = value.slice(0, -1);
        return;
      }
      value += char;
    };
    stdin.on("data", handler);
  });
}

async function main(): Promise<void> {
  config.validate();
  if (args[0] === "admin" && args[1] === "show-username") {
    const admin = await prisma.adminUser.findFirst({
      select: { username: true },
    });
    if (!admin) throw new Error("Administrator has not been initialized");
    console.log(admin.username);
    return;
  }
  if (args[0] === "admin" && args[1] === "reset-password") {
    const useRandom = args.includes("--random");
    const disableTotp = args.includes("--disable-totp");
    const password = useRandom
      ? randomPassword()
      : await promptHidden("新密码（至少 12 位）: ");
    if (password.length < 12)
      throw new Error("Password must contain at least 12 characters");
    const admin = await prisma.adminUser.findFirstOrThrow();
    await prisma.$transaction([
      prisma.adminUser.update({
        where: { id: admin.id },
        data: {
          passwordHash: await hash(password, {
            memoryCost: 65_536,
            timeCost: 3,
            parallelism: 1,
            outputLen: 32,
          }),
          mustChangePassword: useRandom,
        },
      }),
      prisma.adminSession.deleteMany({ where: { adminId: admin.id } }),
      ...(disableTotp
        ? [prisma.totpCredential.deleteMany({ where: { adminId: admin.id } })]
        : []),
      prisma.auditLog.create({
        data: {
          action: "CLI_PASSWORD_RESET",
          entityType: "AdminUser",
          entityId: admin.id,
          metadata: { random: useRandom, totpDisabled: disableTotp },
        },
      }),
    ]);
    console.log("管理员密码已重置，所有后台会话已注销。");
    if (useRandom) console.log(`临时密码: ${password}`);
    return;
  }
  if (args[0] === "doctor") {
    let database = false;
    let redis = false;
    try {
      await prisma.$queryRaw`SELECT 1`;
      database = true;
    } catch {
      database = false;
    }
    const redisClient = new Redis(
      process.env.REDIS_URL ?? "redis://redis:6379",
      { lazyConnect: true },
    );
    try {
      await redisClient.connect();
      redis = (await redisClient.ping()) === "PONG";
    } catch {
      redis = false;
    } finally {
      redisClient.disconnect();
    }
    const workers = database
      ? await prisma.workerHeartbeat.findMany({
          orderBy: { updatedAt: "desc" },
          take: 5,
        })
      : [];
    console.log(
      JSON.stringify(
        { database, redis, workers, now: new Date().toISOString() },
        null,
        2,
      ),
    );
    if (!database || !redis) process.exitCode = 1;
    return;
  }
  if (args[0] === "backup" && args[1] === "export") {
    const outputIndex = args.indexOf("--output");
    const output = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
    const passphrase =
      process.env.BACKUP_PASSPHRASE || (await readSecretLine());
    const service = new BackupService(
      prisma,
      new CryptoService(config),
      config,
      new RestoreBarrierService(prisma, config),
    );
    const buffer = await service.export(passphrase);
    if (output) {
      await writeFile(output, buffer, { mode: 0o600 });
      console.error(`备份已写入 ${output}`);
    } else stdout.write(buffer);
    return;
  }
  if (args[0] === "backup" && args[1] === "show-update-passphrase") {
    console.log(deriveUpdateBackupPassphrase(config.updaterToken));
    return;
  }
  console.log("用法:");
  console.log("  autoreply admin show-username");
  console.log("  autoreply admin reset-password [--random] [--disable-totp]");
  console.log("  autoreply doctor");
  console.log("  autoreply backup export [--output /path/file.mpbak]");
  console.log("  autoreply backup show-update-passphrase");
  process.exitCode = 2;
}

async function readSecretLine(): Promise<string> {
  if (stdin.isTTY) return promptHidden("备份口令: ");
  const reader = createInterface({ input: stdin });
  const line = await new Promise<string>((resolve) =>
    reader.once("line", resolve),
  );
  reader.close();
  return line;
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
