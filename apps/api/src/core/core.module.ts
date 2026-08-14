import { Global, MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { AppConfig } from "./config.js";
import { PrismaService } from "./prisma.js";
import { CryptoService } from "./crypto.js";
import { AuditService } from "./audit.js";
import { EventBus } from "./events.js";
import { GlobalExceptionFilter, RequestIdMiddleware } from "./http.js";

@Global()
@Module({
  providers: [
    AppConfig,
    PrismaService,
    CryptoService,
    AuditService,
    EventBus,
    GlobalExceptionFilter,
  ],
  exports: [
    AppConfig,
    PrismaService,
    CryptoService,
    AuditService,
    EventBus,
    GlobalExceptionFilter,
  ],
})
export class CoreModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes("*");
  }
}
