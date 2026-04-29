# Architecture

## The one-paragraph version

A client (Claude Code) makes an HTTPS POST to `/v1/messages` in
**Anthropic** format. The proxy converts the request body into
**OpenAI chat-completions** format, picks an upstream provider from
a configurable chain, forwards the request, then converts the
response — streaming or not — back into **Anthropic** format and
sends it to the client. Caching, key rotation, fallback retries,
stats, and an audit log all wrap this single core flow.

## Component diagram

```
                                        ┌──────────────────────────────────┐
                                        │           src/server.js          │
                                        │  Express app — all HTTP routes   │
                                        └──────────────────┬───────────────┘
                                                           │
        ┌──────────────────────────┬───────────────────────┼────────────────────────┬──────────────────────┐
        ▼                          ▼                       ▼                        ▼                      ▼
┌───────────────┐         ┌────────────────┐      ┌─────────────────┐      ┌────────────────┐     ┌────────────────┐
│ tokens.js     │         │ cache.js       │      │ translator.js   │      │ providers.js   │     │ stats.js       │
│ rough         │         │ disk cache for │      │ Anthropic ↔     │      │ provider list, │     │ in-memory      │
│ char/4 token  │         │ non-streaming  │      │ OpenAI request  │      │ fallback chain │     │ counters,      │
│ estimator     │         │ responses      │      │ + SSE rewrite   │      │ key rotation   │     │ persisted JSON │
└───────────────┘         └────────────────┘      └─────────────────┘      └────────┬───────┘     └────────────────┘
                                                                                    │
                                                                                    ▼
                                                                          ┌────────────────────┐
                                                                          │   upstream HTTPS   │
                                                                          │ (Cloudflare, etc.) │
                                                                          └────────────────────┘

┌────────────────┐    ┌────────────────┐
│ logger.js      │    │ dashboard.js   │
│ JSONL audit    │    │ inline HTML    │
│ trail          │    │ for /dashboard │
└────────────────┘    └────────────────┘
```

Optional, separate processes:

```
┌──────────────────┐         HTTP        ┌──────────────────┐
│ bots/telegram.js │ ──────────────────► │  proxy /v1/      │
│ bots/discord.js  │ ◄────────────────── │  messages        │
└──────────────────┘                     └──────────────────┘
```

The bots are not part of the proxy itself; they are *example clients*.

## Lifecycle of a request to `/v1/messages`

This is the single most important flow in the project. The numbered
steps map 1:1 to lines in [src/server.js](../src/server.js).

1. **Express receives the POST.** Body is parsed as JSON
   (limit 50 MB — large enough for big tool-use payloads).
   See [src/server.js:79](../src/server.js#L79).

2. **Auth check** via `requireAuth`. If `AUTH_TOKEN` is set in `.env`,
   the request must carry it as `x-api-key` or `Authorization: Bearer …`.
   Off by default. See [src/server.js:22-28](../src/server.js#L22-L28).

3. **Token estimate.** `estimateTokens()` walks the request body and
   returns `Math.ceil(chars / 4)` — fast, no model needed, accurate
   enough for Claude Code's pre-flight context-budget checks.
   See [src/tokens.js](../src/tokens.js).

4. **Route plan.** `routePlan(model)` returns an ordered list of
   `{providerKey, provider, upstreamModel}` steps. The list is built
   from `ROUTE_HAIKU` / `ROUTE_SONNET` / `ROUTE_OPUS` if set for the
   matching tier, otherwise from `PROVIDER`. The upstream model name
   is `SMALL_MODEL` for haiku, `BIG_MODEL` otherwise (each provider
   has reasonable defaults).
   See [src/providers.js:84-100](../src/providers.js#L84-L100).

5. **Cache check** (only if `CACHE_TTL > 0` and the request is
   non-streaming). Cache key is a SHA-256 of
   `{model, upstream, system, messages, tools, temperature, max_tokens}`.
   On hit, the cached Anthropic response is returned immediately and
   stats record a `cacheHit`. See [src/cache.js](../src/cache.js).

6. **Build the upstream body.** `anthropicToOpenAI(req, upstreamModel)`
   produces the OpenAI-format JSON. The system prompt becomes a
   `role: 'system'` message, `tool_use` blocks become `tool_calls`,
   `tool_result` blocks become `role: 'tool'` messages.
   See [translator.md](translator.md) for the full conversion table.

7. **Call the chain.** `callWithFallback(plan, buildBody)` walks the
   chain. On 2xx, returns immediately. On 4xx, returns immediately
   (no point retrying — the request is bad). On 5xx or network
   error, tries the next step in the chain. If every step fails,
   throws.
   See [src/providers.js:123-146](../src/providers.js#L123-L146).

8. **Convert and respond.**
   - **Non-streaming**: read the upstream JSON, run
     `openAIToAnthropic()`, write to cache, send to client.
   - **Streaming**: set SSE headers and pump the upstream body
     through `streamOpenAIToAnthropic()`, which emits Anthropic-style
     events (`message_start`, `content_block_*`, `message_delta`,
     `message_stop`) line-by-line as upstream chunks arrive.
   See [streaming.md](streaming.md).

9. **Record.** `recordRequest()` updates in-memory totals and the
   per-provider bucket (persisted to `.data/stats.json` every 5 s).
   `logRequest()` appends one JSONL line to `logs/requests.jsonl`
   *only* if `LOG_REQUESTS=true`.

10. **Done.** Total wall-clock time is included in the log entry.

## Lifecycle of a request that fails

- **Auth fails** → `401 unauthorized`. No upstream call, no log entry.
- **Unknown provider key** → `500` with the available provider names.
  No upstream call.
- **Cache hit, but cache file unreadable** → silently treated as a miss.
- **Upstream 4xx** → returned to the client verbatim wrapped in an
  Anthropic-style `error` object. No fallback retry.
- **Upstream 5xx or network error** → next step in chain tried; if all
  fail, last error is thrown and surfaces as a `500 internal_error`.
- **Streaming response, error mid-stream** — already-sent bytes are
  preserved; the connection is `res.end()`-ed without an error JSON
  body (response headers are already on the wire).

## Why this shape?

A few design choices that aren't obvious from reading the code:

- **No queue, no worker pool.** Express handles each request inline.
  Concurrency is whatever Node's event loop + `fetch` can do (plenty
  for a personal proxy; not designed as a multi-tenant gateway).
- **Disk-backed state, not a database.** `.data/stats.json` and the
  cache directory exist purely so a restart doesn't lose history.
  No SQLite, no Redis — a single Node process owns the file.
- **No transformer layer between server and translator.** The server
  passes the raw Anthropic body straight to the translator, and the
  translator's output is sent unchanged upstream. There's no
  middleware abstraction because there's nothing to middleware.
- **The dashboard is one inline HTML string.** No build step, no
  framework, no static directory. The page polls `/stats`, `/info`,
  and `/logs` every 5 s.
- **Tests cover only the translator.** That's the only piece with
  enough subtlety to break in a non-obvious way; everything else is
  thin glue around `fetch`.
