# Vaysen AI CRM Local Deployment

This package is designed for a Windows computer used as an internal CRM server.

## Requirements

- Windows 10/11 or Windows Server
- Docker Desktop running
- Node.js 20+ or 24 LTS
- PowerShell
- Stable LAN IP address

## First install

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\install-local.ps1
```

## Start

```powershell
.\scripts\start-local.ps1
```

The script detects the LAN IP and updates:

- `backend\.env`
- `frontend\.env.local`

Open:

- Local machine: `http://localhost:4001/login`
- LAN devices: `http://YOUR_LAN_IP:4001/login`
- n8n: `http://YOUR_LAN_IP:5678`

## Stop

```powershell
.\scripts\stop-local.ps1
```

## Health check

```powershell
.\scripts\health-check.ps1
```

## Backup

```powershell
.\scripts\backup-db.ps1
```

## Restore

```powershell
.\scripts\restore-db.ps1 -BackupFile .\backups\db\YOUR_BACKUP.dump
```

## Reacher email verification

The backend is already configured with:

```env
REACHER_API_URL=http://localhost:18080
```

If Docker can pull the image, start it:

```powershell
docker compose -f docker-compose.infra.local.yml up -d reacher
```

If the image is blocked by a registry mirror, the system still runs. Email verification falls back to MX/DNS checks. Full SMTP mailbox verification may also fail on home or office networks if outbound port 25 is blocked by the ISP.

## Public domain access

For internal LAN usage, do not expose the app publicly.

If you bind a domain and want to access it from other cities, use one of these safer options:

- VPN into the office network, then access the LAN address.
- Use a secure tunnel/reverse proxy with HTTPS and access controls.
- Deploy to a proper VPS with HTTPS, backups, firewall, and ICP compliance where required.

Do not directly port-forward this machine to the public internet without HTTPS, strong passwords, firewall rules, and regular backups.
