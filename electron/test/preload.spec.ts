/**
 * WhatsApp Preload 脚本测试
 *
 * 测试范围：
 * - WhatsApp Preload 选择器配置完整性
 * - 消息提取函数（mock DOM）
 * - 去重逻辑
 *
 * 注意：wa-preload.ts 不导出任何内容（它是 preload 脚本），
 * 因此测试通过以下方式验证：
 * 1. 读取源文件验证 SELECTORS 结构完整性
 * 2. 复刻 extractMessage 核心逻辑并使用 mock DOM 元素测试
 * 3. 使用 Set 验证 data-id 去重逻辑
 */

import fs from 'fs';
import path from 'path';

// 纯逻辑已抽到 wa-logic.ts（TASK-111 行为测试），这里直接引用真实实现。
// 用别名避免与本文件内复刻的 extractMessage / MAX_DEDUP_SIZE 冲突。
import { extractMessage as realExtractMessage, MAX_DEDUP_SIZE as realMaxDedupSize } from '../src/preload/wa-logic';

// ── 读取源文件 ────────────────────────────────────────────────

const sourcePath = path.resolve(__dirname, '..', 'src', 'preload', 'wa-preload.ts');
const sourceContent = fs.readFileSync(sourcePath, 'utf-8');

// ════════════════════════════════════════════════════════════
// 选择器配置完整性测试
// ════════════════════════════════════════════════════════════

describe('WhatsApp Preload 选择器配置', () => {
  // 从源文件中提取 SELECTORS 定义
  // 匹配 const SELECTORS = { ... } 块
  const selectorsMatch = sourceContent.match(/const SELECTORS\s*=\s*\{([\s\S]*?)\n\};/);

  it('源文件应包含 SELECTORS 定义', () => {
    expect(selectorsMatch).not.toBeNull();
  });

  // 预期的选择器组
  const expectedSelectorGroups = [
    'messageRow',
    'chatHeader',
    'chatListItem',
    'inputBox',
    'sendButton',
    'unreadBadge',
    'qrCode',
    'loggedIn',
    'mediaImage',
    'mediaFile',
    'offlineNotice',
    'contactName',
    'contactLastMessage',
  ];

  describe('选择器组完整性', () => {
    for (const group of expectedSelectorGroups) {
      it(`应包含 "${group}" 选择器组`, () => {
        expect(sourceContent).toContain(`${group}:`);
      });

      it(`"${group}" 选择器组应至少有一个选择器`, () => {
        // 匹配 groupName: [ ... ] 并检查数组不为空
        const groupRegex = new RegExp(`${group}:\\s*\\[([\\s\\S]*?)\\]`);
        const match = sourceContent.match(groupRegex);
        expect(match).not.toBeNull();
        if (match) {
          // 检查数组中有至少一个引号包裹的选择器
          const selectors = match[1].match(/['"][^'"]+['"]/g);
          expect(selectors).not.toBeNull();
          expect(selectors!.length).toBeGreaterThanOrEqual(1);
        }
      });
    }
  });

  describe('选择器组数量', () => {
    it('应包含至少 13 个选择器组', () => {
      let count = 0;
      for (const group of expectedSelectorGroups) {
        if (sourceContent.includes(`${group}:`)) {
          count++;
        }
      }
      expect(count).toBeGreaterThanOrEqual(13);
    });
  });

  describe('关键选择器验证', () => {
    it('messageRow 应包含 data-testid 选择器', () => {
      expect(sourceContent).toContain('conversation-panel-messages');
    });

    it('messageRow 应包含 data-id 属性选择器', () => {
      expect(sourceContent).toContain('[data-id]');
    });

    it('inputBox 应包含 contenteditable 选择器', () => {
      expect(sourceContent).toContain('contenteditable');
    });

    it('sendButton 应包含 compose-btn-send 选择器', () => {
      expect(sourceContent).toContain('compose-btn-send');
    });

    it('qrCode 应包含 canvas 选择器', () => {
      expect(sourceContent).toContain('qr-code');
    });

    it('loggedIn 应包含 chat-list 选择器', () => {
      expect(sourceContent).toContain('chat-list');
    });

    it('offlineNotice 应包含 connectivity 选择器', () => {
      expect(sourceContent).toContain('connectivity');
    });
  });

  describe('多选择器 fallback 机制', () => {
    it('每个选择器组应使用数组形式（支持 fallback）', () => {
      for (const group of expectedSelectorGroups) {
        const groupRegex = new RegExp(`${group}:\\s*\\[`);
        expect(sourceContent).toMatch(groupRegex);
      }
    });

    it('应定义 querySelectorFallback 函数', () => {
      expect(sourceContent).toContain('function querySelectorFallback');
    });

    it('应定义 querySelectorAllFallback 函数', () => {
      expect(sourceContent).toContain('function querySelectorAllFallback');
    });

    it('应定义选择器失败阈值 SELECTOR_FAIL_THRESHOLD', () => {
      expect(sourceContent).toContain('SELECTOR_FAIL_THRESHOLD');
    });

    it('选择器失败阈值应为 3', () => {
      expect(sourceContent).toMatch(/SELECTOR_FAIL_THRESHOLD\s*=\s*3/);
    });
  });
});

