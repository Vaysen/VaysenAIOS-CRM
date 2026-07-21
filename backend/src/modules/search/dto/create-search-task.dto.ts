import { IsString, IsArray, IsOptional, IsInt, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateSearchTaskDto {
  @ApiProperty({ example: ['steel nails', 'fasteners'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  keywords?: string[];

  @ApiProperty({ example: 'USA' })
  @IsString()
  targetCountry: string;

  @ApiPropertyOptional({ example: 'importer' })
  @IsOptional()
  @IsString()
  customerType?: string;

  @ApiPropertyOptional({ example: ['alibaba', 'amazon'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  excludeWords?: string[];

  @ApiPropertyOptional({ example: 'en' })
  @IsOptional()
  @IsString()
  searchLanguage?: string;

  @ApiPropertyOptional({ example: 1, description: 'Layer ID (1-5) to restrict random category selection' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  layerId?: number;

  @ApiPropertyOptional({ example: 300 })
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(1000)
  maxResults?: number;
}
