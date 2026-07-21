import { IsEmail, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class TestEmailDto {
  @ApiProperty({ description: 'Recipient email address for the test email' })
  @IsEmail()
  @IsString()
  recipientEmail: string;
}
