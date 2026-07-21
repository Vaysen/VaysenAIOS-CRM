/**
 * TASK-102B: normalizePhoneIdentity — 电话号码身份归一化纯函数
 *
 * 核心契约:
 * 1. 保留国家代码前缀 (如 +86)，输出 E.164，绝不截断为末尾 10 位。
 * 2. 有国家代码且有效 -> resolved (libphonenumber-js 解析)。
 * 3. 无国家代码 (纯本地号) -> needs_country，保留 rawDigits，禁止猜测国家。
 * 4. @lid / @jid / @s.whatsapp.net 后缀 -> unresolved (非电话身份)。
 * 5. 无效输入 (空 / 无数字) -> unresolved/invalid。
 *
 * 纯函数: 无 DB / 网络 / 副作用。依赖 libphonenumber-js 的离线元数据。
 */
import {
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js';
import type { PhoneIdentity } from './identity.types';

/** WhatsApp 内部 LID 后缀 (Linked Identity) */
const LID_SUFFIX = '@lid';
/** WhatsApp JID 后缀集合 (Jabber ID) */
const JID_SUFFIXES = ['@jid', '@s.whatsapp.net'];
/** 本地号码最少位数，低于此值视为无效 (过滤随机短串) */
const MIN_LOCAL_DIGITS = 4;
/** 电话号码外观正则: 可选 + 前缀，仅含数字与常见分隔符 */
const PHONE_LIKE_REGEX = /^[+]?[\d\s().-]+$/;

/**
 * 将任意输入归一化为 PhoneIdentity。
 *
 * @param input 原始电话字符串 (可能含空格、@lid、@s.whatsapp.net 等)
 * @param countryHint 用户选择或已确认的 ISO 3166-1 alpha-2 国家代码
 * @returns PhoneIdentity 判别联合
 */
export function normalizePhoneIdentity(
  input: string,
  countryHint?: CountryCode,
): PhoneIdentity {
  const trimmed = (input ?? '').trim();

  if (trimmed === '') {
    return { status: 'unresolved', kind: 'invalid', externalId: trimmed };
  }

  const lower = trimmed.toLowerCase();

  // WhatsApp LID 后缀: 非电话身份
  if (lower.endsWith(LID_SUFFIX)) {
    return { status: 'unresolved', kind: 'lid', externalId: trimmed };
  }

  // WhatsApp JID 后缀: 非电话身份
  for (const suffix of JID_SUFFIXES) {
    if (lower.endsWith(suffix)) {
      return { status: 'unresolved', kind: 'jid', externalId: trimmed };
    }
  }

  // 尝试用 libphonenumber-js 解析 (防御性: 不抛异常)
  let parsed: ReturnType<typeof parsePhoneNumberFromString> | null = null;
  try {
    parsed = parsePhoneNumberFromString(trimmed, countryHint);
  } catch {
    parsed = null;
  }

  if (parsed && parsed.isValid()) {
    const countryIso2 = parsed.country ?? null;
    return {
      status: 'resolved',
      kind: 'phone',
      e164: parsed.number,
      countryIso2,
      countryCallingCode: String(parsed.countryCallingCode),
      // countryIso2 确定则为 high; 仅 countryCallingCode (如卫星/共享区号) 为 medium
      confidence: countryIso2 ? 'high' : 'medium',
    };
  }

  // 未能解析为有效国际号码。若输入外观像电话号码且有足够位数，
  // 保留 rawDigits 并标记 needs_country —— 禁止猜测国家。
  const rawDigits = trimmed.replace(/\D/g, '');
  if (PHONE_LIKE_REGEX.test(trimmed) && rawDigits.length >= MIN_LOCAL_DIGITS) {
    return { status: 'needs_country', kind: 'phone', rawDigits };
  }

  return { status: 'unresolved', kind: 'invalid', externalId: trimmed };
}
