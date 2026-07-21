/**
 * TASK-102B: WhatsApp 显示文本净化纯函数
 *
 * 契约:
 * - classifyWhatsAppDisplayText: 系统文案关键词 (中英文) -> 'system_text';
 *   空白 -> 'empty'; 其余 -> 'person_candidate'。
 * - sanitizeContactNameCandidate: trim，空/系统文案 -> null，否则返回 trimmed。
 * - sanitizeCompanyCandidate: trim，空/"WhatsApp:" 前缀/系统文案 -> null，否则返回 trimmed。
 *
 * 纯函数: 无 DB / 网络 / 副作用。
 */
import type { WhatsAppDisplayClassification } from './identity.types';

/**
 * WhatsApp 系统文案规则 (中英文)。
 * 短状态词采用整句匹配，可带时间等后缀的文案采用前缀匹配，避免把
 * "Online Packaging Ltd" 之类合法公司名误判为系统状态。
 */
const SYSTEM_TEXT_EXACT: ReadonlySet<string> = new Set([
  '业务账户',
  '给自己发消息',
  '在线',
  'business account',
  'online',
  'unavailable',
]);

const SYSTEM_TEXT_PREFIXES: readonly string[] = [
  '最后上线于',
  '点击此处查看联系人信息',
  '正在输入',
  'last seen',
  'click here to view',
  'typing',
];

/**
 * 分类 WhatsApp 显示文本。
 *
 * @param input 原始显示文本
 * @returns 'system_text' | 'person_candidate' | 'empty'
 */
export function classifyWhatsAppDisplayText(
  input: string,
): WhatsAppDisplayClassification {
  const trimmed = (input ?? '').trim();

  if (trimmed === '') {
    return 'empty';
  }

  const lower = trimmed.toLowerCase();
  if (SYSTEM_TEXT_EXACT.has(lower)) {
    return 'system_text';
  }

  for (const prefix of SYSTEM_TEXT_PREFIXES) {
    if (lower.startsWith(prefix)) {
      return 'system_text';
    }
  }

  return 'person_candidate';
}

/**
 * 净化联系人姓名候选。
 * - trim 前后空白
 * - 空字符串 -> null
 * - 系统文案 -> null (不可作为人名)
 * - 其余 -> 返回 trimmed 姓名
 *
 * @param input 原始姓名候选
 * @returns 净化后姓名，或 null
 */
export function sanitizeContactNameCandidate(input: string): string | null {
  const trimmed = (input ?? '').trim();

  if (trimmed === '') {
    return null;
  }

  if (classifyWhatsAppDisplayText(trimmed) === 'system_text') {
    return null;
  }

  return trimmed;
}

/**
 * 净化公司名称候选。
 * - trim 前后空白
 * - 空字符串 -> null
 * - 以 "WhatsApp:" 开头 (大小写不敏感) -> null (系统占位，非公司名)
 * - 系统文案 -> null
 * - 其余 -> 返回 trimmed 公司名
 *
 * @param input 原始公司名候选
 * @returns 净化后公司名，或 null
 */
export function sanitizeCompanyCandidate(input: string): string | null {
  const trimmed = (input ?? '').trim();

  if (trimmed === '') {
    return null;
  }

  if (trimmed.toLowerCase().startsWith('whatsapp:')) {
    return null;
  }

  if (classifyWhatsAppDisplayText(trimmed) === 'system_text') {
    return null;
  }

  return trimmed;
}
