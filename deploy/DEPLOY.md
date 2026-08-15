# Deploying CoreKit Tracker on a VPS

Target: Ubuntu 24.04 VPS (Hetzner / DigitalOcean / Lightsail — any works), Caddy for HTTPS, systemd to keep it running. ~20 minutes.

## 0. Provision

- Create the smallest VPS (1 vCPU / 1 GB is more than enough), Ubuntu 24.04, add your SSH key.
- Point DNS: create an **A record** for `corekit.me` (or your chosen name) → the VPS IP. Do this early; Caddy needs it resolvable to issue the certificate.

## 1. Base setup (as root)

```bash
apt update && apt upgrade -y
apt install -y caddy sqlite3 ufw

# Node 24 (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs
node -v   # must be >= 22.5

# firewall: SSH + web only
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw enable

# service user
useradd -r -m -d /opt/corekit -s /usr/sbin/nologin corekit
```

## 2. Upload the app

From your Windows machine (PowerShell, adjust IP):

```powershell
scp -r C:\Users\LENOVO\Downloads\corekit\* root@YOUR_VPS_IP:/opt/corekit/
```

Then on the server:

```bash
chown -R corekit:corekit /opt/corekit
chmod +x /opt/corekit/deploy/backup.sh
```

**Decide about data:** if you want to start the online instance with your locally imported data (all the Sprint0 projects), include the `data/` folder in the copy above. For a fresh start, delete it on the server — a new admin will be seeded on first boot.

## 3. Service

```bash
cp /opt/corekit/deploy/corekit.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now corekit
systemctl status corekit        # should be active (running)
journalctl -u corekit -n 20     # first run prints where the admin password was saved
```

## 4. HTTPS via Caddy

```bash
cp /opt/corekit/deploy/Caddyfile /etc/caddy/Caddyfile
# edit the domain in it if different:  nano /etc/caddy/Caddyfile
systemctl reload caddy
```

Open `https://corekit.me` — certificate is automatic.

## 5. First login & lockdown

1. Log in as `admin` with the password from `/opt/corekit/data/admin-password.txt`.
2. **Immediately change it**: Team → (or ask Claude to PUT /api/users/1 with a new password), then `rm /opt/corekit/data/admin-password.txt`.
3. Set real passwords for your imported teammates (they were created with random unknown passwords).
4. Disable the `dev1` test account if it came along with the data.

## 6. Backups

```bash
crontab -e
# add:
10 3 * * * /opt/corekit/deploy/backup.sh
```

Snapshots land in `/opt/corekit-backups` (14-day retention). To also keep them off-server, rsync that folder anywhere.

## 7. Updating the app later

**Automatic (recommended):** a push to `main` on GitHub deploys automatically via
`.github/workflows/deploy.yml` — it rsyncs the repo (minus `data/`, `.env` files,
`.git`) to `/opt/corekit` and restarts the service. One-time setup, in the GitHub
repo's Settings → Secrets and variables → Actions:

| Secret | Value |
|---|---|
| `LIGHTSAIL_HOST` | the server's IP or `corekit.me` |
| `LIGHTSAIL_USER` | `ubuntu` |
| `LIGHTSAIL_SSH_KEY` | the full contents of the Lightsail SSH private key (the `ubuntu` user must have passwordless `sudo` for `chown`/`systemctl restart`, which is the Lightsail default) |

**Manual fallback:**
```powershell
scp C:\Users\LENOVO\Downloads\corekit\server.js root@VPS:/opt/corekit/
scp C:\Users\LENOVO\Downloads\corekit\public\index.html root@VPS:/opt/corekit/public/
```
```bash
systemctl restart corekit
```

(`data/` is never touched by updates, either way.)

## Pointing the Claude MCP at production

In the sprint0-mcp config, set:
```
SPRINT0_BASE_URL=https://corekit.me
```
and put an CoreKit Tracker username/password in `sprint0.credentials.json` — auto-relogin then keeps Claude connected forever, no cookies involved.
