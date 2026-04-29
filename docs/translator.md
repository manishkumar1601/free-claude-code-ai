# The translator

Anthropic and OpenAI have *similar* APIs but disagree on roughly a
dozen specifics. The translator's job is to make those disagreements
invisible to the client. This doc is the conversion reference.

Source: [src/translator.js](../src/translator.js).

## Why this exists

Claude Code (and any other Anthropic SDK client) sends requests
shaped like Anthropic's [Messages API][a]. The free providers we
target (Cloudflare Workers AI, NVIDIA NIM, OpenRouter, DeepSeek,
LM Studio, llama.cpp, Ollama) all expose a different but very common
shape: OpenAI's [Chat Completions API][o].

Without a translator, you'd need a different client per provider.
With one, the client doesn't change.

[a]: https://docs.claude.com/en/api/messages
[o]: https://platform.openai.com/docs/api-reference/chat

## Shape comparison

| Concept                | Anthropic                                       | OpenAI                                              |
|------------------------|-------------------------------------------------|------------------------------------------------------|
| System prompt          | top-level `system` field (string or array)      | first message with `role: 'system'`                 |
| Conversation           | `messages: [{role, content}]`                   | `messages: [{role, content}]`                       |
| Multimodal/tool blocks | `content: [{type: 'text'|'tool_use'|'tool_result', ...}]` | flatter — `tool_calls` array on assistant message, `role: 'tool'` for results |
| Tool definitions       | `tools: [{name, description, input_schema}]`    | `tools: [{type: 'function', function: {name, description, parameters}}]` |
| Tool result            | user message with `{type:'tool_result', tool_use_id, content}` | separate message with `role: 'tool', tool_call_id, content` |
| Stop reasons           | `end_turn`, `max_tokens`, `tool_use`            | `stop`, `length`, `tool_calls`, `function_call`     |
| Max tokens             | `max_tokens` (required)                         | `max_tokens` (optional)                             |
| Streaming events       | typed: `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop` | one event type — partial `delta` chunks of a `message` |

## `anthropicToOpenAI(req, upstreamModel)`

