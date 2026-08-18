import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Max, Min } from 'class-validator';
import { OPPORTUNITY_STAGES } from '../opportunity-policy';

export class TransitionOpportunityDto {
  @ApiProperty({ enum: OPPORTUNITY_STAGES })
  @IsIn([...OPPORTUNITY_STAGES])
  stage!: string;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  version!: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  probability?: number;

  @ApiPropertyOptional({ maxLength: 2_000 })
  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  note?: string;

  @ApiPropertyOptional({ description: 'Required only when moving to lost' })
  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  lostReason?: string;
}
