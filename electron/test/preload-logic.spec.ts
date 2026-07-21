/**
 * wa-preload 纯逻辑行为测试（TASK-111）
 *
 * 针对从 wa-preload.ts 抽取到 wa-logic.ts 的纯函数做「真实行为」断言：
 *   - buildContactSnapshotFromElement：名称/号码识别（externalIdKind / phoneCandidate）
 *   - extractMessage：消息提取 + 去重（含溢出 FIFO 淘汰）
 *   - SelectorFailureTracker：多选择器失败计数与阈值告警
 *   - pickSendButton：注入/发送路径中「可点击元素」选择
 *
 * 注意：本文件不使用源码字符串断言（满足 TASK-111 验收第 6 项）。
 * 使用 test/mock-element.ts 的 MockElement 提供标准 DOM API 子集。
 */

import {
  buildContactSnapshotFromElement,
  extractMessage,
  SelectorFailureTracker,
  pickSendButton,
  sanitizeWhatsAppDisplayName,
  firstTrustedWhatsAppDisplayName,
  findTrustedWhatsAppJidInObject,
  findPhoneJidForWhatsAppIdentity,
  normalizePhoneLikeWhatsAppTitle,
  isUnavailableAiTranslation,
} from '@preload/wa-logic';

describe('isUnavailableAiTranslation', () => {
  it('拦截旧 AI provider、智谱未配置和 Unauthorized 失败文案', () => {
    expect(isUnavailableAiTranslation('[AI 翻译] 当前 AI 未启用。请配置 AI provider API key 后使用。')).toBe(true);
    expect(isUnavailableAiTranslation('[AI 翻译] 当前 AI 未启用。请配置智谱 API Key 后使用。')).toBe(true);
    expect(isUnavailableAiTranslation('Translation failed: Unauthorized')).toBe(true);
    expect(isUnavailableAiTranslation('Sorry, AI service is temporarily unavailable.')).toBe(true);
  });

  it('保留正常翻译，即使正文提到 AI 或 API', () => {
    expect(isUnavailableAiTranslation('客户希望通过 API 对接 AI 报价。')).toBe(false);
    expect(isUnavailableAiTranslation('感谢您的询价，我们会尽快回复。')).toBe(false);
  });
});

describe('normalizePhoneLikeWhatsAppTitle', () => {
  it('accepts a formatted international number shown as the chat title', () => {
    expect(normalizePhoneLikeWhatsAppTitle('+86 133 6592 3697')).toBe('8613365923697');
  });

  it('normalizes the international 00 prefix', () => {
    expect(normalizePhoneLikeWhatsAppTitle('00 39 388 981 5828')).toBe('393889815828');
  });

  it('rejects names, online status and dates', () => {
    expect(normalizePhoneLikeWhatsAppTitle('Sample Buyer')).toBeNull();
    expect(normalizePhoneLikeWhatsAppTitle('最后上线于2026年6月26日')).toBeNull();
    expect(normalizePhoneLikeWhatsAppTitle('2026-06-26 16:05')).toBeNull();
  });
});
import { MockElement } from '../test/mock-element';

