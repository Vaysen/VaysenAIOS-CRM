import { Body, Controller, Get, Headers, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { BrevoInboundService } from './brevo-inbound.service';

@ApiTags('Brevo Email Integration')
@Controller('integrations/brevo')
export class BrevoInboundController {
  constructor(private readonly service: BrevoInboundService) {}

  @Get('status')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get Brevo SMTP and inbound email integration status' })
  getStatus() {
    return this.service.getStatus();
  }

  @Post('inbound-email')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Receive parsed inbound emails from Brevo' })
  async inboundEmail(
    @Body() payload: any,
    @Headers('authorization') authorization?: string,
  ) {
    this.service.assertAuthorized(authorization);
    return this.service.ingest(payload);
  }
}
