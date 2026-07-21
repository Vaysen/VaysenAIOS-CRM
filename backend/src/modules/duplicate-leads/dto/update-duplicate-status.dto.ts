import { IsString, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

const VALID_STATUSES = ['confirmed', 'not_duplicate', 'ignored'];

export class UpdateDuplicateStatusDto {
  @ApiProperty({ enum: VALID_STATUSES })
  @IsString()
  @IsIn(VALID_STATUSES)
  status: string;
}
