// End-to-end test of the delete/undo/trash recovery flow, driving the real index.html in jsdom.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const INDEX_HTML = path.join(ROOT, 'index.html');
const WORKER_JS = path.join(ROOT, 'worker', 'worker.js');
const WRANGLER_TOML = path.join(ROOT, 'worker', 'wrangler.toml');

const fs = require('fs');
const { JSDOM } = require('jsdom');

const HTML_PATH = INDEX_HTML;
// Strip external CDN <script src> tags (no network in test); the libs are stubbed below.
const html = fs.readFileSync(HTML_PATH, 'utf8').replace(/<script src="[^"]*"><\/script>/g, '');

// A pre-authenticated session, so the app boots straight past the sign-in gate.
const SESSION = JSON.stringify({ token: 'test.token', expiresAt: Date.now() + 86400000 });

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
}

// Boot a fresh copy of the app, optionally with pre-seeded localStorage.
function boot(storage = {}) {
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://bikram2051.github.io/My_Assistant/',
    pretendToBeVisual: true,
    beforeParse(w) {
      w.marked = { parse: (s) => String(s), setOptions() {}, use() {}, Renderer: function () {} };
      w.hljs = { highlight: (c) => ({ value: c }), highlightAuto: (c) => ({ value: c }), getLanguage: () => null };
      w.DOMPurify = { sanitize: (s) => String(s) };
      // jsdom implements neither of these on elements.
      w.Element.prototype.scrollTo = function () {};
      w.Element.prototype.scrollIntoView = function () {};
      w.scrollTo = () => {};
      w.confirm = () => true;   // auto-accept confirmations
      w.alert = () => {};
      w.prompt = () => 'renamed';
      w.localStorage.setItem('alvik_session', SESSION);
      for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v);
    }
  });
  return dom.window;
}

const seed = `
  branches = {};
  const mk = (id, name, n) => {
    branches[id] = {
      name,
      messages: Array.from({length:n}, (_,i)=>({role: i%2?'assistant':'user', content: name+' msg '+i})),
      createdAt: Date.now()-1000, updatedAt: Date.now(), pinned:false
    };
  };
  mk('a','Deploy notes',4); mk('b','Recipe ideas',2); mk('c','Work plan',6);
  activeBranchId = 'a'; messages = branches['a'].messages; trash = [];
  persistBranches(); persistTrash(); renderSidebar(); renderMessages(); renderTrash();
`;

console.log('\n=== Setup ===');
const win = boot();
check('app unlocked', win.document.getElementById('app').style.visibility === 'visible');
win.eval(seed);
check('3 conversations seeded', Object.keys(win.eval('branches')).length === 3);
check('trash starts empty', win.eval('trash.length') === 0);

console.log('\n=== Scenario 1: delete a chat, then Undo via the toast ===');
win.eval(`deleteBranch('a')`);
check('chat removed from sidebar state', win.eval(`!branches['a']`));
check('chat captured in trash', win.eval('trash.length') === 1);
check('trash kept all 4 messages', win.eval('trash[0].messages.length') === 4);
check('trash kept the name', win.eval('trash[0].name') === 'Deploy notes');
check('active chat still valid', win.eval('!!branches[activeBranchId]'));

const toast = win.document.getElementById('toast');
const undoBtn = toast.querySelector('.toast-action');
check('Undo button rendered in toast', !!undoBtn, 'toast text: ' + toast.textContent);
check('toast accepts clicks', toast.classList.contains('has-action'));

undoBtn.click();
check('chat restored under its original id', win.eval(`!!branches['a']`));
check('all 4 messages restored', win.eval(`branches['a'].messages.length`) === 4);
check('message content intact', win.eval(`branches['a'].messages[0].content`) === 'Deploy notes msg 0');
check('trash emptied after undo', win.eval('trash.length') === 0);
check('restored chat becomes active', win.eval(`activeBranchId === 'a'`));

console.log('\n=== Scenario 2: a delete survives a page reload ===');
win.eval(`deleteBranch('b')`);
const savedBranches = win.localStorage.getItem('deepseek_branches');
const savedTrash = win.localStorage.getItem('deepseek_trash');
check('trash written to localStorage', !!savedTrash && JSON.parse(savedTrash).length === 1);
check('deleted chat absent from saved branches', !JSON.parse(savedBranches)['b']);

const win2 = boot({
  deepseek_branches: savedBranches,
  deepseek_trash: savedTrash,
  deepseek_active_branch: win.localStorage.getItem('deepseek_active_branch')
});
check('trash survived reload', win2.eval('trash.length') === 1);
check('trashed chat kept its messages', win2.eval('trash[0].messages.length') === 2);

console.log('\n=== Scenario 3: restore from the Settings trash list ===');
win2.eval('openSettings()');
const rows = win2.document.querySelectorAll('.trash-item');
check('trash list rendered one row', rows.length === 1);
check('row shows the chat name', rows[0].textContent.includes('Recipe ideas'), rows[0].textContent);
check('row shows the message count', rows[0].textContent.includes('2 messages'), rows[0].textContent);
const restoreBtn = [...rows[0].querySelectorAll('button')].find(b => b.textContent === 'Restore');
check('Restore button present', !!restoreBtn);
restoreBtn.click();
check('chat restored from settings', win2.eval(`!!branches['b']`));
check('messages intact after restore', win2.eval(`branches['b'].messages.length`) === 2);
check('trash now empty', win2.eval('trash.length') === 0);
check('empty-state message shown', win2.document.getElementById('trashList').textContent.includes('No deleted'));

