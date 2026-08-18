import api from '@/lib/api';

export type AssistantToolExecution = {
  id: string;
  toolName: string;
  state: 'REQUESTED' | 'PLANNING' | 'AWAITING_CONFIRMATION' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  confirmationRequired: boolean;
  parameterSummary: Record<string, unknown>;
  result?: Record<string, unknown> | null;
  resultRef?: Record<string, unknown> | null;
  errorCode?: string | null;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
};

export async function listAssistantToolHistory(companyId: string) {
  const response = await api.get<AssistantToolExecution[]>('/assistant-tools/history', { params: { companyId } });
  return response.data;
}

export async function planAssistantTool(input: { companyId: string; toolName: string; parameters: Record<string, unknown>; requestId?: string }) {
  const response = await api.post<AssistantToolExecution>('/assistant-tools/plan', input);
  return response.data;
}

export async function confirmAssistantTool(id: string) {
  const response = await api.post<AssistantToolExecution>(`/assistant-tools/${encodeURIComponent(id)}/confirm`, {});
  return response.data;
}

export async function cancelAssistantTool(id: string) {
  const response = await api.post<AssistantToolExecution>(`/assistant-tools/${encodeURIComponent(id)}/cancel`, {});
  return response.data;
}
