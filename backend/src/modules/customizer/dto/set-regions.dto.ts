import { IsArray, ValidateNested, IsString, IsNumber, IsBoolean, IsOptional, IsInt } from 'class-validator';
import { Type } from 'class-transformer';

export class RegionItemDto {
  @IsString()
  regionId: string;

  @IsString()
  label: string;

  @IsNumber()
  uvX: number;

  @IsNumber()
  uvY: number;

  @IsNumber()
  uvW: number;

  @IsNumber()
  uvH: number;

  @IsNumber()
  unfoldX: number;

  @IsNumber()
  unfoldY: number;

  @IsNumber()
  unfoldW: number;

  @IsNumber()
  unfoldH: number;

  @IsOptional()
  @IsBoolean()
  isEditable?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

export class SetRegionsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RegionItemDto)
  regions: RegionItemDto[];
}
