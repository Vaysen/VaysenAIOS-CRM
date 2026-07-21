import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AddCompanyUserDto {
  @ApiProperty({ example: 'user-uuid' })
  @IsString()
  userId: string;

  @ApiProperty({ example: 'role-uuid' })
  @IsString()
  roleId: string;
}
