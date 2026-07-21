/**
 * wa-preload 纯逻辑模块（TASK-111 行为测试可测化）
 *
 * 从 wa-preload.ts 中抽取「不依赖 Electron 运行时、仅依赖标准 DOM API」
 * 的纯函数，便于用 jest + MockElement 做真实行为测试（而非源码字符串断言）：
 *   - buildContactSnapshotFromElement：名称/号码识别
 *   - extractMessage：消息提取 + 去重（去重集合参数化）
 *   - SelectorFailureTracker：多选择器 fallback 失败计数与阈值告警
 *   - pickSendButton：发送按钮的「可点击元素」选择（注入/发送逻辑）
 *
 * wa-preload.ts 改为引用本模块的这些实现，行为保持不变。
 * 本文件不 import 'electron'，可在 Node 测试环境中直接加载。
 */

import { WhatsAppContactSnapshot } from '../shared/whatsapp-contact-types';

/** 消息去重集合上限（与 wa-preload.ts 保持一致）。 */
export const MAX_DEDUP_SIZE = 5000;

/**
 * 纯逻辑依赖的最小 DOM 结构（鸭子类型）。
 * 真实浏览器 Element / 测试用 MockElement 都满足该结构，
 * 因此本模块不依赖完整 DOM lib 即可被 Node 测试环境加载。
 */
export interface DomElement {
  getAttribute(name: string): string | null;
  querySelector(selector: string): DomElement | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
  textContent: string | null;
  classList: { contains(name: string): boolean };
  closest(selector: string): DomElement | null;
}

// 已知 WhatsApp 系统/状态文案，出现在聊天列表标题时不视为真实联系人名。
const SYSTEM_TITLE_EXACT = new Set([
  '业务账户',
  '给自己发消息',
  '在线',
  'business account',
  'online',
  'unavailable',
  'messages',
]);

const SYSTEM_TITLE_PREFIXES = [
  '最后上线于',
  '点击此处查看联系人信息',
  '正在输入',
  'last seen',
  'click here to view',
  'typing',
] as const;

/**
 * 净化 WhatsApp UI 中的联系人显示名。
 *
 * WhatsApp 会把“最后上线于…”、“正在输入…”等状态与联系人名称放在相邻的
 * `span[title]` 中。选择器变化时宁可返回 null，也不能把状态文案写入 CRM。
 */
export function sanitizeWhatsAppDisplayName(input: string | null | undefined): string | null {
  const trimmed = (input ?? '').trim();
  if (!trimmed || trimmed.length >= 100) return null;

  const lower = trimmed.toLowerCase();
  if (SYSTEM_TITLE_EXACT.has(lower)) return null;
  if (SYSTEM_TITLE_PREFIXES.some((prefix) => lower.startsWith(prefix))) return null;

  return trimmed;
}

/** 从同一区域的多个 title 中取第一个可信姓名，跳过在它前面的状态 span。 */
export function firstTrustedWhatsAppDisplayName(
  inputs: readonly (string | null | undefined)[],
): string | null {
  for (const input of inputs) {
    const value = sanitizeWhatsAppDisplayName(input);
    if (value) return value;
  }
  return null;
}

/**
 * WhatsApp 未保存联系人时会直接把完整号码作为聊天标题显示。
 * 这类标题是当前会话本身提供的身份信息，可以作为 phone JID 缺失时的
 * 可信候选；但必须严格限制为“仅电话号码字符 + 7~15 位数字”，避免把
 * 在线状态、日期或普通昵称误写成客户号码。
 */
export function normalizePhoneLikeWhatsAppTitle(
  input: string | null | undefined,
): string | null {
  const value = (input ?? '').trim();
  if (!value || !/^[+\d\s().-]+$/.test(value)) return null;

  let digits = value.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (!/^\d{7,15}$/.test(digits)) return null;
  return digits;
}

const TRUSTED_WHATSAPP_JID = /^(\d{7,15}@(?:c\.us|s\.whatsapp\.net)|\d+@lid|\d{10,}@g\.us)$/;

/**
 * 在 WhatsApp 当前选中行的 React 状态中寻找可信 JID。
 *
 * 新版 WhatsApp Web 不再把 JID 放在列表行 data-id 上，但仍将
 * historyChatId 保存在选中行的 React props/fiber 中。遍历严格限制深度和
 * 节点数，并且只接受完整 WhatsApp JID，绝不把消息 id、状态文案或尾号
 * 当成客户身份。
 */
