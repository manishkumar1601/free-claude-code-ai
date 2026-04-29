# Configuration reference

Every environment variable, what it does, defaults, and how variables
interact.

All config lives in `.env` — see [.env.example](../.env.example) for a
template you can copy. The proxy reads `.env` via `dotenv` at startup
([src/server.js:1](../src/server.js#L1)).

## Routing

| Variable        | Default         | Description                                            |
|-----------------|-----------------|--------------------------------------------------------|
| `PROVIDER`      | `cloudflare`    | One name OR comma-separated fallback chain             |
| `ROUTE_OPUS`    | (uses PROVIDER) | Override chain for Opus traffic                        |
| `ROUTE_SONNET`  | (uses PROVIDER) | Override chain for Sonnet traffic                      |
| `ROUTE_HAIKU`   | (uses PROVIDER) | Override chain for Haiku traffic                       |
| `BIG_MODEL`     | provider default| Upstream model name for opus/sonnet                    |
| `SMALL_MODEL`   | provider default| Upstream model name for haiku                          |

Valid provider keys: `cloudflare`, `nvidia`, `openrouter`, `deepseek`,
`lmstudio`, `llamacpp`, `ollama`.

Tier detection is substring matching on the requested Claude model
name (`opus`, `sonnet`, `haiku`). See [providers.md](providers.md).

### Examples

```ini
# Single hosted provider
PROVIDER=cloudflare

# Fallback chain — try cloudflare first, openrouter on 5xx, deepseek if both fail
PROVIDER=cloudflare,openrouter,deepseek

# Different providers per tier (small models locally, big models hosted)
PROVIDER=cloudflare
ROUTE_HAIKU=ollama

# Mix providers + override the model name
PROVIDER=openrouter
BIG_MODEL=anthropic/claude-3.5-sonnet
SMALL_MODEL=anthropic/claude-3-haiku
```

`BIG_MODEL` / `SMALL_MODEL` apply across **all providers in the chain**,
so make sure the model name actually exists on each provider you list.

## Server

| Variable        | Default | Description                                          |
|-----------------|---------|------------------------------------------------------|
| `PORT`          | `3000`  | Listen port                                          |
| `AUTH_TOKEN`    | (empty) | Optional shared secret. If set, clients must send it |
| `LOG_REQUESTS`  | `false` | Append each request to `logs/requests.jsonl`         |
| `CACHE_TTL`     | `0`     | Cache non-streaming responses on disk for N seconds  |

`AUTH_TOKEN` only protects `/v1/*` routes. The dashboard, stats, info,
and logs endpoints are always open — don't expose this server publicly
without a reverse proxy.

## Cloudflare Workers AI

```ini
PROVIDER=cloudflare
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...
BIG_MODEL=@cf/meta/llama-3.3-70b-instruct-fp8-fast
SMALL_MODEL=@cf/meta/llama-3.1-8b-instruct
```

`CLOUDFLARE_API_TOKEN` may be a comma-separated list — see
[Key rotation](#key-rotation) below. Browse model slugs at
<https://developers.cloudflare.com/workers-ai/models/>.

## NVIDIA NIM

| Variable          | Default                                   |
|-------------------|-------------------------------------------|
| `NVIDIA_API_KEY`  | (required)                                |
| `NVIDIA_BASE_URL` | `https://integrate.api.nvidia.com/v1`     |

Get a key at <https://build.nvidia.com/>.

## OpenRouter

| Variable             | Default     |
|----------------------|-------------|
| `OPENROUTER_API_KEY` | (required)  |

## DeepSeek

| Variable           | Default     |
|--------------------|-------------|
| `DEEPSEEK_API_KEY` | (required)  |

## LM Studio (local)

| Variable             | Default                       |
|----------------------|-------------------------------|
| `LMSTUDIO_BASE_URL`  | `http://localhost:1234/v1`    |
| `LMSTUDIO_MODEL`     | `local-model`                 |

## llama.cpp (local)

| Variable             | Default                       |
|----------------------|-------------------------------|
| `LLAMACPP_BASE_URL`  | `http://localhost:8080/v1`    |
| `LLAMACPP_MODEL`     | `local-model`                 |

## Ollama (local)

| Variable             | Default                       |
|----------------------|-------------------------------|
| `OLLAMA_BASE_URL`    | `http://localhost:11434/v1`   |
| `OLLAMA_MODEL`       | `llama3.1`                    |

## Bots

These are read by `bots/telegram.js` and `bots/discord.js`, *not* by
the proxy itself.

| Variable                | Default                                | Used by    |
|-------------------------|----------------------------------------|------------|
| `TELEGRAM_BOT_TOKEN`    | (empty)                                | telegram   |
| `DISCORD_BOT_TOKEN`     | (empty)                                | discord    |
| `PROXY_URL`             | `http://localhost:3000`                | both       |
| `ANTHROPIC_AUTH_TOKEN`  | (empty)                                | both       |
| `BOT_MODEL`             | `claude-3-5-sonnet-20241022`           | both       |

`ANTHROPIC_AUTH_TOKEN` only matters if the proxy has `AUTH_TOKEN` set.

## Key rotation

Any hosted-provider API key may be a comma-separated list. The proxy
round-robins between them on each request:

```ini
CLOUDFLARE_API_TOKEN=key1,key2,key3
```

Each env var has its own counter. This is **not** automatic failover —
if a key is revoked, requests using it will 401 and the fallback chain
will move to the next *provider*, not the next key.

## How the variables interact

Reading priority for "what provider chain am I using?":

1. `ROUTE_HAIKU` / `ROUTE_SONNET` / `ROUTE_OPUS` for the matching tier,
   if non-empty.
2. `PROVIDER`.
3. Hardcoded fallback `cloudflare`.

Reading priority for "what upstream model name do I send?":

1. `SMALL_MODEL` (haiku) or `BIG_MODEL` (sonnet/opus), if non-empty.
2. The provider's `defaultSmall` / `defaultBig`.

For local providers the `defaultBig` / `defaultSmall` are themselves
defined as env-var lookups (`OLLAMA_MODEL` etc.), so they cascade one
level further.

## Production checklist

- [ ] `AUTH_TOKEN` set to a long random string.
- [ ] Reverse proxy (nginx, Caddy, Cloudflare Tunnel, …) terminates TLS.
- [ ] Server is bound to localhost or otherwise firewalled — only the
      reverse proxy reaches port 3000.
- [ ] `PROVIDER` is a fallback chain, not a single provider.
- [ ] `LOG_REQUESTS=true` if you want an audit trail.
- [ ] `CACHE_TTL` set to something nonzero if you have repeating
      requests (e.g. `300` for 5-min cache).
- [ ] `.data/` and `logs/` are on persistent storage (mounted volumes
      in Docker).
