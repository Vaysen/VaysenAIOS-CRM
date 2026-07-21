/**
 * TASK-102B: 身份类型编译时契约测试
 *
 * 本文件通过 TypeScript 类型注解在编译期断言 discriminated union 形状。
 * 若 identity.types.ts 的类型定义偏离契约，ts-jest 编译将失败 (RED)。
 * 运行期 expect 仅用于让 jest 拥有可执行的测试用例。
 */
import {
  PhoneIdentity,
  MatchSignal,
  WhatsAppDisplayClassification,
} from './identity.types';

describe('TASK-102B identity.types compile-time contracts', () => {
  it('PhoneIdentity resolved 变体包含 e164 / countryIso2 / countryCallingCode / confidence', () => {
    const id: PhoneIdentity = {
      status: 'resolved',
      kind: 'phone',
      e164: '+8613800001234',
      countryIso2: 'CN',
      countryCallingCode: '86',
      confidence: 'high',
    };
    expect(id.status).toBe('resolved');
    expect(id.e164).toBe('+8613800001234');
  });

  it('PhoneIdentity resolved 变体允许 countryIso2 为 null 且 confidence 为 medium', () => {
    const id: PhoneIdentity = {
      status: 'resolved',
      kind: 'phone',
      e164: '+881632123456',
      countryIso2: null,
      countryCallingCode: '881',
      confidence: 'medium',
    };
    expect(id.countryIso2).toBeNull();
    expect(id.confidence).toBe('medium');
  });

  it('PhoneIdentity needs_country 变体包含 rawDigits', () => {
    const id: PhoneIdentity = {
      status: 'needs_country',
      kind: 'phone',
      rawDigits: '13800001234',
    };
    expect(id.status).toBe('needs_country');
    expect(id.rawDigits).toBe('13800001234');
  });

  it('PhoneIdentity unresolved 变体支持 lid / jid / invalid 三种 kind', () => {
    const lid: PhoneIdentity = {
      status: 'unresolved',
      kind: 'lid',
      externalId: '1234567890@lid',
    };
    const jid: PhoneIdentity = {
      status: 'unresolved',
      kind: 'jid',
      externalId: '8613800001234@s.whatsapp.net',
    };
    const invalid: PhoneIdentity = {
      status: 'unresolved',
      kind: 'invalid',
      externalId: '',
    };
    expect(lid.kind).toBe('lid');
    expect(jid.kind).toBe('jid');
    expect(invalid.kind).toBe('invalid');
  });

  it('PhoneIdentity 状态窄化: resolved 可访问 e164, needs_country 可访问 rawDigits', () => {
    // 通过函数返回联合类型，确保调用点类型为完整 PhoneIdentity 而非窄化字面量
    function build(status: 'resolved' | 'needs_country'): PhoneIdentity {
      if (status === 'resolved') {
        return {
          status: 'resolved',
          kind: 'phone',
          e164: '+8613800001234',
          countryIso2: 'CN',
          countryCallingCode: '86',
          confidence: 'high',
        };
      }
      return {
        status: 'needs_country',
        kind: 'phone',
        rawDigits: '13800001234',
      };
    }

    const resolved = build('resolved');
    if (resolved.status === 'resolved') {
      expect(resolved.e164).toBe('+8613800001234');
    } else {
      throw new Error('应进入 resolved 分支');
    }

    const needsCountry = build('needs_country');
    if (needsCountry.status === 'needs_country') {
      expect(needsCountry.rawDigits).toBe('13800001234');
    } else {
      throw new Error('应进入 needs_country 分支');
    }
  });

  it('MatchSignal 接口包含身份、租户和排除信号', () => {
    const signal: MatchSignal = {
      exactE164: true,
      exactEmail: false,
      phoneSuffixOnly: false,
      sameTenant: true,
      excluded: false,
    };
    expect(signal.exactE164).toBe(true);
    expect(signal.exactEmail).toBe(false);
    expect(signal.phoneSuffixOnly).toBe(false);
    expect(signal.sameTenant).toBe(true);
    expect(signal.excluded).toBe(false);
  });

  it('WhatsAppDisplayClassification 包含三种字面量', () => {
    const a: WhatsAppDisplayClassification = 'person_candidate';
    const b: WhatsAppDisplayClassification = 'system_text';
    const c: WhatsAppDisplayClassification = 'empty';
    expect([a, b, c]).toEqual([
      'person_candidate',
      'system_text',
      'empty',
    ]);
  });
});