console.log('\n=== Scenario 4: "Delete all conversations" is recoverable ===');
win2.eval(`
  branches = {};
  const mk=(id,name,n)=>{branches[id]={name,messages:Array.from({length:n},(_,i)=>({role:'user',content:name+i})),createdAt:Date.now(),updatedAt:Date.now(),pinned:false};};
  mk('x','Alpha',3); mk('y','Beta',5); mk('z','',0);
  activeBranchId='x'; messages=branches['x'].messages; trash=[];
  persistBranches(); persistTrash();
`);
win2.document.getElementById('clearAllBtn').click();
check('both content chats moved to trash', win2.eval('trash.length') === 2, 'trash=' + win2.eval('trash.length'));
check('empty scratch chat not trashed', win2.eval(`trash.every(e=>e.messages.length>0)`));
check('a fresh empty chat replaces them', win2.eval('Object.keys(branches).length') === 1);
check('active chat valid after clear-all', win2.eval('!!branches[activeBranchId]'));

const undoAll = win2.document.getElementById('toast').querySelector('.toast-action');
check('Undo offered on delete-all', !!undoAll, 'toast: ' + win2.document.getElementById('toast').textContent);
undoAll.click();
check('both chats restored', win2.eval(`!!branches['x'] && !!branches['y']`));
check('Alpha messages intact', win2.eval(`branches['x'].messages.length`) === 3);
check('Beta messages intact', win2.eval(`branches['y'].messages.length`) === 5);
check('trash cleared after undo-all', win2.eval('trash.length') === 0);
check('leftover empty chat cleaned up', win2.eval('Object.keys(branches).length') === 2,
      'keys=' + win2.eval('JSON.stringify(Object.keys(branches))'));

console.log('\n=== Scenario 5: backup export/import carries the trash ===');
win2.eval(`deleteBranch('x')`);
const payload = win2.eval(`JSON.stringify({app:'alvik',version:APP_VERSION,exportedAt:new Date().toISOString(),branches,trash})`);
const parsed = JSON.parse(payload);
check('export includes a trash array', Array.isArray(parsed.trash) && parsed.trash.length === 1);
check('exported trash carries messages', parsed.trash[0].messages.length === 3);

const win3 = boot();
// Drive the real importBackup() through a File, the same path the file picker uses.
win3.eval(`
  window.__done = false;
  const f = new File([${JSON.stringify(payload)}], 'backup.json', { type: 'application/json' });
  importBackup(f);
  setTimeout(()=>{ window.__done = true; }, 0);
`);
// FileReader is async — wait for it to settle.
const waitFor = (w, cond, ms = 2000) => new Promise((res, rej) => {
  const t0 = Date.now();
  (function poll() {
    let ok = false;
    try { ok = w.eval(cond); } catch {}
    if (ok) return res();
    if (Date.now() - t0 > ms) return rej(new Error('timeout waiting for: ' + cond));
    setTimeout(poll, 10);
  })();
});

waitFor(win3, 'trash.length === 1')
  .then(() => {
    check('import restored the trashed chat', win3.eval('trash.length') === 1);
    check('imported trash content intact', win3.eval('trash[0].messages.length') === 3);
    check('imported live conversations too', win3.eval(`!!branches['y']`));

    console.log('\n=== Scenario 6: 30-day retention purge ===');
    const day = 24 * 60 * 60 * 1000;
    const oldStamp = Date.now() - 31 * day;
    const freshStamp = Date.now() - 2 * day;
    const mixed = JSON.stringify([
      { id:'old', name:'Ancient', messages:[{role:'user',content:'hi'}], createdAt:oldStamp, updatedAt:oldStamp, pinned:false, deletedAt:oldStamp },
      { id:'new', name:'Recent',  messages:[{role:'user',content:'yo'}], createdAt:freshStamp, updatedAt:freshStamp, pinned:false, deletedAt:freshStamp }
    ]);
    const win4 = boot({ deepseek_trash: mixed });
    check('expired entry purged on load', win4.eval('trash.length') === 1, 'len=' + win4.eval('trash.length'));
    check('recent entry kept', win4.eval(`trash[0].name`) === 'Recent');
    check('purge written back to storage', JSON.parse(win4.localStorage.getItem('deepseek_trash')).length === 1);

    console.log('\n=== Scenario 7: corrupt trash data does not break the app ===');
    const win5 = boot({ deepseek_trash: '{not valid json' });
    check('app still boots', win5.document.getElementById('app').style.visibility === 'visible');
    check('trash falls back to an empty array', win5.eval('Array.isArray(trash) && trash.length === 0'));
    check('chat still usable', win5.eval('!!branches[activeBranchId]'));

    console.log('\n=== Scenario 8: deleting the only chat is still safe ===');
    const win6 = boot();
    win6.eval(`
      branches = { solo: {name:'Only one', messages:[{role:'user',content:'important'}], createdAt:Date.now(), updatedAt:Date.now(), pinned:false} };
      activeBranchId='solo'; messages=branches['solo'].messages; trash=[];
      persistBranches(); renderSidebar();
    `);
    win6.eval(`deleteBranch('solo')`);
    check('sole chat went to trash', win6.eval('trash.length') === 1);
    check('app auto-created a replacement chat', win6.eval('Object.keys(branches).length') === 1);
    check('replacement is a valid active chat', win6.eval('!!branches[activeBranchId] && messages.length === 0'));
    win6.document.getElementById('toast').querySelector('.toast-action').click();
    check('sole chat recoverable via Undo', win6.eval(`!!branches['solo'] && branches['solo'].messages[0].content === 'important'`));

    console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(46)}`);
    process.exit(fail ? 1 : 0);
  })
  .catch(err => {
    console.log('  FAIL  import test: ' + err.message);
    console.log(`\n  ${pass} passed, ${fail + 1} failed`);
    process.exit(1);
  });
