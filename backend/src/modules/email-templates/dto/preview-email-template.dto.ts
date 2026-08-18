import { IsObject } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class PreviewEmailTemplateDto {
  @ApiProperty({
    description: 'Variable values for preview',
    example: {
      contact_name: 'John Smith',
      company_name: 'ABC Foods Ltd',
      country: 'United States',
      product_name: 'Macaroni Production Line',
      sender_name: 'Chris',
      sender_company: 'Vaysen Packaging',
      sender_website: 'https://vaysen.com',
      website: 'https://example.com',
      pain_point: 'improve production efficiency',
      last_email_date: '2026-05-28',
    },
  })
  @IsObject()
  variables: Record<string, string>;
}