describe('buildContactSnapshotFromElement — 名称/号码识别', () => {
  it('phone_jid：从 JID 提取纯号码', () => {
    const item = new MockElement('div');
    item.setAttribute('data-id', '8613800138000@c.us');
    const snap = buildContactSnapshotFromElement(item)!;
    expect(snap).not.toBeNull();
    expect(snap.externalId).toBe('8613800138000@c.us');
    expect(snap.externalIdKind).toBe('phone_jid');
    expect(snap.phoneCandidate).toBe('8613800138000');
    expect(snap.isGroup).toBe(false);
  });

  it('lid：@lid 识别为 lid 且不反推号码', () => {
    const item = new MockElement('div');
    item.setAttribute('data-id', '1234567890@lid');
    const snap = buildContactSnapshotFromElement(item)!;
    expect(snap.externalIdKind).toBe('lid');
    expect(snap.phoneCandidate).toBeNull();
  });

  it('group：@g.us 识别为群聊', () => {
    const item = new MockElement('div');
    item.setAttribute('data-id', '123456789012345@g.us');
    const snap = buildContactSnapshotFromElement(item)!;
    expect(snap.isGroup).toBe(true);
  });

  it('unknown：无法识别的 data-id 仍返回且 kind=unknown', () => {
    const item = new MockElement('div');
    item.setAttribute('data-id', 'some-random-id');
    const snap = buildContactSnapshotFromElement(item)!;
    expect(snap.externalId).toBe('some-random-id');
    expect(snap.externalIdKind).toBe('unknown');
  });

  it('无 data-id 元素返回 null', () => {
    const item = new MockElement('div');
    expect(buildContactSnapshotFromElement(item)).toBeNull();
  });

  it('从 title 提取显示名', () => {
    const item = new MockElement('div');
    item.setAttribute('data-id', '8613800138000@c.us');
    const nameEl = new MockElement('span');
    nameEl.setAttribute('dir', 'auto');
    nameEl.setAttribute('title', '张三');
    item.appendChild(nameEl);
    const snap = buildContactSnapshotFromElement(item)!;
    expect(snap.displayNameCandidate).toBe('张三');
  });

  it('系统状态文案（如「在线」）不视为联系人名', () => {
    const item = new MockElement('div');
    item.setAttribute('data-id', '8613800138000@c.us');
    const nameEl = new MockElement('span');
    nameEl.setAttribute('dir', 'auto');
    nameEl.setAttribute('title', '在线');
    item.appendChild(nameEl);
    const snap = buildContactSnapshotFromElement(item)!;
    expect(snap.displayNameCandidate).toBeNull();
  });

  it('带时间的中文最后上线状态不视为联系人名', () => {
    const item = new MockElement('div');
    item.setAttribute('data-id', '8613800138000@c.us');
    const nameEl = new MockElement('span');
    nameEl.setAttribute('dir', 'auto');
    nameEl.setAttribute('title', '最后上线于2026年6月26日06:05');
    item.appendChild(nameEl);
    expect(buildContactSnapshotFromElement(item)!.displayNameCandidate).toBeNull();
  });

  it('「给自己发消息」判定为 self', () => {
    const item = new MockElement('div');
    item.setAttribute('data-id', '8613800138000@c.us');
    const nameEl = new MockElement('span');
    nameEl.setAttribute('dir', 'auto');
    nameEl.setAttribute('title', '给自己发消息');
    item.appendChild(nameEl);
    const snap = buildContactSnapshotFromElement(item)!;
    expect(snap.isSelf).toBe(true);
  });
});

describe('findPhoneJidForWhatsAppIdentity — LID 与 phone JID 精确映射', () => {
  const tree = {
    return: {
      stateNode: {
        props: {
          active: {
            list: [
              { __x_id: { _serialized: '234977878868136@lid' }, __x_historyChatId: '12025550123@c.us' },
              { __x_id: { _serialized: '237323031720001@lid' }, __x_historyChatId: '639195009703@c.us' },
            ],
          },
        },
      },
    },
  };

  it('只返回与选中 LID 同一 record 的号码', () => {
    expect(findPhoneJidForWhatsAppIdentity(tree, '234977878868136@lid'))
      .toBe('12025550123@c.us');
  });

  it('不会把相邻聊天的号码当成当前客户', () => {
    expect(findPhoneJidForWhatsAppIdentity(tree, '999999999999@lid')).toBeNull();
  });

  it('非 LID 身份不进入映射', () => {
    expect(findPhoneJidForWhatsAppIdentity(tree, '12025550123@c.us')).toBeNull();
  });
});

