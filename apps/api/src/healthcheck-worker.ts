import { PrismaClient } from "@prisma/client";

const workerId = process.env.WORKER_ID ?? `worker-${process.pid}`;

const prisma = new PrismaClient();
try {
  const heartbeat = await prisma.workerHeartbeat.findFirst({
    where: {
      id: workerId,
      role: "worker",
      updatedAt: { gte: new Date(Date.now() - 60_000) },
    },
    orderBy: { updatedAt: "desc" },
  });
  process.exitCode = heartbeat ? 0 : 1;
} finally {
  await prisma.$disconnect();
}
