export const ASSISTANT_PERMISSION_PRESETS = ['ADVISORY', 'EXECUTOR', 'SUPERVISOR'] as const;
export type AssistantPermissionPresetValue = (typeof ASSISTANT_PERMISSION_PRESETS)[number];

export const ASSISTANT_POLICY_DECISIONS = ['ALLOW', 'APPROVAL_REQUIRED', 'DENY'] as const;
export type AssistantPolicyDecisionValue = (typeof ASSISTANT_POLICY_DECISIONS)[number];

export type AssistantRiskLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'F';

export type AssistantCapabilityDefinition = {
  id: string;
  domain: 'crm' | 'order' | 'quote' | 'message' | 'task' | 'research' | 'channel' | 'infrastructure';
  risk: AssistantRiskLevel;
  label: string;
  temporaryGrantAllowed: boolean;
  defaults: Record<AssistantPermissionPresetValue, AssistantPolicyDecisionValue>;
};

const capability = (
  id: string,
  domain: AssistantCapabilityDefinition['domain'],
  risk: AssistantRiskLevel,
  label: string,
  defaults: AssistantCapabilityDefinition['defaults'],
  temporaryGrantAllowed = false,
): AssistantCapabilityDefinition => ({ id, domain, risk, label, defaults, temporaryGrantAllowed });

export const ASSISTANT_CAPABILITIES: readonly AssistantCapabilityDefinition[] = [
  capability('crm.dashboard.read', 'crm', 'L0', '读取经营简报', { ADVISORY: 'ALLOW', EXECUTOR: 'ALLOW', SUPERVISOR: 'ALLOW' }),
  capability('crm.customer.read', 'crm', 'L0', '读取客户资料', { ADVISORY: 'ALLOW', EXECUTOR: 'ALLOW', SUPERVISOR: 'ALLOW' }),
  capability('crm.customer.note.write', 'crm', 'L1', '新增客户备注', { ADVISORY: 'DENY', EXECUTOR: 'ALLOW', SUPERVISOR: 'ALLOW' }),
  capability('crm.customer.stage.write', 'crm', 'L1', '更新客户阶段', { ADVISORY: 'DENY', EXECUTOR: 'ALLOW', SUPERVISOR: 'ALLOW' }),
  capability('crm.customer.create', 'crm', 'L2', '创建客户', { ADVISORY: 'DENY', EXECUTOR: 'APPROVAL_REQUIRED', SUPERVISOR: 'ALLOW' }),
  capability('crm.customer.update', 'crm', 'L2', '更新客户资料', { ADVISORY: 'DENY', EXECUTOR: 'APPROVAL_REQUIRED', SUPERVISOR: 'ALLOW' }),
  capability('crm.customer.merge', 'crm', 'L4', '合并客户', { ADVISORY: 'DENY', EXECUTOR: 'APPROVAL_REQUIRED', SUPERVISOR: 'APPROVAL_REQUIRED' }),
  capability('crm.customer.delete', 'crm', 'L4', '删除客户', { ADVISORY: 'DENY', EXECUTOR: 'APPROVAL_REQUIRED', SUPERVISOR: 'APPROVAL_REQUIRED' }),
  capability('crm.order.read', 'order', 'L0', '读取订单', { ADVISORY: 'ALLOW', EXECUTOR: 'ALLOW', SUPERVISOR: 'ALLOW' }),
  capability('crm.order.draft.write', 'order', 'L2', '创建或修改订单草稿', { ADVISORY: 'DENY', EXECUTOR: 'APPROVAL_REQUIRED', SUPERVISOR: 'ALLOW' }),
  capability('crm.order.status.write', 'order', 'L2', '更新订单阶段', { ADVISORY: 'DENY', EXECUTOR: 'APPROVAL_REQUIRED', SUPERVISOR: 'ALLOW' }),
  capability('crm.order.status.critical', 'order', 'L4', '确认订单收款或完成', { ADVISORY: 'DENY', EXECUTOR: 'APPROVAL_REQUIRED', SUPERVISOR: 'APPROVAL_REQUIRED' }),
  capability('crm.order.cancel', 'order', 'L4', '取消订单', { ADVISORY: 'DENY', EXECUTOR: 'APPROVAL_REQUIRED', SUPERVISOR: 'APPROVAL_REQUIRED' }),
  capability('crm.quote.read', 'quote', 'L0', '读取报价', { ADVISORY: 'ALLOW', EXECUTOR: 'ALLOW', SUPERVISOR: 'ALLOW' }),
  capability('crm.product.read', 'quote', 'L0', '读取产品与美元价格', { ADVISORY: 'ALLOW', EXECUTOR: 'ALLOW', SUPERVISOR: 'ALLOW' }),
  capability('crm.quote.draft.write', 'quote', 'L2', '创建或修改报价草稿', { ADVISORY: 'DENY', EXECUTOR: 'APPROVAL_REQUIRED', SUPERVISOR: 'ALLOW' }),
  capability('crm.quote.render', 'quote', 'L1', '生成报价 PDF', { ADVISORY: 'DENY', EXECUTOR: 'ALLOW', SUPERVISOR: 'ALLOW' }),
  capability('crm.quote.send', 'quote', 'L3', '发送已审核报价', { ADVISORY: 'DENY', EXECUTOR: 'APPROVAL_REQUIRED', SUPERVISOR: 'ALLOW' }, true),
  capability('crm.message.draft', 'message', 'L1', '生成或翻译回复', { ADVISORY: 'ALLOW', EXECUTOR: 'ALLOW', SUPERVISOR: 'ALLOW' }),
  capability('crm.message.read', 'message', 'L0', '读取选中客户消息', { ADVISORY: 'ALLOW', EXECUTOR: 'ALLOW', SUPERVISOR: 'ALLOW' }),
  capability('crm.email.read', 'message', 'L0', '读取选中客户邮件', { ADVISORY: 'ALLOW', EXECUTOR: 'ALLOW', SUPERVISOR: 'ALLOW' }),
  capability('crm.message.send', 'message', 'L3', '发送客户消息', { ADVISORY: 'DENY', EXECUTOR: 'APPROVAL_REQUIRED', SUPERVISOR: 'ALLOW' }, true),
  capability('crm.email.send', 'message', 'L3', '发送客户邮件', { ADVISORY: 'DENY', EXECUTOR: 'APPROVAL_REQUIRED', SUPERVISOR: 'ALLOW' }, true),
  capability('crm.task.write', 'task', 'L1', '创建或更新待办', { ADVISORY: 'DENY', EXECUTOR: 'ALLOW', SUPERVISOR: 'ALLOW' }),
  capability('crm.research.start', 'research', 'L1', '启动客户背调', { ADVISORY: 'DENY', EXECUTOR: 'ALLOW', SUPERVISOR: 'ALLOW' }),
  capability('channel.wechat.manage', 'channel', 'L4', '绑定或解除负责人微信', { ADVISORY: 'DENY', EXECUTOR: 'APPROVAL_REQUIRED', SUPERVISOR: 'APPROVAL_REQUIRED' }),
  capability('infrastructure.shell', 'infrastructure', 'F', '任意 Shell', { ADVISORY: 'DENY', EXECUTOR: 'DENY', SUPERVISOR: 'DENY' }),
  capability('infrastructure.sql', 'infrastructure', 'F', '任意 SQL', { ADVISORY: 'DENY', EXECUTOR: 'DENY', SUPERVISOR: 'DENY' }),
  capability('infrastructure.secrets', 'infrastructure', 'F', '读取密钥', { ADVISORY: 'DENY', EXECUTOR: 'DENY', SUPERVISOR: 'DENY' }),
] as const;

