import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSyncClient,
  mergeLocalChanges,
  SYNC_CLIENT_STORAGE_KEY,
} from '../src/sync-client.js';

function createStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    values,
  };
}

function response(body, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async text() { return body === null ? '' : JSON.stringify(body); },
  };
}

function authData(userId = 'user-1') {
  return { token: `token-${userId}`, tokenType: 'Bearer', expiresAt: null, user: { id: userId, email: `${userId}@example.test` } };
}

function state(tasks = [], settings = {}) {
  return { schema: 1, tasks, captures: [], focus: null, settings };
}

function authFetch(other = async () => response({})) {
  return async (url, options = {}) => {
    if (url.endsWith('/api/auth/login') || url.endsWith('/api/auth/register')) return response(authData());
    return other(url, options);
  };
}

test('login persists the bearer token and sync requests send it as an Authorization header', async () => {
  const storage = createStorage();
  const calls = [];
  const client = createSyncClient({
    storage,
    fetch: authFetch(async (url, options) => {
      calls.push({ url, options });
      return response({ revision: 3, state: state([{ id: 'remote', title: 'Remote item' }]), updatedAt: '2026-10-29T10:00:00.000Z' });
    }),
  });

  await client.login('user-1@example.test', 'secret');
  assert.equal(client.getToken(), 'token-user-1');
  assert.equal(JSON.parse(storage.getItem(SYNC_CLIENT_STORAGE_KEY)).session.token, 'token-user-1');

  const states = [];
  client.onRemoteState = (remoteState) => states.push(remoteState);
  await client.syncNow();

  assert.equal(calls[0].url, '/api/sync');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer token-user-1');
  assert.deepEqual(states[0].tasks.map((task) => task.id), ['remote']);
  assert.equal(client.getStatus().revision, 3);
});

test('offline edits are persisted and coalesced into the latest complete state', async () => {
  const storage = createStorage();
  const client = createSyncClient({ storage, fetch: authFetch() });
  client.setLocalState(state([{ id: 'one', title: 'Old' }]));
  const firstOperationId = client.getPendingOperations()[0].operationId;
  client.setLocalState(state([{ id: 'one', title: 'Newest' }, { id: 'two', title: 'Second' }]));

  const persisted = JSON.parse(storage.getItem(SYNC_CLIENT_STORAGE_KEY));
  assert.equal(persisted.queue.length, 1);
  assert.equal(persisted.queue[0].operationId, firstOperationId);
  assert.deepEqual(persisted.queue[0].state.tasks.map((task) => task.title), ['Newest', 'Second']);

  const reloaded = createSyncClient({ storage, fetch: authFetch() });
  assert.equal(reloaded.getPendingOperations().length, 1);
  assert.deepEqual(reloaded.getPendingOperations()[0].state, persisted.queue[0].state);
});

test('local changes made while a PUT is in flight survive and absorb unrelated server edits', async () => {
  const storage = createStorage();
  const calls = [];
  let completeFirstPut;
  let putCount = 0;
  const client = createSyncClient({
    storage,
    fetch: authFetch(async (url, options) => {
      calls.push({ url, options });
      if (options.method === 'GET') return response({ revision: 4, state: state([{ id: 'local', title: 'Before' }], { shared: false }), updatedAt: 'before' });
      if (options.method === 'PUT' && ++putCount === 1) {
        return new Promise((resolve) => { completeFirstPut = resolve; });
      }
      const body = JSON.parse(options.body);
      return response({ revision: 6, state: body.state, updatedAt: 'after', conflicts: [] });
    }),
  });
  await client.login('user-1@example.test', 'secret');
  await client.syncNow();

  client.setLocalState(state([{ id: 'local', title: 'Before' }], { shared: false }));
  const syncing = client.syncNow();
  assert.equal(typeof completeFirstPut, 'function');
  client.setLocalState(state([{ id: 'local', title: 'After' }], { shared: false }));
  completeFirstPut(response({
    revision: 5,
    state: state([{ id: 'local', title: 'Before' }, { id: 'server', title: 'Server item' }], { shared: true, serverOnly: 'kept' }),
    updatedAt: 'middle',
    conflicts: [],
  }));
  await syncing;

  const putCalls = calls.filter(({ options }) => options.method === 'PUT');
  assert.equal(putCalls.length, 2);
  assert.equal(JSON.parse(putCalls[1].options.body).baseRevision, 5);
  const sent = JSON.parse(putCalls[1].options.body).state;
  assert.deepEqual(sent.tasks, [{ id: 'local', title: 'After' }, { id: 'server', title: 'Server item' }]);
  assert.deepEqual(sent.settings, { shared: true, serverOnly: 'kept' });
  assert.equal(client.getStatus().pendingCount, 0);
});

