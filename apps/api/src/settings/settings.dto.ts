import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from "class-validator";

export class UpdateSettingsDto {
  @IsOptional() @IsString() @Length(1, 120) siteName?: string;
  @IsOptional() @IsString() @MaxLength(120) timezone?: string;
  @IsOptional() @IsInt() @Min(3) @Max(3600) defaultPollIntervalSeconds?: number;
  @IsOptional() @IsInt() @Min(1) @Max(300) defaultBacklogPerMinute?: number;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(320, { each: true })
  excludedAddresses?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(253, { each: true })
  excludedDomains?: string[];
  @IsOptional() @IsInt() @Min(1) @Max(25) attachmentLimitMb?: number;
  @IsOptional() @IsInt() @Min(1) @Max(3650) processingLogDays?: number;
  @IsOptional() @IsInt() @Min(1) @Max(3650) systemLogDays?: number;
  @IsOptional() @IsInt() @Min(1) @Max(3650) alertLogDays?: number;
  @IsOptional() @IsInt() @Min(1) @Max(3650) auditLogDays?: number;
  @IsOptional() @IsInt() @Min(1) @Max(3650) dedupeDays?: number;
  @IsOptional() @IsInt() @Min(5) @Max(1440) sessionIdleMinutes?: number;
  @IsOptional() @IsInt() @Min(10) @Max(10080) sessionAbsoluteMinutes?: number;
}
