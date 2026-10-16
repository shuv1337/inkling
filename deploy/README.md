# Private deployment and recovery

Use Node.js 22 or later, npm, Docker Compose, systemd user services, and a signed-in Tailscale node. Keep `main` upstream-only; deploy `selfhost`. This repository is private while upstream licensing is unresolved. No CI is configured; run the gates manually.

## Configure and serve

Follow the root README to install dependencies and start/migrate Postgres. Keep `.env.local` mode 0600. Use a long random database password and a separate 32-byte `AUTH_ENCRYPTION_KEY` for ChatGPT. Store a recoverable copy of those secrets in your password manager. Never commit them or include them in a support log.

Set `ALLOWED_TS_USERS` to the exact Tailscale login(s), not the display name. `tailscale status --json` identifies the node owner under `User`. Do not infer the login from a ChatGPT email. Set `NEXT_PUBLIC_SITE_URL` to the intended HTTPS origin before building.

Browser and owner APIs require an allowed Tailscale identity in single-user production. Empty configuration denies access. The app trusts the identity header only because Tailscale Serve is the public-facing proxy and the backend is loopback-only. Other local processes are inside this trust boundary. Do not expose port 3100 directly to the LAN or Internet. The exact `/mcp` and `/mcp/<token>` routes instead require a scoped agent token in their handler, so a tagged agent host can connect without impersonating a human. Bearer tokens do not authorize owner APIs.

Build with `npm run build`. Example user unit at `~/.config/systemd/user/gloss.service` (adjust the checkout and the absolute npm path to your installation):

```ini
[Unit]
Description=Inkling private reader
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/repos/gloss
ExecStart=/usr/bin/npm run start -- -H 127.0.0.1 -p 3100
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0077

[Install]
WantedBy=default.target
```

The app loads `.env.local` itself. Configure systemd user lingering if it must survive logout. Then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now gloss.service
# Inspect existing routes first; preserve every unrelated route.
tailscale serve status
tailscale serve --bg --yes --https=443 http://127.0.0.1:3100
```

Use the existing operator/sudo setup if Tailscale requires privilege. Never use Funnel for this deployment. Confirm app and database listeners are loopback-only, the tailnet home works, and missing/wrong identity requests to the backend return 403. Verify the actual owner over the tailnet, not only a manually supplied header.

```bash
systemctl --user status gloss.service
journalctl --user -u gloss.service -n 30 --no-pager
ss -ltn '( sport = :3100 or sport = :5432 )'
curl -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/api/chatgpt
```

## Validate and upgrade

Run `npm test`, `npm run lint` (TypeScript), and `npm run build`. Run `npm test` again after building so the boundary test checks the generated home page. No separate formatter or ESLint command is configured.

Run the build in a disposable Git worktree or copy under `~/.cache/agent-ws`, with dependencies installed and the same public site origin. Do not build into `.next` while `next start` serves that directory. Keep build output and the exact source revision together. On deployment, stop only `gloss.service`, replace `.next` with the verified build, and start it. Keep the previous build until health checks pass, and roll back source and build together if necessary. Check the HTTP title, owner gate, scoped MCP behavior, and service logs after each upgrade.

For database checks, point `DATABASE_URL` at a disposable database, then run these from the checkout (an explicitly exported variable takes precedence over `.env.local`):

```bash
npm run db:migrate
npm run db:migrate  # idempotency
npm run db:roundtrip
npm run mcp:smoke
```

These smoke scripts insert/delete fixture users; they are not read-only production probes. A restored copy of `openai_auth` must not run inference or refresh: rotating the copied refresh token would invalidate the production session. Use no production encryption key in test servers, or delete the restored credential rows in the disposable database before starting one.

## Nightly backups

The host's existing `~/bin/gloss-backup` uses this pattern. Container name must match `docker compose -f deploy/docker-compose.yml ps`:

```bash
#!/bin/bash
set -euo pipefail
umask 077
backup_dir="$HOME/backups/gloss"
mkdir -p "$backup_dir"
backup_file="$backup_dir/gloss-$(date +%Y%m%d-%H%M%S).sql.gz"
docker exec gloss-postgres-1 pg_dump -U gloss -d gloss --no-owner | gzip > "$backup_file.tmp"
mv "$backup_file.tmp" "$backup_file"
find "$backup_dir" -name 'gloss-*.sql.gz' -mtime +13 -delete
```

Example `gloss-backup.service`:

```ini
[Unit]
Description=Nightly Inkling database backup
[Service]
Type=oneshot
ExecStart=%h/bin/gloss-backup
UMask=0077
```

Example `gloss-backup.timer`:

```ini
[Unit]
Description=Nightly Inkling backup
[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true
RandomizedDelaySec=10m
[Install]
WantedBy=timers.target
```

Enable with `systemctl --user enable --now gloss-backup.timer`. Check completed runs using `journalctl --user -u gloss-backup.service`; an enabled timer is not proof of a successful dump.

The SQL dump includes library content and encrypted ChatGPT credentials, but not the key needed to decrypt them or the host configuration. Recover `.env.local` securely from a separate secret backup, or relink ChatGPT with a new encryption key. Browser-only unsynced documents are not covered by database backups. Current backups are local to this host: protection from host/disk loss requires an encrypted off-host copy to a destination selected by the owner. No off-host destination is configured by this guide.

## Restore drill

Restore into a new isolated database, never over the live library. Example using a disposable Postgres 18 container named `inkling-restore` and a database named `restore_check`:

```bash
docker exec inkling-restore createdb -U postgres restore_check
gzip -t /path/to/backup.sql.gz
gzip -dc /path/to/backup.sql.gz | docker exec -i inkling-restore \
  psql -U postgres -d restore_check -v ON_ERROR_STOP=1 --single-transaction
```

Check migration records and counts of articles, highlights, notes (`glosses`), covers, and encrypted auth rows. Read a restored article through the library API/code, not just the table count. Run migrations against the isolated restore and confirm they are idempotent. Do not use its saved ChatGPT credentials. Remove the disposable database/container when finished.

For disaster recovery, keep the old production instance stopped while restoring. Restore the database and matching secret configuration, run migrations, rebuild the selected revision, then verify owner access, library data, sync, and one model request. Never have both old and restored instances refresh the same ChatGPT session.
