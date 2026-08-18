import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { AuthenticatedUser } from './agent.service';
import {
  AuthorizeWhatsappTextSendDto,
  CompleteWhatsappTextSendDto,
} from './dto/assistant-external-action.dto';

/**
 * The legacy Electron bridge could only prove that a renderer clicked "send";
 * it could not produce a provider receipt or participate in ExternalActionOutbox.
 * Keep both endpoints fail-closed until the desktop transport executes the same
 * durable reservation/claim/receipt protocol as server-side providers.
 */
@Injectable()
export class AssistantExternalActionService {
  async authorizeWhatsappTextSend(
    _dto: AuthorizeWhatsappTextSendDto,
    _user: AuthenticatedUser,
  ): Promise<never> {
    throw this.disabled();
  }

  async completeWhatsappTextSend(
    _id: string,
    _dto: CompleteWhatsappTextSendDto,
    _user: AuthenticatedUser,
  ): Promise<never> {
    throw this.disabled();
  }

  private disabled() {
    return new ServiceUnavailableException(
      'Electron one-time WhatsApp sends are disabled until provider execution uses ExternalActionOutbox',
    );
  }
}
