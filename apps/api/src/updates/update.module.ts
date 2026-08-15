import { Module } from "@nestjs/common";
import { UpdateController } from "./update.controller.js";
import { UpdateService } from "./update.service.js";

@Module({
  controllers: [UpdateController],
  providers: [UpdateService],
})
export class UpdateModule {}
