/**
 * AlVik — authenticated DeepSeek proxy (Cloudflare Worker).
 *
 * The browser never sees the DeepSeek API key, and the app password is a
 * Worker secret — it is never shipped to the client or committed to git.
 *
 * Routes:
 *   GET  /api/health              -> { ok: true }            (no auth)
 *   POST /api/login  { password } -> { token, expiresAt }    (no auth)
 *   POST /api/chat                -> SSE stream or { reply, ... }  (Bearer token)
 *   POST /                        -> alias of /api/chat
 *
 * Setup:
 *   1. wrangler secret put DEEPSEEK_API_KEY   sk-b204135decd2401f9fdb033fe577bc96
 *   2. wrangler secret put APP_PASSWORD       Power@56789
 *   3. wrangler secret put AUTH_SECRET        # 32+ random chars, signs tokens
 *   4. set ALLOWED_ORIGINS in wrangler.toml to your site origin
 *   5. wrangler deploy
 *
 * Rotating AUTH_SECRET immediately invalidates every issued session token,
 * which is the fastest way to lock everyone out if a device is lost.
 */

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const DEFAULT_MODEL = 'deepseek-v4-pro';
const ALLOWED_MODELS = ['deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'];

// Models that take reasoning/thinking parameters. The payload shape here
// mirrors the previously deployed worker exactly, because that shape is
// known to work against this account's API.
const REASONING_MODELS = ['deepseek-v4-pro', 'deepseek-reasoner'];
const DEFAULT_REASONING_EFFORT = 'high';
const ALLOWED_REASONING_EFFORT = ['low', 'medium', 'high'];
const MAX_BODY_BYTES = 2_000_000;   // 2 MB request cap
const MAX_MESSAGES = 400;
const MAX_TOKENS_CAP = 8192;
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days

// Best-effort brute-force damper. Workers isolates are per-colo and short
// lived, so this is a speed bump, not a guarantee — the real protection is
// a strong APP_PASSWORD.
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_ATTEMPTS = 10;
const loginHits = new Map();

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors || {} });
    }
    if (cors === null) {
      return json({ error: 'Origin not allowed' }, 403, {});
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/api/health') {
      return json({ ok: true, service: 'alvik' }, 200, cors);
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405, cors);
    }

    if (!env.DEEPSEEK_API_KEY || !env.APP_PASSWORD || !env.AUTH_SECRET) {
      return json({ error: 'Worker is not configured. Set DEEPSEEK_API_KEY, APP_PASSWORD and AUTH_SECRET.' }, 500, cors);
    }

    if (path === '/api/login') return handleLogin(request, env, cors);
    if (path === '/api/chat' || path === '/') return handleChat(request, env, cors);

    return json({ error: 'Not found' }, 404, cors);
  }
};

// ---------------------------------------------------------------- login

async function handleLogin(request, env, cors) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (isRateLimited(ip)) {
    return json({ error: 'Too many attempts. Wait a minute and try again.' }, 429, cors);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400, cors);
  }

  const supplied = typeof body.password === 'string' ? body.password : '';
  const ok = await constantTimeEquals(supplied, env.APP_PASSWORD);
  if (!ok) {
    recordLoginFailure(ip);
    return json({ error: 'Incorrect password.' }, 401, cors);
  }

  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const token = await issueToken(env.AUTH_SECRET, expiresAt);
  return json({ token, expiresAt }, 200, cors);
}

function isRateLimited(ip) {
  const rec = loginHits.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > LOGIN_WINDOW_MS) {
    loginHits.delete(ip);
    return false;
  }
  return rec.count >= LOGIN_MAX_ATTEMPTS;
}

function recordLoginFailure(ip) {
  const now = Date.now();
  const rec = loginHits.get(ip);
  if (!rec || now - rec.first > LOGIN_WINDOW_MS) {
    loginHits.set(ip, { first: now, count: 1 });
  } else {
    rec.count++;
  }
  // Keep the map from growing without bound in a long-lived isolate.
  if (loginHits.size > 5000) {
    for (const [k, v] of loginHits) {
      if (now - v.first > LOGIN_WINDOW_MS) loginHits.delete(k);
    }
  }
}

// ---------------------------------------------------------------- chat

