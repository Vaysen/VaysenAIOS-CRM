import { IsString, IsOptional, IsNumber, IsArray, IsObject } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateProductDto {
  @ApiProperty({ example: 'BOLT-M8-001' })
  @IsString()
  sku: string;

  @ApiProperty({ example: 'M8 六角螺栓 304不锈钢' })
  @IsString()
  name: string;

  @ApiProperty({ example: 'category-uuid' })
  @IsString()
  categoryId: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ example: 'MX-001' })
  @IsOptional()
  @IsString()
  productCode?: string;

  @ApiPropertyOptional({ example: '牛皮纸+CPP' })
  @IsOptional()
  @IsString()
  material?: string;

  @ApiPropertyOptional({ example: '双面28丝' })
  @IsOptional()
  @IsString()
  thickness?: string;

  @ApiPropertyOptional({ example: 'stand_up' })
  @IsOptional()
  @IsString()
  productType?: string;

  @ApiPropertyOptional({ example: 0.15 })
  @IsOptional()
  @IsNumber()
  basePrice?: number;

  @ApiPropertyOptional({ example: 'USD' })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiPropertyOptional({ example: { '直径': 'M8', '长度': '50mm', '材质': '304不锈钢' } })
  @IsOptional()
  @IsObject()
  attributes?: Record<string, any>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  images?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  categoryName?: string; // 可选：通过名称自动创建品类
}

export class UpdateProductDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sku?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  categoryId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ example: 'MX-001' })
  @IsOptional()
  @IsString()
  productCode?: string;

  @ApiPropertyOptional({ example: '牛皮纸+CPP' })
  @IsOptional()
  @IsString()
  material?: string;

  @ApiPropertyOptional({ example: '双面28丝' })
  @IsOptional()
  @IsString()
  thickness?: string;

  @ApiPropertyOptional({ example: 'stand_up' })
  @IsOptional()
  @IsString()
  productType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  basePrice?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  attributes?: Record<string, any>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  images?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  categoryName?: string;
}
