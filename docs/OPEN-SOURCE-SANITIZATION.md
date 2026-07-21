# Open-source sanitization report

Date: 2026-07-21
Source boundary: clean snapshot of the CRM application only; no parent repository history imported.

## Removed or replaced

- Real company names, domains, emails and tenant profile values
- Real LAN/ZeroTier addresses and production deployment notes
- Prospect research JSON files and operational one-off scripts
- Internal release, acceptance, audit and work-record documents
- Real product costs, USD prices and price-source hashes
- Runtime `.env`, credentials, backups, uploads, logs and messaging sessions
- Old J-Origin/TradeLead branding and application icons
- Internal workstation bootstrap scripts and bundled test credentials

## Kept intentionally

- Runtime source code and tests
- Generic email, WhatsApp, OpenClaw and AI provider integrations
- Synthetic preview companies and reserved example addresses
- Schema-compatible zero-price product examples
- Vaysen public brand exports with separate trademark rules

## Publication model

This directory is a new standalone Git repository. It must not be replaced by a public fork of the private parent repository, because that history also contains unrelated business materials.

Before each public push run:

```bash
npm run verify:public-release
git status --short
```

The release owner must also review generated diffs and confirm that no runtime data was force-added.

Dependency findings are tracked separately in [`DEPENDENCY-RISK.md`](DEPENDENCY-RISK.md); sanitization success must not be interpreted as a zero-vulnerability claim.
