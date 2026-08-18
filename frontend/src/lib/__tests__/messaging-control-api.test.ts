import { describe, expect, it } from 'vitest';
import {
  deliveryFailureFrom,
  parseBusinessEmailAccounts,
  parseEmailDeliveryReceipt,
  parseOwnerNotificationStatus,
  parseServerWhatsAppAccount,
  parseServerWhatsAppQr,
  plainTextToSafeHtml,
  replySubject,
} from '../messaging-control-api';

describe('messaging control API parsers', () => {
  it('minimizes a server WhatsApp account and drops auth state and QR material', () => {
    const account = parseServerWhatsAppAccount({
      id: 'wa-1',
      accountName: 'Linux Baileys',
      phoneNumber: '+8613800000000',
      status: 'connected',
      connectedAt: '2026-07-18T10:00:00.000Z',
      lastSeenAt: '2026-07-18T10:01:00.000Z',
      authStatePath: '/run/secrets/wa',
      qrCode: 'sensitive',
    });

    expect(account).toEqual({
      id: 'wa-1',
      accountName: 'Linux Baileys',
      phoneNumber: '+8613800000000',
      status: 'connected',
      connectedAt: '2026-07-18T10:00:00.000Z',
      lastSeenAt: '2026-07-18T10:01:00.000Z',
    });
    expect(account).not.toHaveProperty('authStatePath');
    expect(account).not.toHaveProperty('qrCode');
  });

  it('accepts only a bounded PNG data URL as a WhatsApp QR image', () => {
    expect(parseServerWhatsAppQr({
      status: 'waiting_scan',
      qrCode: `data:image/png;base64,${'A'.repeat(128)}`,
      expireAt: '2026-07-18T10:01:00.000Z',
    }).qrDataUrl).toMatch(/^data:image\/png;base64,/);

    expect(() => parseServerWhatsAppQr({
      status: 'waiting_scan',
      qrCode: 'https://third-party.example/qr?token=secret',
    })).toThrow('二维码未通过本地安全校验');
  });

  it('parses active email accounts without exposing SMTP passwords', () => {
    const accounts = parseBusinessEmailAccounts({
      data: [{
        id: 'mail-1',
        senderName: 'Vaysen Sales',
        senderEmail: 'sales@vaysen.com',
        replyToEmail: 'reply@reply.vaysen.com',
        status: 'active',
        smtpPasswordEncrypted: 'secret',
      }],
    });
    expect(accounts[0]).not.toHaveProperty('smtpPasswordEncrypted');
    expect(accounts[0].senderEmail).toBe('sales@vaysen.com');
  });

  it('requires an SMTP message id and accepted recipient before claiming success', () => {
    expect(parseEmailDeliveryReceipt({
      messageId: '<mail-1@example.com>',
      accepted: ['buyer@example.com'],
      response: '250 queued',
    })).toEqual({
      status: 'SUCCEEDED',
      messageId: '<mail-1@example.com>',
      accepted: ['buyer@example.com'],
      response: '250 queued',
    });
    expect(() => parseEmailDeliveryReceipt({ accepted: ['buyer@example.com'] })).toThrow(
      'SMTP 未返回 messageId',
    );
  });

  it('preserves an explicit server BLOCKED response instead of turning it into success', () => {
    expect(deliveryFailureFrom({
      isAxiosError: true,
      response: {
        data: {
          status: 'BLOCKED',
          code: 'EMAIL_SEND_DISABLED',
          message: 'Email delivery is blocked by the server safety switch',
        },
      },
    })).toEqual({
      status: 'BLOCKED',
      code: 'EMAIL_SEND_DISABLED',
      message: 'Email delivery is blocked by the server safety switch',
    });
  });

  it('escapes reply text and normalizes the reply subject', () => {
    expect(plainTextToSafeHtml('<script>alert("x")</script>\nThanks')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;<br>Thanks',
    );
    expect(replySubject('Inquiry')).toBe('Re: Inquiry');
    expect(replySubject('RE: Inquiry')).toBe('RE: Inquiry');
  });

  it('accepts a minimized tenant notification status without message content or raw WeChat ids', () => {
    expect(parseOwnerNotificationStatus({
      enabled: true,
      channel: 'openclaw-weixin',
      channelStatus: 'CONNECTED',
      counts: { pending: 1, sending: 0, sent: 3, failed: 0 },
      lastDelivery: {
        status: 'SENT',
        eventType: 'EMAIL_INBOUND',
        createdAt: '2026-07-18T10:00:00.000Z',
        sentAt: '2026-07-18T10:00:01.000Z',
        errorCode: null,
      },
    })).toMatchObject({
      available: true,
      channelStatus: 'CONNECTED',
      counts: { pending: 1, sent: 3, failed: 0 },
      lastDelivery: { status: 'SENT', eventType: 'EMAIL_INBOUND' },
    });
  });
});
