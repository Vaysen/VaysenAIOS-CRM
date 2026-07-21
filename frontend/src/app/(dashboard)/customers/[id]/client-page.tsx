'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import { useRuntimeRouteParam } from '@/lib/use-runtime-route-param';
import { Card } from '@/components/ui/card';
import {
  MapPin, Mail, Phone, MessageSquare, FileText, Clock, Users, Building2, ArrowLeft,
  Tag, Pin, X, Star, Globe, ChevronDown, ChevronRight, Sparkles, Calendar,
  TrendingUp, BarChart3, ClipboardList, FileCheck, Package, Briefcase, Activity,
  ExternalLink, MoreHorizontal, Edit3, MessageCircle, Send, Paperclip, Filter,
  Plus, Loader2, Bot, History, FileClock
} from 'lucide-react';

const STAGE_OPTIONS = [
  { key: 'new', label: '新客户' }, { key: 'contacted', label: '已联系' },
  { key: 'sampling', label: '样品中' }, { key: 'quoting', label: '报价中' },
  { key: 'negotiating', label: '谈判中' }, { key: 'won', label: '已成交' }, { key: 'lost', label: '暂停/无效' },
];

const TABS = [
  { key: 'activity', label: '动态', icon: Activity },
  { key: 'profile', label: '资料', icon: Users },
  { key: 'deals', label: '商机&交易', icon: TrendingUp },
  { key: 'tips', label: 'Tips', icon: Sparkles },
  { key: 'docs', label: '文档', icon: FileText },
  { key: 'history', label: '操作历史', icon: History },
] as const;

type TabKey = typeof TABS[number]['key'];