test('a retry reuses the durable operation ID and base revision after a network failure', async () => {
  const storage = createStorage();
  const requests = [];
  let putCount = 0;
  const client = createSyncClient({
    storage,
    fetch: authFetch(async (_url, options) => {
      requests.push(options);
      if (++putCount === 1) throw new Error('connection reset after send');
      const body = JSON.parse(options.body);
      return response({ revision: 2, state: body.state, updatedAt: 'saved', conflicts: [] });
    }),
  });
  await client.login('user-1@example.test', 'secret');
  client.setLocalState(state([{ id: 'one', title: 'Keep me' }]));
  const pendingId = client.getPendingOperations()[0].operationId;

  await assert.rejects(client.syncNow(), /Network request failed/);
  const savedQueue = JSON.parse(storage.getItem(SYNC_CLIENT_STORAGE_KEY)).queue;
  assert.equal(savedQueue[0].attempted, true);
  assert.equal(savedQueue[0].operationId, pendingId);

  const restarted = createSyncClient({
    storage,
    fetch: authFetch(async (_url, options) => {
      requests.push(options);
      const body = JSON.parse(options.body);
      return response({ revision: 2, state: body.state, updatedAt: 'saved', conflicts: [] });
    }),
  });
  await restarted.syncNow();
  assert.equal(requests.length, 2);
  assert.deepEqual(JSON.parse(requests[0].body), JSON.parse(requests[1].body));
  assert.equal(JSON.parse(requests[1].body).operationId, pendingId);
});

test('an expired server base reports a conflict and leaves the local queue intact', async () => {
  const storage = createStorage();
  const conflicts = [];
  const client = createSyncClient({
    storage,
    onConflict: (conflict) => conflicts.push(conflict),
    fetch: authFetch(async () => response({ error: {
      code: 'base_revision_expired',
      message: 'Base revision expired',
      details: { revision: 9, state: state([{ id: 'server', title: 'Server version' }]), updatedAt: 'now' },
    } }, 409)),
  });
  await client.login('user-1@example.test', 'secret');
  client.setLocalState(state([{ id: 'local', title: 'Local version' }]));
  const operationId = client.getPendingOperations()[0].operationId;

  await assert.rejects(client.syncNow(), /Base revision expired/);
  assert.equal(client.getPendingOperations().length, 1);
  assert.equal(client.getPendingOperations()[0].operationId, operationId);
  assert.equal(client.getStatus().state, 'conflict');
  assert.equal(conflicts[0].reason, 'base_revision_expired');
  assert.equal(conflicts[0].remote.revision, 9);
});

test('explicit expired-base resolution archives the blocked operation before submitting the chosen merge', async () => {
  const storage = createStorage();
  const putBodies = [];
  let firstPut = true;
  const client = createSyncClient({
    storage,
    fetch: authFetch(async (_url, options) => {
      if (options.method !== 'PUT') return response({});
      const body = JSON.parse(options.body);
      putBodies.push(body);
      if (firstPut) {
        firstPut = false;
        return response({ error: {
          code: 'base_revision_expired',
          message: 'Base revision expired',
          details: { revision: 9, state: state([{ id: 'server', title: 'Server' }]), updatedAt: 'current' },
        } }, 409);
      }
      return response({ revision: 10, state: body.state, updatedAt: 'resolved', conflicts: [] });
    }),
  });
  await client.login('user-1@example.test', 'secret');
  client.setLocalState(state([{ id: 'local', title: 'Local' }]));
  const blockedId = client.getPendingOperations()[0].operationId;
  await assert.rejects(client.syncNow(), /Base revision expired/);

  const chosen = state([{ id: 'server', title: 'Server' }, { id: 'local', title: 'Local' }]);
  const replacementId = client.resolveExpiredBase(chosen);
  await client.syncNow();

  assert.notEqual(replacementId, blockedId);
  assert.equal(putBodies[1].baseRevision, 9);
  assert.equal(putBodies[1].operationId, replacementId);
  assert.deepEqual(client.getRecoveryItems()[0].queuedOperations[0].state, state([{ id: 'local', title: 'Local' }]));
  assert.equal(client.getPendingOperations().length, 0);
});

