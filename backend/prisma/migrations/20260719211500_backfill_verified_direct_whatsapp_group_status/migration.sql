-- Historical Electron imports predated the explicit Conversation.isGroup
-- classification. Backfill only rows whose external thread is itself a phone
-- identity and exactly equals the same tenant-scoped, verified E.164
-- WhatsApp ContactPoint. Group JIDs, LIDs, display names, unverified contacts
-- and suffix-only matches remain unchanged.
UPDATE "Conversation" AS conversation
SET
  "isGroup" = FALSE,
  "updatedAt" = NOW()
FROM "ContactPoint" AS contact_point
WHERE conversation."contactPointId" = contact_point.id
  AND conversation.channel = 'whatsapp'
  AND conversation."isGroup" IS NULL
  AND conversation."externalThreadId" !~* '@g\.us$'
  AND conversation."externalThreadId" ~* '^\+?[1-9][0-9]{6,14}(@s\.whatsapp\.net)?$'
  AND contact_point.type = 'whatsapp'
  AND contact_point."isVerified" = TRUE
  AND contact_point."normalizedValue" ~ '^\+[1-9][0-9]{6,14}$'
  AND regexp_replace(
    regexp_replace(conversation."externalThreadId", '@s\.whatsapp\.net$', '', 'i'),
    '\D',
    '',
    'g'
  ) = regexp_replace(contact_point."normalizedValue", '\D', '', 'g');