export function findTrustedWhatsAppJidInObject(
  root: unknown,
  maxDepth = 8,
  maxNodes = 1200,
): string | null {
  const seen = new WeakSet<object>();
  let visited = 0;

  const visit = (value: unknown, depth: number): string | null => {
    if (typeof value === 'string') {
      return TRUSTED_WHATSAPP_JID.test(value) ? value : null;
    }
    if (
      value === null ||
      (typeof value !== 'object' && typeof value !== 'function') ||
      depth > maxDepth ||
      visited >= maxNodes
    ) {
      return null;
    }

    const objectValue = value as object;
    if (seen.has(objectValue)) return null;
    seen.add(objectValue);
    visited += 1;

    let keys: string[];
    try {
      keys = Object.keys(objectValue).slice(0, 120);
    } catch {
      return null;
    }

    // WhatsApp 当前版本的明确字段优先，减少对 React 大对象的遍历。
    keys.sort((a, b) => {
      const score = (key: string) => {
        if (/historyChatId|chatId|jid|id$/i.test(key)) return 0;
        if (/^(return|stateNode|props|memoizedProps|pendingProps|chat|\$ProxyState\$state)$/i.test(key)) return 1;
        return 2;
      };
      return score(a) - score(b);
    });

    for (const key of keys) {
      let child: unknown;
      try {
        child = (objectValue as Record<string, unknown>)[key];
      } catch {
        continue;
      }
      const found = visit(child, depth + 1);
      if (found) return found;
    }
    return null;
  };

  return visit(root, 0);
}

/**
 * 把选中联系人 LID 映射到同一条 WhatsApp chat record 的 phone JID。
 * 只在 record.__x_id 与 selectedIdentity 完全相等时读取 historyChatId，
 * 防止从虚拟化聊天列表中误拿相邻客户号码。
 */
export function findPhoneJidForWhatsAppIdentity(
  root: unknown,
  selectedIdentity: string,
  maxDepth = 10,
  maxNodes = 2400,
): string | null {
  if (!/^\d+@lid$/.test(selectedIdentity)) return null;
  const seen = new WeakSet<object>();
  let visited = 0;

  const visit = (value: unknown, depth: number): string | null => {
    if (
      value === null ||
      (typeof value !== 'object' && typeof value !== 'function') ||
      depth > maxDepth ||
      visited >= maxNodes
    ) return null;

    const objectValue = value as Record<string, unknown>;
    if (seen.has(objectValue)) return null;
    seen.add(objectValue);
    visited += 1;

    const idObject = (objectValue.__x_id || objectValue.id) as Record<string, unknown> | undefined;
    const recordIdentity = typeof idObject?._serialized === 'string'
      ? idObject._serialized
      : typeof objectValue.__x_id === 'string'
        ? objectValue.__x_id
        : null;
    if (recordIdentity === selectedIdentity) {
      const historyChatId = objectValue.__x_historyChatId;
      if (typeof historyChatId === 'string' && /^\d{7,15}@(c\.us|s\.whatsapp\.net)$/.test(historyChatId)) {
        return historyChatId;
      }
    }

    let keys: string[];
    try {
      keys = Object.keys(objectValue).slice(0, 160);
    } catch {
      return null;
    }
    keys.sort((a, b) => {
      const score = (key: string) => {
        if (/^(active|list|return|stateNode|props|memoizedProps|pendingProps)$/i.test(key)) return 0;
        if (/^(children|child)$/i.test(key)) return 1;
        return 2;
      };
      return score(a) - score(b);
    });
    for (const key of keys) {
      let child: unknown;
      try { child = objectValue[key]; } catch { continue; }
      const found = visit(child, depth + 1);
      if (found) return found;
    }
    return null;
  };

  return visit(root, 0);
}

// WhatsApp Web "给自己发消息" 聊天的本地化标题，仅用于判定 self。
const SELF_CHAT_TITLES = new Set([
  '给自己发消息',
  'message yourself',
]);

export interface ExtractedMessage {
  id: string;
  text: string;
  isOutgoing: boolean;
  type: string;
  timestamp: string;
}