describe('findTrustedWhatsAppJidInObject — 新版 WhatsApp 选中行身份提取', () => {
  it('从 React historyChatId 提取完整 phone JID', () => {
    const value = {
      // 大量无关分支模拟真实 React fiber，可信 return 路径必须优先遍历。
      child: Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`noise${index}`, { value: index }])),
      return: {
        stateNode: {
          props: { chat: { $ProxyState$state: { __x_historyChatId: '12025550123@c.us' } } },
        },
      },
    };
    expect(findTrustedWhatsAppJidInObject(value)).toBe('12025550123@c.us');
  });

  it('支持循环 React fiber 且不会无限遍历', () => {
    const value: Record<string, unknown> = { id: '120363123456789012@g.us' };
    value.return = value;
    expect(findTrustedWhatsAppJidInObject(value)).toBe('120363123456789012@g.us');
  });

  it.each([
    '3EB00206175404A854CF48',
    '最后上线于2026年6月26日06:05',
    '12025550123',
    'false_12025550123@c.us_message',
  ])('拒绝非完整可信 JID: %s', (value) => {
    expect(findTrustedWhatsAppJidInObject({ value })).toBeNull();
  });
});

describe('sanitizeWhatsAppDisplayName — fail-closed 状态文案过滤', () => {
  it.each([
    '最后上线于2026年6月26日06:05',
    '正在输入…',
    'last seen yesterday at 10:00',
    'typing...',
    '点击此处查看联系人信息',
  ])('拒绝 WhatsApp 状态文案: %s', (value) => {
    expect(sanitizeWhatsAppDisplayName(value)).toBeNull();
  });

  it('保留真实联系人名称', () => {
    expect(sanitizeWhatsAppDisplayName('  Sample Buyer  ')).toBe('Sample Buyer');
  });

  it('同一区域首个 span 为状态时继续寻找后续真实姓名', () => {
    expect(firstTrustedWhatsAppDisplayName([
      '最后上线于2026年6月26日06:05',
      'Sample Buyer',
    ])).toBe('Sample Buyer');
  });
});

describe('extractMessage — 消息提取 + 去重', () => {
  let store: Set<string>;
  beforeEach(() => { store = new Set<string>(); });

  function msgWithText(id: string, text: string): MockElement {
    const el = new MockElement('div');
    el.setAttribute('data-id', id);
    const span = new MockElement('span');
    span.setAttribute('class', 'selectable-text');
    span.setTextContent(text);
    el.appendChild(span);
    return el;
  }

  it('提取带 data-id 与文本的消息', () => {
    const msg = msgWithText('msg_001_false', '你好，报价多少？');
    const result = extractMessage(msg, store)!;
    expect(result).not.toBeNull();
    expect(result.id).toBe('msg_001_false');
    expect(result.text).toBe('你好，报价多少？');
    expect(result.type).toBe('text');
  });

  it('无 data-id 返回 null', () => {
    const el = new MockElement('div');
    expect(extractMessage(el, store)).toBeNull();
  });

  it('相同 data-id 第二次提取返回 null（去重）', () => {
    const a = msgWithText('dup_1', 'x');
    const b = msgWithText('dup_1', 'x');
    expect(extractMessage(a, store)).not.toBeNull();
    expect(extractMessage(b, store)).toBeNull();
  });

  it('message-out 类判定为发送消息', () => {
    const el = new MockElement('div');
    el.setAttribute('data-id', 'm1');
    el.classList.add('message-out');
    expect(extractMessage(el, store)!.isOutgoing).toBe(true);
  });

  it('message-in 判定为接收消息', () => {
    const el = new MockElement('div');
    el.setAttribute('data-id', 'm1');
    el.classList.add('message-in');
    expect(extractMessage(el, store)!.isOutgoing).toBe(false);
  });

  it('data-id 含 _true_ 判定为发送消息', () => {
    const el = new MockElement('div');
    el.setAttribute('data-id', '5511999999999@c.us_true_3EB0A1B2C3');
    expect(extractMessage(el, store)!.isOutgoing).toBe(true);
  });

  it('img[src*=blob] 检测为 image 类型', () => {
    const el = new MockElement('div');
    el.setAttribute('data-id', 'm_img');
    const img = new MockElement('img');
    img.setAttribute('src', 'blob:https://web.whatsapp.com/x');
    el.appendChild(img);
    expect(extractMessage(el, store)!.type).toBe('image');
  });

  it('audio 元素检测为 audio 类型', () => {
    const el = new MockElement('div');
    el.setAttribute('data-id', 'm_aud');
    el.appendChild(new MockElement('audio'));
    expect(extractMessage(el, store)!.type).toBe('audio');
  });

  it('[data-testid*=document] 检测为 file 类型', () => {
    const el = new MockElement('div');
    el.setAttribute('data-id', 'm_file');
    const f = new MockElement('div');
    f.setAttribute('data-testid', 'document-file');
    el.appendChild(f);
    expect(extractMessage(el, store)!.type).toBe('file');
  });

  it('去重集合达到上限后 FIFO 淘汰最早 ID', () => {
    // 用较小的上限验证溢出行为（不实际填充 5000）
    const smallStore = new Set<string>();
    const max = 2;
    extractMessage(msgWithText('a', '1'), smallStore, max);
    extractMessage(msgWithText('b', '2'), smallStore, max);
    expect(smallStore.size).toBe(2);
    expect(smallStore.has('a')).toBe(true);
    // 第三个插入，最早 'a' 被淘汰
    extractMessage(msgWithText('c', '3'), smallStore, max);
    expect(smallStore.size).toBe(2);
    expect(smallStore.has('a')).toBe(false);
    expect(smallStore.has('c')).toBe(true);
  });
});

