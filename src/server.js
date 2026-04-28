import 'dotenv/config';
import express from 'express';
import { readFile } from 'node:fs/promises';
import { routePlan, callWithFallback } from './providers.js';
import {
  anthropicToOpenAI,
  openAIToAnthropic,
  streamOpenAIToAnthropic,
} from './translator.js';
import { estimateTokens } from './tokens.js';
import { logRequest, LOG_PATH } from './logger.js';
import { loadStats, recordRequest, getStats } from './stats.js';
import { getCached, setCached, CACHE_ENABLED } from './cache.js';
import { dashboardHtml } from './dashboard.js';

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = Number(process.env.PORT || 3000);
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';

function requireAuth(req, res, next) {
  if (!AUTH_TOKEN) return next();
  const header = req.headers['x-api-key'] || req.headers.authorization || '';
  const token = String(header).replace(/^Bearer\s+/i, '');
  if (token !== AUTH_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// --- public/internal endpoints (no auth) ---

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/dashboard', (_req, res) => {
  res.type('html').send(dashboardHtml);
});

app.get('/stats', (_req, res) => res.json(getStats()));

app.get('/info', (_req, res) =>
  res.json({
    provider: process.env.PROVIDER || 'cloudflare',
    bigModel: process.env.BIG_MODEL || '(provider default)',
    smallModel: process.env.SMALL_MODEL || '(provider default)',
    cache: CACHE_ENABLED ? `on, ttl ${process.env.CACHE_TTL}s` : 'off',
    logging: process.env.LOG_REQUESTS === 'true' ? 'on' : 'off',
    auth: AUTH_TOKEN ? 'required' : 'open',
  })
);

// Last 50 log lines (returns empty if logging disabled).
app.get('/logs', async (_req, res) => {
  try {
    const raw = await readFile(LOG_PATH, 'utf8');
    const lines = raw.trim().split('\n').slice(-50);
    res.type('text/plain').send(lines.join('\n'));
  } catch {
    res.type('text/plain').send('');
  }
});

// --- Anthropic-compatible API (auth) ---

app.get('/v1/models', requireAuth, (_req, res) => {
  res.json({
    data: [
      'claude-opus-4-20250514',
      'claude-sonnet-4-20250514',
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
    ].map((id) => ({ id, type: 'model', display_name: id })),
  });
});

app.post('/v1/messages/count_tokens', requireAuth, (req, res) => {
  res.json({ input_tokens: estimateTokens(req.body || {}) });
});

app.post('/v1/messages', requireAuth, async (req, res) => {
  const startedAt = Date.now();
  const anthropicReq = req.body || {};
  const inputTokens = estimateTokens(anthropicReq);

  let plan, firstStep;
  try {
    plan = routePlan(anthropicReq.model);
    firstStep = plan[0];
  } catch (err) {
    return res.status(500).json({ type: 'error', error: { message: err.message } });
  }

  // --- cache hit (non-streaming only) ---
  const cached = await getCached(anthropicReq, firstStep.upstreamModel);
  if (cached) {
    recordRequest({
      provider: firstStep.providerKey,
      inputTokens,
      outputTokens: cached.usage?.output_tokens || 0,
      cacheHit: true,
    });
    await logRequest({
      model: anthropicReq.model,
      provider: firstStep.providerKey,
      upstream: firstStep.upstreamModel,
      stream: false,
      cacheHit: true,
      inputTokens,
      outputTokens: cached.usage?.output_tokens || 0,
      durationMs: Date.now() - startedAt,
    });
    return res.json(cached);
  }

  try {
    const { res: upstream, step } = await callWithFallback(plan, (upstreamModel) =>
      anthropicToOpenAI(anthropicReq, upstreamModel)
    );

    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error(`upstream ${upstream.status}: ${errText}`);
      recordRequest({ provider: step.providerKey, inputTokens, error: true });
      await logRequest({
        model: anthropicReq.model,
        provider: step.providerKey,
        upstream: step.upstreamModel,
        stream: !!anthropicReq.stream,
        status: upstream.status,
        error: errText.slice(0, 500),
        durationMs: Date.now() - startedAt,
      });
      return res.status(upstream.status).json({
        type: 'error',
        error: { type: 'upstream_error', message: errText },
      });
    }

    console.log(
      `[${anthropicReq.model}] -> ${step.providerKey}/${step.upstreamModel} (stream=${!!anthropicReq.stream})`
    );

    if (anthropicReq.stream) {
      res.setHeader('content-type', 'text/event-stream');
      res.setHeader('cache-control', 'no-cache');
      res.setHeader('connection', 'keep-alive');
      const result = await streamOpenAIToAnthropic(upstream, anthropicReq.model, res);
      const outputTokens = result?.outputTokens || 0;
      recordRequest({ provider: step.providerKey, inputTokens, outputTokens });
      await logRequest({
        model: anthropicReq.model,
        provider: step.providerKey,
        upstream: step.upstreamModel,
        stream: true,
        inputTokens,
        outputTokens,
        durationMs: Date.now() - startedAt,
      });
    } else {
      const json = await upstream.json();
      const anthropicRes = openAIToAnthropic(json, anthropicReq.model);
      await setCached(anthropicReq, step.upstreamModel, anthropicRes);
      recordRequest({
        provider: step.providerKey,
        inputTokens,
        outputTokens: anthropicRes.usage?.output_tokens || 0,
      });
      await logRequest({
        model: anthropicReq.model,
        provider: step.providerKey,
        upstream: step.upstreamModel,
        stream: false,
        inputTokens,
        outputTokens: anthropicRes.usage?.output_tokens || 0,
        durationMs: Date.now() - startedAt,
      });
      res.json(anthropicRes);
    }
  } catch (err) {
    console.error(err);
    recordRequest({ provider: firstStep.providerKey, inputTokens, error: true });
    await logRequest({
      model: anthropicReq.model,
      provider: firstStep.providerKey,
      error: err.message,
      durationMs: Date.now() - startedAt,
    });
    if (!res.headersSent) {
      res.status(500).json({
        type: 'error',
        error: { type: 'internal_error', message: err.message },
      });
    } else {
      res.end();
    }
  }
});

await loadStats();

app.listen(PORT, () => {
  console.log(`free-claude-code listening on http://localhost:${PORT}`);
  console.log(`provider chain: ${process.env.PROVIDER || 'cloudflare'}`);
  console.log(`dashboard: http://localhost:${PORT}/dashboard`);
});
