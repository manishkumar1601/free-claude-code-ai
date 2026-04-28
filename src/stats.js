import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve('.data');
const FILE = path.join(DATA_DIR, 'stats.json');

const empty = () => ({
  startedAt: new Date().toISOString(),
  totals: { requests: 0, inputTokens: 0, outputTokens: 0, cacheHits: 0, errors: 0 },
  byProvider: {},
});

let state = empty();
let dirty = false;
let writing = false;

async function ensureDir() {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
}

export async function loadStats() {
  try {
    await ensureDir();
    const raw = await readFile(FILE, 'utf8');
    state = { ...empty(), ...JSON.parse(raw) };
  } catch {
    state = empty();
  }
}

async function persist() {
  if (!dirty || writing) return;
  writing = true;
  dirty = false;
  try {
    await ensureDir();
    await writeFile(FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('stats write failed:', err.message);
    dirty = true;
  } finally {
    writing = false;
  }
}

setInterval(() => persist(), 5000).unref();

function bucket(provider) {
  if (!state.byProvider[provider]) {
    state.byProvider[provider] = { requests: 0, inputTokens: 0, outputTokens: 0, errors: 0 };
  }
  return state.byProvider[provider];
}

export function recordRequest({ provider, inputTokens = 0, outputTokens = 0, cacheHit = false, error = false }) {
  state.totals.requests += 1;
  state.totals.inputTokens += inputTokens;
  state.totals.outputTokens += outputTokens;
  if (cacheHit) state.totals.cacheHits += 1;
  if (error) state.totals.errors += 1;

  const b = bucket(provider || 'unknown');
  b.requests += 1;
  b.inputTokens += inputTokens;
  b.outputTokens += outputTokens;
  if (error) b.errors += 1;

  dirty = true;
}

export function getStats() {
  return state;
}
