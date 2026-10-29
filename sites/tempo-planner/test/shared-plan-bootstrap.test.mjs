import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { createSyncClient, preservePreLinkPlan, SYNC_CLIENT_STORAGE_KEY } from '../public/src/sync-client.js';

const TOKEN = 'S'.repeat(43);
const SHARED_USER_ID = 'tempo-shared-planner-v1';
const emptyPlan = { schema: 1, tasks: [], captures: [], focus: null, settings: {} };

function makeStorage(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    readJson(key) { return JSON.parse(values.get(key) ?? 'null'); },
  };
}

function queuedRecord(queue, { siteUserId = null, hydrated = false } = {}) {
  return JSON.stringify({
    version: 1,
    session: null,
    siteUserId,
    revision: 0,
    queue,
    queueOwnerId: siteUserId,
    hydrated,
    recovery: [],
    lastRemoteState: null,
    lastRemoteTombstones: [],
    lastSyncedAt: null,
  });
}

function jsonResponse(body) {
  return Response.json(body, { headers: { 'Cache-Control': 'no-store' } });
}

function makeClient({ storage, fetch, onRemoteState, autoRetry = false }) {
  return createSyncClient({
    storage,
    siteAuth: true,
    fetch,
    autoRetry,
    navigator: { onLine: true },
    onlineTarget: null,
    visibilityTarget: { visibilityState: 'visible' },
    pollIntervalMs: 0,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {},
    onRemoteState,
  });
}

test('unauthenticated local edits remain local instead of becoming a future shared-plan upload', () => {
  const storage = makeStorage();
  const client = makeClient({ storage, fetch: async () => { throw new Error('no unauthenticated request expected'); } });
  const localPlan = { ...emptyPlan, tasks: [{ id: 'private-before-link', title: 'Private draft' }] };

  assert.equal(client.setLocalState(localPlan), null);
  assert.deepEqual(client.getPendingOperations(), []);
  assert.equal(storage.readJson(SYNC_CLIENT_STORAGE_KEY), null);
});

test('pre-link recovery preserves the complete local plan and old recovery records without truncation', () => {
  const initialRecovery = Array.from({ length: 6 }, (_, index) => ({ archivedAt: `prior-${index}`, state: { id: index } }));
  const storage = makeStorage({ 'tempo-local-recovery': JSON.stringify(initialRecovery) });
  const localPlan = {
    ...emptyPlan,
    demoData: false,
    tasks: [{ id: 'private', title: 'Do not publish', notes: 'Keep every local field' }],
    captures: [{ id: 'capture-private', text: 'private capture' }],
    settings: { lowStimulation: true },
  };
  const queuedOperations = [{ type: 'state', operationId: 'private-op-0001', state: localPlan, baseRevision: 0, attempted: false }];

  assert.equal(preservePreLinkPlan(storage, 'tempo-local-recovery', localPlan, queuedOperations), true);
  const recovery = storage.readJson('tempo-local-recovery');
  assert.equal(recovery.length, 7);
  assert.deepEqual(recovery.slice(0, 6), initialRecovery);
  assert.deepEqual(recovery.at(-1).state, localPlan);
  assert.deepEqual(recovery.at(-1).queuedOperations, queuedOperations);
  preservePreLinkPlan(storage, 'tempo-local-recovery', localPlan, []);
  assert.equal(storage.readJson('tempo-local-recovery').length, 7, 'repeated bootstrap does not duplicate an unchanged plan');
});

