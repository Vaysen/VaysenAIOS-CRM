import { IsString, IsNumber, IsOptional, IsInt, Min } from 'class-validator';

export class CreateMaterialDto {
  @IsString()
  name: string;

  @IsString()
  type: string;

  @IsOptional()
  @IsString()
  colorHex?: string;

  @IsOptional()
  @IsString()
  textureUrl?: string;

  @IsNumber()
  @Min(0)
  priceModifier: number;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

export class UpdateMaterialDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsString()
  colorHex?: string;

  @IsOptional()
  @IsString()
  textureUrl?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  priceModifier?: number;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}
