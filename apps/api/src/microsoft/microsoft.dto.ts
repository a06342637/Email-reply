import {
  IsDateString,
  MaxLength,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from "class-validator";

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
  @IsOptional()
  @IsString()
  @MaxLength(512)
  redirectAfter?: string;
}
