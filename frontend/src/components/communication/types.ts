export type Channel = 'business_email' | 'marketing_email' | 'whatsapp' | 'website_inquiry' | 'manual' | 'website_livechat';

export interface ConversationSummary {
  id: string;
  channel: Channel;
  subject: string | null;
  status: 'active' | 'archived' | 'closed';
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unreadCount: number;
  isPinned?: boolean;
  hasPendingFollowUp?: boolean;
  whatsappSessionId?: string | null;
  lead: {
    id: string;
    companyName: string;
    contactName: string | null;
    contactEmail?: string | null;
    contactPhone?: string | null;
    whatsapp?: string | null;
    country: string | null;
    language?: string | null;
    status?: string;
    leadGrade?: string | null;
    sourceType?: string | null;
    website?: string | null;
    nextFollowUpAt?: string | null;
    lastContactedAt?: string | null;
    updatedAt?: string;
    createdAt?: string;
    tags?: Array<{ id?: string; tagId?: string; tag?: { id: string; name: string; displayName?: string; color?: string } }>;
  } | null;
  contactPoint?: {
    id: string;
    type: string;
    originalValue: string;
    normalizedValue: string;
    avatarUrl?: string | null;
  } | null;
  assignedUser: {
    id: string;
    firstName: string;
    lastName: string;
  } | null;
}

export interface CommunicationMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  content: string;
  contentType: string;
  fromAddress: string | null;
  toAddress: string | null;
  subject: string | null;
  sentAt: string | null;
  receivedAt: string | null;
  attachmentsMeta: any;
  createdAt: string;
  translatedContent?: string | null;
  detectedLanguage?: string | null;
}

export interface ConversationDetail extends ConversationSummary {
  contactPoint: any;
  messages: CommunicationMessage[];
  aiArtifacts: any[];
}
