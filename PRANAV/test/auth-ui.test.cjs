const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../public/js/auth.js'), 'utf8').replace('export async function signIn', 'async function signIn') + '\nthis.loadClerk = loadClerk;';
const key = 'pk_test_' + Buffer.from('auth.example.clerk.accounts.dev$').toString('base64');
function fixture({ brokenUI = false } = {}) {
  const urls = [], loads = [], w = {};
  const Ctor = function ClerkUI() {};
  const context = { window: w, atob, setTimeout, clearTimeout, document: { createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild(script) {
    urls.push(script.src);
    queueMicrotask(() => {
      if (script.src.includes('/ui@')) { if (brokenUI) return script.onerror(); w.__internal_ClerkUICtor = Ctor; }
      else w.Clerk = { load: async options => { loads.push(options); }, openUserProfile() {} };
      script.onload();
    });
  } } } };
  vm.runInNewContext(source, context);
  return { context, urls, loads, Ctor };
}
test('Clerk v6 loads separate UI before core and supplies its constructor', async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.context.loadClerk(key), f.context.loadClerk(key)]);
  assert.equal(a, b); assert.equal(f.urls.length, 2);
  assert.match(f.urls[0], /auth\.example\.clerk\.accounts\.dev\/npm\/@clerk\/ui@1\/dist\/ui\.browser\.js$/);
  assert.match(f.urls[1], /clerk-js@6\.39\.0/);
  assert.equal(f.loads[0].ui.ClerkUI, f.Ctor);
});
test('UI loading failure is surfaced instead of trying to mount headless Clerk', async () => {
  const f = fixture({ brokenUI: true });
  await assert.rejects(f.context.loadClerk(key), /Could not load/);
  assert.equal(f.urls.length, 1); assert.equal(f.loads.length, 0);
});
test('invalid publishable key does not create a script request', async () => {
  const f = fixture();
  await assert.rejects(f.context.loadClerk('bad-key'), /invalid publishable key/);
  assert.equal(f.urls.length, 0);
});
