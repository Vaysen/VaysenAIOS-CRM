/**
 * TASK-102B: normalizeEmailIdentity 纯函数测试 (RED)
 *
 * 契约: trim + toLowerCase + 简单格式校验，无效返回 null。
 */
import { normalizeEmailIdentity } from './normalize-email';

describe('TASK-102B normalizeEmailIdentity', () => {
  it('trim + toLowerCase 混合大小写邮箱', () => {
    expect(normalizeEmailIdentity(' Sales@Example.COM ')).toBe(
      'sales@example.com',
    );
  });

  it('非邮箱字符串返回 null', () => {
    expect(normalizeEmailIdentity('not-an-email')).toBeNull();
  });

  it('空字符串返回 null', () => {
    expect(normalizeEmailIdentity('')).toBeNull();
  });

  it('纯空白返回 null', () => {
    expect(normalizeEmailIdentity('   ')).toBeNull();
  });

  it('缺少域名返回 null', () => {
    expect(normalizeEmailIdentity('user@')).toBeNull();
  });

  it('缺少 @ 返回 null', () => {
    expect(normalizeEmailIdentity('userhost.com')).toBeNull();
  });

  it('标准小写邮箱保持不变', () => {
    expect(normalizeEmailIdentity('john.doe@company.org')).toBe(
      'john.doe@company.org',
    );
  });

  it('多个空格被 trim', () => {
    expect(normalizeEmailIdentity('  a@b.cn  ')).toBe('a@b.cn');
  });
});
