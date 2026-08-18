import { BadRequestException } from '@nestjs/common';
import { resolveSmtpEgress } from './smtp-egress.policy';

describe('SMTP egress policy', () => {
  const originalAllowlist = process.env.SMTP_EGRESS_ALLOWED_RELAYS;

  beforeEach(() => {
    process.env.SMTP_EGRESS_ALLOWED_RELAYS = 'smtp.example.org:465:tls,smtp.example.net:587:starttls';
  });

  afterAll(() => {
    if (originalAllowlist === undefined) delete process.env.SMTP_EGRESS_ALLOWED_RELAYS;
    else process.env.SMTP_EGRESS_ALLOWED_RELAYS = originalAllowlist;
  });

  it('rejects arbitrary hosts, IP literals and unsafe port/TLS combinations before DNS', async () => {
    const resolver = jest.fn();
    await expect(resolveSmtpEgress({
      smtpHost: 'attacker.example',
      smtpPort: 465,
      smtpSecure: true,
    }, resolver)).rejects.toBeInstanceOf(BadRequestException);
    await expect(resolveSmtpEgress({
      smtpHost: '127.0.0.1',
      smtpPort: 465,
      smtpSecure: true,
    }, resolver)).rejects.toBeInstanceOf(BadRequestException);
    await expect(resolveSmtpEgress({
      smtpHost: 'smtp.example.org',
      smtpPort: 25,
      smtpSecure: false,
    }, resolver)).rejects.toBeInstanceOf(BadRequestException);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('rejects any private DNS answer and pins an allowed public address', async () => {
    await expect(resolveSmtpEgress({
      smtpHost: 'smtp.example.org',
      smtpPort: 465,
      smtpSecure: true,
    }, async () => [
      { address: '203.0.113.10', family: 4 },
      { address: '10.0.0.8', family: 4 },
    ])).rejects.toBeInstanceOf(BadRequestException);

    const result = await resolveSmtpEgress({
      smtpHost: 'smtp.example.net.',
      smtpPort: 587,
      smtpSecure: false,
    }, async () => [{ address: '8.8.8.8', family: 4 }]);
    expect(result).toMatchObject({
      host: '8.8.8.8',
      port: 587,
      secure: false,
      requireTLS: true,
      tls: {
        servername: 'smtp.example.net',
        minVersion: 'TLSv1.2',
        rejectUnauthorized: true,
      },
    });
  });

  it.each([
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::127.0.0.1',
    '::ffff:0:127.0.0.1',
    '2002:7f00:0001::',
    '64:ff9b::7f00:1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
  ])('rejects mapped or non-public IPv6 DNS answer %s', async (address) => {
    await expect(resolveSmtpEgress({
      smtpHost: 'smtp.example.org',
      smtpPort: 465,
      smtpSecure: true,
    }, async () => [{ address, family: 6 }])).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a mixed public/private answer set instead of selecting only the public answer', async () => {
    await expect(resolveSmtpEgress({
      smtpHost: 'smtp.example.net',
      smtpPort: 587,
      smtpSecure: false,
    }, async () => [
      { address: '2606:4700:4700::1111', family: 6 },
      { address: '::ffff:10.0.0.1', family: 6 },
    ])).rejects.toBeInstanceOf(BadRequestException);
  });

  it('gives the real Nodemailer SMTPConnection the vetted IP while preserving relay SNI', async () => {
    // Exercise Nodemailer's actual SMTPConnection options rather than manually
    // invoking a callback that the transport may never consume.
    const SMTPConnection = require('nodemailer/lib/smtp-connection');
    let dnsAnswer = '8.8.4.4';
    const resolver = jest.fn(async () => [{ address: dnsAnswer, family: 4 }]);
    const result = await resolveSmtpEgress({
      smtpHost: 'smtp.example.org',
      smtpPort: 465,
      smtpSecure: true,
    }, resolver);
    dnsAnswer = '127.0.0.1';

    const connection = new SMTPConnection(result);
    expect((connection as any).options).toMatchObject({
      host: '8.8.4.4',
      port: 465,
      secure: true,
      tls: {
        servername: 'smtp.example.org',
        rejectUnauthorized: true,
      },
    });
    expect(resolver).toHaveBeenCalledTimes(1);
  });
});
