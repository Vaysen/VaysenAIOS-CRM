/**
 * Human-confirmed desktop capability contract for the AI business assistant.
 *
 * Desktop actions may prepare an authenticated quotation PDF or fill a draft
 * into the exact verified WhatsApp chat. They never click WhatsApp's send
 * button without a separate L3 authorization flow.
 */
export interface AgentQuoteDeliveryRequest {
  proposalId: string;
}

export interface AgentQuoteDeliveryResult {
  success: boolean;
  data?: {
    preparedFileId: string;
    quoteId: string;
    filename: string;
    size: number;
    sha256: string;
    targetPhone: string;
  };
  error?: string;
}

export interface AgentWhatsappTextSendRequest {
  conversationId: string;
  targetPhone: string;
  targetName: string;
  targetAccountId: string;
  selectionProof: string;
  text: string;
}

export interface AgentWhatsappTextSendResult {
  success: boolean;
  actionId?: string;
  warning?: string;
  error?: string;
}

export interface AgentDesktopCapabilitySnapshot {
  schemaVersion: 2;
  observedAt: string;
  mode: 'human-confirmed';
  executor: {
    supported: true;
    actions: Array<
      'prepare_quote_delivery'
      | 'fill_whatsapp_draft'
      | 'send_whatsapp_text_human_confirmed'
    >;
  };
  safety: {
    automaticSend: false;
    offlineCatchUp: false;
    retryUnknownResult: false;
    domInjection: true;
    targetIdentityRequired: true;
    manualWhatsappSendRequired: true;
  };
  whatsapp: {
    available: boolean;
    activeAccount: {
      id: string;
      label: string;
    } | null;
    login: {
      status: string;
      observedAt: string | null;
    };
    currentChat: {
      accountId: string;
      name: string;
      phone: string;
      isGroup: boolean;
      externalId?: string;
      observedAt: string;
      selectionProof: string;
    } | null;
  };
}

export interface AgentDesktopHeartbeat {
  schemaVersion: 2;
  observedAt: string;
  mode: 'human-confirmed';
  whatsappAvailable: boolean;
  activeAccountId: string | null;
  loginStatus: string;
  loginObservedAt: string | null;
  currentChatKnown: boolean;
  currentChatObservedAt: string | null;
  executorSupported: true;
}
