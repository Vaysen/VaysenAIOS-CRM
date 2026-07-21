'use client';

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import { Card } from '@/components/ui/card';
import {
  Users, Target, TrendingUp, Clock, BarChart3, Star, Activity, AlertCircle,
  Globe, MapPin, ArrowUp, ArrowDown, ChevronRight, Filter, Zap, FileText
} from 'lucide-react';

const STAGE_LABELS: Record<string, string> = {
  new: '新客户', contacted: '已联系', sampling: '样品中',
  quoting: '报价中', negotiating: '谈判中', won: '已成交', lost: '暂停',
};

export default function ExecutivePage() {
  const [leads, setLeads] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [timeRange, setTimeRange] = useState<'today'|'week'|'month'>('week');

  useEffect(() => {
    api.get('/leads', { params: { limit: 500 } }).then(r => setLeads(r.data?.data||[])).catch((error) => { console.error('[Frontend] background operation failed:', error); }).finally(()=>setLoading(false));
  }, []);

  const gradeA = leads.filter((l:any)=>l.leadGrade==='A');
  const gradeB = leads.filter((l:any)=>l.leadGrade==='B');
  const gradeC = leads.filter((l:any)=>l.leadGrade==='C'||!l.leadGrade);
  const won = leads.filter((l:any)=>l.status==='won');
  const inactive = leads.filter((l:any)=>l.lastContactedAt&&(Date.now()-new Date(l.lastContactedAt).getTime())>7*86400000);

  // Stage distribution for funnel
  const stageCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    leads.forEach(l => { const s = l.status || 'new'; counts[s] = (counts[s]||0)+1; });
    return counts;
  }, [leads]);

  const stageOrder = ['new', 'contacted', 'sampling', 'quoting', 'negotiating', 'won'];
  const maxStage = Math.max(1, ...stageOrder.map(s => stageCounts[s] || 0));

  // Country distribution
  const countryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    leads.forEach(l => { if (l.country) { counts[l.country] = (counts[l.country]||0)+1; } });
    return Object.entries(counts).sort(([,a],[,b]) => b-a).slice(0, 8);
  }, [leads]);
  const maxCountry = Math.max(1, ...countryCounts.map(([,c]) => c));

  // Team leaderboard (mock for now)
  const teamMembers = [
    { name: 'chris', leads: gradeA.length + gradeB.length, won: won.length, rate: leads.length ? Math.round(won.length / leads.length * 100) : 0 },
    { name: 'alex', leads: 45, won: 12, rate: 27 },
    { name: 'sarah', leads: 38, won: 8, rate: 21 },
  ];

  // Monthly trend mock
  const monthlyTrend = [
    { month: '1月', leads: 12, won: 3 },
    { month: '2月', leads: 18, won: 5 },
    { month: '3月', leads: 15, won: 4 },
    { month: '4月', leads: 22, won: 7 },
    { month: '5月', leads: 28, won: 9 },
    { month: '6月', leads: 35, won: 11 },
  ];

  if (loading) return <div className="flex justify-center py-16"><div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" /></div>;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-bold">经营驾驶舱</h1>
          <p className="text-[11px] text-gray-500">ABCD客户分级 · 团队效率 · 业务趋势 · 阶段漏斗</p>
        </div>
        <div className="flex gap-1">
          {[{k:'today',l:'今日'},{k:'week',l:'本周'},{k:'month',l:'本月'}].map(t => (
            <button key={t.k} onClick={()=>setTimeRange(t.k as any)} className={`text-[11px] px-2.5 py-1 rounded-md border ${timeRange===t.k?'bg-blue-50 border-blue-200 text-blue-700 font-semibold':'border-gray-200 text-gray-400 hover:bg-gray-50'}`}>{t.l}</button>
          ))}
        </div>
      </div>

      {/* Grade Distribution Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          { label:'A级客户', value:gradeA.length, color:'bg-red-50 text-red-700 border-red-200', icon:<Star className="w-4 h-4"/> },
          { label:'B级客户', value:gradeB.length, color:'bg-amber-50 text-amber-700 border-amber-200', icon:<Users className="w-4 h-4"/> },
          { label:'C级客户', value:gradeC.length, color:'bg-gray-50 text-gray-600 border-gray-200', icon:<Users className="w-4 h-4"/> },
          { label:'已成交', value:won.length, color:'bg-green-50 text-green-700 border-green-200', icon:<Target className="w-4 h-4"/> },
          { label:'客户总数', value:leads.length, color:'bg-blue-50 text-blue-700 border-blue-200', icon:<TrendingUp className="w-4 h-4"/> },
        ].map(m => (
          <Card key={m.label} className={`p-3 text-center border ${m.color.split(' ')[0]} ${m.color.split(' ')[2] || ''}`}>
            <div className={`w-8 h-8 mx-auto rounded-lg ${m.color.split(' ')[0]} flex items-center justify-center mb-1.5`}>{m.icon}</div>
            <p className="text-lg font-bold">{m.value}</p>
            <p className="text-[10px] text-gray-500">{m.label}</p>
          </Card>
        ))}
      </div>

      {/* Row 1: Monthly Trend + Stage Funnel */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Monthly Trend */}
        <Card className="p-4">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-1.5">
            <TrendingUp className="w-3.5 h-3.5 text-blue-500" />本月趋势
            <span className="text-[9px] text-gray-300 font-normal ml-auto">演示数据</span>
          </h3>
          <div className="flex items-end gap-2 h-24">
            {monthlyTrend.map((m, i) => (
              <div key={m.month} className="flex-1 flex flex-col items-center gap-1">
                <div className="w-full flex flex-col items-center gap-0.5">
                  <div className="w-full bg-green-200 rounded-t" style={{height: `${m.won / 15 * 60}px`}} />
                  <div className="w-full bg-blue-200 rounded-t" style={{height: `${(m.leads - m.won) / 40 * 60}px`}} />
                </div>
                <span className="text-[9px] text-gray-400">{m.month}</span>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-3 mt-3 text-[10px]">
            <span className="flex items-center gap-1"><span className="w-3 h-3 bg-blue-200 rounded" /> 新客户</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 bg-green-200 rounded" /> 成交</span>
          </div>
        </Card>

        {/* Stage Funnel */}
        <Card className="p-4">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-1.5">
            <Filter className="w-3.5 h-3.5 text-purple-500" />客户阶段漏斗
          </h3>
          <div className="space-y-1.5">
            {stageOrder.map(s => {
              const count = stageCounts[s] || 0;
              const pct = Math.round(count / maxStage * 100);
              return (
                <div key={s} className="flex items-center gap-2">
                  <span className="text-[11px] text-gray-600 w-14 shrink-0">{STAGE_LABELS[s]}</span>
                  <div className="flex-1 h-5 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        s === 'won' ? 'bg-green-400' :
                        s === 'negotiating' ? 'bg-blue-400' :
                        s === 'quoting' ? 'bg-amber-400' :
                        s === 'sampling' ? 'bg-purple-400' :
                        s === 'contacted' ? 'bg-cyan-400' :
                        'bg-gray-300'
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-gray-500 w-8 text-right shrink-0">{count}</span>
                </div>
              );
            })}
          </div>
        </Card>
      </div>

      {/* Row 2: A-grade Clients + Country Distribution */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="p-4">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-1.5">
            <Star className="w-3.5 h-3.5 text-red-500" />A级客户 ({gradeA.length})
          </h3>
          <div className="space-y-0.5 max-h-[260px] overflow-y-auto">
            {gradeA.slice(0, 10).map((l:any) => (
              <Link key={l.id} href={`/customers/${l.id}`} className="flex items-center justify-between p-2 rounded hover:bg-gray-50 text-[12px] transition-colors">
                <div className="flex items-center gap-2 min-w-0">
                  <Star className="w-3 h-3 text-amber-400 shrink-0" fill="currentColor" />
                  <span className="truncate font-medium text-gray-800">{l.companyName}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-gray-400 shrink-0">
                  <span>{l.country || '—'}</span>
                  <span className="text-blue-600">{l.owner?.firstName || 'chris'}</span>
                </div>
              </Link>
            ))}
            {gradeA.length === 0 && <p className="text-gray-400 text-xs py-4 text-center">暂无A级客户</p>}
          </div>
        </Card>

        {/* Country Distribution */}
        <Card className="p-4">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-1.5">
            <Globe className="w-3.5 h-3.5 text-green-500" />国家/地区分布
          </h3>
          {countryCounts.length > 0 ? (
            <div className="space-y-1.5">
              {countryCounts.map(([country, count]) => {
                const pct = Math.round(count / maxCountry * 100);
                return (
                  <div key={country} className="flex items-center gap-2">
                    <span className="text-[11px] text-gray-600 w-20 shrink-0 flex items-center gap-1">
                      <MapPin className="w-3 h-3 text-gray-400" />{country}
                    </span>
                    <div className="flex-1 h-4 bg-gray-100 rounded-full overflow-hidden">
                      <div className="h-full bg-green-300 rounded-full transition-all" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-[10px] text-gray-500 w-6 text-right shrink-0">{count}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-gray-400 text-xs py-4 text-center">暂无数据</p>
          )}
        </Card>
      </div>

      {/* Row 3: Churn Warning + Team Leaderboard + Recent Won */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Churn Warning */}
        <Card className="p-4">
          <h3 className="text-sm font-semibold mb-2 flex items-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5 text-red-500" />流失预警
          </h3>
          <p className="text-2xl font-bold text-red-600">{inactive.length}</p>
          <p className="text-[10px] text-gray-400 mt-0.5">超7天未联系客户</p>
          <div className="mt-2 space-y-1">
            {inactive.slice(0, 5).map((l:any) => (
              <Link key={l.id} href={`/customers/${l.id}`} className="block text-[11px] text-gray-600 hover:text-blue-600 truncate">
                {l.companyName} · {l.lastContactedAt ? new Date(l.lastContactedAt).toLocaleDateString('zh-CN') : '从未联系'}
              </Link>
            ))}
          </div>
        </Card>

        {/* Team Leaderboard */}
        <Card className="p-4">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5 text-amber-500" />团队排行榜
          </h3>
          <div className="space-y-2">
            {teamMembers.map((m, i) => (
              <div key={m.name} className="flex items-center gap-2">
                <span className={`text-[10px] font-bold w-5 text-center ${i === 0 ? 'text-amber-500' : i === 1 ? 'text-gray-400' : 'text-gray-300'}`}>
                  {i + 1}
                </span>
                <span className="text-[12px] font-medium text-gray-800 flex-1">{m.name}</span>
                <span className="text-[10px] text-gray-400">{m.leads} 客户</span>
                <span className="text-[10px] text-green-600 font-medium">{m.won} 成交</span>
                <span className="text-[10px] text-gray-400">{m.rate}%</span>
              </div>
            ))}
          </div>
        </Card>

        {/* Recent Won */}
        <Card className="p-4">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-1.5">
            <Target className="w-3.5 h-3.5 text-green-500" />最近成交
          </h3>
          <div className="space-y-0.5">
            {won.slice(0, 8).map((l:any) => (
              <Link key={l.id} href={`/customers/${l.id}`} className="flex items-center justify-between p-1.5 rounded hover:bg-gray-50 text-[12px] transition-colors">
                <span className="truncate text-gray-800">{l.companyName}</span>
                <span className="text-[10px] text-gray-400 shrink-0">{l.country}</span>
              </Link>
            ))}
            {won.length === 0 && <p className="text-gray-400 text-xs py-4 text-center">暂无成交记录</p>}
          </div>
        </Card>
      </div>

      {/* Quick Links */}
      <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
        {[
          { href:'/customers', label:'客户资产', icon:<Users className="w-3.5 h-3.5"/> },
          { href:'/analytics', label:'数据分析', icon:<BarChart3 className="w-3.5 h-3.5"/> },
          { href:'/emails', label:'邮件中心', icon:<Activity className="w-3.5 h-3.5"/> },
          { href:'/communication', label:'沟通中心', icon:<Activity className="w-3.5 h-3.5"/> },
          { href:'/quotes', label:'报价管理', icon:<FileText className="w-3.5 h-3.5" /> },
          { href:'/products', label:'产品资料', icon:<FileText className="w-3.5 h-3.5" /> },
        ].map(a => (
          <Link key={a.href} href={a.href} className="flex items-center justify-center gap-1.5 p-2.5 border rounded-lg hover:bg-gray-50 text-[12px] text-gray-600 transition-colors">
            {a.icon}{a.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
