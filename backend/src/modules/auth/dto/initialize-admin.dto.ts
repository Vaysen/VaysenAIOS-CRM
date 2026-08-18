import {
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class InitializeAdminDto {
  @ApiProperty()
  @IsString()
  @MinLength(32)
  @MaxLength(512)
  setupKey: string;

  @ApiProperty({ example: 'admin@example.com' })
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  email: string;

  @ApiProperty()
  @IsString()
  @MinLength(12)
  @MaxLength(100)
  password: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  firstName: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  lastName: string;

  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  companyName: string;
}
