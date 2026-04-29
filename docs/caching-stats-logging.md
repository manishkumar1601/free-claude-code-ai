# Caching, stats, and logging

Three small subsystems handle observability and persistence. Each is
independently toggleable — by default, only stats are on.

## Caching

**Module:** [src/cache.js](../src/cache.js)
**Toggle:** `CACHE_TTL` (seconds, `0` = off)

### What gets cached

Only **non-streaming** `/v1/messages` responses. Streaming requests
always bypass.

The cache key is a SHA-256 hash of:

```js
{
  model: req.model,             // requested Claude model
  upstream: upstreamModel,      // resolved upstream model
  system: req.system || null,
  messages: req.messages || [],
  tools: req.tools || [],
  temperature: req.temperature ?? null,
  max_tokens: req.max_tokens ?? null,
}
```

Other fields (`top_p`, `stop_sequences`, etc.) are **not** in the key
and will produce identical cache entries. If that matters for you,
edit `keyFor()` in [src/cache.js:14](../src/cache.js#L14).

### Files

```
.data/cache/
├── 0123abc...def.json
├── 0456ghi...uvw.json
└── ...
```

Each file:

```json
{
  "savedAt": 1714400000000,
  "response": { /* full Anthropic-format response */ }
}
```

A read is a hit if `Date.now() - savedAt <= TTL_SEC * 1000`. Stale
entries are *not* deleted automatically — they're just ignored on
read. If the cache directory grows too large, delete it (or the whole
`.data/` folder) and restart.

### Best-effort writes

Cache write failures are logged but never propagated. If your disk
fills up or `.data/` is read-only, the proxy keeps working — just
without caching.

## Stats

**Module:** [src/stats.js](../src/stats.js)
**Toggle:** always on (no env var)

### What gets counted

```js
{
  startedAt: ISO string,
  totals: {
    requests: number,
    inputTokens: number,
    outputTokens: number,
    cacheHits: number,
    errors: number
  },
  byProvider: {
    [providerKey]: {
      requests: number,
      inputTokens: number,
      outputTokens: number,
      errors: number
    }
  }
}
```

`recordRequest()` is called inside `/v1/messages` after every outcome
(cache hit, success, upstream error, internal error). Tokens are
the values from `estimateTokens()` for input and from the upstream
response (or estimated from streamed text) for output.

### Persistence

State lives in memory and is flushed to `.data/stats.json` every 5
seconds *only if dirty*. The interval is `.unref()`-ed so it doesn't
keep the process alive on its own.

On boot, `loadStats()` merges the saved file into a fresh `empty()`
template — if the schema gains a new field, old saves still load.

### Reset

To wipe stats, delete `.data/stats.json` and restart. The
`startedAt` timestamp is regenerated.

### Failure modes

- **`.data/` not writable** — flush logs an error and re-flags
  `dirty`. Counters in memory keep working.
- **Corrupt JSON on load** — caught silently, state resets to empty.

## Logging

**Module:** [src/logger.js](../src/logger.js)
**Toggle:** `LOG_REQUESTS` (must be the literal string `true`)

### Format

JSONL — one JSON object per line. Each entry has at minimum:

```json
{
  "ts": "2026-04-29T10:11:12.345Z",
  "model": "claude-3-5-sonnet-20241022",
  "provider": "cloudflare",
  "upstream": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "stream": false,
  "inputTokens": 42,
  "outputTokens": 17,
  "durationMs": 830
}
```

Additional fields appear when relevant:

- `cacheHit: true` on cache hits.
- `status: 4xx`, `error: '<truncated upstream message>'` on upstream
  errors.
- `error: '<message>'` on internal errors (no `status`).

### File location

`logs/requests.jsonl` (relative to the working directory). Created on
first write. Tailing:

```bash
tail -f logs/requests.jsonl | jq .
```

The dashboard's `/logs` endpoint returns the last 50 lines as plain
text — no parsing.

### Rotation

There is **no built-in log rotation**. If you log a lot, set up
`logrotate` or similar externally. Suggested config:

```
/path/to/free-claude-code-ai/logs/requests.jsonl {
    daily
    rotate 7
    compress
    missingok
    notifempty
    copytruncate
}
```

The `copytruncate` mode is important — the proxy holds the file open
in append mode, so a rename-and-recreate would leave it writing to
the rotated file.

### What logging costs

`logRequest()` is `await`-ed but the underlying `appendFile` is fast.
On a SSD with light traffic, expect <1 ms overhead per request. On
slow storage or under heavy load, the file I/O can become a bottleneck —
consider disabling logging if throughput matters more than auditing.

## Storage layout summary

```
free-claude-code-ai/
├── .data/                     # always created on first stats flush
│   ├── stats.json             # in-memory state, persisted every 5s
│   └── cache/                 # only created if CACHE_TTL > 0
│       └── <sha256>.json
└── logs/                      # only created if LOG_REQUESTS=true
    └── requests.jsonl
```

Both directories are listed in [.gitignore](../.gitignore) and
mounted as Docker volumes in [docker-compose.yml](../docker-compose.yml).
