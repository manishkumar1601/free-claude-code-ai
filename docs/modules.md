# Module-by-module walkthrough

Every JavaScript file in the project, what it does, and why it exists.

## `src/server.js` — Express application

The single entry point. Wires every other module together.

**Top of file** ([src/server.js:1-19](../src/server.js#L1-L19)) — imports
and `app.use(express.json({ limit: '50mb' }))`. The 50 MB limit is
deliberate: tool-use turns can carry large structured payloads
(file contents, screenshots-as-base64, etc.).

**`requireAuth` middleware** ([src/server.js:22-28](../src/server.js#L22-L28))
— if `AUTH_TOKEN` is unset, it's a no-op. Otherwise the token may
arrive as either `x-api-key: <token>` (Anthropic style) or
`Authorization: Bearer <token>` (OpenAI style). Both work.

**Public endpoints** (no auth):

| Route        | Purpose                                                |
|--------------|--------------------------------------------------------|
| `/health`    | Liveness probe — returns `{"ok": true}`                |
| `/dashboard` | Inline HTML page that polls `/stats`, `/info`, `/logs` |
| `/stats`     | Raw stats JSON                                         |
| `/info`      | Live config snapshot (provider, models, cache, …)      |
| `/logs`      | Last 50 lines of `logs/requests.jsonl` as plain text   |

**Anthropic-compatible endpoints** (auth):

| Route                          | Purpose                                       |
|--------------------------------|-----------------------------------------------|
| `GET /v1/models`               | Hardcoded list of Claude model names          |
| `POST /v1/messages/count_tokens`| Returns `{input_tokens: estimateTokens(body)}`|
| `POST /v1/messages`            | The real work — see [architecture.md](architecture.md) |

**Why a hardcoded model list?** Claude Code calls `/v1/models` to
populate its model picker. The proxy advertises the standard Claude
names regardless of which upstream is configured — the upstream model
gets resolved later by `routePlan`.

## `src/providers.js` — provider abstraction

Defines the seven supported backends and the routing logic.

**`pickKey(varName)`** ([src/providers.js:6-17](../src/providers.js#L6-L17))
— reads `process.env[varName]`, splits on `,`, and round-robins. The
counter lives on the function itself (`pickKey._counters`) so it
survives between calls without a module-scoped variable.

**`providers` object** ([src/providers.js:19-70](../src/providers.js#L19-L70))
— one entry per backend. Each has `baseUrl()`, `apiKey()`,
`requiresAuth`, `defaultBig`, `defaultSmall`. Function-valued fields
are evaluated lazily so env-var changes (in tests, for example) take
effect.

**`chainFor(claudeModel)`** ([src/providers.js:74-82](../src/providers.js#L74-L82))
— picks the provider chain. Looks at the model name for `haiku`,
`sonnet`, or `opus` and returns the matching `ROUTE_*` env var if set,
otherwise falls back to `PROVIDER`.

**`routePlan(claudeModel)`** ([src/providers.js:84-100](../src/providers.js#L84-L100))
— turns the chain into a list of concrete steps. Each step has the
`providerKey`, the provider definition, and the resolved
`upstreamModel`. Throws on unknown provider keys.

**`callUpstream(provider, body)`** ([src/providers.js:103-116](../src/providers.js#L103-L116))
— a single HTTP POST to `{baseUrl}/chat/completions` with the right
headers. Throws if the provider requires auth and no key is set.

**`callWithFallback(plan, buildBody)`** ([src/providers.js:123-146](../src/providers.js#L123-L146))
— the fallback engine. Iterates the plan, returning the first 2xx or
4xx response. Only 5xx/network errors trigger the next step. The
`buildBody` callback takes the upstream model name so the body can be
rebuilt with the right `model` field for each step.

## `src/translator.js` — Anthropic ↔ OpenAI

Three exported functions:

- `anthropicToOpenAI(req, upstreamModel)` — request shape conversion.
- `openAIToAnthropic(openaiRes, requestedModel)` — non-stream response.
- `streamOpenAIToAnthropic(upstreamRes, requestedModel, res)` —
  rewrites an OpenAI SSE stream into an Anthropic SSE stream as it
  flows.

The full conversion rules (system prompt, tools, tool_use, tool_result,
finish_reason mapping, …) are documented in
[translator.md](translator.md). The streaming details are in
[streaming.md](streaming.md). This file is the largest and trickiest
in the codebase.

## `src/tokens.js` — token estimator

Treats every English character as ¼ of a token and rounds up. Counts
the system prompt, every message's content (handling text /
tool_use / tool_result blocks), and every tool's name + description +
JSON schema.

This isn't accurate enough for billing, but Claude Code only uses the
result for context-window budgeting before sending a request — it
needs an *upper-bound-ish* number, fast, with no network call. That is
exactly what this delivers.

## `src/cache.js` — disk-backed response cache

**Enabled when `CACHE_TTL > 0`.** Streaming requests always bypass.

**Key** ([src/cache.js:14-25](../src/cache.js#L14-L25)) — SHA-256 of a
canonical JSON of the request: model, upstream model, system prompt,
messages, tools, temperature, max_tokens. Anything else (top_p,
stop_sequences, …) is currently ignored — change at your own risk.

**`getCached(req, upstreamModel)`** — reads `.data/cache/<hash>.json`,
checks `Date.now() - savedAt > TTL_SEC * 1000`, returns the cached
Anthropic response or `null`. Any read error is treated as a miss.

**`setCached(req, upstreamModel, response)`** — writes the same file.
Errors are logged but never propagate (cache is best-effort).

## `src/stats.js` — in-memory counters with periodic flush

State shape:

```js
{
  startedAt: ISO string,
  totals: { requests, inputTokens, outputTokens, cacheHits, errors },
  byProvider: { [provider]: { requests, inputTokens, outputTokens, errors } }
}
```

**`loadStats()`** is called once at boot. If `.data/stats.json` exists
it's merged with an `empty()` skeleton (so newer fields are filled in
on old saved files). On parse error, state resets to empty.

**`recordRequest({...})`** mutates state and sets a `dirty` flag. It is
*not* an `await` — the call site never blocks on disk I/O.

**Periodic flush** ([src/stats.js:47](../src/stats.js#L47)) — a 5-second
`setInterval` calls `persist()`, which is a no-op unless `dirty`. The
interval is `.unref()`-ed so it doesn't keep the process alive on its
own.

## `src/logger.js` — JSONL audit trail

**Enabled when `LOG_REQUESTS=true`.** When off, `logRequest()` returns
immediately — zero overhead.

When on, every request appends one line to `logs/requests.jsonl`:

```json
{"ts":"2026-...Z","model":"claude-...","provider":"cloudflare","upstream":"@cf/meta/llama-...","stream":false,"inputTokens":20,"outputTokens":12,"durationMs":830}
```

JSONL means each line is a complete object — easy to `tail -f`, easy
to ingest into anything (jq, BigQuery, etc.).

## `src/dashboard.js` — inline HTML page

A single exported `dashboardHtml` template literal (using
`String.raw` so the embedded JS doesn't need backslash-escaping).
Sent verbatim by the `/dashboard` route.

The page's client-side JS polls three endpoints every 5 s:

- `/stats` — totals + by-provider table.
- `/info` — current config (provider, models, cache, logging, auth).
- `/logs` — last 50 log lines (or empty string when logging is off).

Everything renders into three areas: the **Configuration** table, the
**Totals** tile row, and the **By provider** table. The recent-log
`<pre>` shows raw JSONL.

## `bots/telegram.js` — minimal Telegram client

Long-polls `getUpdates`, sends each text message to the proxy as a
single-turn chat, posts the model's reply back. Keeps the last 20
messages of context per chat ID. `/reset` wipes that chat's history.

It's **not a Claude Code substitute** — just a small example of what
talking to the proxy from another program looks like.

## `bots/discord.js` — minimal Discord client

Same idea but using `discord.js`. Optional dependency — fail-fast at
import time if not installed. Only responds to direct messages or to
messages that mention the bot. Splits replies into 1900-char chunks
(Discord caps messages at 2000 chars).

## `tests/translator.test.js` — translator unit tests

Uses Node's built-in `node:test` runner — zero extra deps. Covers:

- text-only requests
- string vs. array system prompts
- tools converted to OpenAI `function` format
- assistant `tool_use` becomes `tool_calls`
- user `tool_result` becomes `role: 'tool'` messages
- non-stream response conversion
- `tool_calls` becoming `tool_use` blocks
- `finish_reason` → `stop_reason` mapping

Streaming is *not* covered by tests because mocking SSE realistically
adds more complexity than it saves. If you change `streamOpenAIToAnthropic`,
exercise it against a real provider.

## `Dockerfile`

`node:20-alpine`, copies `package.json` + `src/`, runs
`npm install --omit=dev`. Exposes 3000.

The `bots/` and `tests/` directories are deliberately *not* copied —
the Docker image is the proxy only.

## `docker-compose.yml`

One service named `proxy`. Volumes:

- `./.data` → `/app/.data` — cache + persisted stats
- `./logs` → `/app/logs` — request log

The image is named `free-claude-code-ai` and the container also.
`PORT` defaults to 3000 but can be overridden.
