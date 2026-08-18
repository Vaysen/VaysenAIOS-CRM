'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRuntimeRouteParam } from '@/lib/use-runtime-route-param';
import api from '@/lib/api';
import {
  formatOpportunityAmount,
  formatOpportunityContact,
  formatOpportunityDate,
  formatOpportunityLead,
  formatOpportunityOwner,
  OPPORTUNITY_CONTACT_ROLE_LABELS,
  OPPORTUNITY_CONTACT_ROLE_TYPES,
  OPPORTUNITY_STAGE_LABELS,
  OPPORTUNITY_STAGE_TRANSITIONS,
  type Opportunity,
  type OpportunityContactDirectoryItem,
  type OpportunityContactRole,
  type OpportunityHistoryResponse,
  type OpportunityContactRoleResponse,
  type OpportunityContactRoleType,
  type OpportunityStage,
} from '@/types/opportunity';

export default function OpportunityDetailPage() {
  const id = useRuntimeRouteParam('id');
  const [opportunity, setOpportunity] = useState<Opportunity | null>(null);
  const [history, setHistory] = useState<OpportunityHistoryResponse['data']>([]);
  const [roles, setRoles] = useState<OpportunityContactRole[]>([]);
  const [contacts, setContacts] = useState<OpportunityContactDirectoryItem[]>([]);
  const [contactsLoading, setContactsLoading] = useState(true);
  const [contactsError, setContactsError] = useState<string | null>(null);
  const [rolesLoading, setRolesLoading] = useState(true);
  const [roleLoadError, setRoleLoadError] = useState<string | null>(null);
  const [roleError, setRoleError] = useState<string | null>(null);
  const [roleSaving, setRoleSaving] = useState(false);
  const [selectedContactId, setSelectedContactId] = useState('');
  const [selectedRoleType, setSelectedRoleType] = useState<OpportunityContactRoleType>('buyer');
  const [selectedIsPrimary, setSelectedIsPrimary] = useState(false);
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null);
  const [nextStage, setNextStage] = useState<OpportunityStage | ''>('');
  const [note, setNote] = useState('');
  const [lostReason, setLostReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const loadContactRoles = useCallback(async () => {
    setRolesLoading(true);
    setRoleLoadError(null);
    setRoleError(null);
    try {
      const roleResponse = await api.get<OpportunityContactRoleResponse>(`/opportunities/${id}/contact-roles`);
      setRoles(roleResponse.data?.data || []);
    } catch (requestError: unknown) {
      setRoles([]);
      const message = getContactRoleError(requestError, '联系人角色加载失败');
      setRoleLoadError(message);
      setRoleError(message);
    } finally {
      setRolesLoading(false);
    }
  }, [id]);

  const loadContacts = useCallback(async (leadId: string) => {
    setContactsLoading(true);
    setContactsError(null);
    try {
      const contactResponse = await api.get<OpportunityContactDirectoryItem[]>(`/customer-assets/${leadId}/contacts`);
      setContacts(contactResponse.data || []);
    } catch (requestError: unknown) {
      setContacts([]);
      setContactsError(getContactDirectoryError(requestError));
    } finally {
      setContactsLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setRoleLoadError(null);
    setRoleError(null);
    setContactsError(null);
    try {
      const [detailResponse, historyResponse] = await Promise.all([
        api.get<Opportunity>(`/opportunities/${id}`),
        api.get<OpportunityHistoryResponse>(`/opportunities/${id}/stage-history`),
      ]);
      const loadedOpportunity = detailResponse.data;
      setOpportunity(loadedOpportunity);
      setHistory(historyResponse.data?.data || []);
      setNextStage('');
      setLostReason('');
      setEditingRoleId(null);
      setSelectedContactId('');
      await Promise.all([loadContactRoles(), loadContacts(loadedOpportunity.leadId)]);
    } catch (requestError: any) {
      setError(requestError?.response?.data?.message || '商机加载失败，请稍后重试。');
    } finally { setLoading(false); }
  }, [id, loadContactRoles, loadContacts]);

  useEffect(() => { void load(); }, [load]);

  const resetRoleForm = () => {
    setEditingRoleId(null);
    setSelectedContactId('');
    setSelectedRoleType('buyer');
    setSelectedIsPrimary(false);
  };

  const saveContactRole = async () => {
    if (!selectedContactId) {
      setRoleError('请选择可信联系人。');
      return;
    }
    setRoleSaving(true);
    setRoleError(null);
    const payload = { contactId: selectedContactId, roleType: selectedRoleType, isPrimary: selectedIsPrimary };
    try {
      if (editingRoleId) {
        const response = await api.patch<OpportunityContactRole>(`/opportunities/${id}/contact-roles/${editingRoleId}`, payload);
        setRoles((current) => current.map((role) => role.id === editingRoleId ? response.data : role));
      } else {
        const response = await api.post<OpportunityContactRole>(`/opportunities/${id}/contact-roles`, payload);
        setRoles((current) => [...current, response.data]);
      }
      resetRoleForm();
    } catch (requestError: unknown) {
      setRoleError(getContactRoleError(requestError, editingRoleId ? '联系人角色更新失败' : '联系人角色添加失败'));
    } finally {
      setRoleSaving(false);
    }
  };

  const startEditingRole = (role: OpportunityContactRole) => {
    if (!contacts.some((contact) => contact.id === role.contactId)) {
      setRoleError('该角色联系人不在当前可信目录中，暂不可编辑。');
      return;
    }
    setRoleError(null);
    setEditingRoleId(role.id);
    setSelectedContactId(role.contactId);
    setSelectedRoleType(role.roleType);
    setSelectedIsPrimary(role.isPrimary);
  };

  const removeContactRole = async (roleId: string) => {
    setRoleSaving(true);
    setRoleError(null);
    try {
      const response = await api.delete<{ removed: boolean }>(`/opportunities/${id}/contact-roles/${roleId}`);
      if (!response.data?.removed) {
        setRoleError('联系人角色删除未确认，请刷新后重试。');
        return;
      }
      await loadContactRoles();
      if (editingRoleId === roleId) resetRoleForm();
    } catch (requestError: unknown) {
      setRoleError(getContactRoleError(requestError, '联系人角色删除失败'));
    } finally {
      setRoleSaving(false);
    }
  };

  const transition = async () => {
    if (!opportunity || !nextStage || nextStage === opportunity.stage) return;
    if (nextStage === 'lost' && !lostReason.trim()) { setError('输单必须填写原因。'); return; }
    setSaving(true); setError(null); setConflict(false);
    try {
      const response = await api.post<Opportunity>(`/opportunities/${id}/stage`, { stage: nextStage, version: opportunity.version, note: note.trim() || undefined, lostReason: nextStage === 'lost' ? lostReason.trim() : undefined });
      setOpportunity(response.data);
      const historyResponse = await api.get<OpportunityHistoryResponse>(`/opportunities/${id}/stage-history`);
      setHistory(historyResponse.data?.data || []);
      setNextStage(''); setNote(''); setLostReason('');
    } catch (requestError: any) {
      if (requestError?.response?.status === 409) { setConflict(true); setError('商机已被其他操作更新，请重新加载后重试。'); }
      else setError(requestError?.response?.data?.message || '阶段更新失败。');
    } finally { setSaving(false); }
  };

  if (loading) return <div className="p-12 text-center text-sm text-gray-500">正在加载商机…</div>;
  if (error && !opportunity) return <div className="space-y-4 p-6"><Link href="/opportunities" className="text-sm text-blue-600">← 返回商机</Link><div role="alert" className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div><button type="button" onClick={() => void load()} className="rounded border px-3 py-2 text-sm">重新加载</button></div>;
  if (!opportunity) return null;
  const legalNextStages = OPPORTUNITY_STAGE_TRANSITIONS[opportunity.stage];
  const roleFormDisabled = contactsLoading || Boolean(contactsError) || Boolean(roleLoadError) || contacts.length === 0 || roleSaving;

  return <div className="mx-auto max-w-5xl space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><Link href="/opportunities" className="text-sm text-gray-500 hover:text-blue-600">← 返回商机</Link><h1 className="mt-3 text-2xl font-bold">{opportunity.name}</h1><p className="mt-1 text-sm text-gray-700">客户：{formatOpportunityLead(opportunity.lead)} · 联系人：{formatOpportunityContact(opportunity.lead)}</p><p className="text-sm text-gray-500">负责人：{formatOpportunityOwner(opportunity.owner)} · {OPPORTUNITY_STAGE_LABELS[opportunity.stage]} · 版本 {opportunity.version}</p><p className="text-xs text-gray-400">关联客户 ID：{opportunity.leadId}</p></div><div className="text-right"><p className="text-xl font-semibold">{formatOpportunityAmount(opportunity.amount, opportunity.currency)}</p><p className="text-sm text-gray-500">赢单概率 {opportunity.probability}%</p></div></div>
    {error && <div role="alert" className={`rounded border p-3 text-sm ${conflict ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-red-200 bg-red-50 text-red-700'}`}>{error}{conflict && <button type="button" onClick={() => void load()} className="ml-3 rounded border border-amber-300 bg-white px-2 py-1">重新加载</button>}</div>}
    <div className="grid gap-4 md:grid-cols-3"><Info label="描述" value={opportunity.description || '-'} /><Info label="预计成交" value={formatOpportunityDate(opportunity.expectedCloseDate)} /><Info label="下一步" value={opportunity.nextStep || '-'} /></div>
    <section className="rounded-xl border bg-white p-5"><h2 className="font-semibold">阶段推进</h2>{legalNextStages.length === 0 ? <p className="mt-3 text-sm text-gray-500">当前为终态，后端不允许重新打开。</p> : <div className="mt-3 grid gap-3 md:grid-cols-3"><label className="text-sm text-gray-600">下一阶段<select aria-label="下一阶段" value={nextStage} onChange={(e) => setNextStage(e.target.value as OpportunityStage)} className="mt-1 w-full rounded border px-3 py-2"><option value="">请选择合法下一阶段</option>{legalNextStages.map((stage) => <option key={stage} value={stage}>{OPPORTUNITY_STAGE_LABELS[stage]}</option>)}</select></label>{nextStage === 'lost' && <label className="text-sm text-gray-600">输单原因 *<input aria-label="输单原因" value={lostReason} onChange={(e) => setLostReason(e.target.value)} className="mt-1 w-full rounded border px-3 py-2" /></label>}<label className="text-sm text-gray-600">备注<input aria-label="阶段备注" value={note} onChange={(e) => setNote(e.target.value)} className="mt-1 w-full rounded border px-3 py-2" /></label><button type="button" disabled={!nextStage || saving} onClick={() => void transition()} className="self-end rounded bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-40">{saving ? '保存中…' : '推进阶段'}</button></div>}</section>
    <section className="rounded-xl border bg-white p-5"><h2 className="font-semibold">阶段历史</h2><div className="mt-3 space-y-2">{history.length ? history.map((entry) => <div key={entry.id} className="rounded border p-3 text-sm"><div className="flex flex-wrap justify-between gap-2"><span>{entry.fromStage ? `${OPPORTUNITY_STAGE_LABELS[entry.fromStage]} → ` : '初始 → '}{OPPORTUNITY_STAGE_LABELS[entry.toStage]}</span><time className="text-xs text-gray-500">{formatOpportunityDate(entry.changedAt)}</time></div>{entry.note && <p className="mt-1 text-xs text-gray-500">{entry.note}</p>}</div>) : <p className="text-sm text-gray-500">暂无阶段历史。</p>}</div></section>
    <section className="rounded-xl border bg-white p-5">
      <h2 className="font-semibold">联系人角色</h2>
      <p className="mt-1 text-xs text-gray-500">联系人来自当前客户的可信目录；“客户主联系人”来自客户档案，“商机主联系人”仅表示本商机角色。</p>
      {contactsError && <div role="alert" className="mt-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{contactsError}</div>}
      {roleError && <div role="alert" className="mt-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{roleError}</div>}
      {rolesLoading ? <p className="mt-3 text-sm text-gray-500">正在加载联系人角色…</p> : roles.length ? <div className="mt-3 space-y-2">{roles.map((role) => <div key={role.id} className="flex flex-wrap items-start justify-between gap-3 rounded border p-3 text-sm">
        <div>
          <p className="font-medium">{formatRoleContactName(role)}</p>
          {role.contact?.title && <p className="text-xs text-gray-500">{role.contact.title}</p>}
          <div className="mt-1 flex flex-wrap gap-2 text-xs text-gray-500"><span>{OPPORTUNITY_CONTACT_ROLE_LABELS[role.roleType]}</span>{role.contact?.isPrimary && <span className="text-emerald-600">客户主联系人</span>}{role.isPrimary && <span className="text-blue-600">商机主联系人</span>}</div>
        </div>
        <div className="flex gap-2"><button type="button" disabled={roleSaving || contactsLoading} onClick={() => startEditingRole(role)} className="rounded border px-2 py-1 text-xs disabled:opacity-40">编辑</button><button type="button" disabled={roleSaving} onClick={() => void removeContactRole(role.id)} className="rounded border border-red-200 px-2 py-1 text-xs text-red-600 disabled:opacity-40">删除</button></div>
      </div>)}</div> : <p className="mt-3 text-sm text-gray-500">暂无联系人角色。</p>}
      {!contactsLoading && !contactsError && contacts.length === 0 && <p className="mt-3 text-sm text-gray-500">当前客户暂无可选联系人，无法添加联系人角色。</p>}
      {!contactsLoading && !contactsError && contacts.length > 0 && <div className="mt-4 rounded-lg border border-dashed p-4">
        <div className="grid gap-3 md:grid-cols-3">
          <label className="text-sm text-gray-600">联系人<select aria-label="可信联系人" value={selectedContactId} onChange={(event) => setSelectedContactId(event.target.value)} disabled={roleFormDisabled} className="mt-1 w-full rounded border px-3 py-2"><option value="">请选择联系人</option>{contacts.map((contact) => <option key={contact.id} value={contact.id}>{formatDirectoryContactName(contact)}{contact.title ? ` · ${contact.title}` : ''}{contact.isPrimary ? ' · 客户主联系人' : ''}</option>)}</select></label>
          <label className="text-sm text-gray-600">角色类型<select aria-label="角色类型" value={selectedRoleType} onChange={(event) => setSelectedRoleType(event.target.value as OpportunityContactRoleType)} disabled={roleFormDisabled} className="mt-1 w-full rounded border px-3 py-2">{OPPORTUNITY_CONTACT_ROLE_TYPES.map((roleType) => <option key={roleType} value={roleType}>{OPPORTUNITY_CONTACT_ROLE_LABELS[roleType]}</option>)}</select></label>
          <label className="flex items-end gap-2 pb-2 text-sm text-gray-600"><input type="checkbox" aria-label="设为商机主联系人" checked={selectedIsPrimary} onChange={(event) => setSelectedIsPrimary(event.target.checked)} disabled={roleFormDisabled} />设为商机主联系人</label>
        </div>
        <div className="mt-3 flex gap-2"><button type="button" disabled={roleFormDisabled || !selectedContactId} onClick={() => void saveContactRole()} className="rounded bg-blue-600 px-3 py-2 text-sm text-white disabled:opacity-40">{editingRoleId ? '保存联系人角色' : '添加联系人角色'}</button>{editingRoleId && <button type="button" disabled={roleSaving} onClick={resetRoleForm} className="rounded border px-3 py-2 text-sm">取消编辑</button>}</div>
      </div>}
    </section>
  </div>;
}

function Info({ label, value }: { label: string; value: string }) { return <div className="rounded-xl border bg-white p-4"><p className="text-xs text-gray-500">{label}</p><p className="mt-1 break-words text-sm">{value}</p></div>; }

function getStatus(error: unknown): number | undefined {
  return (error as { response?: { status?: number } } | null)?.response?.status;
}

function getContactRoleError(error: unknown, fallback: string): string {
  const status = getStatus(error);
  if (status === 403) return '当前账号无权读取或修改联系人角色。';
  if (status === 409) return '联系人角色已被其他操作更新，请刷新后重试。';
  if (status === 400) return '联系人角色请求无效，请检查后重试。';
  return `${fallback}，请稍后重试。`;
}

function getContactDirectoryError(error: unknown): string {
  return getStatus(error) === 403 ? '当前账号无权读取客户联系人目录。' : '客户联系人目录加载失败，请稍后重试。';
}

function formatDirectoryContactName(contact: OpportunityContactDirectoryItem): string {
  return contact.displayName?.trim() || [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim() || '联系人姓名不可用';
}

function formatRoleContactName(role: OpportunityContactRole): string {
  return role.contact?.displayName?.trim() || '联系人摘要不可用';
}
