import { Module } from "@nestjs/common";
import { SmtpController } from "./smtp.controller.js";
import { SmtpConfigService } from "./smtp-config.service.js";
import { SmtpDeliveryService } from "./smtp-delivery.service.js";

@Module({
  controllers: [SmtpController],
  providers: [SmtpConfigService, SmtpDeliveryService],
  exports: [SmtpConfigService, SmtpDeliveryService],
})
export class SmtpModule {}
