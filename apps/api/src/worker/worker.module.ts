import { Module } from "@nestjs/common";
import { MicrosoftModule } from "../microsoft/microsoft.module.js";
import { TemplateModule } from "../templates/template.module.js";
import { ObservabilityModule } from "../observability/observability.module.js";
import { FilterService } from "./filter.service.js";
import { DeltaService } from "./delta.service.js";
import { MailProcessorService } from "./mail-processor.service.js";
import { OutboxDispatcherService, QueueService } from "./queue.service.js";
import { SchedulerService } from "./scheduler.service.js";
import { WorkerRunnerService } from "./worker-runner.service.js";
import { BackupModule } from "../backup/backup.module.js";

@Module({
  imports: [MicrosoftModule, TemplateModule, ObservabilityModule, BackupModule],
  providers: [
    FilterService,
    DeltaService,
    MailProcessorService,
    QueueService,
    OutboxDispatcherService,
    SchedulerService,
    WorkerRunnerService,
  ],
  exports: [MailProcessorService, QueueService],
})
export class WorkerServicesModule {}
