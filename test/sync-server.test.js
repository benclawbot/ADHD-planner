import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSyncServer } from '../server/sync-server.mjs';

async function withServer(t, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'tempo-sync-test-'));
  let time = new Date('2026-10-29T12:00:00.000Z');
  const server = await createSyncServer({
    dataDir,
    now: options.now ?? (() => time),
    allowedOrigins: options.allowedOrigins,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    dataDir,
    server,
    baseUrl,
    advanceTo(date) { time = new Date(date); },
  };
}

async function request(baseUrl, endpoint, { method = 'GET', token, body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = response.status === 204 ? null : await response.json();
  return { response, data };
}

async function register(baseUrl, email = 'person@example.test', password = 'correct horse battery staple') {
  const { response, data } = await request(baseUrl, '/api/auth/register', {
    method: 'POST', body: { email, password },
  });
  assert.equal(response.status, 201, JSON.stringify(data));
  assert.equal(data.tokenType, 'Bearer');
  assert.ok(data.token);
  return data;
}

const starterState = () => ({
  schema: 1,
  tasks: [{ id: 'task-1', title: 'Initial title', notes: '', status: 'open' }],
  captures: [],
  focus: null,
  settings: { lowStimulation: false },
});

async function putSync(baseUrl, token, baseRevision, operationId, state) {
  return request(baseUrl, '/api/sync', {
    method: 'PUT', token, body: { baseRevision, operationId, state },
  });
}

test('registers accounts, enforces auth and isolates each account', async (t) => {
  const { baseUrl } = await withServer(t);
  const alice = await register(baseUrl, 'ALICE@example.test');
  const bob = await register(baseUrl, 'bob@example.test');

  const unauthenticated = await request(baseUrl, '/api/sync');
  assert.equal(unauthenticated.response.status, 401);

  const aliceInitial = await request(baseUrl, '/api/sync', { token: alice.token });
  assert.equal(aliceInitial.response.status, 200);
  assert.equal(aliceInitial.data.revision, 0);
  assert.deepEqual(aliceInitial.data.state, { schema: 1, tasks: [], captures: [], focus: null, settings: {} });

  const saved = await putSync(baseUrl, alice.token, 0, 'alice-save-0001', starterState());
  assert.equal(saved.response.status, 200);
  assert.equal(saved.data.revision, 1);

  const bobState = await request(baseUrl, '/api/sync', { token: bob.token });
  assert.equal(bobState.response.status, 200);
  assert.equal(bobState.data.revision, 0);
  assert.deepEqual(bobState.data.state.tasks, []);

  const logout = await request(baseUrl, '/api/auth/logout', { method: 'POST', token: alice.token });
  assert.equal(logout.response.status, 204);
  const afterLogout = await request(baseUrl, '/api/sync', { token: alice.token });
  assert.equal(afterLogout.response.status, 401);
});

test('merges independent edits and retains overlapping versions for restore', async (t) => {
  const { baseUrl } = await withServer(t);
  const account = await register(baseUrl);
  const initial = starterState();
  const first = await putSync(baseUrl, account.token, 0, 'save-initial-001', initial);
  assert.equal(first.data.revision, 1);

  const serverEdit = structuredClone(initial);
  serverEdit.tasks[0].title = 'Server title';
  const second = await putSync(baseUrl, account.token, 1, 'server-title-001', serverEdit);
  assert.equal(second.data.revision, 2);

  const offlineEdit = structuredClone(initial);
  offlineEdit.tasks[0].notes = 'Added from the other device';
  offlineEdit.tasks.push({ id: 'task-2', title: 'A separate task', status: 'open' });
  const merged = await putSync(baseUrl, account.token, 1, 'offline-edit-001', offlineEdit);
  assert.equal(merged.response.status, 200);
  assert.equal(merged.data.revision, 3);
  assert.deepEqual(merged.data.conflicts, []);
  assert.equal(merged.data.state.tasks.find((task) => task.id === 'task-1').title, 'Server title');
  assert.equal(merged.data.state.tasks.find((task) => task.id === 'task-1').notes, 'Added from the other device');
  assert.ok(merged.data.state.tasks.some((task) => task.id === 'task-2'));

  const serverConflict = structuredClone(merged.data.state);
  serverConflict.tasks[0].title = 'Accepted server edit';
  const fourth = await putSync(baseUrl, account.token, 3, 'conflict-server-001', serverConflict);
  assert.equal(fourth.data.revision, 4);

  const losingEdit = structuredClone(merged.data.state);
  losingEdit.tasks[0].title = 'Retained offline edit';
  const conflicted = await putSync(baseUrl, account.token, 3, 'conflict-local-0001', losingEdit);
  assert.equal(conflicted.response.status, 200);
  assert.equal(conflicted.data.revision, 5);
  assert.equal(conflicted.data.state.tasks[0].title, 'Accepted server edit');
  assert.equal(conflicted.data.conflicts.length, 1);
  const historyId = conflicted.data.conflicts[0].id;
  assert.equal(conflicted.data.conflicts[0].label, 'tasks["task-1"].title');
  assert.equal(conflicted.data.conflicts[0].server.value, 'Accepted server edit');
  assert.equal(conflicted.data.conflicts[0].incoming.value, 'Retained offline edit');

  const history = await request(baseUrl, '/api/sync/history', { token: account.token });
  assert.equal(history.response.status, 200);
  assert.equal(history.data.history.length, 1);
  assert.equal(history.data.history[0].id, historyId);

  const restore = await request(baseUrl, '/api/sync/restore', {
    method: 'POST', token: account.token,
    body: { historyId, version: 'losing', baseRevision: 5, operationId: 'restore-loser-0001' },
  });
  assert.equal(restore.response.status, 200);
  assert.equal(restore.data.revision, 6);
  assert.equal(restore.data.state.tasks[0].title, 'Retained offline edit');
});

test('delete versus edit keeps the server deletion and makes the edited task restorable', async (t) => {
  const { baseUrl } = await withServer(t);
  const account = await register(baseUrl);
  const baseState = starterState();
  await putSync(baseUrl, account.token, 0, 'delete-base-0001', baseState);

  const deletedState = structuredClone(baseState);
  deletedState.tasks = [];
  const deletion = await putSync(baseUrl, account.token, 1, 'delete-task-0001', deletedState);
  assert.equal(deletion.data.revision, 2);
  assert.deepEqual(deletion.data.tombstones.map(({ collection, id, revision }) => ({ collection, id, revision })), [
    { collection: 'tasks', id: 'task-1', revision: 2 },
  ]);

  const editedState = structuredClone(baseState);
  editedState.tasks[0].title = 'Edited while offline';
  const edit = await putSync(baseUrl, account.token, 1, 'offline-edit-0002', editedState);
  assert.equal(edit.response.status, 200);
  assert.equal(edit.data.revision, 3);
  assert.deepEqual(edit.data.state.tasks, []);
  assert.equal(edit.data.conflicts.length, 1);
  assert.equal(edit.data.conflicts[0].server.exists, false);
  assert.equal(edit.data.conflicts[0].incoming.value.title, 'Edited while offline');

  const restore = await request(baseUrl, '/api/sync/restore', {
    method: 'POST', token: account.token,
    body: { historyId: edit.data.conflicts[0].id, version: 'losing', baseRevision: 3, operationId: 'restore-delete-0001' },
  });
  assert.equal(restore.response.status, 200);
  assert.equal(restore.data.revision, 4);
  assert.equal(restore.data.state.tasks[0].title, 'Edited while offline');
  assert.deepEqual(restore.data.tombstones, []);
});

test('treats the existing model removed status as a deletion conflict', async (t) => {
  const { baseUrl } = await withServer(t);
  const account = await register(baseUrl);
  const baseState = starterState();
  await putSync(baseUrl, account.token, 0, 'soft-delete-base-01', baseState);

  const removedState = structuredClone(baseState);
  removedState.tasks[0].status = 'removed';
  const removal = await putSync(baseUrl, account.token, 1, 'soft-delete-task-01', removedState);
  assert.equal(removal.data.revision, 2);
  assert.equal(removal.data.state.tasks[0].status, 'removed');

  const staleEdit = structuredClone(baseState);
  staleEdit.tasks[0].title = 'Edited while offline';
  const conflict = await putSync(baseUrl, account.token, 1, 'soft-delete-edit-01', staleEdit);
  assert.equal(conflict.response.status, 200);
  assert.equal(conflict.data.revision, 3);
  assert.equal(conflict.data.state.tasks[0].status, 'removed');
  assert.equal(conflict.data.state.tasks[0].title, 'Initial title');
  assert.equal(conflict.data.conflicts[0].incoming.value.title, 'Edited while offline');
  assert.ok(conflict.data.tombstones.some((item) => item.collection === 'tasks' && item.id === 'task-1'));
});

test('idempotency prevents duplicate commits and rejects key reuse', async (t) => {
  const { baseUrl } = await withServer(t);
  const account = await register(baseUrl);
  const state = starterState();
  const first = await putSync(baseUrl, account.token, 0, 'idempotency-0001', state);
  assert.equal(first.data.revision, 1);

  const retry = await putSync(baseUrl, account.token, 0, 'idempotency-0001', state);
  assert.equal(retry.response.status, 200);
  assert.equal(retry.data.duplicate, true);
  assert.equal(retry.data.revision, 1);

  const changed = structuredClone(state);
  changed.tasks[0].title = 'Different request';
  const reused = await putSync(baseUrl, account.token, 1, 'idempotency-0001', changed);
  assert.equal(reused.response.status, 409);
  assert.equal(reused.data.error.code, 'idempotency_key_reused');
});

test('durable file state survives a server restart and expired bases are rejected safely', async (t) => {
  const setup = await withServer(t);
  const account = await register(setup.baseUrl);
  const saved = await putSync(setup.baseUrl, account.token, 0, 'durable-state-0001', starterState());
  assert.equal(saved.data.revision, 1);

  await new Promise((resolve) => setup.server.close(resolve));
  const restarted = await createSyncServer({ dataDir: setup.dataDir, now: () => new Date('2026-11-30T12:00:00.000Z') });
  await new Promise((resolve, reject) => {
    restarted.once('error', reject);
    restarted.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => new Promise((resolve) => restarted.close(resolve)));
  const restartedUrl = `http://127.0.0.1:${restarted.address().port}`;
  const reauthenticated = await request(restartedUrl, '/api/auth/login', {
    method: 'POST', body: { email: 'person@example.test', password: 'correct horse battery staple' },
  });
  assert.equal(reauthenticated.response.status, 200);
  const loaded = await request(restartedUrl, '/api/sync', { token: reauthenticated.data.token });
  assert.equal(loaded.response.status, 200);
  assert.equal(loaded.data.revision, 1);
  assert.equal(loaded.data.state.tasks[0].title, 'Initial title');

  const changed = structuredClone(loaded.data.state);
  changed.tasks[0].title = 'A fresh edit';
  const expiredBase = await putSync(restartedUrl, reauthenticated.data.token, 0, 'old-base-retry-001', changed);
  assert.equal(expiredBase.response.status, 409);
  assert.equal(expiredBase.data.error.code, 'base_revision_expired');
  assert.equal(expiredBase.data.error.details.revision, 1);
  assert.equal(expiredBase.data.error.details.state.tasks[0].title, 'Initial title');
});

test('rejects weak passwords and malformed or duplicate task identifiers', async (t) => {
  const { baseUrl } = await withServer(t);
  const weak = await request(baseUrl, '/api/auth/register', {
    method: 'POST', body: { email: 'weak@example.test', password: 'short' },
  });
  assert.equal(weak.response.status, 400);
  assert.equal(weak.data.error.code, 'weak_password');

  const account = await register(baseUrl);
  const invalidState = starterState();
  invalidState.tasks.push({ ...invalidState.tasks[0] });
  const invalid = await putSync(baseUrl, account.token, 0, 'invalid-state-0001', invalidState);
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.data.error.code, 'invalid_state');
});
