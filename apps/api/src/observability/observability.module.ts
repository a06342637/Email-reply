import { Module } from "@nestjs/common";
import { AlertService } from "./alert.service.js";
import { WebhookService } from "./webhook.service.js";
import { ObservabilityController } from "./observability.controller.js";

@Module({
  controllers: [ObservabilityController],
  providers: [AlertService, WebhookService],
  exports: [AlertService, WebhookService],
})
export class ObservabilityModule {}
