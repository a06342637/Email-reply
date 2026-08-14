import {
  IsEmail,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from "class-validator";

export class CreateTemplateDto {
  @IsString()
  @Length(1, 120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsString()
  @MaxLength(500)
  subjectTemplate!: string;

  @IsString()
  @MaxLength(250_000)
  htmlContent!: string;

  @IsOptional()
  @IsString()
  @MaxLength(250_000)
  textContent?: string;
}

export class UpdateDraftDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsString()
  @MaxLength(500)
  subjectTemplate!: string;

  @IsString()
  @MaxLength(250_000)
  htmlContent!: string;

  @IsOptional()
  @IsString()
  @MaxLength(250_000)
  textContent?: string;
}

export class TestSendDto {
  @IsString()
  mailboxId!: string;

  @IsEmail()
  recipient!: string;

  @IsOptional()
  @IsObject()
  variables?: Record<string, unknown>;
}

export class PreviewTemplateDto {
  @IsString()
  @MaxLength(500)
  subjectTemplate!: string;

  @IsString()
  @MaxLength(250_000)
  htmlContent!: string;

  @IsOptional()
  @IsString()
  @MaxLength(250_000)
  textContent?: string;

  @IsObject()
  variables!: Record<string, unknown>;
}

export class AssetMetadataDto {
  @IsOptional()
  @IsIn(["true", "false"])
  inline?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  contentId?: string;
}
