'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Bot, Headphones, Loader2, PhoneCall, RefreshCw, ShieldCheck } from 'lucide-react';
import api from '@/lib/api';
import { useRouter } from 'next/navigation';
import { RELEASE_FEATURES } from '@/config/release-features';

const STATUS: Record<string, string> = {
  queued: '待接入', connecting: '连接中', ai_active: 'AI 接待中', handoff_requested: '等待人工',
  human_connected: '人工接待中', completed: '已完成', failed: '失败', cancelled: '已取消',
};

export default function VoiceServicePage() {
  const router = useRouter();
  const [calls, setCalls] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await api.get('/voice-calls');
      setCalls(response.data || []);
    } catch (err: any) {
      setError(err?.response?.data?.message || '语音会话加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!RELEASE_FEATURES.aiVoiceCustomerService) {
      router.replace('/');
      return;
    }
    load();
  }, [load, router]);

  if (!RELEASE_FEATURES.aiVoiceCustomerService) return null;

  const createTest = async () => {
    setCreating(true);
    setError('');
    try {
      await api.post('/voice-calls/test-session', { channel: 'web_test', locale: 'zh-CN', recordingEnabled: false });
      await load();
    } catch (err: any) {
      setError(err?.response?.data?.message || '创建测试会话失败');
    } finally {
      setCreating(false);
    }
  };

  const handoff = async (id: string) => {
    try {
      await api.post(`/voice-calls/${id}/handoff`, {
        reason: '坐席在 CRM 中手动请求接管',
        context: { source: 'voice_service_dashboard', requestedAt: new Date().toISOString() },
      });
      await load();
    } catch (err: any) {
      setError(err?.response?.data?.message || '转人工请求失败');
    }
  };

  return <div className="space-y-6">
    <header className="flex items-start justify-between gap-4">
      <div>
        <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2"><PhoneCall className="w-5 h-5" />AI 语音客服</h1>
        <p className="text-sm text-gray-500 mt-1">企业语音 Agent 子项目已并入 CRM。当前开放安全的局域网测试会话，真实 WhatsApp/PSTN 呼叫需先完成渠道资质与公网 webhook 验收。</p>
      </div>
      <div className="flex gap-2">
        <button onClick={load} className="px-3 py-2 border rounded-md text-xs flex items-center gap-1"><RefreshCw className="w-3.5 h-3.5" />刷新</button>
        <button onClick={createTest} disabled={creating} className="px-3 py-2 bg-blue-600 text-white rounded-md text-xs flex items-center gap-1 disabled:opacity-50">
          {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Bot className="w-3.5 h-3.5" />}新建 LAN 测试会话
        </button>
      </div>
    </header>

    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      <Info icon={<ShieldCheck className="w-4 h-4" />} title="录音默认关闭" text="取得客户明确同意前，后端会拒绝开启录音。" />
      <Info icon={<Headphones className="w-4 h-4" />} title="一键转人工" text="原因与上下文写入 CRM 审计，避免客户重复描述。" />
      <Info icon={<AlertTriangle className="w-4 h-4" />} title="渠道受控" text="WhatsApp Calls 仍为 Beta 且受 Meta 地区、权限和用户许可限制。" />
    </div>

    {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded-md px-4 py-3 text-sm">{error}</div>}

    <section className="bg-white border rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b"><h2 className="text-sm font-semibold">语音会话队列</h2></div>
      {loading ? <div className="p-12 flex justify-center"><Loader2 className="w-5 h-5 animate-spin" /></div> : calls.length === 0 ?
        <div className="p-12 text-center text-sm text-gray-500">暂无会话。可先创建一个不会拨号、不会录音的 LAN 测试会话。</div> :
        <div className="divide-y">{calls.map((call) => <div key={call.id} className="px-4 py-3 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2"><span className="font-mono text-xs text-gray-500">{call.id.slice(0, 8)}</span><span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">{STATUS[call.status] || call.status}</span><span className="text-xs text-gray-500">{call.channel}</span></div>
            <p className="text-sm mt-1">{call.lead?.companyName || call.lead?.contactName || '未关联客户'} · {call.locale}</p>
            <p className="text-[11px] text-gray-400">{new Date(call.createdAt).toLocaleString('zh-CN')} · 录音 {call.recordingEnabled ? '已开启' : '关闭'}</p>
          </div>
          {!['completed', 'failed', 'cancelled', 'handoff_requested'].includes(call.status) && <button onClick={() => handoff(call.id)} className="px-3 py-1.5 border border-amber-300 text-amber-700 rounded-md text-xs hover:bg-amber-50">请求人工接管</button>}
        </div>)}</div>}
    </section>
  </div>;
}

function Info({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return <div className="bg-white border rounded-lg p-4"><div className="flex items-center gap-2 text-sm font-semibold text-gray-800">{icon}{title}</div><p className="text-xs text-gray-500 mt-2 leading-5">{text}</p></div>;
}
