import { IsString, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

const VALID_STATUSES = ['active', 'inactive', 'testing', 'failed', 'suspended'];

export class UpdateEmailAccountStatusDto {
  @ApiProperty({ description: 'Account status', enum: VALID_STATUSES })
  @IsString()
  @IsIn(VALID_STATUSES)
  status: string;
}
