# Deployment

How to run the proxy in different environments. The codebase is small
enough that "deployment" usually means "start one Node process and
point a client at it" — but here are the supported variations.

## Local — `npm start`

```bash
git clone https://github.com/<your-fork>/free-claude-code-ai.git
cd free-claude-code-ai
npm install
cp .env.example .env
# edit .env — set PROVIDER and the matching API key
npm start
```

Runs `node src/server.js`. Reads `.env` from the current working
directory. Stops on Ctrl-C.

## Local — watch mode

```bash
npm run dev
```

Uses `node --watch` (built-in since Node 18.11) to restart on file
change. Useful while editing `src/`.

## Docker

The provided `Dockerfile` is a small Alpine image:

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY src ./src
ENV PORT=3000
EXPOSE 3000
CMD ["node", "src/server.js"]
```

Note that `bots/` and `tests/` are deliberately *not* copied — the
image is the proxy only.

### Build and run manually

```bash
docker build -t free-claude-code-ai .
docker run --rm \
  -p 3000:3000 \
  --env-file .env \
  -v $(pwd)/.data:/app/.data \
  -v $(pwd)/logs:/app/logs \
  free-claude-code-ai
```

### docker-compose

The bundled `docker-compose.yml` does the same thing one-shot:

```bash
cp .env.example .env
# edit .env
docker compose up -d
```

Stop with `docker compose down`.

The compose file maps two volumes:

| Host          | Container       | Used for                       |
|---------------|-----------------|--------------------------------|
| `./.data`     | `/app/.data`    | cache + persisted stats        |
| `./logs`      | `/app/logs`     | request log (when enabled)     |

Both volumes are bind mounts to the project directory so you can
inspect the data with regular tools (`cat`, `jq`, `tail`) on the host.

## Behind a reverse proxy

The proxy exposes operational endpoints (`/dashboard`, `/stats`,
`/info`, `/logs`) **without authentication**. Don't expose them to
the public internet. Run behind nginx, Caddy, or Cloudflare Tunnel.

### nginx example

```nginx
server {
    listen 443 ssl;
    server_name proxy.example.com;

    ssl_certificate     /etc/letsencrypt/live/proxy.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/proxy.example.com/privkey.pem;

    # Lock dashboards/stats to a private CIDR
    location ~ ^/(dashboard|stats|info|logs|health)$ {
        allow 10.0.0.0/8;
        allow 192.168.0.0/16;
        deny  all;
        proxy_pass http://127.0.0.1:3000;
    }

    # Public Anthropic-compatible API
    location /v1/ {
        proxy_pass             http://127.0.0.1:3000;
        proxy_http_version     1.1;
        proxy_set_header       Host $host;
        proxy_buffering        off;          # important for SSE streaming
        proxy_read_timeout     1h;
    }
}
```

`proxy_buffering off` and a long `proxy_read_timeout` are both needed
for streaming responses to flow through nginx in real time.

### Caddy example

```
proxy.example.com {
    @internal {
        path /dashboard /stats /info /logs /health
        not remote_ip 10.0.0.0/8 192.168.0.0/16
    }
    respond @internal 403

    reverse_proxy /v1/* localhost:3000 {
        flush_interval -1
    }
    reverse_proxy /* localhost:3000
}
```

`flush_interval -1` disables buffering so SSE flows immediately.

## Pointing Claude Code at the proxy

```bash
# bash / zsh
export ANTHROPIC_BASE_URL=http://localhost:3000
export ANTHROPIC_AUTH_TOKEN=anything   # only checked if AUTH_TOKEN is set
claude
```

```powershell
# Windows PowerShell
$env:ANTHROPIC_BASE_URL = "http://localhost:3000"
$env:ANTHROPIC_AUTH_TOKEN = "anything"
claude
```

VS Code extension settings (JSON):

```json
{
  "anthropic.baseUrl": "http://localhost:3000",
  "anthropic.authToken": "anything"
}
```

JetBrains IDEs: set the same env vars in the *Run Configuration* or
your shell profile before launching the IDE.

## Production checklist

- [ ] `AUTH_TOKEN` set to a long random string.
- [ ] Reverse proxy terminates TLS.
- [ ] Operational endpoints are firewalled/IP-allowlisted.
- [ ] `PROVIDER` is a fallback chain, not a single provider, so a
      provider outage doesn't take you down.
- [ ] `LOG_REQUESTS=true` if you want an audit trail; `logrotate`
      configured to keep the file from growing unbounded.
- [ ] `CACHE_TTL` tuned for your workload — `0` if you want freshness,
      `300`+ if you have repeated requests.
- [ ] `.data/` and `logs/` are on persistent storage (not ephemeral
      `tmpfs`).
- [ ] Process supervisor (systemd, pm2, Docker restart policy)
      restarts on crash.
- [ ] Free-tier provider quotas understood. Set up multiple keys
      (`KEY1,KEY2,KEY3`) and a multi-provider fallback chain.

## What this proxy is *not*

- A multi-tenant gateway. There's one shared in-memory map for stats,
  one cache directory, one log file. Run one instance per user/team.
- A rate limiter. Add one in your reverse proxy if you need it.
- A cost tracker. The token counts are estimates. For real billing,
  the upstream provider's dashboard is authoritative.
- A long-term storage system. Stats and logs persist to local disk;
  none of this goes to a database.
