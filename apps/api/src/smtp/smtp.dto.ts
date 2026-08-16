import {
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { SmtpSecurity } from "@prisma/client";

export class CreateSmtpConfigDto {
  @IsString()
  @Length(1, 120)
  name!: string;

  @IsString()
  @Length(1, 253)
  host!: string;

  @IsInt()
  @Min(1)
  @Max(65_535)
  port!: number;

  @IsEnum(SmtpSecurity)
  security!: SmtpSecurity;

  @IsString()
  @Length(1, 320)
  username!: string;

  @IsString()
  @Length(1, 1_024)
  password!: string;

  @IsEmail()
  @MaxLength(320)
  fromEmail!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  fromName?: string | null;

  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  replyToEmail?: string | null;
}

export class UpdateSmtpConfigDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(1, 253)
  host?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65_535)
  port?: number;

  @IsOptional()
  @IsEnum(SmtpSecurity)
  security?: SmtpSecurity;

  @IsOptional()
  @IsString()
  @Length(1, 320)
  username?: string;

  @IsOptional()
  @IsString()
  @Length(1, 1_024)
  password?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  fromEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  fromName?: string | null;

  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  replyToEmail?: string | null;
}

export class TestSmtpConfigDto {
  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  recipient?: string;
}
