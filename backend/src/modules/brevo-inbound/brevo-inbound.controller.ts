import { Body, Controller, Get, Headers, HttpCode, HttpException, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { BrevoInboundService } from './brevo-inbound.service';

const BREVO_INBOUND_PROCESSING_ERROR = 'BREVO_INBOUND_PROCESSING_FAILED';

function toPublicProcessingException(error: unknown) {
  const status = error instanceof HttpException
    ? error.getStatus()
    : HttpStatus.INTERNAL_SERVER_ERROR;
  return new HttpException({
    statusCode: status,
    code: BREVO_INBOUND_PROCESSING_ERROR,
    message: 'Brevo inbound processing failed',
  }, status);
}

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
    try {
      return await this.service.ingest(payload);
    } catch (error) {
      throw toPublicProcessingException(error);
    }
  }
}
