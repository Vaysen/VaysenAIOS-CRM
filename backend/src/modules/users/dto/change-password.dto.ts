import { IsString, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ChangePasswordDto {
  @ApiProperty({ description: 'Current password' })
  @IsString()
  currentPassword: string;

  @ApiProperty({ description: 'New password (min 12 characters)', minLength: 12 })
  @IsString()
  @MinLength(12)
  @MaxLength(100)
  newPassword: string;
}
