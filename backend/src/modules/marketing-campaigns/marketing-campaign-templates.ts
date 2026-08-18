/**
 * marketing-campaign-templates.ts
 *
 * R111 批次B：营销活动预设模板（常量数组，不落库）。
 * 模板 = 客群条件建议（defaultCriteria）+ 推荐固定渠道（suggestedChannel）+ AI 草拟提示（aiPrompt），
 * 前端一键创建：用 defaultCriteria 建客群/条件、suggestedChannel 定活动渠道、aiPrompt 生成内容。
 */
export interface MarketingCampaignTemplate {
  id: string;
  name: string;
  description: string;
  defaultCriteria: Record<string, unknown>;
  suggestedChannel: 'email' | 'whatsapp';
  aiPrompt: string;
}

export const MARKETING_CAMPAIGN_TEMPLATES: readonly MarketingCampaignTemplate[] = [
  {
    id: 'new-lead-outreach',
    name: '新客开发',
    description: '近30天新客，首轮触达：公司介绍+主打产品',
    defaultCriteria: {
      createdWithinDays: 30,
      leadStatuses: ['new', 'prospect_pool'],
      hasEmail: true,
    },
    suggestedChannel: 'email',
    aiPrompt:
      '为新客户撰写一封简洁的英文开发信，介绍Vaysen包装（快递袋/牛皮纸袋/垃圾袋/自封袋工厂），突出 15 年经验、ISO 认证、快速打样、MOQ 低。语气专业友好，长度 100-150 词，附中文对照。',
  },
  {
    id: 'dormant-reactivation',
    name: '潜客激活',
    description: '已跟进但超过7天未回复的潜客，二次触达唤醒',
    defaultCriteria: {
      followedUpNoReplyDays: 7,
      leadStatuses: ['prospect_pool', 'contacted'],
      hasEmail: true,
    },
    suggestedChannel: 'email',
    aiPrompt:
      '为超过7天未回复的潜客撰写一封简短的英文跟进邮件，礼貌询问是否需要补充资料或调整方案，突出快速响应与定制打样能力。语气轻松专业，长度 60-100 词，附中文对照。',
  },
  {
    id: 'sample-followup',
    name: '样品追单',
    description: '已索取样品或已有样品报价的客户，推动样品确认与下单',
    defaultCriteria: {
      hasSampleQuote: true,
      leadStatuses: ['quoted', 'negotiation'],
      hasEmail: true,
    },
    suggestedChannel: 'email',
    aiPrompt:
      '为已索取样品或已有样品报价的客户撰写一封简短的英文跟进邮件，确认样品寄送进度、询问测试反馈，并推动小批量试单。语气专业亲切，长度 80-120 词，附中文对照。',
  },
  {
    id: 'existing-customer-rebuy',
    name: '老客复购',
    description: '已有成交记录的老客，周期性复购唤醒与新品推荐',
    defaultCriteria: {
      hasOrder: true,
      leadStatuses: ['customer', 'repeat_customer'],
      hasEmail: true,
    },
    suggestedChannel: 'email',
    aiPrompt:
      '为已有成交记录的老客户撰写一封简短的英文复购邮件，感谢过往合作，介绍新品或旺季备货提醒，附专属优惠。语气熟络专业，长度 80-120 词，附中文对照。',
  },
  {
    id: 'market-targeting',
    name: '市场定向',
    description: '按国家/行业定向触达目标市场客户，条件由用户自定义填写',
    // 国家/行业条件留空由用户填（criteria-parser 对空 countries 数组会报错，故不预置）
    defaultCriteria: {
      leadStatuses: ['new', 'prospect_pool'],
      hasEmail: true,
    },
    suggestedChannel: 'whatsapp',
    aiPrompt:
      '为目标市场定向客户撰写一封简洁的英文开发信，按行业/国家定制开场，介绍Vaysen包装的产品与工厂优势，突出本地化服务与快速响应。语气专业友好，长度 100-150 词，附中文对照。',
  },
];
