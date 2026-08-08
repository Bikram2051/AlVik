/**
 * AlVik — authenticated multi-provider LLM proxy (Cloudflare Worker).
 *
 * The browser never sees any API key, and the app password is a Worker
 * secret — it is never shipped to the client or committed to git.
 *
 * Routes:
 *   GET  /api/health              -> { ok: true }            (no auth)
 *   POST /api/login  { password } -> { token, expiresAt }    (no auth)
 *   POST /api/models              -> { models, providers }   (Bearer token)
 *   POST /api/chat                -> SSE stream or { reply, ... }  (Bearer token)
 *   POST /                        -> alias of /api/chat
 *
 * Setup — NEVER write real values here. This file is public; secrets live
 * only in Cloudflare (Dashboard -> Settings -> Variables and Secrets, or
 * the CLI below, which prompts for the value on stdin):
 *   1. wrangler secret put APP_PASSWORD       # the password you type to log in
 *   2. wrangler secret put AUTH_SECRET        # 32+ random chars, signs tokens
 *   3. a key for each provider you use:
 *        wrangler secret put DEEPSEEK_API_KEY
 *        wrangler secret put OPENAI_API_KEY
 *   4. set ALLOWED_ORIGINS in wrangler.toml to your site origin
 *   5. wrangler deploy
 *
 * Only the providers you configure are usable; the rest are reported as
 * unavailable rather than failing the whole Worker.
 *
 * Rotating AUTH_SECRET immediately invalidates every issued session token,
 * which is the fastest way to lock everyone out if a device is lost.
 */

// ============================================================
// PROVIDERS & MODELS
//
// To add a model: add one entry to MODELS. To add a provider: add one
// entry to PROVIDERS and set its key as a Worker secret. No other code
// changes are needed.
//
// Model IDs must be the exact string the provider's API documents —
// marketing names ("GPT 5.6", "Ultra") are usually not the API id. If a
// model is not listed here it can still be used: send it with an explicit
// `provider` and it is passed straight through (see resolveModel).
// ============================================================

// `dialect` selects the request/response translation. 'openai' is the
// OpenAI-compatible shape most providers speak; 'anthropic' is the Messages
// API, which differs in auth header, system prompt placement, response
// shape, and streaming events — see toAnthropicRequest//fromAnthropic*.
const PROVIDERS = {
  deepseek: {
    url: 'https://api.deepseek.com/chat/completions',
    keyEnv: 'DEEPSEEK_API_KEY',
    label: 'DeepSeek',
    dialect: 'openai'
  },
  openai: {
    url: 'https://api.openai.com/v1/chat/completions',
    keyEnv: 'OPENAI_API_KEY',
    label: 'OpenAI',
    dialect: 'openai'
  },
  anthropic: {
    url: 'https://api.anthropic.com/v1/messages',
    keyEnv: 'ANTHROPIC_API_KEY',
    label: 'Anthropic',
    dialect: 'anthropic'
  }
};

// Anthropic requires max_tokens; there is no "provider default" to fall back
// on, so a request without one needs a value supplied here.
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_DEFAULT_MAX_TOKENS = 8192;

// Per-model behaviour. Providers disagree on these details, and getting
// them wrong is a 400 from upstream, so they are data rather than logic:
//   reasoning        - allowed effort tiers, or null if not a reasoning model
//   defaultReasoning - tier used when the client does not pick one
//   thinkingExtraBody- send DeepSeek's extra_body.thinking block
//   maxTokensParam   - 'max_tokens' or 'max_completion_tokens'
//   allowTemperature - reasoning models often reject a custom temperature
const MODELS = {
  'deepseek-v4-pro': {
    provider: 'deepseek', label: 'DeepSeek V4 Pro',
    reasoning: ['low', 'medium', 'high'], defaultReasoning: 'high',
    thinkingExtraBody: true, maxTokensParam: 'max_tokens', allowTemperature: true
  },
  'deepseek-reasoner': {
    provider: 'deepseek', label: 'DeepSeek Reasoner',
    reasoning: ['low', 'medium', 'high'], defaultReasoning: 'high',
    thinkingExtraBody: true, maxTokensParam: 'max_tokens', allowTemperature: true
  },
  'deepseek-chat': {
    provider: 'deepseek', label: 'DeepSeek Chat',
    reasoning: null, maxTokensParam: 'max_tokens', allowTemperature: true
  },
  // Thinking is on by default on Opus 5 and `budget_tokens` is rejected, so
  // the worker never sends one. Effort maps to output_config.effort, and a
  // custom temperature is rejected outright.
  'claude-opus-5': {
    provider: 'anthropic', label: 'Claude Opus 5',
    reasoning: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoning: 'high',
    thinkingExtraBody: false, maxTokensParam: 'max_tokens', allowTemperature: false
  }
};