test('history restore maps losing/winning choices to incoming/server and uses a durable operation ID', async () => {
  const calls = [];
  const client = createSyncClient({
    storage: createStorage(),
    fetch: authFetch(async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/api/sync/history')) return response({ history: [{ id: 'history-1' }], hasMore: false });
      if (url.endsWith('/api/sync/restore')) {
        const body = JSON.parse(options.body);
        return response({ revision: body.baseRevision + 1, state: state([{ id: 'restored', title: body.version }]), updatedAt: 'restored', conflicts: [] });
      }
      return response({ revision: 7, state: state([{ id: 'current', title: 'Current' }]), updatedAt: 'current' });
    }),
  });
  await client.login('user-1@example.test', 'secret');
  await client.syncNow();
  await client.getHistory();
  const restored = await client.restore('history-1', 'losing');

  const restoreCall = calls.find(({ url }) => url.endsWith('/api/sync/restore'));
  const body = JSON.parse(restoreCall.options.body);
  assert.equal(body.historyId, 'history-1');
  assert.equal(body.version, 'incoming');
  assert.equal(body.baseRevision, 7);
  assert.match(body.operationId, /^sync-/);
  assert.equal(restored.state.tasks[0].title, 'incoming');
});

test('logout clears the token but leaves pending edits durable and scoped to their account', async () => {
  const storage = createStorage();
  let currentUser = 'user-1';
  const client = createSyncClient({
    storage,
    fetch: async (url, options = {}) => {
      if (url.endsWith('/api/auth/login')) return response(authData(currentUser));
      if (url.endsWith('/api/auth/logout')) return response(null, 204);
      return response({});
    },
  });
  await client.login('user-1@example.test', 'secret');
  client.setLocalState(state([{ id: 'private', title: 'Pending' }]));
  const pendingId = client.getPendingOperations()[0].operationId;
  await client.logout();
  assert.equal(client.getToken(), null);
  assert.equal(client.getPendingOperations()[0].operationId, pendingId);

  currentUser = 'user-2';
  await client.login('user-2@example.test', 'secret');
  assert.equal(client.getStatus().state, 'conflict');
  assert.equal(client.getPendingOperations()[0].operationId, pendingId);
});

test('three-way local rebase combines disjoint edits and keyed task additions', () => {
  const base = state([{ id: 'existing', title: 'Before' }], { shared: false });
  const local = state([{ id: 'existing', title: 'After' }, { id: 'local', title: 'Local addition' }], { shared: false });
  const remote = state([{ id: 'existing', title: 'Before' }, { id: 'remote', title: 'Remote addition' }], { shared: true, remoteOnly: true });

  const merged = mergeLocalChanges(base, local, remote);
  assert.deepEqual(merged.tasks, [
    { id: 'existing', title: 'After' },
    { id: 'remote', title: 'Remote addition' },
    { id: 'local', title: 'Local addition' },
  ]);
  assert.deepEqual(merged.settings, { shared: true, remoteOnly: true });
});

test('three-way local rebase keeps separately added nested fields from both sides', () => {
  const merged = mergeLocalChanges(
    { schema: 1 },
    { schema: 1, settings: { localOnly: true } },
    { schema: 1, settings: { remoteOnly: true } },
  );
  assert.deepEqual(merged.settings, { localOnly: true, remoteOnly: true });
});

test('start observes offline state and syncs queued work on reconnect', async () => {
  const storage = createStorage();
  const listeners = new Map();
  const onlineTarget = {
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name) { listeners.delete(name); },
  };
  let online = false;
  let putCount = 0;
  const client = createSyncClient({
    storage,
    navigator: { get onLine() { return online; } },
    onlineTarget,
    visibilityTarget: null,
    autoRetry: false,
    fetch: authFetch(async (_url, options) => {
      assert.equal(options.method, 'PUT');
      putCount += 1;
      const body = JSON.parse(options.body);
      return response({ revision: 1, state: body.state, updatedAt: 'online', conflicts: [] });
    }),
  });
  await client.login('user-1@example.test', 'secret');
  client.setLocalState(state([{ id: 'one', title: 'Queued offline' }]));
  client.start();
  assert.equal(client.getStatus().state, 'offline');
  assert.equal(putCount, 0);

  online = true;
  listeners.get('online')();
  await client.syncNow();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(putCount, 1);
  assert.equal(client.getStatus().pendingCount, 0);
  client.stop();
});

