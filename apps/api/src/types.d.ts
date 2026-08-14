import type { AdminUser, AdminSession } from "@prisma/client";

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      auth?: {
        admin: AdminUser;
        session: AdminSession;
      };
    }
  }
}

export {};
