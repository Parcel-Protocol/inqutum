-- Issue #8: asset codes are normalized (trimmed, uppercased) when an invoice is
-- created. Invoices created before that rule may hold a code such as 'usdc',
-- which verification (byte-exact by design) could never settle.
--
-- Only PENDING invoices are rewritten: they are the ones that can still be
-- paid. PAID/EXPIRED/CANCELLED rows are history and are left untouched.
-- The statement is idempotent; re-running it changes nothing.
UPDATE invoices
SET asset_code = upper(btrim(asset_code))
WHERE status = 'PENDING'
  AND asset_code IS NOT NULL
  AND asset_code <> upper(btrim(asset_code));

-- Data-quality check: list invoices whose stored asset can still never be
-- settled (a credit asset with no issuer, or a code outside 1-12 alphanumerics).
-- Run manually and review; the migration deliberately does not guess a fix.
--   SELECT id, asset_code, asset_issuer, status FROM invoices
--   WHERE asset_code !~ '^[A-Z0-9]{1,12}$'
--      OR (asset_code <> 'XLM' AND asset_issuer IS NULL);
