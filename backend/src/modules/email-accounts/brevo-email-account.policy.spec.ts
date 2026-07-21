import { BadRequestException } from '@nestjs/common';
import { assertBrevoReceivingConfig } from './brevo-email-account.policy';

describe('Brevo email account policy', () => {
  it('rejects a Brevo account without a CRM receiving address', () => {
    expect(() => assertBrevoReceivingConfig('smtp-relay.brevo.com', ''))
      .toThrow(BadRequestException);
  });

  it('rejects a malformed Brevo CRM receiving address', () => {
    expect(() => assertBrevoReceivingConfig('SMTP-RELAY.BREVO.COM', 'sales'))
      .toThrow(/valid Reply-To/);
  });

  it('accepts a valid Brevo CRM receiving address', () => {
    expect(() => assertBrevoReceivingConfig(
      'smtp-relay.brevo.com',
      'sales@reply.example.com',
    )).not.toThrow();
  });

  it('does not impose the Brevo receiving contract on other SMTP providers', () => {
    expect(() => assertBrevoReceivingConfig('smtp.example.com', null)).not.toThrow();
  });
});
