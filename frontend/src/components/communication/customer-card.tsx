'use client';

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  MapPin, Mail, Phone, Building2, Sparkles, ArrowRight, Bot, Tag, Clock, Search, Loader2,
  Star, Globe, ChevronDown, FileText, Calculator, Calendar, Package, TrendingUp, AlertCircle,
  BarChart3, CheckCircle2, XCircle, ExternalLink, RefreshCw, Lightbulb, Target, Activity,
  Zap, Users, Briefcase, DollarSign, Link2, Info, History, StickyNote, Edit3, Check, X,
  ListChecks, MessageSquare, Gauge
} from 'lucide-react';
import api from '@/lib/api';
import type { ConversationDetail } from './types';
import { LanguageBadge } from '@/components/common/LanguageBadge';

const STAGE_LABELS: Record<string, string> = {
  new: '新客户', contacted: '已联系', sampling: '样品中', quoting: '报价中', negotiating: '谈判中', won: '已成交', lost: '暂停',
};

const STAGE_ORDER = ['new', 'contacted', 'sampling', 'quoting', 'negotiating', 'won'];

interface Props {
  conversation: ConversationDetail;
  onOpenQuoteForm?: (type: 'quote' | 'pi' | 'sample') => void;
  electronApi?: any;
  currentChat?: { accountId?: string; name?: string; phone?: string; selectionProof?: string } | null;
}

