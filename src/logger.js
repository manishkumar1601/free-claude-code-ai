import { appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const LOG_DIR = path.resolve('logs');
const LOG_FILE = path.join(LOG_DIR, 'requests.jsonl');
const ENABLED = process.env.LOG_REQUESTS === 'true';

let ready = false;

async function ensureDir() {
  if (ready) return;
  if (!existsSync(LOG_DIR)) await mkdir(LOG_DIR, { recursive: true });
  ready = true;
}

export async function logRequest(entry) {
  if (!ENABLED) return;
  try {
    await ensureDir();
    await appendFile(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch (err) {
    console.error('log write failed:', err.message);
  }
}

export const LOG_PATH = LOG_FILE;
