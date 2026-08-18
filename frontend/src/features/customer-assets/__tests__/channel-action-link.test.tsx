import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChannelActionLink } from '../components/channel-action-link';
import type { ContactPoint } from '../types';

function makeContactPoint(
  overrides: Partial<ContactPoint> = {},
): ContactPoint {
  return {
    id: 'cp-test',
    type: 'whatsapp',
    originalValue: '+8613800138000',
    normalizedValue: '+8613800138000',
    conversationId: null,
    isAvailable: true,
    ...overrides,
  };
}

describe('ChannelActionLink', () => {
  it('合法 E.164 号码生成 wa.me 链接', () => {
    const cp = makeContactPoint({
      type: 'whatsapp',
      normalizedValue: '+8613800138000',
      originalValue: '+8613800138000',
    });

    render(<ChannelActionLink contactPoint={cp} />);

    const link = screen.getByTestId('channel-link-whatsapp');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('https://wa.me/8613800138000');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('LID 号码不生成 wa.me 链接，显示为纯文本', () => {
    const cp = makeContactPoint({
      type: 'whatsapp',
      normalizedValue: '123456789@lid',
      originalValue: '123456789@lid',
      conversationId: null,
    });

    render(<ChannelActionLink contactPoint={cp} />);

    const plain = screen.getByTestId('channel-link-plain');
    expect(plain.tagName).toBe('DIV');
    expect(plain.textContent).toContain('123456789@lid');
  });

  it('非 E.164 号码（无+前缀）不生成 wa.me 链接', () => {
    const cp = makeContactPoint({
      type: 'whatsapp',
      normalizedValue: '13800138000',
      originalValue: '13800138000',
      conversationId: null,
    });

    render(<ChannelActionLink contactPoint={cp} />);

    const plain = screen.getByTestId('channel-link-plain');
    expect(plain.tagName).toBe('DIV');
  });

  it('有 conversationId 时优先内部会话链接', () => {
    const cp = makeContactPoint({
      type: 'whatsapp',
      conversationId: 'conv-001',
    });

    render(<ChannelActionLink contactPoint={cp} />);

    const internal = screen.getByTestId('channel-link-internal');
    expect(internal.tagName).toBe('A');
    expect(internal.getAttribute('href')).toContain('/whatsapp/chat');
    expect(internal.getAttribute('href')).toContain('conversationId=conv-001');
  });

  it('合法邮箱生成 mailto 链接', () => {
    const cp = makeContactPoint({
      type: 'email',
      normalizedValue: 'john@example.com',
      originalValue: 'john@example.com',
    });

    render(<ChannelActionLink contactPoint={cp} />);

    const link = screen.getByTestId('channel-link-email');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('mailto:john%40example.com');
  });

  it('非法邮箱不生成 mailto 链接', () => {
    const cp = makeContactPoint({
      type: 'email',
      normalizedValue: 'not-an-email',
      originalValue: 'not-an-email',
    });

    render(<ChannelActionLink contactPoint={cp} />);

    const plain = screen.getByTestId('channel-link-plain');
    expect(plain.tagName).toBe('DIV');
  });

  it('不可用渠道仅展示文本', () => {
    const cp = makeContactPoint({
      isAvailable: false,
    });

    render(<ChannelActionLink contactPoint={cp} />);

    const unavailable = screen.getByTestId('channel-link-unavailable');
    expect(unavailable.textContent).toContain('不可用');
  });

  it('电话类型也尝试 wa.me 链接', () => {
    const cp = makeContactPoint({
      type: 'phone',
      normalizedValue: '+12025551234',
      originalValue: '+12025551234',
    });

    render(<ChannelActionLink contactPoint={cp} />);

    const link = screen.getByTestId('channel-link-whatsapp');
    expect(link.getAttribute('href')).toBe('https://wa.me/12025551234');
  });

  it('不渲染危险 href（XSS 防护）', () => {
    const cp = makeContactPoint({
      type: 'whatsapp',
      normalizedValue: 'javascript:alert(1)',
      originalValue: 'javascript:alert(1)',
      conversationId: null,
    });

    render(<ChannelActionLink contactPoint={cp} />);

    // javascript: 协议不是合法 E.164，应显示为纯文本
    const plain = screen.getByTestId('channel-link-plain');
    expect(plain.tagName).toBe('DIV');
    // 确保没有 <a> 标签
    expect(screen.queryByRole('link')).toBeNull();
  });
});