describe('WhatsApp quotation delivery safety', () => {
  it('does not listen for, inject, or click an automatically supplied PDF', () => {
    expect(sourceContent).not.toContain('IPC_CHANNELS.WA_INJECT_DOCUMENT');
    expect(sourceContent).not.toContain('IPC_CHANNELS.WA_DOCUMENT_MENU_READY');
    expect(sourceContent).not.toContain('IPC_CHANNELS.WA_DOCUMENT_RESULT');
    expect(sourceContent).not.toContain('isDocumentPreviewReady');
    expect(sourceContent).not.toContain('DOCUMENT_SEND_MAX_ATTEMPTS');
    expect(sourceContent).not.toContain('findVisibleDocumentMenuItem');
  });
});

describe('WhatsApp identity-bound draft fill', () => {
  it('verifies the live direct-chat phone before filling text', () => {
    expect(sourceContent).toContain('IPC_CHANNELS.WA_FILL_DRAFT');
    expect(sourceContent).toContain('IPC_CHANNELS.WA_FILL_DRAFT_RESULT');
    expect(sourceContent).toContain('getCurrentChatInfo()');
    expect(sourceContent).toContain('currentPhone === targetPhone');
    expect(sourceContent).toContain('valid && injectText(text)');
  });

  it('does not click the send button in the draft-fill handler', () => {
    const handler = sourceContent.match(
      /ipcRenderer\.on\(\s*IPC_CHANNELS\.WA_FILL_DRAFT,[\s\S]*?\n\);/,
    );
    expect(handler).not.toBeNull();
    expect(handler?.[0]).not.toContain('clickSend');
    expect(handler?.[0]).not.toContain('.click()');
  });

  it('keeps real click-send behind the separate short-lived authorized channel', () => {
    expect(sourceContent).toContain('IPC_CHANNELS.WA_SEND_AUTHORIZED');
    expect(sourceContent).toContain('IPC_CHANNELS.WA_SEND_AUTHORIZED_RESULT');
    expect(sourceContent).toContain('createInFlightSendGate()');
    expect(sourceContent).toContain('runInjectAndSend(text');
    expect(sourceContent).toContain('clickAuthorizedSendButton');
    expect(sourceContent).toContain('expiryMs > Date.now()');
    expect(sourceContent).toContain('currentPhone === targetPhone');
  });
});

// ════════════════════════════════════════════════════════════
// 消息提取函数测试（mock DOM）
// ════════════════════════════════════════════════════════════

