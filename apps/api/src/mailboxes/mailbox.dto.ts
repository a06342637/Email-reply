import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { SendTransport } from "@prisma/client";

export class CreateTaskDto {
  @IsString()
  @Length(1, 120)
  name!: string;

  @IsInt()
  @Min(3)
  @Max(3600)
  pollIntervalSeconds!: number;

  @IsInt()
  @Min(1)
  @Max(300)
  backlogPerMinute!: number;

  @IsString()
  defaultTemplateId!: string;

  @IsEnum(SendTransport)
  sendTransport!: SendTransport;

  @IsOptional()
  @IsString()
  smtpConfigId?: string | null;
}

export class UpdateTaskDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(3)
  @Max(3600)
  pollIntervalSeconds?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(300)
  backlogPerMinute?: number;

  @IsOptional()
  @IsString()
  defaultTemplateId?: string;

  @IsOptional()
  @IsEnum(SendTransport)
  sendTransport?: SendTransport;

  @IsOptional()
  @IsString()
  smtpConfigId?: string | null;
}

export class ReplyRuleDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsString()
  @Length(1, 120)
  name!: string;

  @IsBoolean()
  enabled!: boolean;

  @IsString()
  @Length(1, 100)
  templateId!: string;

  @IsObject()
  conditions!: Record<string, unknown>;
}

export class ReplaceRulesDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ReplyRuleDto)
  rules!: ReplyRuleDto[];
}
