import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import {
  OpenClawCustomerSearchDto,
  OpenClawCustomerNoteDto,
  OpenClawCustomerStageDto,
  OpenClawCustomerUpdateDto,
  OpenClawEmailReplyDto,
  OpenClawEmailSendDto,
  OpenClawMessageReadDto,
  OpenClawOrderCreateDto,
  OpenClawOrderStageDto,
  OpenClawPrepareQuoteDto,
  OpenClawProductSearchDto,
  OpenClawQuoteCreateDto,
  OpenClawSelectionToolDto,
  OpenClawStartResearchDto,
  OpenClawTaskCreateDto,
  OpenClawWorkBriefDto,
  OpenClawWhatsappSendDto,
  OpenClawWhatsappQuoteSendDto,
} from './dto/openclaw-tool.dto';
import { OpenClawHmacGuard } from './openclaw-hmac.guard';
import { OpenClawToolBrokerService } from './openclaw-tool-broker.service';
import type { OpenClawSignedRequest } from './openclaw.types';

@Public()
@UseGuards(OpenClawHmacGuard)
@Controller('internal/openclaw/tools')
export class OpenClawInternalController {
  constructor(private readonly broker: OpenClawToolBrokerService) {}

  @Post('work-brief')
  workBrief(@Body() body: OpenClawWorkBriefDto, @Req() request: OpenClawSignedRequest) {
    return this.broker.execute('work-brief', body, request.openClawVerified);
  }

  @Post('customer-search')
  customerSearch(@Body() body: OpenClawCustomerSearchDto, @Req() request: OpenClawSignedRequest) {
    return this.broker.execute('customer-search', body, request.openClawVerified);
  }

  @Post('prepare-quote-delivery')
  prepareQuote(@Body() body: OpenClawPrepareQuoteDto, @Req() request: OpenClawSignedRequest) {
    return this.broker.execute('prepare-quote-delivery', body, request.openClawVerified);
  }

  @Post('start-background-research')
  startResearch(@Body() body: OpenClawStartResearchDto, @Req() request: OpenClawSignedRequest) {
    return this.broker.execute('start-background-research', body, request.openClawVerified);
  }

  @Post('customer-get')
  customerGet(@Body() body: OpenClawSelectionToolDto, @Req() request: OpenClawSignedRequest) {
    return this.broker.execute('customer-get', body, request.openClawVerified);
  }

  @Post('customer-add-note')
  customerAddNote(@Body() body: OpenClawCustomerNoteDto, @Req() request: OpenClawSignedRequest) {
    return this.broker.execute('customer-add-note', body, request.openClawVerified);
  }

  @Post('customer-set-stage')
  customerSetStage(@Body() body: OpenClawCustomerStageDto, @Req() request: OpenClawSignedRequest) {
    return this.broker.execute('customer-set-stage', body, request.openClawVerified);
  }

  @Post('customer-update')
  customerUpdate(@Body() body: OpenClawCustomerUpdateDto, @Req() request: OpenClawSignedRequest) {
    return this.broker.execute('customer-update', body, request.openClawVerified);
  }

  @Post('task-create')
  taskCreate(@Body() body: OpenClawTaskCreateDto, @Req() request: OpenClawSignedRequest) {
    return this.broker.execute('task-create', body, request.openClawVerified);
  }

  @Post('order-list')
  orderList(@Body() body: OpenClawSelectionToolDto, @Req() request: OpenClawSignedRequest) {
    return this.broker.execute('order-list', body, request.openClawVerified);
  }

  @Post('order-create-draft')
  orderCreateDraft(@Body() body: OpenClawOrderCreateDto, @Req() request: OpenClawSignedRequest) {
    return this.broker.execute('order-create-draft', body, request.openClawVerified);
  }

  @Post('order-update-stage')
  orderUpdateStage(@Body() body: OpenClawOrderStageDto, @Req() request: OpenClawSignedRequest) {
    return this.broker.execute('order-update-stage', body, request.openClawVerified);
  }

  @Post('quote-list')
  quoteList(@Body() body: OpenClawSelectionToolDto, @Req() request: OpenClawSignedRequest) {
    return this.broker.execute('quote-list', body, request.openClawVerified);
  }

  @Post('quote-create-draft')
  quoteCreateDraft(@Body() body: OpenClawQuoteCreateDto, @Req() request: OpenClawSignedRequest) {
    return this.broker.execute('quote-create-draft', body, request.openClawVerified);
  }

  @Post('product-search')
  productSearch(@Body() body: OpenClawProductSearchDto, @Req() request: OpenClawSignedRequest) {
    return this.broker.execute('product-search', body, request.openClawVerified);
  }

  @Post('whatsapp-messages-read')
  whatsappMessagesRead(@Body() body: OpenClawMessageReadDto, @Req() request: OpenClawSignedRequest) {
    return this.broker.execute('whatsapp-messages-read', body, request.openClawVerified);
  }

  @Post('whatsapp-send-text')
  whatsappSendText(@Body() body: OpenClawWhatsappSendDto, @Req() request: OpenClawSignedRequest) {
    return this.broker.execute('whatsapp-send-text', body, request.openClawVerified);
  }

  @Post('whatsapp-send-quote')
  whatsappSendQuote(@Body() body: OpenClawWhatsappQuoteSendDto, @Req() request: OpenClawSignedRequest) {
    return this.broker.execute('whatsapp-send-quote', body, request.openClawVerified);
  }

  @Post('email-messages-read')
  emailMessagesRead(@Body() body: OpenClawMessageReadDto, @Req() request: OpenClawSignedRequest) {
    return this.broker.execute('email-messages-read', body, request.openClawVerified);
  }

  @Post('email-send')
  emailSend(@Body() body: OpenClawEmailSendDto, @Req() request: OpenClawSignedRequest) {
    return this.broker.execute('email-send', body, request.openClawVerified);
  }

  @Post('email-reply')
  emailReply(@Body() body: OpenClawEmailReplyDto, @Req() request: OpenClawSignedRequest) {
    return this.broker.execute('email-reply', body, request.openClawVerified);
  }
}
