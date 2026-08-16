import { Injectable } from "@nestjs/common";
import { Liquid } from "liquidjs";
import sanitizeHtml from "sanitize-html";
import { convert } from "html-to-text";
import { PrismaService } from "../core/prisma.js";
import { AppError } from "../core/http.js";
import type { TemplateVariables } from "@autoreply/shared";

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "p",
    "br",
    "div",
    "span",
    "strong",
    "b",
    "em",
    "i",
    "u",
    "s",
    "blockquote",
    "pre",
    "code",
    "ul",
    "ol",
    "li",
    "h1",
    "h2",
    "h3",
    "h4",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "a",
    "img",
    "hr",
  ],
  allowedAttributes: {
    "*": ["style", "class"],
    a: ["href", "title", "target", "rel"],
    img: ["src", "alt", "title", "width", "height"],
    td: ["colspan", "rowspan"],
    th: ["colspan", "rowspan"],
  },
  allowedSchemes: ["http", "https", "mailto", "cid"],
  allowedSchemesByTag: { img: ["https", "cid"] },
  allowedStyles: {
    "*": {
      color: [/^#[0-9a-f]{3,8}$/i, /^rgb/i],
      "background-color": [/^#[0-9a-f]{3,8}$/i, /^rgb/i],
      "font-size": [/^\d+(?:px|em|rem|%)$/],
      "font-family": [/^[\w\s,"'-]+$/],
      "font-weight": [/^(?:normal|bold|[1-9]00)$/],
      "font-style": [/^(?:normal|italic)$/],
      "text-align": [/^(?:left|right|center|justify)$/],
      "text-decoration": [/^(?:none|underline|line-through)$/],
      margin: [/^[\d\s.pxemrem%-]+$/],
      padding: [/^[\d\s.pxemrem%-]+$/],
      border: [/^[\w\s#().,%/-]+$/],
      "border-radius": [/^[\d\s.pxemrem%]+$/],
      width: [/^(?:auto|\d+(?:px|em|rem|%))$/],
      "max-width": [/^(?:none|\d+(?:px|em|rem|%))$/],
      display: [/^(?:block|inline|inline-block|table|table-row|table-cell)$/],
    },
  },
  transformTags: {
    a: sanitizeHtml.simpleTransform(
      "a",
      { rel: "noopener noreferrer", target: "_blank" },
      true,
    ),
  },
};

const NO_FILE_SYSTEM = {
  exists: async () => false,
  existsSync: () => false,
  readFile: async () => {
    throw new Error("Liquid file access is disabled");
  },
  readFileSync: () => {
    throw new Error("Liquid file access is disabled");
  },
  resolve: () => {
    throw new Error("Liquid file access is disabled");
  },
  contains: async () => false,
  containsSync: () => false,
  sep: "/",
  dirname: () => "/",
};

@Injectable()
export class TemplateService {
  private readonly liquidHtml = new Liquid({
    outputEscape: "escape",
    strictFilters: true,
    strictVariables: false,
    dynamicPartials: false,
    jsTruthy: false,
    ownPropertyOnly: true,
    fs: NO_FILE_SYSTEM,
    parseLimit: 250_000,
    renderLimit: 500,
    memoryLimit: 2_000_000,
  });
  private readonly liquidText = new Liquid({
    strictFilters: true,
    strictVariables: false,
    dynamicPartials: false,
    jsTruthy: false,
    ownPropertyOnly: true,
    fs: NO_FILE_SYSTEM,
    parseLimit: 250_000,
    renderLimit: 500,
    memoryLimit: 2_000_000,
  });

  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.replyTemplate.findMany({
      include: {
        publishedRevision: {
          select: { id: true, version: true, publishedAt: true },
        },
        revisions: {
          orderBy: { version: "desc" },
          take: 1,
          include: {
            assets: {
              select: {
                id: true,
                fileName: true,
                contentType: true,
                size: true,
                inline: true,
                contentId: true,
              },
            },
          },
        },
        _count: {
          select: {
            rules: { where: { task: { status: { not: "DELETED" } } } },
            defaultForTasks: { where: { status: { not: "DELETED" } } },
          },
        },
      },
      orderBy: { updatedAt: "desc" },
    });
  }

  get(id: string) {
    return this.prisma.replyTemplate.findUniqueOrThrow({
      where: { id },
      include: {
        publishedRevision: true,
        revisions: {
          orderBy: { version: "desc" },
          include: {
            assets: {
              select: {
                id: true,
                fileName: true,
                contentType: true,
                size: true,
                inline: true,
                contentId: true,
              },
            },
          },
        },
      },
    });
  }

  async create(input: {
    name: string;
    description?: string;
    subjectTemplate: string;
    htmlContent: string;
    textContent?: string;
    autoTextContent?: boolean;
  }) {
    const name = input.name.trim();
    if (!name)
      throw new AppError("TEMPLATE_NAME_REQUIRED", "模板名称不能为空", 400);
    const sanitized = this.sanitize(input.htmlContent);
    await this.validateLiquid(
      input.subjectTemplate,
      sanitized,
      input.textContent ?? "",
    );
    const autoTextContent = input.autoTextContent !== false;
    const textContent = autoTextContent
      ? this.toText(sanitized)
      : input.textContent?.trim() || this.toText(sanitized);
    return this.prisma.replyTemplate.create({
      data: {
        name,
        description: input.description?.trim(),
        revisions: {
          create: {
            version: 1,
            subjectTemplate: input.subjectTemplate,
            htmlContent: input.htmlContent,
            sanitizedHtml: sanitized,
            textContent,
            autoTextContent,
          },
        },
      },
      include: { revisions: true },
    });
  }

  async updateDraft(
    id: string,
    input: {
      name?: string;
      description?: string;
      subjectTemplate: string;
      htmlContent: string;
      textContent?: string;
      autoTextContent?: boolean;
    },
  ) {
    const name = input.name?.trim();
    if (input.name !== undefined && !name)
      throw new AppError("TEMPLATE_NAME_REQUIRED", "模板名称不能为空", 400);
    const template = await this.prisma.replyTemplate.findUniqueOrThrow({
      where: { id },
      include: {
        revisions: {
          orderBy: { version: "desc" },
          take: 1,
          include: { assets: true },
        },
      },
    });
    const latest = template.revisions[0];
    const sanitized = this.sanitize(input.htmlContent);
    const autoTextContent = input.autoTextContent !== false;
    const textContent = autoTextContent
      ? this.toText(sanitized)
      : input.textContent?.trim() || this.toText(sanitized);
    await this.validateLiquid(input.subjectTemplate, sanitized, textContent);
    const isPublishedLatest = latest?.id === template.publishedRevisionId;
    const revision =
      isPublishedLatest || !latest
        ? await this.prisma.templateRevision.create({
            data: {
              templateId: id,
              version: (latest?.version ?? 0) + 1,
              subjectTemplate: input.subjectTemplate,
              htmlContent: input.htmlContent,
              sanitizedHtml: sanitized,
              textContent,
              autoTextContent,
              assets: latest?.assets.length
                ? {
                    create: latest.assets.map((asset) => ({
                      fileName: asset.fileName,
                      contentType: asset.contentType,
                      size: asset.size,
                      inline: asset.inline,
                      contentId: asset.contentId,
                      data: asset.data,
                    })),
                  }
                : undefined,
            },
          })
        : await this.prisma.templateRevision.update({
            where: { id: latest.id },
            data: {
              subjectTemplate: input.subjectTemplate,
              htmlContent: input.htmlContent,
              sanitizedHtml: sanitized,
              textContent,
              autoTextContent,
            },
          });
    await this.prisma.replyTemplate.update({
      where: { id },
      data: {
        ...(name ? { name } : {}),
        ...(input.description !== undefined
          ? { description: input.description.trim() }
          : {}),
      },
    });
    return revision;
  }

  async publish(id: string) {
    const template = await this.prisma.replyTemplate.findUniqueOrThrow({
      where: { id },
      include: { revisions: { orderBy: { version: "desc" }, take: 1 } },
    });
    const revision = template.revisions[0];
    if (!revision)
      throw new AppError("TEMPLATE_EMPTY", "模板没有可发布的修订", 409);
    await this.prisma.$transaction([
      this.prisma.templateRevision.update({
        where: { id: revision.id },
        data: { publishedAt: new Date() },
      }),
      this.prisma.replyTemplate.update({
        where: { id },
        data: { publishedRevisionId: revision.id },
      }),
    ]);
    return {
      templateId: id,
      revisionId: revision.id,
      version: revision.version,
    };
  }

  async addAsset(
    revisionId: string,
    file: Express.Multer.File,
    metadata: { inline: boolean; contentId?: string },
  ) {
    if (!file) throw new AppError("FILE_REQUIRED", "请选择附件", 400);
    const revision = await this.prisma.templateRevision.findUniqueOrThrow({
      where: { id: revisionId },
      include: { assets: { select: { size: true } } },
    });
    if (revision.publishedAt)
      throw new AppError(
        "REVISION_IMMUTABLE",
        "已发布修订不能修改附件，请先创建新草稿",
        409,
      );
    const hardLimit = 25 * 1024 * 1024;
    const setting = await this.prisma.systemSetting.findUnique({
      where: { key: "attachmentLimitMb" },
    });
    const limitMb = Math.min(25, Math.max(1, Number(setting?.value ?? 10)));
    const total =
      revision.assets.reduce((sum, item) => sum + item.size, 0) + file.size;
    if (file.size > hardLimit || total > limitMb * 1024 * 1024) {
      throw new AppError(
        "ATTACHMENT_LIMIT",
        `模板附件总量不能超过 ${limitMb}MB`,
        413,
      );
    }
    const contentId = metadata.inline
      ? metadata.contentId || `asset-${crypto.randomUUID()}@autoreply`
      : null;
    return this.prisma.templateAsset.create({
      data: {
        revisionId,
        fileName: file.originalname.slice(0, 255),
        contentType: file.mimetype || "application/octet-stream",
        size: file.size,
        inline: metadata.inline,
        contentId,
        data: new Uint8Array(file.buffer),
      },
      select: {
        id: true,
        fileName: true,
        contentType: true,
        size: true,
        inline: true,
        contentId: true,
      },
    });
  }

  async deleteAsset(assetId: string): Promise<void> {
    const asset = await this.prisma.templateAsset.findUniqueOrThrow({
      where: { id: assetId },
      include: { revision: true },
    });
    if (asset.revision.publishedAt)
      throw new AppError("REVISION_IMMUTABLE", "已发布修订不能修改附件", 409);
    await this.prisma.templateAsset.delete({ where: { id: assetId } });
  }

  async render(revisionId: string, variables: TemplateVariables) {
    const revision = await this.prisma.templateRevision.findUniqueOrThrow({
      where: { id: revisionId },
      include: { assets: true, template: true },
    });
    const [subject, html, text] = await Promise.all([
      this.liquidText.parseAndRender(revision.subjectTemplate, variables),
      this.liquidHtml.parseAndRender(revision.sanitizedHtml, variables),
      this.liquidText.parseAndRender(
        revision.autoTextContent
          ? this.toText(revision.sanitizedHtml)
          : revision.textContent,
        variables,
      ),
    ]);
    const cleanHtml = this.sanitize(html);
    return {
      subject: subject.replace(/[\r\n]+/g, " ").slice(0, 998),
      html: cleanHtml,
      text,
      warnings: this.deliverabilityWarnings(cleanHtml, text),
      assets: revision.assets,
      templateName: revision.template.name,
      version: revision.version,
    };
  }

  async renderForReply(revisionId: string, variables: TemplateVariables) {
    return this.render(revisionId, variables);
  }

  async preview(input: {
    subjectTemplate: string;
    htmlContent: string;
    textContent?: string;
    autoTextContent?: boolean;
    variables: TemplateVariables;
  }) {
    const sanitized = this.sanitize(input.htmlContent);
    await this.validateLiquid(
      input.subjectTemplate,
      sanitized,
      input.textContent ?? "",
    );
    const textTemplate =
      input.autoTextContent === false && input.textContent?.trim()
        ? input.textContent
        : this.toText(sanitized);
    const [subject, html, text] = await Promise.all([
      this.liquidText.parseAndRender(input.subjectTemplate, input.variables),
      this.liquidHtml.parseAndRender(sanitized, input.variables),
      this.liquidText.parseAndRender(textTemplate, input.variables),
    ]);
    const cleanHtml = this.sanitize(html);
    return {
      subject,
      html: cleanHtml,
      text,
      warnings: this.deliverabilityWarnings(cleanHtml, text),
    };
  }

  async delete(id: string): Promise<{ revisionCount: number }> {
    const template = await this.prisma.replyTemplate.findUnique({
      where: { id },
      select: {
        id: true,
        revisions: { select: { id: true } },
        defaultForTasks: {
          where: { status: { not: "DELETED" } },
          select: { id: true, name: true },
        },
        rules: {
          where: { task: { status: { not: "DELETED" } } },
          select: {
            id: true,
            name: true,
            task: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (!template)
      throw new AppError("TEMPLATE_NOT_FOUND", "模板不存在或已删除", 404);
    if (template.defaultForTasks.length || template.rules.length)
      throw new AppError(
        "TEMPLATE_IN_USE",
        "模板仍被自动回复任务或规则使用，请先更换对应模板后再删除",
        409,
        {
          tasks: template.defaultForTasks,
          rules: template.rules,
        },
      );
    const revisionIds = template.revisions.map((revision) => revision.id);
    const processing = revisionIds.length
      ? await this.prisma.messageReceipt.count({
          where: {
            templateRevisionId: { in: revisionIds },
            state: {
              in: [
                "DISCOVERED",
                "QUEUED",
                "CREATING_DRAFT",
                "DRAFT_READY",
                "SENDING",
              ],
            },
          },
        })
      : 0;
    if (processing)
      throw new AppError(
        "TEMPLATE_PROCESSING",
        "模板仍有正在处理或发送的邮件，请等待处理完成后再删除",
        409,
        { processing },
      );
    await this.prisma.$transaction([
      this.prisma.replyRule.deleteMany({
        where: { templateId: id, task: { status: "DELETED" } },
      }),
      this.prisma.autoReplyTask.updateMany({
        where: { defaultTemplateId: id, status: "DELETED" },
        data: { defaultTemplateId: null },
      }),
      this.prisma.replyTemplate.delete({ where: { id } }),
    ]);
    return { revisionCount: revisionIds.length };
  }

  async duplicate(id: string) {
    const source = await this.prisma.replyTemplate.findUniqueOrThrow({
      where: { id },
      include: {
        revisions: {
          orderBy: { version: "desc" },
          take: 1,
          include: { assets: true },
        },
      },
    });
    const revision = source.revisions[0];
    if (!revision)
      throw new AppError("TEMPLATE_EMPTY", "源模板没有可复制的修订", 409);
    return this.prisma.replyTemplate.create({
      data: {
        name: `${source.name} - 副本`,
        description: source.description,
        revisions: {
          create: {
            version: 1,
            subjectTemplate: revision.subjectTemplate,
            htmlContent: revision.htmlContent,
            sanitizedHtml: revision.sanitizedHtml,
            textContent: revision.textContent,
            autoTextContent: revision.autoTextContent,
            assets: {
              create: revision.assets.map((asset) => ({
                fileName: asset.fileName,
                contentType: asset.contentType,
                size: asset.size,
                inline: asset.inline,
                contentId: asset.contentId,
                data: asset.data,
              })),
            },
          },
        },
      },
      include: { revisions: { include: { assets: true } } },
    });
  }

  sanitize(html: string): string {
    return sanitizeHtml(html, SANITIZE_OPTIONS);
  }

  toText(html: string): string {
    return convert(html, {
      wordwrap: 100,
      selectors: [{ selector: "img", format: "skip" }],
    });
  }

  deliverabilityWarnings(html: string, text: string): string[] {
    const warnings: string[] = [];
    const links = html.match(/<a\b/gi)?.length ?? 0;
    const images = html.match(/<img\b/gi)?.length ?? 0;
    const visibleText = text.replace(/\s+/g, " ").trim();
    if (links > 8)
      warnings.push("模板包含较多链接，目标邮箱可能提高反垃圾评分");
    if (images > 5)
      warnings.push("模板包含较多图片，建议减少图片并保留足够正文文字");
    if (html.length > 100_000)
      warnings.push("HTML 内容超过 100KB，部分邮箱可能截断或拒收");
    if (visibleText.length < 40 && html.length > 2_000)
      warnings.push("富文本较多但纯文本内容过少，建议启用自动生成纯文本版本");
    if (
      /免费|限时|立即购买|点击领取|唯一.{0,6}官方|永久.{0,6}导航/i.test(
        visibleText,
      )
    )
      warnings.push("正文包含常见营销词，最终投递可能受发件信誉影响");
    return warnings;
  }

  private async validateLiquid(...values: string[]): Promise<void> {
    try {
      for (const value of values) {
        if (/{%\s*(?:include|render|layout)\b/i.test(value))
          throw new Error("不允许引用外部 Liquid 文件或布局");
        this.liquidHtml.parse(value);
      }
    } catch (error) {
      throw new AppError(
        "TEMPLATE_SYNTAX_INVALID",
        `模板语法错误：${error instanceof Error ? error.message : "unknown error"}`,
        400,
      );
    }
  }
}
