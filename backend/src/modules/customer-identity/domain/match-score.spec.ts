/**
 * TASK-102B: 身份匹配评分与自动合并信任规则测试 (RED)
 *
 * 契约:
 * - canAutoMerge: 仅当 exactE164 || exactEmail 为 true 才允许自动合并
 *   (phoneSuffixOnly 不允许自动合并 —— 禁止后缀自动合并)
 * - scoreIdentityMatch: exactE164=100, exactEmail=100, phoneSuffixOnly=30, 否则 0 (取最高)
 */
import { canAutoMerge, scoreIdentityMatch } from './match-score';

describe('TASK-102B canAutoMerge', () => {
  it('仅 phoneSuffixOnly -> false (禁止后缀自动合并)', () => {
    expect(
      canAutoMerge({
        exactE164: false,
        exactEmail: false,
        phoneSuffixOnly: true,
        sameTenant: true,
        excluded: false,
      }),
    ).toBe(false);
  });

  it('exactE164 -> true', () => {
    expect(
      canAutoMerge({
        exactE164: true,
        exactEmail: false,
        phoneSuffixOnly: false,
        sameTenant: true,
        excluded: false,
      }),
    ).toBe(true);
  });

  it('exactEmail -> true', () => {
    expect(
      canAutoMerge({
        exactE164: false,
        exactEmail: true,
        phoneSuffixOnly: false,
        sameTenant: true,
        excluded: false,
      }),
    ).toBe(true);
  });

  it('无任何信号 -> false', () => {
    expect(
      canAutoMerge({
        exactE164: false,
        exactEmail: false,
        phoneSuffixOnly: false,
        sameTenant: true,
        excluded: false,
      }),
    ).toBe(false);
  });

  it('phoneSuffixOnly + exactE164 同时为 true -> true', () => {
    expect(
      canAutoMerge({
        exactE164: true,
        exactEmail: false,
        phoneSuffixOnly: true,
        sameTenant: true,
        excluded: false,
      }),
    ).toBe(true);
  });

  it('跨租户即使 E.164 相同也禁止自动合并', () => {
    expect(
      canAutoMerge({
        exactE164: true,
        exactEmail: false,
        phoneSuffixOnly: false,
        sameTenant: false,
        excluded: false,
      }),
    ).toBe(false);
  });

  it('已排除组合即使邮箱相同也禁止自动合并', () => {
    expect(
      canAutoMerge({
        exactE164: false,
        exactEmail: true,
        phoneSuffixOnly: false,
        sameTenant: true,
        excluded: true,
      }),
    ).toBe(false);
  });
});

describe('TASK-102B scoreIdentityMatch', () => {
  it('exactE164 -> 高分 100', () => {
    expect(scoreIdentityMatch({ exactE164: true, sameTenant: true })).toBe(100);
  });

  it('exactEmail -> 高分 100', () => {
    expect(
      scoreIdentityMatch({
        exactE164: false,
        exactEmail: true,
        sameTenant: true,
      }),
    ).toBe(100);
  });

  it('phoneSuffixOnly -> 低分 30', () => {
    expect(
      scoreIdentityMatch({
        exactE164: false,
        exactEmail: false,
        phoneSuffixOnly: true,
        sameTenant: true,
      }),
    ).toBe(30);
  });

  it('无信号 -> 0', () => {
    expect(
      scoreIdentityMatch({
        exactE164: false,
        exactEmail: false,
        phoneSuffixOnly: false,
        sameTenant: true,
      }),
    ).toBe(0);
  });

  it('exactE164 + exactEmail 同时为 true -> 100 (取最高，不叠加)', () => {
    expect(
      scoreIdentityMatch({
        exactE164: true,
        exactEmail: true,
        phoneSuffixOnly: false,
        sameTenant: true,
      }),
    ).toBe(100);
  });

  it('空对象 -> 0', () => {
    expect(scoreIdentityMatch({})).toBe(0);
  });

  it('跨租户或已排除组合评分为 0', () => {
    expect(scoreIdentityMatch({ exactE164: true, sameTenant: false })).toBe(0);
    expect(
      scoreIdentityMatch({
        exactEmail: true,
        sameTenant: true,
        excluded: true,
      }),
    ).toBe(0);
  });
});
