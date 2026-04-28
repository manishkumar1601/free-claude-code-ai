import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anthropicToOpenAI, openAIToAnthropic } from '../src/translator.js';

test('anthropic -> openai: simple text', () => {
  const out = anthropicToOpenAI(
    {
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 100,
    },
    'gpt-x'
  );
  assert.equal(out.model, 'gpt-x');
  assert.equal(out.messages.length, 1);
  assert.deepEqual(out.messages[0], { role: 'user', content: 'hello' });
  assert.equal(out.max_tokens, 100);
});

test('anthropic -> openai: string system prompt becomes a system message', () => {
  const out = anthropicToOpenAI(
    { messages: [{ role: 'user', content: 'hi' }], system: 'be brief' },
    'm'
  );
  assert.equal(out.messages[0].role, 'system');
  assert.equal(out.messages[0].content, 'be brief');
  assert.equal(out.messages[1].role, 'user');
});

test('anthropic -> openai: array system prompt is concatenated', () => {
  const out = anthropicToOpenAI(
    {
      messages: [{ role: 'user', content: 'hi' }],
      system: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
    },
    'm'
  );
  assert.equal(out.messages[0].content, 'a\nb');
});

test('anthropic -> openai: tools converted to function format', () => {
  const out = anthropicToOpenAI(
    {
      messages: [{ role: 'user', content: 'x' }],
      tools: [
        {
          name: 'get_weather',
          description: 'get current weather',
          input_schema: { type: 'object', properties: { city: { type: 'string' } } },
        },
      ],
    },
    'm'
  );
  assert.equal(out.tools.length, 1);
  assert.equal(out.tools[0].type, 'function');
  assert.equal(out.tools[0].function.name, 'get_weather');
  assert.equal(out.tools[0].function.description, 'get current weather');
  assert.deepEqual(out.tools[0].function.parameters.properties.city, { type: 'string' });
});

test('anthropic -> openai: assistant tool_use becomes tool_calls', () => {
  const out = anthropicToOpenAI(
    {
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'sure' },
            { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'NYC' } },
          ],
        },
      ],
    },
    'm'
  );
  const asst = out.messages.find((m) => m.role === 'assistant');
  assert.equal(asst.content, 'sure');
  assert.equal(asst.tool_calls.length, 1);
  assert.equal(asst.tool_calls[0].id, 'toolu_1');
  assert.equal(asst.tool_calls[0].function.name, 'get_weather');
  assert.deepEqual(JSON.parse(asst.tool_calls[0].function.arguments), { city: 'NYC' });
});

test('anthropic -> openai: tool_result becomes role=tool message', () => {
  const out = anthropicToOpenAI(
    {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'sunny, 70F' },
          ],
        },
      ],
    },
    'm'
  );
  const tool = out.messages.find((m) => m.role === 'tool');
  assert.ok(tool, 'expected a tool message');
  assert.equal(tool.tool_call_id, 'toolu_1');
  assert.equal(tool.content, 'sunny, 70F');
});

test('openai -> anthropic: text response', () => {
  const out = openAIToAnthropic(
    {
      id: 'cmpl_1',
      choices: [{ message: { content: 'hi there' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 3 },
    },
    'claude-3-5-sonnet-20241022'
  );
  assert.equal(out.role, 'assistant');
  assert.equal(out.model, 'claude-3-5-sonnet-20241022');
  assert.equal(out.content[0].type, 'text');
  assert.equal(out.content[0].text, 'hi there');
  assert.equal(out.stop_reason, 'end_turn');
  assert.equal(out.usage.input_tokens, 10);
  assert.equal(out.usage.output_tokens, 3);
});

test('openai -> anthropic: tool_calls become tool_use blocks', () => {
  const out = openAIToAnthropic(
    {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
    'claude-3-5-sonnet-20241022'
  );
  assert.equal(out.stop_reason, 'tool_use');
  assert.equal(out.content.length, 1);
  assert.equal(out.content[0].type, 'tool_use');
  assert.equal(out.content[0].id, 'call_1');
  assert.equal(out.content[0].name, 'get_weather');
  assert.deepEqual(out.content[0].input, { city: 'NYC' });
});

test('openai -> anthropic: maps finish_reason values', () => {
  const len = openAIToAnthropic(
    { choices: [{ message: { content: '' }, finish_reason: 'length' }] },
    'm'
  );
  assert.equal(len.stop_reason, 'max_tokens');
});
