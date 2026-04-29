# free-claude-code-ai — Documentation

This folder contains the full developer documentation for the project.
The top-level [README](../README.md) is the *user-facing* quick-start;
everything in here goes deeper — code walkthroughs, request flow,
protocol translation details, and module-by-module reference.

## What is this project?

`free-claude-code-ai` is a small Node.js HTTP proxy that **speaks the
Anthropic Messages API on the front and any OpenAI-compatible
`/chat/completions` endpoint on the back**. It exists so that
[Claude Code](https://docs.claude.com/en/docs/claude-code) — and any
other Anthropic-API client — can be pointed at *free* or *self-hosted*
LLM providers (Cloudflare Workers AI, NVIDIA NIM, OpenRouter, DeepSeek,
LM Studio, llama.cpp, Ollama) without changing the client.

The proxy is intentionally tiny: two runtime dependencies
(`express`, `dotenv`), no build step, no transpilation, plain ES modules
on Node 18+.

## Reading order

If you are new to the codebase, read these in order:

1. **[architecture.md](architecture.md)** — the big picture.
   Components, request flow, lifecycle of a single call.
2. **[modules.md](modules.md)** — file-by-file walkthrough of `src/`
   and `bots/` with line references.
3. **[translator.md](translator.md)** — Anthropic ↔ OpenAI conversion
   in detail. This is the most subtle part of the codebase.
4. **[streaming.md](streaming.md)** — how the SSE stream is rewritten
   chunk-by-chunk.
5. **[providers.md](providers.md)** — provider abstraction, fallback
   chain, key rotation, per-tier routing.
6. **[api.md](api.md)** — every HTTP endpoint with request/response
   examples.
7. **[configuration.md](configuration.md)** — every environment
   variable, what it does, and how to combine them.
8. **[caching-stats-logging.md](caching-stats-logging.md)** —
   observability and persistence (the `.data/` and `logs/` folders).
9. **[bots.md](bots.md)** — the optional Telegram and Discord clients.
10. **[deployment.md](deployment.md)** — Docker, env files,
    production-style setup.
11. **[development.md](development.md)** — running tests, the dev
    server, what to know when contributing.
12. **[troubleshooting.md](troubleshooting.md)** — common errors and
    their causes.

## Glossary

A small dictionary of terms used throughout the docs:

- **Upstream** — the actual LLM provider the proxy forwards to
  (Cloudflare, OpenRouter, etc.). The proxy is *downstream* of those.
- **Client** — the program calling the proxy (Claude Code, a curl
  command, the Telegram bot, …). The proxy is *upstream* of those.
- **Tier** — the Claude model class: `opus`, `sonnet`, or `haiku`.
  The proxy decides routing based on which tier appears in the
  `model` field.
- **Provider chain / fallback chain** — a comma-separated list of
  provider keys (e.g. `cloudflare,openrouter`). Tried in order on
  5xx / network errors.
- **Tool use / function calling** — a turn where the model emits a
  structured call to a named function instead of plain text.
  Anthropic calls these `tool_use` blocks, OpenAI calls them
  `tool_calls`. The translator converts between the two.
- **SSE** — Server-Sent Events. The wire format used by both
  Anthropic and OpenAI for streaming responses.

## Project layout (top-level)

```
free-claude-code-ai/
├── src/                  proxy core (server, providers, translator, ...)
├── bots/                 optional Telegram / Discord chat clients
├── tests/                node:test unit tests for the translator
├── docs/                 you are here
├── Dockerfile            tiny Alpine image for the proxy
├── docker-compose.yml    one-service compose file
├── package.json          two runtime deps, one optional
├── .env.example          every supported env var, commented
└── README.md             user-facing quick-start
```