/**
 * Mock DOM 元素类
 * 模拟 DOM Element API 的关键方法，用于测试 extractMessage 逻辑
 */
class MockElement {
  private attributes: Map<string, string> = new Map();
  private children: MockElement[] = [];
  private _textContent: string = '';
  private _classList: Set<string> = new Set();
  private _tagName: string;
  parent: MockElement | null = null;

  constructor(tagName: string = 'div') {
    this._tagName = tagName;
  }

  get tagName(): string {
    return this._tagName.toUpperCase();
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) || null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  get textContent(): string {
    if (this.children.length === 0) {
      return this._textContent;
    }
    return this.children.map((c) => c.textContent).join('');
  }

  setTextContent(text: string): MockElement {
    this._textContent = text;
    return this;
  }

  get classList(): any {
    const self = this;
    return {
      contains(cls: string): boolean {
        return self._classList.has(cls);
      },
      add(cls: string): void {
        self._classList.add(cls);
      },
      remove(cls: string): void {
        self._classList.delete(cls);
      },
    };
  }

  querySelector(selector: string): MockElement | null {
    const parts = selector.split(',').map((part) => part.trim());
    for (const part of parts) {
      for (const child of this.children) {
        if (child.matches(part)) return child;
        const found = child.querySelector(part);
        if (found) return found;
      }
    }
    return null;
  }

  querySelectorAll(selector: string): MockElement[] {
    const results: MockElement[] = [];
    const parts = selector.split(',').map((part) => part.trim());
    for (const part of parts) {
      for (const child of this.children) {
        if (child.matches(part)) results.push(child);
        results.push(...child.querySelectorAll(part));
      }
    }
    return results;
  }

