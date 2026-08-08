// Tests the Worker's auth: token signing/verification, rejection paths, CORS.
// Runs the real worker.js module against a stubbed DeepSeek upstream.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const INDEX_HTML = path.join(ROOT, 'index.html');
const WORKER_JS = path.join(ROOT, 'worker', 'worker.js');
const WRANGLER_TOML = path.join(ROOT, 'wrangler.toml');

const fs = require('fs');
const { webcrypto } = require('crypto');

globalThis.crypto = webcrypto;
globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
}

// Load worker.js as an ES module.
const SRC = WORKER_JS;
const tmp = path.join(require('os').tmpdir(), 'alvik-worker-under-test.mjs');
fs.copyFileSync(SRC, tmp);

const ENV = {
  DEEPSEEK_API_KEY: 'sk-test-key',
  APP_PASSWORD: 'correct horse battery staple',
  AUTH_SECRET: 'a'.repeat(48),
  ALLOWED_ORIGINS: 'https://bikram2051.github.io'
};
const ORIGIN = 'https://bikram2051.github.io';

// Stub the DeepSeek upstream.
let upstreamCalls = [];
let upstreamMode = 'ok';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  upstreamCalls.push({ url: String(url), init });
  if (upstreamMode === 'error') {
    return new Response('quota exceeded', { status: 429 });
  }
  return new Response(JSON.stringify({
    choices: [{ message: { content: 'hello from the model' } }],
    usage: { total_tokens: 12 },
    model: 'deepseek-chat'
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

// Pass `origin: null` to send no Origin header at all — that is what a
// non-browser client (curl, PowerShell, a native app) actually does.
const req = (p, opts = {}) => {
  const headers = { ...(opts.headers || {}) };
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  if (origin) headers['Origin'] = origin;
  return new Request('https://alvik.example.workers.dev' + p, {
    method: opts.method || 'POST',
    headers,
    body: opts.body
  });
};

(async () => {
  const mod = await import('file://' + tmp);
  const worker = mod.default;
  const call = (p, opts) => worker.fetch(req(p, opts), opts && opts.env ? opts.env : ENV);

  console.log('\n=== Health & config ===');
  let r = await call('/api/health', { method: 'GET' });
  check('health endpoint responds 200', r.status === 200);
  check('health needs no auth', (await r.clone().json()).ok === true);

  r = await call('/api/login', { env: { ALLOWED_ORIGINS: ENV.ALLOWED_ORIGINS }, body: JSON.stringify({ password: 'x' }) });
  check('unconfigured worker fails closed (500)', r.status === 500, 'got ' + r.status);

  console.log('\n=== Login ===');
  r = await call('/api/login', { body: JSON.stringify({ password: 'wrong' }) });
  check('wrong password rejected with 401', r.status === 401, 'got ' + r.status);
  const wrongBody = await r.json();
  check('no token leaked on failure', !wrongBody.token);

  r = await call('/api/login', { body: JSON.stringify({}) });
  check('missing password rejected', r.status === 401);

  r = await call('/api/login', { body: JSON.stringify({ password: ENV.APP_PASSWORD }) });
  check('correct password accepted', r.status === 200, 'got ' + r.status);
  const session = await r.json();
  check('login returns a token', typeof session.token === 'string' && session.token.length > 20);
  check('login returns an expiry', Number.isFinite(session.expiresAt) && session.expiresAt > Date.now());
  check('token is a two-part signed value', session.token.split('.').length === 2);
  check('password is not echoed back', !JSON.stringify(session).includes(ENV.APP_PASSWORD));

  r = await call('/api/login', { body: '{not json' });
  check('malformed login JSON rejected', r.status === 400);

  console.log('\n=== Chat authentication ===');
  upstreamCalls = [];
  r = await call('/api/chat', { body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) });
  check('chat without a token is 401', r.status === 401, 'got ' + r.status);
  check('unauthenticated request never reaches DeepSeek', upstreamCalls.length === 0);

  r = await call('/api/chat', {
    headers: { 'Authorization': 'Bearer garbage' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
  });
  check('garbage token is 401', r.status === 401);
  check('garbage token never reaches DeepSeek', upstreamCalls.length === 0);

  // Forge a token with a valid-looking payload but a bad signature.
  const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const forgedPayload = b64url(JSON.stringify({ exp: Date.now() + 999999 }));
  r = await call('/api/chat', {
    headers: { 'Authorization': `Bearer ${forgedPayload}.${b64url('not-a-real-signature')}` },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
  });
  check('forged signature rejected', r.status === 401);
  check('forged token never reaches DeepSeek', upstreamCalls.length === 0);

  // A token signed with a DIFFERENT secret must not be accepted.
  const otherEnv = { ...ENV, AUTH_SECRET: 'b'.repeat(48) };
  const otherLogin = await worker.fetch(req('/api/login', { body: JSON.stringify({ password: ENV.APP_PASSWORD }) }), otherEnv);
  const otherToken = (await otherLogin.json()).token;
  r = await call('/api/chat', {
    headers: { 'Authorization': `Bearer ${otherToken}` },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
  });
  check('token signed with another secret rejected', r.status === 401);
  check('rotating AUTH_SECRET invalidates old tokens', upstreamCalls.length === 0);

  console.log('\n=== Chat with a valid token ===');
  const good = { 'Authorization': `Bearer ${session.token}` };
  r = await call('/api/chat', { headers: good, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) });
  check('valid token accepted', r.status === 200, 'got ' + r.status + ' ' + (await r.clone().text()).slice(0, 120));
  const chatBody = await r.json();
  check('reply passed through', chatBody.reply === 'hello from the model');
  check('upstream was called once', upstreamCalls.length === 1);
  check('API key sent to DeepSeek, not the client',
        upstreamCalls[0].init.headers.Authorization === 'Bearer sk-test-key' &&
        !JSON.stringify(chatBody).includes('sk-test-key'));

  r = await call('/', { headers: good, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) });
  check('legacy root path still works', r.status === 200);

  console.log('\n=== Expiry ===');
  // Build a correctly-signed but already-expired token using the worker's own scheme.
  const enc = new TextEncoder();
  const key = await webcrypto.subtle.importKey('raw', enc.encode(ENV.AUTH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expPayload = b64url(JSON.stringify({ exp: Date.now() - 1000 }));
  const expSig = b64url(new Uint8Array(await webcrypto.subtle.sign('HMAC', key, enc.encode(expPayload))));
  r = await call('/api/chat', {
    headers: { 'Authorization': `Bearer ${expPayload}.${expSig}` },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
  });
  check('expired token rejected even with a valid signature', r.status === 401, 'got ' + r.status);

  // Sanity: same construction but in the future must pass.
  const okPayload = b64url(JSON.stringify({ exp: Date.now() + 60000 }));
  const okSig = b64url(new Uint8Array(await webcrypto.subtle.sign('HMAC', key, enc.encode(okPayload))));
  r = await call('/api/chat', {
    headers: { 'Authorization': `Bearer ${okPayload}.${okSig}` },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
  });
  check('unexpired token with valid signature passes', r.status === 200);

  console.log('\n=== CORS lockdown ===');
  r = await call('/api/chat', { origin: 'https://evil.example.com', headers: good, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) });
  check('foreign browser origin blocked with 403', r.status === 403, 'got ' + r.status);

  // Non-browser clients send no Origin at all. CORS is a browser mechanism,
  // so refusing these breaks curl/scripts/native apps without adding any
  // protection — the bearer token is the real gate.
  r = await call('/api/login', { origin: null, body: JSON.stringify({ password: ENV.APP_PASSWORD }) });
  check('client with no Origin can log in', r.status === 200, 'got ' + r.status);
  const cliToken = (await r.json()).token;
  check('and receives a usable token', typeof cliToken === 'string' && cliToken.length > 20);

  upstreamCalls = [];
  r = await call('/api/chat', {
    origin: null,
    headers: { 'Authorization': `Bearer ${cliToken}` },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
  });
  check('client with no Origin can chat', r.status === 200, 'got ' + r.status);
  check('no-Origin request still requires a valid token',
        (await call('/api/chat', { origin: null, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) })).status === 401);

  r = await call('/api/health', { method: 'GET', origin: null });
  check('health reachable without an Origin', r.status === 200);

  r = await call('/api/health', { method: 'GET' });
  check('allowed origin echoed in CORS header', r.headers.get('Access-Control-Allow-Origin') === ORIGIN);
  check('Authorization header is permitted by CORS',
        (r.headers.get('Access-Control-Allow-Headers') || '').includes('Authorization'));

  r = await call('/api/chat', { method: 'OPTIONS', origin: ORIGIN });
  check('preflight returns 204', r.status === 204);

  console.log('\n=== Upstream errors do not look like auth failures ===');
  upstreamMode = 'error';
  r = await call('/api/chat', { headers: good, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) });
  check('upstream 429 surfaces as 429, not 401', r.status === 429, 'got ' + r.status);
  upstreamMode = 'ok';

  console.log('\n=== Upstream failures are classified, not lumped together ===');
  const upstreamFails = async (status, bodyText) => {
    const saved = globalThis.fetch;
    globalThis.fetch = async () => new Response(bodyText, { status });
    const rr = await call('/api/chat', {
      headers: good,
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], model: 'deepseek-v4-pro' })
    });
    globalThis.fetch = saved;
    return { status: rr.status, body: await rr.json() };
  };

  // The real failure seen in production: DeepSeek 402 Insufficient Balance.
  let f = await upstreamFails(402, '{"error":{"message":"Insufficient Balance","type":"unknown_error"}}');
  check('billing failure is not disguised as a server error', f.status === 402, 'got ' + f.status);
  check('billing message says what to do', /out of credit|billing/i.test(f.body.error), f.body.error);
  check('provider is named', f.body.error.includes('DeepSeek'));
  check('the secret to check is named', f.body.error.includes('DEEPSEEK_API_KEY'));
  check('nested provider message is unwrapped', f.body.detail === 'Insufficient Balance', f.body.detail);
  check('original upstream status preserved', f.body.upstreamStatus === 402);

  f = await upstreamFails(401, '{"error":{"message":"invalid api key"}}');
  check('a refused key is never surfaced as 401', f.status !== 401, 'got ' + f.status);
  check('a refused key reads as a configuration problem', f.status === 503, 'got ' + f.status);
  check('refused-key message names the secret', f.body.error.includes('DEEPSEEK_API_KEY'));

  f = await upstreamFails(404, '{"error":{"message":"model not found"}}');
  check('unknown model passes 404 through', f.status === 404);
  check('unknown-model message names the model', f.body.error.includes('deepseek-v4-pro'));

  f = await upstreamFails(500, 'gateway blew up');
  check('genuine upstream fault maps to 502', f.status === 502);
  check('non-JSON detail is kept verbatim', f.body.detail === 'gateway blew up');

  f = await upstreamFails(400, '{"error":{"message":"bad parameter"}}');
  check('bad request passes 400 through, not retried as 5xx', f.status === 400);

  console.log('\n=== Input validation still enforced ===');
  r = await call('/api/chat', { headers: good, body: JSON.stringify({ messages: [] }) });
  check('empty messages rejected', r.status === 400);
  r = await call('/api/chat', { headers: good, body: JSON.stringify({ messages: Array(500).fill({ role: 'user', content: 'x' }) }) });
  check('too many messages rejected', r.status === 400);
  upstreamCalls = [];
  r = await call('/api/chat', { headers: good, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], model: 'some-new-model' }) });
  check('unknown model without a provider is rejected, not silently swapped', r.status === 400, 'got ' + r.status);
  check('rejection explains how to fix it', (await r.json()).error.includes('provider'));
  check('unknown model never reaches an upstream', upstreamCalls.length === 0);

  upstreamCalls = [];
  r = await call('/api/chat', { headers: good, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) });
  check('omitted model uses the default',
        JSON.parse(upstreamCalls[0].init.body).model === 'deepseek-v4-pro');

  console.log('\n=== Model handling (matches the previously deployed worker) ===');
  const sendModel = async (model, extra = {}) => {
    upstreamCalls = [];
    await call('/api/chat', {
      headers: good,
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], model, ...extra })
    });
    return JSON.parse(upstreamCalls[0].init.body);
  };

  let sent = await sendModel('deepseek-v4-pro');
  check('deepseek-v4-pro is allowed through', sent.model === 'deepseek-v4-pro', sent.model);
  check('v4-pro gets reasoning_effort high', sent.reasoning_effort === 'high', String(sent.reasoning_effort));
  check('v4-pro gets thinking mode enabled',
        sent.extra_body && sent.extra_body.thinking && sent.extra_body.thinking.type === 'enabled',
        JSON.stringify(sent.extra_body));

  sent = await sendModel('deepseek-reasoner');
  check('reasoner also gets thinking mode', sent.extra_body?.thinking?.type === 'enabled');

  sent = await sendModel('deepseek-chat');
  check('deepseek-chat passes through unchanged', sent.model === 'deepseek-chat');
  check('non-reasoning model gets no reasoning_effort', sent.reasoning_effort === undefined);
  check('non-reasoning model gets no extra_body', sent.extra_body === undefined);

  sent = await sendModel('deepseek-v4-pro', { reasoning_effort: 'low' });
  check('client may lower reasoning_effort', sent.reasoning_effort === 'low');
  sent = await sendModel('deepseek-v4-pro', { reasoning_effort: 'ludicrous' });
  check('invalid reasoning_effort falls back to high', sent.reasoning_effort === 'high');

  console.log('\n=== Multi-provider routing ===');
  const ENV2 = { ...ENV, OPENAI_API_KEY: 'sk-openai-test' };
  const call2 = (p, opts) => worker.fetch(req(p, opts), ENV2);

  const sendTo = async (bodyObj, env2 = true) => {
    upstreamCalls = [];
    const rr = await (env2 ? call2 : call)('/api/chat', {
      headers: good,
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], ...bodyObj })
    });
    return { res: rr, sent: upstreamCalls[0] ? JSON.parse(upstreamCalls[0].init.body) : null, raw: upstreamCalls[0] };
  };

  let t = await sendTo({ model: 'deepseek-v4-pro' });
  check('deepseek model routed to the deepseek endpoint',
        t.raw.url === 'https://api.deepseek.com/chat/completions', t.raw.url);
  check('deepseek request uses the deepseek key',
        t.raw.init.headers.Authorization === 'Bearer sk-test-key');

  t = await sendTo({ model: 'gpt-some-future-id', provider: 'openai' });
  check('custom model routed to the openai endpoint',
        t.raw && t.raw.url === 'https://api.openai.com/v1/chat/completions', t.raw && t.raw.url);
  check('openai request uses the openai key',
        t.raw.init.headers.Authorization === 'Bearer sk-openai-test');
  check('custom model id passed through verbatim', t.sent.model === 'gpt-some-future-id');
  check('keys are never crossed between providers',
        !JSON.stringify(t.raw.init.headers).includes('sk-test-key'));

  t = await sendTo({ model: 'gpt-x', provider: 'openai', max_tokens: 500, temperature: 0.7 });
  check('custom model uses max_completion_tokens', t.sent.max_completion_tokens === 500,
        JSON.stringify({ mt: t.sent.max_tokens, mct: t.sent.max_completion_tokens }));
  check('custom model omits max_tokens', t.sent.max_tokens === undefined);
  check('temperature suppressed where reasoning models reject it', t.sent.temperature === undefined);
  check('deepseek still gets max_tokens and temperature',
        (await sendTo({ model: 'deepseek-chat', max_tokens: 500, temperature: 0.7 })).sent.max_tokens === 500);

  t = await sendTo({ model: 'gpt-x', provider: 'openai' });
  check('custom model sends no reasoning_effort unless asked', t.sent.reasoning_effort === undefined);
  check('custom model never gets deepseek extra_body', t.sent.extra_body === undefined);
  t = await sendTo({ model: 'gpt-x', provider: 'openai', reasoning_effort: 'high' });
  check('custom model honours a requested thinking level', t.sent.reasoning_effort === 'high');

  t = await sendTo({ model: 'gpt-x', provider: 'not-a-provider' });
  check('unknown provider rejected', t.res.status === 400);
  t = await sendTo({ model: 'http://evil/x', provider: 'openai' });
  check('malformed model id rejected', t.res.status === 400);

  // Provider with no key configured must say so, not fail obscurely.
  t = await sendTo({ model: 'gpt-x', provider: 'openai' }, false);
  check('missing provider key returns 503', t.res.status === 503, 'got ' + t.res.status);
  const missing = await t.res.json();
  check('missing-key error names the secret', missing.error.includes('OPENAI_API_KEY'), missing.error);
  check('missing key means no upstream call', upstreamCalls.length === 0);

  console.log('\n=== Anthropic dialect (Messages API is not OpenAI-compatible) ===');
  const ENV3 = { ...ENV, ANTHROPIC_API_KEY: 'sk-ant-test' };
  const callA = async (bodyObj) => {
    upstreamCalls = [];
    const rr = await worker.fetch(req('/api/chat', {
      headers: good,
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], ...bodyObj })
    }), ENV3);
    const raw = upstreamCalls[0];
    return { res: rr, sent: raw ? JSON.parse(raw.init.body) : null, raw };
  };

  let a = await callA({ model: 'claude-opus-5' });
  check('routed to the Messages endpoint',
        a.raw.url === 'https://api.anthropic.com/v1/messages', a.raw.url);
  check('uses x-api-key, not Bearer',
        a.raw.init.headers['x-api-key'] === 'sk-ant-test' && !a.raw.init.headers.Authorization,
        JSON.stringify(a.raw.init.headers));
  check('sends the required anthropic-version header',
        a.raw.init.headers['anthropic-version'] === '2023-06-01');
  check('max_tokens always present (Anthropic requires it)',
        typeof a.sent.max_tokens === 'number' && a.sent.max_tokens > 0, String(a.sent.max_tokens));
  check('thinking is adaptive, never budget_tokens (400 on Opus 5)',
        a.sent.thinking.type === 'adaptive' && a.sent.thinking.budget_tokens === undefined);
  check('thinking display opts into summaries', a.sent.thinking.display === 'summarized');
  check('effort goes in output_config, not reasoning_effort',
        a.sent.output_config.effort === 'high' && a.sent.reasoning_effort === undefined,
        JSON.stringify({ oc: a.sent.output_config, re: a.sent.reasoning_effort }));

  a = await callA({ model: 'claude-opus-5', temperature: 0.9 });
  check('temperature never sent (400 on Opus 5)', a.sent.temperature === undefined);
  a = await callA({ model: 'claude-opus-5', reasoning_effort: 'xhigh' });
  check('xhigh effort accepted', a.sent.output_config.effort === 'xhigh');

  // The system prompt must be lifted out of messages into a top-level field.
  upstreamCalls = [];
  await worker.fetch(req('/api/chat', {
    headers: good,
    body: JSON.stringify({
      model: 'claude-opus-5',
      messages: [
        { role: 'system', content: 'You are terse.' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'again' }
      ]
    })
  }), ENV3);
  const sentSys = JSON.parse(upstreamCalls[0].init.body);
  check('system lifted to a top-level field', sentSys.system === 'You are terse.');
  check('system removed from the messages array',
        sentSys.messages.every(m => m.role !== 'system'), JSON.stringify(sentSys.messages));
  check('conversation turns preserved in order',
        sentSys.messages.length === 3 && sentSys.messages[2].content === 'again');

  console.log('\n=== Anthropic response translation ===');
  const savedFetch2 = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    content: [
      { type: 'thinking', thinking: 'considering...' },
      { type: 'text', text: 'Hello there.' }
    ],
    usage: { input_tokens: 10, output_tokens: 4 },
    model: 'claude-opus-5',
    stop_reason: 'end_turn'
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  r = await worker.fetch(req('/api/chat', {
    headers: good,
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], model: 'claude-opus-5' })
  }), ENV3);
  const abody = await r.json();
  check('content blocks flattened into reply', abody.reply === 'Hello there.', abody.reply);
  check('thinking block surfaced as reasoning', abody.reasoning === 'considering...');
  check('usage mapped to the common shape',
        abody.usage.prompt_tokens === 10 && abody.usage.completion_tokens === 4 && abody.usage.total_tokens === 14,
        JSON.stringify(abody.usage));

  // A refusal is a 200 with no usable content — must not look like success.
  globalThis.fetch = async () => new Response(JSON.stringify({
    content: [], stop_reason: 'refusal', model: 'claude-opus-5'
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  r = await worker.fetch(req('/api/chat', {
    headers: good,
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], model: 'claude-opus-5' })
  }), ENV3);
  check('refusal surfaced rather than an empty reply', (await r.json()).error !== undefined);
  globalThis.fetch = savedFetch2;

  console.log('\n=== Anthropic streaming translation ===');
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"model":"claude-opus-5"}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}',
    '',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}',
    '',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hel"}}',
    '',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"lo"}}',
    '',
    'data: {"type":"message_stop"}',
    ''
  ].join('\n');

  const savedFetch3 = globalThis.fetch;
  globalThis.fetch = async () => new Response(sse, {
    status: 200, headers: { 'Content-Type': 'text/event-stream' }
  });
  r = await worker.fetch(req('/api/chat', {
    headers: good,
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], model: 'claude-opus-5', stream: true })
  }), ENV3);
  check('streaming response passes through as SSE',
        (r.headers.get('content-type') || '').includes('text/event-stream'));
  const streamed = await r.text();
  globalThis.fetch = savedFetch3;

  // Parse it exactly the way the browser client does.
  const pieces = [];
  const reasoningPieces = [];
  let sawDone = false;
  for (const line of streamed.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const p = t.slice(5).trim();
    if (p === '[DONE]') { sawDone = true; continue; }
    const j = JSON.parse(p);
    const d = j.choices?.[0]?.delta || {};
    if (d.content) pieces.push(d.content);
    if (d.reasoning_content) reasoningPieces.push(d.reasoning_content);
  }
  check('text deltas translated to OpenAI shape', pieces.join('') === 'Hello', pieces.join(''));
  check('thinking deltas translated to reasoning_content', reasoningPieces.join('') === 'hmm');
  check('stream terminated with [DONE]', sawDone);

  console.log('\n=== /api/models ===');
  r = await call2('/api/models', { headers: good });
  check('models endpoint requires no extra setup', r.status === 200, 'got ' + r.status);
  const cat = await r.json();
  check('returns the model list', Array.isArray(cat.models) && cat.models.length >= 3);
  check('marks configured providers available',
        cat.providers.find(p => p.id === 'openai').available === true);
  check('reports reasoning tiers per model',
        Array.isArray(cat.models.find(m => m.id === 'deepseek-v4-pro').reasoning));
  check('deepseek-chat reports no reasoning',
        cat.models.find(m => m.id === 'deepseek-chat').reasoning === null);
  check('never leaks key values',
        !JSON.stringify(cat).includes('sk-openai-test') && !JSON.stringify(cat).includes('sk-test-key'));

  r = await call2('/api/models', {});
  check('models endpoint requires auth', r.status === 401);

  r = await call('/api/models', { headers: good });
  check('unconfigured provider shown unavailable',
        (await r.json()).providers.find(p => p.id === 'openai').available === false);

  console.log('\n=== Streaming fallback ===');
  // A model that rejects stream:true must not surface as a hard error.
  let seen = [];
  upstreamMode = 'custom';
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const b = JSON.parse(init.body);
    seen.push(b.stream);
    if (b.stream) return new Response('streaming not supported for this model', { status: 400 });
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'non-streamed reply' } }], model: b.model
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  r = await call('/api/chat', {
    headers: good,
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], model: 'deepseek-v4-pro', stream: true })
  });
  check('streaming rejection retries without streaming', seen.length === 2 && seen[0] === true && seen[1] === false,
        JSON.stringify(seen));
  check('user still gets a usable reply', r.status === 200, 'got ' + r.status);
  check('reply content preserved on fallback', (await r.json()).reply === 'non-streamed reply');
  globalThis.fetch = savedFetch;
  upstreamMode = 'ok';

  console.log('\n=== Sync storage ===');
  // Minimal in-memory KV stand-in.
  const kv = new Map();
  const ENV_KV = {
    ...ENV,
    SYNC: {
      get: async (k, type) => {
        const v = kv.get(k);
        if (v === undefined) return null;
        return type === 'json' ? JSON.parse(v) : v;
      },
      put: async (k, v) => { kv.set(k, v); }
    }
  };
  const sync = (payload, env2 = ENV_KV, headers = good) =>
    worker.fetch(req('/api/sync', { headers, body: JSON.stringify(payload) }), env2);

  r = await sync({ op: 'pull' }, ENV);
  check('sync reports unconfigured without a KV binding', r.status === 501, 'got ' + r.status);
  check('unconfigured message names the binding', (await r.json()).error.includes('SYNC'));

  r = await sync({ op: 'pull' }, ENV_KV, {});
  check('sync requires authentication', r.status === 401);

  r = await sync({ op: 'pull' });
  const empty = await r.json();
  check('first pull returns an empty state', empty.version === 0 && Object.keys(empty.branches).length === 0);

  r = await sync({ op: 'push', baseVersion: 0, state: {
    branches: { a: { name: 'A', messages: [{ role: 'user', content: 'hi' }], updatedAt: 100 } },
    trash: []
  }});
  check('push accepted', r.status === 200, 'got ' + r.status);
  check('push bumps the version', (await r.json()).version === 1);

  r = await sync({ op: 'pull' });
  const pulled = await r.json();
  check('pull returns what was pushed', pulled.branches.a.messages[0].content === 'hi');
  check('pulled state carries the version', pulled.version === 1);

  // A second device pushing from a stale read must be told, not silently win.
  r = await sync({ op: 'push', baseVersion: 0, state: { branches: {}, trash: [] } });
  check('stale push rejected with 409', r.status === 409, 'got ' + r.status);
  const conflict = await r.json();
  check('conflict returns the current version', conflict.version === 1);
  check('conflict returns the winning state so the client can re-merge',
        conflict.state.branches.a !== undefined);

  r = await sync({ op: 'pull' });
  check('rejected push did not overwrite', (await r.json()).branches.a !== undefined);

  r = await sync({ op: 'push', baseVersion: 1, state: { branches: { a: { name: 'A2', messages: [], updatedAt: 200 } }, trash: [] } });
  check('push with the current version succeeds', r.status === 200);

  r = await sync({ op: 'push', state: { branches: {}, trash: [] } });
  check('push without baseVersion is allowed (force)', r.status === 200);

  r = await sync({ op: 'nonsense' });
  check('unknown sync op rejected', r.status === 400);
  r = await sync({ op: 'push' });
  check('push without state rejected', r.status === 400);

  console.log('\n=== Rate limiting ===');
  let limited = false;
  for (let i = 0; i < 14; i++) {
    const rr = await worker.fetch(
      new Request('https://alvik.example.workers.dev/api/login', {
        method: 'POST',
        headers: { 'Origin': ORIGIN, 'CF-Connecting-IP': '203.0.113.9' },
        body: JSON.stringify({ password: 'guess' + i })
      }), ENV);
    if (rr.status === 429) { limited = true; break; }
  }
  check('repeated wrong passwords get rate limited', limited);

  console.log('\n=== No secrets in the shipped client ===');
  const client = fs.readFileSync(INDEX_HTML, 'utf8');
  check('no hardcoded PASSWORD constant', !/const\s+PASSWORD\s*=/.test(client));
  check('old password string is gone', !client.includes('Power@56789'));
  check('no DeepSeek API key in client', !/sk-[a-zA-Z0-9]{20,}/.test(client));
  check('client points at the configured worker', client.includes('https://deepseekv4pro.vikrambhattarai1994.workers.dev'));
  check('worker name matches wrangler.toml (deploy replaces in place)',
        fs.readFileSync(WRANGLER_TOML,'utf8').includes('name = "deepseekv4pro"'));
  check('client calls the login endpoint', client.includes('/api/login'));
  check('client sends a bearer token', client.includes('Bearer ${authToken()'));

  fs.unlinkSync(tmp);
  console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
