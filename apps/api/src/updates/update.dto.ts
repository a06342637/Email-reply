import { IsString, Matches } from "class-validator";

export class ApplyUpdateDto {
  @IsString()
  @Matches(/^\d+\.\d+$/)
  targetVersion!: string;
}
