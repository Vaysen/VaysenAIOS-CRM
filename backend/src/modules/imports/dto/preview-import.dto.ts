import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsObject } from 'class-validator';

export class PreviewImportDto {
  @ApiProperty({ description: 'Parse token from upload' })
  @IsString()
  parseToken: string;

  @ApiProperty({ description: 'Field mapping: CSV header → Lead field name' })
  @IsObject()
  fieldMapping: Record<string, string>;
}
