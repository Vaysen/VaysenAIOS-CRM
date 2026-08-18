/**
 * TASK-102B: normalizePhoneIdentity 纯函数测试 (RED)
 *
 * 契约要点:
 * - 保留 +86 前缀，输出 E.164，绝不截断为末尾 10 位
 * - 无国家代码的本地号 -> needs_country (禁止猜测国家)
 * - @lid / @jid / @s.whatsapp.net 后缀 -> unresolved
 * - 无效输入 -> unresolved/invalid
 */
import { normalizePhoneIdentity } from './normalize-phone';

describe('TASK-102B normalizePhoneIdentity', () => {
  it('+86 133 6592 3697 resolves to the complete E.164 number', () => {
    const result = normalizePhoneIdentity('+86 133 6592 3697');
    expect(result).toMatchObject({ status: 'resolved', e164: '+8613365923697' });
  });

  describe('resolved (含国家代码)', () => {
    it('+86 138 0000 1234 解析为 E.164 并保留 +86 前缀', () => {
      const result = normalizePhoneIdentity('+86 138 0000 1234');
      expect(result.status).toBe('resolved');
      if (result.status === 'resolved') {
        expect(result.kind).toBe('phone');
        expect(result.e164).toBe('+8613800001234');
        expect(result.countryCallingCode).toBe('86');
        // +86 前缀必须保留，禁止删除
        expect(result.e164).toMatch(/^\+86/);
      }
    });

    it('countryCallingCode 为 string 类型', () => {
      const result = normalizePhoneIdentity('+86 138 0000 1234');
      if (result.status === 'resolved') {
        expect(typeof result.countryCallingCode).toBe('string');
      }
    });

    it('+1 415 555 2671 解析为美国号码', () => {
      const result = normalizePhoneIdentity('+1 415 555 2671');
      expect(result.status).toBe('resolved');
      if (result.status === 'resolved') {
        expect(result.e164).toBe('+14155552671');
        expect(result.countryCallingCode).toBe('1');
        expect(result.countryIso2).toBe('US');
        expect(result.confidence).toBe('high');
      }
    });

    it('已为 E.164 格式的 +8613800001234 直接解析', () => {
      const result = normalizePhoneIdentity('+8613800001234');
      expect(result.status).toBe('resolved');
      if (result.status === 'resolved') {
        expect(result.e164).toBe('+8613800001234');
      }
    });
  });

  describe('needs_country (无国家代码)', () => {
    it('纯 11 位本地号 13800001234 -> needs_country', () => {
      const result = normalizePhoneIdentity('13800001234');
      expect(result.status).toBe('needs_country');
      if (result.status === 'needs_country') {
        expect(result.kind).toBe('phone');
        expect(result.rawDigits).toBe('13800001234');
      }
    });

    it('本地号带分隔符 138-0000-1234 -> needs_country', () => {
      const result = normalizePhoneIdentity('138-0000-1234');
      expect(result.status).toBe('needs_country');
      if (result.status === 'needs_country') {
        expect(result.rawDigits).toBe('13800001234');
      }
    });

    it('美国本地号 4155552671 (无 +1) -> needs_country', () => {
      const result = normalizePhoneIdentity('4155552671');
      expect(result.status).toBe('needs_country');
    });

    it('有明确 CN 国家提示时将本地号解析为 E.164', () => {
      const result = normalizePhoneIdentity('13800001234', 'CN');
      expect(result).toMatchObject({
        status: 'resolved',
        e164: '+8613800001234',
        countryIso2: 'CN',
      });
    });
  });

  describe('unresolved (lid / jid)', () => {
    it('1234567890@lid -> unresolved/lid', () => {
      const result = normalizePhoneIdentity('1234567890@lid');
      expect(result.status).toBe('unresolved');
      if (result.status === 'unresolved') {
        expect(result.kind).toBe('lid');
        expect(result.externalId).toBe('1234567890@lid');
      }
    });

    it('user@host.com@jid -> unresolved/jid', () => {
      const result = normalizePhoneIdentity('user@host.com@jid');
      expect(result.status).toBe('unresolved');
      if (result.status === 'unresolved') {
        expect(result.kind).toBe('jid');
      }
    });

    it('8613800001234@s.whatsapp.net -> unresolved/jid', () => {
      const result = normalizePhoneIdentity('8613800001234@s.whatsapp.net');
      expect(result.status).toBe('unresolved');
      if (result.status === 'unresolved') {
        expect(result.kind).toBe('jid');
      }
    });

    it('@lid 后缀检测大小写不敏感', () => {
      const result = normalizePhoneIdentity('1234567890@LID');
      expect(result.status).toBe('unresolved');
      if (result.status === 'unresolved') {
        expect(result.kind).toBe('lid');
      }
    });
  });

  describe('unresolved/invalid', () => {
    it('非数字字符串 abc -> unresolved/invalid', () => {
      const result = normalizePhoneIdentity('abc');
      expect(result.status).toBe('unresolved');
      if (result.status === 'unresolved') {
        expect(result.kind).toBe('invalid');
      }
    });

    it('空字符串 -> unresolved/invalid', () => {
      const result = normalizePhoneIdentity('');
      expect(result.status).toBe('unresolved');
      if (result.status === 'unresolved') {
        expect(result.kind).toBe('invalid');
      }
    });

    it('纯空白 -> unresolved/invalid', () => {
      const result = normalizePhoneIdentity('   ');
      expect(result.status).toBe('unresolved');
      if (result.status === 'unresolved') {
        expect(result.kind).toBe('invalid');
      }
    });
  });

  describe('身份完整性: 禁止删除 +86 前缀', () => {
    it('解析后 E.164 为 +8613800001234 (14 字符: + 86 11位)，绝不截断为末尾 10 位', () => {
      const result = normalizePhoneIdentity('+86 138 0000 1234');
      if (result.status === 'resolved') {
        // +86 前缀 (3 字符) + 11 位号码 = 14 字符
        expect(result.e164).toBe('+8613800001234');
        expect(result.e164.length).toBe(14);
        // 绝不是删除 +86 后的 11 位或末尾 10 位
        expect(result.e164).not.toBe('+13800001234');
        expect(result.e164).not.toBe('13800001234');
      }
    });
  });
});