const DEFAULT_MODEL = 'deepseek-v4-pro';

// Defaults applied to a model that is not in the table above (a custom id
// sent with an explicit provider). Conservative: reasoning models on most
// providers reject `max_tokens` and a non-default temperature.
const CUSTOM_MODEL_DEFAULTS = {
  reasoning: ['low', 'medium', 'high'],
  defaultReasoning: null,          // omit the field unless the client asks
  thinkingExtraBody: false,
  maxTokensParam: 'max_completion_tokens',
  allowTemperature: false
};

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

    // Auth is mandatory. Provider keys are not: you may configure only the
    // providers you use, and a missing one is reported per-model instead of
    // blocking the whole Worker.
    if (!env.APP_PASSWORD || !env.AUTH_SECRET) {
      return json({ error: 'Worker is not configured. Set APP_PASSWORD and AUTH_SECRET.' }, 500, cors);
    }
    if (!Object.values(PROVIDERS).some(p => env[p.keyEnv])) {
      return json({
        error: `No provider API key configured. Set at least one of: ${Object.values(PROVIDERS).map(p => p.keyEnv).join(', ')}.`
      }, 500, cors);
    }

    if (path === '/api/login') return handleLogin(request, env, cors);
    if (path === '/api/models') return handleModels(request, env, cors);
    if (path === '/api/sync') return handleSync(request, env, cors);
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

// ---------------------------------------------------------------- models

// Lets the UI list real models and grey out any whose provider key is not
// set, instead of failing only once a message is sent.
async function handleModels(request, env, cors) {
  if (!(await isAuthed(request, env))) {
    return json({ error: 'Not authenticated' }, 401, cors);
  }

  const models = Object.entries(MODELS).map(([id, spec]) => {
    const provider = PROVIDERS[spec.provider];
    return {
      id,
      label: spec.label || id,
      provider: spec.provider,
      providerLabel: provider.label,
      reasoning: spec.reasoning || null,
      defaultReasoning: spec.defaultReasoning || null,
      available: !!env[provider.keyEnv]
    };
  });

  const providers = Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    label: p.label,
    available: !!env[p.keyEnv],
    keyEnv: p.keyEnv
  }));

  return json({ models, providers, defaultModel: DEFAULT_MODEL }, 200, cors);
}

// ---------------------------------------------------------------- sync

// Cross-device chat history. This is a single-user app, so the whole state
// lives under one key; the client owns merging and the Worker only stores
// what it is given, with a version for optimistic concurrency.
const SYNC_KEY = 'alvik:state:v1';
const SYNC_MAX_BYTES = 20_000_000;   // KV caps values at 25 MB

