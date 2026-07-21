import { GoneException } from '@nestjs/common';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { QuotesController } from './quotes.controller';

describe('QuotesController retired WhatsApp PDF delivery', () => {
  it('returns 410 without generating a PDF, sending WhatsApp media, or writing a message', () => {
    const quotesService = {
      generatePiHtml: jest.fn(),
      htmlToPdf: jest.fn(),
      findOne: jest.fn(),
    };
    const controller = new QuotesController(quotesService as any);

    let caught: unknown;
    try {
      controller.sendWhatsappPdf();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(GoneException);
    expect((caught as GoneException).getStatus()).toBe(410);
    expect((caught as GoneException).getResponse()).toEqual(
      expect.objectContaining({
        code: 'QUOTE_WHATSAPP_AUTO_SEND_RETIRED',
        message: expect.stringContaining('人工拖拽到 WhatsApp'),
      }),
    );
    expect(quotesService.generatePiHtml).not.toHaveBeenCalled();
    expect(quotesService.htmlToPdf).not.toHaveBeenCalled();
    expect(quotesService.findOne).not.toHaveBeenCalled();
  });

  it('keeps WhatsApp delivery and communication-message writes out of this controller', () => {
    const controllerSource = readFileSync(
      resolve(__dirname, 'quotes.controller.ts'),
      'utf8',
    );

    expect(controllerSource).not.toContain('WhatsAppService');
    expect(controllerSource).not.toContain('sendMediaOnly');
    expect(controllerSource).not.toContain('communicationMessage.create');
  });

  it('keeps the authenticated PDF download flow available', async () => {
    const pdfBuffer = Buffer.from('pdf');
    const user = { id: 'user-1', companyId: 'company-1' };
    const quotesService = {
      generatePiHtml: jest.fn().mockResolvedValue('<html>quote</html>'),
      htmlToPdf: jest.fn().mockResolvedValue(pdfBuffer),
      findOne: jest.fn().mockResolvedValue({ referenceNo: 'QT-2026-001' }),
    };
    const response = {
      setHeader: jest.fn(),
      send: jest.fn(),
    };
    const controller = new QuotesController(quotesService as any);

    await controller.generatePdf('quote-1', user, response as any);

    expect(quotesService.generatePiHtml).toHaveBeenCalledWith('quote-1', user);
    expect(quotesService.htmlToPdf).toHaveBeenCalledWith('<html>quote</html>');
    expect(quotesService.findOne).toHaveBeenCalledWith('quote-1', user);
    expect(response.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'application/pdf',
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="QT-2026-001.pdf"',
    );
    expect(response.send).toHaveBeenCalledWith(pdfBuffer);
  });
});
