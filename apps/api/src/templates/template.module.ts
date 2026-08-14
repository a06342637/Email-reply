import { Module } from "@nestjs/common";
import { TemplateService } from "./template.service.js";
import { TemplateController } from "./template.controller.js";
import { MailProviderModule } from "../providers/mail-provider.module.js";
import { TestMailService } from "./test-mail.service.js";

@Module({
  imports: [MailProviderModule],
  controllers: [TemplateController],
  providers: [TemplateService, TestMailService],
  exports: [TemplateService],
})
export class TemplateModule {}
