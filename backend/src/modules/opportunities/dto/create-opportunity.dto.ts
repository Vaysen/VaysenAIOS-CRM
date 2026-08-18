import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { OPPORTUNITY_STAGES } from '../opportunity-policy';

const decimalInput = ({ value }: { value: unknown }) =>
  value === null || value === undefined ? value : String(value);

export class CreateOpportunityDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  leadId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  description?: string;

  @ApiPropertyOptional({ enum: OPPORTUNITY_STAGES, default: 'new' })
  @IsOptional()
  @IsIn([...OPPORTUNITY_STAGES])
  stage?: string;

  @ApiPropertyOptional({
    example: '12500.00',
    description: 'Decimal(14,2), non-negative, maximum 999999999999.99',
  })
  @IsOptional()
  @Transform(decimalInput)
  @IsString()
  @Matches(/^\d{1,12}(\.\d{1,2})?$/)
  amount?: string | null;

  @ApiPropertyOptional({ default: 'USD', pattern: '^[A-Z]{3}$' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  probability?: number;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsISO8601({ strict: true })
  expectedCloseDate?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  nextStep?: string;

  @ApiPropertyOptional({
    description: 'Required and trimmed for lost; forbidden for every other initial stage',
    maxLength: 2_000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  lostReason?: string;

  @ApiPropertyOptional({ description: 'Only an active user in the active company' })
  @IsOptional()
  @IsString()
  ownerUserId?: string;
}
