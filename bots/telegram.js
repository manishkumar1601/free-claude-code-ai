// Minimal Telegram bot — long-polls getUpdates, sends each message to the
// proxy as a single-turn chat, replies with the model's text.
//
// Run: node bots/telegram.js
// Env: TELEGRAM_BOT_TOKEN, PROXY_URL (default http://localhost:3000),
//      ANTHROPIC_AUTH_TOKEN (only if AUTH_TOKEN is set on the proxy).

import 'dotenv/config';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PROXY_URL = process.env.PROXY_URL || 'http://localhost:3000';
const AUTH = process.env.ANTHROPIC_AUTH_TOKEN || '';
const MODEL = process.env.BOT_MODEL || 'claude-3-5-sonnet-20241022';

if (!TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is required');
  process.exit(1);
}

const TG = `https://api.telegram.org/bot${TOKEN}`;
const history = new Map(); // chatId -> [{role, content}]

async function tg(method, body) {
  const r = await fetch(`${TG}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function ask(chatId, text) {
  const messages = (history.get(chatId) || []).concat([{ role: 'user', content: text }]);
  const headers = { 'content-type': 'application/json' };
  if (AUTH) headers['x-api-key'] = AUTH;

  const r = await fetch(`${PROXY_URL}/v1/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: MODEL, max_tokens: 1024, messages }),
  });
  const j = await r.json();
  const reply = (j.content || []).map((b) => b.text || '').join('\n').trim() || '(no response)';

  messages.push({ role: 'assistant', content: reply });
  history.set(chatId, messages.slice(-20));
  return reply;
}

let offset = 0;
console.log('telegram bot listening — proxy at', PROXY_URL);

while (true) {
  try {
    const u = await tg('getUpdates', { offset, timeout: 30 });
    for (const upd of u.result || []) {
      offset = upd.update_id + 1;
      const msg = upd.message;
      if (!msg?.text) continue;

      if (msg.text === '/reset') {
        history.delete(msg.chat.id);
        await tg('sendMessage', { chat_id: msg.chat.id, text: 'history cleared' });
        continue;
      }

      const reply = await ask(msg.chat.id, msg.text);
      await tg('sendMessage', { chat_id: msg.chat.id, text: reply });
    }
  } catch (err) {
    console.error('poll error:', err.message);
    await new Promise((r) => setTimeout(r, 2000));
  }
}
