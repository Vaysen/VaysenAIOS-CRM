import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class RefreshDto {
  @ApiPropertyOptional({
    description: 'Non-browser compatibility mode only; browsers use the HttpOnly cookie',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  refreshToken?: string;
}
