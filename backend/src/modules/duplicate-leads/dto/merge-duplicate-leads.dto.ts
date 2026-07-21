import { IsOptional, IsObject, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class MergeDuplicateLeadsDto {
  @ApiProperty({ description: 'Field choice map: fieldName -> leadId to keep value from' })
  @IsObject()
  fieldChoices: Record<string, string>;

  @ApiPropertyOptional({ description: 'Merge notes' })
  @IsOptional()
  @IsString()
  notes?: string;
}
