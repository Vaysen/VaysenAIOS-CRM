import {
  Body,
  Controller,
  Delete,
  Get,
  GoneException,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Response } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { QuotesService } from './quotes.service';

@ApiTags('Quotes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('quotes')
export class QuotesController {
  constructor(private readonly quotesService: QuotesService) {}

  @Get()
  @ApiOperation({ summary: 'List all quotes (company-scoped)' })
  findAll(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('type') type?: string,
    @Query('status') status?: string,
    @Query('leadId') leadId?: string,
    @CurrentUser() user?: any,
  ) {
    return this.quotesService.findAll(user, {
      page: Number(page) || 1,
      limit: Number(limit) || 20,
      type,
      status,
      leadId,
    });
  }

  @Post()
  @ApiOperation({ summary: 'Create a quote draft with multiple line items' })
  create(@Body() dto: any, @CurrentUser() user: any) {
    return this.quotesService.createQuote(dto, user);
  }

  @Get('lead/:leadId')
  @ApiOperation({ summary: 'List quotes for a lead' })
  listByLead(@Param('leadId') leadId: string, @CurrentUser() user: any) {
    return this.quotesService.listByLead(leadId, user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single quote by ID with line items' })
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.quotesService.findOne(id, user);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update quote (fields and/or line items)' })
  update(@Param('id') id: string, @Body() dto: any, @CurrentUser() user: any) {
    return this.quotesService.updateQuote(id, dto, user);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a quote' })
  delete(@Param('id') id: string, @CurrentUser() user: any) {
    return this.quotesService.deleteQuote(id, user);
  }

  @Post(':id/line-items')
  @ApiOperation({ summary: 'Add a line item to a quote' })
  addLineItem(@Param('id') id: string, @Body() dto: any, @CurrentUser() user: any) {
    return this.quotesService.addLineItem(id, dto, user);
  }

  @Patch(':id/line-items/:itemId')
  @ApiOperation({ summary: 'Update a line item' })
  updateLineItem(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() dto: any,
    @CurrentUser() user: any,
  ) {
    return this.quotesService.updateLineItem(id, itemId, dto, user);
  }

  @Delete(':id/line-items/:itemId')
  @ApiOperation({ summary: 'Delete a line item' })
  deleteLineItem(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @CurrentUser() user: any,
  ) {
    return this.quotesService.deleteLineItem(id, itemId, user);
  }

  @Post(':id/calculate')
  @ApiOperation({ summary: 'Recalculate quote totals' })
  calculate(@Param('id') id: string, @CurrentUser() user: any) {
    return this.quotesService.calculate(id, user);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Update quote status' })
  updateStatus(
    @Param('id') id: string,
    @Body('status') status: string,
    @CurrentUser() user: any,
  ) {
    return this.quotesService.updateStatus(id, status, user);
  }

  @Post(':id/convert-to-order')
  @ApiOperation({ summary: 'Convert quote to order' })
  convertToOrder(@Param('id') id: string, @CurrentUser() user: any) {
    return this.quotesService.convertToOrder(id, user);
  }

  @Get(':id/pi')
  @ApiOperation({ summary: 'Generate PI HTML for a quote' })
  async generatePi(@Param('id') id: string, @CurrentUser() user: any, @Res() res: Response) {
    const html = await this.quotesService.generatePiHtml(id, user);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  }

  @Get(':id/pdf')
  @ApiOperation({ summary: 'Generate PI PDF for a quote' })
  async generatePdf(@Param('id') id: string, @CurrentUser() user: any, @Res() res: Response) {
    const html = await this.quotesService.generatePiHtml(id, user);
    const pdfBuffer = await this.quotesService.htmlToPdf(html);
    const quote = await this.quotesService.findOne(id, user);
    const filename = `${quote.referenceNo || id}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdfBuffer);
  }

  @Post(':id/send-whatsapp-pdf')
  @ApiOperation({
    summary: 'Retired: automatic WhatsApp PDF delivery is no longer available',
  })
  sendWhatsappPdf(): never {
    throw new GoneException({
      statusCode: 410,
      code: 'QUOTE_WHATSAPP_AUTO_SEND_RETIRED',
      message:
        '该自动外发接口已永久停用：它无法安全验证客户、会话、群聊、幂等与逐次审批。请在 AI 业务助理中“准备报价 PDF”，下载后由人工拖拽到 WhatsApp 对话并确认发送。',
    });
  }
}
