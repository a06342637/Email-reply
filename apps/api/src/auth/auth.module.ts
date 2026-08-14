import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { AuthService } from "./auth.service.js";
import { AuthController } from "./auth.controller.js";
import { AuthMiddleware } from "./auth.middleware.js";

@Module({
  controllers: [AuthController],
  providers: [AuthService, AuthMiddleware],
  exports: [AuthService],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AuthMiddleware).forRoutes("*");
  }
}
