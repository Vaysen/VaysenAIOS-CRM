import { IsString, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ChangePasswordDto {
  @ApiProperty({ description: 'Current password' })
  @IsString()
  currentPassword: string;

  @ApiProperty({ description: 'New password (min 6 characters)', minLength: 6 })
  @IsString()
  @MinLength(6)
  @MaxLength(100)
  newPassword: string;
}
