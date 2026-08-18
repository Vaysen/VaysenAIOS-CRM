import { describe, expect, it } from 'vitest';
import {
  findUniqueExactMatch,
  findLeadByTrustedWhatsAppIdentity,
  normalizeWhatsAppName,
  normalizeWhatsAppE164,
  normalizeWhatsAppPhone,
  sanitizeWhatsAppDisplayName,
} from '../whatsapp-identity';

describe('WhatsApp identity fail-closed helpers', () => {
  it.each([
    '最后上线于2026年6月26日06:05',
    '正在输入…',
    'last seen yesterday at 10:00',
    'typing...',
    'recording audio',
    '\u5f55\u97f3\u4e2d',
    '在线',
  ])('拒绝状态文案: %s', (value) => {
    expect(sanitizeWhatsAppDisplayName(value)).toBeNull();
  });

  it('保留并规范真实姓名', () => {
    expect(sanitizeWhatsAppDisplayName('  AcmeCorp  ')).toBe('AcmeCorp');
    expect(normalizeWhatsAppName('  AcmeCorp  ')).toBe('elvis-w');
  });

  it('号码只做完整规范化，不截取尾号', () => {
    expect(normalizeWhatsAppPhone('+86 153 0600 1234')).toBe('8615306001234');
    expect(normalizeWhatsAppPhone('0086 153 0600 1234')).toBe('8615306001234');
    expect(normalizeWhatsAppE164('+86 133 6592 3697')).toBe('+8613365923697');
    expect(normalizeWhatsAppE164('1234567890@lid')).toBeNull();
  });

  it('仅唯一精确命中时返回结果', () => {
    const values = [{ name: 'elvis-w' }, { name: 'other' }];
    expect(findUniqueExactMatch(values, 'elvis-w', (item) => item.name)).toEqual(values[0]);
    expect(findUniqueExactMatch([...values, { name: 'elvis-w' }], 'elvis-w', (item) => item.name)).toBeUndefined();
    expect(findUniqueExactMatch(values, 'elvis', (item) => item.name)).toBeUndefined();
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
