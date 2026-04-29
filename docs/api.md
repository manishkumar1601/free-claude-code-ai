# HTTP API reference

Every endpoint the proxy exposes, with example requests and responses.

Base URL is whatever you set for `PORT` (default `http://localhost:3000`).

## Auth

If `AUTH_TOKEN` is set in `.env`, **only** the `/v1/*` routes require it.
Send the value as either:

- `x-api-key: <token>` (Anthropic style — what Claude Code sends), or
- `Authorization: Bearer <token>` (OpenAI style).

The other routes (`/health`, `/info`, `/stats`, `/logs`, `/dashboard`)
are always open. Don't expose this server publicly without a reverse
proxy or firewall — those endpoints leak operational data.

## Endpoint summary

| Method | Path                          | Auth | Purpose                                |
|--------|-------------------------------|------|----------------------------------------|
| GET    | `/health`                     | no   | Liveness probe                         |
| GET    | `/info`                       | no   | Live config snapshot                   |
| GET    | `/stats`                      | no   | JSON stats (totals + per provider)     |
| GET    | `/logs`                       | no   | Last 50 log lines (plain text)         |
| GET    | `/dashboard`                  | no   | Live HTML dashboard                    |
| GET    | `/v1/models`                  | yes  | Hardcoded Claude model list            |
| POST   | `/v1/messages`                | yes  | Anthropic Messages API (streaming or not) |
| POST   | `/v1/messages/count_tokens`   | yes  | Rough char/4 token estimate            |

---

## `GET /health`

```bash
curl http://localhost:3000/health
```

```json
{ "ok": true }
```

Always 200. Use this in container orchestrators / process supervisors.

---

## `GET /info`

```bash
curl http://localhost:3000/info
```

```json
{
  "provider": "cloudflare,openrouter",
  "bigModel": "(provider default)",
  "smallModel": "(provider default)",
  "cache": "off",
  "logging": "on",
  "auth": "open"
}
```

A snapshot of the running configuration. Useful for debugging "what
exactly is this proxy doing right now?".

---

## `GET /stats`

```bash
curl http://localhost:3000/stats
```

```json
{
  "startedAt": "2026-04-29T10:11:12.345Z",
  "totals": {
    "requests": 17,
    "inputTokens": 4321,
    "outputTokens": 980,
    "cacheHits": 3,
    "errors": 1
  },
  "byProvider": {
    "cloudflare": { "requests": 14, "inputTokens": 4000, "outputTokens": 870, "errors": 0 },
    "openrouter": { "requests": 3,  "inputTokens": 321,  "outputTokens": 110, "errors": 1 }
  }
}
```

`startedAt` is the time the *first* `loadStats()` ran on a fresh
state — not necessarily this process's start, since stats persist
across restarts via `.data/stats.json`.

---

## `GET /logs`

```bash
curl http://localhost:3000/logs
```

Returns the last 50 lines of `logs/requests.jsonl` as plain text. If
`LOG_REQUESTS=false` or the file is empty/missing, returns an empty
body.

Each line is one complete JSON object:

```json
{"ts":"2026-04-29T10:11:12.345Z","model":"claude-3-5-sonnet-20241022","provider":"cloudflare","upstream":"@cf/meta/llama-3.3-70b-instruct-fp8-fast","stream":false,"inputTokens":42,"outputTokens":17,"durationMs":830}
```

---

## `GET /dashboard`

Returns an HTML page that polls `/stats`, `/info`, and `/logs` every
5 s and renders them. No auth, no static file — the markup is inlined
in [src/dashboard.js](../src/dashboard.js).

---

## `GET /v1/models`

```bash
curl http://localhost:3000/v1/models -H "x-api-key: $AUTH_TOKEN"
```

```json
{
  "data": [
    { "id": "claude-opus-4-20250514",     "type": "model", "display_name": "claude-opus-4-20250514" },
    { "id": "claude-sonnet-4-20250514",   "type": "model", "display_name": "claude-sonnet-4-20250514" },
    { "id": "claude-3-5-sonnet-20241022", "type": "model", "display_name": "claude-3-5-sonnet-20241022" },
    { "id": "claude-3-5-haiku-20241022",  "type": "model", "display_name": "claude-3-5-haiku-20241022" }
  ]
}
```