/**
 * 多选择器 fallback 失败计数器。
 * 连续失败达到阈值时 record() 返回 true（触发告警）。
 * 任意一次成功命中即重置该组计数。
 */
export class SelectorFailureTracker {
  private counts: Record<string, number> = {};

  constructor(private threshold: number) {}

  /** 记录一次失败，返回是否刚达到阈值。 */
  record(groupKey: string): boolean {
    this.counts[groupKey] = (this.counts[groupKey] || 0) + 1;
    return this.counts[groupKey] === this.threshold;
  }

  /** 记录一次成功命中，重置该组计数。 */
  reset(groupKey: string): void {
    this.counts[groupKey] = 0;
  }

  /** 读取某组当前连续失败次数。 */
  get(groupKey: string): number {
    return this.counts[groupKey] || 0;
  }
}

/**
 * 从聊天列表/活跃聊天 DOM 元素构建可信联系人快照。
 * 仅从 data-id 的 JID/LID 提取可信信息，不从 UI 文本猜号码。
 */
export function buildContactSnapshotFromElement(item: DomElement): WhatsAppContactSnapshot | null {
  const dataId = item.getAttribute('data-id') || '';
  if (!dataId) return null;

  const jidMatch = dataId.match(
    /(\d{7,15}@(?:c\.us|s\.whatsapp\.net)|\d+@lid|\d{10,}@g\.us)/,
  );
  const externalId = jidMatch ? jidMatch[1] : dataId;

  let externalIdKind: WhatsAppContactSnapshot['externalIdKind'] = 'unknown';
  let phoneCandidate: string | null = null;
  let isGroup = false;

  if (externalId.includes('@g.us')) {
    isGroup = true;
    externalIdKind = 'unknown';
  } else if (externalId.endsWith('@lid')) {
    externalIdKind = 'lid';
  } else {
    const phoneMatch = externalId.match(/^(\d{7,15})@(?:c\.us|s\.whatsapp\.net)$/);
    if (phoneMatch) {
      externalIdKind = 'phone_jid';
      phoneCandidate = phoneMatch[1];
    }
  }

  let displayNameCandidate: string | null = null;
  const nameEls = Array.from(item.querySelectorAll('span[dir="auto"][title]'));
  const titles = nameEls.map((nameEl) => (
    nameEl.getAttribute('title') || nameEl.textContent
  ));
  const title = titles[0] || '';
  displayNameCandidate = firstTrustedWhatsAppDisplayName(titles);

  const isSelf = titles.some((candidate) => SELF_CHAT_TITLES.has((candidate ?? '').trim().toLowerCase()));

  return {
    externalId,
    externalIdKind,
    phoneCandidate,
    displayNameCandidate,
    isGroup,
    isSelf,
    observedAt: Date.now(),
  };
}

/**
 * 从消息 DOM 元素提取结构化消息（含去重）。
 * @param el 消息元素
 * @param processedMessageIds 去重集合（由调用方持有，便于测试注入）
 * @param maxDedup 去重集合上限，默认 MAX_DEDUP_SIZE
 */
export function extractMessage(
  el: DomElement,
  processedMessageIds: Set<string>,
  maxDedup: number = MAX_DEDUP_SIZE,
): ExtractedMessage | null {
  const dataId = el.getAttribute('data-id') || el.closest('[data-id]')?.getAttribute('data-id');
  if (!dataId) return null;
  if (processedMessageIds.has(dataId)) return null;
  processedMessageIds.add(dataId);
  if (processedMessageIds.size > maxDedup) {
    const first = processedMessageIds.values().next().value;
    if (first) processedMessageIds.delete(first);
  }

  let text = '';
  const textEl = el.querySelector('.selectable-text span, .copyable-text span, span.selectable-text') || el;
  if (textEl) text = textEl.textContent?.trim() || '';

  const isOutgoing = el.classList.contains('message-out') ||
    el.closest('.message-out') !== null ||
    dataId.includes('_true_') ||
    (dataId.split('_').pop() === 'true');

  let type: string = 'text';
  if (el.querySelector('img[src*="blob"]')) type = 'image';
  else if (el.querySelector('audio')) type = 'audio';
  else if (el.querySelector('video')) type = 'video';
  else if (el.querySelector('[data-testid*="document"]')) type = 'file';

  return {
    id: dataId,
    text,
    isOutgoing,
    type,
    timestamp: new Date().toISOString(),
  };
}

