import { Module } from "@nestjs/common";
import { CoreModule } from "./core/core.module.js";
import { WorkerServicesModule } from "./worker/worker.module.js";

@Module({ imports: [CoreModule, WorkerServicesModule] })
export class WorkerAppModule {}