The list is hardcoded. The proxy doesn't *actually* run any of these
models — Claude Code uses the list to populate its model picker, and
the proxy then routes whatever model name comes back to the
configured upstream.

---

## `POST /v1/messages/count_tokens`

```bash
curl -X POST http://localhost:3000/v1/messages/count_tokens \
  -H "content-type: application/json" \
  -H "x-api-key: $AUTH_TOKEN" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "messages": [{"role":"user","content":"Hello there"}]
  }'
```

```json
{ "input_tokens": 3 }
```

Calls `estimateTokens(body)`. See [the tokens module](modules.md#srctokensjs--token-estimator)
for the algorithm.

---

## `POST /v1/messages`

The main endpoint. Accepts an [Anthropic Messages API][a] body and
returns either a single JSON response or an SSE stream.

[a]: https://docs.claude.com/en/api/messages

### Non-streaming

```bash
curl -X POST http://localhost:3000/v1/messages \
  -H "content-type: application/json" \
  -H "x-api-key: $AUTH_TOKEN" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 256,
    "messages": [{"role":"user","content":"Say hello in one word."}]
  }'
```

```json
{
  "id": "msg_a1b2c3d4...",
  "type": "message",
  "role": "assistant",
  "model": "claude-3-5-sonnet-20241022",
  "content": [
    { "type": "text", "text": "Hi." }
  ],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": { "input_tokens": 12, "output_tokens": 2 }
}
```

The `model` in the response is always the *requested* Claude name —
not the upstream model. See [translator.md](translator.md#openaitoanthropicopenaireturned-requestedmodel).

### Streaming

Same body, but with `"stream": true`:

```bash
curl -N -X POST http://localhost:3000/v1/messages \
  -H "content-type: application/json" \
  -H "x-api-key: $AUTH_TOKEN" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 256,
    "stream": true,
    "messages": [{"role":"user","content":"Hello"}]
  }'
```

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_...","role":"assistant",...}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}

event: message_stop
data: {"type":"message_stop"}
```

See [streaming.md](streaming.md) for the full event grammar.

### Tool use (function calling)

```bash
curl -X POST http://localhost:3000/v1/messages \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 256,
    "tools": [{
      "name": "get_weather",
      "description": "Get the current weather for a city.",
      "input_schema": {
        "type": "object",
        "properties": { "city": { "type": "string" } },
        "required": ["city"]
      }
    }],
    "messages": [{"role":"user","content":"What is the weather in NYC?"}]
  }'
```

A tool-using response looks like:

```json
{
  "id": "msg_...",
  "type": "message",
  "role": "assistant",
  "model": "claude-3-5-sonnet-20241022",
  "content": [
    { "type": "tool_use", "id": "toolu_...", "name": "get_weather", "input": { "city": "NYC" } }
  ],
  "stop_reason": "tool_use",
  "stop_sequence": null,
  "usage": { "input_tokens": 50, "output_tokens": 14 }
}
```

For tool results to flow back, the *next* request must include a
`tool_result` block in a user message:

```json
{
  "messages": [
    { "role": "user", "content": "What is the weather in NYC?" },
    { "role": "assistant", "content": [
      { "type": "tool_use", "id": "toolu_abc", "name": "get_weather", "input": {"city":"NYC"} }
    ]},
    { "role": "user", "content": [
      { "type": "tool_result", "tool_use_id": "toolu_abc", "content": "sunny, 70F" }
    ]}
  ]
}
```

See [translator.md](translator.md) for how this is converted to OpenAI's
flat `tool_calls` / `role: 'tool'` shape.

### Error responses

| Status | Shape                                                              | When                                          |
|--------|--------------------------------------------------------------------|-----------------------------------------------|
| 401    | `{"error":"unauthorized"}`                                         | `AUTH_TOKEN` set, client sent wrong/no token  |
| 4xx    | `{"type":"error","error":{"type":"upstream_error","message":"…"}}` | Upstream returned 4xx (passed through verbatim)|
| 500    | `{"type":"error","error":{"type":"internal_error","message":"…"}}` | Routing failed or all providers failed        |

For streaming, errors *before* any bytes are written use the JSON
shape above. After bytes start flowing, the stream is silently
terminated (`res.end()`) — there's no clean way to inject an error
event into a partially-written SSE response without breaking clients.
