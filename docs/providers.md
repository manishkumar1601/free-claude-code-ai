# Providers, routing, and fallback

How the proxy decides *who* to call, *which model* to ask for, and
*what to do when that fails*.

Source: [src/providers.js](../src/providers.js).

## The seven backends

| Key          | Type   | Default base URL                                              | Auth env var                                       |
|--------------|--------|---------------------------------------------------------------|----------------------------------------------------|
| `cloudflare` | hosted | `https://api.cloudflare.com/client/v4/accounts/{id}/ai/v1`    | `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`   |
| `nvidia`     | hosted | `https://integrate.api.nvidia.com/v1`                         | `NVIDIA_API_KEY`                                   |
| `openrouter` | hosted | `https://openrouter.ai/api/v1`                                | `OPENROUTER_API_KEY`                               |
| `deepseek`   | hosted | `https://api.deepseek.com/v1`                                 | `DEEPSEEK_API_KEY`                                 |
| `lmstudio`   | local  | `http://localhost:1234/v1`                                    | none                                               |
| `llamacpp`   | local  | `http://localhost:8080/v1`                                    | none                                               |
| `ollama`     | local  | `http://localhost:11434/v1`                                   | none                                               |

Each entry in the `providers` object
([src/providers.js:19-70](../src/providers.js#L19-L70)) has the same
shape:

```js
{
  baseUrl: () => string,        // evaluated lazily so env edits take effect
  apiKey: () => string,         // returns '' if none / not required
  requiresAuth: boolean,        // throw if true and apiKey() === ''
  defaultBig: string,           // used for opus/sonnet if BIG_MODEL unset
  defaultSmall: string,         // used for haiku if SMALL_MODEL unset
}
```

## Provider chain

`PROVIDER` may be a single name or a comma-separated chain:

```ini
PROVIDER=cloudflare              # single
PROVIDER=cloudflare,openrouter   # try cloudflare, fall back to openrouter on 5xx
```

Per-tier overrides supersede `PROVIDER`:

```ini
ROUTE_OPUS=openrouter
ROUTE_SONNET=cloudflare,openrouter
ROUTE_HAIKU=cloudflare
```

Tier detection is purely substring matching on the model name:

```js
if (name.includes('haiku'))      raw = env('ROUTE_HAIKU');
else if (name.includes('sonnet')) raw = env('ROUTE_SONNET');
else if (name.includes('opus'))   raw = env('ROUTE_OPUS');
raw = raw || env('PROVIDER', 'cloudflare');
```

So a model name like `claude-opus-4-7` would match the `opus` tier;
`claude-3-5-haiku-20241022` matches `haiku`; etc.

## Upstream model selection

For each step in the chain, `routePlan` resolves the upstream model:

- If the *requested* Claude model contains `haiku`, use
  `SMALL_MODEL` env var; if unset, the provider's `defaultSmall`.
- Otherwise, use `BIG_MODEL`; if unset, the provider's `defaultBig`.

The result is one `{providerKey, provider, upstreamModel}` per step.

### Defaults per provider

| Provider     | `defaultBig`                                  | `defaultSmall`                          |
|--------------|-----------------------------------------------|------------------------------------------|
| cloudflare   | `@cf/meta/llama-3.3-70b-instruct-fp8-fast`    | `@cf/meta/llama-3.1-8b-instruct`         |
| nvidia       | `meta/llama-3.3-70b-instruct`                 | `meta/llama-3.1-8b-instruct`             |
| openrouter   | `anthropic/claude-3.5-sonnet`                 | `anthropic/claude-3-haiku`               |
| deepseek     | `deepseek-chat`                               | `deepseek-chat`                          |
| lmstudio     | `LMSTUDIO_MODEL` env, fallback `local-model`  | same                                     |
| llamacpp     | `LLAMACPP_MODEL` env, fallback `local-model`  | same                                     |
| ollama       | `OLLAMA_MODEL` env, fallback `llama3.1`       | same                                     |

If you set `BIG_MODEL` / `SMALL_MODEL` they apply *across all
providers in the chain*. So if you mix providers in a chain, make
sure the model name you choose actually exists on each.

## Key rotation

Any hosted-provider API key may be a comma-separated list:

```ini
CLOUDFLARE_API_TOKEN=key1,key2,key3
```

`pickKey('CLOUDFLARE_API_TOKEN')` round-robins between them. The
counter lives on `pickKey._counters` so it survives between calls
without needing module-scoped state. Each env var has its own counter.

This is useful when you have multiple free accounts and want to
spread quota usage. It is **not** automatic failover — if `key2` is
revoked, requests using it will 401 and the fallback chain will
*not* try the next key (it'll move to the next provider instead).

## The fallback chain in action

`callWithFallback` ([src/providers.js:123-146](../src/providers.js#L123-L146)):

```js
for (const step of plan) {
  try {
    const body = buildBody(step.upstreamModel);
    const res = await callUpstream(step.provider, body);
    if (res.ok)             return { res, step };  // 2xx → done
    if (res.status >= 400 && res.status < 500)
                            return { res, step };  // 4xx → done, no retry
    // 5xx → try next
  } catch (err) {
    // network error → try next
  }
}
throw lastErr || new Error('all providers failed');
```

Notes:

- 4xx is *not* retried. A 401/403/404/429 from one provider is almost
  never fixed by trying the next — and silently retrying could double
  your spend.
- 5xx and `fetch` exceptions (DNS failure, ECONNREFUSED, …) *are*
  retried.
- Streaming requests can still benefit from fallback **before** any
  bytes are read. Once the body is handed back, the caller owns it
  and we cannot retry without losing what was streamed.
- Each retry rebuilds the body via `buildBody(upstreamModel)` so the
  `model` field can change per step.

## Worked example

```ini
PROVIDER=cloudflare,openrouter
BIG_MODEL=
SMALL_MODEL=
```

A request for `claude-3-5-sonnet-20241022`:

1. Tier check — name contains `sonnet`. `ROUTE_SONNET` empty, so use
   `PROVIDER` → `['cloudflare', 'openrouter']`.
2. Not haiku, so use `BIG_MODEL`. Unset, so per-provider defaults:
   - cloudflare → `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
   - openrouter → `anthropic/claude-3.5-sonnet`
3. Build body with cloudflare's upstream model. POST.
4. Cloudflare returns 503. Logged: `upstream 503 from cloudflare —
   trying next provider`.
5. Build body with openrouter's upstream model. POST.
6. OpenRouter returns 200. Return that response.

A request for `claude-3-5-haiku-20241022` with the same config would
use `defaultSmall` instead (`@cf/meta/llama-3.1-8b-instruct` and
`anthropic/claude-3-haiku`).
