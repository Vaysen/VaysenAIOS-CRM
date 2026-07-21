jest.mock('./baileys-loader', () => ({ loadBaileys: jest.fn() }));

import { EventEmitter } from 'events';
import {
  forwardBaileysMessageBatch,
  forwardBaileysMessageUpdates,
  describeProxyEndpoint,
  normalizeBaileysMessageStatus,
} from './whatsapp-adapter';

describe('WhatsAppAdapter proxy diagnostics', () => {
  it('redacts proxy credentials while retaining the endpoint', () => {
    expect(describeProxyEndpoint('socks5://user:secret@proxy.internal:1080'))
      .toBe('socks5://proxy.internal:1080');
  });

  it('does not echo malformed proxy input', () => {
    expect(describeProxyEndpoint('not a proxy secret-value')).toBe('invalid-proxy-url');
  });
});

describe('WhatsAppAdapter Baileys event forwarding', () => {
  it('forwards every usable batch item and preserves fromMe direction', () => {
    const emitter = new EventEmitter();
    const received: any[] = [];
    emitter.on('message', (event) => received.push(event));

    const count = forwardBaileysMessageBatch(emitter, 'session-1', {
      messages: [
        { key: { id: 'in-1', fromMe: false }, message: { conversation: 'one' } },
        { key: { id: 'out-1', fromMe: true }, message: { conversation: 'two' } },
        { key: { id: 'empty' }, message: null },
        { key: { id: 'in-2', fromMe: false }, message: { conversation: 'three' } },
      ],
    });

    expect(count).toBe(3);
    expect(received.map((event) => [event.msg.key.id, event.direction])).toEqual([
      ['in-1', 'inbound'],
      ['out-1', 'outbound'],
      ['in-2', 'inbound'],
    ]);
  });

  it.each([
    [0, 'failed'],
    [1, 'pending'],
    [2, 'sent'],
    [3, 'delivered'],
    [4, 'read'],
    [5, 'read'],
    [99, null],
  ])('maps Baileys status %s to %s', (input, expected) => {
    expect(normalizeBaileysMessageStatus(input)).toBe(expected);
  });

  it('forwards each valid message status and ignores unusable entries', () => {
    const emitter = new EventEmitter();
    const received: any[] = [];
    emitter.on('message-status', (event) => received.push(event));

    const count = forwardBaileysMessageUpdates(emitter, 'session-1', [
      { key: { id: 'm-1' }, update: { status: 2 } },
      { key: { id: 'm-2' }, update: { status: 3 } },
      { key: {}, update: { status: 4 } },
      { key: { id: 'm-3' }, update: { status: 99 } },
    ]);

    expect(count).toBe(2);
    expect(received).toEqual([
      { sessionId: 'session-1', messageId: 'm-1', status: 'sent' },
      { sessionId: 'session-1', messageId: 'm-2', status: 'delivered' },
    ]);
  });
});