export function CustomerCard({ conversation, onOpenQuoteForm, electronApi, currentChat }: Props) {
  const lead = conversation.lead;
  const [analysis, setAnalysis] = useState<any>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [followupDraft, setFollowupDraft] = useState<string | null>(null);
  const [followupLoading, setFollowupLoading] = useState(false);
  const [timeline, setTimeline] = useState<any[]>([]);

  // 备注编辑状态
  const [noteText, setNoteText] = useState('');
  const [noteEditing, setNoteEditing] = useState(false);
  const [noteSaving, setNoteSaving] = useState(false);

  // 名字编辑状态
  const [companyNameEditing, setCompanyNameEditing] = useState(false);
  const [companyNameText, setCompanyNameText] = useState('');
  const [contactNameEditing, setContactNameEditing] = useState(false);
  const [contactNameText, setContactNameText] = useState('');
  const [nameSaving, setNameSaving] = useState(false);

  useEffect(() => {
    if (!lead?.id) return;
    api.get(`/leads/${lead.id}/timeline`, { params: { limit: 8 } })
      .then(r => setTimeline(r.data?.data || []))
      .catch(() => setTimeline([]));
  }, [lead?.id]);

  useEffect(() => {
    if (!lead?.id) return;
    let cancelled = false;
    setAnalysisLoading(true);
    api.post(`/ai-communications/customer-analysis/${lead.id}`)
      .then(r => { if (!cancelled) setAnalysis(r.data?.analysis || r.data); })
      .catch(() => { if (!cancelled) setAnalysis(null); })
      .finally(() => { if (!cancelled) setAnalysisLoading(false); });
    return () => { cancelled = true; };
  }, [lead?.id]);

  // 同步 lead.notes 到编辑框
  useEffect(() => {
    setNoteText((lead as any)?.notes || '');
    setNoteEditing(false);
  }, [lead?.id, (lead as any)?.notes]);

  // 同步 lead 名字到编辑框
  useEffect(() => {
    setCompanyNameText(lead?.companyName || '');
    setCompanyNameEditing(false);
  }, [lead?.id, lead?.companyName]);

  useEffect(() => {
    setContactNameText(lead?.contactName || '');
    setContactNameEditing(false);
  }, [lead?.id, lead?.contactName]);

  const saveCompanyName = async () => {
    if (!lead?.id) return;
    setNameSaving(true);
    try {
      await api.patch(`/leads/${lead.id}`, { companyName: companyNameText });
      setCompanyNameEditing(false);
    } catch (error) { console.error('[Frontend] operation failed:', error); } finally { setNameSaving(false); }
  };

  const saveContactName = async () => {
    if (!lead?.id) return;
    setNameSaving(true);
    try {
      await api.patch(`/leads/${lead.id}`, { contactName: contactNameText });
      setContactNameEditing(false);
    } catch (error) { console.error('[Frontend] operation failed:', error); } finally { setNameSaving(false); }
  };

  const saveNote = async () => {
    if (!lead?.id) return;
    setNoteSaving(true);
    try {
      await api.patch(`/leads/${lead.id}`, { notes: noteText });
      setNoteEditing(false);
    } catch (error) { console.error('[Frontend] operation failed:', error); }
    finally { setNoteSaving(false); }
  };

  const runAnalysis = async () => {
    if (!lead?.id) return; setAnalysisLoading(true);
    try { const r = await api.post(`/ai-communications/customer-analysis/${lead.id}`); setAnalysis(r.data?.analysis || r.data); }
    catch { setAnalysis({ summary: '分析服务暂不可用', isDemo: true }); }
    finally { setAnalysisLoading(false); }
  };


  const generateFollowup = async () => {
    if (!conversation.id) return; setFollowupLoading(true);
    try {
      const r = await api.post(`/ai-communications/generate-follow-up`, { conversationId: conversation.id });
      setFollowupDraft(r.data?.content || r.data?.draft || '跟进记录生成中...');
    } catch { setFollowupDraft('跟进记录生成失败，请稍后重试'); }
    finally { setFollowupLoading(false); }
  };

  const changeStage = async (s: string) => {
    if (!lead?.id) return;
    try { await api.patch(`/leads/${lead.id}/status`, { status: s }); }
    catch (error) { console.error('[Frontend] operation failed:', error); }
  };

  // Calculate overdue days
  const overdueDays = (lead as any)?.nextFollowUpAt
    ? Math.ceil((Date.now() - new Date((lead as any).nextFollowUpAt).getTime()) / 86400000)
    : null;

  if (!lead) {
    return (
      <aside className="w-full border-l bg-white p-6 overflow-y-auto overflow-x-hidden">
        <div className="text-center py-12">
          <Building2 className="w-8 h-8 mx-auto text-gray-300 mb-2" />
          <p className="text-sm text-gray-500">未关联客户</p>
          <p className="text-xs text-gray-400 mt-1">当前会话未绑定客户资料</p>
          <a href="/customers/new" className="inline-block mt-3 text-xs text-blue-600 hover:underline">+ 创建/关联客户</a>
        </div>
      </aside>
    );
  }

  return (
    <aside className="w-full border-l bg-white overflow-y-auto overflow-x-hidden">
      {/* 1. 联系人卡 */}
      <div className="p-3 border-b bg-gray-50/50">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[15px] font-bold text-gray-900">{lead.contactName || lead.companyName || 'Chris'}</span>
          {lead.leadGrade && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${lead.leadGrade === 'A' ? 'bg-red-100 text-red-700' : lead.leadGrade === 'B' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500'}`}>
              {lead.leadGrade} 级
            </span>
          )}
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-50 text-green-700 font-medium">{lead.status === 'new' ? '新客户' : '已联系'}</span>
        </div>
        {lead.contactPhone && <div className="text-[12px] text-gray-600 mt-0.5">{lead.contactPhone}</div>}
        {lead.companyName && <div className="text-[11px] text-gray-500">{lead.companyName}</div>}
        {lead.id && (
          <a href={`/customers/${lead.id}`} className="text-[11px] text-blue-600 hover:underline mt-0.5 inline-block">查看完整客户详情 →</a>
        )}
        <div className="flex gap-1 mt-2">
          {STAGE_ORDER.map(stage => (
            <span key={stage} onClick={() => changeStage(stage)}
              className={`flex-1 text-center text-[9px] py-1 rounded cursor-pointer ${(lead.status || 'new') === stage ? 'bg-amber-100 text-amber-700 border border-amber-300 font-semibold' : 'bg-gray-100 text-gray-400 hover:bg-gray-200'}`}>
              {STAGE_LABELS[stage]}
            </span>
          ))}
        </div>
      </div>

      {/* 2. 客户备注 */}
      <div className="p-3 border-b bg-yellow-50/30">
        <div className="flex items-center justify-between mb-1.5">
          <h3 className="text-[12px] font-semibold text-gray-700">📝 客户备注</h3>
          {!noteEditing ? (
            <button onClick={() => setNoteEditing(true)} className="text-[10px] text-gray-400 hover:text-blue-600">编辑</button>
          ) : (
            <div className="flex items-center gap-1">
              <button onClick={saveNote} disabled={noteSaving} className="text-[10px] text-green-600 hover:text-green-700">{noteSaving ? '保存中…' : '保存'}</button>
              <button onClick={() => { setNoteEditing(false); setNoteText((lead as any)?.notes || ''); }} className="text-[10px] text-gray-400">取消</button>
            </div>
          )}
        </div>
        {noteEditing ? (
          <textarea value={noteText} onChange={(e) => setNoteText(e.target.value)} rows={3} autoFocus
            className="w-full text-[11px] rounded border border-amber-200 px-2 py-1.5 outline-none focus:border-amber-400 bg-white" />
        ) : (
          <p className="text-[11px] text-gray-600 whitespace-pre-wrap min-h-[20px]">{noteText || <span className="text-gray-400 italic">暂无备注，点击编辑添加</span>}</p>
        )}
      </div>

      {/* 3. 分析头部（评分环） */}
      <div className="p-3 border-b flex items-center gap-3">
        <div className="relative w-[52px] h-[52px] shrink-0 rounded-full flex items-center justify-center"
          style={{ background: `conic-gradient(#ff6a00 ${Math.max(0, Math.min(100, Number(analysis?.probability || 0))) * 3.6}deg, #edf1f5 0)` }}>
          <div className="absolute inset-[5px] rounded-full bg-white"></div>
          <div className="relative text-center">
            <div className="text-[13px] font-extrabold text-orange-600 leading-none">{analysis?.probability ?? '—'}%</div>
            <div className="text-[8px] text-gray-400">成交概率</div>
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-bold text-gray-900">{lead.contactName || '客户'}</div>
          <div className="text-[11px] text-gray-600">{analysis?.intent ? `客户意图：${analysis.intent}` : '客户意图：待分析'}</div>
          <div className="flex gap-1 mt-1">
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 font-bold">{analysis?.matchScore === '高' ? '高优先级' : '中优先级'}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-50 text-green-700 font-bold">低风险</span>
          </div>
        </div>
      </div>

      {/* 4. 当前卡点 */}
      {analysis?.recommendation && (
        <div className="p-3 border-b bg-orange-50/30">
          <div className="text-[11.5px] text-amber-800"><strong className="text-orange-600">当前卡点：</strong>{analysis.recommendation}</div>
        </div>
      )}

      {/* 5. AI 标签（自动） */}
      {Array.isArray(analysis?.tags) && analysis.tags.length > 0 && (
        <div className="p-3 border-b">
          <div className="flex flex-wrap gap-1">
            {analysis.tags.slice(0, 8).map((t: string, i: number) => (
              <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-orange-50 text-orange-700">{t}</span>
            ))}
          </div>
        </div>
      )}

      {/* 6. AI 跟进分析 */}
      <div className="p-3 border-b">
        <h3 className="text-[12px] font-semibold text-gray-700 mb-2">⚡ AI 跟进分析</h3>
        <div className="flex gap-1 mb-2">
          {STAGE_ORDER.map(stage => (
            <span key={stage} className={`flex-1 text-center text-[8px] py-1 rounded ${(lead.status || 'new') === stage ? 'bg-amber-100 text-amber-800 border border-amber-300' : 'bg-gray-50 text-gray-400 border border-gray-100'}`}>{STAGE_LABELS[stage]}</span>
          ))}
        </div>
        <div className="space-y-1 text-[10px]">
          <div className="flex justify-between"><span className="text-gray-500">优先级</span><span className={lead.leadGrade === 'A' ? 'text-red-600' : 'text-gray-600'}>{lead.leadGrade === 'A' ? '高' : lead.leadGrade === 'B' ? '中' : '普通'}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">待跟进事项</span><span className={overdueDays && overdueDays > 0 ? 'text-red-600' : 'text-gray-600'}>{overdueDays && overdueDays > 0 ? `已逾期 ${overdueDays} 天` : '暂无'}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">会话消息</span><span className="text-gray-600">{conversation.messages?.length || 0} 条</span></div>
          <div className="flex justify-between"><span className="text-gray-500">最近联系</span><span className="text-gray-600">{lead.lastContactedAt ? new Date(lead.lastContactedAt).toLocaleDateString('zh-CN') : '—'}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">下一次跟进</span><span className={overdueDays && overdueDays > 0 ? 'text-red-600' : 'text-gray-600'}>{lead.nextFollowUpAt ? new Date(lead.nextFollowUpAt).toLocaleDateString('zh-CN') : '未安排'}</span></div>
        </div>
        <button onClick={generateFollowup} disabled={followupLoading} className="w-full mt-2 py-1.5 text-[10px] rounded border border-amber-200 bg-white text-amber-700 hover:bg-amber-50 disabled:opacity-40">
          {followupLoading ? '生成中…' : '生成跟进记录'}
        </button>
        {followupDraft && (
          <div className="mt-2 p-2 bg-white border border-amber-200 rounded text-[10px] text-gray-700">
            <p className="text-[9px] text-amber-600 font-medium mb-1">AI 跟进草稿（待确认后写入）</p>
            <p className="line-clamp-4">{followupDraft}</p>
          </div>
        )}
      </div>

      {/* 7. 下一步行动（stepper） */}
      {Array.isArray(analysis?.nextSteps) && analysis.nextSteps.length > 0 && (
        <div className="p-3 border-b">
          <h3 className="text-[13px] font-semibold text-gray-800 mb-2">下一步行动</h3>
          <div className="grid grid-cols-3 gap-1">
            {analysis.nextSteps.slice(0, 3).map((s: any, i: number) => {
              const title = typeof s === 'string' ? s : s?.title || '';
              const desc = typeof s === 'string' ? '' : s?.description || '';
              return (
                <div key={i} className="flex flex-col items-center gap-1 text-center">
                  <span className={`w-5 h-5 rounded-full text-[9px] font-bold flex items-center justify-center ${i === 0 ? 'bg-sky-500 text-white shadow ring-4 ring-sky-100' : 'bg-gray-100 text-gray-400'}`}>{i + 1}</span>
                  <span className="text-[9px] text-gray-700 leading-snug font-medium">{title}</span>
                  {desc && <span className="text-[8px] text-gray-400 leading-snug">{desc}</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 8. AI 推荐回复（4 tab） */}
      {analysis?.replyVariants && (
        <div className="p-3 border-b">
          <h3 className="text-[13px] font-semibold text-gray-800 mb-1">💬 AI 推荐回复</h3>
          <ReplyVariants
            variants={analysis.replyVariants}
            onInject={(text) => {
              navigator.clipboard.writeText(text).catch(() => {});
              const wa = electronApi?.whatsapp;
              if (wa?.fillDraft && currentChat?.phone) {
                wa.fillDraft({
                  text,
                  targetPhone: currentChat.phone,
                  targetName: currentChat.name || '客户',
                  targetAccountId: currentChat.accountId,
                  selectionProof: currentChat.selectionProof || '',
                }).catch(() => {});
              }
            }}
          />
        </div>
      )}

      {/* 9. AI 客户背调 */}
      {!analysis && (
        <div className="p-3 border-b">
          <button onClick={runAnalysis} disabled={analysisLoading} className="w-full py-1.5 text-[10px] rounded border border-purple-200 bg-purple-50 text-purple-700 hover:bg-purple-100 disabled:opacity-40">
            {analysisLoading ? '分析中…' : 'AI 客户背调'}
          </button>
        </div>
      )}
      {analysis && (analysis.summary || analysis.matchScore || analysis.mainProducts) && (
        <div className="p-3 border-b">
          <h3 className="text-[12px] font-semibold text-gray-700 mb-2">🔍 AI 客户背调</h3>
          {analysis.summary && <div className="mt-1 p-2 bg-purple-50/50 border border-purple-100 rounded"><p className="text-[11px] text-gray-700 leading-relaxed">{analysis.summary}</p></div>}
          {analysis.matchScore && <div className="flex justify-between text-[11px] mt-1"><span className="text-gray-500">业务匹配度</span><span className="font-bold text-purple-700">{analysis.matchScore}</span></div>}
          {analysis.mainProducts && <div className="flex flex-wrap gap-1 mt-1">{String(analysis.mainProducts).split(/[,;，；]/).map((p: string, i: number) => <span key={i} className="text-[9px] px-1.5 py-0.5 rounded-full bg-purple-50 text-purple-700 border border-purple-100">{p.trim()}</span>)}</div>}
          <button onClick={runAnalysis} disabled={analysisLoading} className="text-[9px] text-blue-500 hover:underline mt-1">{analysisLoading ? '分析中…' : '刷新分析'}</button>
        </div>
      )}

      {/* 10. 回复质检 */}
      {analysis?.replyQuality && (
        <div className="p-3 border-b">
          <details className="rounded-xl border border-gray-200 bg-white p-2.5" open>
            <summary className="flex items-center justify-between cursor-pointer list-none">
              <h3 className="text-[13px] font-semibold text-gray-800">业务员回复质检</h3>
              <span className="flex items-center gap-2"><span className="text-[10px] px-1.5 py-0.5 rounded-full bg-orange-50 text-orange-600">{typeof analysis.replyQuality.score === 'number' && analysis.replyQuality.score >= 80 ? '良好' : '待优化'}</span><span className="font-bold text-teal-700">{analysis.replyQuality.score ?? '—'}/100</span></span>
            </summary>
            <QualityDetail quality={analysis.replyQuality} />
          </details>
        </div>
      )}

      {/* 11. 最近活动 */}
      <div className="p-3 border-t">
        <h3 className="text-xs font-semibold mb-2 flex items-center gap-1.5"><History className="w-3 h-3 text-gray-400" />最近活动</h3>
        {timeline.length > 0 ? (
          <div className="space-y-1.5">
            {timeline.slice(0, 8).map((a: any) => (
              <div key={a.id} className="flex gap-2 text-[10px]">
                <div className={`w-1.5 h-1.5 rounded-full mt-1 shrink-0 ${a.activityType?.includes('email') ? 'bg-blue-400' : a.activityType?.includes('ai') ? 'bg-purple-400' : a.activityType?.includes('quote') ? 'bg-amber-400' : 'bg-gray-300'}`} />
                <div className="flex-1 min-w-0"><p className="text-gray-700 truncate">{a.title}</p><p className="text-[9px] text-gray-400">{new Date(a.occurredAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })}</p></div>
              </div>
            ))}
          </div>
        ) : (<p className="text-[10px] text-gray-400 text-center py-2">暂无活动记录</p>)}
      </div>
    </aside>
  );
}

function ReplyVariants({ variants, onInject }: { variants: any; onInject: (text: string) => void }) {
  const [tab, setTab] = useState<'standard' | 'brief' | 'detailed'>('standard');
  const labels = { standard: '标准', brief: '简短', detailed: '详细' } as const;
  const reply = variants[tab] || variants.standard || '';
  const translation = variants.chinese || '';
  return (
    <div>
      <div className="grid grid-cols-3 border-b border-gray-100">
        {(Object.keys(labels) as Array<keyof typeof labels>).map(k => (
          <button key={k} onClick={() => setTab(k)} className={`text-[11px] py-2 border-b-2 ${tab === k ? 'border-sky-500 text-sky-600 font-bold' : 'border-transparent text-gray-400'}`}>{labels[k]}</button>
        ))}
      </div>
      <div className="text-[13px] text-gray-700 leading-relaxed mt-2 p-2.5 border border-gray-100 rounded bg-gray-50/50 min-h-[60px]">{reply}</div>
      {translation && (
        <div className="mt-1.5 pt-1.5 border-t border-gray-100">
          <strong className="text-[11px] text-sky-700 block mb-0.5">中文对照</strong>
          <div className="text-[12px] text-sky-800/80 leading-relaxed">{translation}</div>
        </div>
      )}
      <div className="flex gap-1 mt-2">
        <button className="text-[10px] px-2 py-1 rounded border border-gray-200 bg-white text-gray-600 hover:bg-gray-50" onClick={() => navigator.clipboard.writeText(reply).catch(() => {})}>复制</button>
        <button className="text-[10px] px-2 py-1 rounded border border-sky-500 bg-gradient-to-r from-sky-400 to-blue-600 text-white font-bold" onClick={() => onInject(reply)}>一键填入发送</button>
      </div>
    </div>
  );
}

function QualityDetail({ quality }: { quality: any }) {
  const dims = quality.dimensions || {};
  const dimLabels = {
    responseSpeed: '响应速度', needRecognition: '需求识别', professionalism: '专业度',
    conversionAction: '转化动作', riskControl: '风险控制',
  } as const;
  const dimKeys = ['responseSpeed', 'needRecognition', 'professionalism', 'conversionAction', 'riskControl'] as const;
  const hasDims = dimKeys.some(k => typeof dims[k] === 'number');
  const currentAction = quality.currentAction || quality.nextAction;
  const strengths = Array.isArray(quality.strengths) ? quality.strengths.slice(0, 3) : [];
  const improvements = Array.isArray(quality.improvements) ? quality.improvements.slice(0, 3) : [];

  return (
    <div className="mt-2 space-y-2">
      {(currentAction || quality.summary) && (
        <div className="p-1.5 border border-gray-100 rounded bg-gray-50 text-[11px]">
          {currentAction && <p><span>当前待处理：</span><strong className="text-gray-800">{currentAction}</strong></p>}
          {quality.summary && <p className="text-gray-500 mt-0.5">{quality.summary}</p>}
        </div>
      )}
      {hasDims && (
        <div className="space-y-1">
          {dimKeys.map(k => (
            typeof dims[k] === 'number' ? (
              <div key={k} className="flex items-center gap-2 text-[10.5px]">
                <span className="w-16 shrink-0 text-gray-500">{dimLabels[k]}</span>
                <div className="flex-1 h-1.5 rounded bg-gray-100 overflow-hidden">
                  <div className="h-full rounded bg-gradient-to-r from-sky-400 to-teal-500" style={{ width: `${Math.max(0, Math.min(100, Number(dims[k]) || 0))}%` }}></div>
                </div>
                <span className="w-6 text-right font-bold text-gray-700">{dims[k]}</span>
              </div>
            ) : null
          ))}
        </div>
      )}
      {strengths.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold text-green-700 mb-0.5">做得好的</p>
          <ul className="text-[10.5px] text-gray-600 space-y-0.5 pl-3 list-disc">{strengths.map((s: string, i: number) => <li key={i}>{s}</li>)}</ul>
        </div>
      )}
      {improvements.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold text-amber-700 mb-0.5">需改进</p>
          <ul className="text-[10.5px] text-gray-600 space-y-0.5 pl-3 list-disc">{improvements.map((s: string, i: number) => <li key={i}>{s}</li>)}</ul>
        </div>
      )}
      {quality.recommendation && (
        <div className="p-1.5 border border-teal-100 rounded bg-teal-50/40 text-[10.5px] text-gray-700"><strong className="text-teal-700">改进建议：</strong>{quality.recommendation}</div>
      )}
    </div>
  );
}
