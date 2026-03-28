# Deploy to a VPS

This recipe walks through deploying a Guren application on a bare Linux VPS (Ubuntu/Debian) with Nginx as a reverse proxy and systemd for process management.

## Prerequisites

- A Linux server with SSH access
- Bun installed ([bun.sh](https://bun.sh))
- PostgreSQL running (local or remote)
- Nginx installed
- A domain name pointed at your server (optional but recommended)

## 1. Clone and build

```bash
ssh deploy@your-server

git clone https://github.com/your-org/your-app.git /srv/your-app
cd /srv/your-app

bun install --production=false
bun run codegen
bun run build
bun install --production
```

## 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with production values:

```dotenv
APP_URL=https://example.com
PORT=3333
DATABASE_URL=postgres://user:password@localhost:5432/your_db
NODE_ENV=production
```

## 3. Run migrations

```bash
NODE_ENV=production bun run db:migrate
```

## 4. Create a systemd service

Create `/etc/systemd/system/guren-app.service`:

```ini
[Unit]
Description=Guren Application
After=network.target postgresql.service

[Service]
Type=simple
User=deploy
WorkingDirectory=/srv/your-app
EnvironmentFile=/srv/your-app/.env
ExecStart=/usr/local/bin/bun run start
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Enable and start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable guren-app
sudo systemctl start guren-app
sudo systemctl status guren-app
```

## 5. Configure Nginx

Create `/etc/nginx/sites-available/guren-app`:

```nginx
server {
    listen 80;
    server_name example.com;

    location / {
        proxy_pass http://127.0.0.1:3333;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    # Serve static assets directly
    location /assets/ {
        alias /srv/your-app/public/assets/;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

Enable the site and reload:

```bash
sudo ln -s /etc/nginx/sites-available/guren-app /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

## 6. TLS with Let's Encrypt

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d example.com
```

Certbot automatically updates the Nginx config to redirect HTTP to HTTPS.

## 7. Deploying updates

A minimal deployment script (`deploy.sh`):

```bash
#!/usr/bin/env bash
set -euo pipefail

cd /srv/your-app
git pull origin main

bun install --production=false
bun run codegen
bun run build
bun install --production

bun run db:migrate

sudo systemctl restart guren-app
```

## Monitoring

```bash
# View application logs
sudo journalctl -u guren-app -f

# Check process status
sudo systemctl status guren-app
```
