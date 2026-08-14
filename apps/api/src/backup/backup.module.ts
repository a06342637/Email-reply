import { Module } from "@nestjs/common";
import { BackupController } from "./backup.controller.js";
import { BackupService } from "./backup.service.js";
import { RestoreBarrierService } from "./restore-barrier.service.js";
import { ObservabilityModule } from "../observability/observability.module.js";

@Module({
  imports: [ObservabilityModule],
  controllers: [BackupController],
  providers: [BackupService, RestoreBarrierService],
  exports: [BackupService, RestoreBarrierService],
})
export class BackupModule {}
