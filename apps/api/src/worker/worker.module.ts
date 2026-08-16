import { Module } from "@nestjs/common";
import { MailProviderModule } from "../providers/mail-provider.module.js";
import { TemplateModule } from "../templates/template.module.js";
import { ObservabilityModule } from "../observability/observability.module.js";
import { FilterService } from "./filter.service.js";
import { DeltaService } from "./delta.service.js";
import { MailProcessorService } from "./mail-processor.service.js";
import { OutboxDispatcherService, QueueService } from "./queue.service.js";
import { SchedulerService } from "./scheduler.service.js";
import { WorkerRunnerService } from "./worker-runner.service.js";
import { BackupModule } from "../backup/backup.module.js";
import { GmailPollService } from "./gmail-poll.service.js";
import { ProviderPollService } from "./provider-poll.service.js";
import { SmtpModule } from "../smtp/smtp.module.js";

@Module({
  imports: [
    MailProviderModule,
    TemplateModule,
    ObservabilityModule,
    BackupModule,
    SmtpModule,
  ],
  providers: [
    FilterService,
    DeltaService,
    GmailPollService,
    ProviderPollService,
    MailProcessorService,
    QueueService,
    OutboxDispatcherService,
    SchedulerService,
    WorkerRunnerService,
  ],
  exports: [MailProcessorService, QueueService],
})
export class WorkerServicesModule {}
