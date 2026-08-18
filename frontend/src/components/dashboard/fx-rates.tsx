'use client';

import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { getFxRates, type FxRates } from '@/lib/dashboard-api';

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY'];

export function FxRatesBar() {
  const [rates, setRates] = useState<FxRates | null>(null);
  const [failed, setFailed] = useState(false);

  const load = async () => {
    const data = await getFxRates();
    if (data) {
      setRates(data);
      setFailed(false);
    } else {
      setFailed(true);
    }
  };

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 4 * 60 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  const sourceLabels: Record<string, string> = {
    fawazahmed0: '实时',
    frankfurter: '实时',
    'static-fallback': '兜底',
  };

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto">
      {failed && !rates ? (
        <span className="text-[10px] text-slate-400">汇率暂不可用</span>
      ) : rates ? (
        <>
          <RefreshCw
            className="h-3.5 w-3.5 shrink-0 cursor-pointer text-slate-400 transition hover:text-slate-600"
            onClick={() => void load()}
          />
          {CURRENCIES.map((code) => (
            <div
              key={code}
              className="flex shrink-0 items-baseline gap-1 rounded-lg bg-white px-2 py-1 shadow-sm ring-1 ring-slate-200"
            >
              <span className="text-[10px] font-medium text-slate-500">{code}/CNY</span>
              <span className="text-xs font-semibold tabular-nums text-slate-800">
                {rates.rates[code]?.toFixed(4) ?? '—'}
              </span>
            </div>
          ))}
          <span
            className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-medium ${
              rates.source === 'static-fallback'
                ? 'bg-amber-50 text-amber-700'
                : 'bg-emerald-50 text-emerald-700'
            }`}
          >
            {sourceLabels[rates.source] || rates.source}
          </span>
        </>
      ) : (
        <span className="text-[10px] text-slate-400">正在加载汇率…</span>
      )}
    </div>
  );
}
