// Minimal Discord bot — listens for messages that mention the bot or DM it,
// forwards each to the proxy as a single-turn chat, replies with model text.
//
// Run:  npm install discord.js   (optional dep)
//       node bots/discord.js
// Env:  DISCORD_BOT_TOKEN, PROXY_URL, ANTHROPIC_AUTH_TOKEN, BOT_MODEL

import 'dotenv/config';

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const PROXY_URL = process.env.PROXY_URL || 'http://localhost:3000';
const AUTH = process.env.ANTHROPIC_AUTH_TOKEN || '';
const MODEL = process.env.BOT_MODEL || 'claude-3-5-sonnet-20241022';

if (!TOKEN) {
  console.error('DISCORD_BOT_TOKEN is required');
  process.exit(1);
}

let djs;
try {
  djs = await import('discord.js');
} catch {
  console.error('discord.js is not installed. Run: npm install discord.js');
  process.exit(1);
}

const { Client, GatewayIntentBits, Partials } = djs;
const history = new Map(); // channelId -> [{role, content}]

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

async function ask(channelId, text) {
  const messages = (history.get(channelId) || []).concat([{ role: 'user', content: text }]);
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
  history.set(channelId, messages.slice(-20));
  return reply;
}

client.once('ready', () => console.log(`discord bot logged in as ${client.user.tag}`));

client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;

  const isDM = !msg.guild;
  const mentioned = msg.mentions.has(client.user);
  if (!isDM && !mentioned) return;

  const text = msg.content.replace(/<@!?\d+>/g, '').trim();
  if (!text) return;

  if (text === '/reset') {
    history.delete(msg.channel.id);
    await msg.reply('history cleared');
    return;
  }

  await msg.channel.sendTyping();
  try {
    const reply = await ask(msg.channel.id, text);
    // Discord caps messages at 2000 chars.
    for (let i = 0; i < reply.length; i += 1900) {
      await msg.reply(reply.slice(i, i + 1900));
    }
  } catch (err) {
    await msg.reply('error: ' + err.message);
  }
});

client.login(TOKEN);
