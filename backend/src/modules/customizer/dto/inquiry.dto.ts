import {
  IsString,
  IsOptional,
  IsInt,
  Min,
  Max,
  IsEmail,
  MaxLength,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';

/* ========================================
   SubmitInquiryDto (TASK-046: Security)
   - Added customer contact fields with validation
   - Rate limiting via controller decorator
   - Input length limits to prevent abuse
   ======================================== */

export class SubmitInquiryDto {
  @IsString()
  @MaxLength(100)
  designId: string;

  @IsInt()
  @Min(1)
  @Max(1000000)
  quantity: number;

  @IsString()
  @MaxLength(200)
  customerName: string;

  @IsEmail()
  @MaxLength(255)
  customerEmail: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Matches(/^[+0-9\s\-()]*$/, {
    message: 'Invalid phone number format',
  })
  customerPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  company?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

/* ========================================
   QueryInquiriesDto (Admin only)
   ======================================== */

export class QueryInquiriesDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  designId?: string;
}
