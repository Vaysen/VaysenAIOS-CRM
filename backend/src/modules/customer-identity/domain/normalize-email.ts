/**
 * TASK-102B: normalizeEmailIdentity — 邮箱身份归一化纯函数
 *
 * 契约: trim + toLowerCase + 简单格式校验，无效返回 null。
 * 纯函数: 无 DB / 网络 / 副作用。
 */

/**
 * 简单邮箱格式正则:
 * - 本地部分: 至少一个非空白非 @ 字符
 * - @
 * - 域名: 至少一个非空白非 @ 字符 + . + 至少一个非空白非 @ 字符
 *
 * 注意: 这是结构性校验，不做 RFC 5321 完整验证。
 * 目的是过滤明显非邮箱输入，保留确定性归一。
 */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 将邮箱归一化为小写去空格形式。
 *
 * @param input 原始邮箱字符串
 * @returns 归一化邮箱，或 null (无效/空)
 */
export function normalizeEmailIdentity(input: string): string | null {
  const trimmed = (input ?? '').trim().toLowerCase();

  if (trimmed === '') {
    return null;
  }

  if (!EMAIL_REGEX.test(trimmed)) {
    return null;
  }

  return trimmed;
}
