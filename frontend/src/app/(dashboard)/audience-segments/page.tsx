'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, Search, Users, RefreshCw, Loader2, Eye, Trash2, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  listAudienceSegments,
  createAudienceSegment,
  deleteAudienceSegment,
  refreshAudienceSegment,
  getAudienceSegment,
} from '@/lib/audience-segment-api';
import {
  AUDIENCE_SEGMENT_STATUS_LABELS,
  LEAD_STATUS_OPTIONS,
  LEAD_GRADE_OPTIONS,
} from '@/types/audience-segment';
import type { AudienceSegment, AudienceSegmentCriteria } from '@/types/audience-segment';

const PRESET_SEGMENTS: { name: string; desc: string; criteria: AudienceSegmentCriteria }[] = [
  {
    name: '近30天新客',
    desc: '最近 30 天内入库的新客户',
    criteria: { createdWithinDays: 30, hasEmail: true },
  },
  {
    name: '样品单客户',
    desc: '曾询价/要过样品的客户',
    criteria: { hasSampleQuote: true },
  },
  {
    name: '已跟进未回复',
    desc: '联系过但超过 7 天未回复',
    criteria: { followedUpNoReplyDays: 7 },
  },
  {
    name: '订单客户',
    desc: '已有成交订单的客户',
    criteria: { hasOrder: true },
  },
  {
    name: 'WhatsApp 可触达',
    desc: '有 WhatsApp 联系方式的客户',
    criteria: { hasWhatsapp: true },
  },
];

