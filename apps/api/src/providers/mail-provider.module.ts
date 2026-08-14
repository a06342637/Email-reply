import { Module } from "@nestjs/common";
import { GoogleModule } from "../google/google.module.js";
import { MicrosoftModule } from "../microsoft/microsoft.module.js";
import { MailProviderService } from "./mail-provider.service.js";

@Module({
  imports: [MicrosoftModule, GoogleModule],
  providers: [MailProviderService],
  exports: [MailProviderService, MicrosoftModule, GoogleModule],
})
export class MailProviderModule {}
