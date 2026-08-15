import { IsString, Length, Matches } from "class-validator";

export class ApplyUpdateDto {
  @IsString()
  @Matches(/^\d+\.\d+$/)
  targetVersion!: string;

  @IsString()
  @Length(12, 256)
  backupPassphrase!: string;

  @IsString()
  @Matches(/^UPGRADE$/)
  confirmation!: string;
}
