// Tests the client sign-in flow against a stubbed Worker: login success,
// failure, session persistence, and re-lock on an expired session.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const INDEX_HTML = path.join(ROOT, 'index.html');
const WORKER_JS = path.join(ROOT, 'worker', 'worker.js');
const WRANGLER_TOML = path.join(ROOT, 'worker', 'wrangler.toml');

const fs = require('fs');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(INDEX_HTML, 'utf8')
  .replace(/<script src="[^"]*"><\/script>/g, '');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
}

const GOOD_PASSWORD = 'correct horse battery staple';

// Boot the app with a fake Worker behind fetch.
function boot({ storage = {}, fetchImpl } = {}) {
  const calls = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://bikram2051.github.io/',
    pretendToBeVisual: true,
    beforeParse(w) {
      w.marked = { parse: (s) => String(s), setOptions() {}, use() {}, Renderer: function () {} };
      w.hljs = { highlight: (c) => ({ value: c }), highlightAuto: (c) => ({ value: c }), getLanguage: () => null };
      w.DOMPurify = { sanitize: (s) => String(s) };
      w.Element.prototype.scrollTo = function () {};
      w.Element.prototype.scrollIntoView = function () {};
      w.scrollTo = () => {};
      w.confirm = () => true; w.alert = () => {}; w.prompt = () => 'x';
      w.Response = Response;   // jsdom has no fetch/Response; use Node's
      for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v);

      w.fetch = async (url, init) => {
        calls.push({ url: String(url), init });
        if (fetchImpl) return fetchImpl(String(url), init, w);
        // Default stub Worker.
        if (String(url).endsWith('/api/login')) {
          const body = JSON.parse(init.body);
          if (body.password === GOOD_PASSWORD) {
            return new Response(JSON.stringify({ token: 'signed.token', expiresAt: Date.now() + 86400000 }),
              { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          return new Response(JSON.stringify({ error: 'Incorrect password.' }),
            { status: 401, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({ reply: 'hi' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      };
    }
  });
  return { win: dom.window, calls };
}

const settle = (ms = 60) => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('\n=== Locked by default ===');
  let { win, calls } = boot();
  check('app hidden before sign-in', win.document.getElementById('app').style.visibility !== 'visible');
  check('auth overlay visible', win.document.getElementById('authOverlay').classList.contains('show'));
  check('no network call on load', calls.length === 0);

  console.log('\n=== Wrong password ===');
  win.document.getElementById('authInput').value = 'hunter2';
  win.document.getElementById('authSubmit').click();
  await settle();
  check('login request sent to /api/login', calls.length === 1 && calls[0].url.endsWith('/api/login'));
  check('password sent in the body, not the URL',
        JSON.parse(calls[0].init.body).password === 'hunter2' && !calls[0].url.includes('hunter2'));
  check('app stays locked', win.document.getElementById('app').style.visibility !== 'visible');
  check('error shown from the server', win.document.getElementById('authError').textContent.includes('Incorrect password'),
        win.document.getElementById('authError').textContent);
  check('no session stored', !win.localStorage.getItem('alvik_session'));
  check('input cleared for retry', win.document.getElementById('authInput').value === '');
  check('button re-enabled', win.document.getElementById('authSubmit').disabled === false);
  check('button label restored', win.document.getElementById('authSubmit').textContent === 'Continue',
        win.document.getElementById('authSubmit').textContent);

  console.log('\n=== Correct password ===');
  win.document.getElementById('authInput').value = GOOD_PASSWORD;
  win.document.getElementById('authSubmit').click();
  await settle();
  check('app unlocked', win.document.getElementById('app').style.visibility === 'visible');
  check('session persisted', !!win.localStorage.getItem('alvik_session'));
  const stored = JSON.parse(win.localStorage.getItem('alvik_session'));
  check('stored value is the token', stored.token === 'signed.token');
  check('the password itself is never stored',
        !JSON.stringify(win.localStorage).includes(GOOD_PASSWORD));
  check('a chat is ready to use', win.eval('!!branches[activeBranchId]'));

  console.log('\n=== Session survives reload ===');
  const sess = win.localStorage.getItem('alvik_session');
  const r2 = boot({ storage: { alvik_session: sess } });
  check('returning user skips sign-in', r2.win.document.getElementById('app').style.visibility === 'visible');
  check('no login call on reload', r2.calls.length === 0);

  console.log('\n=== Expired session ===');
  const expired = JSON.stringify({ token: 'old.token', expiresAt: Date.now() - 1000 });
  const r3 = boot({ storage: { alvik_session: expired } });
  check('expired session does not unlock', r3.win.document.getElementById('app').style.visibility !== 'visible');
  check('expired session purged from storage', !r3.win.localStorage.getItem('alvik_session'));

  console.log('\n=== Chat request carries the bearer token ===');
  const r4 = boot({ storage: { alvik_session: sess } });
  r4.win.eval(`
    branches = { t: {name:'T', messages:[], createdAt:Date.now(), updatedAt:Date.now(), pinned:false} };
    activeBranchId='t'; messages=branches['t'].messages;
    document.getElementById('userInput').value = 'ping';
    sendMessage();
  `);
  await settle(150);
  const chatCall = r4.calls.find(c => c.url.endsWith('/api/chat'));
  check('chat hits /api/chat', !!chatCall, 'urls: ' + r4.calls.map(c => c.url).join(', '));
  check('Authorization header present', chatCall && chatCall.init.headers.Authorization === 'Bearer signed.token',
        chatCall && JSON.stringify(chatCall.init.headers));

  console.log('\n=== A 401 from the Worker re-locks the app ===');
  const r5 = boot({
    storage: { alvik_session: sess },
    fetchImpl: async (url, init, w) =>
      new Response(JSON.stringify({ error: 'Not authenticated' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } })
  });
  check('starts unlocked', r5.win.document.getElementById('app').style.visibility === 'visible');
  r5.win.eval(`
    branches = { t: {name:'T', messages:[], createdAt:Date.now(), updatedAt:Date.now(), pinned:false} };
    activeBranchId='t'; messages=branches['t'].messages;
    document.getElementById('userInput').value = 'ping';
    sendMessage();
  `);
  await settle(250);
  check('app re-locked after 401', r5.win.document.getElementById('app').style.visibility !== 'visible');
  check('stale session cleared', !r5.win.localStorage.getItem('alvik_session'));
  check('sign-in prompt explains why',
        r5.win.document.getElementById('authError').textContent.toLowerCase().includes('expired'),
        r5.win.document.getElementById('authError').textContent);
  check('only one attempt made — no retry storm',
        r5.calls.filter(c => c.url.endsWith('/api/chat')).length === 1,
        'calls=' + r5.calls.filter(c => c.url.endsWith('/api/chat')).length);
  check('the user message was still saved', r5.win.eval(`branches['t'].messages.some(m=>m.content==='ping')`));

  console.log('\n=== Model settings migration (v1 -> v2) ===');
  // The old proxy ignored the model field and always served V4 Pro, so a
  // stored 'deepseek-chat' must not become a silent downgrade.
  const r7 = boot({ storage: {
    alvik_session: sess,
    assistant_settings: JSON.stringify({ model: 'deepseek-chat', temperature: 1.0 })
  }});
  check('legacy deepseek-chat migrated to V4 Pro', r7.win.eval('settings.model') === 'deepseek-v4-pro',
        r7.win.eval('settings.model'));
  check('migration is persisted', JSON.parse(r7.win.localStorage.getItem('assistant_settings')).v === 2);
  check('other settings preserved', r7.win.eval('settings.temperature') === 1.0);

  // An explicit non-default choice must be respected, not overwritten.
  const r8 = boot({ storage: {
    alvik_session: sess,
    assistant_settings: JSON.stringify({ model: 'deepseek-reasoner' })
  }});
  check('explicit reasoner choice kept', r8.win.eval('settings.model') === 'deepseek-reasoner');

  // Already migrated: leave it alone even if it says deepseek-chat.
  const r9 = boot({ storage: {
    alvik_session: sess,
    assistant_settings: JSON.stringify({ model: 'deepseek-chat', v: 2 })
  }});
  check('post-migration deepseek-chat is respected', r9.win.eval('settings.model') === 'deepseek-chat');

  const r10 = boot({ storage: { alvik_session: sess } });
  check('fresh install defaults to V4 Pro', r10.win.eval('settings.model') === 'deepseek-v4-pro');
  check('V4 Pro offered in the model picker',
        r10.win.eval(`MODELS.some(m => m.id === 'deepseek-v4-pro')`));

  console.log('\n=== Worker unreachable ===');
  const r6 = boot({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  r6.win.document.getElementById('authInput').value = GOOD_PASSWORD;
  r6.win.document.getElementById('authSubmit').click();
  await settle();
  check('network failure reported clearly',
        r6.win.document.getElementById('authError').textContent.includes('Cannot reach the server'),
        r6.win.document.getElementById('authError').textContent);
  check('form usable again after failure', r6.win.document.getElementById('authSubmit').disabled === false);

  console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