const CAPABILITY_BY_ID = new Map(ASSISTANT_CAPABILITIES.map((item) => [item.id, item]));

export function getAssistantCapability(id: string): AssistantCapabilityDefinition | null {
  return CAPABILITY_BY_ID.get(id) || null;
}

export function resolveAssistantCapabilityDecision(
  preset: AssistantPermissionPresetValue,
  capabilityId: string,
  overrides: Record<string, AssistantPolicyDecisionValue> = {},
  hasTemporaryGrant = false,
): AssistantPolicyDecisionValue {
  const definition = getAssistantCapability(capabilityId);
  if (!definition) return 'DENY';
  if (definition.risk === 'F') return 'DENY';

  const requested = overrides[capabilityId] || definition.defaults[preset];
  if (definition.risk === 'L4' && requested === 'ALLOW') return 'APPROVAL_REQUIRED';
  if (
    hasTemporaryGrant
    && definition.temporaryGrantAllowed
    && requested === 'APPROVAL_REQUIRED'
  ) {
    return 'ALLOW';
  }
  return requested;
}

export function validateAssistantOverrides(
  overrides: Record<string, unknown>,
): Record<string, AssistantPolicyDecisionValue> {
  const normalized: Record<string, AssistantPolicyDecisionValue> = {};
  for (const [id, value] of Object.entries(overrides)) {
    const definition = getAssistantCapability(id);
    if (!definition) throw new Error(`Unknown assistant capability: ${id}`);
    if (!ASSISTANT_POLICY_DECISIONS.includes(value as AssistantPolicyDecisionValue)) {
      throw new Error(`Invalid policy decision for ${id}`);
    }
    const decision = value as AssistantPolicyDecisionValue;
    normalized[id] = definition.risk === 'F'
      ? 'DENY'
      : definition.risk === 'L4' && decision === 'ALLOW'
        ? 'APPROVAL_REQUIRED'
        : decision;
  }
  return normalized;
}
