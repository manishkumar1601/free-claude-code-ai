import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const DIR = path.resolve('.data', 'cache');
const TTL_SEC = Number(process.env.CACHE_TTL || 0);
const ENABLED = TTL_SEC > 0;

async function ensureDir() {
  if (!existsSync(DIR)) await mkdir(DIR, { recursive: true });
}

function keyFor(req, upstreamModel) {
  const payload = {
    model: req.model,
    upstream: upstreamModel,
    system: req.system || null,
    messages: req.messages || [],
    tools: req.tools || [],
    temperature: req.temperature ?? null,
    max_tokens: req.max_tokens ?? null,
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export async function getCached(req, upstreamModel) {
  if (!ENABLED || req.stream) return null;
  try {
    const file = path.join(DIR, keyFor(req, upstreamModel) + '.json');
    const raw = await readFile(file, 'utf8');
    const entry = JSON.parse(raw);
    if (Date.now() - entry.savedAt > TTL_SEC * 1000) return null;
    return entry.response;
  } catch {
    return null;
  }
}

export async function setCached(req, upstreamModel, response) {
  if (!ENABLED || req.stream) return;
  try {
    await ensureDir();
    const file = path.join(DIR, keyFor(req, upstreamModel) + '.json');
    await writeFile(file, JSON.stringify({ savedAt: Date.now(), response }));
  } catch (err) {
    console.error('cache write failed:', err.message);
  }
}

export const CACHE_ENABLED = ENABLED;
