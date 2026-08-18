-- Preserve existing values and fail closed if a legacy column is incompatible
-- with the Prisma model's nullable TEXT definition.
ALTER TABLE "CommunicationMessage"
  ADD COLUMN IF NOT EXISTS "deliveryStatus" TEXT;

DO $$
DECLARE
  delivery_type TEXT;
BEGIN
  SELECT data_type INTO delivery_type
  FROM information_schema.columns
  WHERE table_schema = current_schema() AND table_name = 'CommunicationMessage' AND column_name = 'deliveryStatus';
  IF delivery_type IS DISTINCT FROM 'text' THEN
    RAISE EXCEPTION 'CommunicationMessage.deliveryStatus must be text, found %', COALESCE(delivery_type, '<missing>');
  END IF;
END $$;
