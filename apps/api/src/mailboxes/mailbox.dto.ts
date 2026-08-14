import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

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
