import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

const VALID_STATUSES = [
  'new',
  'contacted',
  'replied',
  'interested',
  'quoted',
  'won',
  'lost',
];

export class UpdateLeadStatusDto {
  @ApiProperty({
    enum: VALID_STATUSES,
    example: 'contacted',
  })
  @IsString()
  status: string;
}
