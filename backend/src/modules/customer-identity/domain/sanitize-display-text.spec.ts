/**
 * TASK-102B: WhatsApp 显示文本净化纯函数测试 (RED)
 *
 * 契约:
 * - classifyWhatsAppDisplayText: 系统文案 vs 人名候选 vs 空
 * - sanitizeContactNameCandidate: trim，空/系统文案 -> null
 * - sanitizeCompanyCandidate: trim，空/"WhatsApp:" 前缀/系统文案 -> null
 */
import {
  classifyWhatsAppDisplayText,
  sanitizeContactNameCandidate,
  sanitizeCompanyCandidate,
} from './sanitize-display-text';

describe('TASK-102B classifyWhatsAppDisplayText', () => {
  describe('系统文案 -> system_text', () => {
    it.each([
      '最后上线于星期四16:56',
      '业务账户',
      '点击此处查看联系人信息',
      '最后上线于今天',
      '正在输入…',
      '在线',
    ])('中文系统文案: %s', (text) => {
      expect(classifyWhatsAppDisplayText(text)).toBe('system_text');
    });

    it.each([
      'Last seen today at 4:56 PM',
      'Business account',
      'Click here to view contact info',
      'last seen yesterday',
      'typing…',
      'online',
      'unavailable',
    ])('英文系统文案: %s', (text) => {
      expect(classifyWhatsAppDisplayText(text)).toBe('system_text');
    });
  });

  describe('人名候选 -> person_candidate', () => {
    it.each(['张三', 'John Smith', '李四 销售经理', 'Online Packaging Ltd'])(
      '人名: %s',
      (text) => {
        expect(classifyWhatsAppDisplayText(text)).toBe('person_candidate');
      },
    );
  });

  it('空字符串 -> empty', () => {
    expect(classifyWhatsAppDisplayText('')).toBe('empty');
  });

  it('纯空白 -> empty', () => {
    expect(classifyWhatsAppDisplayText('   ')).toBe('empty');
  });
});

describe('TASK-102B sanitizeContactNameCandidate', () => {
  it('返回 trim 后的人名', () => {
    expect(sanitizeContactNameCandidate('张三')).toBe('张三');
  });

  it('trim 前后空格', () => {
    expect(sanitizeContactNameCandidate('  李四  ')).toBe('李四');
  });

  it('空字符串返回 null', () => {
    expect(sanitizeContactNameCandidate('')).toBeNull();
  });

  it('纯空白返回 null', () => {
    expect(sanitizeContactNameCandidate('   ')).toBeNull();
  });

  it('系统文案返回 null', () => {
    expect(sanitizeContactNameCandidate('业务账户')).toBeNull();
    expect(sanitizeContactNameCandidate('Business account')).toBeNull();
  });

  it('拒绝带时间后缀的中文/英文上线状态', () => {
    expect(sanitizeContactNameCandidate('最后上线于2026年6月26日06:05')).toBeNull();
    expect(sanitizeContactNameCandidate('last seen yesterday at 10:00')).toBeNull();
  });
});

describe('TASK-102B sanitizeCompanyCandidate', () => {
  it('以 WhatsApp: 开头返回 null', () => {
    expect(sanitizeCompanyCandidate('WhatsApp: +86 138...')).toBeNull();
  });

  it('以 whatsapp: (小写) 开头返回 null', () => {
    expect(sanitizeCompanyCandidate('whatsapp: +86 138...')).toBeNull();
  });

  it('返回 trim 后的公司名', () => {
    expect(sanitizeCompanyCandidate('Acme Corp')).toBe('Acme Corp');
  });

  it('trim 前后空格', () => {
    expect(sanitizeCompanyCandidate('  Acme Corp  ')).toBe('Acme Corp');
  });

  it('空字符串返回 null', () => {
    expect(sanitizeCompanyCandidate('')).toBeNull();
  });

  it('系统文案返回 null', () => {
    expect(sanitizeCompanyCandidate('在线')).toBeNull();
    expect(sanitizeCompanyCandidate('online')).toBeNull();
  });

  it('包含 online 的合法公司名不会被误删', () => {
    expect(sanitizeCompanyCandidate('Online Packaging Ltd')).toBe(
      'Online Packaging Ltd',
    );
  });
});
