import { IsOptional, IsString, Length, MaxLength } from "class-validator";

export class GoogleConfigDto {
  @IsString()
  @Length(8, 512)
  clientId!: string;

  @IsOptional()
  @IsString()
  @Length(8, 512)
  clientSecret?: string;
}

export class GoogleOAuthStartDto {
  @IsOptional()
  @IsString()
  @MaxLength(512)
  redirectAfter?: string;
}

export class GooglePublicUrlDto {
  @IsString()
  @MaxLength(2_048)
  publicUrl!: string;
}
