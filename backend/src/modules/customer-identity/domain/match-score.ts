/**
 * TASK-102B: 身份匹配评分与自动合并信任规则纯函数
 *
 * 信任策略 (严格遵守 CRCP 禁止事项):
 * - canAutoMerge: 仅当同租户、未排除且 exactE164 || exactEmail 为 true
 *   才允许自动合并。
 *   phoneSuffixOnly 单独出现时禁止自动合并 (禁止后缀自动合并)。
 * - scoreIdentityMatch: exactE164=100, exactEmail=100, phoneSuffixOnly=30, 否则 0。
 *   多信号取最高分，不叠加 (避免弱信号凑分)。
 *
 * 纯函数: 无 DB / 网络 / 副作用。
 */
import type { MatchSignal } from './identity.types';

/** 自动合并所需的高信任分阈值 */
export const AUTO_MERGE_THRESHOLD = 100;

/**
 * 判断是否允许自动合并。
 *
 * 仅当同租户、未排除且 E.164 完全一致或邮箱完全一致时才允许。
 * phoneSuffixOnly (末尾位数匹配) 不允许自动合并。
 *
 * @param signal 完整的匹配信号集
 * @returns true 表示可自动合并
 */
export function canAutoMerge(signal: MatchSignal): boolean {
  return (
    signal.sameTenant &&
    !signal.excluded &&
    (signal.exactE164 || signal.exactEmail)
  );
}

/**
 * 计算身份匹配置信分 (0-100)。
 *
 * 评分规则 (取最高，不叠加):
 * - exactE164 -> 100 (E.164 完全一致，含国家代码)
 * - exactEmail -> 100 (归一化邮箱完全一致)
 * - phoneSuffixOnly -> 30 (仅末尾位数匹配，弱信号)
 * - 无信号 -> 0
 *
 * @param signal 部分或完整的匹配信号 (缺失字段视为 false)
 * @returns 0 / 30 / 100
 */
export function scoreIdentityMatch(signal: Partial<MatchSignal>): number {
  if (signal.sameTenant === false || signal.excluded === true) {
    return 0;
  }
  if (signal.exactE164) {
    return 100;
  }
  if (signal.exactEmail) {
    return 100;
  }
  if (signal.phoneSuffixOnly) {
    return 30;
  }
  return 0;
}
