import { IsString, IsNumber, IsOptional, IsInt, Min, IsObject } from 'class-validator';

export class UpdateTemplateDto {
  @IsOptional()
  @IsString()
  productId?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  slug?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  basePrice?: number;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  moq?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  leadTimeDays?: number;

  @IsOptional()
  @IsInt()
  @Min(256)
  textureSize?: number;

  @IsOptional()
  @IsObject()
  unfoldLayout?: Record<string, any>;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}
