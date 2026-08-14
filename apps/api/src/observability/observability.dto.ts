import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  MaxLength,
} from "class-validator";

export class CreateWebhookDto {
  @IsString()
  @Length(1, 120)
  name!: string;

  @IsUrl({ require_protocol: true, protocols: ["https"] })
  @MaxLength(2_048)
  url!: string;

  @IsOptional()
  @IsString()
  @Length(16, 512)
  secret?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  eventTypes?: string[];
}

export class UpdateWebhookDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;

  @IsOptional()
  @IsUrl({ require_protocol: true, protocols: ["https"] })
  @MaxLength(2_048)
  url?: string;

  @IsOptional()
  @IsString()
  @Length(16, 512)
  secret?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  eventTypes?: string[];

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
