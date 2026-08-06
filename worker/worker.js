/**
 * DeepSeek API proxy — production Cloudflare Worker.
 *
 * Supports both response modes the chat UI understands:
 *   - stream: true  → passes the OpenAI-compatible SSE stream straight through
 *   - stream: false → returns { reply, reasoning?, usage, model } JSON
 *     (backward compatible with the original { reply } worker)
 *
 * Setup:
 *   1. wrangler secret put DEEPSEEK_API_KEY
 *   2. (optional) set ALLOWED_ORIGINS var to a comma-separated list of
 *      origins, e.g. "https://yourname.github.io,https://yourdomain.com".
 *      When unset, any origin is allowed (fine for a personal project,
 *      lock it down once you have a stable URL).
 *   3. wrangler deploy
 */

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const DEFAULT_MODEL = 'deepseek-chat';
const ALLOWED_MODELS = ['deepseek-chat', 'deepseek-reasoner'];
const MAX_BODY_BYTES = 2_000_000;   // 2 MB request cap
const MAX_MESSAGES = 400;
const MAX_TOKENS_CAP = 8192;

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405, cors);
    }
    if (cors === null) {
      return json({ error: 'Origin not allowed' }, 403, {});
    }

    // ---- Parse & validate ----
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

    // ---- Call upstream ----
    let upstream;
    try {
      upstream = await fetch(DEEPSEEK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`
        },
        body: JSON.stringify(payload)
      });
    } catch (e) {
      return json({ error: 'Upstream unreachable', detail: String(e) }, 502, cors);
    }

    if (!upstream.ok) {
      const detail = (await upstream.text()).slice(0, 600);
      const status = upstream.status === 429 ? 429 : 502;
      return json({ error: `Upstream error ${upstream.status}`, detail }, status, cors);
    }

    // ---- Streaming: pass the SSE body straight through ----
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

    // ---- Non-streaming: keep the legacy { reply } shape ----
    const data = await upstream.json();
    const msg = data.choices?.[0]?.message || {};
    return json({
      reply: msg.content ?? '',
      ...(msg.reasoning_content ? { reasoning: msg.reasoning_content } : {}),
      usage: data.usage,
      model: data.model
    }, 200, cors);
  }
};

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
    return null; // signals "origin not allowed" for non-preflight requests
  }

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' }
  });
}
