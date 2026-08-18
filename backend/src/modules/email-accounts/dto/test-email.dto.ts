import { IsEmail, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class TestEmailDto {
  @ApiProperty({ description: 'Recipient email address for the test email' })
  @IsEmail()
  @IsString()
  recipientEmail: string;

  @ApiProperty({ description: 'Tenant-scoped lead whose verified email must match the recipient' })
  @IsUUID()
  leadId: string;

  @ApiProperty({ description: 'Canonical retry key', minLength: 8, maxLength: 200 })
  @IsOptional()
  @IsString()
  @Length(8, 200)
  idempotencyKey?: string;
}
