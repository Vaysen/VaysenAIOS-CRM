/**
 * 统一的手机号归一化工具
 * 确保所有渠道（WhatsApp、网站询盘、邮件等）使用相同的归一化逻辑
 *
 * 规则：
 * 1. 去除空格、连字符、括号、加号、点号
 * 2. 去除前缀 "00"（国际拨号前缀）
 * 3. 去除前缀 "86"（中国区号）— 统一存储不带区号的号码
 * 4. 保留其他国家的完整号码（如 14155552671）
 */
export function normalizePhone(phone: string): string {
  return phone
    .replace(/[\s\-\(\)\+\.]/g, '')
    .replace(/^00/, '')
    .replace(/^86/, '');
}

/**
 * 获取手机号的后10位数字（用于模糊匹配）
 * 不同归一化方式产生的号码后10位是一致的
 * 例如: 8613800000000 / 13800000000 / +8613800000000 → 后10位都是 1380000000
 */
export function phoneLastDigits(phone: string, digits: number = 10): string {
  const cleaned = phone.replace(/\D/g, '');
  return cleaned.slice(-digits);
}

/**
 * 归一化邮箱地址
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * 跨渠道客户查找条件构建器
 * 使用后10位号码模糊匹配，避免因归一化不一致导致重复创建
 * 同时兼容精确匹配（normalizedValue）和模糊匹配（endsWith 后10位）
 */
export function buildPhoneLookupConditions(companyId: string, normalizedPhone: string) {
  const last10 = phoneLastDigits(normalizedPhone, 10);
  return {
    companyId,
    type: { in: ['whatsapp', 'phone'] },
    OR: [
      { normalizedValue: normalizedPhone },
      { normalizedValue: { endsWith: last10 } },
      { originalValue: { endsWith: last10 } },
    ],
  };
}
