export type AgentRunKind =
  | 'READ_LEAD_SUMMARY'
  | 'DRAFT_FOLLOW_UP'
  | 'BACKGROUND_RESEARCH'
  | 'OPENCLAW_TOOL';
export type AgentRunStatus =
  'PENDING' | 'RUNNING' | 'AWAITING_APPROVAL' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type AgentTaskStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type AgentAuthorizationStatus =
  'PENDING' | 'CONFIRMED' | 'CONSUMED' | 'EXPIRED' | 'REJECTED';

export interface AgentTask {
  id: string;
  companyId: string;
  runId: string;
  toolName: string;
  status: AgentTaskStatus;
  inputDigest: string;
  result: unknown;
  errorCode: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentAuthorization {
  id: string;
  actionType: string;
  status: AgentAuthorizationStatus;
  expiresAt: string;
  confirmedAt: string | null;
  consumedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentAuditLog {
  id: string;
  companyId: string;
  runId: string;
  actorUserId: string | null;
  eventType: string;
  inputDigest: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  companyId: string;
  operatorUserId: string;
  kind: AgentRunKind;
  status: AgentRunStatus;
  inputDigest: string;
  subjectType: string | null;
  subjectId: string | null;
  result: unknown;
  errorCode: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  tasks: AgentTask[];
  authorizations: AgentAuthorization[];
  auditLogs?: AgentAuditLog[];
  researchReport?: {
    id: string;
    title: string;
    type: string;
    createdAt: string;
  } | null;
}

export const AGENT_STATUS_LABELS: Record<AgentRunStatus, string> = {
  PENDING: '等待执行',
  RUNNING: '执行中',
  AWAITING_APPROVAL: '待管理员授权',
  COMPLETED: '已完成',
  FAILED: '执行失败',
  CANCELLED: '已取消',
};

export const AGENT_KIND_LABELS: Record<AgentRunKind, string> = {
  READ_LEAD_SUMMARY: '读取客户摘要',
  DRAFT_FOLLOW_UP: '生成跟进草稿',
  BACKGROUND_RESEARCH: '客户背景调查',
  OPENCLAW_TOOL: 'OpenClaw 受控工具',
};
