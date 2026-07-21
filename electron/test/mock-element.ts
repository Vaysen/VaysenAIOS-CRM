/**
 * 测试用轻量 DOM 元素 Mock（与 wa-preload 选择器语义兼容）
 *
 * 仅实现 wa-logic.ts 依赖到的 DOM API：
 *   getAttribute / setAttribute / textContent
 *   classList.contains / querySelector / querySelectorAll / matches / closest
 *   appendChild / parent
 *
 * matches() 支持单复合选择器：
 *   tag、.class（多）、#id、[attr]、[attr="v"]、[attr*=v]、[attr^=v]、[attr$=v]
 * querySelector/All 支持逗号分隔的多选择器（对子节点递归匹配）。
 */
export class MockElement {
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