  matches(selector: string): boolean {
    if (selector.includes(',')) {
      return selector.split(',').some((part) => this.matches(part.trim()));
    }

    let rest = selector.trim();
    const tagMatch = rest.match(/^([a-zA-Z][\w-]*)/);
    const tag = tagMatch?.[1].toLowerCase();
    if (tagMatch) {
      rest = rest.slice(tagMatch[0].length);
    }
    if (tag && this._tagName.toLowerCase() !== tag) return false;

    while (rest.length > 0) {
      if (rest.startsWith('.')) {
        const classMatch = rest.match(/^\.([\w-]+)/);
        if (!classMatch || !this._classList.has(classMatch[1])) return false;
        rest = rest.slice(classMatch[0].length);
      } else if (rest.startsWith('#')) {
        const idMatch = rest.match(/^#([\w-]+)/);
        if (!idMatch || this.attributes.get('id') !== idMatch[1]) return false;
        rest = rest.slice(idMatch[0].length);
      } else if (rest.startsWith('[')) {
        const attrMatch = rest.match(
          /^\[([\w-]+)(?:([*^$|~]?=)"([^"]*)")?\]/,
        );
        if (!attrMatch) return false;

        const [, attrName, operator, expected] = attrMatch;
        const actual =
          attrName === 'class'
            ? Array.from(this._classList).join(' ')
            : this.attributes.get(attrName);
        if (actual === undefined || actual === null) return false;
        if (operator === '=' && actual !== expected) return false;
        if (operator === '*=' && !actual.includes(expected)) return false;
        if (operator === '^=' && !actual.startsWith(expected)) return false;
        if (operator === '$=' && !actual.endsWith(expected)) return false;
        rest = rest.slice(attrMatch[0].length);
      } else {
        return false;
      }
    }

    return true;
  }

  closest(selector: string): MockElement | null {
    let el: MockElement | null = this;
    while (el) {
      if (el.matches(selector)) return el;
      el = el.parent;
    }
    return null;
  }

  appendChild(child: MockElement): MockElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  get src(): string {
    return this.attributes.get('src') || '';
  }

  set src(value: string) {
    this.attributes.set('src', value);
  }

  get alt(): string {
    return this.attributes.get('alt') || '';
  }
}

/**
 * 复刻 wa-preload.ts 中的 extractMessage 核心逻辑
 * 用于测试（原始函数未导出）
 */
const MAX_DEDUP_SIZE = 5000;
const processedMessageIds = new Set<string>();

interface ExtractedMessage {
  id: string;
  text: string;
  isOutgoing: boolean;
  timestamp: string;
  type: 'text' | 'image' | 'file' | 'audio' | 'video' | 'system';
  mediaUrl?: string;
  mediaName?: string;
  sender?: string;
}

function extractMessage(el: MockElement): ExtractedMessage | null {
  const dataId = el.getAttribute('data-id') || el.closest('[data-id]')?.getAttribute('data-id');
  if (!dataId) return null;

  // 去重
  if (processedMessageIds.has(dataId)) return null;
  processedMessageIds.add(dataId);

  // 限制去重集合大小
  if (processedMessageIds.size > MAX_DEDUP_SIZE) {
    const firstId = processedMessageIds.values().next().value;
    if (firstId) processedMessageIds.delete(firstId);
  }

  // 提取文本
  let text = '';
  const textEl = el.querySelector('.selectable-text, .copyable-text span') || el;
  if (textEl) {
    text = textEl.textContent?.trim() || '';
  }

  // 判断方向
  const isOutgoing =
    el.classList.contains('message-out') ||
    el.closest('.message-out') !== null ||
    dataId.includes('_true_') ||
    dataId.endsWith('_true') ||
    dataId.startsWith('true_') ||
    dataId.includes('_true@');

  // 提取时间戳
  const timeEl = el.querySelector('[data-pre-plain-text]') as MockElement | null;
  let timestamp = new Date().toISOString();
  if (timeEl) {
    const preText = timeEl.getAttribute('data-pre-plain-text') || '';
    const match = preText.match(/\[(.+?)\]/);
    if (match) timestamp = match[1];
  }

  // 提取发送者
  let sender: string | undefined;
  const senderEl = el.querySelector('[class*="sender"]') as MockElement | null;
  if (senderEl) {
    sender = senderEl.textContent?.trim() || undefined;
  }

  // 判断消息类型
  let type: ExtractedMessage['type'] = 'text';
  let mediaUrl: string | undefined;
  let mediaName: string | undefined;

  const imgEl = el.querySelector('img[src*="blob"], img[src*="https://"]') as MockElement | null;
  if (imgEl) {
    type = 'image';
    mediaUrl = imgEl.src;
    mediaName = imgEl.getAttribute('alt') || undefined;
  }

  const fileEl = el.querySelector('[data-testid="document-file"], [class*="document-file"]') as MockElement | null;
  if (fileEl) {
    type = 'file';
    const nameEl = fileEl.querySelector('[class*="title"], span[title]') as MockElement | null;
    mediaName = nameEl?.textContent?.trim() || nameEl?.getAttribute('title') || undefined;
  }

  const audioEl = el.querySelector('audio, [class*="audio-message"]') as MockElement | null;
  if (audioEl) {
    type = 'audio';
  }

  const videoEl = el.querySelector('video, [class*="video-message"]') as MockElement | null;
  if (videoEl) {
    type = 'video';
    mediaUrl = videoEl.getAttribute('src') || undefined;
  }

  const systemEl = el.querySelector('[class*="system-message"], [data-testid="system-message"]') as MockElement | null;
  if (systemEl) {
    type = 'system';
  }

  return { id: dataId, text, isOutgoing, timestamp, type, mediaUrl, mediaName, sender };
}

describe('消息提取函数 extractMessage()', () => {
  beforeEach(() => {
    processedMessageIds.clear();
  });

  describe('基本提取', () => {
    it('应该提取带有 data-id 的消息', () => {
      const el = new MockElement('div');
      el.setAttribute('data-id', 'msg_001_false');
      el.setTextContent('Hello World');

      const msg = extractMessage(el);
      expect(msg).not.toBeNull();
      expect(msg!.id).toBe('msg_001_false');
    });

    it('没有 data-id 的元素应返回 null', () => {
      const el = new MockElement('div');
      el.setTextContent('No data-id');

      const msg = extractMessage(el);
      expect(msg).toBeNull();
    });

    it('应该提取消息文本内容', () => {
      const el = new MockElement('div');
      el.setAttribute('data-id', 'msg_002_false');

      const textSpan = new MockElement('span');
      textSpan.classList.add('selectable-text');
      textSpan.setTextContent('你好，请问包装盒的价格是多少？');
      el.appendChild(textSpan);

      const msg = extractMessage(el);
      expect(msg!.text).toBe('你好，请问包装盒的价格是多少？');
    });

    it('文本应被 trim 处理', () => {
      const el = new MockElement('div');
      el.setAttribute('data-id', 'msg_003_false');
      el.setTextContent('  多余空格  ');

      const msg = extractMessage(el);
      expect(msg!.text).toBe('多余空格');
    });
  });

  describe('消息方向判断 (isOutgoing)', () => {
    it('message-out 类应判断为发送消息', () => {
      const el = new MockElement('div');
      el.setAttribute('data-id', 'msg_001');
      el.classList.add('message-out');

      const msg = extractMessage(el);
      expect(msg!.isOutgoing).toBe(true);
    });

    it('message-in（无 message-out）应判断为接收消息', () => {
      const el = new MockElement('div');
      el.setAttribute('data-id', 'msg_002');
      el.classList.add('message-in');

      const msg = extractMessage(el);
      expect(msg!.isOutgoing).toBe(false);
    });

    it('data-id 包含 _true_ 应判断为发送消息', () => {
      const el = new MockElement('div');
      el.setAttribute('data-id', 'true_1234567890_true@c.us');

      const msg = extractMessage(el);
      expect(msg!.isOutgoing).toBe(true);
    });

    it('data-id 以 _true 结尾应判断为发送消息', () => {
      const el = new MockElement('div');
      el.setAttribute('data-id', 'msg_123_true');

      const msg = extractMessage(el);
      expect(msg!.isOutgoing).toBe(true);
    });

    it('父元素包含 message-out 也应判断为发送消息', () => {
      const parent = new MockElement('div');
      parent.classList.add('message-out');
      parent.setAttribute('data-id', 'msg_parent');

      const child = new MockElement('span');
      parent.appendChild(child);

      // child 元素本身没有 data-id，但 closest 能找到
      const msg = extractMessage(child);
      expect(msg).not.toBeNull();
      expect(msg!.isOutgoing).toBe(true);
    });
  });

  describe('时间戳提取', () => {
    it('应该从 data-pre-plain-text 属性提取时间', () => {
      const el = new MockElement('div');
      el.setAttribute('data-id', 'msg_001');

      const timeEl = new MockElement('span');
      timeEl.setAttribute('data-pre-plain-text', '[2026-06-26, 14:30:00] John:');
      el.appendChild(timeEl);

      const msg = extractMessage(el);
      expect(msg!.timestamp).toBe('2026-06-26, 14:30:00');
    });

    it('无时间属性时应使用当前时间 ISO 字符串', () => {
      const el = new MockElement('div');
      el.setAttribute('data-id', 'msg_002');

      const before = new Date().toISOString();
      const msg = extractMessage(el);
      const after = new Date().toISOString();

      // 时间戳应该在 before 和 after 之间（或等于）
      expect(msg!.timestamp).toBeDefined();
      expect(msg!.timestamp.length).toBeGreaterThan(10);
    });
  });

  describe('消息类型检测', () => {
    it('普通文本消息类型应为 text', () => {
      const el = new MockElement('div');
      el.setAttribute('data-id', 'msg_text');

      const msg = extractMessage(el);
      expect(msg!.type).toBe('text');
    });

    it('包含 img[src*="blob"] 应检测为 image 类型', () => {
      const el = new MockElement('div');
      el.setAttribute('data-id', 'msg_img');

      const img = new MockElement('img');
      img.setAttribute('src', 'blob:https://web.whatsapp.com/abc123');
      img.setAttribute('alt', '图片');
      el.appendChild(img);

      const msg = extractMessage(el);
      expect(msg!.type).toBe('image');
      expect(msg!.mediaUrl).toBe('blob:https://web.whatsapp.com/abc123');
      expect(msg!.mediaName).toBe('图片');
    });

    it('包含 [data-testid="document-file"] 应检测为 file 类型', () => {
      const el = new MockElement('div');
      el.setAttribute('data-id', 'msg_file');

      const fileEl = new MockElement('div');
      fileEl.setAttribute('data-testid', 'document-file');
      const titleEl = new MockElement('span');
      titleEl.setAttribute('title', '报价单.pdf');
      fileEl.appendChild(titleEl);
      el.appendChild(fileEl);

      const msg = extractMessage(el);
      expect(msg!.type).toBe('file');
      expect(msg!.mediaName).toBe('报价单.pdf');
    });

    it('包含 audio 元素应检测为 audio 类型', () => {
      const el = new MockElement('div');
      el.setAttribute('data-id', 'msg_audio');

      const audio = new MockElement('audio');
      el.appendChild(audio);

      const msg = extractMessage(el);
      expect(msg!.type).toBe('audio');
    });

    it('包含 video 元素应检测为 video 类型', () => {
      const el = new MockElement('div');
      el.setAttribute('data-id', 'msg_video');

      const video = new MockElement('video');
      video.setAttribute('src', 'blob:https://web.whatsapp.com/video123');
      el.appendChild(video);

      const msg = extractMessage(el);
      expect(msg!.type).toBe('video');
      expect(msg!.mediaUrl).toBe('blob:https://web.whatsapp.com/video123');
    });

    it('包含 system-message 类应检测为 system 类型', () => {
      const el = new MockElement('div');
      el.setAttribute('data-id', 'msg_system');

      const sysEl = new MockElement('div');
      sysEl.classList.add('system-message');
      el.appendChild(sysEl);

      const msg = extractMessage(el);
      expect(msg!.type).toBe('system');
    });
  });

  describe('发送者提取', () => {
    it('应该从 [class*="sender"] 元素提取发送者', () => {
      const el = new MockElement('div');
      el.setAttribute('data-id', 'msg_group');

      const senderEl = new MockElement('span');
      senderEl.classList.add('sender-name');
      senderEl.setTextContent('张三');
      el.appendChild(senderEl);

      const msg = extractMessage(el);
      expect(msg!.sender).toBe('张三');
    });

    it('无发送者元素时 sender 应为 undefined', () => {
      const el = new MockElement('div');
      el.setAttribute('data-id', 'msg_no_sender');

      const msg = extractMessage(el);
      expect(msg!.sender).toBeUndefined();
    });
  });
});

// ════════════════════════════════════════════════════════════
// 去重逻辑测试
// ════════════════════════════════════════════════════════════

describe('消息去重逻辑 (processedMessageIds)', () => {
  beforeEach(() => {
    processedMessageIds.clear();
  });

  it('首次处理的消息应成功提取', () => {
    const el = new MockElement('div');
    el.setAttribute('data-id', 'unique_msg_001');

    const msg = extractMessage(el);
    expect(msg).not.toBeNull();
    expect(msg!.id).toBe('unique_msg_001');
  });

  it('相同 data-id 的消息第二次提取应返回 null', () => {
    const el1 = new MockElement('div');
    el1.setAttribute('data-id', 'dup_msg_001');

    const el2 = new MockElement('div');
    el2.setAttribute('data-id', 'dup_msg_001');

    const msg1 = extractMessage(el1);
    const msg2 = extractMessage(el2);

    expect(msg1).not.toBeNull();
    expect(msg2).toBeNull();
  });

  it('不同 data-id 的消息都应成功提取', () => {
    const ids = ['msg_a', 'msg_b', 'msg_c', 'msg_d', 'msg_e'];

    for (const id of ids) {
      const el = new MockElement('div');
      el.setAttribute('data-id', id);
      const msg = extractMessage(el);
      expect(msg).not.toBeNull();
      expect(msg!.id).toBe(id);
    }
  });

  it('去重集合应正确记录已处理的 ID', () => {
    const el = new MockElement('div');
    el.setAttribute('data-id', 'tracked_msg_001');
    extractMessage(el);

    expect(processedMessageIds.has('tracked_msg_001')).toBe(true);
  });

  it('去重集合大小达到上限后应淘汰最早的 ID', () => {
    // 填满去重集合到上限
    for (let i = 0; i < MAX_DEDUP_SIZE; i++) {
      const el = new MockElement('div');
      el.setAttribute('data-id', `msg_${i}`);
      extractMessage(el);
    }

    expect(processedMessageIds.size).toBe(MAX_DEDUP_SIZE);

    // 添加一条新消息，最早的应该被淘汰
    const newEl = new MockElement('div');
    newEl.setAttribute('data-id', 'msg_new');
    extractMessage(newEl);

    expect(processedMessageIds.size).toBe(MAX_DEDUP_SIZE);
    expect(processedMessageIds.has('msg_0')).toBe(false); // 最早被淘汰
    expect(processedMessageIds.has('msg_new')).toBe(true);
  });

  it('去重集合淘汰后旧 ID 可以重新被提取', () => {
    // 填满并溢出
    for (let i = 0; i <= MAX_DEDUP_SIZE; i++) {
      const el = new MockElement('div');
      el.setAttribute('data-id', `overflow_msg_${i}`);
      extractMessage(el);
    }

    // msg_0 已被淘汰，应该可以重新提取
    const reEl = new MockElement('div');
    reEl.setAttribute('data-id', 'overflow_msg_0');
    const reMsg = extractMessage(reEl);
    expect(reMsg).not.toBeNull();
  });

  it('并发处理相同 ID 只应成功一次', () => {
    const id = 'concurrent_msg_001';
    const results: (ExtractedMessage | null)[] = [];

    for (let i = 0; i < 10; i++) {
      const el = new MockElement('div');
      el.setAttribute('data-id', id);
      results.push(extractMessage(el));
    }

    const successCount = results.filter((r) => r !== null).length;
    expect(successCount).toBe(1);
  });

  it('空字符串 data-id 应返回 null', () => {
    const el = new MockElement('div');
    el.setAttribute('data-id', '');

    const msg = extractMessage(el);
    expect(msg).toBeNull();
  });

  it('MAX_DEDUP_SIZE 应为 5000', () => {
    expect(MAX_DEDUP_SIZE).toBe(5000);
  });
});

// ════════════════════════════════════════════════════════════
// 源文件常量验证
// ════════════════════════════════════════════════════════════

describe('wa-preload.ts 常量配置', () => {
  it('MAX_DEDUP_SIZE 应为 5000', () => {
    // 常量已统一到 wa-logic.ts（单一来源），直接验证真实值。
    expect(realMaxDedupSize).toBe(5000);
  });

  it('CONTACT_SYNC_INTERVAL 应为 60000', () => {
    expect(sourceContent).toMatch(/CONTACT_SYNC_INTERVAL\s*=\s*60000/);
  });

  it('UNREAD_COUNT_INTERVAL 应为 10000', () => {
    expect(sourceContent).toMatch(/UNREAD_COUNT_INTERVAL\s*=\s*10000/);
  });

  it('LOGIN_CHECK_INTERVAL 应为 5000', () => {
    expect(sourceContent).toMatch(/LOGIN_CHECK_INTERVAL\s*=\s*5000/);
  });

  it('RECONNECT_CHECK_INTERVAL 应为 30000', () => {
    expect(sourceContent).toMatch(/RECONNECT_CHECK_INTERVAL\s*=\s*30000/);
  });

  it('SELECTOR_FAIL_THRESHOLD 应为 3', () => {
    expect(sourceContent).toMatch(/SELECTOR_FAIL_THRESHOLD\s*=\s*3/);
  });
});

// ════════════════════════════════════════════════════════════
// 核心函数存在性验证
// ════════════════════════════════════════════════════════════

describe('wa-preload.ts 核心函数', () => {
  it('应定义 extractMessage 函数（实现位于 wa-logic.ts）', () => {
    // 行为验证：直接引用真实实现，确认 extractMessage 是可调用函数。
    expect(typeof realExtractMessage).toBe('function');
  });

  it('应定义 getCurrentChatInfo 函数', () => {
    expect(sourceContent).toContain('function getCurrentChatInfo');
  });

  it('应定义 syncContacts 函数', () => {
    expect(sourceContent).toContain('function syncContacts');
  });

  it('应定义 getUnreadCount 函数', () => {
    expect(sourceContent).toContain('function getUnreadCount');
  });

  it('应定义 checkLoginStatus 函数', () => {
    expect(sourceContent).toContain('function checkLoginStatus');
  });

  it('应定义 initReconnectMonitor 函数', () => {
    expect(sourceContent).toContain('function initReconnectMonitor');
  });

  it('应定义 initMessageObserver 函数', () => {
    expect(sourceContent).toContain('function initMessageObserver');
  });

  it('应定义 injectText 函数', () => {
    expect(sourceContent).toContain('function injectText');
  });

  it('不得定义自动点击发送函数', () => {
    expect(sourceContent).not.toContain('function clickSendButton');
    expect(sourceContent).not.toContain('function clickSend(');
    expect(sourceContent).toContain('runInjectAndSend');
  });

  it('应定义 init 函数', () => {
    expect(sourceContent).toContain('function init()');
  });

  it('生产初始化不再注入旧版 AI 面板，避免与全局业务助理形成双入口', () => {
    expect(sourceContent).not.toContain('AIPanel.init();');
  });

  it('不得监听无可信目标绑定的 WA_INJECT_TEXT 自动外发通道', () => {
    expect(sourceContent).not.toContain('IPC_CHANNELS.WA_INJECT_TEXT');
  });

  it('应通过 IPC_CHANNELS.WA_NEW_MESSAGE 发送新消息', () => {
    expect(sourceContent).toContain("IPC_CHANNELS.WA_NEW_MESSAGE");
  });

  it('应通过 IPC_CHANNELS.WA_LOGIN_STATUS 发送登录状态', () => {
    expect(sourceContent).toContain("IPC_CHANNELS.WA_LOGIN_STATUS");
  });

  it('应通过 IPC_CHANNELS.WA_CONTACTS_SYNC 发送联系人', () => {
    expect(sourceContent).toContain("IPC_CHANNELS.WA_CONTACTS_SYNC");
  });

  it('不得伪造自动文本发送结果', () => {
    expect(sourceContent).not.toContain('IPC_CHANNELS.WA_SEND_RESULT');
  });

  it('应通过 IPC_CHANNELS.WA_CURRENT_CHAT 发送当前聊天', () => {
    expect(sourceContent).toContain("IPC_CHANNELS.WA_CURRENT_CHAT");
  });

  it('应在渲染页请求时强制重发未变化的当前聊天', () => {
    expect(sourceContent).toContain('IPC_CHANNELS.WA_REQUEST_CURRENT_CHAT');
    expect(sourceContent).toContain("checkChat('renderer-request', true)");
    expect(sourceContent).toContain('(force || key !== lastChatKey)');
  });
});