export default function AudienceSegmentsPage() {
  const [segments, setSegments] = useState<AudienceSegment[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  // 创建弹窗
  const [showCreate, setShowCreate] = useState(false);
  const [editCriteria, setEditCriteria] = useState<AudienceSegmentCriteria>({});
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [creating, setCreating] = useState(false);
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [previewing, setPreviewing] = useState(false);

  // 成员抽屉
  const [selected, setSelected] = useState<AudienceSegment | null>(null);
  const [members, setMembers] = useState<any[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await listAudienceSegments({ page, pageSize, search: search || undefined });
      setSegments(data?.items || []);
      setTotal(data?.total || 0);
    } catch (err: any) {
      setError(`客群加载失败: ${err.response?.data?.message || err.message}`);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize]);

  useEffect(() => { load(); }, [load]);

  const filtered = segments.filter((s) =>
    !search || s.name.toLowerCase().includes(search.toLowerCase()),
  );

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      await createAudienceSegment({
        name: newName.trim(),
        description: newDesc.trim() || undefined,
        criteriaJson: editCriteria,
        autoRefreshEnabled: true,
        autoRefreshIntervalHours: 24,
      });
      setShowCreate(false);
      setNewName('');
      setNewDesc('');
      setEditCriteria({});
      setPreviewCount(null);
      await load();
    } catch (err: any) {
      setError(`创建失败: ${err.response?.data?.message || err.message}`);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('确认删除该客群？成员记录将一并清除。')) return;
    try {
      await deleteAudienceSegment(id);
      await load();
    } catch (err: any) {
      setError(`删除失败: ${err.response?.data?.message || err.message}`);
    }
  };

  const handleRefresh = async (id: string) => {
    try {
      await refreshAudienceSegment(id);
      await load();
      if (selected?.id === id) await openDetail(id);
    } catch (err: any) {
      setError(`刷新失败: ${err.response?.data?.message || err.message}`);
    }
  };

  const openDetail = async (id: string) => {
    setSelected(segments.find((s) => s.id === id) || null);
    setDetailLoading(true);
    try {
      const data = await getAudienceSegment(id, { includeMembers: true, pageSize: 100 });
      setMembers((data as any).members || []);
      setSelected(data as any);
    } catch (err: any) {
      setError(`详情加载失败: ${err.response?.data?.message || err.message}`);
    } finally {
      setDetailLoading(false);
    }
  };

  const handlePreview = async () => {
    if (!newName.trim()) {
      setError('请先填写客群名称，再预览命中数');
      return;
    }
    setPreviewing(true);
    setPreviewCount(null);
    try {
      const tmp = await createAudienceSegment({
        name: `__preview_${Date.now()}__`,
        criteriaJson: editCriteria,
      });
      try {
        setPreviewCount((tmp as any).memberCount ?? 0);
      } finally {
        await deleteAudienceSegment(tmp.id).catch(() => {});
      }
    } catch (err: any) {
      setError(`预览失败: ${err.response?.data?.message || err.message}`);
    } finally {
      setPreviewing(false);
    }
  };

  const setCriteria = (patch: Partial<AudienceSegmentCriteria>) => {
    setEditCriteria((prev) => ({ ...prev, ...patch }));
  };

  const criteriaSummary = (c: AudienceSegmentCriteria) => {
    const parts: string[] = [];
    if (c.createdWithinDays) parts.push(`近${c.createdWithinDays}天新客`);
    if (c.hasSampleQuote) parts.push('样品单');
    if (c.hasOrder) parts.push('订单客户');
    if (c.followedUpNoReplyDays) parts.push(`未回复>${c.followedUpNoReplyDays}天`);
    if (c.hasEmail) parts.push('有邮箱');
    if (c.hasWhatsapp) parts.push('有WhatsApp');
    if (c.countries?.length) parts.push(`国家(${c.countries.length})`);
    if (c.leadStatuses?.length) parts.push(`阶段(${c.leadStatuses.length})`);
    if (c.leadGrades?.length) parts.push(`分级(${c.leadGrades.join('/')})`);
    if (c.sourceTypes?.length) parts.push(`来源(${c.sourceTypes.length})`);
    if (c.tags?.length) parts.push(`标签(${c.tags.length})`);
    return parts.length ? parts.join(' + ') : '全部客户';
  };

  return (
    <div className="mx-auto max-w-7xl p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">客群管理</h1>
          <p className="mt-1 text-sm text-gray-500">
            按条件筛选客户形成客群，供营销活动定向发送
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          <Plus className="h-4 w-4" /> 新建客群
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      {/* 预设客群快捷入口 */}
      <div className="mt-6">
        <h2 className="mb-2 text-sm font-semibold text-gray-700">预设客群</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {PRESET_SEGMENTS.map((p) => (
            <button
              key={p.name}
              onClick={() => {
                setEditCriteria(p.criteria);
                setNewName(p.name);
                setNewDesc(p.desc);
                setShowCreate(true);
              }}
              className="rounded-xl border border-gray-200 bg-white p-3 text-left transition hover:border-blue-300 hover:shadow-sm"
            >
              <div className="text-sm font-medium text-gray-900">{p.name}</div>
              <div className="mt-1 line-clamp-2 text-xs text-gray-500">{p.desc}</div>
            </button>
          ))}
        </div>
      </div>

      {/* 客群列表 */}
      <div className="mt-6 rounded-xl border border-gray-200 bg-white">
        <div className="flex items-center gap-3 border-b border-gray-100 p-4">
          <Search className="h-4 w-4 text-gray-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索客群名称..."
            className="flex-1 text-sm outline-none"
          />
          <span className="text-xs text-gray-400">共 {total} 个客群</span>
        </div>
        {loading ? (
          <div className="flex items-center justify-center py-16 text-gray-400">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-gray-400">
            <Users className="mb-2 h-8 w-8" />
            <div className="text-sm">还没有客群，点击右上角新建</div>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
                <th className="px-4 py-3 font-medium">名称</th>
                <th className="px-4 py-3 font-medium">筛选条件</th>
                <th className="px-4 py-3 font-medium">成员数</th>
                <th className="px-4 py-3 font-medium">自动刷新</th>
                <th className="px-4 py-3 font-medium">状态</th>
                <th className="px-4 py-3 font-medium">最近刷新</th>
                <th className="px-4 py-3 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <tr key={s.id} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <button
                      onClick={() => openDetail(s.id)}
                      className="font-medium text-gray-900 hover:text-blue-600"
                    >
                      {s.name}
                    </button>
                    {s.description && (
                      <div className="mt-0.5 max-w-xs truncate text-xs text-gray-400">
                        {s.description}
                      </div>
                    )}
                  </td>
                  <td className="max-w-xs px-4 py-3 text-xs text-gray-600">
                    {criteriaSummary(s.criteriaJson)}
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                      <Users className="h-3 w-3" /> {s.memberCount}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-600">
                    {s.autoRefreshEnabled ? `${s.autoRefreshIntervalHours}h` : '关闭'}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        s.status === 'active'
                          ? 'bg-green-50 text-green-700'
                          : 'bg-gray-100 text-gray-500'
                      }`}
                    >
                      {AUDIENCE_SEGMENT_STATUS_LABELS[s.status] || s.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {s.lastRefreshedAt
                      ? new Date(s.lastRefreshedAt).toLocaleString()
                      : '未刷新'}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => handleRefresh(s.id)}
                        title="立即刷新成员"
                        className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-blue-600"
                      >
                        <RefreshCw className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => openDetail(s.id)}
                        title="查看成员"
                        className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-blue-600"
                      >
                        <Eye className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(s.id)}
                        title="删除"
                        className="rounded p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {total > pageSize && (
          <div className="flex items-center justify-between border-t border-gray-100 p-3">
            <span className="text-xs text-gray-500">
              第 {page} / {Math.ceil(total / pageSize)} 页
            </span>
            <div className="flex gap-2">
              <button
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
                className="rounded-lg border border-gray-200 p-1.5 disabled:opacity-40"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                disabled={page >= Math.ceil(total / pageSize)}
                onClick={() => setPage((p) => p + 1)}
                className="rounded-lg border border-gray-200 p-1.5 disabled:opacity-40"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 创建客群弹窗 */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-900">新建客群</h2>
              <button
                onClick={() => setShowCreate(false)}
                className="rounded p-1 text-gray-400 hover:bg-gray-100"
              >
                ×
              </button>
            </div>

            <div className="mt-4 space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">客群名称</label>
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  placeholder="如：美国市场近30天新客"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">描述</label>
                <input
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  placeholder="客群用途说明"
                />
              </div>

              {/* 筛选条件 */}
              <div className="rounded-xl border border-gray-200 p-4">
                <div className="mb-3 text-sm font-semibold text-gray-700">筛选条件</div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-xs text-gray-500">近 N 天新客</label>
                    <input
                      type="number"
                      min={1}
                      value={editCriteria.createdWithinDays ?? ''}
                      onChange={(e) =>
                        setCriteria({ createdWithinDays: e.target.value ? Number(e.target.value) : undefined })
                      }
                      className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
                      placeholder="留空=不限"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-gray-500">未回复超 N 天</label>
                    <input
                      type="number"
                      min={1}
                      value={editCriteria.followedUpNoReplyDays ?? ''}
                      onChange={(e) =>
                        setCriteria({ followedUpNoReplyDays: e.target.value ? Number(e.target.value) : undefined })
                      }
                      className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
                      placeholder="留空=不限"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-gray-500">客户阶段（可多选）</label>
                    <select
                      multiple
                      value={editCriteria.leadStatuses || []}
                      onChange={(e) =>
                        setCriteria({
                          leadStatuses: Array.from(e.target.selectedOptions, (o) => o.value),
                        })
                      }
                      className="h-24 w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
                    >
                      {LEAD_STATUS_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-gray-500">客户分级</label>
                    <select
                      multiple
                      value={editCriteria.leadGrades || []}
                      onChange={(e) =>
                        setCriteria({ leadGrades: Array.from(e.target.selectedOptions, (o) => o.value) })
                      }
                      className="h-24 w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
                    >
                      {LEAD_GRADE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-gray-500">国家（逗号分隔）</label>
                    <input
                      value={(editCriteria.countries || []).join(',')}
                      onChange={(e) =>
                        setCriteria({
                          countries: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                        })
                      }
                      className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
                      placeholder="如 US,DE,GB"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-gray-500">来源（逗号分隔）</label>
                    <input
                      value={(editCriteria.sourceTypes || []).join(',')}
                      onChange={(e) =>
                        setCriteria({
                          sourceTypes: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                        })
                      }
                      className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
                      placeholder="如 alibaba,website"
                    />
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-3">
                  <label className="flex items-center gap-1.5 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={!!editCriteria.hasSampleQuote}
                      onChange={(e) => setCriteria({ hasSampleQuote: e.target.checked })}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                    样品单客户
                  </label>
                  <label className="flex items-center gap-1.5 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={!!editCriteria.hasOrder}
                      onChange={(e) => setCriteria({ hasOrder: e.target.checked })}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                    订单客户
                  </label>
                  <label className="flex items-center gap-1.5 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={!!editCriteria.hasEmail}
                      onChange={(e) => setCriteria({ hasEmail: e.target.checked })}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                    有邮箱
                  </label>
                  <label className="flex items-center gap-1.5 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={!!editCriteria.hasWhatsapp}
                      onChange={(e) => setCriteria({ hasWhatsapp: e.target.checked })}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                    有 WhatsApp
                  </label>
                </div>
              </div>

              {/* 预览 */}
              <div className="flex items-center gap-3">
                <button
                  onClick={handlePreview}
                  disabled={previewing}
                  className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  {previewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
                  预览命中数
                </button>
                {previewCount !== null && (
                  <span className="text-sm font-medium text-blue-700">
                    预计命中 {previewCount} 个客户
                  </span>
                )}
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => setShowCreate(false)}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
              >
                取消
              </button>
              <button
                onClick={handleCreate}
                disabled={creating || !newName.trim()}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : '创建客群'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 成员抽屉 */}
      {selected && (
        <div className="fixed inset-0 z-50 bg-black/40" onClick={() => setSelected(null)}>
          <div
            className="absolute right-0 top-0 flex h-full w-full max-w-2xl flex-col bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-gray-100 p-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">{selected.name}</h2>
                <div className="mt-0.5 text-xs text-gray-500">
                  {criteriaSummary(selected.criteriaJson)} · 共 {selected.memberCount} 人
                </div>
              </div>
              <button
                onClick={() => setSelected(null)}
                className="rounded p-1 text-gray-400 hover:bg-gray-100"
              >
                ×
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {detailLoading ? (
                <div className="flex items-center justify-center py-16 text-gray-400">
                  <Loader2 className="h-6 w-6 animate-spin" />
                </div>
              ) : members.length === 0 ? (
                <div className="py-16 text-center text-sm text-gray-400">
                  该客群暂无成员，点击&ldquo;刷新&rdquo;重新计算
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
                      <th className="px-3 py-2 font-medium">客户</th>
                      <th className="px-3 py-2 font-medium">国家</th>
                      <th className="px-3 py-2 font-medium">来源</th>
                      <th className="px-3 py-2 font-medium">状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((m: any) => (
                      <tr key={m.id} className="border-b border-gray-50">
                        <td className="px-3 py-2">
                          <div className="font-medium text-gray-900">
                            {m.lead?.companyName || m.lead?.leadName || '未命名'}
                          </div>
                          <div className="text-xs text-gray-400">{m.lead?.contactEmail || m.lead?.whatsapp || ''}</div>
                        </td>
                        <td className="px-3 py-2 text-xs text-gray-600">{m.lead?.country || '-'}</td>
                        <td className="px-3 py-2 text-xs text-gray-600">{m.lead?.sourceType || '-'}</td>
                        <td className="px-3 py-2 text-xs text-gray-600">{m.lead?.status || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
