/**
 * marketing-scheduling.service.ts
 *
 * wesley-ai-crm 批次2：营销活动排程 —— 纯函数（无 IO、无 DB 依赖，便于单测与复用）。
 *
 * - materializeMarketingScheduleIntent: 把排程意图（窗口 + 频控 maxPerContact/windowSeconds）
 *   物化为可执行的确定性排程（窗口解析 + 候选投放时刻）。
 * - evaluateMarketingScheduleAt: 在给定时刻评估该排程是否放行（窗口 + 频控）。
 */

export interface MarketingScheduleWindow {
  start: Date;
  end: Date;
}

export interface MarketingScheduleIntent {
  channel: string;
  windowStart?: string | Date | null;
  windowEnd?: string | Date | null;
  /** 若提供 windowSeconds，则以 now 为起点推导窗口 */
  windowSeconds?: number | null;
  /** 同一触点在该窗口内的最大投放次数 */
  maxPerContact?: number | null;
  timezone?: string | null;
}

export interface MarketingScheduleSlot {
  at: Date;
}

export interface MaterializedMarketingSchedule {
  channel: string;
  window: MarketingScheduleWindow;
  windowSeconds: number;
  maxPerContact: number;
  slots: MarketingScheduleSlot[];
}

export interface MarketingScheduleEvaluationInput {
  intent: MaterializedMarketingSchedule;
  now?: Date;
  /** 该触点在该渠道的既往投放时刻（用于频控） */
  previousDeliveries?: Array<{ at: Date }>;
}

export interface MarketingScheduleEvaluation {
  eligible: boolean;
  reason: 'ok' | 'outside_window' | 'frequency_capped' | 'invalid_window';
  withinWindow: boolean;
  recentDeliveries: number;
  maxPerContact: number;
  windowSeconds: number;
  nextSlotAt: Date | null;
}

export const DEFAULT_MAX_PER_CONTACT = 1;
export const DEFAULT_WINDOW_SECONDS = 0; // 0 = 不限定窗口（随排程意图显式给出）
export const MAX_SCHEDULE_SLOTS = 1000;
export const MAX_WINDOW_SECONDS = 90 * 24 * 3600; // 90 天上限，防止超大数组

function toDate(value: string | Date | null | undefined): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * 物化排程意图：
 * - windowStart/windowEnd 显式给定；或 windowSeconds 以 now 为起点推导。
 * - 在窗口内生成确定性候选投放时刻（最多 MAX_SCHEDULE_SLOTS 个）。
 */
export function materializeMarketingScheduleIntent(
  intent: MarketingScheduleIntent,
  now: Date = new Date(),
): MaterializedMarketingSchedule {
  const channel = intent.channel?.trim() || 'email';
  const windowSeconds = Math.max(
    0,
    Math.min(
      intent.windowSeconds ?? DEFAULT_WINDOW_SECONDS,
      MAX_WINDOW_SECONDS,
    ),
  );
  const maxPerContact = Math.max(
    1,
    Math.min(intent.maxPerContact ?? DEFAULT_MAX_PER_CONTACT, 1000),
  );

  const explicitStart = toDate(intent.windowStart);
  const explicitEnd = toDate(intent.windowEnd);
  let start: Date;
  let end: Date;

  if (explicitStart && explicitEnd) {
    start = explicitStart;
    end = explicitEnd > explicitStart ? explicitEnd : new Date(explicitStart.getTime() + 1000);
  } else if (explicitStart) {
    start = explicitStart;
    end = windowSeconds > 0
      ? new Date(start.getTime() + windowSeconds * 1000)
      : new Date(start.getTime() + 7 * 24 * 3600 * 1000);
  } else if (explicitEnd) {
    end = explicitEnd;
    start = windowSeconds > 0
      ? new Date(end.getTime() - windowSeconds * 1000)
      : new Date(end.getTime() - 7 * 24 * 3600 * 1000);
  } else if (windowSeconds > 0) {
    start = now;
    end = new Date(now.getTime() + windowSeconds * 1000);
  } else {
    start = now;
    end = new Date(now.getTime() + 7 * 24 * 3600 * 1000); // 默认 7 天窗口
  }

  const slots: MarketingScheduleSlot[] = [];
  const spanMs = end.getTime() - start.getTime();
  const stepMs = Math.max(1, Math.floor(spanMs / MAX_SCHEDULE_SLOTS));
  for (let t = start.getTime(); t <= end.getTime() && slots.length < MAX_SCHEDULE_SLOTS; t += stepMs) {
    slots.push({ at: new Date(t) });
  }

  return {
    channel,
    window: { start, end },
    windowSeconds: Math.round(spanMs / 1000),
    maxPerContact,
    slots,
  };
}

/**
 * 在给定时刻评估排程：
 * 1) 窗口内？
 * 2) 频控：窗口内既往投放次数 < maxPerContact？
 */
export function evaluateMarketingScheduleAt(
  input: MarketingScheduleEvaluationInput,
): MarketingScheduleEvaluation {
  const now = input.now ?? new Date();
  const { window, maxPerContact, windowSeconds } = input.intent;
  const withinWindow = now >= window.start && now <= window.end;
  if (!withinWindow) {
    return {
      eligible: false,
      reason: 'outside_window',
      withinWindow: false,
      recentDeliveries: 0,
      maxPerContact,
      windowSeconds,
      nextSlotAt: now < window.start ? window.start : null,
    };
  }

  const previous = (input.previousDeliveries ?? [])
    .map((d) => (d.at instanceof Date ? d.at : new Date(d.at)))
    .filter((at) => at >= window.start && at <= now);
  const recentDeliveries = previous.length;
  const frequencyCapped = recentDeliveries >= maxPerContact;

  if (frequencyCapped) {
    return {
      eligible: false,
      reason: 'frequency_capped',
      withinWindow: true,
      recentDeliveries,
      maxPerContact,
      windowSeconds,
      nextSlotAt: null,
    };
  }

  return {
    eligible: true,
    reason: 'ok',
    withinWindow: true,
    recentDeliveries,
    maxPerContact,
    windowSeconds,
    nextSlotAt: now,
  };
}
