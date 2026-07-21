/**
 * TASK-102B: 客户身份领域类型定义
 *
 * 纯类型文件，无运行时逻辑。被 normalize-phone / match-score /
 * sanitize-display-text 等纯函数引用。
 *
 * 设计原则:
 * - PhoneIdentity 为 discriminated union (按 status 区分)
 * - resolved: 已确定国家与 E.164，身份可信
 * - needs_country: 仅有本地号码位数，缺国家代码，禁止猜测
 * - unresolved: lid / jid / invalid，无法作为电话身份参与自动合并
 */

/**
 * 电话身份归一化结果。
 *
 * - resolved: 解析为有效 E.164，保留国家代码前缀 (如 +86)，绝不截断。
 *   - confidence 'high': countryIso2 (ISO 3166-1 alpha-2) 已确定
 *   - confidence 'medium': 仅确定 countryCallingCode，无法映射到单一国家
 * - needs_country: 输入为本地号码位数但无国家代码，需外部补充国家后才能解析。
 *   rawDigits 保留原始数字 (不含国家代码)，禁止猜测国家。
 * - unresolved: lid / jid / invalid。externalId 保留原始输入以供审计。
 */
export type PhoneIdentity =
  | {
      status: 'resolved';
      kind: 'phone';
      e164: string;
      countryIso2: string | null;
      countryCallingCode: string;
      confidence: 'high' | 'medium';
    }
  | {
      status: 'needs_country';
      kind: 'phone';
      rawDigits: string;
    }
  | {
      status: 'unresolved';
      kind: 'lid' | 'jid' | 'invalid';
      externalId: string;
    };

/**
 * 身份匹配信号集，用于评估两个客户记录是否指向同一自然人/法人。
 *
 * - exactE164: E.164 完全一致 (含国家代码)，最强信号
 * - exactEmail: 归一化邮箱完全一致，强信号
 * - phoneSuffixOnly: 仅号码末尾若干位匹配 (旧逻辑的末尾 10 位)，
 *   弱信号，单独出现时禁止自动合并
 * - sameTenant: 两个身份是否属于同一个 companyId
 * - excluded: 用户是否已明确判定不是同一客户
 */
export interface MatchSignal {
  exactE164: boolean;
  exactEmail: boolean;
  phoneSuffixOnly: boolean;
  sameTenant: boolean;
  excluded: boolean;
}

/**
 * WhatsApp 显示文本分类。
 *
 * - person_candidate: 可能是人名，需进一步净化
 * - system_text: WhatsApp 系统文案 (最后上线于 / 业务账户 等)，不可作为人名
 * - empty: 空字符串或纯空白
 */
export type WhatsAppDisplayClassification =
  | 'person_candidate'
  | 'system_text'
  | 'empty';
