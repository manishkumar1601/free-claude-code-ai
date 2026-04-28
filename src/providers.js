// Each provider exposes an OpenAI-compatible /chat/completions endpoint.
// Auth keys may be a comma-separated list — we round-robin between them.

const env = (k, fb = '') => process.env[k] || fb;

function pickKey(varName) {
  const raw = env(varName);
  if (!raw) return '';
  const keys = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (keys.length === 0) return '';
  if (keys.length === 1) return keys[0];
  // Round-robin counter per env var name.
  pickKey._counters ??= {};
  const i = pickKey._counters[varName] || 0;
  pickKey._counters[varName] = (i + 1) % keys.length;
  return keys[i];
}

export const providers = {
  cloudflare: {
    baseUrl: () =>
      `https://api.cloudflare.com/client/v4/accounts/${env('CLOUDFLARE_ACCOUNT_ID')}/ai/v1`,
    apiKey: () => pickKey('CLOUDFLARE_API_TOKEN'),
    requiresAuth: true,
    defaultBig: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    defaultSmall: '@cf/meta/llama-3.1-8b-instruct',
  },
  nvidia: {
    baseUrl: () => env('NVIDIA_BASE_URL', 'https://integrate.api.nvidia.com/v1'),
    apiKey: () => pickKey('NVIDIA_API_KEY'),
    requiresAuth: true,
    defaultBig: 'meta/llama-3.3-70b-instruct',
    defaultSmall: 'meta/llama-3.1-8b-instruct',
  },
  openrouter: {
    baseUrl: () => 'https://openrouter.ai/api/v1',
    apiKey: () => pickKey('OPENROUTER_API_KEY'),
    requiresAuth: true,
    defaultBig: 'anthropic/claude-3.5-sonnet',
    defaultSmall: 'anthropic/claude-3-haiku',
  },
  deepseek: {
    baseUrl: () => 'https://api.deepseek.com/v1',
    apiKey: () => pickKey('DEEPSEEK_API_KEY'),
    requiresAuth: true,
    defaultBig: 'deepseek-chat',
    defaultSmall: 'deepseek-chat',
  },
  lmstudio: {
    baseUrl: () => env('LMSTUDIO_BASE_URL', 'http://localhost:1234/v1'),
    apiKey: () => '',
    requiresAuth: false,
    defaultBig: env('LMSTUDIO_MODEL', 'local-model'),
    defaultSmall: env('LMSTUDIO_MODEL', 'local-model'),
  },
  llamacpp: {
    baseUrl: () => env('LLAMACPP_BASE_URL', 'http://localhost:8080/v1'),
    apiKey: () => '',
    requiresAuth: false,
    defaultBig: env('LLAMACPP_MODEL', 'local-model'),
    defaultSmall: env('LLAMACPP_MODEL', 'local-model'),
  },
  ollama: {
    baseUrl: () => env('OLLAMA_BASE_URL', 'http://localhost:11434/v1'),
    apiKey: () => '',
    requiresAuth: false,
    defaultBig: env('OLLAMA_MODEL', 'llama3.1'),
    defaultSmall: env('OLLAMA_MODEL', 'llama3.1'),
  },
};

// PROVIDER may be a comma-separated list ("cloudflare,openrouter") for fallback.
// ROUTE_OPUS / ROUTE_SONNET / ROUTE_HAIKU override the chain per model tier.
function chainFor(claudeModel) {
  const name = (claudeModel || '').toLowerCase();
  let raw;
  if (name.includes('haiku')) raw = env('ROUTE_HAIKU');
  else if (name.includes('sonnet')) raw = env('ROUTE_SONNET');
  else if (name.includes('opus')) raw = env('ROUTE_OPUS');
  raw = raw || env('PROVIDER', 'cloudflare');
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export function routePlan(claudeModel) {
  const chain = chainFor(claudeModel);
  const isSmall = (claudeModel || '').toLowerCase().includes('haiku');

  return chain.map((key) => {
    const provider = providers[key];
    if (!provider) {
      throw new Error(
        `Unknown provider: ${key}. Valid: ${Object.keys(providers).join(', ')}`
      );
    }
    const upstreamModel = isSmall
      ? env('SMALL_MODEL', provider.defaultSmall)
      : env('BIG_MODEL', provider.defaultBig);
    return { providerKey: key, provider, upstreamModel };
  });
}

// Single-shot upstream call.
export async function callUpstream(provider, body) {
  const headers = { 'content-type': 'application/json' };
  const apiKey = provider.apiKey();
  if (provider.requiresAuth && !apiKey) {
    throw new Error('Missing API key for selected provider');
  }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  return fetch(`${provider.baseUrl()}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

// Walk the fallback chain. Returns { res, plan } from the first provider that
// returns a 2xx. On 5xx or network error, tries the next. 4xx is final.
//
// For streaming, fallback only applies before any bytes are read by the caller —
// once we hand back the response, the caller owns it.
export async function callWithFallback(plan, buildBody) {
  let lastErr = null;

  for (const step of plan) {
    try {
      const body = buildBody(step.upstreamModel);
      const res = await callUpstream(step.provider, body);
      if (res.ok) return { res, step };

      // 4xx: bad input or auth — no point retrying with another provider
      if (res.status >= 400 && res.status < 500) {
        return { res, step };
      }
      // 5xx: try next
      lastErr = new Error(`upstream ${res.status} from ${step.providerKey}`);
      console.warn(lastErr.message + ' — trying next provider');
    } catch (err) {
      lastErr = err;
      console.warn(`provider ${step.providerKey} failed: ${err.message} — trying next`);
    }
  }

  throw lastErr || new Error('all providers failed');
}
