import { IsArray, IsString, IsIn, IsOptional, ValidateNested, IsUUID, IsBoolean, IsObject } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

const VALID_STATUSES = ['new', 'contacted', 'replied', 'interested', 'quoted', 'won', 'lost'] as const;

class BatchOperationData {
  @ApiPropertyOptional({ enum: VALID_STATUSES, description: 'Target status for updateStatus action' })
  @IsOptional()
  @IsString()
  @IsIn(VALID_STATUSES)
  status?: string;

  @ApiPropertyOptional({ description: 'Target owner user ID for assignOwner action' })
  @IsOptional()
  @IsUUID('4')
  ownerUserId?: string;
}

export class BatchOperationDto {
  @ApiProperty({ description: 'Array of lead IDs to operate on', type: [String] })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  ids?: string[];

  @ApiProperty({ enum: ['updateStatus', 'delete', 'assignOwner'], description: 'Type of batch operation' })
  @IsString()
  @IsIn(['updateStatus', 'delete', 'assignOwner'])
  action: 'updateStatus' | 'delete' | 'assignOwner';

  @ApiPropertyOptional({ description: 'Additional data for the operation' })
  @IsOptional()
  @ValidateNested()
  @Type(() => BatchOperationData)
  data?: BatchOperationData;

  @ApiPropertyOptional({ description: 'Apply operation to all leads matching current filters across pages' })
  @IsOptional()
  @IsBoolean()
  selectAll?: boolean;

  @ApiPropertyOptional({ description: 'Filters used when selectAll is true' })
  @IsOptional()
  @IsObject()
  filters?: Record<string, any>;
}