async function handleSync(request, env, cors) {
  if (!(await isAuthed(request, env))) {
    return json({ error: 'Not authenticated' }, 401, cors);
  }
  if (!env.SYNC) {
    return json({
      error: 'Sync is not configured. Create a KV namespace and bind it as SYNC on the Worker to enable cross-device history.',
      configured: false
    }, 501, cors);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400, cors);
  }

  if (body.op === 'pull') {
    const stored = await env.SYNC.get(SYNC_KEY, 'json');
    return json(stored || { version: 0, updatedAt: 0, branches: {}, trash: [] }, 200, cors);
  }

  if (body.op === 'push') {
    if (typeof body.state !== 'object' || body.state === null) {
      return json({ error: '"state" object is required' }, 400, cors);
    }
    const current = await env.SYNC.get(SYNC_KEY, 'json');
    const currentVersion = current ? (current.version || 0) : 0;

    // Reject a push built on a stale read so the client re-merges rather
    // than silently overwriting another device's newer history.
    if (Number.isFinite(body.baseVersion) && body.baseVersion !== currentVersion) {
      return json({
        error: 'Sync conflict — another device wrote first.',
        conflict: true,
        version: currentVersion,
        state: current
      }, 409, cors);
    }

    const next = {
      version: currentVersion + 1,
      updatedAt: Date.now(),
      branches: body.state.branches && typeof body.state.branches === 'object' ? body.state.branches : {},
      trash: Array.isArray(body.state.trash) ? body.state.trash : []
    };

    const serialized = JSON.stringify(next);
    if (serialized.length > SYNC_MAX_BYTES) {
      return json({ error: 'History is too large to sync. Export a backup and clear old chats.' }, 413, cors);
    }

    await env.SYNC.put(SYNC_KEY, serialized);
    return json({ ok: true, version: next.version, updatedAt: next.updatedAt }, 200, cors);
  }

  return json({ error: 'Unknown sync operation. Use "pull" or "push".' }, 400, cors);
}

// ---------------------------------------------------------------- chat

async function isAuthed(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  return !!token && await verifyToken(env.AUTH_SECRET, token);
}

