'use client';

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  MapPin, Mail, Phone, Building2, Sparkles, ArrowRight, Bot, Tag, Clock, Search, Loader2,
  Star, Globe, ChevronDown, FileText, Calculator, Calendar, Package, TrendingUp, AlertCircle,
  BarChart3, CheckCircle2, XCircle, ExternalLink, RefreshCw, Lightbulb, Target, Activity,
  Zap, Users, Briefcase, DollarSign, Link2, Info, History, StickyNote, Edit3, Check, X
} from 'lucide-react';
import api from '@/lib/api';
import type { ConversationDetail } from './types';
import { LanguageBadge } from '@/components/common/LanguageBadge';

const STAGE_LABELS: Record<string, string> = {
  new: '新客户', contacted: '已联系', sampling: '样品中', quoting: '报价中', negotiating: '谈判中', won: '已成交', lost: '暂停',
};

const STAGE_ORDER = ['new', 'contacted', 'sampling', 'quoting', 'negotiating', 'won'];

interface Props { conversation: ConversationDetail; onOpenQuoteForm?: (type: 'quote' | 'pi' | 'sample') => void; }

export function CustomerCard({ conversation, onOpenQuoteForm }: Props) {
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
      {/* ======== 1. Customer Profile ======== */}
      <div className="p-3 border-b">
        <div className="flex items-center gap-1.5 mb-2">
          <Building2 className="w-3.5 h-3.5 text-gray-400" />
          <h3 className="text-xs font-semibold text-gray-700">客户资料</h3>
        </div>
        {/* 公司名称 — 可编辑 */}
        <div className="flex items-center gap-1 group">
          {companyNameEditing ? (
            <div className="flex items-center gap-1 flex-1">
              <input
                value={companyNameText}
                onChange={(e) => setCompanyNameText(e.target.value)}
                className="text-sm font-bold text-gray-900 border-b border-blue-400 outline-none flex-1 bg-transparent"
                autoFocus
                placeholder="公司名称"
              />
              <button onClick={saveCompanyName} disabled={nameSaving} className="text-green-600 hover:text-green-700">
                {nameSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
              </button>
              <button onClick={() => { setCompanyNameEditing(false); setCompanyNameText(lead?.companyName || ''); }} className="text-gray-400 hover:text-red-500">
                <X className="w-3 h-3" />
              </button>
            </div>
          ) : (
            <>
              <p className="text-sm font-bold text-gray-900 flex-1">{lead.companyName || '（未填写）'}</p>
              {lead?.id && (
                <button onClick={() => setCompanyNameEditing(true)} className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-blue-600 transition-opacity">
                  <Edit3 className="w-3 h-3" />
                </button>
              )}
            </>
          )}
        </div>
        {/* 联系人名称 — 可编辑 */}
        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap group">
          {contactNameEditing ? (
            <div className="flex items-center gap-1">
              <input
                value={contactNameText}
                onChange={(e) => setContactNameText(e.target.value)}
                className="text-[11px] text-gray-500 border-b border-blue-400 outline-none bg-transparent"
                autoFocus
                placeholder="联系人名"
              />
              <button onClick={saveContactName} disabled={nameSaving} className="text-green-600 hover:text-green-700">
                {nameSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
              </button>
              <button onClick={() => { setContactNameEditing(false); setContactNameText(lead?.contactName || ''); }} className="text-gray-400 hover:text-red-500">
                <X className="w-3 h-3" />
              </button>
            </div>
          ) : (
            <>
              <span className="text-[11px] text-gray-500">{lead.contactName || ''}</span>
              {lead?.id && (
                <button onClick={() => setContactNameEditing(true)} className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-blue-600 transition-opacity">
                  <Edit3 className="w-2.5 h-2.5" />
                </button>
              )}
              {lead.leadGrade && (
                <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold ${lead.leadGrade === 'A' ? 'bg-green-100 text-green-700' : lead.leadGrade === 'B' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-500'}`}>
                  {lead.leadGrade}级
                </span>
              )}
              {lead.language && (
                <LanguageBadge language={lead.language} size="sm" />
              )}
            </>
          )}
        </div>
        <div className="mt-1.5 space-y-0.5 text-[10px]">
          {lead.country && <div className="flex items-center gap-1 text-gray-500"><MapPin className="w-3 h-3" />{lead.country}</div>}
          <div className="flex items-center gap-1 text-gray-500"><Mail className="w-3 h-3" />{conversation.contactPoint?.normalizedValue || lead.contactEmail || '—'}</div>
          {lead.contactPhone && <div className="flex items-center gap-1 text-gray-500"><Phone className="w-3 h-3" />{lead.contactPhone}</div>}
          {lead.website && <div className="flex items-center gap-1 text-blue-500"><Globe className="w-3 h-3" /><a href={lead.website} target="_blank" className="truncate">{lead.website}</a></div>}
        </div>
        <div className="mt-2">
          <select value={lead.status || 'new'} onChange={e => changeStage(e.target.value)} className="text-[10px] border rounded px-1.5 py-1 w-full bg-white">
            {Object.entries(STAGE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div className="flex flex-wrap gap-1 mt-1.5">
          {(lead.tags || []).slice(0, 4).map((t: any) => (
            <span key={t.id || t.tagId} className="text-[9px] px-1.5 py-0.5 rounded-full border bg-gray-50 text-gray-500 flex items-center gap-0.5">
              <Tag className="w-2 h-2" />{t.tag?.displayName || t.tag?.name || '标签'}
            </span>
          ))}
        </div>
        {lead.id ? (
          <Link href={`/customers/${lead.id}`} className="text-[10px] text-blue-600 hover:underline mt-1.5 inline-block">
            查看完整客户详情 →
          </Link>
        ) : (
          <span className="text-[10px] text-gray-400 mt-1.5 inline-block">客户资料不完整</span>
        )}
      </div>

      {/* ======== 1.5 客户备注 ======== */}
      <div className="p-3 border-b bg-yellow-50/20">
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-1.5">
            <StickyNote className="w-3.5 h-3.5 text-amber-500" />
            <h3 className="text-xs font-semibold text-gray-700">客户备注</h3>
          </div>
          {!noteEditing ? (
            <button onClick={() => setNoteEditing(true)} className="text-[10px] text-gray-400 hover:text-blue-600 flex items-center gap-0.5">
              <Edit3 className="w-2.5 h-2.5" />编辑
            </button>
          ) : (
            <div className="flex items-center gap-1">
              <button onClick={saveNote} disabled={noteSaving} className="text-[10px] text-green-600 hover:text-green-700 flex items-center gap-0.5 disabled:opacity-40">
                {noteSaving ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Check className="w-2.5 h-2.5" />}保存
              </button>
              <button onClick={() => { setNoteEditing(false); setNoteText((lead as any)?.notes || ''); }} className="text-[10px] text-gray-400 hover:text-red-500 flex items-center gap-0.5">
                <X className="w-2.5 h-2.5" />取消
              </button>
            </div>
          )}
        </div>
        {noteEditing ? (
          <textarea
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            placeholder="输入客户备注信息...（如：客户偏好、特殊需求、沟通要点等）"
            rows={3}
            autoFocus
            className="w-full text-[11px] rounded border border-amber-200 px-2 py-1.5 outline-none focus:border-amber-400 resize-none bg-white"
          />
        ) : (
          <p className="text-[11px] text-gray-600 whitespace-pre-wrap min-h-[20px]">
            {noteText || <span className="text-gray-400 italic">暂无备注，点击编辑添加</span>}
          </p>
        )}
      </div>

      {/* ======== 2. AI Follow-up Analysis (DEEPENED) ======== */}
      <div className="p-3 border-b bg-amber-50/30">
        <h3 className="text-xs font-semibold mb-2 flex items-center gap-1.5">
          <Activity className="w-3 h-3 text-amber-500" />AI 跟进分析
        </h3>

        {/* Follow-up Status Cards */}
        <div className="flex gap-1 mb-2">
          {STAGE_ORDER.map(stage => (
            <div
              key={stage}
              className={`flex-1 text-center py-1 rounded text-[8px] font-medium transition-colors ${
                (lead.status || 'new') === stage
                  ? 'bg-amber-100 text-amber-800 border border-amber-300'
                  : 'bg-gray-50 text-gray-400 border border-gray-100'
              }`}
            >
              {STAGE_LABELS[stage]}
            </div>
          ))}
        </div>

        {/* Priority + Overdue */}
        <div className="space-y-1.5 text-[10px]">
          <div className="flex justify-between">
            <span className="text-gray-500">优先级</span>
            <span className={`font-medium flex items-center gap-1 ${lead.leadGrade === 'A' ? 'text-red-600' : lead.leadGrade === 'B' ? 'text-amber-600' : 'text-gray-500'}`}>
              {lead.leadGrade === 'A' ? <AlertCircle className="w-2.5 h-2.5" /> : <Info className="w-2.5 h-2.5" />}
              {lead.leadGrade === 'A' ? '高优先级' : lead.leadGrade === 'B' ? '中优先级' : '普通'}
            </span>
          </div>

          <div className="flex justify-between">
            <span className="text-gray-500">待跟进事项</span>
            <span className={overdueDays && overdueDays > 0 ? 'text-red-600 font-medium' : 'text-gray-600'}>
              {overdueDays && overdueDays > 0 ? `已逾期 ${overdueDays} 天` : overdueDays === 0 ? '今日跟进' : '暂无'}
            </span>
          </div>

          <div className="flex justify-between">
            <span className="text-gray-500">会话消息</span>
            <span className="text-gray-600">{conversation.messages?.length || 0} 条</span>
          </div>

          <div className="flex justify-between">
            <span className="text-gray-500">最近联系</span>
            <span className="text-gray-600">
              {lead.lastContactedAt
                ? new Date(lead.lastContactedAt).toLocaleDateString('zh-CN')
                : '—'}
            </span>
          </div>

          <div className="flex justify-between">
            <span className="text-gray-500">下一次跟进</span>
            <span className={overdueDays && overdueDays > 0 ? 'text-red-600' : 'text-gray-600'}>
              {lead.nextFollowUpAt
                ? new Date(lead.nextFollowUpAt).toLocaleDateString('zh-CN')
                : '未安排'}
            </span>
          </div>
        </div>

        {/* Generate Follow-up Button */}
        <button
          onClick={generateFollowup}
          disabled={followupLoading}
          className="w-full mt-2 py-1.5 text-[10px] rounded border border-amber-200 bg-white text-amber-700 hover:bg-amber-50 disabled:opacity-40 flex items-center justify-center gap-1 transition-colors"
        >
          {followupLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <FileText className="w-3 h-3" />}
          {followupLoading ? '生成中...' : '生成跟进记录'}
        </button>

        {followupDraft && (
          <div className="mt-2 p-2 bg-white border border-amber-200 rounded text-[10px] text-gray-700">
            <p className="text-[9px] text-amber-600 font-medium mb-1 flex items-center gap-1">
              <Info className="w-2.5 h-2.5" />AI 跟进草稿（待确认后写入）：
            </p>
            <p className="line-clamp-4">{followupDraft}</p>
            <div className="flex gap-1 mt-1.5">
              <button className="text-[9px] px-2 py-0.5 bg-green-50 text-green-700 rounded border border-green-200 hover:bg-green-100">确认写入</button>
              <button onClick={() => setFollowupDraft(null)} className="text-[9px] px-2 py-0.5 bg-gray-50 text-gray-500 rounded border hover:bg-gray-100">放弃</button>
            </div>
          </div>
        )}
      </div>

      {/* ======== 3. AI Customer Research (DEEPENED) ======== */}
      <div className="p-3 border-b">
        <h3 className="text-xs font-semibold mb-2 flex items-center gap-1.5">
          <Search className="w-3 h-3 text-purple-500" />AI 客户背调
        </h3>

        {analysis ? (
          <div className="space-y-1.5 text-[10px]">
            {analysis.isDemo && (
              <div className="flex items-center gap-1 text-[9px] text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded mb-1.5">
                <Info className="w-2.5 h-2.5" />预览数据（AI 服务未连接）
              </div>
            )}

            {/* Business Match Rate */}
            {analysis.matchScore && (
              <div className="flex justify-between items-center">
                <span className="text-gray-500">业务匹配度</span>
                <span className="font-bold text-purple-700">{analysis.matchScore}</span>
              </div>
            )}

            {/* Enterprise Judgment */}
            {analysis.enterpriseType && (
              <div className="flex justify-between">
                <span className="text-gray-500">该企业为</span>
                <span className="font-medium text-gray-700">{analysis.enterpriseType}</span>
              </div>
            )}

            {/* Summary */}
            {analysis.summary && (
              <div className="mt-1.5 p-2 bg-purple-50/50 border border-purple-100 rounded">
                <p className="text-[9px] text-purple-600 font-medium mb-0.5 flex items-center gap-1">
                  <Lightbulb className="w-2.5 h-2.5" />背调概要
                </p>
                <p className="text-gray-700 leading-relaxed">{analysis.summary}</p>
              </div>
            )}

            {/* Contact Info */}
            {analysis.contactName && (
              <div className="flex justify-between">
                <span className="text-gray-500">联系人</span>
                <span className="text-gray-700">{analysis.contactName}{analysis.contactTitle ? ` · ${analysis.contactTitle}` : ''}</span>
              </div>
            )}

            {/* Company + Website */}
            {analysis.companyName && (
              <div className="flex justify-between">
                <span className="text-gray-500">公司</span>
                <span className="text-gray-700 truncate max-w-[180px]">{analysis.companyName}</span>
              </div>
            )}

            {analysis.website && (
              <div className="flex justify-between">
                <span className="text-gray-500">官网</span>
                <a href={analysis.website} target="_blank" className="text-blue-600 hover:underline truncate max-w-[180px] flex items-center gap-0.5">
                  <Link2 className="w-2.5 h-2.5 shrink-0" />{analysis.website}
                </a>
              </div>
            )}

            {/* Main Products */}
            {analysis.mainProducts && (
              <div>
                <span className="text-gray-500 block mb-0.5">主营产品</span>
                <div className="flex flex-wrap gap-1">
                  {analysis.mainProducts.split(/[,;，；]/).map((p: string, i: number) => (
                    <span key={i} className="text-[9px] px-1.5 py-0.5 rounded-full bg-purple-50 text-purple-700 border border-purple-100">
                      {p.trim()}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Social Media */}
            {analysis.socialMedia && (
              <div className="flex justify-between">
                <span className="text-gray-500">社媒主页</span>
                <span className="text-blue-600 flex items-center gap-0.5">
                  <Link2 className="w-2.5 h-2.5" />{analysis.socialMedia}
                </span>
              </div>
            )}

            {/* Annual Revenue */}
            {analysis.annualRevenue && (
              <div className="flex justify-between">
                <span className="text-gray-500">年销售额</span>
                <span className="text-gray-700 flex items-center gap-0.5">
                  <DollarSign className="w-2.5 h-2.5" />{analysis.annualRevenue}
                </span>
              </div>
            )}

            {/* Transaction Overview */}
            {analysis.transactionOverview && (
              <div className="flex justify-between">
                <span className="text-gray-500">交易概况</span>
                <span className="text-gray-700">{analysis.transactionOverview}</span>
              </div>
            )}

            {/* Confidence */}
            {analysis.confidence && (
              <p className="text-[9px] text-gray-400 mt-0.5">可信度: {analysis.confidence}{analysis.isDemo ? ' (预览)' : ''}</p>
            )}

            <button onClick={runAnalysis} className="text-[9px] text-blue-500 hover:underline">刷新分析</button>
          </div>
        ) : (
          <button onClick={runAnalysis} disabled={analysisLoading} className="w-full py-1.5 text-[10px] rounded border border-purple-200 bg-purple-50 text-purple-700 hover:bg-purple-100 disabled:opacity-40 flex items-center justify-center gap-1">
            {analysisLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Bot className="w-3 h-3" />}
            {analysisLoading ? '分析中...' : 'AI 客户背调'}
          </button>
        )}
      </div>


      {/* ======== 4. AI辅助订单 ======== */}
      <div className="p-3">
        <h3 className="text-xs font-semibold mb-2 flex items-center gap-1.5">
          <Sparkles className="w-3 h-3 text-blue-500" />AI辅助订单
        </h3>
        <div className="space-y-1">
          <button onClick={() => onOpenQuoteForm?.('quote')} className="block w-full text-left text-[10px] px-2 py-1.5 rounded border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors">
            <FileText className="w-3 h-3 inline mr-1" />一键生成报价
          </button>
          <button onClick={() => onOpenQuoteForm?.('pi')} className="block w-full text-left text-[10px] px-2 py-1.5 rounded border border-gray-200 hover:bg-gray-50 text-gray-700 transition-colors">
            <FileText className="w-3 h-3 inline mr-1" />生成 PI
          </button>
          <button onClick={() => onOpenQuoteForm?.('sample')} className="block w-full text-left text-[10px] px-2 py-1.5 rounded border border-gray-200 hover:bg-gray-50 text-gray-700 transition-colors">
            <Package className="w-3 h-3 inline mr-1" />创建样品单
          </button>
        </div>
        <p className="text-[9px] text-gray-400 mt-2 text-center">
          AI 分析对话辅助报价 · 可编辑确认后生成 · 不自动发送
        </p>
      </div>

      {/* ======== 5. Activity Timeline ======== */}
      <div className="p-3 border-t">
        <h3 className="text-xs font-semibold mb-2 flex items-center gap-1.5">
          <History className="w-3 h-3 text-gray-400" />最近活动
        </h3>
        {timeline.length > 0 ? (
          <div className="space-y-1.5">
            {timeline.slice(0, 8).map((a: any) => (
              <div key={a.id} className="flex gap-2 text-[10px]">
                <div className={`w-1.5 h-1.5 rounded-full mt-1 shrink-0 ${
                  a.activityType?.includes('email') ? 'bg-blue-400' :
                  a.activityType?.includes('ai') ? 'bg-purple-400' :
                  a.activityType?.includes('quote') ? 'bg-amber-400' :
                  'bg-gray-300'
                }`} />
                <div className="flex-1 min-w-0">
                  <p className="text-gray-700 truncate">{a.title}</p>
                  <p className="text-[9px] text-gray-400">
                    {new Date(a.occurredAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })}
                  </p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[10px] text-gray-400 text-center py-2">暂无活动记录</p>
        )}
      </div>
    </aside>
  );
}