describe('SelectorFailureTracker — 多选择器失败计数与阈值告警', () => {
  it('连续失败达到阈值时 record 返回 true', () => {
    const t = new SelectorFailureTracker(3);
    expect(t.record('inputBox')).toBe(false);
    expect(t.record('inputBox')).toBe(false);
    expect(t.record('inputBox')).toBe(true); // 第 3 次命中阈值
  });

  it('超过阈值后 record 不再返回 true', () => {
    const t = new SelectorFailureTracker(3);
    t.record('g'); t.record('g'); t.record('g');
    expect(t.record('g')).toBe(false);
  });

  it('一次成功命中重置该组计数', () => {
    const t = new SelectorFailureTracker(3);
    t.record('x'); t.record('x');
    t.reset('x');
    expect(t.record('x')).toBe(false); // 重置后从头计数
    expect(t.record('x')).toBe(false);
    expect(t.record('x')).toBe(true);
  });

  it('不同组计数相互独立', () => {
    const t = new SelectorFailureTracker(3);
    t.record('a'); t.record('a');
    expect(t.get('b')).toBe(0);
    expect(t.get('a')).toBe(2);
  });
});

describe('pickSendButton — 注入/发送路径的可点击元素选择', () => {
  it('输入元素为 null 时返回 null', () => {
    expect(pickSendButton(null)).toBeNull();
  });

  it('选择 button 祖先作为可点击元素', () => {
    const span = new MockElement('span');
    span.setAttribute('data-icon', 'send');
    const btn = new MockElement('button');
    btn.appendChild(span);
    const pick = pickSendButton(span);
    expect(pick).not.toBeNull();
    expect(pick).toBe(btn); // 返回的是可点击的 button 祖先
  });

  it('元素本身是 button 时返回自身', () => {
    const btn = new MockElement('button');
    const pick = pickSendButton(btn);
    expect(pick).toBe(btn);
  });
});

/**
 * TASK-111 v1.1 红线 4 复审后：inject + send 行为测试
 *
 * 闸门语义：单次 in-flight（不按 chatId 隔离，删除 v1.1 阶段 A 的永久锁定 bug）。
 * 必须覆盖（按你红线 4 复审要求）：
 *   - 同一请求在延时期间重复触发 → 只点击一次
 *   - 第一条成功后，同一聊天第二条新消息可以正常发送（这是 v1.1 阶段 A 的 bug）
 *   - 注入失败后下一次可以重试
 *   - click 失败后下一次可以重试
 *   - setTimeout 回调抛异常后不会永久锁死（finally release）
 *   - 延时等待期间闸门保持锁定（不能"调度后立即释放"）
 */
import { createInFlightSendGate, runInjectAndSend, InjectAndSendClock } from '@preload/wa-logic';