async function handleChat(request, env, cors) {
  if (!(await isAuthed(request, env))) {
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

  const resolved = resolveModel(body.model, body.provider);
  if (resolved.error) {
    return json({ error: resolved.error }, 400, cors);
  }
  const { model, spec, provider, providerId } = resolved;

  const apiKey = env[provider.keyEnv];
  if (!apiKey) {
    return json({
      error: `No API key configured for ${provider.label}. Set ${provider.keyEnv} in the Worker's secrets to use this model.`
    }, 503, cors);
  }

  const payload = {
    model,
    messages: body.messages.map(m => ({
      role: m.role === 'system' || m.role === 'assistant' ? m.role : 'user',
      content: String(m.content ?? '')
    })),
    stream: body.stream === true
  };

  // Reasoning models on most providers reject a custom temperature.
  if (Number.isFinite(body.temperature) && spec.allowTemperature) {
    payload.temperature = Math.min(2, Math.max(0, body.temperature));
  }

  // Providers disagree on the token-limit field name.
  if (Number.isFinite(body.max_tokens) && body.max_tokens > 0) {
    payload[spec.maxTokensParam] = Math.min(MAX_TOKENS_CAP, Math.floor(body.max_tokens));
  }

  if (spec.reasoning) {
    const asked = typeof body.reasoning_effort === 'string' ? body.reasoning_effort : null;
    const effort = spec.reasoning.includes(asked) ? asked : spec.defaultReasoning;
    if (effort) payload.reasoning_effort = effort;
    // DeepSeek-specific: mirrors the payload this account is known to accept.
    if (spec.thinkingExtraBody) payload.extra_body = { thinking: { type: 'enabled' } };
  }

  const anthropic = provider.dialect === 'anthropic';

  const callUpstream = (p) => {
    const wire = anthropic ? toAnthropicRequest(p, spec) : p;
    const headers = anthropic
      ? {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION
        }
      : {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        };
    return fetch(provider.url, { method: 'POST', headers, body: JSON.stringify(wire) });
  };

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
    return json(describeUpstreamFailure(
      upstream.status,
      (await upstream.text()).slice(0, 600),
      provider,
      model
    ), mapUpstreamStatus(upstream.status), cors);
  }

  if (payload.stream) {
    // Anthropic's event stream is rewritten into the OpenAI-compatible shape
    // so the browser only ever needs one SSE parser.
    const stream = anthropic ? anthropicStreamToOpenAI(upstream.body) : upstream.body;
    return new Response(stream, {
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
  if (anthropic) {
    return json(fromAnthropicResponse(data), 200, cors);
  }
  const msg = data.choices?.[0]?.message || {};
  return json({
    reply: msg.content ?? '',
    ...(msg.reasoning_content ? { reasoning: msg.reasoning_content } : {}),
    usage: data.usage,
    model: data.model
  }, 200, cors);
}

// ---------------------------------------------------------------- anthropic

// The Messages API is not OpenAI-compatible. Differences that matter:
//   - auth is x-api-key plus a required anthropic-version header
//   - the system prompt is a top-level field, not a message with role system
//   - max_tokens is required, not optional
//   - thinking is configured with {type:'adaptive'}; budget_tokens is
//     rejected on current models, as is a custom temperature
//   - effort lives in output_config, not as reasoning_effort
function toAnthropicRequest(payload, spec) {
  // Anthropic takes the system prompt out of band; everything else stays a
  // turn. Consecutive same-role turns are allowed, so no merging is needed.
  const system = payload.messages
    .filter(m => m.role === 'system')
    .map(m => m.content)
    .join('\n\n')
    .trim();

  const messages = payload.messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));

  const out = {
    model: payload.model,
    max_tokens: payload.max_tokens || ANTHROPIC_DEFAULT_MAX_TOKENS,
    messages,
    stream: !!payload.stream,
    // display:'summarized' — the default omits the text entirely, which
    // would render as a long silent pause in the thinking panel.
    thinking: { type: 'adaptive', display: 'summarized' }
  };
  if (system) out.system = system;
  if (spec.reasoning && payload.reasoning_effort) {
    out.output_config = { effort: payload.reasoning_effort };
  }
  return out;
}

// content is an array of blocks, not a single string.
function fromAnthropicResponse(data) {
  const blocks = Array.isArray(data.content) ? data.content : [];
  const reply = blocks.filter(b => b.type === 'text').map(b => b.text || '').join('');
  const reasoning = blocks.filter(b => b.type === 'thinking').map(b => b.thinking || '').join('');

  return {
    reply,
    ...(reasoning ? { reasoning } : {}),
    usage: data.usage
      ? {
          prompt_tokens: data.usage.input_tokens,
          completion_tokens: data.usage.output_tokens,
          total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0)
        }
      : undefined,
    model: data.model,
    // A safety refusal is a successful 200 with no usable content; say so
    // rather than handing the client an empty message.
    ...(data.stop_reason === 'refusal'
      ? { error: 'The model declined this request.', upstreamStatus: 200 }
      : {})
  };
}

