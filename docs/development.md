# Development

Notes for anyone editing the codebase.

## Prerequisites

- **Node.js 18+** — uses built-in `fetch` and the Web Streams API.
  Node 18.11+ for `--watch` mode in dev.
- A `.env` file with at least one provider configured.

## Scripts

```bash
npm start            # node src/server.js
npm run dev          # node --watch src/server.js (restart on change)
npm test             # node --test tests
npm run bot:telegram # node bots/telegram.js
npm run bot:discord  # node bots/discord.js  (requires `npm i discord.js`)
```

## Dependencies

| Package      | Version    | Why                                                        |
|--------------|------------|------------------------------------------------------------|
| `express`    | `^4.19.2`  | HTTP routing — the only non-trivial framework dep          |
| `dotenv`     | `^16.4.5`  | Reads `.env` at startup                                    |
| `discord.js` | `^14.16.0` | **optional** — only loaded by the Discord bot              |

That's it. No bundler, no transpiler, no linter, no test framework.
Tests use Node's built-in `node:test`.

## Project conventions

- **Plain ES modules.** `package.json` declares `"type": "module"`,
  every `import` uses an explicit `.js` extension.
- **No TypeScript.** The codebase is small enough that it isn't worth
  the build step. Add JSDoc types if you want autocomplete.
- **No build step.** What's in `src/` is what runs.
- **No frameworks beyond Express.** Don't add React/Vue/Svelte for the
  dashboard — it's intentionally one HTML string.
- **One file per concern.** Modules are short (rarely >300 lines).
  Split before adding a second concern to a file.
- **Best-effort I/O.** Cache writes, log writes, and stats flushes
  catch errors and log them — they never propagate.

## Running tests

```bash
npm test
```

Uses Node's built-in `node:test` runner. Output is TAP-ish:

```
TAP version 13
ok 1 - anthropic -> openai: simple text
ok 2 - anthropic -> openai: string system prompt becomes a system message
...
1..9
# tests 9
# pass 9
```

If you change the translator, add a test for the new behavior in
[tests/translator.test.js](../tests/translator.test.js) before fixing
the bug.

## Things to know when editing each module

### Editing `server.js`

- The 50 MB body limit on `express.json()` is deliberate — tool calls
  with large structured payloads need it. Don't lower it without
  checking.
- The `requireAuth` middleware accepts both `x-api-key` and
  `Authorization: Bearer …`. Don't drop one of them; both are in use
  by real clients.
- Any new route handler should call `recordRequest()` and
  `logRequest()` at the right places — both happen in `/v1/messages`
  for every outcome (cache hit, success, upstream error, internal
  error).

### Editing `translator.js`

- Round-trip cases are non-obvious. **Add a unit test first.**
- The streaming code keeps state across chunks (`textBlockOpen`,
  `toolBlocks`, `nextIndex`, …). Don't refactor it into a state
  machine without strong reason — the current shape mirrors the
  data flow.
- `mapStopReason` is deliberately a switch with a default —
  unfamiliar `finish_reason` values become `end_turn` rather than
  bubbling through.

### Editing `providers.js`

- `pickKey` stores its counter on the function itself. This is on
  purpose so the round-robin survives across calls without a module-
  scoped variable. Don't extract the state — keep it co-located.
- Provider entries' `baseUrl()` and `apiKey()` are functions, not
  strings. Don't eagerly resolve them at module load — env-var
  changes (e.g. tests overriding `process.env`) won't take effect.
- Adding a new provider: add an entry to `providers`, add the env
  vars to `.env.example`, add a row to the README's provider matrix,
  and update [docs/providers.md](providers.md).

### Editing `cache.js`

- Cache key fields are listed explicitly in `keyFor()`. If you add a
  field to the request that affects the response (e.g. `top_p`),
  add it to the key, or you'll serve stale wrong answers.
- Streaming requests bypass the cache. Don't try to cache SSE — it
  doesn't work.

### Editing `stats.js`

- `recordRequest` is sync. Don't make it async without auditing the
  call sites.
- The 5-second flush interval is a `setInterval` — `.unref()`-ed so
  it doesn't keep the process alive on its own. Don't remove the
  `.unref()`.

### Editing `dashboard.js`

- The HTML is a `String.raw` template. Backslashes are literal — you
  do not need `\\n` etc.
- Inline `<script>` polls every 5 s. The page is not styled with any
  framework — keep it simple.

## Adding new endpoints

1. Decide if it needs auth. `/v1/*` does; everything else doesn't.
2. Add the handler in `server.js`. If it touches stats, call
   `recordRequest()`. If it touches the upstream, use
   `callWithFallback`.
3. Document it in [docs/api.md](api.md).
4. (Optional) Surface it in the dashboard.

## Adding new providers

1. Add an entry to `providers` in `src/providers.js` with `baseUrl`,
   `apiKey`, `requiresAuth`, `defaultBig`, `defaultSmall`.
2. Add the env vars to `.env.example` with comments.
3. Add a row to the provider matrix in the README.
4. Add a setup section to [docs/providers.md](providers.md) and
   [docs/configuration.md](configuration.md).
5. Smoke test: `PROVIDER=newone npm start && curl …`.

The provider must already speak OpenAI-compatible
`/chat/completions`. If it speaks something else (Anthropic-native,
Cohere, Vertex's REST shape, …), you'd need a per-provider
translator — out of scope for this proxy.

## Style

- Two-space indent.
- Single-quoted strings except where escaping a `'` matters.
- Semicolons.
- No trailing commas in function calls; trailing commas in arrays /
  objects when multi-line.
- `function` declarations for top-level utilities; arrow functions
  for inline callbacks.
- One concept per file. If you find yourself opening more than three
  files to make one change, the abstraction is wrong.

## What not to add

- A web framework. Express is enough.
- A database. The state we have fits in a JSON file.
- TypeScript. Adds a build step the project doesn't need.
- A logger library (winston/pino). The current `console.log`/`console.error`
  is sufficient and goes to stdout/stderr like every other process.
- An ORM. We have no SQL.
- A queue. We have no async work.