function makeClock(): { clock: InjectAndSendClock; advance: (ms: number) => void; now: () => number } {
  const pending: Array<{ cb: () => void; dueAt: number }> = [];
  let now = 0;
  const clock: InjectAndSendClock = {
    setTimeout: (cb, ms) => {
      const h = { cb, dueAt: now + ms };
      pending.push(h);
      return h;
    },
    clearTimeout: (h: any) => {
      const i = pending.indexOf(h);
      if (i !== -1) pending.splice(i, 1);
    },
  };
  const advance = (ms: number) => {
    now += ms;
    for (let i = 0; i < pending.length; i++) {
      const h = pending[i];
      if (h.dueAt <= now) {
        pending.splice(i, 1);
        i--;
        h.cb();
      }
    }
  };
  return { clock, advance, now: () => now };
}

describe('createInFlightSendGate — 状态机', () => {
  it('初始 IDLE，canAccept=true', () => {
    const g = createInFlightSendGate();
    expect(g.state).toBe('IDLE');
    expect(g.canAccept()).toBe(true);
  });

  it('IDLE → INJECTING（enterInjecting 返回 true）', () => {
    const g = createInFlightSendGate();
    expect(g.enterInjecting()).toBe(true);
    expect(g.state).toBe('INJECTING');
    expect(g.canAccept()).toBe(false);
  });

  it('INJECTING 时 enterInjecting 返回 false', () => {
    const g = createInFlightSendGate();
    g.enterInjecting();
    expect(g.enterInjecting()).toBe(false);
    expect(g.state).toBe('INJECTING');
  });

  it('IDLE → FAILED → enterInjecting 返回 true（允许重试）', () => {
    const g = createInFlightSendGate();
    g.markFailed();
    expect(g.state).toBe('FAILED');
    expect(g.canAccept()).toBe(true);
    expect(g.enterInjecting()).toBe(true);
  });

  it('release 回到 IDLE', () => {
    const g = createInFlightSendGate();
    g.enterInjecting();
    g.enterClicking();
    g.release();
    expect(g.state).toBe('IDLE');
    expect(g.canAccept()).toBe(true);
  });
});

