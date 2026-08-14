import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { WorkerAppModule } from "./worker-app.module.js";
import { AppConfig } from "./core/config.js";

// createApplicationContext runs module lifecycle hooks immediately. Validate
// before constructing the context so schedulers and queue workers can never
// start with a missing database URL, encryption key, or session secret.
new AppConfig().validate();
const app = await NestFactory.createApplicationContext(WorkerAppModule, {
  logger: ["log", "error", "warn"],
});
app.enableShutdownHooks();
console.log("MailPilot worker started");
