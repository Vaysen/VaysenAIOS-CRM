/**
 * Evolution API Service
 * 负责调用 Evolution API REST 接口管理 WhatsApp 连接和消息收发
 * 替代原有的 Baileys 直连方案，解决群组消息 participant 提取等问题
 */
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  EnabledEvolutionConfig,
  isValidWebhookSecret,
  requireEvolutionConfig,
} from './evolution-api-policy';

export interface EvolutionInstance {
  instance: {
    instanceName: string;
    status: string;
  };
  hash?: string;
  qrcode?: {
    code: string;
    base64: string;
  };
}

@Injectable()
export class EvolutionApiService {
  private readonly logger = new Logger(EvolutionApiService.name);

  assertEnabled(): EnabledEvolutionConfig {
    try {
      return requireEvolutionConfig();
    } catch (error) {
      throw new ServiceUnavailableException(
        `Evolution API unavailable: ${error instanceof Error ? error.message : 'invalid configuration'}`,
      );
    }
  }

  assertWebhookAuthorized(providedSecret: unknown): EnabledEvolutionConfig {
    const config = this.assertEnabled();
    if (!isValidWebhookSecret(providedSecret, config.webhookSecret)) {
      throw new UnauthorizedException('Invalid Evolution webhook credential');
    }
    return config;
  }

  getWebhookUrl(): string {
    const config = this.assertEnabled();
    return `${config.backendUrl}/api/whatsapp/evolution-webhook`;
  }

  private getHeaders(config: EnabledEvolutionConfig) {
    return {
      'Content-Type': 'application/json',
      'apikey': config.apiKey,
    };
  }

  /**
   * 创建 WhatsApp 实例
   */
  async createInstance(instanceName: string, webhookUrl?: string): Promise<EvolutionInstance> {
    const config = this.assertEnabled();
    const body: any = {
      instanceName,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
    };

    if (webhookUrl) {
      body.webhook = {
        url: webhookUrl,
        byEvents: true,
        base64: false,
        headers: {
          'x-evolution-webhook-secret': config.webhookSecret,
        },
        events: [
          'qrcode.updated',
          'connection.update',
          'messages.upsert',
          'messages.update',
        ],
      };
    }

    const response = await fetch(`${config.apiUrl}/instance/create`, {
      method: 'POST',
      headers: this.getHeaders(config),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Evolution API createInstance failed: ${response.status} ${errorText}`);
    }

    return response.json();
  }

  /**
   * 连接实例（获取 QR 码或连接状态）
   */
  async connectInstance(instanceName: string): Promise<EvolutionInstance> {
    const config = this.assertEnabled();
    const response = await fetch(`${config.apiUrl}/instance/connect/${instanceName}`, {
      method: 'GET',
      headers: this.getHeaders(config),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Evolution API connectInstance failed: ${response.status} ${errorText}`);
    }

    return response.json();
  }

  /**
   * 获取实例状态
   */
  async getInstanceStatus(instanceName: string): Promise<any> {
    const config = this.assertEnabled();
    const response = await fetch(`${config.apiUrl}/instance/connectionState/${instanceName}`, {
      method: 'GET',
      headers: this.getHeaders(config),
    });

    if (!response.ok) {
      return { status: 'disconnected' };
    }

    return response.json();
  }

  /**
   * 列出所有实例
   */
  async listInstances(): Promise<any[]> {
    const config = this.assertEnabled();
    const response = await fetch(`${config.apiUrl}/instance/fetchInstances`, {
      method: 'GET',
      headers: this.getHeaders(config),
    });

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    return Array.isArray(data) ? data : [];
  }

  /**
   * 删除实例（断开连接）
   */
  async deleteInstance(instanceName: string): Promise<void> {
    const config = this.assertEnabled();
    const response = await fetch(`${config.apiUrl}/instance/delete/${instanceName}`, {
      method: 'DELETE',
      headers: this.getHeaders(config),
    });

    if (!response.ok) {
      this.logger.warn(`Delete instance ${instanceName} failed: ${response.status}`);
    }
  }

  /**
   * 注销（logout）
   */
  async logoutInstance(instanceName: string): Promise<void> {
    const config = this.assertEnabled();
    const response = await fetch(`${config.apiUrl}/instance/logout/${instanceName}`, {
      method: 'DELETE',
      headers: this.getHeaders(config),
    });

    if (!response.ok) {
      this.logger.warn(`Logout instance ${instanceName} failed: ${response.status}`);
    }
  }

  /**
   * 发送文本消息
   */
  async sendTextMessage(
    instanceName: string,
    number: string,
    text: string,
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const config = this.assertEnabled();
    try {
      const response = await fetch(`${config.apiUrl}/message/sendText/${instanceName}`, {
        method: 'POST',
        headers: this.getHeaders(config),
        body: JSON.stringify({
          number,
          text,
          delay: 0,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return { success: false, error: `${response.status}: ${errorText}` };
      }

      const data = await response.json();
      return {
        success: true,
        messageId: data?.key?.id || undefined,
      };
    } catch (err: any) {
      this.logger.error(`sendTextMessage failed: ${err?.message}`);
      return { success: false, error: err?.message };
    }
  }

  /**
   * 发送媒体消息（图片/文档/视频/音频）
   */
  async sendMediaMessage(
    instanceName: string,
    number: string,
    options: {
      type: 'image' | 'document' | 'video' | 'audio';
      url?: string;
      filename?: string;
      caption?: string;
      mimeType?: string;
    },
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const config = this.assertEnabled();
    try {
      const endpoint = options.type === 'image'
        ? 'sendMedia'
        : options.type === 'document'
          ? 'sendDocument'
          : options.type === 'video'
            ? 'sendVideo'
            : 'sendAudio';

      const body: any = {
        number,
        delay: 0,
      };

      if (options.type === 'image') {
        body.media = options.url;
        body.caption = options.caption || '';
      } else if (options.type === 'document') {
        body.document = options.url;
        body.fileName = options.filename || 'file';
      } else if (options.type === 'video') {
        body.video = options.url;
        body.caption = options.caption || '';
      } else if (options.type === 'audio') {
        body.audio = options.url;
      }

      const response = await fetch(`${config.apiUrl}/message/${endpoint}/${instanceName}`, {
        method: 'POST',
        headers: this.getHeaders(config),
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return { success: false, error: `${response.status}: ${errorText}` };
      }

      const data = await response.json();
      return {
        success: true,
        messageId: data?.key?.id || undefined,
      };
    } catch (err: any) {
      this.logger.error(`sendMediaMessage failed: ${err?.message}`);
      return { success: false, error: err?.message };
    }
  }

  /**
   * 获取群组元数据（群名）
   */
  async getGroupMetadata(instanceName: string, groupJid: string): Promise<any> {
    const config = this.assertEnabled();
    try {
      const response = await fetch(`${config.apiUrl}/group/fetchGroupInfo/${instanceName}`, {
        method: 'POST',
        headers: this.getHeaders(config),
        body: JSON.stringify({ groupJid }),
      });

      if (!response.ok) return null;
      return response.json();
    } catch {
      return null;
    }
  }
}
