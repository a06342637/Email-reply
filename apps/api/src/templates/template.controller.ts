import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Request } from "express";
import { memoryStorage } from "multer";
import {
  CreateTemplateDto,
  AssetMetadataDto,
  PreviewTemplateDto,
  TestSendDto,
  UpdateDraftDto,
} from "./template.dto.js";
import { TemplateService } from "./template.service.js";
import { AuditService } from "../core/audit.js";
import { TestMailService } from "./test-mail.service.js";

@Controller("api/v1/templates")
export class TemplateController {
  constructor(
    private readonly templates: TemplateService,
    private readonly audit: AuditService,
    private readonly testMail: TestMailService,
  ) {}

  @Get()
  list() {
    return this.templates.list();
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.templates.get(id);
  }

  @Post()
  async create(@Body() body: CreateTemplateDto, @Req() req: Request) {
    const template = await this.templates.create(body);
    await this.audit.write("TEMPLATE_CREATED", req, {
      type: "ReplyTemplate",
      id: template.id,
    });
    return template;
  }

  @Patch(":id/draft")
  async update(
    @Param("id") id: string,
    @Body() body: UpdateDraftDto,
    @Req() req: Request,
  ) {
    const revision = await this.templates.updateDraft(id, body);
    await this.audit.write("TEMPLATE_DRAFT_UPDATED", req, {
      type: "ReplyTemplate",
      id,
    });
    return revision;
  }

  @Post(":id/publish")
  async publish(@Param("id") id: string, @Req() req: Request) {
    const result = await this.templates.publish(id);
    await this.audit.write(
      "TEMPLATE_PUBLISHED",
      req,
      { type: "ReplyTemplate", id },
      result,
    );
    return result;
  }

  @Post(":id/duplicate")
  async duplicate(@Param("id") id: string, @Req() req: Request) {
    const result = await this.templates.duplicate(id);
    await this.audit.write(
      "TEMPLATE_DUPLICATED",
      req,
      { type: "ReplyTemplate", id: result.id },
      { sourceId: id },
    );
    return result;
  }

  @Post("revisions/:revisionId/assets")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: 25 * 1024 * 1024 },
    }),
  )
  async addAsset(
    @Param("revisionId") revisionId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: AssetMetadataDto,
    @Req() req: Request,
  ) {
    const asset = await this.templates.addAsset(revisionId, file, {
      inline: body.inline === "true",
      contentId: body.contentId,
    });
    await this.audit.write(
      "TEMPLATE_ASSET_ADDED",
      req,
      { type: "TemplateRevision", id: revisionId },
      { fileName: asset.fileName, size: asset.size },
    );
    return asset;
  }

  @Delete("assets/:assetId")
  async deleteAsset(@Param("assetId") assetId: string, @Req() req: Request) {
    await this.templates.deleteAsset(assetId);
    await this.audit.write("TEMPLATE_ASSET_DELETED", req, {
      type: "TemplateAsset",
      id: assetId,
    });
    return { ok: true };
  }

  @Post(":id/test-send")
  async testSend(
    @Param("id") id: string,
    @Body() body: TestSendDto,
    @Req() req: Request,
  ) {
    const result = await this.testMail.send(
      id,
      body.mailboxId,
      body.recipient,
      body.variables,
    );
    await this.audit.write(
      "TEMPLATE_TEST_SENT",
      req,
      { type: "ReplyTemplate", id },
      { mailboxId: body.mailboxId, recipient: body.recipient },
    );
    return result;
  }

  @Post("preview/render")
  preview(@Body() body: PreviewTemplateDto) {
    return this.templates.preview(
      body as Parameters<TemplateService["preview"]>[0],
    );
  }

  @Delete(":id")
  async remove(@Param("id") id: string, @Req() req: Request) {
    const result = await this.templates.delete(id);
    await this.audit.write(
      "TEMPLATE_DELETED",
      req,
      { type: "ReplyTemplate", id },
      result,
    );
    return { ok: true };
  }
}
