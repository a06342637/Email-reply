import { Module } from "@nestjs/common";
import { TemplateService } from "./template.service.js";
import { TemplateController } from "./template.controller.js";
import { MicrosoftModule } from "../microsoft/microsoft.module.js";
import { TestMailService } from "./test-mail.service.js";

@Module({
  imports: [MicrosoftModule],
  controllers: [TemplateController],
  providers: [TemplateService, TestMailService],
  exports: [TemplateService],
})
export class TemplateModule {}
