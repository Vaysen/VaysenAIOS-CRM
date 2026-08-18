import { ArrayMaxSize, ArrayMinSize, IsArray, IsISO8601, IsOptional, IsString } from 'class-validator';

export class LegacyFactDryRunDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  records!: unknown[];

  @IsOptional()
  @IsISO8601({ strict: true })
  validationNow?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  allowlistedSourceRefs?: string[];
}
