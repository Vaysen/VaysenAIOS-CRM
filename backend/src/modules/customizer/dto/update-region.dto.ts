import { IsString, IsNumber, IsBoolean, IsOptional, IsInt } from 'class-validator';

export class UpdateRegionDto {
  @IsOptional()
  @IsString()
  label?: string;

  @IsOptional()
  @IsNumber()
  uvX?: number;

  @IsOptional()
  @IsNumber()
  uvY?: number;

  @IsOptional()
  @IsNumber()
  uvW?: number;

  @IsOptional()
  @IsNumber()
  uvH?: number;

  @IsOptional()
  @IsNumber()
  unfoldX?: number;

  @IsOptional()
  @IsNumber()
  unfoldY?: number;

  @IsOptional()
  @IsNumber()
  unfoldW?: number;

  @IsOptional()
  @IsNumber()
  unfoldH?: number;

  @IsOptional()
  @IsBoolean()
  isEditable?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}
