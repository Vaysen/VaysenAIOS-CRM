export type ResearchSubjectIdentity = {
  companyName: string | null;
  companyNameSource: string | null;
  companyNameConfidence: string | null;
};

export type ResearchSubjectAssessment =
  | { trusted: true; companyName: string }
  | {
      trusted: false;
      code: 'MISSING_COMPANY_NAME' | 'UNVERIFIED_COMPANY_NAME';
      companyName: string | null;
      source: string | null;
    };

const TRUSTED_COMPANY_NAME_SOURCES = new Set(['manual_confirmed', 'verified_import']);

/**
 * Background research must never treat a WhatsApp display name as a company.
 * Only a high-confidence, explicitly reviewed CRM company identity is a safe
 * research subject. Older rows with no provenance intentionally fail closed.
 */
export function assessResearchSubject(
  identity: ResearchSubjectIdentity,
): ResearchSubjectAssessment {
  const companyName = identity.companyName?.trim() || null;
  if (!companyName) {
    return {
      trusted: false,
      code: 'MISSING_COMPANY_NAME',
      companyName: null,
      source: identity.companyNameSource,
    };
  }

  if (
    !identity.companyNameSource
    || !TRUSTED_COMPANY_NAME_SOURCES.has(identity.companyNameSource)
    || identity.companyNameConfidence !== 'high'
  ) {
    return {
      trusted: false,
      code: 'UNVERIFIED_COMPANY_NAME',
      companyName,
      source: identity.companyNameSource,
    };
  }

  return { trusted: true, companyName };
}
