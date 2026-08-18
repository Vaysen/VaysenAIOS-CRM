export interface CustomerAssetContactPointDto {
  id: string;
  type: string;
  originalValue: string;
  normalizedValue: string;
  isVerified: boolean;
  conversationIds: string[];
}

export interface CustomerAssetContactDto {
  id: string;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  title: string | null;
  isPrimary: boolean;
  contactPoints: CustomerAssetContactPointDto[];
  updatedAt: string;
}

export interface CustomerAssetConversationDto {
  id: string;
  channel: string;
  subject: string | null;
  status: string;
  isGroup: boolean | null;
  contactPointId: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unreadCount: number;
}

export interface CustomerAssetLinkDto {
  id: string;
  reference: string;
  status: string;
  amount?: string;
  createdAt: string;
}

export interface PendingCandidateDto {
  id: string;
  sourceLeadId: string;
  targetLeadId: string;
  score: number;
  reasons: unknown;
  status: string;
  createdAt: string;
}

export interface CustomerAssetDto {
  id: string;
  companyName: string | null;
  displayName: string;
  countryIso2: string | null;
  contacts: CustomerAssetContactDto[];
  contactPoints: CustomerAssetContactPointDto[];
  conversations: CustomerAssetConversationDto[];
  emails: CustomerAssetLinkDto[];
  quotes: CustomerAssetLinkDto[];
  orders: CustomerAssetLinkDto[];
  selectedContactId: string | null;
  pendingMatchCount: number;
  pendingCandidates: PendingCandidateDto[];
  updatedAt: string;
}
