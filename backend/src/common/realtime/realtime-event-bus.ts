import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter } from 'events';

/**
 * 全局实时事件总线
 * 用于在各模块间传递实时事件，由 SSE 端点推送给前端
 *
 * 事件类型：
 * - whatsapp.message    — WhatsApp 新消息
 * - conversation.update — 会话更新（新消息/状态变化）
 * - inquiry.new         — 新询价
 */
@Injectable()
export class RealtimeEventBus {
  private readonly logger = new Logger(RealtimeEventBus.name);
  private readonly emitter = new EventEmitter();

  constructor() {
    // 提高最大监听器数量，避免警告
    this.emitter.setMaxListeners(50);
  }

  /**
   * 发射事件
   */
  emit(event: string, payload: any): void {
    this.logger.debug(`Event emitted: ${event}`);
    this.emitter.emit(event, payload);
    // 同时发射通用的 conversation.update 事件
    if (event.startsWith('whatsapp.') || event.startsWith('inquiry.')) {
      this.emitter.emit('conversation.update', {
        ...payload,
        _eventType: event,
      });
    }
  }

  /**
   * 监听事件（SSE 端点使用）
   * 返回取消监听的函数
   */
  on(event: string, listener: (payload: any) => void): () => void {
    this.emitter.on(event, listener);
    return () => {
      this.emitter.off(event, listener);
    };
  }

  /**
   * 监听所有事件（SSE 端点使用）
   * 返回取消监听的函数
   */
  onAny(listener: (event: string, payload: any) => void): () => void {
    const wrappedListener = (payload: any) => {
      // EventEmitter 不直接支持 onAny，我们监听具体事件
    };

    const events = ['whatsapp.message', 'conversation.update', 'inquiry.new'];
    const cleanups = events.map((evt) => {
      const l = (payload: any) => listener(evt, payload);
      this.emitter.on(evt, l);
      return () => this.emitter.off(evt, l);
    });

    return () => cleanups.forEach((fn) => fn());
  }
}
