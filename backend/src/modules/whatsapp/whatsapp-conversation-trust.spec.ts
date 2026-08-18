import { isTrustedDirectWhatsappConversation } from './whatsapp-conversation-trust';

describe('isTrustedDirectWhatsappConversation', () => {
  it('accepts an explicitly classified direct conversation', () => {
    expect(isTrustedDirectWhatsappConversation({
      isGroup: false,
      externalThreadId: '8613800000000@s.whatsapp.net',
      contactPoint: null,
    })).toBe(true);
  });

  it('recovers a legacy NULL group flag only from an exact verified E.164 anchor', () => {
    expect(isTrustedDirectWhatsappConversation({
      isGroup: null,
      externalThreadId: '+8613800000000',
      contactPoint: {
        type: 'whatsapp',
        originalValue: '+86 156 2458 4719',
        normalizedValue: '+8613800000000',
        isVerified: true,
      },
    })).toBe(true);
  });

  it.each([
    ['different verified number', '+8613800000000', '+8615624584700', true],
    ['unverified identity', '+8613800000000', '+8613800000000', false],
    ['LID thread', '234977878868136@lid', '+234977878868136', true],
    ['group JID', '120363000000@g.us', '+120363000000', true],
    ['display-name thread', 'AcmeCorp', '+8613800000000', true],
  ])('rejects a legacy NULL group flag with %s', (_label, externalThreadId, normalizedValue, isVerified) => {
    expect(isTrustedDirectWhatsappConversation({
      isGroup: null,
      externalThreadId,
      contactPoint: { type: 'whatsapp', normalizedValue, isVerified },
    })).toBe(false);
  });
});
