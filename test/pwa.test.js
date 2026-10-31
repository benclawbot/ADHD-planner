import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';

async function loadWorker() {
  const handlers = {};
  const cache = new Map();
  const deleted = [];
  const shell = [];
  const cacheStore = {
    addAll: async paths => { for (const url of paths) { await readFile(path.join(process.cwd(), url === '/src/' ? 'src/index.html' : url.slice(1))); shell.push(url); cache.set(url, { cached: url }); } },
    put: async (request, response) => cache.set(request.url, response),
  };
  const caches = { open: async () => cacheStore, keys: async () => ['tempo-shell-v0','tempo-shell-v1','tempo-shell-v2','tempo-shell-v3','tempo-shell-v4','tempo-shell-v5','tempo-shell-v6','tempo-shell-v7','tempo-shell-v8','tempo-shell-v9','tempo-shell-v10','tempo-shell-v11','another-app'], delete: async key => deleted.push(key), match: async request => cache.get(new URL(request.url).pathname) };
  const self = { addEventListener: (name, handler) => handlers[name] = handler, skipWaiting: async () => {}, clients: { claim: async () => {} }, location: {origin:'https://tempo.example'} };
  vm.runInNewContext(await readFile('src/sw.js','utf8'), {self, caches, URL, Promise, fetch: async () => { throw Error('offline'); }});
  return {handlers, shell, deleted};
}

test('PWA precaches all listed assets, serves a cached page offline and preserves unrelated caches', async () => {
  const {handlers, shell, deleted} = await loadWorker();
  let promise;
  handlers.install({waitUntil: p => {promise = p;}}); await promise;
  assert.ok(shell.includes('/src/templates/today.html'));
  assert.ok(shell.includes('/src/templates/later.html'));
  assert.ok(shell.includes('/src/subtasks.js'));
  assert.ok(shell.includes('/src/recurrence.js'));
  assert.ok(shell.includes('/src/sync-client.js'));
  assert.ok(shell.includes('/src/voice-capture.js'));
  assert.ok(shell.includes('/src/voice-worker.js'));
  assert.ok(!shell.includes('/src/vendor/transformers/ort-wasm-simd-threaded.jsep.wasm'), 'the large WASM asset is lazy-loaded, not part of the app shell');
  handlers.activate({waitUntil: p => {promise = p;}}); await promise;
  assert.deepEqual(deleted, Array.from({length: 12}, (_, version) => `tempo-shell-v${version}`));
  handlers.fetch({request: {method:'GET', url:'https://tempo.example/src/templates/today.html'}, respondWith: p => {promise = p;}});
  assert.equal((await promise).cached, '/src/templates/today.html');
  let intercepted = false;
  handlers.fetch({request: {method:'GET', url:'https://tempo.example/api/sync'}, respondWith: () => {intercepted = true;}});
  assert.equal(intercepted, false, 'authenticated sync data must bypass the shell cache');
});

test('manifest specifies installable standalone app with existing required icons', async () => {
  const manifest = JSON.parse(await readFile('src/manifest.webmanifest','utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.start_url.startsWith(manifest.scope));
  for (const size of ['192x192','512x512']) {
    const icon = manifest.icons.find(item => item.sizes === size && item.type === 'image/png');
    assert.ok(icon, `missing ${size} icon`);
    const bytes = await readFile(path.join(process.cwd(), icon.src.slice(1)));
    assert.equal(bytes.readUInt32BE(16), Number(size.split('x')[0]));
    assert.equal(bytes.readUInt32BE(20), Number(size.split('x')[1]));
  }
});

test('local server serves PWA start URL and its manifest', async () => {
  const { createServer } = await import('node:net');
  const { spawn } = await import('node:child_process');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tempo-pwa-test-'));
  const probe = createServer();
  await new Promise((resolve, reject) => probe.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const server = spawn(process.execPath, ['scripts/serve.mjs'], {env:{...process.env, PORT:String(port), TEMPO_SYNC_DATA_DIR:dataDir}, stdio:'ignore'});
  try {
    let response;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { response = await fetch(`http://127.0.0.1:${port}/src/`); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 25)); }
    }
    assert.ok(response, 'local server did not start');
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Tempo Planner/);
    const manifest = await fetch(`http://127.0.0.1:${port}/src/manifest.webmanifest`);
    assert.equal(manifest.status, 200);
    assert.match(manifest.headers.get('content-type'), /application\/manifest\+json/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);
    const worker = await fetch(`http://127.0.0.1:${port}/src/voice-worker.js`);
    assert.equal(worker.status, 200);
    assert.match(worker.headers.get('content-type'), /text\/javascript/);
    const wasmModule = await fetch(`http://127.0.0.1:${port}/src/vendor/transformers/ort-wasm-simd-threaded.jsep.mjs`);
    assert.equal(wasmModule.status, 200);
    assert.match(wasmModule.headers.get('content-type'), /text\/javascript/);
    const wasm = await fetch(`http://127.0.0.1:${port}/src/vendor/transformers/ort-wasm-simd-threaded.jsep.wasm`, { method: 'HEAD' });
    assert.equal(wasm.status, 200);
    assert.match(wasm.headers.get('content-type'), /application\/wasm/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/server/sync-server.mjs`)).status, 404);
  } finally { server.kill(); await rm(dataDir, {recursive:true, force:true}); }
});
