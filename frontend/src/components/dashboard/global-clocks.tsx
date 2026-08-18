'use client';

import { useEffect, useState } from 'react';
import { Globe2 } from 'lucide-react';

const CLOCKS = [
  { label: '北京', zone: 'Asia/Shanghai' },
  { label: '迪拜', zone: 'Asia/Dubai' },
  { label: '伦敦', zone: 'Europe/London' },
  { label: '纽约', zone: 'America/New_York' },
  { label: '悉尼', zone: 'Australia/Sydney' },
];

export function GlobalClocks() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto">
      <Globe2 className="h-3.5 w-3.5 shrink-0 text-slate-400" />
      {CLOCKS.map((clock) => {
        const time = new Intl.DateTimeFormat('zh-CN', {
          timeZone: clock.zone,
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).format(now);
        const date = new Intl.DateTimeFormat('zh-CN', {
          timeZone: clock.zone,
          month: 'numeric',
          day: 'numeric',
          weekday: 'short',
        }).format(now);
        return (
          <div key={clock.zone} className="flex shrink-0 items-baseline gap-1 rounded-lg bg-white px-2 py-1 shadow-sm ring-1 ring-slate-200">
            <span className="text-[10px] font-medium text-slate-500">{clock.label}</span>
            <span className="text-xs font-semibold tabular-nums text-slate-800">{time}</span>
            <span className="hidden text-[9px] text-slate-400 lg:inline">{date}</span>
          </div>
        );
      })}
    </div>
  );
}
