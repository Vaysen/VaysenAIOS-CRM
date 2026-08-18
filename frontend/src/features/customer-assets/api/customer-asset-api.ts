/**
 * TASK-102H: 客户资产 API 层
 *
 * 基于 fetch 的封装，所有请求携带 Authorization header。
 * 支持 AbortSignal 以便 hook 层取消请求。
 * 禁止 any；禁止组件直接调用此层（必须通过 hooks）。
 */

import type {
  CustomerAsset,
  DuplicateCheckCommand,
  DuplicateCheckResult,
  MergeCommand,
  MergePreview,
  MergeResult,
} from '../types';

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

interface FetchOptions extends RequestInit {
  signal?: AbortSignal;
}

/**
 * 读取 localStorage 中的 access_token。
 * 使用 typeof window 守卫，避免 SSR / 非 Electron 环境报错。
 */
function getAuthToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('access_token');
}

/**
 * 读取 localStorage 中的 active_company_id。
 */
function getActiveCompanyId(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('active_company_id');
}

/**
 * 统一 fetch 封装。
 * - 自动注入 Authorization 和 X-Company-Id header
 * - 统一错误处理
 * - 支持 AbortSignal
 */
async function apiFetch<T>(
  path: string,
  options: FetchOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) ?? {}),
  };

  const token = getAuthToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const companyId = getActiveCompanyId();
  if (companyId) {
    headers['X-Company-Id'] = companyId;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    let message = `请求失败: ${response.status}`;
    try {
      const body = await response.json();
      message = body.message || body.error || message;
    } catch (error) {
      console.warn('[customer-assets] API error response was not JSON', error instanceof Error ? error.message : 'unknown');
      // 响应体非 JSON，使用默认消息
    }
    throw new Error(message);
  }

  // 204 No Content
  if (response.status === 204) {
    return undefined as T;
  }

  const json = await response.json();
  // 兼容后端 { data: ... } 包装
  return (json.data ?? json) as T;
}

