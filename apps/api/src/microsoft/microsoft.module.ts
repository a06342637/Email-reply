import { Module } from "@nestjs/common";
import { MicrosoftController } from "./microsoft.controller.js";
import { MicrosoftService } from "./microsoft.service.js";
import { GraphService } from "./graph.service.js";
import { MailTransportService } from "./mail-transport.service.js";
import { ObservabilityModule } from "../observability/observability.module.js";

@Module({
  imports: [ObservabilityModule],
  controllers: [MicrosoftController],
  providers: [MicrosoftService, GraphService, MailTransportService],
  exports: [MicrosoftService, GraphService, MailTransportService],
})
export class MicrosoftModule {}
