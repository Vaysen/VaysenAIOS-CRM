import { describe, it, expect } from 'vitest';
import {
  buildWhatsAppLink,
  buildEmailLink,
  buildDisplayName,
  formatContactName,
  COMPANY_NAME_PLACEHOLDER,
  CONTACT_NAME_PLACEHOLDER,
} from '../domain/customer-links';

// ---------------------------------------------------------------------------
// buildWhatsAppLink
// ---------------------------------------------------------------------------

describe('buildWhatsAppLink', () => {
  it('合法 E.164 号码返回 wa.me 链接', () => {
    expect(buildWhatsAppLink('+8613800138000')).toBe('https://wa.me/8613800138000');
    expect(buildWhatsAppLink('+12025551234')).toBe('https://wa.me/12025551234');
    expect(buildWhatsAppLink('+447911123456')).toBe('https://wa.me/447911123456');
  });

  it('无 + 前缀的号码返回 null', () => {
    expect(buildWhatsAppLink('8613800138000')).toBeNull();
    expect(buildWhatsAppLink('13800138000')).toBeNull();
  });

  it('LID/JID 返回 null', () => {
    expect(buildWhatsAppLink('123456789@lid')).toBeNull();
    expect(buildWhatsAppLink('123456789@s.whatsapp.net')).toBeNull();
    expect(buildWhatsAppLink('123456789@c.us')).toBeNull();
    expect(buildWhatsAppLink('group-123@g.us')).toBeNull();
  });

  it('含空格/括号的号码返回 null（非严格 E.164）', () => {
    expect(buildWhatsAppLink('+86 138 0013 8000')).toBeNull();
    expect(buildWhatsAppLink('+1 (202) 555-1234')).toBeNull();
  });

  it('位数不足（<8位）返回 null', () => {
    expect(buildWhatsAppLink('+1234567')).toBeNull();
    expect(buildWhatsAppLink('+1234')).toBeNull();
  });

  it('位数超长（>15位）返回 null', () => {
    expect(buildWhatsAppLink('+1234567890123456')).toBeNull();
  });

  it('空字符串/null/undefined 返回 null', () => {
    expect(buildWhatsAppLink('')).toBeNull();
    expect(buildWhatsAppLink('   ')).toBeNull();
  });

  it('纯字母/特殊字符返回 null', () => {
    expect(buildWhatsAppLink('abcdefghij')).toBeNull();
    expect(buildWhatsAppLink('!@#$%^&*()')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildEmailLink
// ---------------------------------------------------------------------------

describe('buildEmailLink', () => {
  it('合法邮箱返回 mailto 链接', () => {
    expect(buildEmailLink('john@example.com')).toBe('mailto:john%40example.com');
    expect(buildEmailLink('test.user@domain.co.uk')).toBe('mailto:test.user%40domain.co.uk');
  });

  it('无 @ 的字符串返回 null', () => {
    expect(buildEmailLink('johnexample.com')).toBeNull();
    expect(buildEmailLink('john@')).toBeNull();
  });

  it('无域名部分返回 null', () => {
    expect(buildEmailLink('john@domain')).toBeNull();
    expect(buildEmailLink('john@.com')).toBeNull();
  });

  it('含空格的邮箱返回 null', () => {
    expect(buildEmailLink('john @example.com')).toBeNull();
    expect(buildEmailLink('john@ example.com')).toBeNull();
  });

  it('空字符串返回 null', () => {
    expect(buildEmailLink('')).toBeNull();
    expect(buildEmailLink('   ')).toBeNull();
  });

  it('对邮箱进行 URI 编码（@ -> %40）', () => {
    const result = buildEmailLink('user+tag@mail.example.org');
    expect(result).toBe('mailto:user%2Btag%40mail.example.org');
  });
});

// ---------------------------------------------------------------------------
// buildDisplayName
// ---------------------------------------------------------------------------

describe('buildDisplayName', () => {
  it('null 返回占位符', () => {
    expect(buildDisplayName(null)).toBe(COMPANY_NAME_PLACEHOLDER);
    expect(buildDisplayName(null)).toBe('公司待补充');
  });

  it('空字符串返回占位符', () => {
    expect(buildDisplayName('')).toBe(COMPANY_NAME_PLACEHOLDER);
    expect(buildDisplayName('   ')).toBe(COMPANY_NAME_PLACEHOLDER);
  });

  it('正常公司名原样返回（去除首尾空格）', () => {
    expect(buildDisplayName('Acme Co')).toBe('Acme Co');
    expect(buildDisplayName('  Acme Co  ')).toBe('Acme Co');
  });

  it('中文名正常返回', () => {
    expect(buildDisplayName('Vaysen包装')).toBe('Vaysen包装');
  });
});

// ---------------------------------------------------------------------------
// formatContactName
// ---------------------------------------------------------------------------

describe('formatContactName', () => {
  it('displayName 优先', () => {
    expect(
      formatContactName({
        displayName: 'Johnny',
        firstName: 'John',
        lastName: 'Smith',
      }),
    ).toBe('Johnny');
  });

  it('displayName 为空时使用 firstName+lastName', () => {
    expect(
      formatContactName({
        displayName: null,
        firstName: 'John',
        lastName: 'Smith',
      }),
    ).toBe('John Smith');
  });

  it('displayName 为空字符串时使用 firstName+lastName', () => {
    expect(
      formatContactName({
        displayName: '',
        firstName: 'Jane',
        lastName: 'Doe',
      }),
    ).toBe('Jane Doe');
  });

  it('仅有 firstName 时返回 firstName', () => {
    expect(
      formatContactName({
        displayName: null,
        firstName: 'John',
        lastName: null,
      }),
    ).toBe('John');
  });

  it('仅有 lastName 时返回 lastName', () => {
    expect(
      formatContactName({
        displayName: null,
        firstName: null,
        lastName: 'Smith',
      }),
    ).toBe('Smith');
  });

  it('全部为空时返回占位符', () => {
    expect(
      formatContactName({
        displayName: null,
        firstName: null,
        lastName: null,
      }),
    ).toBe(CONTACT_NAME_PLACEHOLDER);
    expect(
      formatContactName({
        displayName: null,
        firstName: null,
        lastName: null,
      }),
    ).toBe('未命名联系人');
  });

  it('全部为空字符串时返回占位符', () => {
    expect(
      formatContactName({
        displayName: '',
        firstName: '',
        lastName: '',
      }),
    ).toBe(CONTACT_NAME_PLACEHOLDER);
  });

  it('空格字符串视为空', () => {
    expect(
      formatContactName({
        displayName: '   ',
        firstName: '  ',
        lastName: '  ',
      }),
    ).toBe(CONTACT_NAME_PLACEHOLDER);
  });
});
