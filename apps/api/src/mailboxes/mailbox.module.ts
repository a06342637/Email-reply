import { Module } from "@nestjs/common";
import { MailboxController } from "./mailbox.controller.js";
import { MailboxService } from "./mailbox.service.js";

@Module({
  controllers: [MailboxController],
  providers: [MailboxService],
  exports: [MailboxService],
})
export class MailboxModule {}
