'use client';

import { useEffect, useState } from 'react';
import api from '@/lib/api';

export default function ImapInboundPage() {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [configs, setConfigs] = useState<Record<string, any>>({});
  const [reviews, setReviews] = useState<any[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [syncAllBusy, setSyncAllBusy] = useState(false);
  const load = async () => {
    try {
      const [a, r] = await Promise.all([api.get('/email-accounts', { params: { limit: 100 } }), api.get('/imap-inbound/reviews')]);
      const rows = a.data?.data || []; setAccounts(rows); setReviews(r.data || []);
      const next: Record<string, any> = {};
      await Promise.all(rows.map(async (account: any) => { const c = await api.get(`/imap-inbound/accounts/${account.id}/config`); next[account.id] = c.data; }));
      setConfigs(next);
    } catch (e: any) { setError(e.response?.data?.message || 'Unable to load IMAP inbox state'); }
  };
  useEffect(() => { void load(); }, []);
  const save = async (id: string) => { setBusy(id); try { await api.patch(`/imap-inbound/accounts/${id}/config`, configs[id]); await load(); } catch (e: any) { setError(e.response?.data?.message || 'Save failed'); } finally { setBusy(null); } };
  const action = async (id: string, verb: 'test' | 'sync') => { setBusy(id + verb); try { const result = await api.post(`/imap-inbound/accounts/${id}/${verb}`); if (result.data?.message) setError(result.data.message); await load(); } catch (e: any) { setError(e.response?.data?.message || `${verb} failed`); } finally { setBusy(null); } };
  const syncAll = async () => {
    setSyncAllBusy(true);
    try {
      const result = await api.post('/imap-inbound/sync-all');
      const results = Array.isArray(result.data) ? result.data : [];
      if (results.length === 0) { setError('当前没有已启用且已配置 IMAP 的邮箱账号'); return; }
      const ok = results.filter((r: any) => r.status === 'ok');
      setError(`全部收信完成：${ok.length} 成功 / ${results.length - ok.length} 失败` + (results.filter((r: any) => r.status !== 'ok')[0]?.error ? `（失败示例：${results.filter((r: any) => r.status !== 'ok')[0].error}）` : ''));
      await load();
    } catch (e: any) { setError(e.response?.data?.message || 'sync-all failed'); } finally { setSyncAllBusy(false); }
  };
  const resolve = async (review: any, leadId: string) => { if (!leadId) return; setBusy(review.id); try { await api.post(`/imap-inbound/reviews/${review.id}/resolve`, { leadId }); await load(); } catch (e: any) { setError(e.response?.data?.message || 'Manual link failed'); } finally { setBusy(null); } };
  return <main className="p-6 max-w-6xl mx-auto space-y-6">
    <div className="flex items-center justify-between"><div><h1 className="text-2xl font-semibold">IMAP 收件入库</h1><p className="text-sm text-gray-500 mt-1">仅收件；凭据只显示配置状态，不显示 secret。</p></div><button className="rounded bg-slate-800 text-white px-3 py-1.5 text-sm disabled:opacity-50" disabled={syncAllBusy} onClick={() => void syncAll()}>{syncAllBusy ? '收信中...' : '全部立即同步'}</button></div>
    {error && <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
    <section className="space-y-3">{accounts.length === 0 && <div className="rounded border p-5 text-sm text-gray-500">暂无邮件账号。请先创建账号，再配置 IMAP。</div>}
      {accounts.map((account) => { const c = configs[account.id] || {}; const set = (key: string, value: any) => setConfigs({ ...configs, [account.id]: { ...c, [key]: value } }); return <div key={account.id} className="rounded border bg-white p-5 shadow-sm space-y-4">
        <div className="flex justify-between"><div><h2 className="font-medium">{account.senderEmail}</h2><p className="text-xs text-gray-500">{c.configured ? `已配置 ${c.host}:${c.port}` : '未配置 IMAP'}</p></div><span className={`text-xs ${c.enabled ? 'text-green-600' : 'text-gray-500'}`}>{c.enabled ? '启用' : '停用'}</span></div>
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3"><input className="border rounded px-2 py-1" placeholder="IMAP host" value={c.host || ''} onChange={e => set('host', e.target.value)} /><input className="border rounded px-2 py-1" type="number" placeholder="993" value={c.port || ''} onChange={e => set('port', Number(e.target.value))} /><input className="border rounded px-2 py-1" placeholder="Username" value={c.username || ''} onChange={e => set('username', e.target.value)} /><input className="border rounded px-2 py-1" type="password" placeholder="Secret（留空不改）" value={c.secret || ''} onChange={e => set('secret', e.target.value)} /><input className="border rounded px-2 py-1" type="number" min="60" placeholder="Poll seconds" value={c.pollIntervalSeconds || 300} onChange={e => set('pollIntervalSeconds', Number(e.target.value))} /></div>
        <label className="text-sm"><input type="checkbox" checked={c.tls !== false} onChange={e => set('tls', e.target.checked)} className="mr-2" />TLS</label> <label className="text-sm ml-4"><input type="checkbox" checked={Boolean(c.enabled)} onChange={e => set('enabled', e.target.checked)} className="mr-2" />启用轮询</label>
        <div className="flex gap-2 items-center"><button className="rounded bg-blue-600 text-white px-3 py-1.5 text-sm" disabled={busy === account.id} onClick={() => save(account.id)}>保存</button><button className="rounded border px-3 py-1.5 text-sm" disabled={busy === account.id + 'test'} onClick={() => action(account.id, 'test')}>测试连接</button><button className="rounded border px-3 py-1.5 text-sm" disabled={busy === account.id + 'sync'} onClick={() => action(account.id, 'sync')}>立即同步</button><span className="text-xs text-gray-500">{c.lastSyncStatus || '尚未同步'} {c.lastSyncAt ? `· ${new Date(c.lastSyncAt).toLocaleString()}` : ''}</span></div>
      </div>; })}</section>
    <section className="rounded border bg-white p-5 shadow-sm"><h2 className="font-medium">待人工关联 ({reviews.length})</h2>{reviews.length === 0 ? <p className="text-sm text-gray-500 mt-3">暂无未匹配邮件。</p> : <div className="mt-3 space-y-3">{reviews.map((r) => <div key={r.id} className="border-t pt-3 text-sm"><div><span className="font-medium">{r.communicationMessage?.subject || '(no subject)'}</span> · {r.fromEmail} · {r.reason}</div><div className="mt-2 flex gap-2"><input id={`lead-${r.id}`} className="border rounded px-2 py-1" placeholder="输入客户 Lead ID" /><button className="rounded bg-slate-800 text-white px-3 py-1" onClick={() => resolve(r, (document.getElementById(`lead-${r.id}`) as HTMLInputElement)?.value)}>手动关联</button></div></div>)}</div>}</section>
  </main>;
}
