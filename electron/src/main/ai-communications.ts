/**
 * AI 通信模块
 * 在 Electron 主进程中处理 AI 请求，支持：
 * - AI 回复建议（英文）
 * - 实时中文→英文翻译
 * - 消息翻译
 * - 客户分析
 *
 * 所有请求通过 pushToBackend 发送到后端，自动附加 JWT token
 */

import axios from 'axios';
import { safeStorage } from 'electron';
import Store from 'electron-store';

interface AuthStore {
  token: string | null;
  refreshToken: string | null;
  companyId: string | null;
}

export class AICommunications {
  private authStore: Store<AuthStore>;
  private apiBaseUrl: string;

  constructor(apiBaseUrl: string) {
    this.apiBaseUrl = apiBaseUrl;
    this.authStore = new Store<AuthStore>({
      name: 'auth',
      defaults: { token: null, refreshToken: null, companyId: null },
      encryptionKey: 'vaysen-crm-desktop-auth-key',
    });
  }

  /**
   * 获取 AI 回复建议
   * GET /ai-communications/suggest-replies/:messageId
   */
  async suggestReplies(messageId: string, targetLanguage?: string): Promise<any> {
    return this.request('POST', `/ai-communications/suggest-replies/${messageId}`, {
      targetLanguage: targetLanguage || 'en',
    });
  }

  /**
   * 实时翻译草稿（中文→英文）
   * POST /ai-communications/translate-draft
   */
  async translateDraft(text: string, targetLanguage: string = 'en'): Promise<any> {
    return this.request('POST', '/ai-communications/translate-draft', {
      text,
      targetLanguage,
    });
  }

  /**
   * 翻译消息
   * POST /ai-communications/translate/:messageId
   */
  async translateMessage(messageId: string, targetLang: string = 'zh'): Promise<any> {
    return this.request('POST', `/ai-communications/translate/${messageId}`, {
      targetLang,
    });
  }

  /**
   * 生成客户分析
   * POST /ai-communications/customer-analysis/:leadId
   */
  async customerAnalysis(leadId: string): Promise<any> {
    return this.request('POST', `/ai-communications/customer-analysis/${leadId}`);
  }

  /**
   * AI 生成报价
   * POST /ai-communications/generate-quote/:conversationId
   */
  async generateQuote(conversationId: string, type: string = 'quote'): Promise<any> {
    return this.request('POST', `/ai-communications/generate-quote/${conversationId}`, { type });
  }

  /**
   * 提取报价字段
   * POST /ai-communications/extract-quote/:conversationId
   */
  async extractQuote(conversationId: string): Promise<any> {
    return this.request('POST', `/ai-communications/extract-quote/${conversationId}`);
  }

  /**
   * 统一请求方法
   */
  private async request(method: string, path: string, data?: any): Promise<any> {
    const token = this.getStoredToken();
    const companyId = this.authStore.get('companyId');

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    if (companyId) {
      headers['X-Company-Id'] = companyId;
    }

    try {
      const response = await axios({
        method,
        url: `${this.apiBaseUrl}${path}`,
        data,
        headers,
        timeout: 60000, // AI 请求可能较慢，60秒超时
      });
      return { success: true, data: response.data };
    } catch (error: any) {
      console.error(`[AI] 请求失败 ${path}:`, error.message);
      return {
        success: false,
        error: error.response?.data?.message || error.message,
        status: error.response?.status,
      };
    }
  }

  private getStoredToken(): string | null {
    const encrypted = this.authStore.get('token');
    if (!encrypted) return null;
    if (safeStorage.isEncryptionAvailable()) {
      try {
        return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
      } catch {
        return null;
      }
    }
    return encrypted;
  }
}