export default function CustomerDetailPage() {
  const id = useRuntimeRouteParam('id');
  const [lead, setLead] = useState<any>(null);
  const [activities, setActivities] = useState<any[]>([]);
  const [communication, setCommunication] = useState<any[]>([]);
  const [quotes, setQuotes] = useState<any[]>([]);
  const [availableTags, setAvailableTags] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  // Customer assets open on the actual profile. The activity stream mostly
  // contains system events for newly archived contacts and looked "empty".
  const [tab, setTab] = useState<TabKey>('profile');
  const [activityFilter, setActivityFilter] = useState<string>('all');
  const [followupInput, setFollowupInput] = useState('');

  // Collapse states for profile sections
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const toggleSection = (key: string) => {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const loadLead = useCallback(async () => {
    if (!id || id === '__static') return;
    const [leadRes, activityRes, tagRes] = await Promise.allSettled([
      api.get(`/leads/${id}`),
      api.get(`/leads/${id}/timeline`, { params: { limit: 50 } }),
      api.get('/tags'),
    ]);
    if (leadRes.status === 'fulfilled') setLead(leadRes.value.data);
    if (activityRes.status === 'fulfilled') setActivities(activityRes.value.data?.data || []);
    if (tagRes.status === 'fulfilled') {
      const tagsData = tagRes.value.data?.data || tagRes.value.data || [];
      setAvailableTags(Array.isArray(tagsData) ? tagsData : []);
    }

    try {
      const [commRes, quoteRes] = await Promise.allSettled([
        api.get('/communications/conversations', { params: { leadId: id } }),
        api.get(`/quotes/lead/${id}`),
      ]);
      if (commRes.status === 'fulfilled') setCommunication(commRes.value.data?.data || []);
      if (quoteRes.status === 'fulfilled') setQuotes(quoteRes.value.data || []);
    } catch (error) { console.error('[Frontend] operation failed:', error); }
  }, [id]);

  useEffect(() => { let c = false; loadLead().finally(() => { if (!c) setLoading(false); }); return () => { c = true; }; }, [loadLead]);

  const changeStage = async (newStatus: string) => {
    await api.patch(`/leads/${id}/status`, { status: newStatus });
    setLead((prev: any) => ({ ...prev, status: newStatus }));
  };

  const togglePin = async () => {
    try {
      if (lead?.isPinned) {
        await api.delete(`/leads/${id}/pin`);
        setLead((prev: any) => ({ ...prev, isPinned: false }));
      } else {
        await api.put(`/leads/${id}/pin`);
        setLead((prev: any) => ({ ...prev, isPinned: true }));
      }
    } catch (error) { console.error('[Frontend] operation failed:', error); }
  };

  const addTag = async (tagId: string) => {
    try { await api.post(`/leads/${id}/tags`, { tagIds: [tagId] }); loadLead(); } catch (error) { console.error('[Frontend] operation failed:', error); }
  };

  const removeTag = async (tagId: string) => {
    try { await api.delete(`/leads/${id}/tags/${tagId}`); loadLead(); } catch (error) { console.error('[Frontend] operation failed:', error); }
  };

  // Activity filtering
  const filteredActivities = activities.filter((a: any) => {
    if (activityFilter === 'all') return true;
    if (activityFilter === 'email') return a.title?.includes('邮件') || a.type === 'email';
    if (activityFilter === 'ai') return a.title?.includes('AI') || a.type?.startsWith('ai_');
    return true;
  });

  // Group activities by date
  const groupedActivities = filteredActivities.reduce((groups: any, a: any) => {
    const date = new Date(a.occurredAt).toLocaleDateString('zh-CN');
    if (!groups[date]) groups[date] = [];
    groups[date].push(a);
    return groups;
  }, {});

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!lead) {
    return (
      <div className="p-6">
        <Link href="/customers" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4">
          <ArrowLeft className="w-3.5 h-3.5" /> 返回客户列表
        </Link>
        <p className="text-sm text-gray-500">客户未找到。</p>
      </div>
    );
  }

  const companyInitial = (lead.companyName || lead.leadName || '?').charAt(0).toUpperCase();
  const primaryContact = lead.contacts?.find((contact: any) => contact.isPrimary) || lead.contacts?.[0];
  const whatsappPoint = lead.contactPoints?.find((point: any) => point.type === 'whatsapp');
  const phonePoint = lead.contactPoints?.find((point: any) => point.type === 'phone');
  const emailPoint = lead.contactPoints?.find((point: any) => point.type === 'email');
  const latestWhatsAppConversation = lead.conversations?.find((conversation: any) => conversation.channel === 'whatsapp');
  const displayContactName = lead.contactName || primaryContact?.displayName || [primaryContact?.firstName, primaryContact?.lastName].filter(Boolean).join(' ');
  const displayEmail = lead.contactEmail || primaryContact?.email || emailPoint?.normalizedValue || emailPoint?.originalValue;
  const displayPhone = lead.contactPhone || lead.whatsapp || primaryContact?.phone || whatsappPoint?.normalizedValue || phonePoint?.normalizedValue;

  return (
    <div className="max-w-5xl mx-auto space-y-0">
      {/* ======== Header ======== */}
      <div className="bg-white rounded-lg border p-4">
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3 flex-1 min-w-0">
            {/* Avatar */}
            <div className="w-10 h-10 rounded-full bg-blue-500 text-white flex items-center justify-center font-bold text-sm shrink-0">
              {companyInitial}
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-base font-bold text-gray-900 truncate">
                  {lead.companyName || lead.leadName || 'Unknown'}
                </h1>
                <button onClick={togglePin} className={`p-0.5 rounded ${lead?.isPinned ? 'text-amber-500' : 'text-gray-300 hover:text-gray-500'}`}>
                  <Pin className="w-3.5 h-3.5" fill={lead?.isPinned ? 'currentColor' : 'none'} />
                </button>
                <button className="p-0.5 rounded text-gray-300 hover:text-gray-500">
                  <Star className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Meta tags */}
              <div className="flex flex-wrap items-center gap-1.5 mt-1 text-[11px] text-gray-500">
                <span>编号: {String(lead.id).slice(0, 8)}</span>
                {lead.country && (
                  <span className="flex items-center gap-0.5">
                    <MapPin className="w-3 h-3" />{lead.country}
                  </span>
                )}
                {displayContactName && <span>{displayContactName}</span>}
                <span>跟进人: <span className="text-blue-600">{lead.owner?.firstName || lead.owner?.email?.split('@')[0] || '—'}</span></span>
              </div>

              {/* Stage + Grade + Tags */}
              <div className="flex flex-wrap items-center gap-2 mt-2">
                <select
                  value={lead.status || 'new'}
                  onChange={(e) => changeStage(e.target.value)}
                  className="text-[11px] border rounded px-2 py-1 bg-white"
                >
                  {STAGE_OPTIONS.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
                {lead.leadGrade && (
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                    lead.leadGrade === 'A' ? 'bg-green-100 text-green-700' :
                    lead.leadGrade === 'B' ? 'bg-blue-100 text-blue-700' :
                    'bg-gray-100 text-gray-600'
                  }`}>
                    {lead.leadGrade}级
                  </span>
                )}
                {(lead.tags || []).map((t: any) => (
                  <span key={t.id || t.tagId} className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full border bg-gray-50">
                    <Tag className="w-2.5 h-2.5" />{t.tag?.displayName || t.tag?.name || '标签'}
                    <button onClick={() => removeTag(t.tagId || t.tag?.id)} className="text-gray-400 hover:text-red-500"><X className="w-2.5 h-2.5" /></button>
                  </span>
                ))}
                {availableTags.filter((t: any) => !(lead.tags || []).some((lt: any) => (lt.tagId || lt.tag?.id) === t.id)).length > 0 && (
                  <select onChange={(e) => { if (e.target.value) addTag(e.target.value); e.target.value = ''; }} className="text-[10px] border rounded px-1.5 py-1 bg-white text-gray-400">
                    <option value="">+ 标签</option>
                    {availableTags.filter((t: any) => !(lead.tags || []).some((lt: any) => (lt.tagId || lt.tag?.id) === t.id)).map((t: any) => (
                      <option key={t.id} value={t.id}>{t.displayName || t.name}</option>
                    ))}
                  </select>
                )}
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-1 text-gray-400">
            <Link href={`/communication?leadId=${id}&phone=${encodeURIComponent(lead?.contactPhone || '')}`} className="p-1.5 hover:text-blue-500 hover:bg-blue-50 rounded" title="发消息">
              <MessageCircle className="w-4 h-4" />
            </Link>
            <button className="p-1.5 hover:text-blue-500 hover:bg-blue-50 rounded" title="发邮件">
              <Send className="w-4 h-4" />
            </button>
            <button className="p-1.5 hover:text-gray-600 hover:bg-gray-50 rounded" title="更多">
              <MoreHorizontal className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {lead.profileSummary && !lead.profileSummary.hasTrustedIdentity && (
        <div className="px-4 py-2 border-x border-b bg-amber-50 text-amber-800 text-xs">
          此客户尚未建立已验证的邮箱/电话/WhatsApp 身份锚点；系统不会根据相似姓名或号码尾号自动合并。请补充可信联系方式，或从 WhatsApp 取得完整号码后再自动建档。
        </div>
      )}

      {/* ======== Tabs ======== */}
      <div className="bg-white rounded-lg border overflow-hidden">
        <nav className="flex border-b bg-gray-50/50 px-2">
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-1.5 px-3 py-2.5 text-[13px] font-medium border-b-2 transition-colors ${
                tab === t.key
                  ? 'border-blue-500 text-blue-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              <t.icon className="w-3.5 h-3.5" />
              {t.label}
            </button>
          ))}
        </nav>

        {/* ======== Tab Content ======== */}

        {/* --- Activity Tab --- */}
        {tab === 'activity' && (
          <div>
            {/* Action area */}
            <div className="p-4 border-b border-dashed">
              <p className="text-[12px] text-gray-500 mb-2">
                如有新的交易，可在此 <Link href={`/opportunities/new?leadId=${id}`} className="text-blue-600 hover:underline">新建商机</Link> 进行管理。
              </p>
              <div className="flex items-center gap-2 flex-wrap">
                <input
                  type="text"
                  value={followupInput}
                  onChange={(e) => setFollowupInput(e.target.value)}
                  placeholder="点击这里记录跟进细节，同步最新进展..."
                  className="flex-1 min-w-[200px] px-3 py-1.5 text-[12px] border rounded-md outline-none focus:border-blue-400 transition-colors"
                />
                <div className="flex gap-1.5">
                  <button className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] rounded border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100">
                    <Sparkles className="w-3 h-3" /> AI 撰写跟进
                  </button>
                  <button className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] rounded border bg-white text-gray-600 hover:bg-gray-50">
                    <ClipboardList className="w-3 h-3" /> 选择模板
                  </button>
                  <button className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] rounded border bg-white text-gray-600 hover:bg-gray-50">
                    <Calendar className="w-3 h-3" /> 添加日程
                  </button>
                </div>
              </div>
            </div>

            {/* Filter bar */}
            <div className="px-4 py-2 border-b flex items-center gap-4 flex-wrap">
              <div className="flex gap-1.5">
                {[
                  { key: 'all', label: '历史动态' },
                  { key: 'ai', label: 'AI 聊天旅程' },
                  { key: 'email', label: 'AI 谈单卡点' },
                ].map(f => (
                  <button
                    key={f.key}
                    onClick={() => setActivityFilter(f.key)}
                    className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${
                      activityFilter === f.key
                        ? 'bg-blue-50 border-blue-200 text-blue-700'
                        : 'border-transparent text-gray-500 hover:bg-gray-100'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              <div className="flex-1" />
              <span className="text-[11px] text-gray-400">
                全部 <span className="bg-gray-100 px-1.5 py-0.5 rounded-full font-medium text-gray-500">{filteredActivities.length}</span>
              </span>
            </div>

            {/* Timeline */}
            <div className="p-4">
              {filteredActivities.length > 0 ? (
                <div className="space-y-6">
                  {Object.entries(groupedActivities).map(([date, acts]: [string, any]) => (
                    <div key={date}>
                      <div className="text-[11px] text-gray-400 font-medium mb-3 ml-1 flex items-center gap-1.5">
                        <Clock className="w-3 h-3" />
                        {date}
                        <span className="bg-gray-100 px-1.5 py-0.5 rounded-full text-[10px]">{acts.length}</span>
                      </div>
                      <div className="space-y-2">
                        {acts.map((a: any) => (
                          <div key={a.id} className="flex gap-3 p-3 bg-gray-50/80 border rounded-lg hover:bg-white hover:shadow-sm transition-all">
                            {/* Left: dot + time */}
                            <div className="flex flex-col items-center gap-1 shrink-0 pt-0.5">
                              <div className={`w-2 h-2 rounded-full ${
                                a.title?.includes('收到') ? 'bg-green-400' :
                                a.title?.includes('发送') ? 'bg-orange-400' :
                                a.type?.startsWith('ai_') ? 'bg-purple-400' :
                                'bg-blue-400'
                              }`} />
                              <span className="text-[9px] text-gray-400 whitespace-nowrap">
                                {new Date(a.occurredAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                              </span>
                            </div>

                            {/* Right: content */}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-2 flex-wrap mb-1">
                                <span className="text-[12px] font-medium text-gray-800">{a.title}</span>
                                {a.title?.includes('AI') && (
                                  <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-purple-50 text-purple-600 border border-purple-200 flex items-center gap-0.5">
                                    <Sparkles className="w-2 h-2" />AI 分析
                                  </span>
                                )}
                              </div>
                              {a.description && (
                                <p className="text-[11px] text-gray-600 leading-relaxed">{a.description}</p>
                              )}
                              {a.attachmentName && (
                                <div className="inline-flex items-center gap-1.5 mt-1 px-2 py-0.5 bg-gray-100 rounded text-[10px] text-gray-500">
                                  <Paperclip className="w-2.5 h-2.5" />{a.attachmentName}
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="py-8 text-center">
                  <Activity className="w-8 h-8 mx-auto text-gray-300 mb-2" />
                  <p className="text-sm text-gray-400">暂无活动记录</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* --- Profile Tab --- */}
        {tab === 'profile' && (
          <div className="p-4 space-y-1">
            {/* Section 1: 主要联系人信息 */}
            <SectionHeader
              title="主要联系人信息"
              subtitle={`全部联系人(${lead.contacts?.length || (displayContactName ? 1 : 0)})`}
              collapsed={collapsedSections.has('contacts')}
              onToggle={() => toggleSection('contacts')}
            />
            {!collapsedSections.has('contacts') && (
              <div className="grid grid-cols-3 gap-x-6 gap-y-2 px-2 py-2 mb-2">
                <InfoField label="姓名" value={displayContactName} main />
                <InfoField label="社交平台" value={(lead as any).socialMedia} link />
                <InfoField label="职位" value={(lead as any).contactTitle} empty />
                <InfoField label="邮箱" value={displayEmail} link />
                <InfoField label="联系电话" value={displayPhone} />
                <InfoField label="性别" value={(lead as any).gender} empty />
              </div>
            )}

            {/* Section 2: 公司常用信息 */}
            <SectionHeader
              title="公司常用信息"
              collapsed={collapsedSections.has('company')}
              onToggle={() => toggleSection('company')}
            />
            {!collapsedSections.has('company') && (
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 px-2 py-2 mb-2">
                <InfoField label="公司网址" value={(lead as any).website} link />
                <InfoField label="公司名称" value={lead.companyName} />
                <InfoField label="简称" value={(lead as any).shortName} empty />
                <InfoField label="国家地区" value={lead.country} flag />
                <InfoField label="客户来源" value={lead.sourceType === 'website_inquiry' ? '网站询盘' : lead.sourceType === 'acquisition' ? '获客开发' : lead.sourceType === 'manual' ? '手动录入' : lead.sourceType || '--'} />
                <InfoField label="客户阶段" value={STAGE_OPTIONS.find(s => s.key === lead.status)?.label || lead.status} />
                <InfoField label="客户编号" value={String(lead.id).slice(0, 8)} />
                <InfoField label="客户分类" value={lead.industry} empty />
                <InfoField label="客户类别" value={(lead as any).customerCategory} empty />
                <InfoField label="客户类型" value={lead.businessType} empty />
                <InfoField label="是否主动营销" value={(lead as any).marketingEnabled} empty />
                <InfoField label="座机" value={(lead as any).landline} empty />
                <InfoField label="公海分组" value={(lead as any).poolGroup} empty full />
              </div>
            )}

            {/* Section 3: 公司其他信息 */}
            <SectionHeader
              title="公司其他信息"
              collapsed={collapsedSections.has('other')}
              onToggle={() => toggleSection('other')}
            />
            {!collapsedSections.has('other') && (
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 px-2 py-2 mb-2">
                <InfoField label="采购意向" value={lead.productCategory || lead.mainProducts} empty />
                <InfoField label="年采购额" value={lead.annualRevenue} empty />
                <InfoField label="时区" value={(lead as any).timezone} empty />
                <InfoField label="规模" value={lead.employeeCount} empty />
                <InfoField label="产品分组" value={lead.mainProducts || lead.productCategory} empty />
                <InfoField label="传真" value={(lead as any).fax} empty />
                <InfoField label="详细地址" value={[lead.city, lead.country].filter(Boolean).join(', ')} empty full />
                <InfoField label="公司备注" value={lead.notes} empty full />
                <InfoField label="客户星级" value={(lead as any).starRating} empty />
              </div>
            )}

            {/* Section 4: 跟进信息 */}
            <SectionHeader
              title="跟进信息"
              collapsed={collapsedSections.has('followup')}
              onToggle={() => toggleSection('followup')}
            />
            {!collapsedSections.has('followup') && (
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 px-2 py-2 mb-2">
                <InfoField label="最近联系时间" value={lead.lastContactedAt ? new Date(lead.lastContactedAt).toLocaleString('zh-CN') : '--'} />
                <InfoField label="最近跟进时间" value={lead.updatedAt ? new Date(lead.updatedAt).toLocaleString('zh-CN') : '--'} />
                <InfoField label="下次移交公海日期" value="--" empty />
                <InfoField label="最近进入私海时间" value={lead.createdAt ? new Date(lead.createdAt).toLocaleString('zh-CN') : '--'} />
                <InfoField label="最近进入公海时间" value="--" empty />
                <InfoField label="进入公海次数" value="0" />
                <InfoField label="最近成交日期" value="--" empty />
                <InfoField label="最近WhatsApp沟通时间" value={latestWhatsAppConversation?.lastMessageAt ? new Date(latestWhatsAppConversation.lastMessageAt).toLocaleString('zh-CN') : undefined} empty />
                <InfoField label="下次日程时间" value={(lead as any).nextFollowUpAt ? new Date((lead as any).nextFollowUpAt).toLocaleString('zh-CN') : '--'} empty full />
              </div>
            )}

            {/* Section 5: 系统信息 */}
            <SectionHeader
              title="系统信息"
              collapsed={collapsedSections.has('system')}
              onToggle={() => toggleSection('system')}
            />
            {!collapsedSections.has('system') && (
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 px-2 py-2 mb-2">
                <InfoField label="创建人" value={lead.owner?.firstName || '--'} />
                <InfoField label="创建时间" value={lead.createdAt ? new Date(lead.createdAt).toLocaleString('zh-CN') : '--'} />
                <InfoField label="最近修改人" value={lead.owner?.firstName || '--'} />
                <InfoField label="资料更新时间" value={lead.updatedAt ? new Date(lead.updatedAt).toLocaleString('zh-CN') : '--'} />
                <InfoField label="原始跟进人" value="--" empty />
                <InfoField label="客户跟进人" value={lead.owner?.firstName || '--'} />
                <InfoField label="创建方式" value={lead.sourceType === 'whatsapp' ? 'WhatsApp 自动建档' : '导入或手动创建'} />
                <InfoField label="关联线索" value="--" empty />
                <InfoField label="来源详情" value={lead.sourceUrl || lead.sources?.[0]?.sourceTitle || lead.sources?.[0]?.sourceUrl} empty full />
                <InfoField label="客群" value="--" empty />
                <InfoField label="关联客户最近同步时间" value="--" empty />
              </div>
            )}
          </div>
        )}

        {/* --- Deals Tab --- */}
        {tab === 'deals' && (
          <div className="p-6">
            <div className="text-center py-8">
              <TrendingUp className="w-10 h-10 mx-auto text-gray-300 mb-3" />
              <p className="text-sm font-medium text-gray-600">商机 & 交易</p>
              <p className="text-xs text-gray-400 mt-1">关联的商机、报价、订单和合同将在此集中展示。</p>
              {quotes.length > 0 && (
                <div className="mt-4 max-w-md mx-auto text-left space-y-2">
                  {quotes.map((q: any) => (
                    <div key={q.id} className="flex items-center justify-between p-2 border rounded text-[12px]">
                      <span className="font-medium text-gray-700">{q.outputContent ? (() => { try { return JSON.parse(q.outputContent).referenceNo || '草稿'; } catch { return '报价'; } })() : '报价'}</span>
                      <span className="text-gray-400">{new Date(q.createdAt).toLocaleDateString('zh-CN')}</span>
                    </div>
                  ))}
                </div>
              )}
              <Link href={`/quotes/new?leadId=${id}`} className="inline-block mt-3 text-xs text-blue-600 hover:underline">+ 新建报价/商机</Link>
            </div>
          </div>
        )}

        {/* --- Tips Tab --- */}
        {tab === 'tips' && (
          <div className="p-6">
            <div className="text-center py-8">
              <Sparkles className="w-10 h-10 mx-auto text-gray-300 mb-3" />
              <p className="text-sm font-medium text-gray-600">AI Tips</p>
              <p className="text-xs text-gray-400 mt-1">AI 根据客户画像和沟通记录自动生成的销售建议和话术提示。</p>
              <p className="text-xs text-gray-400 mt-0.5">即将上线</p>
            </div>
          </div>
        )}

        {/* --- Docs Tab --- */}
        {tab === 'docs' && (
          <div className="p-6">
            <div className="text-center py-8">
              <FileText className="w-10 h-10 mx-auto text-gray-300 mb-3" />
              <p className="text-sm font-medium text-gray-600">文档</p>
              <p className="text-xs text-gray-400 mt-1">与该客户相关的合同、PI、规格书、检验报告等文档。</p>
              <p className="text-xs text-gray-400 mt-0.5">即将上线</p>
            </div>
          </div>
        )}

        {/* --- History Tab --- */}
        {tab === 'history' && (
          <div className="p-6">
            <div className="text-center py-8">
              <History className="w-10 h-10 mx-auto text-gray-300 mb-3" />
              <p className="text-sm font-medium text-gray-600">操作历史</p>
              <p className="text-xs text-gray-400 mt-1">系统自动记录的所有操作日志，包括资料修改、阶段变更、标签变更等。</p>
              <p className="text-xs text-gray-400 mt-0.5">即将上线</p>
            </div>
          </div>
        )}
      </div>

      {/* Footer note */}
      <div className="text-center py-3">
        <p className="text-[11px] text-gray-400">待跟进事项、AI聊天旅程、AI谈单卡点内容由AI生成</p>
      </div>
    </div>
  );
}

/* ======== Inline sub-components ======== */

function SectionHeader({ title, subtitle, collapsed, onToggle }: {
  title: string;
  subtitle?: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className="flex items-center justify-between py-2 border-b cursor-pointer hover:bg-gray-50/50 rounded px-2 transition-colors"
      onClick={onToggle}
    >
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-medium text-gray-800">{title}</span>
        {subtitle && <span className="text-[11px] text-gray-400">{subtitle}</span>}
      </div>
      <span className="text-gray-400 flex items-center gap-1 text-[11px]">
        {collapsed ? '展开' : '收起'}
        {collapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
      </span>
    </div>
  );
}

function InfoField({ label, value, link, empty, main, full, flag }: {
  label: string;
  value: string | undefined | null;
  link?: boolean;
  empty?: boolean;
  main?: boolean;
  full?: boolean;
  flag?: boolean;
}) {
  const display = value || '--';
  const isEmpty = empty || !value;

  if (link && value) {
    return (
      <div className={full ? 'col-span-full' : ''}>
        <div className="text-[11px] text-gray-400">{label}</div>
        <div className="text-[12px] text-blue-600 hover:underline cursor-pointer truncate">
          {flag && <MapPin className="w-3 h-3 inline mr-0.5" />}
          {value}
        </div>
      </div>
    );
  }

  return (
    <div className={full ? 'col-span-full' : ''}>
      <div className="text-[11px] text-gray-400">{label}</div>
      <div className={`text-[12px] ${isEmpty ? 'text-gray-300' : 'text-gray-800'} ${main ? 'font-medium' : ''} truncate`}>
        {flag && <MapPin className="w-3 h-3 inline mr-0.5" />}
        {display}
        {main && <span className="text-[10px] text-gray-400 font-normal ml-1">主</span>}
      </div>
    </div>
  );
}
