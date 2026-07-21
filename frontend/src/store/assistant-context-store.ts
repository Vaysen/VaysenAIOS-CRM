import { create } from 'zustand';

export interface WhatsAppAssistantContext {
  name: string;
  phone: string;
  accountId?: string;
  selectionProof?: string;
  conversationId?: string;
  leadId?: string;
  isGroup?: boolean;
  lastMessage?: string;
}

interface AssistantContextState {
  whatsapp: WhatsAppAssistantContext | null;
  setWhatsAppContext: (context: WhatsAppAssistantContext | null) => void;
}

export const useAssistantContextStore = create<AssistantContextState>((set) => ({
  whatsapp: null,
  setWhatsAppContext: (whatsapp) => set({ whatsapp }),
}));
