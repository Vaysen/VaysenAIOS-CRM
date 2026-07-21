import { IsString, IsOptional, IsBoolean, IsInt, IsArray, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AttrType } from '@prisma/client';

export class CreateAttributeDto {
  @ApiProperty({ example: '直径' })
  @IsString()
  name: string;

  @ApiProperty({ enum: AttrType, example: 'SELECT' })
  @IsEnum(AttrType)
  type: AttrType;

  @ApiPropertyOptional({ example: ['M6', 'M8', 'M10'] })
  @IsOptional()
  @IsArray()
  options?: string[];

  @ApiPropertyOptional({ example: 'mm' })
  @IsOptional()
  @IsString()
  unit?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

export class UpdateAttributeDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ enum: AttrType })
  @IsOptional()
  @IsEnum(AttrType)
  type?: AttrType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  options?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  unit?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  sortOrder?: number;
}
