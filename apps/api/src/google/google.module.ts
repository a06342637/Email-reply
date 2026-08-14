import { Module } from "@nestjs/common";
import { ObservabilityModule } from "../observability/observability.module.js";
import { GoogleController } from "./google.controller.js";
import { GmailApiService } from "./gmail-api.service.js";
import { GmailTransportService } from "./gmail-transport.service.js";
import { GoogleService } from "./google.service.js";

@Module({
  imports: [ObservabilityModule],
  controllers: [GoogleController],
  providers: [GoogleService, GmailApiService, GmailTransportService],
  exports: [GoogleService, GmailApiService, GmailTransportService],
})
export class GoogleModule {}
