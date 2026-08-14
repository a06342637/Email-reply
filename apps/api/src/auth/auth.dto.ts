import {
  IsIn,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  MinLength,
} from "class-validator";

export class LoginDto {
  @IsString()
  @Length(1, 128)
  username!: string;

  @IsString()
  @Length(1, 256)
  password!: string;

  @IsOptional()
  @IsString()
  @Length(6, 32)
  totpCode?: string;
}

export class ChangePasswordDto {
  @IsString()
  @MaxLength(256)
  currentPassword!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(256)
  newPassword!: string;
}

export class TotpCodeDto {
  @IsString()
  @Length(6, 32)
  code!: string;
}

export class DisableTotpDto {
  @IsString()
  @Length(1, 256)
  password!: string;
}

export class ThemeDto {
  @IsIn(["dark", "light", "system"])
  theme!: "dark" | "light" | "system";
}
