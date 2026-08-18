/**
 * marketing-execution.contract.ts
 *
 * wesley-ai-crm 批次2：投放执行十道闸（纯函数契约）。
 *
 * 十道闸（与 MarketingPreflightAttempt.gate 一一对应）：
 *   1. migration          迁移是否已应用
 *   2. executionEnabled   全局执行开关
 *   3. nodeWhitelist      节点白名单
 *   4. accountReady       投放账号就绪
 *   5. consent            客户同意 GRANTED（fail-closed：UNKNOWN/DENIED 一律拦截）
 *   6. suppression        未被抑制/退订
 *   7. killSwitch         全局/渠道 kill-switch 未激活
 *   8. approval           需要审批时已审批
 *   9. frequency          频控 maxPerContact 未超限
 *  10. window             排程窗口已打开
 *
 * 契约本身为纯函数：DB 取值由调用方（preflight / preview-gate / 执行侧）解析后注入。
 */

export const MARKETING_EXECUTION_GATES = [
  'migration',
  'executionEnabled',
  'nodeWhitelist',
  'accountReady',
  'consent',
  'suppression',
  'killSwitch',
  'approval',
  'frequency',
  'window',
] as const;

export type MarketingExecutionGate = (typeof MARKETING_EXECUTION_GATES)[number];

export interface MarketingExecutionContext {
  companyId: string;
  channel: string;
  contactRef?: string | null;
  leadId?: string | null;
  contactPointId?: string | null;
  campaignId?: string | null;
  campaignStatus?: string | null;
  channelPlan?: {
    id: string;
    channel: string;
    enabled: boolean;
    windowSeconds: number;
    maxPerContact: number;
  } | null;

  // —— 以下由调用方解析注入 ——
  migrationApplied?: boolean;
  executionEnabled?: boolean;
  nodeWhitelisted?: boolean;
  accountReady?: boolean;
  /** R111 批次A: accountReady=false 时的明确原因（如 email 渠道未配置 MARKETING 角色账号） */
  accountReadyReason?: string | null;
  /** fail-closed：缺省视为未同意 */
  consentStatus?: 'GRANTED' | 'DENIED' | 'UNKNOWN' | null;
  suppressed?: boolean;
  killSwitchActive?: boolean;
  killSwitchScope?: string | null;
  approvalRequired?: boolean;
  approvalGranted?: boolean;
  recentDeliveries?: number;
  windowOpen?: boolean;
}

export interface MarketingGateCheck {
  gate: MarketingExecutionGate;
  passed: boolean;
  blockedReason?: string;
  detail?: Record<string, unknown>;
}

export interface MarketingExecutionContractResult {
  passed: boolean;
  checks: MarketingGateCheck[];
  failedGates: MarketingExecutionGate[];
}

export interface MarketingGateRule {
  gate: MarketingExecutionGate;
  label: string;
  check: (ctx: MarketingExecutionContext) => MarketingGateCheck;
}

/** 未注入的布尔开关一律视为“未禁用”（fail-open），安全关键闸（consent/suppression/killSwitch）除外。 */
function openGate(gate: MarketingExecutionGate, label: string, check: (ctx: MarketingExecutionContext) => MarketingGateCheck): MarketingGateRule {
  return { gate, label, check };
}

export const MARKETING_EXECUTION_GATE_RULES: MarketingGateRule[] = [
  openGate('migration', '数据库迁移已应用', (ctx) => {
    const ok = ctx.migrationApplied !== false;
    return {
      gate: 'migration',
      passed: ok,
      blockedReason: ok ? undefined : 'marketing-campaigns migration has not been applied',
    };
  }),
  openGate('executionEnabled', '投放执行开关已开启', (ctx) => {
    const ok = ctx.executionEnabled !== false;
    return {
      gate: 'executionEnabled',
      passed: ok,
      blockedReason: ok ? undefined : 'marketing execution is disabled',
    };
  }),
  openGate('nodeWhitelist', '节点在白名单内', (ctx) => {
    const ok = ctx.nodeWhitelisted !== false;
    return {
      gate: 'nodeWhitelist',
      passed: ok,
      blockedReason: ok ? undefined : 'execution node is not whitelisted',
    };
  }),
  openGate('accountReady', '投放账号就绪', (ctx) => {
    const ok = ctx.accountReady !== false;
    return {
      gate: 'accountReady',
      passed: ok,
      blockedReason: ok
        ? undefined
        : (ctx.accountReadyReason ?? 'no ready sending account for channel'),
      detail: ctx.accountReadyReason ? { reason: ctx.accountReadyReason } : undefined,
    };
  }),
  openGate('consent', '客户同意 GRANTED', (ctx) => {
    const ok = ctx.consentStatus === 'GRANTED';
    return {
      gate: 'consent',
      passed: ok,
      blockedReason: ok
        ? undefined
        : `consent is ${ctx.consentStatus ?? 'UNKNOWN'}; GRANTED required`,
      detail: { consentStatus: ctx.consentStatus ?? 'UNKNOWN' },
    };
  }),
  openGate('suppression', '未被抑制/退订', (ctx) => {
    const suppressed = ctx.suppressed === true;
    return {
      gate: 'suppression',
      passed: !suppressed,
      blockedReason: suppressed ? 'contact is suppressed or unsubscribed' : undefined,
    };
  }),
  openGate('killSwitch', '合规 kill-switch 未激活', (ctx) => {
    const active = ctx.killSwitchActive === true;
    return {
      gate: 'killSwitch',
      passed: !active,
      blockedReason: active
        ? `kill-switch active${ctx.killSwitchScope ? ` (${ctx.killSwitchScope})` : ''}`
        : undefined,
      detail: ctx.killSwitchScope ? { scope: ctx.killSwitchScope } : undefined,
    };
  }),
  openGate('approval', '审批要求已满足', (ctx) => {
    const required = ctx.approvalRequired === true;
    const granted = ctx.approvalGranted === true;
    const ok = !required || granted;
    return {
      gate: 'approval',
      passed: ok,
      blockedReason: ok ? undefined : 'approval required but not yet granted',
      detail: { approvalRequired: required, approvalGranted: granted },
    };
  }),
  openGate('frequency', '频控未超限', (ctx) => {
    const maxPerContact = ctx.channelPlan?.maxPerContact ?? 1;
    const recent = ctx.recentDeliveries ?? 0;
    const ok = recent < maxPerContact;
    return {
      gate: 'frequency',
      passed: ok,
      blockedReason: ok ? undefined : `frequency capped: ${recent}/${maxPerContact} in window`,
      detail: { recentDeliveries: recent, maxPerContact },
    };
  }),
  openGate('window', '排程窗口已打开', (ctx) => {
    const ok = ctx.windowOpen !== false;
    return {
      gate: 'window',
      passed: ok,
      blockedReason: ok ? undefined : 'delivery outside the scheduled window',
    };
  }),
];

export function evaluateMarketingExecutionContract(
  ctx: MarketingExecutionContext,
): MarketingExecutionContractResult {
  const checks = MARKETING_EXECUTION_GATE_RULES.map((rule) => rule.check(ctx));
  const failedGates = checks.filter((c) => !c.passed).map((c) => c.gate);
  return {
    passed: failedGates.length === 0,
    checks,
    failedGates,
  };
}
