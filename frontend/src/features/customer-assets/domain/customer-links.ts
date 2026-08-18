/**
 * TASK-102H: 客户链接纯函数
 *
 * 所有函数无副作用、无 I/O 依赖，可独立单元测试。
 * 禁止 any。
 */

import type { ContactNameInput } from '../types';

// ---------------------------------------------------------------------------
// WhatsApp 链接
// ---------------------------------------------------------------------------

/**
 * E.164 校验正则：
 * - 以 + 开头
 * - 后跟 8-15 位数字
 * - 整体仅含 + 和数字（无空格、括号等）
 */
const E164_REGEX = /^\+\d{8,15}$/;

/**
 * 判断值是否为 LID/JID（WhatsApp 内部标识，非电话号码）。
 * LID 形如 `xxxxxxxxx@lid`，JID 形如 `xxxxxxxxx@s.whatsapp.net`。
 */
function isLidOrJid(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.includes('@lid') ||
    lower.includes('@s.whatsapp.net') ||
    lower.includes('@c.us') ||
    lower.includes('@g.us')
  );
}

/**
 * 构建安全 WhatsApp 跳转链接。
 *
 * 仅当号码为合法 E.164（+开头，8-15位数字）时返回 `https://wa.me/<digits>`。
 * LID/JID/无效号码返回 null。
 *
 * @param phone 原始号码字符串
 * @returns 安全的 wa.me 链接，或 null
 */
export function buildWhatsAppLink(phone: string): string | null {
  if (!phone || typeof phone !== 'string') return null;

  const trimmed = phone.trim();
  if (!trimmed) return null;

  // LID/JID 不是电话号码，不可用于 wa.me
  if (isLidOrJid(trimmed)) return null;

  // 严格 E.164 校验
  if (!E164_REGEX.test(trimmed)) return null;

  // 提取纯数字部分用于 wa.me
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return null;

  return `https://wa.me/${digits}`;
}

// ---------------------------------------------------------------------------
// Email 链接
// ---------------------------------------------------------------------------

/**
 * RFC 5322 简化邮箱正则（实用范围）。
 * 不追求完美匹配所有 RFC 合法邮箱，但能拦截常见非法格式。
 */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 构建安全 mailto 链接。
 *
 * 仅当 email 为合法邮箱时返回 `mailto:<encoded>`。
 * 无效返回 null。
 *
 * @param email 原始邮箱字符串
 * @returns 安全的 mailto 链接，或 null
 */
export function buildEmailLink(email: string): string | null {
  if (!email || typeof email !== 'string') return null;

  const trimmed = email.trim();
  if (!trimmed) return null;

  if (!EMAIL_REGEX.test(trimmed)) return null;

  // 对邮箱进行 URI 编码以防止注入
  const encoded = encodeURIComponent(trimmed);
  return `mailto:${encoded}`;
}

// ---------------------------------------------------------------------------
// 显示名
// ---------------------------------------------------------------------------

/** 公司名为 null 时的占位符 */
export const COMPANY_NAME_PLACEHOLDER = '公司待补充';

/** 联系人名为空时的占位符 */
export const CONTACT_NAME_PLACEHOLDER = '未命名联系人';

/**
 * 构建公司显示名。
 *
 * @param companyName 公司名（可为 null）
 * @returns 公司名或占位符 "公司待补充"
 */
export function buildDisplayName(companyName: string | null): string {
  if (companyName === null) return COMPANY_NAME_PLACEHOLDER;
  const trimmed = companyName.trim();
  if (trimmed === '') return COMPANY_NAME_PLACEHOLDER;
  return trimmed;
}

/**
 * 格式化联系人名称。
 *
 * 优先级：displayName > firstName+lastName > "未命名联系人"
 *
 * @param contact 联系人最小结构
 * @returns 格式化后的联系人名
 */
export function formatContactName(
  contact: ContactNameInput,
): string {
  // 1. displayName 优先
  if (contact.displayName && contact.displayName.trim() !== '') {
    return contact.displayName.trim();
  }

  // 2. firstName + lastName
  const first = contact.firstName?.trim() ?? '';
  const last = contact.lastName?.trim() ?? '';
  const combined = `${first} ${last}`.trim();
  if (combined !== '') {
    return combined;
  }

  // 3. 占位符
  return CONTACT_NAME_PLACEHOLDER;
}