test('foreground polling pulls another open client and preserves a save made during that poll', async () => {
  let revision = 0;
  let serverState = state();
  let updatedAt = 'initial';
  let holdNextAGet = false;
  let finishHeldAGet;
  let aGetCount = 0;
  const aPutBodies = [];
  const aRemoteStates = [];
  const timers = [];
  const clearedTimers = [];
  const onlineListeners = new Map();
  const visibilityListeners = new Map();
  const visibilityTarget = {
    visibilityState: 'visible',
    addEventListener(name, listener) { visibilityListeners.set(name, listener); },
    removeEventListener(name) { visibilityListeners.delete(name); },
  };
  const onlineTarget = {
    addEventListener(name, listener) { onlineListeners.set(name, listener); },
    removeEventListener(name) { onlineListeners.delete(name); },
  };
  const sharedFetch = async (_url, options = {}) => {
    if (options.method === 'GET') return response({ revision, state: structuredClone(serverState), updatedAt, tombstones: [] });
    if (options.method === 'PUT') {
      const body = JSON.parse(options.body);
      const mergedTasks = new Map(serverState.tasks.map((task) => [task.id, task]));
      for (const task of body.state.tasks) mergedTasks.set(task.id, task);
      serverState = { ...serverState, ...body.state, tasks: [...mergedTasks.values()] };
      revision += 1;
      updatedAt = `revision-${revision}`;
      return response({ revision, state: structuredClone(serverState), updatedAt, tombstones: [], conflicts: [] });
    }
    return response({});
  };
  const fetchA = async (url, options = {}) => {
    if (url.endsWith('/api/auth/login')) return response(authData());
    if (options.method === 'GET') {
      aGetCount += 1;
      if (holdNextAGet) {
        holdNextAGet = false;
        const snapshot = { revision, state: structuredClone(serverState), updatedAt, tombstones: [] };
        return new Promise((resolve) => { finishHeldAGet = () => resolve(response(snapshot)); });
      }
      return sharedFetch(url, options);
    }
    if (options.method === 'PUT') aPutBodies.push(JSON.parse(options.body));
    return sharedFetch(url, options);
  };
  const clientA = createSyncClient({
    storage: createStorage(),
    fetch: fetchA,
    navigator: { onLine: true },
    onlineTarget,
    visibilityTarget,
    pollIntervalMs: 25_000,
    setIntervalFn: (callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn: (timer) => clearedTimers.push(timer),
    onRemoteState: (remoteState, meta) => aRemoteStates.push({ remoteState, meta }),
  });
  const clientB = createSyncClient({ storage: createStorage(), fetch: async (url, options = {}) => {
    if (url.endsWith('/api/auth/login')) return response(authData());
    return sharedFetch(url, options);
  } });

  await clientA.login('user-1@example.test', 'secret');
  clientA.start();
  clientA.start();
  await clientA.syncNow();
  assert.equal(timers.length, 1, 'repeated start calls must not create duplicate poll timers');
  assert.equal(timers[0].delay, 25_000);
  assert.equal(aRemoteStates.length, 1);

  await clientB.login('user-1@example.test', 'secret');
  clientB.setLocalState(state([{ id: 'from-b', title: 'Saved on the other device' }]));
  await clientB.syncNow();
  assert.equal(revision, 1);

  holdNextAGet = true;
  timers[0].callback();
  const poll = clientA.syncNow();
  assert.equal(typeof finishHeldAGet, 'function');
  clientA.setLocalState(state([{ id: 'from-a', title: 'Edited during the poll' }]));
  timers[0].callback();
  assert.equal(aGetCount, 2, 'a second poll tick must not overlap the in-flight GET');
  assert.equal(aPutBodies.length, 0, 'the local edit waits for the in-flight GET before submitting');

  finishHeldAGet();
  await poll;
  assert.equal(aPutBodies.length, 1);
  assert.equal(aPutBodies[0].baseRevision, 0, 'the write keeps the revision known before the poll for server-side 3-way merge');
  assert.deepEqual(aPutBodies[0].state.tasks.map((task) => task.id), ['from-a']);
  assert.equal(aRemoteStates.length, 2, 'the pulled response is not applied over a newer queued local save');
  assert.deepEqual(aRemoteStates.at(-1).remoteState.tasks.map((task) => task.id), ['from-b', 'from-a']);
  assert.equal(clientA.getStatus().pendingCount, 0);

  visibilityTarget.visibilityState = 'hidden';
  visibilityListeners.get('visibilitychange')();
  assert.equal(clearedTimers.length, 1, 'polling stops while the document is hidden');
  const previousGetCount = aGetCount;
  timers[0].callback();
  assert.equal(aGetCount, previousGetCount, 'a cleared timer cannot poll in the background');

  visibilityTarget.visibilityState = 'visible';
  visibilityListeners.get('visibilitychange')();
  await clientA.syncNow();
  assert.equal(timers.length, 2, 'returning to the foreground starts one fresh poll timer');
  clientA.stop();
  assert.equal(clearedTimers.length, 2, 'stop clears the active foreground poll timer');
  assert.equal(onlineListeners.size, 0);
  assert.equal(visibilityListeners.size, 0);
});
