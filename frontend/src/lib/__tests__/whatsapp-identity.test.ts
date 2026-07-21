import { describe, expect, it } from 'vitest';
import {
  findUniqueExactMatch,
  findLeadByTrustedWhatsAppIdentity,
  normalizeWhatsAppName,
  normalizeWhatsAppPhone,
  sanitizeWhatsAppDisplayName,
} from '../whatsapp-identity';

describe('WhatsApp identity fail-closed helpers', () => {
  it.each([
    '最后上线于2026年6月26日06:05',
    '正在输入…',
    'last seen yesterday at 10:00',
    'typing...',
    '在线',
  ])('拒绝状态文案: %s', (value) => {
    expect(sanitizeWhatsAppDisplayName(value)).toBeNull();
  });

  it('保留并规范真实姓名', () => {
    expect(sanitizeWhatsAppDisplayName('  Sample Buyer  ')).toBe('Sample Buyer');
    expect(normalizeWhatsAppName('  Sample Buyer  ')).toBe('sample buyer');
  });

  it('号码只做完整规范化，不截取尾号', () => {
    expect(normalizeWhatsAppPhone('+86 153 0600 1234')).toBe('8615306001234');
    expect(normalizeWhatsAppPhone('0086 153 0600 1234')).toBe('8615306001234');
  });

  it('仅唯一精确命中时返回结果', () => {
    const values = [{ name: 'sample buyer' }, { name: 'other' }];
    expect(findUniqueExactMatch(values, 'sample buyer', (item) => item.name)).toEqual(values[0]);
    expect(findUniqueExactMatch([...values, { name: 'sample buyer' }], 'sample buyer', (item) => item.name)).toBeUndefined();
    expect(findUniqueExactMatch(values, 'sample', (item) => item.name)).toBeUndefined();
  });

  it('可信 WhatsApp ContactPoint 优先于旧字段中的重复号码', () => {
    const canonical = {
      id: 'canonical',
      contactPoints: [{
        type: 'whatsapp',
        normalizedValue: '+8615306009641',
        isVerified: true,
      }],
    };
    const staleDuplicate = {
      id: 'duplicate',
      whatsapp: '+8615306009641',
      contactPoints: [],
    };

    expect(findLeadByTrustedWhatsAppIdentity(
      [staleDuplicate, canonical],
      '+86 153 0600 9641',
    )).toEqual(canonical);
  });

  it('没有可信 ContactPoint 时只接受唯一旧号码命中', () => {
    const duplicated = [
      { id: 'one', contactPhone: '+8615306009641' },
      { id: 'two', whatsapp: '+8615306009641' },
    ];
    expect(findLeadByTrustedWhatsAppIdentity(duplicated, '8615306009641')).toBeUndefined();
  });
});
