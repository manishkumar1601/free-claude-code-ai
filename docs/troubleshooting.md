# Troubleshooting

Symptoms, causes, and fixes for the most common issues.

## Startup fails

### `Missing API key for selected provider`

You set `PROVIDER` (or one of `ROUTE_*`) to a hosted backend without
setting its API key. Map of `PROVIDER` → required env var:

| Provider     | Env var                                            |
|--------------|----------------------------------------------------|
| `cloudflare` | `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`   |
| `nvidia`     | `NVIDIA_API_KEY`                                   |
| `openrouter` | `OPENROUTER_API_KEY`                               |
| `deepseek`   | `DEEPSEEK_API_KEY`                                 |
| `lmstudio`   | (no auth needed — running locally)                 |
| `llamacpp`   | (no auth needed — running locally)                 |
| `ollama`     | (no auth needed — running locally)                 |

### `Unknown provider: <key>. Valid: ...`

Typo in `PROVIDER` or one of `ROUTE_*`. Valid names are listed in the
error message.

### `EADDRINUSE: address already in use :::3000`

Something else is already on port 3000 (often a previous instance
of the proxy). Either stop it (`lsof -i :3000` then `kill <pid>`) or
set `PORT=...` in `.env`.

### Process exits silently right after startup

99% of the time `.env` is missing or in the wrong directory. The
proxy reads `.env` from `process.cwd()` — make sure you're starting
from the project root.

## Request errors

### `401 unauthorized` from the proxy

`AUTH_TOKEN` is set in `.env` but the client sent a different value
(or no value). Either:

- Send the token as `x-api-key: <token>` or `Authorization: Bearer <token>`.
- Unset `AUTH_TOKEN` if you don't need auth.

### `401`/`403` from the upstream

Hosted providers reject the API key. Check:

- Key isn't expired or revoked (sign in to the provider's dashboard).
- Key has the right scope (Cloudflare's "Workers AI" template, etc.).
- If using comma-separated keys, every key is valid — bad keys cause
  intermittent 401s as the round-robin hits them.

### `upstream 404` from Cloudflare

`BIG_MODEL` / `SMALL_MODEL` doesn't exist on Workers AI. Cloudflare
model slugs look like `@cf/meta/llama-3.3-70b-instruct-fp8-fast` —
browse the catalogue at
<https://developers.cloudflare.com/workers-ai/models/>.

### `upstream 429`

Rate limit. Options:

- Set up multiple API keys (`KEY1,KEY2,KEY3`) for round-robin.
- Set up a fallback chain (`PROVIDER=cloudflare,openrouter`) so other
  providers handle the overflow.
- Wait.

The fallback chain does *not* retry on 4xx — including 429 — because
hammering a rate-limited provider with the same request just makes
it worse. The chain only moves on 5xx and network errors.

### `upstream 5xx` repeatedly

Provider outage. With a single-provider config the proxy returns 5xx
to the client too. Switch to a fallback chain so a different
provider handles requests when one is down.

### `all providers failed`

Every step in your `PROVIDER` chain returned a 5xx or threw. Could
be a network outage, DNS failure, or all providers genuinely down.
Check `/info` to see what chain is actually active and try each
provider directly with curl.

## Local provider issues

### `connect ECONNREFUSED 127.0.0.1:1234` (or :8080, :11434)

Local provider isn't running or is on a different port.

| Provider  | Default port | Default `*_BASE_URL`             |
|-----------|--------------|----------------------------------|
| LM Studio | 1234         | `http://localhost:1234/v1`       |
| llama.cpp | 8080         | `http://localhost:8080/v1`       |
| Ollama    | 11434        | `http://localhost:11434/v1`      |

### Local provider returns weird/empty responses

Some local servers don't fully implement the OpenAI chat-completions
shape. Common gotchas:

- **Tool calls** require a model that natively supports function
  calling (Llama 3.1+ instruct, Mistral with the right template).
  Smaller models will return `tool_calls: []` regardless of input.
- **Streaming chunks** from older llama.cpp builds may have different
  `delta` keys. Update llama.cpp to a recent build.

## Tool-use issues

### "The model isn't calling my tool"

Most likely the upstream model doesn't natively support function
calling. Try:

- Switching to a known-good model (Llama 3.3 70B Instruct, GPT-4o,
  Claude via OpenRouter).
- Verifying tool definitions look right with a `console.log` in
  `anthropicToOpenAI` and `openAIToAnthropic`.

### Tool arguments are malformed JSON

The translator wraps unparseable arguments in `{_raw: '...'}` so the
response still gets through. The cause is upstream-side: the model
returned a non-JSON string in `tool_calls[*].function.arguments`.
Switch to a smarter model or simpler tool schema.

## Streaming issues

### Stream "hangs" — no events arrive at the client

If a reverse proxy is in front, it might be **buffering** the SSE
response. Disable buffering:

- nginx: `proxy_buffering off;` and a long `proxy_read_timeout`.
- Caddy: `flush_interval -1` in `reverse_proxy`.

Also check that the client is actually reading the stream — `curl`
needs `-N` (`--no-buffer`) to print events as they arrive.

### Stream cuts off mid-response

Possible causes:

- Upstream's response time exceeded a reverse-proxy `read_timeout`.
- The model hit `max_tokens` and stopped (not a bug — set `max_tokens`
  higher).
- Network blip — check upstream provider status.

The proxy itself doesn't time out streams.

## Dashboard / observability issues

### Dashboard shows zero requests

`.data/stats.json` is unreadable or `.data/` isn't writable. Check:

```bash
ls -la .data/
cat .data/stats.json
```

If the file is missing the proxy resets to empty stats — fix
permissions and make sure the directory is writable.

### `/logs` returns empty

You haven't enabled `LOG_REQUESTS=true` in `.env`, or the file hasn't
been created yet (no requests logged so far).

### Stats look wrong / out of date

The persist interval is 5 s and only fires when state is dirty. If
you're hammering the proxy and reading `.data/stats.json` directly,
the file lags reality by up to 5 s. The `/stats` endpoint always
returns live in-memory state — use that for real-time.

## Cache issues

### Cache hits never happen

Check:

- `CACHE_TTL` is `> 0`. (Default `0` disables.)
- The request is **non-streaming**. Streaming always bypasses the cache.
- The request body is byte-identical to the cached one (model, system
  prompt, all messages, all tools, temperature, max_tokens).
- `.data/cache/` is writable.
- The cached entry hasn't expired (older than `CACHE_TTL` seconds).

### Cached response looks stale

Either:

- TTL is too long for your use case — lower it.
- Wipe the cache: `rm -rf .data/cache/`.

## Bot issues

### Telegram bot says nothing

- `TELEGRAM_BOT_TOKEN` set?
- Proxy actually running at `PROXY_URL`?
- Test the proxy directly with curl first.
- Check the bot's stdout — it logs every poll error.

### Discord bot says `discord.js is not installed`

Run `npm install discord.js`. It's an *optional* dep so it isn't
installed by default.

### Discord bot ignores messages

It only responds to DMs and to messages that **explicitly @-mention
the bot**. Plain channel messages are deliberately ignored.

## Debugging tips

- `curl http://localhost:3000/info` shows the live config.
- `curl http://localhost:3000/stats | jq` shows totals + per-provider
  counters.
- `tail -f logs/requests.jsonl | jq` is the fastest way to watch
  individual requests when `LOG_REQUESTS=true`.
- `npm run dev` reloads on save — fastest edit-test loop.
- Add a temporary `console.log` in the translator if a request looks
  weird — there's no other instrumentation in the conversion path.
