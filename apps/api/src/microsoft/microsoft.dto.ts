import {
  IsDateString,
  MaxLength,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from "class-validator";

export class MicrosoftAppDto {
  @IsString()
  @Length(1, 120)
  name!: string;

  @IsString()
  @IsUUID()
  clientId!: string;

  @IsOptional()
  @IsString()
  @Length(8, 512)
  clientSecret?: string;

  @IsOptional()
  @IsDateString()
  secretExpiresAt?: string | null;
}

export class MicrosoftConfigDto {
  @IsString()
  @IsUUID()
  clientId!: string;

  @IsOptional()
  @IsString()
  @Length(8, 512)
  clientSecret?: string;

  @IsOptional()
  @IsDateString()
  secretExpiresAt?: string | null;
}

export class PublicUrlDto {
  @IsString()
  @MaxLength(2_048)
  publicUrl!: string;
}

export class OAuthStartDto {
  @IsString()
  @Length(1, 64)
  appConfigId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  redirectAfter?: string;
}

export class MicrosoftRefreshTokenImportDto {
  @IsOptional()
  @IsString()
  @Length(1, 64)
  appConfigId?: string;

  @IsOptional()
  @IsString()
  @IsUUID()
  clientId?: string;

  @IsString()
  @Length(20, 16_384)
  refreshToken!: string;
}
