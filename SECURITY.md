# Security Policy

## Supported branch

Security fixes target the current `main` branch until tagged release support is defined.

## Reporting

Do not open a public issue containing credentials, customer data or an exploitable proof of concept. Contact the repository owner through the private security-reporting channel configured on GitHub.

## Deployment responsibilities

- Replace every placeholder secret before startup.
- Keep PostgreSQL, Redis and OpenClaw management ports off the public Internet.
- Use HTTPS or a trusted private network for remote access.
- Encrypt backups and test restoration.
- Configure SMTP/IMAP/WhatsApp providers according to their policies.
- Never commit `.env`, sessions, uploads, dumps, certificates or production logs.

The project does not request or need unrestricted host Shell or arbitrary SQL access for normal AI assistant operation.