function formatContactName(contact: { displayName?: string | null; firstName?: string | null; lastName?: string | null }): string {
  return contact.displayName?.trim()
    || [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim()
    || '未命名联系人';
}

function normalizeAsset(raw: Record<string, unknown>): CustomerAsset {
  const rawContacts = Array.isArray(raw.contacts) ? raw.contacts : [];
  return {
    id: String(raw.id),
    companyName: typeof raw.companyName === 'string' ? raw.companyName : null,
    displayName: typeof raw.displayName === 'string' ? raw.displayName : '公司待补充',
    countryIso2: typeof raw.countryIso2 === 'string' ? raw.countryIso2 : null,
    contacts: rawContacts.map((contact) => {
      const item = contact as Record<string, unknown>;
      const points = Array.isArray(item.contactPoints) ? item.contactPoints : [];
      return {
        id: String(item.id),
        firstName: typeof item.firstName === 'string' ? item.firstName : null,
        lastName: typeof item.lastName === 'string' ? item.lastName : null,
        displayName: formatContactName(item),
        isPrimary: item.isPrimary === true,
        contactPoints: points.map((point) => {
          const cp = point as Record<string, unknown>;
          const conversationIds = Array.isArray(cp.conversationIds)
            ? cp.conversationIds.map(String)
            : cp.conversationId ? [String(cp.conversationId)] : [];
          return {
            id: String(cp.id),
            type: (String(cp.type) as CustomerAsset['contacts'][number]['contactPoints'][number]['type']),
            originalValue: String(cp.originalValue ?? ''),
            normalizedValue: String(cp.normalizedValue ?? ''),
            conversationId: conversationIds[0] ?? null,
            isAvailable: cp.isAvailable === true || conversationIds.length > 0,
          };
        }),
        updatedAt: String(item.updatedAt ?? raw.updatedAt),
      };
    }),
    selectedContactId: typeof raw.selectedContactId === 'string' ? raw.selectedContactId : null,
    pendingMatchCount: Number(raw.pendingMatchCount ?? 0),
    pendingCandidates: (Array.isArray(raw.pendingCandidates) ? raw.pendingCandidates : []).map((candidate) => {
      const item = candidate as Record<string, unknown>;
      return {
        id: String(item.id),
        companyName: typeof item.companyName === 'string' ? item.companyName : null,
        displayName: typeof item.displayName === 'string' ? item.displayName : '候选客户',
        matchedChannel: String(item.matchedChannel ?? 'manual') as CustomerAsset['pendingCandidates'][number]['matchedChannel'],
        confidence: Number(item.confidence ?? item.score ?? 0) / (Number(item.score) > 1 ? 100 : 1),
        contactPointPreview: String(item.contactPointPreview ?? item.sourceLeadId ?? ''),
        updatedAt: String(item.updatedAt ?? item.createdAt ?? raw.updatedAt),
      };
    }),
    conversations: (Array.isArray(raw.conversations) ? raw.conversations : []).map((conversation) => {
      const item = conversation as Record<string, unknown>;
      return {
        id: String(item.id),
        channel: typeof item.channel === 'string' ? item.channel : undefined,
        subject: typeof item.subject === 'string' ? item.subject : null,
        threadKey: typeof item.threadKey === 'string' ? item.threadKey : null,
      };
    }),
    emails: (Array.isArray(raw.emails) ? raw.emails : []).map((email) => {
      const item = email as Record<string, unknown>;
      return {
        id: String(item.id),
        subject: typeof item.subject === 'string' ? item.subject : null,
        sentAt: typeof item.sentAt === 'string' ? item.sentAt : null,
        receivedAt: typeof item.receivedAt === 'string' ? item.receivedAt : null,
      };
    }),
    quotes: (Array.isArray(raw.quotes) ? raw.quotes : []).map((quote) => {
      const item = quote as Record<string, unknown>;
      return { id: String(item.id), status: typeof item.status === 'string' ? item.status : undefined, createdAt: String(item.createdAt ?? '') };
    }),
    orders: (Array.isArray(raw.orders) ? raw.orders : []).map((order) => {
      const item = order as Record<string, unknown>;
      return { id: String(item.id), status: typeof item.status === 'string' ? item.status : undefined, createdAt: String(item.createdAt ?? '') };
    }),
    updatedAt: String(raw.updatedAt ?? new Date().toISOString()),
  };
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * GET /customer-assets/:id
 * 获取客户资产详情（含多联系人）。
 */
export function getCustomerAsset(
  id: string,
  signal?: AbortSignal,
): Promise<CustomerAsset> {
  return apiFetch<Record<string, unknown>>(`/customer-assets/${id}`, { signal }).then(normalizeAsset);
}

/**
 * POST /customer-assets/duplicate-check
 * 查重：按公司名/邮箱/号码检索已有客户。
 */
export function duplicateCheck(
  command: DuplicateCheckCommand,
  signal?: AbortSignal,
): Promise<DuplicateCheckResult> {
  const query = command.query.trim();
  const isEmail = query.includes('@');
  return apiFetch<{ queryLeadId: string; hits: Array<{ leadId: string; companyName: string | null; displayName: string | null; countryIso2: string | null; contactPointPreview: string | null; matchedChannel: string; matchedValue: string; score: number }> }>(`/customer-assets/duplicate-check`, {
    method: 'POST',
    body: JSON.stringify({
      leadId: command.excludeId ?? '',
      ...(isEmail ? { email: query } : (/^[+\d()\s-]+$/.test(query) ? { phone: query } : { companyName: query })),
    }),
    signal,
  }).then((response) => ({
    hasDuplicates: response.hits.length > 0,
    matches: response.hits.map((hit) => ({
      id: hit.leadId,
      companyName: hit.companyName,
      displayName: hit.displayName || hit.companyName || '公司待补充',
      countryIso2: hit.countryIso2,
      contactPointPreview: hit.contactPointPreview,
      confidence: hit.score / 100,
      matchedField: hit.matchedChannel === 'companyName' ? 'companyName' : hit.matchedChannel === 'email' ? 'email' : 'phone',
    })),
  }));
}

/**
 * GET /customer-assets/:id/contacts
 * 获取客户资产下的联系人列表。
 */
export function getCustomerContacts(
  id: string,
  signal?: AbortSignal,
): Promise<CustomerAsset['contacts']> {
  return apiFetch<CustomerAsset['contacts']>(
    `/customer-assets/${id}/contacts`,
    { signal },
  );
}

/**
 * POST /identity-candidates/:id/merge-preview
 * 预览合并差异。
 */
export function mergePreview(
  candidateId: string,
  signal?: AbortSignal,
): Promise<MergePreview> {
  return apiFetch<Record<string, unknown>>(
    `/identity-candidates/${candidateId}/merge-preview`,
    { method: 'POST', signal },
  ).then((raw) => {
    if (Array.isArray(raw.diffs)) {
      return { ...(raw as unknown as MergePreview), targetUpdatedAt: String(raw.targetUpdatedAt ?? '') };
    }
    const fieldDiffs = Array.isArray(raw.fieldDiffs) ? raw.fieldDiffs : [];
    return {
      candidateId,
      targetAssetId: String(raw.targetLeadId ?? ''),
      targetUpdatedAt: String(raw.targetUpdatedAt ?? ''),
      diffs: fieldDiffs.map((diff) => {
        const item = diff as Record<string, unknown>;
        return {
          field: String(item.field ?? ''),
          currentValue: item.targetValue == null ? null : String(item.targetValue),
          candidateValue: item.sourceValue == null ? null : String(item.sourceValue),
          recommendCandidate: item.suggestedWinner === 'source',
        };
      }),
      mergedContactCount: Number(raw.contactCount ?? 0),
      mergedChannelCount: Number(raw.contactPointCount ?? 0),
    };
  });
}

/**
 * POST /identity-candidates/:id/merge
 * 执行合并。
 */
export function merge(
  command: MergeCommand,
  signal?: AbortSignal,
): Promise<MergeResult> {
  return apiFetch<{ auditId: string; targetLeadId: string }>(
    `/identity-candidates/${command.candidateId}/merge`,
    {
      method: 'POST',
      body: JSON.stringify({
        adoptFields: command.adoptFields ?? [],
        targetUpdatedAt: command.targetUpdatedAt,
        mode: command.adoptFields?.length ? 'field_choices' : 'trusted_defaults',
      }),
      signal,
    },
  ).then((result) => ({ auditId: result.auditId, mergedAssetId: result.targetLeadId }));
}

/**
 * POST /identity-candidates/:id/reject
 * 拒绝（标记为非同一客户）。
 */
export function reject(
  candidateId: string,
  signal?: AbortSignal,
): Promise<void> {
  return apiFetch<void>(`/identity-candidates/${candidateId}/reject`, {
    method: 'POST',
    signal,
  });
}

/**
 * POST /customer-merges/:id/undo
 * 撤销合并。
 */
export function undoMerge(auditId: string, signal?: AbortSignal): Promise<void> {
  return apiFetch<void>(`/customer-merges/${auditId}/undo`, {
    method: 'POST',
    signal,
  });
}
