import { IsInt, IsISO8601, IsNotEmpty, IsObject, IsOptional, IsString, Max, Min } from 'class-validator';

export class CreateFactProposalDto {
  @IsString()
  @IsNotEmpty()
  leadId!: string;

  @IsString()
  @IsNotEmpty()
  factKey!: string;

  @IsObject()
  value!: Record<string, unknown>;

  @IsString()
  @IsNotEmpty()
  sourceTitle!: string;

  @IsOptional()
  @IsString()
  sourceUri?: string;

  @IsOptional()
  @IsString()
  sourcePublisher?: string;

  @IsString()
  @IsNotEmpty()
  excerpt!: string;

  @IsString()
  @IsNotEmpty()
  locator!: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  capturedAt?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  publishedAt?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  confidenceScore?: number;
}
