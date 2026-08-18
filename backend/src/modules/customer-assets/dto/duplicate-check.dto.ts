export interface DuplicateCheckCommand {
  companyId: string;
  leadId: string;
  phone?: string;
  email?: string;
  companyName?: string;
}

export interface DuplicateCheckHit {
  leadId: string;
  companyName: string | null;
  displayName: string | null;
  countryIso2: string | null;
  contactPointPreview: string | null;
  matchedChannel: 'companyName' | 'email' | 'whatsapp' | 'phone';
  matchedValue: string;
  score: number;
}

export interface DuplicateCheckResult {
  queryLeadId: string;
  hits: DuplicateCheckHit[];
}
