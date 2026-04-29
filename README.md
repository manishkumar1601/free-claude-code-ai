# free-claude-code-ai

A drop-in proxy that lets **Claude Code** (and any Anthropic-compatible
client) talk to free or self-hosted model providers. It speaks the
**Anthropic Messages API** on the front, and any **OpenAI-compatible
`/chat/completions`** endpoint on the back.

> **Inspired by** [Alishahryar1/free-claude-code](https://github.com/Alishahryar1/free-claude-code)
> — the original Python proxy by Ali Shahryar. This port reimplements the
> proxy core in Node.js, swaps in **Cloudflare Workers AI** as the default
> backend, and adds caching, fallback, key rotation, a small dashboard,
> and optional Telegram/Discord chat bots.

---

## Features

- Drop-in proxy for Claude Code's Anthropic API calls
- **Seven** provider backends: Cloudflare Workers AI, NVIDIA NIM,
  OpenRouter, DeepSeek, LM Studio, llama.cpp, Ollama
- **Provider fallback chain** — `PROVIDER=cloudflare,openrouter` retries the
  next backend on 5xx / network errors
- **Per-tier routing** — send Opus/Sonnet/Haiku traffic to different
  providers via `ROUTE_OPUS` / `ROUTE_SONNET` / `ROUTE_HAIKU`
- **API-key rotation** — comma-separated keys are rotated round-robin
- Streaming (SSE) and non-streaming responses
- Tool use / function calling translated both directions
- **`/v1/messages/count_tokens`** endpoint (rough char/4 estimator)
- **Response cache** — disk cache for non-streaming requests, set `CACHE_TTL`
- **Request log** — JSONL audit trail of every request, set `LOG_REQUESTS=true`
- **`/dashboard`** — live HTML view of provider, totals, by-provider stats,
  and recent log entries (auto-refresh)
- **Telegram + Discord bots** — minimal chat clients that talk to the proxy
- Unit tests for the translator (`npm test`, no extra deps — `node:test`)
- **Docker** — `docker compose up`

---

## Provider matrix

| Provider     | Type   | Default base URL                                              | Auth                                              |
|--------------|--------|---------------------------------------------------------------|---------------------------------------------------|
| `cloudflare` | hosted | `https://api.cloudflare.com/client/v4/accounts/{id}/ai/v1`    | `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` |
| `nvidia`     | hosted | `https://integrate.api.nvidia.com/v1`                         | `NVIDIA_API_KEY`                                  |
| `openrouter` | hosted | `https://openrouter.ai/api/v1`                                | `OPENROUTER_API_KEY`                              |
| `deepseek`   | hosted | `https://api.deepseek.com/v1`                                 | `DEEPSEEK_API_KEY`                                |
| `lmstudio`   | local  | `http://localhost:1234/v1`                                    | none                                              |
| `llamacpp`   | local  | `http://localhost:8080/v1`                                    | none                                              |
| `ollama`     | local  | `http://localhost:11434/v1`                                   | none                                              |

---

## Project layout

```
free-claude-code-ai/
├── src/
│   ├── server.js        Express app, all routes
│   ├── providers.js     Provider configs, fallback chain, key rotation, model router
│   ├── translator.js    Anthropic ↔ OpenAI conversion (incl. SSE streaming)
│   ├── tokens.js        count_tokens estimator
│   ├── logger.js        Request log writer (logs/requests.jsonl)
│   ├── stats.js         In-memory + persisted stats (.data/stats.json)
│   ├── cache.js         Disk cache for non-streaming responses
│   └── dashboard.js     Inline HTML for /dashboard
├── bots/
│   ├── telegram.js      Optional Telegram chat bot
│   └── discord.js       Optional Discord chat bot
├── tests/
│   └── translator.test.js
├── Dockerfile
├── docker-compose.yml
├── package.json
├── .env.example
└── README.md
```

No build step. No transpilation. Plain ES modules on Node 18+.

---

## Prerequisites

- **Node.js 18+** (uses built-in `fetch` and Web Streams)
- **Claude Code** — <https://docs.claude.com/en/docs/claude-code>
- One of the providers above with credentials, or a local server running

---

## Quick start

```bash
git clone https://github.com/<your-fork>/free-claude-code-ai.git
cd free-claude-code-ai
npm install
cp .env.example .env
# edit .env: set PROVIDER and that provider's credentials
npm start
```

The proxy listens on `http://localhost:3000`.

```bash
curl http://localhost:3000/health
# {"ok":true}
```

Open the dashboard in a browser:

```
http://localhost:3000/dashboard
```

---

## Configuration

Everything lives in `.env`.

### Routing

| Variable        | Default      | Description                                              |
|-----------------|--------------|----------------------------------------------------------|
| `PROVIDER`      | `cloudflare` | One name OR comma-separated fallback chain               |
| `ROUTE_OPUS`    | *(uses `PROVIDER`)* | Override for Opus traffic                         |
| `ROUTE_SONNET`  | *(uses `PROVIDER`)* | Override for Sonnet traffic                       |
| `ROUTE_HAIKU`   | *(uses `PROVIDER`)* | Override for Haiku traffic                        |
| `BIG_MODEL`     | provider's default | Used for opus/sonnet                              |
| `SMALL_MODEL`   | provider's default | Used for haiku                                    |

Examples:

```ini
# Single provider
PROVIDER=cloudflare

# Fallback chain — retry next on 5xx
PROVIDER=cloudflare,openrouter,deepseek

# Different providers per tier
ROUTE_OPUS=openrouter
ROUTE_SONNET=cloudflare
ROUTE_HAIKU=cloudflare
```

### Server

| Variable        | Default | Description                                          |
|-----------------|---------|------------------------------------------------------|
| `PORT`          | `3000`  | Listen port                                          |
| `AUTH_TOKEN`    | *(empty)* | Optional shared secret. Clients must send it.      |
| `LOG_REQUESTS`  | `false` | Append each request to `logs/requests.jsonl`        |
| `CACHE_TTL`     | `0`     | Cache non-streaming responses on disk for N seconds |

### Key rotation

Any hosted-provider API key may be a comma-separated list. The proxy
round-robins between them on each request:

```ini
CLOUDFLARE_API_TOKEN=key1,key2,key3
```

Useful when you have multiple free accounts and want to spread load.

---

## Provider setup

### Cloudflare Workers AI (default)

1. Sign up at <https://dash.cloudflare.com/>.
2. Copy your **Account ID** (right side of the dashboard).
3. **My Profile → API Tokens → Create Token**, *Workers AI* template.
4. Configure:

```ini
PROVIDER=cloudflare
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...
BIG_MODEL=@cf/meta/llama-3.3-70b-instruct-fp8-fast
SMALL_MODEL=@cf/meta/llama-3.1-8b-instruct
```

Browse model slugs at <https://developers.cloudflare.com/workers-ai/models/>.

### NVIDIA NIM

```ini
PROVIDER=nvidia
NVIDIA_API_KEY=nvapi-...
BIG_MODEL=meta/llama-3.3-70b-instruct
SMALL_MODEL=meta/llama-3.1-8b-instruct
```

Get a key at <https://build.nvidia.com/>.

### OpenRouter

```ini
PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-...
BIG_MODEL=anthropic/claude-3.5-sonnet
SMALL_MODEL=anthropic/claude-3-haiku
```

### DeepSeek

```ini
PROVIDER=deepseek
DEEPSEEK_API_KEY=sk-...
BIG_MODEL=deepseek-chat
SMALL_MODEL=deepseek-chat
```

### LM Studio (local)

Install from <https://lmstudio.ai/>, load a model, start the server.

```ini
PROVIDER=lmstudio
LMSTUDIO_BASE_URL=http://localhost:1234/v1
LMSTUDIO_MODEL=local-model
```

### llama.cpp (local)

```bash
./llama-server -m path/to/model.gguf
```

```ini
PROVIDER=llamacpp
LLAMACPP_BASE_URL=http://localhost:8080/v1
LLAMACPP_MODEL=local-model
```

### Ollama (local)

```bash
ollama pull llama3.1
```

```ini
PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434/v1
OLLAMA_MODEL=llama3.1
```

---

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

JetBrains IDEs: set the same env vars in the *Run Configuration* or your
shell profile before launching the IDE.

---

## API endpoints

| Method | Path                          | Auth | Description                       |
|--------|-------------------------------|------|-----------------------------------|
| GET    | `/health`                     | no   | Liveness probe                    |
| GET    | `/info`                       | no   | Live config snapshot              |
| GET    | `/stats`                      | no   | JSON stats (totals + by provider) |
| GET    | `/logs`                       | no   | Last 50 log lines (plain text)    |
| GET    | `/dashboard`                  | no   | Live HTML dashboard               |
| GET    | `/v1/models`                  | yes  | Advertised Claude model names     |
| POST   | `/v1/messages`                | yes  | Anthropic Messages API            |
| POST   | `/v1/messages/count_tokens`   | yes  | Rough input-token estimate        |

### Smoke test

```bash
curl -s http://localhost:3000/v1/messages \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 256,
    "messages": [{"role":"user","content":"Say hello in one word."}]
  }' | jq .
```

---

## Caching

Set `CACHE_TTL=300` (seconds) to enable. Non-streaming responses are
hashed by `(model, system, messages, tools, temperature, max_tokens)`
and stored under `.data/cache/`. Streaming requests bypass the cache.
Off by default.

## Logging

Set `LOG_REQUESTS=true` to write every request to
`logs/requests.jsonl`. Each line contains timestamp, model, provider,
upstream model, stream flag, token counts, and duration. The dashboard
reads the tail of this file.

## Stats

Persisted to `.data/stats.json` every 5s. Counts are total requests,
input/output tokens, cache hits, errors — both overall and per provider.
View at `/stats` (JSON) or on the dashboard.

---

## Docker

```bash
cp .env.example .env
# edit .env
docker compose up -d
```

Volumes:

- `./.data` → cache + persisted stats
- `./logs`  → request log

Stop with `docker compose down`.

---

## Optional bots

The `bots/` directory contains two minimal chat clients that talk to the
proxy. They run as separate processes; they don't replace Claude Code.

### Telegram

1. Talk to **@BotFather** on Telegram, create a bot, copy the token.
2. Add to `.env`:
   ```ini
   TELEGRAM_BOT_TOKEN=...
   PROXY_URL=http://localhost:3000
   ```
3. Run:
   ```bash
   npm run bot:telegram
   ```
4. Message your bot. Send `/reset` to clear conversation history.

### Discord

1. Create an app at <https://discord.com/developers/applications>, add a
   bot, enable **Message Content Intent**, copy the token, invite to a
   server.
2. Install the optional dep:
   ```bash
   npm install discord.js
   ```
3. Add to `.env`:
   ```ini
   DISCORD_BOT_TOKEN=...
   ```
4. Run:
   ```bash
   npm run bot:discord
   ```
5. Mention the bot or DM it. Send `/reset` to clear history.

Both bots keep the last 20 messages of conversation per chat/channel.

---

## Tests

```bash
npm test
```

Uses Node's built-in `node:test` runner (no extra dependency). Covers
the translator's request/response conversion in both directions.

---

## Development

```bash
npm run dev    # node --watch — restarts on file change
npm start      # production-style start
npm test       # run translator tests
```

Two runtime deps: `express`, `dotenv`. `discord.js` is an optional dep
loaded only by the Discord bot.

---

## How model routing works

Claude Code sends `claude-opus-...`, `claude-sonnet-...`, or
`claude-3-5-haiku-...`. The proxy:

1. Picks a provider chain — `ROUTE_HAIKU` / `ROUTE_SONNET` / `ROUTE_OPUS`
   if set for the matching tier, otherwise `PROVIDER`.
2. Picks an upstream model — `SMALL_MODEL` for `haiku`, `BIG_MODEL`
   otherwise (each provider has reasonable defaults).
3. Rotates API keys round-robin if the env var is comma-separated.
4. Calls the first provider in the chain. On 5xx / network error, tries
   the next. 4xx errors are returned to the client immediately
   (no retry — the request is bad).

---

## Troubleshooting

**`Missing API key for selected provider`** — you set `PROVIDER` to a
hosted backend without setting its API key.

**`401 unauthorized`** — `AUTH_TOKEN` is set in `.env` but the client
sent a different value.

**`upstream 404` from Cloudflare** — `BIG_MODEL` / `SMALL_MODEL` doesn't
exist on Workers AI. Check the model slug.

**Local provider connection refused** — server isn't running, or
`*_BASE_URL` is wrong. Defaults: LM Studio `:1234`, llama.cpp `:8080`,
Ollama `:11434`.

**Tool calls look broken** — switch to a model that natively supports
function calling (e.g. Llama 3.3 70B Instruct).

**Dashboard shows zero requests** — stats reset to `0` if
`.data/stats.json` is missing or unreadable. Make sure `.data/` is
writable.

---

## Acknowledgments

This project is a Node.js port of
[Alishahryar1/free-claude-code](https://github.com/Alishahryar1/free-claude-code)
by **Ali Shahryar**. The Anthropic ↔ OpenAI translation strategy, the
provider list, and the per-tier model routing idea all come from that
project. If this port is useful to you, please star the original too.

## License

MIT — same as the upstream project.
