import { IsString, Length } from "class-validator";

export class ExportBackupDto {
  @IsString()
  @Length(12, 4_096)
  passphrase!: string;

  @IsString()
  @Length(12, 4_096)
  confirmation!: string;
}
