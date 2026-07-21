import { IsString, IsNumber, IsOptional, IsInt, Min } from 'class-validator';

export class CreateLogoEffectDto {
  @IsString()
  name: string;

  @IsString()
  label: string;

  @IsOptional()
  @IsString()
  previewUrl?: string;

  @IsNumber()
  @Min(0)
  pricePerColor: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  minColors?: number;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

export class UpdateLogoEffectDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  label?: string;

  @IsOptional()
  @IsString()
  previewUrl?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  pricePerColor?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  minColors?: number;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}