/**
 * 选择「可点击的发送按钮」：优先返回 button 祖先，
 * 否则返回元素本身。供 clickSend 在真实 DOM 中调用。
 */
export function pickSendButton(sendEl: DomElement | null): DomElement | null {
  if (!sendEl) return null;
  return sendEl.closest('button') || sendEl;
}

/**
 * AI 失败/未配置提示不能伪装成翻译结果注入 WhatsApp 消息气泡。
 * 真实翻译可以包含普通的 “API” 或 “AI” 字样；这里只拦截系统已知的
 * fail-closed 文案与鉴权失败文案。
 */
export function isUnavailableAiTranslation(value: string): boolean {
  const text = value.trim();
  if (!text) return true;
  return (
    /^\[AI\s*翻译\]/i.test(text) ||
    /当前\s*AI\s*未启用|AI\s*service\s*is\s*temporarily\s*unavailable/i.test(text) ||
    /请配置.*API\s*Key|Translation\s*failed:\s*Unauthorized/i.test(text)
  );
}

/**
 * 「单次 in-flight」闸门（TASK-111 v1.1 红线 4 复审后 — 修正 SENT 永久锁定 bug）
 *
 * 历史问题（v1.1 阶段 A）：闸门按 chatId 永久保存 SENT 状态，第二个 WA_INJECT_TEXT
 * 事件被错误拦截；WA_CURRENT_CHAT 实际生产 payload 不含 chatId，重置分支永远不执行。
 *
 * 修正：闸门不按 chatId 隔离；同一时刻**最多一个** in-flight 发送任务。
 * 状态机：
 *   - IDLE      ：可接受新请求
 *   - INJECTING ：已注入但还没点击；重复事件被拒绝
 *   - CLICKING  ：已派发延时 click（setTimeout 已注册但还没触发）；重复事件被拒绝
 *   - FAILED    ：最近一次失败；下一次允许重试
 *
 * 锁定**必须保持到延时 click 完成**：
 *   - 注入失败 → 立即释放（markFailed），下次可重试
 *   - 延时等待期间 → 保持锁定（重复事件被拒绝）
 *   - click 成功或失败 → finally 释放（markSent 或 markFailed），下次可发
 *   - setTimeout 回调抛异常 → finally 释放（永不永久锁死）
 *   - **不能在 setTimeout 刚注册后立即释放**（必须等 click 完成）
 */
export type InFlightSendState = 'IDLE' | 'INJECTING' | 'CLICKING' | 'FAILED';

export interface InFlightSendGate {
  state: InFlightSendState;
  /** 是否可接受新一次 in-flight 请求（仅 IDLE/FAILED 接受） */
  canAccept(): boolean;
  /** 进入 INJECTING（仅当可接受） */
  enterInjecting(): boolean;
  /** 进入 CLICKING（click 已派发，等待延时） */
  enterClicking(): void;
  /** 释放到 IDLE（click 成功/失败后用，finally 必调） */
  release(): void;
  /** 标记 FAILED（注入失败或 click 失败；后续可重试） */
  markFailed(): void;
}

export function createInFlightSendGate(): InFlightSendGate {
  let state: InFlightSendState = 'IDLE';
  return {
    get state() {
      return state;
    },
    canAccept() {
      return state === 'IDLE' || state === 'FAILED';
    },
    enterInjecting() {
      if (state !== 'IDLE' && state !== 'FAILED') return false;
      state = 'INJECTING';
      return true;
    },
    enterClicking() {
      // 必须在 INJECTING 之后；不在 CLICKING 时设
      if (state === 'INJECTING') state = 'CLICKING';
    },
    release() {
      // finally 用：无论成功失败都回到 IDLE
      state = 'IDLE';
    },
    markFailed() {
      state = 'FAILED';
    },
  };
}

