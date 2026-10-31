import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('offline shell includes a new cache and the Later route', async () => {
  const sw = await read('public/src/sw.js');
  assert.ok(sw.includes("const CACHE = 'tempo-shell-v12'"));
  assert.ok(sw.includes("'/src/templates/later'"));
});

test('shortcuts use the active iframe document without intercepting text inputs', async () => {
  const app = await read('public/src/app.js');
  assert.ok(app.includes('function bindKeyboardShortcuts(doc)'));
  assert.ok(app.includes('if (!doc) return;\n    bindKeyboardShortcuts(doc);'));
  assert.ok(app.includes('event.target?.closest?.('));
  assert.ok(app.includes("doc.querySelector('dialog[open]')"));
});

test('navigation exposes Week and Later from mobile and desktop screens', async () => {
  const app = await read('public/src/app.js');
  assert.ok(app.includes('function completeNavigation(doc)'));
  assert.ok(app.includes("['Today', 'Week', 'Plan', 'Later', 'Focus', 'Brain dump']"));
  assert.ok(app.includes('completeNavigation(doc);'));
  assert.ok(app.includes('item.dataset.route = routes[label]'));
  assert.ok(app.includes("button.setAttribute('role', 'link')"));
  for (const name of ['today', 'brain-dump', 'mobile-plan', 'later', 'desktop-today', 'desktop-week']) {
    const html = await read(`public/src/templates/${name}.html`);
    assert.ok(html.includes('Today') && html.includes('Focus'), name);
  }
});

test('settings content can scroll to backup export', async () => {
  const settings = await read('public/src/templates/settings.html');
  assert.ok(settings.includes('min-height: 844px'));
  assert.ok(settings.includes('padding: 56px 20px 110px'));
  assert.ok(settings.includes('overflow: visible'));
  assert.ok(settings.includes('id="backup-export"'));
});

test('import warns before replacing data in shared mode', async () => {
  const app = await read('public/src/app.js');
  assert.ok(app.includes('const sharedLinkActive = Boolean(storage.getItem(sharedCapabilityKey))'));
  assert.ok(app.includes('sharedPlanBootstrapPending || !sharedPlanRecoveryReady'));
  assert.ok(app.includes('Replace the SHARED planner for everyone'));
  assert.ok(app.includes('Final confirmation: replace the shared plan across devices'));
});
