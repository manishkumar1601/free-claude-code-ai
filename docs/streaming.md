# Streaming

Anthropic and OpenAI both stream responses with **Server-Sent Events**
(SSE) — but the *event grammar* is very different. This doc explains
how the proxy rewrites one into the other on the fly.

Source: [streamOpenAIToAnthropic in src/translator.js:144-267](../src/translator.js#L144-L267).

## The two grammars side by side

### OpenAI

A single event stream. Each `data:` line is a JSON chunk that may
contain:

```json
{
  "id": "chatcmpl_...",
  "choices": [{
    "delta": { "content": "...partial text..." },
    "finish_reason": null
  }]
}
```

For tool calls:

```json
{
  "choices": [{
    "delta": {
      "tool_calls": [
        { "index": 0, "id": "call_1", "function": { "name": "x", "arguments": "{\"a" } }
      ]
    }
  }]
}
```

The stream ends with `data: [DONE]`.

### Anthropic

Multiple typed events:

```
event: message_start
data: { "type": "message_start", "message": { "id":"msg_...", "role":"assistant", ... } }

event: content_block_start
data: { "type": "content_block_start", "index": 0, "content_block": { "type":"text", "text":"" } }

event: content_block_delta
data: { "type": "content_block_delta", "index": 0, "delta": { "type":"text_delta", "text":"hello" } }

...more deltas...

event: content_block_stop
data: { "type": "content_block_stop", "index": 0 }

event: message_delta
data: { "type": "message_delta", "delta": { "stop_reason":"end_turn" }, "usage": { "output_tokens": 12 } }

event: message_stop
data: { "type": "message_stop" }
```

Each `content_block_*` index identifies one *chunk* of the response.
Text gets one block; each tool call gets its own block.

## The rewrite algorithm

The proxy reads upstream bytes, splits on `\n`, parses each `data:`
JSON, and emits one or more Anthropic events per chunk.

```
upstream chunk arrives
        │
        ├─ delta.content (text)
        │     │
        │     ├─ first text seen?  emit content_block_start (type: text)
        │     │                    remember the index
        │     │
        │     └─ emit content_block_delta { type: 'text_delta', text }
        │
        ├─ delta.tool_calls[i] (function call)
        │     │
        │     ├─ first time seeing this index?
        │     │     emit content_block_start (type: tool_use)
        │     │     allocate a new anthropic index
        │     │     start an args buffer
        │     │
        │     └─ emit content_block_delta { type: 'input_json_delta', partial_json: argsChunk }
        │
        └─ finish_reason set?  remember mapped stop_reason for the closer
```

Once the upstream `[DONE]` arrives:

```
for each open block:
  emit content_block_stop { index }

emit message_delta { delta: { stop_reason }, usage: { output_tokens } }
emit message_stop
res.end()
```

## The state machine

The translator carries this much state across chunks:

| Variable        | Purpose                                                    |
|-----------------|------------------------------------------------------------|
| `messageId`     | A `msg_<random>` id sent at the start                      |
| `textBlockOpen` | `false` if no text yet, otherwise the Anthropic block index|
| `toolBlocks`    | `Map<openaiToolCallIndex, {anthropicIndex, argsBuf}>`      |
| `nextIndex`     | The next free Anthropic block index                        |
| `stopReason`    | Defaults to `end_turn`, updated on any `finish_reason`     |
| `outputTokens`  | Approximate count — incremented per text delta, replaced if upstream sends `usage.completion_tokens` |

Why a separate map for tool calls?

- OpenAI sends multiple deltas for the *same* tool call (one for the
  name, then several for partial JSON arguments) and it identifies
  them by `index`.
- Anthropic uses a flat block index: text is index 0, tool call A is
  index 1, tool call B is index 2, etc.

The map translates between the two indices and accumulates the
streaming arguments JSON so that `input_json_delta` events fire as the
upstream sends them.

## Backpressure / buffering

The upstream body is a `ReadableStream` (Web Streams API). The
translator owns the reader:

```js
const reader = upstreamRes.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });

  // process complete '\n'-terminated lines from buffer
}
```

Partial lines stay in `buffer` until the next chunk completes them.
The `{ stream: true }` flag on `decode` keeps multi-byte characters
from being split across reads.

Writes to the client (`res.write(...)`) use Node's default
back-pressure. If the client is slow, Node's socket buffer fills and
`fetch`'s reader throttles automatically.

## Failure modes

- **Upstream sends malformed JSON** in a `data:` line. We `try/catch`
  and silently skip the line.
- **Connection dropped mid-stream.** The `while` loop exits when
  `done` is true (EOF) — including from a network error. Whatever
  was sent is sent; the closing events fire.
- **Upstream returns a 5xx instead of streaming.** This is detected
  *before* `streamOpenAIToAnthropic` is called — the fallback chain
  in `callWithFallback` checks `res.ok`. Once we hand back a streaming
  response, fallback is no longer possible.
- **Output tokens count looks rough.** It is. We increment by 1 per
  text delta as a coarse estimate; if upstream sends a `usage` field
  late, we overwrite with the real count.

## Why not chunked passthrough?

A naïve proxy could just pipe the upstream body to the response, but
the client expects Anthropic events, not OpenAI ones. There is no
trivial textual rewrite — the *number* of events differs, the *types*
differ, the *block-indexing* model differs. So we parse-and-emit.
