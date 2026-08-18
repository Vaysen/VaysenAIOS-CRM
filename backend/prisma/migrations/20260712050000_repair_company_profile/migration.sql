-- Repair the legacy GBK/UTF-8-corrupted production company profile.
-- The fixed UUID is the existing Vaysen tenant; the WHERE clause keeps this
-- migration idempotent and prevents changes to any future tenant.
UPDATE "Company"
SET
  "name" = 'Vaysen Packaging',
  "slug" = 'vaysen-crm-packaging',
  "website" = COALESCE("website", 'https://vaysen.com'),
  "industry" = COALESCE("industry", 'Custom flexible packaging'),
  "country" = COALESCE("country", 'CN'),
  "city" = COALESCE("city", 'Xiamen'),
  "description" = COALESCE("description", 'International B2B packaging manufacturer and exporter'),
  "settings" = COALESCE("settings", '{}'::jsonb) || jsonb_build_object(
    'brandName', 'Vaysen Packaging',
    'companyName', 'Vaysen Packaging',
    'website', 'https://vaysen.com',
    'location', 'Xiamen, China',
    'positioning', 'International B2B packaging manufacturer and exporter',
    'mainProducts', 'Poly mailers, kraft paper bags, garbage bags, zip-lock bags and customizable packaging'
  ),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'd81acef0-5841-41dc-9d8e-0864fbf55a1b';