/**
 * 注入 + 发送调度（TASK-111 v1.1 红线 7）
 *
 * 抽象出 inject→delay→click 三段流水，便于 jest 在 Node 环境下不依赖真实 DOM：
 *   - inject(text)        : 注入文本到编辑区；返回 boolean（是否进入 INJECTING）
 *   - onInjected          : 注入成功后调度 clickSend 之前的回调（可空）
 *   - clickDelayMs        : 注入后到 click 的延迟（默认 400ms，与原实现一致）
 *   - click()             : 真实点击发送按钮（被测逻辑）
 *   - clock.setTimeout    : 测试时可注入虚拟时钟；生产直接用 setTimeout
 *   - onResult            : 发送结束后回调，参数 = { sent: boolean, reason?: string }
 *
 * 关键不变量：
 *   - 进入 SENT 后再调用本函数，click() 不应再被调用（一次性闸门）
 *   - 注入失败（inject=false）→ 不调度 click，直接回调 { sent: false, reason: 'inject-failed' }
 *   - click 失败 → 回调 { sent: false, reason: 'click-failed' }，但闸门进入 FAILED 允许重试
 */
export interface InjectAndSendClock {
  setTimeout: (cb: () => void, ms: number) => any;
  clearTimeout: (handle: any) => void;
}

export interface InjectAndSendDeps {
  gate: InFlightSendGate;
  clock: InjectAndSendClock;
  inject: (text: string) => boolean;
  click: () => boolean;
  onInjected?: () => void;
  onResult?: (result: { sent: boolean; reason?: string }) => void;
  clickDelayMs?: number;
}

/**
 * 单次 in-flight 注入+延时 click 编排（v1.1 红线 4 复审后）
 *
 * 锁语义（关键不变量）：
 *   - 已 INJECTING/CLICKING 时，重复事件被拒绝（'already-in-flight'）
 *   - 注入失败：markFailed 立即释放，下一次可重试
 *   - 延时期间：保持锁定（CLICKING），重复事件被拒绝
 *   - click 成功/失败：finally 用 release() 回到 IDLE
 *   - setTimeout 回调抛异常：finally 仍会 release，永不永久锁死
 *   - **禁止**在 setTimeout 注册后立即释放（必须等 click 完成）
 */
export function runInjectAndSend(
  text: string,
  deps: InjectAndSendDeps,
): { sent: boolean; reason?: string } {
  if (!deps.gate.canAccept()) {
    const r = { sent: false, reason: 'already-in-flight' };
    deps.onResult?.(r);
    return r;
  }
  if (!deps.gate.enterInjecting()) {
    // 二次防护（状态机竞态）
    const r = { sent: false, reason: 'already-in-flight' };
    deps.onResult?.(r);
    return r;
  }
  if (!deps.inject(text)) {
    deps.gate.markFailed();
    const r = { sent: false, reason: 'inject-failed' };
    deps.onResult?.(r);
    return r;
  }
  deps.onInjected?.();
  // v1.2b 复审红线 #7：把 `enterClicking()` + `setTimeout(...)` 整体包进 try/finally。
  //   - 若 `clock.setTimeout` 同步抛错（沙箱/调度器异常），闸门已 CLICKING 但不会 release
  //     → 永久锁死
  //   - 必须在 setTimeout 注册前/中抛错时**也** release（fail-closed）
  let timerHandle: any = null;
  try {
    deps.gate.enterClicking();
    const delay = deps.clickDelayMs ?? 400;
    timerHandle = deps.clock.setTimeout(() => {
      try {
        const ok = deps.click();
        if (ok) {
          deps.onResult?.({ sent: true });
        } else {
          deps.onResult?.({ sent: false, reason: 'click-failed' });
        }
      } catch (err) {
        // 关键：定时器抛异常也必须释放，防止永久锁死
        deps.onResult?.({ sent: false, reason: 'click-threw' });
      } finally {
        // 无论成功/失败/异常，都回到 IDLE（允许下一次发送）
        deps.gate.release();
      }
    }, delay);
  } catch (err) {
    // 关键：setTimeout 同步抛错（注册动作本身抛错）也必须 release
    // 闸门已经进入 CLICKING 但 setTimeout 没注册成功 → 立即释放
    try { if (timerHandle) deps.clock.clearTimeout(timerHandle); } catch { /* ignore */ }
    deps.onResult?.({ sent: false, reason: 'schedule-failed' });
    deps.gate.release();
    return { sent: false, reason: 'schedule-failed' };
  }
  return { sent: false, reason: 'pending-click' };
}
