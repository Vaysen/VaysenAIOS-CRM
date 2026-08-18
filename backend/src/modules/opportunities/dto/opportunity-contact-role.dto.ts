import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { OPPORTUNITY_CONTACT_ROLE_TYPES } from '../opportunity-policy';

export class CreateOpportunityContactRoleDto {
  @ApiProperty()
  @IsString()
  contactId!: string;

  @ApiProperty({ enum: OPPORTUNITY_CONTACT_ROLE_TYPES })
  @IsIn([...OPPORTUNITY_CONTACT_ROLE_TYPES])
  roleType!: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

export class UpdateOpportunityContactRoleDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  contactId?: string;

  @ApiPropertyOptional({ enum: OPPORTUNITY_CONTACT_ROLE_TYPES })
  @IsOptional()
  @IsIn([...OPPORTUNITY_CONTACT_ROLE_TYPES])
  roleType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}
