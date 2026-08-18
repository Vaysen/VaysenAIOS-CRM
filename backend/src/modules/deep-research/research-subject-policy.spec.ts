import { assessResearchSubject } from './research-subject-policy';

describe('assessResearchSubject', () => {
  it('rejects an empty company name', () => {
    expect(assessResearchSubject({
      companyName: '  ', companyNameSource: null, companyNameConfidence: null,
    })).toEqual(expect.objectContaining({ trusted: false, code: 'MISSING_COMPANY_NAME' }));
  });

  it.each([
    [null, null],
    ['untrusted_display', 'low'],
    ['exact_channel', 'high'],
    ['manual_confirmed', 'medium'],
  ])('rejects an unreviewed company identity (%s/%s)', (source, confidence) => {
    expect(assessResearchSubject({
      companyName: 'AcmeCorp', companyNameSource: source, companyNameConfidence: confidence,
    })).toEqual(expect.objectContaining({
      trusted: false,
      code: 'UNVERIFIED_COMPANY_NAME',
      companyName: 'AcmeCorp',
    }));
  });

  it.each(['manual_confirmed', 'verified_import'])('accepts trusted source %s', (source) => {
    expect(assessResearchSubject({
      companyName: ' Verified Buyer Ltd ', companyNameSource: source, companyNameConfidence: 'high',
    })).toEqual({ trusted: true, companyName: 'Verified Buyer Ltd' });
  });
});