[src/translator.js:5-43](../src/translator.js#L5-L43)

### System prompt

```js
if (req.system) {
  const systemText = Array.isArray(req.system)
    ? req.system.map((b) => b.text || '').join('\n')
    : String(req.system);
  if (systemText) messages.push({ role: 'system', content: systemText });
}
```

- String → one `{role: 'system', content: '...'}` message at the top.
- Array of `{type: 'text', text}` blocks → joined with `\n` into one
  system message. (Anthropic supports an array form for cache control;
  we collapse to plain text since none of the upstream providers
  honor cache control anyway.)

### Per-message conversion

Each Anthropic message goes through `convertMessage(msg)`. One
Anthropic message can produce **more than one** OpenAI message,
because Anthropic packs `tool_result` blocks into a user message
while OpenAI requires them as separate `role: 'tool'` messages.

```js
{ role: 'user', content: 'hello' }                  →  { role: 'user', content: 'hello' }

{ role: 'assistant', content: [
    { type: 'text', text: 'sure' },
    { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'NYC' } },
]}                                                  →  { role: 'assistant', content: 'sure', tool_calls: [
                                                          { id: 'toolu_1', type: 'function',
                                                            function: { name: 'get_weather',
                                                                        arguments: '{"city":"NYC"}' } }
                                                        ]}

{ role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'toolu_1', content: 'sunny, 70F' },
]}                                                  →  { role: 'tool', tool_call_id: 'toolu_1',
                                                         content: 'sunny, 70F' }
```

Notable details:

- `tool_use.input` is a *JSON object* in Anthropic. OpenAI wants it
  serialized as a string in `tool_calls[*].function.arguments`. The
  translator does `JSON.stringify(block.input || {})`.
- `tool_result.content` may itself be an array of `{type: 'text', text}`
  blocks. Those are joined with `\n` and sent as plain string content
  on the `tool` message.
- The text + tool_use case packs them into the *same* assistant
  message (matching OpenAI's shape). If there's no text, the
  assistant message has `content: null`.

### Tools

```js
body.tools = req.tools.map((t) => ({
  type: 'function',
  function: {
    name: t.name,
    description: t.description || '',
    parameters: t.input_schema || { type: 'object', properties: {} },
  },
}));
```

Anthropic uses `input_schema`, OpenAI uses `parameters`. They are
both JSON Schema objects, so it's a 1:1 rename. If a tool has no
schema we substitute `{ type: 'object', properties: {} }` to keep
strict OpenAI servers happy.

### Other request fields

| Anthropic         | OpenAI                  | Notes                                    |
|-------------------|-------------------------|------------------------------------------|
| `model`           | `model`                 | replaced with `upstreamModel` from caller|
| `messages`        | `messages`              | per-message conversion above             |
| `max_tokens`      | `max_tokens`            | defaults to 4096 if missing              |
| `temperature`     | `temperature`           | passed through if a number               |
| `top_p`           | `top_p`                 | passed through if a number               |
| `stop_sequences`  | `stop`                  | passed through if non-empty array        |
| `stream`          | `stream`                | coerced to boolean                       |
| `system`          | first `messages[]` item | see above                                |
| `tools`           | `tools`                 | see above                                |

Fields not listed (e.g. `metadata`, `top_k`) are silently dropped.

## `openAIToAnthropic(openaiRes, requestedModel)`

[src/translator.js:88-122](../src/translator.js#L88-L122)

Used only for **non-streaming** responses. Streaming has its own path.

```js
{
  id: <upstream id> || `msg_<random>`,
  type: 'message',
  role: 'assistant',
  model: requestedModel,                    // not the upstream model
  content: [                                // built from message.content + tool_calls
    { type: 'text', text: '...' },
    { type: 'tool_use', id, name, input },
    ...
  ],
  stop_reason: mapStopReason(finish_reason),
  stop_sequence: null,
  usage: {
    input_tokens: usage.prompt_tokens ?? 0,
    output_tokens: usage.completion_tokens ?? 0,
  },
}
```

Important behaviors:

- The response carries the **client-requested** model name, not the
  upstream's. Claude Code uses this for cost display and logging — if
  it sees `@cf/meta/llama-3.3-70b-instruct-fp8-fast` instead of
  `claude-3-5-sonnet-20241022`, the UI breaks.
- If the response has no text and no tool calls, we emit a single
  empty text block. The Anthropic spec allows empty content but some
  clients crash without at least one block.
- If a tool call's `arguments` JSON fails to parse, we wrap the raw
  string in `{_raw: '...'}`. This is a soft fallback — a strict
  client will probably error on it, but at least the response gets
  through.
- `tool_calls[*].id` may be missing on small models. We fabricate
  `toolu_<24 hex>` if so.

### `finish_reason` → `stop_reason`

| OpenAI          | Anthropic     |
|-----------------|---------------|
| `stop`          | `end_turn`    |
| `length`        | `max_tokens`  |
| `tool_calls`    | `tool_use`    |
| `function_call` | `tool_use`    |
| anything else   | `end_turn`    |

## `streamOpenAIToAnthropic(...)`

Streaming is a separate beast; see [streaming.md](streaming.md).

## What is *not* translated

- **Caching control blocks** in the system prompt or messages. They
  are dropped (the upstream doesn't support them).
- **`metadata.user_id`**. Dropped.
- **Citations**. Dropped — none of our upstreams return citations.
- **Image content blocks**. Dropped (no upstream we support is
  multimodal). If you need vision, this proxy is the wrong tool.
- **Anthropic-only stop sequences semantics** like the model echoing
  the stop string back. We pass `stop` to OpenAI and trust the
  upstream's behavior.

## Testing

Round-trip behavior is covered in
[tests/translator.test.js](../tests/translator.test.js). Run with:

```bash
npm test
```

Uses `node:test` — no test framework needed. If you change anything
in `translator.js`, add a test for the case before fixing the bug.