async function handleChat(request, env, cors) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token || !(await verifyToken(env.AUTH_SECRET, token))) {
    return json({ error: 'Not authenticated' }, 401, cors);
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return json({ error: 'Request too large' }, 413, cors);
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'Invalid JSON' }, 400, cors);
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return json({ error: '"messages" array is required' }, 400, cors);
  }
  if (body.messages.length > MAX_MESSAGES) {
    return json({ error: 'Too many messages' }, 400, cors);
  }

  const model = typeof body.model === 'string' && ALLOWED_MODELS.includes(body.model)
    ? body.model
    : DEFAULT_MODEL;

  const payload = {
    model,
    messages: body.messages.map(m => ({
      role: m.role === 'system' || m.role === 'assistant' ? m.role : 'user',
      content: String(m.content ?? '')
    })),
    stream: body.stream === true
  };
  if (Number.isFinite(body.temperature)) {
    payload.temperature = Math.min(2, Math.max(0, body.temperature));
  }
  if (Number.isFinite(body.max_tokens) && body.max_tokens > 0) {
    payload.max_tokens = Math.min(MAX_TOKENS_CAP, Math.floor(body.max_tokens));
  }

  // Reasoning models get thinking mode. `extra_body` is carried through in
  // the same shape the previous worker sent, so behaviour matches what this
  // account is already getting from the API.
  if (REASONING_MODELS.includes(model)) {
    payload.reasoning_effort = ALLOWED_REASONING_EFFORT.includes(body.reasoning_effort)
      ? body.reasoning_effort
      : DEFAULT_REASONING_EFFORT;
    payload.extra_body = { thinking: { type: 'enabled' } };
  }

  const callUpstream = (p) => fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify(p)
  });

  let upstream;
  try {
    upstream = await callUpstream(payload);
  } catch (e) {
    return json({ error: 'Upstream unreachable', detail: String(e) }, 502, cors);
  }

  // If a model rejects a streaming request, fall back to non-streaming once
  // rather than surfacing an error the user can do nothing about.
  if (!upstream.ok && payload.stream && upstream.status === 400) {
    try {
      const retry = await callUpstream({ ...payload, stream: false });
      if (retry.ok) {
        payload.stream = false;
        upstream = retry;
      }
    } catch { /* keep the original failure below */ }
  }

  if (!upstream.ok) {
    const detail = (await upstream.text()).slice(0, 600);
    // Never surface upstream 401s as 401 — that would make the client think
    // the user's session expired and bounce them to the login screen.
    const status = upstream.status === 429 ? 429 : 502;
    return json({ error: `Upstream error ${upstream.status}`, detail }, status, cors);
  }

  if (payload.stream) {
    return new Response(upstream.body, {
      status: 200,
      headers: {
        ...cors,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no'
      }
    });
  }

  const data = await upstream.json();
  const msg = data.choices?.[0]?.message || {};
  return json({
    reply: msg.content ?? '',
    ...(msg.reasoning_content ? { reasoning: msg.reasoning_content } : {}),
    usage: data.usage,
    model: data.model
  }, 200, cors);
}

// ---------------------------------------------------------------- tokens

const encoder = new TextEncoder();

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
}

async function sign(secret, data) {
  const key = await hmacKey(secret);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(data)));
}

async function issueToken(secret, expiresAt) {
  const payload = b64urlEncode(encoder.encode(JSON.stringify({ exp: expiresAt })));
  const sig = b64urlEncode(await sign(secret, payload));
  return `${payload}.${sig}`;
}

async function verifyToken(secret, token) {
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;

  const expected = b64urlEncode(await sign(secret, payload));
  if (!(await constantTimeEquals(sig, expected))) return false;

  try {
    const decoded = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
    return Number.isFinite(decoded.exp) && decoded.exp > Date.now();
  } catch {
    return false;
  }
}

// Double-HMAC comparison: constant time regardless of input length, and it
// never leaks how many leading characters matched.
async function constantTimeEquals(a, b) {
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey(
    'raw', nonce, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const [ha, hb] = await Promise.all([
    crypto.subtle.sign('HMAC', key, encoder.encode(String(a))),
    crypto.subtle.sign('HMAC', key, encoder.encode(String(b)))
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = va.length ^ vb.length;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

function b64urlEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const pad = str.length % 4 ? '='.repeat(4 - (str.length % 4)) : '';
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------- helpers

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  let allowOrigin;
  if (allowed.length === 0) {
    allowOrigin = '*';
  } else if (allowed.includes(origin)) {
    allowOrigin = origin;
  } else {
    return null; // signals "origin not allowed"
  }

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
