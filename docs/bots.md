# The Telegram and Discord bots

The `bots/` directory contains two minimal chat clients that **talk to
the proxy** like any other Anthropic API client. They are not part of
the proxy itself — they run as separate processes and exist mostly as
small, readable examples.

## What they share

Both bots:

- Read their config from `.env` via `dotenv`.
- Talk to the proxy at `PROXY_URL` (default `http://localhost:3000`).
- Send `ANTHROPIC_AUTH_TOKEN` as `x-api-key` if set.
- Use `BOT_MODEL` (default `claude-3-5-sonnet-20241022`).
- Keep the **last 20 messages** of conversation per chat as in-memory
  history (a `Map<chatId, messages[]>`).
- Recognize `/reset` to wipe the current chat's history.

Neither bot is multi-user-aware in any sophisticated way — there's
no auth, no rate limiting, and the history maps live in memory only
(restart = forgotten).

## Telegram bot

**File:** [bots/telegram.js](../bots/telegram.js)

Uses Telegram's [Bot API][tg] directly via `fetch` — no SDK needed.
Long-polls `getUpdates` with `timeout: 30` seconds, processes each
text message, replies with `sendMessage`.

[tg]: https://core.telegram.org/bots/api

### Setup

1. Talk to **@BotFather** on Telegram. Send `/newbot`, follow the
   prompts, copy the token it returns.
2. In `.env`:
   ```ini
   TELEGRAM_BOT_TOKEN=123456789:AA...
   PROXY_URL=http://localhost:3000
   ANTHROPIC_AUTH_TOKEN=    # only if AUTH_TOKEN is set on the proxy
   ```
3. Start the proxy: `npm start`.
4. Start the bot in another terminal:
   ```bash
   npm run bot:telegram
   ```
5. Open your bot in Telegram and send a message.

### Loop overview

```js
let offset = 0;
while (true) {
  const u = await tg('getUpdates', { offset, timeout: 30 });
  for (const upd of u.result || []) {
    offset = upd.update_id + 1;
    // ... handle message ...
  }
}
```

`offset` advances past each handled update. Telegram remembers
unacknowledged updates for ~24 hours, so a restart picks up where the
last instance stopped.

Errors in the poll loop are caught, logged, and retried after 2 s.

## Discord bot

**File:** [bots/discord.js](../bots/discord.js)

Uses [`discord.js`][djs] (an **optional** npm dependency — install
it explicitly).

[djs]: https://discord.js.org/

### Setup

1. Visit <https://discord.com/developers/applications>, create an
   app, add a Bot.
2. Under **Bot → Privileged Gateway Intents**, enable
   **Message Content Intent**.
3. Copy the bot token. Use the OAuth2 URL Generator with `bot` scope
   and `Send Messages` permission to invite the bot to a server.
4. Install the optional dep:
   ```bash
   npm install discord.js
   ```
5. In `.env`:
   ```ini
   DISCORD_BOT_TOKEN=...
   PROXY_URL=http://localhost:3000
   ANTHROPIC_AUTH_TOKEN=    # only if AUTH_TOKEN is set on the proxy
   ```
6. Start the bot:
   ```bash
   npm run bot:discord
   ```
7. Mention the bot in a server channel, or DM it directly.

### Trigger logic

```js
const isDM = !msg.guild;
const mentioned = msg.mentions.has(client.user);
if (!isDM && !mentioned) return;
```

The bot ignores everything except DMs and messages that explicitly
@-mention it. This avoids responding to every message in a busy
server.

### Long replies

Discord caps each message at 2000 characters. The bot splits longer
replies into 1900-char chunks:

```js
for (let i = 0; i < reply.length; i += 1900) {
  await msg.reply(reply.slice(i, i + 1900));
}
```

This is naïve — it can split mid-word or mid-code-block. Good enough
for a demo; rewrite if you care.

## Why the bots aren't tests

These were left in the repo as illustrative *clients*, not as test
infrastructure. There are no automated tests for them, and the
proxy's tests don't exercise them.

If you're using one in production:

- Run it under a process supervisor (systemd, pm2, …) so it restarts
  on crash.
- Persist conversation history if you care about it surviving
  restarts (the in-memory `Map` won't).
- Add per-user rate limiting if your proxy is behind a hosted provider
  with quotas.
