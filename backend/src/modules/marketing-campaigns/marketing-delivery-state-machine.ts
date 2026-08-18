/**
 * marketing-delivery-state-machine.ts
 *
 * wesley-ai-crm 批次2：DeliveryRun 投放状态机（纯函数）。
 *
 * 状态流：PENDING → WAITING / AWAITING_APPROVAL / READY / CLAIMED / UNKNOWN
 *                → SUCCEEDED / FAILED / BLOCKED / DEAD_LETTER
 * 非终态可回 PENDING 重试；FAILED/BLOCKED 可重试或转入 DEAD_LETTER。
 */

import { MarketingDeliveryRunStatus } from '@prisma/client';

export type DeliveryRunState = MarketingDeliveryRunStatus;

export const TERMINAL_DELIVERY_STATES: ReadonlySet<DeliveryRunState> = new Set([
  MarketingDeliveryRunStatus.SUCCEEDED,
  MarketingDeliveryRunStatus.DEAD_LETTER,
]);

export const RETRYABLE_DELIVERY_STATES: ReadonlySet<DeliveryRunState> = new Set([
  MarketingDeliveryRunStatus.PENDING,
  MarketingDeliveryRunStatus.WAITING,
  MarketingDeliveryRunStatus.AWAITING_APPROVAL,
  MarketingDeliveryRunStatus.READY,
  MarketingDeliveryRunStatus.CLAIMED,
  MarketingDeliveryRunStatus.UNKNOWN,
  MarketingDeliveryRunStatus.FAILED,
  MarketingDeliveryRunStatus.BLOCKED,
]);

/** 允许的转移表（from → to[]） */
const TRANSITIONS: Record<DeliveryRunState, DeliveryRunState[]> = {
  PENDING: [
    MarketingDeliveryRunStatus.WAITING,
    MarketingDeliveryRunStatus.AWAITING_APPROVAL,
    MarketingDeliveryRunStatus.READY,
    MarketingDeliveryRunStatus.CLAIMED,
    MarketingDeliveryRunStatus.UNKNOWN,
    MarketingDeliveryRunStatus.SUCCEEDED,
    MarketingDeliveryRunStatus.FAILED,
    MarketingDeliveryRunStatus.BLOCKED,
    MarketingDeliveryRunStatus.DEAD_LETTER,
  ],
  WAITING: [
    MarketingDeliveryRunStatus.READY,
    MarketingDeliveryRunStatus.CLAIMED,
    MarketingDeliveryRunStatus.UNKNOWN,
    MarketingDeliveryRunStatus.PENDING,
    MarketingDeliveryRunStatus.FAILED,
    MarketingDeliveryRunStatus.BLOCKED,
    MarketingDeliveryRunStatus.DEAD_LETTER,
  ],
  AWAITING_APPROVAL: [
    MarketingDeliveryRunStatus.READY,
    MarketingDeliveryRunStatus.CLAIMED,
    MarketingDeliveryRunStatus.UNKNOWN,
    MarketingDeliveryRunStatus.PENDING,
    MarketingDeliveryRunStatus.FAILED,
    MarketingDeliveryRunStatus.BLOCKED,
    MarketingDeliveryRunStatus.DEAD_LETTER,
  ],
  READY: [
    MarketingDeliveryRunStatus.CLAIMED,
    MarketingDeliveryRunStatus.UNKNOWN,
    MarketingDeliveryRunStatus.SUCCEEDED,
    MarketingDeliveryRunStatus.FAILED,
    MarketingDeliveryRunStatus.BLOCKED,
    MarketingDeliveryRunStatus.DEAD_LETTER,
  ],
  CLAIMED: [
    MarketingDeliveryRunStatus.UNKNOWN,
    MarketingDeliveryRunStatus.SUCCEEDED,
    MarketingDeliveryRunStatus.FAILED,
    MarketingDeliveryRunStatus.BLOCKED,
    MarketingDeliveryRunStatus.DEAD_LETTER,
  ],
  UNKNOWN: [
    MarketingDeliveryRunStatus.SUCCEEDED,
    MarketingDeliveryRunStatus.FAILED,
    MarketingDeliveryRunStatus.BLOCKED,
    MarketingDeliveryRunStatus.DEAD_LETTER,
  ],
  SUCCEEDED: [],
  FAILED: [
    MarketingDeliveryRunStatus.PENDING,
    MarketingDeliveryRunStatus.DEAD_LETTER,
  ],
  BLOCKED: [
    MarketingDeliveryRunStatus.PENDING,
    MarketingDeliveryRunStatus.DEAD_LETTER,
  ],
  DEAD_LETTER: [],
};

export function canTransitionDeliveryRun(
  from: DeliveryRunState,
  to: DeliveryRunState,
): boolean {
  if (from === to) return true;
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function isTerminalDeliveryState(state: DeliveryRunState): boolean {
  return TERMINAL_DELIVERY_STATES.has(state);
}

export function isRetryableDeliveryState(state: DeliveryRunState): boolean {
  return RETRYABLE_DELIVERY_STATES.has(state);
}

export class InvalidDeliveryTransitionError extends Error {
  constructor(from: DeliveryRunState, to: DeliveryRunState) {
    super(`Invalid marketing delivery transition: ${from} -> ${to}`);
    this.name = 'InvalidDeliveryTransitionError';
  }
}

/**
 * 校验并返回转移后的状态；非法转移抛 InvalidDeliveryTransitionError。
 * 同状态转移视为幂等 no-op（返回原状态）。
 */
export function transitionDeliveryRunState(
  from: DeliveryRunState,
  to: DeliveryRunState,
): DeliveryRunState {
  if (!canTransitionDeliveryRun(from, to)) {
    throw new InvalidDeliveryTransitionError(from, to);
  }
  return to;
}
