import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class CreateProductSpecDto {
  @IsOptional() @IsString()
  specCode?: string;

  @IsString()
  size: string;

  @IsOptional() @IsNumber()
  widthCm?: number;

  @IsOptional() @IsNumber()
  lengthCm?: number;

  @IsOptional() @IsNumber()
  gussetCm?: number;

  @IsOptional() @IsString()
  thicknessCm?: string;

  @IsNumber() @Min(0)
  unitPrice: number;

  @IsOptional() @IsInt() @Min(1)
  moq?: number;

  @IsOptional() @IsInt() @Min(1)
  packPerBundle?: number;

  @IsOptional() @IsNumber()
  bundleWeightKg?: number;

  @IsOptional() @IsString()
  cartonSize?: string;

  @IsOptional() @IsNumber()
  cartonLengthCm?: number;

  @IsOptional() @IsNumber()
  cartonWidthCm?: number;

  @IsOptional() @IsNumber()
  cartonHeightCm?: number;
}

export class UpdateProductSpecDto {
  @IsOptional() @IsString()
  specCode?: string;

  @IsOptional() @IsString()
  size?: string;

  @IsOptional() @IsNumber()
  widthCm?: number;

  @IsOptional() @IsNumber()
  lengthCm?: number;

  @IsOptional() @IsNumber()
  gussetCm?: number;

  @IsOptional() @IsString()
  thicknessCm?: string;

  @IsOptional() @IsNumber() @Min(0)
  unitPrice?: number;

  @IsOptional() @IsInt() @Min(1)
  moq?: number;

  @IsOptional() @IsInt() @Min(1)
  packPerBundle?: number;

  @IsOptional() @IsNumber()
  bundleWeightKg?: number;

  @IsOptional() @IsString()
  cartonSize?: string;

  @IsOptional() @IsNumber()
  cartonLengthCm?: number;

  @IsOptional() @IsNumber()
  cartonWidthCm?: number;

  @IsOptional() @IsNumber()
  cartonHeightCm?: number;
}
