import {
  Body,
  Controller,
  Post,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import type { Request, Response } from "express";
import { BackupService } from "./backup.service.js";
import { AuditService } from "../core/audit.js";
import { AppError } from "../core/http.js";
import { AlertService } from "../observability/alert.service.js";
import { ExportBackupDto } from "./backup.dto.js";

@Controller("api/v1/backups")
export class BackupController {
  constructor(
    private readonly backups: BackupService,
    private readonly audit: AuditService,
    private readonly alerts: AlertService,
  ) {}

  @Post("export")
  async export(
    @Body() body: ExportBackupDto,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (body.passphrase !== body.confirmation)
      throw new AppError(
        "BACKUP_PASSPHRASE_MISMATCH",
        "两次备份口令不一致",
        400,
      );
    const buffer = await this.backups.export(body.passphrase);
    await this.audit.write("BACKUP_EXPORTED", req);
    res.setHeader("content-type", "application/octet-stream");
    res.setHeader(
      "content-disposition",
      `attachment; filename="mailpilot-backup-${new Date().toISOString().slice(0, 10)}.mpbak"`,
    );
    return res.send(buffer);
  }

  @Post("inspect")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: 512 * 1024 * 1024 },
    }),
  )
  inspect(
    @UploadedFile() file: Express.Multer.File,
    @Body("passphrase") passphrase: string,
  ) {
    if (!file)
      throw new AppError("BACKUP_FILE_REQUIRED", "请选择备份文件", 400);
    return this.backups.inspect(file.buffer, passphrase);
  }

  @Post("restore")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: 512 * 1024 * 1024 },
    }),
  )
  async restore(
    @UploadedFile() file: Express.Multer.File,
    @Body("passphrase") passphrase: string,
    @Body("confirmation") confirmation: string,
    @Req() req: Request,
  ) {
    if (confirmation !== "RESTORE")
      throw new AppError("RESTORE_CONFIRMATION_REQUIRED", "恢复确认无效", 400);
    if (!file)
      throw new AppError("BACKUP_FILE_REQUIRED", "请选择备份文件", 400);
    try {
      const result = await this.backups.restore(file.buffer, passphrase);
      await this.alerts.resolve("backup-restore-failed");
      await this.audit.write("BACKUP_RESTORED", req, undefined, result);
      return result;
    } catch (error) {
      await this.alerts.open({
        fingerprint: "backup-restore-failed",
        type: "BACKUP_RESTORE_FAILED",
        severity: "CRITICAL",
        title: "备份恢复失败",
        message:
          "备份未能完成恢复，Worker 已安全解除恢复屏障，请检查系统日志后重试。",
        metadata: {
          code: error instanceof AppError ? error.code : "RESTORE_FAILED",
        },
      });
      throw error;
    }
  }
}