// Rewrite the Anthropic event stream into the OpenAI-compatible SSE the
// client already parses, so streaming works without a second client parser.
function anthropicStreamToOpenAI(body) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let closed = false;

  const emit = (controller, delta) => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`));
  };

  return body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;   // skip `event:` lines
        let ev;
        try {
          ev = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }

        if (ev.type === 'content_block_delta') {
          const d = ev.delta || {};
          if (d.type === 'text_delta' && d.text) emit(controller, { content: d.text });
          else if (d.type === 'thinking_delta' && d.thinking) emit(controller, { reasoning_content: d.thinking });
        } else if (ev.type === 'message_delta' && ev.delta?.stop_reason === 'refusal') {
          emit(controller, { content: '\n\n⚠️ The model declined this request.' });
        } else if (ev.type === 'message_stop' && !closed) {
          closed = true;
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        } else if (ev.type === 'error') {
          emit(controller, { content: `\n\n⚠️ ${ev.error?.message || 'Upstream stream error.'}` });
        }
      }
    },
    flush(controller) {
      if (!closed) controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    }
  }));
}

// Translate an upstream failure into a status the client can act on.
//
// The distinction that matters is retryable vs not. A 402 is a billing
// problem and a 400 is a bad request — retrying either just delays the
// real message behind three rounds of backoff.
//
//   429 -> 429  rate limited, retry
//   5xx -> 502  transient upstream fault, retry
//   401/403 -> 503  our API key was refused; a configuration problem
//   everything else -> passed through unchanged, not retried
//
// Upstream 401s are never surfaced as 401: the client reads that as "your
// session expired" and would bounce the user to the sign-in screen over a
// problem that has nothing to do with their session.
function mapUpstreamStatus(status) {
  if (status === 429) return 429;
  if (status >= 500) return 502;
  if (status === 401 || status === 403) return 503;
  return status;
}

function describeUpstreamFailure(status, rawDetail, provider, model) {
  // Providers nest the useful sentence inside {"error":{"message":"…"}}.
  let detail = rawDetail;
  try {
    const parsed = JSON.parse(rawDetail);
    const inner = parsed?.error?.message ?? parsed?.message;
    if (typeof inner === 'string' && inner.trim()) detail = inner.trim();
  } catch { /* not JSON — keep the raw text */ }

  const name = provider.label;
  let error;
  switch (status) {
    case 402:
      error = `${name} rejected the request for billing reasons — the account behind ${provider.keyEnv} is out of credit. Top up with ${name}, then try again.`;
      break;
    case 401:
    case 403:
      error = `${name} refused the API key. Check ${provider.keyEnv} in the Worker's secrets — it may be wrong, revoked, or lacking access to "${model}".`;
      break;
    case 404:
      error = `${name} does not recognise the model "${model}". Check the exact model id in ${name}'s API documentation.`;
      break;
    case 400:
    case 422:
      error = `${name} rejected the request for "${model}".`;
      break;
    case 429:
      error = `${name} is rate limiting this key. Wait a moment and try again.`;
      break;
    default:
      error = status >= 500
        ? `${name} had a server error. This is usually temporary.`
        : `${name} returned an error (${status}).`;
  }
  return { error, detail, upstreamStatus: status };
}

// Map a requested model onto a provider and a parameter profile.
//
// A model listed in MODELS needs no provider hint. Anything else must name
// a known provider explicitly, which is what lets a brand-new model id be
// used the day it ships without editing this file.
function resolveModel(requested, requestedProvider) {
  const id = typeof requested === 'string' ? requested.trim() : '';

  if (!id) {
    const spec = MODELS[DEFAULT_MODEL];
    return { model: DEFAULT_MODEL, spec, provider: PROVIDERS[spec.provider], providerId: spec.provider };
  }

  const known = MODELS[id];
  if (known) {
    return { model: id, spec: known, provider: PROVIDERS[known.provider], providerId: known.provider };
  }

  const pid = typeof requestedProvider === 'string' ? requestedProvider.trim().toLowerCase() : '';
  if (!pid) {
    return { error: `Unknown model "${id}". Send a "provider" field (${Object.keys(PROVIDERS).join(', ')}) to use a model that is not in the built-in list.` };
  }
  if (!PROVIDERS[pid]) {
    return { error: `Unknown provider "${pid}". Known providers: ${Object.keys(PROVIDERS).join(', ')}.` };
  }
  // Guard against a model id being used to reach another path or host.
  if (!/^[A-Za-z0-9._:-]{1,100}$/.test(id)) {
    return { error: 'Invalid model id.' };
  }

  return {
    model: id,
    spec: { ...CUSTOM_MODEL_DEFAULTS, provider: pid },
    provider: PROVIDERS[pid],
    providerId: pid
  };
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
  if (!origin) {
    // No Origin header means this is not a browser cross-origin request —
    // curl, a script, a native app. ALLOWED_ORIGINS exists to stop another
    // *website* from spending your credits through a visitor's browser, and
    // only browsers send Origin. Blocking these would break legitimate
    // tooling while adding nothing: anyone using curl can set any Origin
    // they like. The bearer token is what actually guards this endpoint.
    allowOrigin = '*';
  } else if (allowed.length === 0) {
    allowOrigin = '*';
  } else if (allowed.includes(origin)) {
    allowOrigin = origin;
  } else {
    return null; // a real browser request from a site that is not permitted
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
