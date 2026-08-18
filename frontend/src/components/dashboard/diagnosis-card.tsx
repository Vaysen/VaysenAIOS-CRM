'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Sparkles, TrendingUp } from 'lucide-react';
import { getDailyDiagnosis, regenerateDailyDiagnosis, type DailyDiagnosis } from '@/lib/dashboard-api';
import { getApiErrorMessage } from '@/lib/api-error';
import { cn } from '@/lib/utils';

const PRIORITY_STYLES: Record<string, string> = {
  P0: 'border-red-200 bg-red-50',
  P1: 'border-amber-200 bg-amber-50',
  P2: 'border-slate-200 bg-slate-50',
};

const PRIORITY_BADGE: Record<string, string> = {
  P0: 'bg-red-600',
  P1: 'bg-amber-500',
  P2: 'bg-slate-400',
};

function HealthRing({ score }: { score: number }) {
  const radius = 34;
  const circumference = 2 * Math.PI * radius;
  const ratio = Math.max(0, Math.min(100, score)) / 100;
  const color = score >= 70 ? '#10b981' : score >= 45 ? '#f59e0b' : '#ef4444';
  return (
    <div className="relative h-24 w-24 shrink-0">
      <svg viewBox="0 0 84 84" className="h-full w-full -rotate-90">
        <circle cx="42" cy="42" r={radius} fill="none" stroke="#e2e8f0" strokeWidth="8" />
        <circle
          cx="42"
          cy="42"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - ratio)}
          className="transition-all duration-700"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-xl font-bold text-slate-900">{score}</span>
        <span className="text-[9px] text-slate-400">健康分</span>
      </div>
    </div>
  );
}

export function DiagnosisCard({ companyId }: { companyId: string }) {
  const [diagnosis, setDiagnosis] = useState<DailyDiagnosis | null>(null);
  const [generating, setGenerating] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const load = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    setError('');
    try {
      const result = await getDailyDiagnosis(companyId);
      if (result && 'generating' in result && result.generating) {
        setGenerating(true);
        stopPolling();
        pollRef.current = setInterval(() => void load(), 5000);
      } else {
        setGenerating(false);
        setUnavailable(false);
        setDiagnosis(result as DailyDiagnosis | null);
        stopPolling();
      }
    } catch (err: unknown) {
      setGenerating(false);
      setUnavailable(true);
      setError(getApiErrorMessage(err, 'AI 运营诊断暂不可用'));
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    void load();
    return stopPolling;
  }, [load]);

  const regenerate = async () => {
    if (!companyId) return;
    setLoading(true);
    setError('');
    try {
      setDiagnosis(await regenerateDailyDiagnosis(companyId));
      setGenerating(false);
      setUnavailable(false);
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, '重新分析失败'));
    } finally {
      setLoading(false);
    }
  };

  const score = diagnosis?.healthScore ?? 0;
  const recommendations = diagnosis?.recommendations || [];

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-50 text-violet-700">
            <Sparkles className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-slate-900">AI 运营诊断</h2>
            <p className="text-[10px] text-slate-400">基于真实业务数据的每日运营快照</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {generating && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-violet-50 px-2.5 py-1 text-[10px] font-medium text-violet-700">
              <Loader2 className="h-3 w-3 animate-spin" />
              AI 正在分析今日数据…
            </span>
          )}
          {diagnosis?.diagnosisDate && (
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-medium text-slate-600">
              快照：{String(diagnosis.diagnosisDate).slice(0, 10)}
            </span>
          )}
          <button
            onClick={() => void (diagnosis ? regenerate() : load())}
            disabled={loading || generating}
            className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
            {diagnosis ? '重新分析' : '生成诊断'}
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs leading-5 text-red-700">
          {error}
          {unavailable && (
            <p className="mt-1 text-[10px] text-red-500">OpenClaw 诊断服务未连接，可稍后重试或联系管理员。</p>
          )}
        </div>
      )}

      {loading && !diagnosis && !error && (
        <div className="mt-6 flex items-center justify-center gap-2 py-6 text-xs text-slate-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在读取诊断快照…
        </div>
      )}

      {!loading && !error && diagnosis && (
        <div className="mt-4 flex flex-col gap-4 xl:flex-row">
          <div className="flex items-center gap-4 xl:w-72 xl:shrink-0">
            <HealthRing score={score} />
            <div className="min-w-0 flex-1">
              <p className="text-sm leading-6 text-slate-700">{diagnosis.summary || '暂无诊断结论'}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(diagnosis.highlights || []).slice(0, 3).map((item) => (
                  <span
                    key={item}
                    className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] text-emerald-700"
                  >
                    <TrendingUp className="h-2.5 w-2.5" />
                    {item}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div className="flex-1 space-y-2">
            {(diagnosis.risks || []).slice(0, 3).map((item) => (
              <div
                key={item}
                className="flex items-start gap-2 rounded-lg border border-red-100 bg-red-50/60 px-3 py-2 text-xs leading-5 text-red-800"
              >
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />
                {item}
              </div>
            ))}
            {recommendations.map((rec) => (
              <div
                key={`${rec.priority}-${rec.title}`}
                className={cn('rounded-lg border px-3 py-2', PRIORITY_STYLES[rec.priority] || PRIORITY_STYLES.P2)}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'rounded px-1.5 py-0.5 text-[9px] font-bold text-white',
                      PRIORITY_BADGE[rec.priority] || PRIORITY_BADGE.P2,
                    )}
                  >
                    {rec.priority}
                  </span>
                  <span className="text-xs font-semibold text-slate-800">{rec.title}</span>
                </div>
                <p className="mt-1 text-[11px] leading-5 text-slate-600">
                  {rec.reason} —— {rec.action}
                </p>
              </div>
            ))}
            {!recommendations.length && !(diagnosis.risks || []).length && (
              <div className="flex items-center gap-2 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-500">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                今日无特别风险项，继续保持。
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
