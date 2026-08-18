import { BusinessMailController } from './business-mail.controller';

describe('BusinessMailController trust boundary', () => {
  it('ignores HTTP actor and authorization claims and binds the authenticated human action', async () => {
    const businessMailService = {
      sendMail: jest.fn().mockResolvedValue({ messageId: 'provider-message-1' }),
    };
    const controller = new BusinessMailController(businessMailService as any);
    const user = {
      id: 'admin-1',
      activeCompanyId: 'company-1',
      companies: [{ id: 'company-1', role: 'company_admin' }],
    };
    const body: any = {
      emailAccountId: 'account-1',
      to: 'buyer@example.com',
      subject: 'Subject',
      html: '<p>Body</p>',
      leadId: 'lead-1',
      idempotencyKey: 'body:key-0001',
      actorType: 'AGENT',
      authorization: { capability: 'crm.email.send' },
    };

    await controller.send(body, 'header:key-0001', user);

    expect(businessMailService.sendMail).toHaveBeenCalledWith({
      emailAccountId: 'account-1',
      to: 'buyer@example.com',
      subject: 'Subject',
      html: '<p>Body</p>',
      conversationId: undefined,
      leadId: 'lead-1',
      attachments: undefined,
      idempotencyKey: 'header:key-0001',
      actorType: 'HUMAN',
      actionType: 'RAW_SMTP',
    }, user);
  });
});