test('first shared-link hydration archives local data, blocks edits until pull, then syncs later edits', async () => {
  const privatePlan = { ...emptyPlan, tasks: [{ id: 'private-before-link', title: 'Private draft' }] };
  const staleQueue = [{
    type: 'state', operationId: 'pre-link-op-0001', state: privatePlan, baseRevision: 0, attempted: false,
  }];
  const storage = makeStorage({
    'tempo-shared-capability-v1': TOKEN,
    [SYNC_CLIENT_STORAGE_KEY]: queuedRecord(staleQueue),
  });
  let currentLocalPlan = privatePlan;
  const recoveries = [];
  const remotePlan = { ...emptyPlan, tasks: [{ id: 'shared-task', title: 'Already shared' }] };
  const requests = [];
  let releasePull;
  let notifyPullStarted;
  const pullStarted = new Promise((resolve) => { notifyPullStarted = resolve; });
  const pendingPull = new Promise((resolve) => { releasePull = resolve; });
  const client = makeClient({
    storage,
    fetch: async (url, options = {}) => {
      requests.push({ url, method: options.method ?? 'GET', body: options.body });
      if (url === '/api/session') return jsonResponse({ user: { id: SHARED_USER_ID } });
      if (url === '/api/sync' && (options.method ?? 'GET') === 'GET') {
        notifyPullStarted();
        return pendingPull;
      }
      if (url === '/api/sync' && options.method === 'PUT') {
        const state = JSON.parse(options.body).state;
        return jsonResponse({ revision: 5, state, updatedAt: '2026-10-29T12:00:00.000Z', tombstones: [], conflicts: [] });
      }
      throw new Error(`Unexpected request: ${options.method ?? 'GET'} ${url}`);
    },
    onRemoteState: (remoteState) => {
      recoveries.push(structuredClone(currentLocalPlan));
      currentLocalPlan = remoteState;
      return true;
    },
  });

  assert.equal(client.prepareSharedPlanBootstrap((queued) => {
    recoveries.push({ state: structuredClone(currentLocalPlan), queuedOperations: queued });
    return true;
  }), true);
  assert.deepEqual(client.getPendingOperations(), []);
  assert.deepEqual(recoveries[0], { state: privatePlan, queuedOperations: staleQueue });

  client.start();
  await client.identityRequest;
  await pullStarted;
  const editedWhileLoading = { ...emptyPlan, tasks: [{ id: 'private-during-load', title: 'Local edit during load' }] };
  currentLocalPlan = editedWhileLoading;
  assert.throws(() => client.setLocalState(editedWhileLoading), { code: 'account_hydrating' });
  assert.deepEqual(client.getPendingOperations(), []);

  releasePull(jsonResponse({ revision: 4, state: remotePlan, updatedAt: null, tombstones: [] }));
  await client.inFlight;
  assert.deepEqual(recoveries.at(-1), editedWhileLoading);
  assert.deepEqual(currentLocalPlan, remotePlan);
  assert.equal(client.getStatus().accountSwitchHydrating, false);
  assert.equal(requests.filter((request) => request.method === 'PUT').length, 0);

  const postLinkEdit = { ...remotePlan, tasks: [...remotePlan.tasks, { id: 'shared-new-task', title: 'Post-link edit' }] };
  assert.ok(client.setLocalState(postLinkEdit));
  await client.inFlight;
  client.stop();
  assert.equal(requests.filter((request) => request.method === 'PUT').length, 1);
  assert.deepEqual(JSON.parse(requests.find((request) => request.method === 'PUT').body).state, postLinkEdit);
});

test('failed local recovery keeps first-link hydration blocked and does not apply the shared state', async () => {
  const privatePlan = { ...emptyPlan, tasks: [{ id: 'private', title: 'Keep local copy' }] };
  const storage = makeStorage({ 'tempo-shared-capability-v1': TOKEN });
  let currentLocalPlan = privatePlan;
  let attemptedRemote = null;
  const client = makeClient({
    storage,
    fetch: async (url) => {
      if (url === '/api/session') return jsonResponse({ user: { id: SHARED_USER_ID } });
      if (url === '/api/sync') return jsonResponse({ revision: 1, state: emptyPlan, updatedAt: null, tombstones: [] });
      throw new Error(`Unexpected request: ${url}`);
    },
    onRemoteState: (remoteState) => { attemptedRemote = remoteState; return false; },
  });

  assert.equal(client.prepareSharedPlanBootstrap(() => true), true);
  client.start();
  await client.identityRequest;
  await assert.rejects(client.inFlight, { code: 'remote_state_not_applied' });
  assert.deepEqual(attemptedRemote, emptyPlan);
  assert.deepEqual(currentLocalPlan, privatePlan);
  assert.equal(client.getStatus().accountSwitchHydrating, true);
  assert.equal(storage.readJson(SYNC_CLIENT_STORAGE_KEY).hydrated, false);
  assert.throws(() => client.setLocalState(privatePlan), { code: 'account_hydrating' });
  assert.deepEqual(client.getPendingOperations(), []);
  client.stop();
});

test('app wires first-link recovery before replacing local state and no longer uploads on status alone', async () => {
  const app = await readFile(new URL('../public/src/app.js', import.meta.url), 'utf8');
  assert.match(app, /preservePreLinkPlan\(storage, accountRecoveryKey, state, queuedOperations\)/);
  assert.match(app, /prepareSharedPlanBootstrap\(archiveLocalPlanBeforeSharedSync\)/);
  assert.match(app, /if \(sharedPlanBootstrapPending\)\s*\{[\s\S]*?archiveLocalPlanBeforeSharedSync/);
  assert.match(app, /if \(sharedPlanRecoveryReady\) syncClient\.start\(\)/);
  const statusCallback = app.match(/onStatus:\s*\(status\)\s*=>\s*\{([\s\S]*?)\n\s*\},\s*onIdentityChange/);
  assert.ok(statusCallback);
  assert.doesNotMatch(statusCallback[1], /setLocalState\(/);
});