describe('runInjectAndSend — 单次 in-flight 闸门（v1.1 红线 4）', () => {
  it('注入失败 → 立即 markFailed，下次可重试', () => {
    const gate = createInFlightSendGate();
    const { clock, advance } = makeClock();
    const click = jest.fn(() => true);
    const results: any[] = [];
    const r = runInjectAndSend('hello', { gate, clock, inject: () => false, click, onResult: (x) => results.push(x) });
    expect(r.reason).toBe('inject-failed');
    expect(click).not.toHaveBeenCalled();
    expect(gate.state).toBe('FAILED');
    expect(results).toEqual([{ sent: false, reason: 'inject-failed' }]);
    // 推进时间也不该触发 click
    advance(1000);
    expect(click).not.toHaveBeenCalled();
  });

  it('注入失败后下一次注入成功可以正常发送', () => {
    const gate = createInFlightSendGate();
    const { clock, advance } = makeClock();
    const click = jest.fn(() => true);
    // 第一次：注入失败
    runInjectAndSend('a', { gate, clock, inject: () => false, click, clickDelayMs: 100 });
    expect(gate.state).toBe('FAILED');
    // 第二次：注入成功
    runInjectAndSend('b', { gate, clock, inject: () => true, click, clickDelayMs: 100 });
    expect(gate.state).toBe('CLICKING');
    advance(100);
    expect(click).toHaveBeenCalledTimes(1);
    expect(gate.state).toBe('IDLE');
  });

  it('同一请求在延时期间重复触发 → 只点击一次', () => {
    const gate = createInFlightSendGate();
    const { clock, advance } = makeClock();
    const click = jest.fn(() => true);
    runInjectAndSend('msg', { gate, clock, inject: () => true, click, clickDelayMs: 400 });
    // 重复触发
    const r2 = runInjectAndSend('msg-2', { gate, clock, inject: () => true, click });
    expect(r2.reason).toBe('already-in-flight');
    advance(400);
    // click 只调用 1 次
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('第一条成功后，同一聊天第二条新消息可以正常发送（v1.1 阶段 A 的 bug 修复）', () => {
    const gate = createInFlightSendGate();
    const { clock, advance } = makeClock();
    const click = jest.fn(() => true);
    // 第一条消息
    runInjectAndSend('first', { gate, clock, inject: () => true, click, clickDelayMs: 100 });
    advance(100);
    expect(click).toHaveBeenCalledTimes(1);
    expect(gate.state).toBe('IDLE');
    // 同一 chatId 第二条消息
    runInjectAndSend('second', { gate, clock, inject: () => true, click, clickDelayMs: 100 });
    advance(100);
    expect(click).toHaveBeenCalledTimes(2);
    expect(gate.state).toBe('IDLE');
  });

  it('click 失败 → finally release 回到 IDLE（用户红线 4 明确：成功/失败都用 finally 释放）', () => {
    const gate = createInFlightSendGate();
    const { clock, advance } = makeClock();
    const click = jest.fn(() => false);
    runInjectAndSend('x', { gate, clock, inject: () => true, click, clickDelayMs: 50 });
    advance(50);
    expect(click).toHaveBeenCalledTimes(1);
    // 关键：click 失败后立刻 release 回 IDLE（与"成功"对称），下次可重试
    expect(gate.state).toBe('IDLE');
    expect(gate.canAccept()).toBe(true);
    // 重试
    runInjectAndSend('y', { gate, clock, inject: () => true, click, clickDelayMs: 50 });
    advance(50);
    expect(click).toHaveBeenCalledTimes(2);
  });

  it('setTimeout 回调抛异常后闸门 release（不永久锁死）', () => {
    const gate = createInFlightSendGate();
    const { clock, advance } = makeClock();
    const click = jest.fn(() => { throw new Error('click crashed'); });
    const results: any[] = [];
    runInjectAndSend('crash', { gate, clock, inject: () => true, click, clickDelayMs: 50, onResult: (x) => results.push(x) });
    // runInjectAndSend 内部 try/catch 捕获 click 抛出的异常，advance 不传播
    expect(() => advance(50)).not.toThrow();
    // 关键：闸门已 release（finally 路径）
    expect(gate.state).toBe('IDLE');
    expect(gate.canAccept()).toBe(true);
    // onResult 应收到 click-threw
    expect(results).toContainEqual({ sent: false, reason: 'click-threw' });
  });

  it('setTimeout 注册本身同步抛错时闸门也 release（v1.2b 红线 #7）', () => {
    const gate = createInFlightSendGate();
    // 自定义 clock：setTimeout 注册时同步抛错（模拟调度器异常 / 资源耗尽）
    const clock = {
      setTimeout: () => { throw new Error('scheduler down'); },
      clearTimeout: () => {},
    };
    const click = jest.fn(() => true);
    const results: any[] = [];
    const r = runInjectAndSend('schedfail', {
      gate,
      clock,
      inject: () => true,
      click,
      onResult: (x) => results.push(x),
    });
    // 关键：闸门已 enterClicking 但 setTimeout 抛错 → 必须 release 到 IDLE
    // 否则永久 CLICKING 锁死
    expect(r.reason).toBe('schedule-failed');
    expect(gate.state).toBe('IDLE');
    expect(gate.canAccept()).toBe(true);
    // click 不能被调用（setTimeout 没注册成功）
    expect(click).not.toHaveBeenCalled();
    // onResult 应收到 schedule-failed
    expect(results).toContainEqual({ sent: false, reason: 'schedule-failed' });
  });

  it('延时等待期间闸门保持锁定（不能"调度后立即释放"）', () => {
    const gate = createInFlightSendGate();
    const { clock, advance } = makeClock();
    const click = jest.fn(() => true);
    runInjectAndSend('lock', { gate, clock, inject: () => true, click, clickDelayMs: 1000 });
    // 刚调度，延时 1000ms
    advance(500);
    expect(gate.state).toBe('CLICKING');
    expect(gate.canAccept()).toBe(false);
    // 此时再来一次必须被拒
    const r = runInjectAndSend('another', { gate, clock, inject: () => true, click });
    expect(r.reason).toBe('already-in-flight');
  });
});
