import { Module } from "@nestjs/common";
import { TemplateService } from "./template.service.js";
import { TemplateController } from "./template.controller.js";
import { MailProviderModule } from "../providers/mail-provider.module.js";
import { TestMailService } from "./test-mail.service.js";
import { SmtpModule } from "../smtp/smtp.module.js";

@Module({
  imports: [MailProviderModule, SmtpModule],
  controllers: [TemplateController],
  providers: [TemplateService, TestMailService],
  exports: [TemplateService],
})
export class TemplateModule {}
