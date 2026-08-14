import { Module } from "@nestjs/common";
import { ServeStaticModule } from "@nestjs/serve-static";
import { join } from "node:path";
import { CoreModule } from "./core/core.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { MailProviderModule } from "./providers/mail-provider.module.js";
import { MailboxModule } from "./mailboxes/mailbox.module.js";
import { TemplateModule } from "./templates/template.module.js";
import { ObservabilityModule } from "./observability/observability.module.js";
import { SettingsModule } from "./settings/settings.module.js";
import { BackupModule } from "./backup/backup.module.js";
import { HealthController } from "./health/health.controller.js";
import { BootstrapService } from "./bootstrap.service.js";
import { AppMonitorService } from "./observability/app-monitor.service.js";

@Module({
  imports: [
    CoreModule,
    AuthModule,
    MailProviderModule,
    MailboxModule,
    TemplateModule,
    ObservabilityModule,
    SettingsModule,
    BackupModule,
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), "apps/web/dist"),
      exclude: ["/api/{*path}", "/health/{*path}"],
    }),
  ],
  controllers: [HealthController],
  providers: [BootstrapService, AppMonitorService],
})
export class AppModule {}
