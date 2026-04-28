import { randomUUID } from 'node:crypto';

// ---------- Anthropic request -> OpenAI request ----------

export function anthropicToOpenAI(req, upstreamModel) {
  const messages = [];

  // Anthropic puts the system prompt in its own field. OpenAI puts it in messages.
  if (req.system) {
    const systemText = Array.isArray(req.system)
      ? req.system.map((b) => b.text || '').join('\n')
      : String(req.system);
    if (systemText) messages.push({ role: 'system', content: systemText });
  }

  for (const msg of req.messages || []) {
    messages.push(...convertMessage(msg));
  }

  const body = {
    model: upstreamModel,
    messages,
    stream: !!req.stream,
    max_tokens: req.max_tokens ?? 4096,
  };
  if (typeof req.temperature === 'number') body.temperature = req.temperature;
  if (typeof req.top_p === 'number') body.top_p = req.top_p;
  if (Array.isArray(req.stop_sequences) && req.stop_sequences.length)
    body.stop = req.stop_sequences;

  if (Array.isArray(req.tools) && req.tools.length) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }));
  }

  return body;
}

// One Anthropic message can become multiple OpenAI messages (tool results split out).
function convertMessage(msg) {
  const out = [];

  if (typeof msg.content === 'string') {
    out.push({ role: msg.role, content: msg.content });
    return out;
  }

  const textParts = [];
  const toolCalls = [];

  for (const block of msg.content || []) {
    if (block.type === 'text') {
      textParts.push(block.text || '');
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input || {}),
        },
      });
    } else if (block.type === 'tool_result') {
      const content = Array.isArray(block.content)
        ? block.content.map((c) => c.text || '').join('\n')
        : String(block.content ?? '');
      out.push({ role: 'tool', tool_call_id: block.tool_use_id, content });
    }
  }

  if (textParts.length || toolCalls.length) {
    const m = { role: msg.role, content: textParts.join('\n') || null };
    if (toolCalls.length) m.tool_calls = toolCalls;
    out.push(m);
  }

  return out;
}

// ---------- OpenAI non-stream response -> Anthropic response ----------

export function openAIToAnthropic(openaiRes, requestedModel) {
  const choice = openaiRes.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];

  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const tc of msg.tool_calls || []) {
    let input = {};
    try {
      input = JSON.parse(tc.function?.arguments || '{}');
    } catch {
      input = { _raw: tc.function?.arguments };
    }
    content.push({
      type: 'tool_use',
      id: tc.id || `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      name: tc.function?.name,
      input,
    });
  }

  return {
    id: openaiRes.id || `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content: content.length ? content : [{ type: 'text', text: '' }],
    stop_reason: mapStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: openaiRes.usage?.prompt_tokens ?? 0,
      output_tokens: openaiRes.usage?.completion_tokens ?? 0,
    },
  };
}

function mapStopReason(reason) {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    default:
      return 'end_turn';
  }
}

// ---------- OpenAI SSE stream -> Anthropic SSE stream ----------
//
// Anthropic's stream is event-based: message_start, content_block_start,
// content_block_delta, content_block_stop, message_delta, message_stop.
// We read the upstream SSE line by line and emit equivalent events.

export async function streamOpenAIToAnthropic(upstreamRes, requestedModel, res) {
  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const messageId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  send('message_start', {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model: requestedModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  // We open a text block lazily on the first text token, and a tool_use block
  // lazily for each tool call index we see.
  let textBlockOpen = false;
  const toolBlocks = new Map(); // openai tool_call index -> { anthropicIndex, argsBuf }
  let nextIndex = 0;
  let stopReason = 'end_turn';
  let outputTokens = 0;

  const reader = upstreamRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;

      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;

      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }

      const delta = chunk.choices?.[0]?.delta || {};
      const finish = chunk.choices?.[0]?.finish_reason;

      if (typeof delta.content === 'string' && delta.content.length) {
        if (!textBlockOpen) {
          send('content_block_start', {
            type: 'content_block_start',
            index: nextIndex,
            content_block: { type: 'text', text: '' },
          });
          textBlockOpen = nextIndex;
          nextIndex += 1;
        }
        send('content_block_delta', {
          type: 'content_block_delta',
          index: textBlockOpen,
          delta: { type: 'text_delta', text: delta.content },
        });
        outputTokens += 1;
      }

      for (const tc of delta.tool_calls || []) {
        let entry = toolBlocks.get(tc.index);
        if (!entry) {
          const idx = nextIndex++;
          entry = { anthropicIndex: idx, argsBuf: '' };
          toolBlocks.set(tc.index, entry);
          send('content_block_start', {
            type: 'content_block_start',
            index: idx,
            content_block: {
              type: 'tool_use',
              id: tc.id || `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
              name: tc.function?.name || '',
              input: {},
            },
          });
        }
        const argChunk = tc.function?.arguments || '';
        if (argChunk) {
          entry.argsBuf += argChunk;
          send('content_block_delta', {
            type: 'content_block_delta',
            index: entry.anthropicIndex,
            delta: { type: 'input_json_delta', partial_json: argChunk },
          });
        }
      }

      if (finish) stopReason = mapStopReason(finish);
      if (chunk.usage?.completion_tokens) outputTokens = chunk.usage.completion_tokens;
    }
  }

  if (textBlockOpen !== false) {
    send('content_block_stop', { type: 'content_block_stop', index: textBlockOpen });
  }
  for (const entry of toolBlocks.values()) {
    send('content_block_stop', { type: 'content_block_stop', index: entry.anthropicIndex });
  }

  send('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
  send('message_stop', { type: 'message_stop' });
  res.end();
  return { outputTokens, stopReason };
}
