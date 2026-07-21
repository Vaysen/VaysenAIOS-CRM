import { Controller, Get, Post, Param, Body, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { Request } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { UnsubscribeService } from './unsubscribe.service';

class ConfirmUnsubscribeDto {
  @ApiPropertyOptional({ description: 'Reason for unsubscribing' })
  @IsOptional()
  @IsString()
  reason?: string;
}

@ApiTags('Unsubscribe')
@Controller('unsubscribe')
export class UnsubscribeController {
  constructor(private readonly unsubscribeService: UnsubscribeService) {}

  @Public()
  @Get(':token')
  @ApiOperation({ summary: 'Get unsubscribe page info' })
  getByToken(@Param('token') token: string) {
    return this.unsubscribeService.getByToken(token);
  }

  @Public()
  @Post(':token')
  @ApiOperation({ summary: 'Confirm unsubscribe' })
  confirm(
    @Param('token') token: string,
    @Body() dto: ConfirmUnsubscribeDto,
    @Req() req: Request,
  ) {
    const ipAddress = (req.headers['x-forwarded-for'] as string) || req.ip || req.socket.remoteAddress;
    return this.unsubscribeService.confirmUnsubscribe(token, ipAddress, dto.reason);
  }
}
