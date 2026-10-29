const STORAGE_KEY = 'tempo-sync-client-v1';
const DEFAULT_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 30_000;

export class SyncClientError extends Error {
  constructor(message, { status = 0, code = 'sync_error', details = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'SyncClientError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class SyncApiError extends SyncClientError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'SyncApiError';
  }
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function defaultStorage() {
  try {
    if (globalThis.localStorage) return globalThis.localStorage;
  } catch {
    // Access to localStorage can throw in restricted browsing contexts.
  }
  return memoryStorage();
}

function cloneJson(value, name = 'value') {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new SyncClientError(`${name} must be JSON serializable`, { code: 'invalid_state', cause: error });
  }
  if (serialized === undefined) {
    throw new SyncClientError(`${name} must be JSON serializable`, { code: 'invalid_state' });
  }
  try {
    return JSON.parse(serialized);
  } catch (error) {
    throw new SyncClientError(`${name} could not be cloned`, { code: 'invalid_state', cause: error });
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRevision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isSnapshot(value) {
  return isObject(value) && isRevision(value.revision) && isObject(value.state)
    && (value.tombstones === undefined || Array.isArray(value.tombstones));
}

function stableEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => stableEqual(item, right[index]));
  }
  if (!isObject(left) || !isObject(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && stableEqual(left[key], right[key]));
}

const MISSING = Symbol('missing');

function hasIdRecords(value) {
  return Array.isArray(value) && value.every((item) => isObject(item) && typeof item.id === 'string');
}

function mergeIdArray(base, local, remote) {
  const baseById = new Map((base === MISSING ? [] : base).map((item) => [item.id, item]));
  const localById = new Map(local.map((item) => [item.id, item]));
  const remoteById = new Map(remote.map((item) => [item.id, item]));
  const ids = new Set([...baseById.keys(), ...localById.keys(), ...remoteById.keys()]);
  const merged = new Map();

  for (const id of ids) {
    const baseItem = baseById.has(id) ? baseById.get(id) : MISSING;
    const localItem = localById.has(id) ? localById.get(id) : MISSING;
    const remoteItem = remoteById.has(id) ? remoteById.get(id) : MISSING;
    const result = mergeValue(baseItem, localItem, remoteItem);
    if (result !== MISSING) merged.set(id, result);
  }

  // Keep local ordering when it changed during the request, while retaining remote-only IDs.
  const baseIds = (base === MISSING ? [] : base).map((item) => item.id);
  const localIds = local.map((item) => item.id);
  const remoteIds = remote.map((item) => item.id);
  const commonLocalBase = localIds.filter((id) => baseById.has(id));
  const commonBaseLocal = baseIds.filter((id) => localById.has(id));
  const localReordered = commonLocalBase.some((id, index) => id !== commonBaseLocal[index]);
  const commonRemoteBase = remoteIds.filter((id) => baseById.has(id));
  const commonBaseRemote = baseIds.filter((id) => remoteById.has(id));
  const remoteReordered = commonRemoteBase.some((id, index) => id !== commonBaseRemote[index]);
  const preferredIds = localReordered && !remoteReordered ? localIds : remoteIds;
  const secondaryIds = preferredIds === localIds ? remoteIds : localIds;
  const seen = new Set();
  const output = [];
  for (const id of [...preferredIds, ...secondaryIds]) {
    if (merged.has(id) && !seen.has(id)) {
      seen.add(id);
      output.push(merged.get(id));
    }
  }
  return output;
}

function mergeValue(base, local, remote) {
  if (stableEqual(local, base)) return remote === MISSING ? MISSING : cloneJson(remote);
  if (stableEqual(remote, base) || stableEqual(local, remote)) return local === MISSING ? MISSING : cloneJson(local);

  if (local !== MISSING && remote !== MISSING
    && (base === MISSING || hasIdRecords(base)) && hasIdRecords(local) && hasIdRecords(remote)) {
    return mergeIdArray(base, local, remote);
  }

  if (local !== MISSING && remote !== MISSING
    && (base === MISSING || isObject(base)) && isObject(local) && isObject(remote)) {
    const output = {};
    const baseObject = base === MISSING ? {} : base;
    const keys = new Set([...Object.keys(baseObject), ...Object.keys(local), ...Object.keys(remote)]);
    for (const key of keys) {
      const merged = mergeValue(
        Object.hasOwn(baseObject, key) ? baseObject[key] : MISSING,
        Object.hasOwn(local, key) ? local[key] : MISSING,
        Object.hasOwn(remote, key) ? remote[key] : MISSING,
      );
      if (merged !== MISSING) output[key] = merged;
    }
    return output;
  }

  // Concurrent changes to the same leaf keep the newest local edit; the server's conflict
  // history remains authoritative for the snapshot already submitted before that edit.
  return local === MISSING ? MISSING : cloneJson(local);
}

/** Merge local edits made after `baseState` with a newer server snapshot. */
export function mergeLocalChanges(baseState, localState, remoteState) {
  if (!isObject(baseState) || !isObject(localState) || !isObject(remoteState)) {
    throw new SyncClientError('All sync states must be objects', { code: 'invalid_state' });
  }
  const result = mergeValue(baseState, localState, remoteState);
  return result === MISSING ? {} : result;
}

function createOperationId() {
  return `sync-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`}`;
}

function normalizeQueue(queue) {
  if (!Array.isArray(queue)) return null;
  const normalized = [];
  for (const item of queue) {
    if (!isObject(item) || typeof item.operationId !== 'string' || !item.operationId) return null;
    if (item.type === 'restore') {
      if (typeof item.historyId !== 'string' || !['incoming', 'server'].includes(item.version)) return null;
    } else if (item.type !== 'state' || !isObject(item.state)) {
      return null;
    }
    if (typeof item.attempted !== 'boolean') return null;
    if (item.baseRevision !== null && !isRevision(item.baseRevision)) return null;
    if (item.attempted && !isRevision(item.baseRevision)) return null;
    normalized.push({ ...item });
  }
  return normalized;
}

function errorFromResponse(response, body) {
  const details = body?.error?.details ?? body?.details ?? null;
  const code = body?.error?.code ?? body?.code ?? `http_${response.status}`;
  const message = body?.error?.message ?? body?.message ?? `Sync request failed (${response.status})`;
  return new SyncApiError(message, { status: response.status, code, details });
}

async function readResponseBody(response) {
  if (response.status === 204 || response.status === 205) return null;
  if (typeof response.text === 'function') {
    const text = await response.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return { message: text }; }
  }
  if (typeof response.json === 'function') {
    try { return await response.json(); } catch { return null; }
  }
  return null;
}

export class SyncClient {
  constructor({
    storage = defaultStorage(),
    fetch: fetchImpl = globalThis.fetch?.bind(globalThis),
    baseUrl = '',
    onStatus = () => {},
    onRemoteState = () => {},
    onConflict = () => {},
    navigator: navigatorRef = globalThis.navigator,
    onlineTarget = globalThis.window,
    visibilityTarget = globalThis.document,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    maxRetryDelayMs = MAX_RETRY_DELAY_MS,
    setTimeoutFn = globalThis.setTimeout?.bind(globalThis),
    clearTimeoutFn = globalThis.clearTimeout?.bind(globalThis),
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    setIntervalFn = globalThis.setInterval?.bind(globalThis),
    clearIntervalFn = globalThis.clearInterval?.bind(globalThis),
    makeOperationId = createOperationId,
    autoRetry = true,
  } = {}) {
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
      throw new TypeError('SyncClient requires storage with getItem and setItem methods');
    }
    this.storage = storage;
    this.fetchImpl = fetchImpl;
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.onStatus = onStatus;
    this.onRemoteState = onRemoteState;
    this.onConflict = onConflict;
    this.navigator = navigatorRef;
    this.onlineTarget = onlineTarget;
    this.visibilityTarget = visibilityTarget;
    this.retryDelayMs = Math.max(0, Number(retryDelayMs) || 0);
    this.maxRetryDelayMs = Math.max(this.retryDelayMs, Number(maxRetryDelayMs) || MAX_RETRY_DELAY_MS);
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.pollIntervalMs = Number.isFinite(Number(pollIntervalMs)) ? Math.max(0, Number(pollIntervalMs)) : DEFAULT_POLL_INTERVAL_MS;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.makeOperationId = makeOperationId;
    this.autoRetry = autoRetry;
    this.started = false;
    this.inFlight = null;
    this.retryTimer = null;
    this.pollTimer = null;
    this.retryAttempt = 0;
    this.lastSyncedAt = null;
    this.lastConflicts = [];
    this.lastError = null;
    this.lastConflict = null;
    this.currentState = 'idle';
    this.recordError = null;
    this._onOnline = () => {
      this.retryAttempt = 0;
      this._clearRetryTimer();
      if (this.inFlight) {
        this.inFlight.then(
          () => { if (this.started) this._kickSync(); },
          () => { if (this.started) this._kickSync(); },
        );
      } else {
        this._kickSync();
      }
    };
    this._onVisibility = () => {
      if (this._isForeground()) {
        this._onOnline();
        this._startPolling();
      } else {
        this._clearPolling();
      }
    };

    const initial = this._loadRecord();
    this.session = initial.session;
    this.revision = initial.revision;
    this.queue = initial.queue;
    this.queueOwnerId = initial.queueOwnerId;
    this.hydrated = initial.hydrated;
    this.recovery = initial.recovery;
    this.lastRemoteState = initial.lastRemoteState;
    this.lastRemoteTombstones = initial.lastRemoteTombstones;
    this.lastSyncedAt = initial.lastSyncedAt;
    this.recordError = initial.error;
    if (this.recordError) this.lastError = this._serializeError(this.recordError);
    this._emitStatus(this.recordError ? 'error' : this.session ? 'idle' : 'unauthenticated');
  }

  _loadRecord() {
    let raw;
    try { raw = this.storage.getItem(STORAGE_KEY); } catch (error) {
      return { session: null, revision: 0, queue: [], queueOwnerId: null, hydrated: false, recovery: [], lastRemoteState: null, lastRemoteTombstones: [], lastSyncedAt: null, error: new SyncClientError('Could not read sync storage', { code: 'storage_error', cause: error }) };
    }
    if (raw == null || raw === '') return { session: null, revision: 0, queue: [], queueOwnerId: null, hydrated: false, recovery: [], lastRemoteState: null, lastRemoteTombstones: [], lastSyncedAt: null, error: null };
    let parsed;
    try { parsed = JSON.parse(raw); } catch (error) {
      return { session: null, revision: 0, queue: [], queueOwnerId: null, hydrated: false, recovery: [], lastRemoteState: null, lastRemoteTombstones: [], lastSyncedAt: null, error: new SyncClientError('Stored sync data is unreadable; it was preserved', { code: 'storage_corrupt', cause: error }) };
    }
    const queue = normalizeQueue(parsed?.queue);
    const sessionValid = parsed?.session === null || (isObject(parsed?.session) && typeof parsed.session.token === 'string' && parsed.session.token.length > 0);
    const revisionValid = isRevision(parsed?.revision);
    const recoveryValid = Array.isArray(parsed?.recovery);
    const remoteStateValid = parsed?.lastRemoteState == null || isObject(parsed?.lastRemoteState);
    const remoteTombstonesValid = parsed?.lastRemoteTombstones == null || Array.isArray(parsed.lastRemoteTombstones);
    const syncedAtValid = parsed?.lastSyncedAt == null || typeof parsed.lastSyncedAt === 'string';
    if (parsed?.version !== 1 || !queue || !sessionValid || !revisionValid || typeof parsed?.hydrated !== 'boolean' || !recoveryValid || !remoteStateValid || !remoteTombstonesValid || !syncedAtValid) {
      return { session: null, revision: 0, queue: [], queueOwnerId: null, hydrated: false, recovery: [], lastRemoteState: null, lastRemoteTombstones: [], lastSyncedAt: null, error: new SyncClientError('Stored sync data is invalid; it was preserved', { code: 'storage_corrupt' }) };
    }
    return {
      session: parsed.session,
      revision: parsed.revision,
      queue,
      queueOwnerId: typeof parsed.queueOwnerId === 'string' ? parsed.queueOwnerId : null,
      hydrated: parsed.hydrated,
      recovery: parsed.recovery,
      lastRemoteState: parsed.lastRemoteState ?? null,
      lastRemoteTombstones: parsed.lastRemoteTombstones ?? [],
      lastSyncedAt: parsed.lastSyncedAt ?? null,
      error: null,
    };
  }

  _record(overrides = {}) {
    return {
      version: 1,
      session: this.session,
      revision: this.revision,
      queue: this.queue,
      queueOwnerId: this.queueOwnerId,
      hydrated: this.hydrated,
      recovery: this.recovery,
      lastRemoteState: this.lastRemoteState ?? null,
      lastRemoteTombstones: this.lastRemoteTombstones ?? [],
      lastSyncedAt: this.lastSyncedAt ?? null,
      ...overrides,
    };
  }

  _save(overrides = {}) {
    if (this.recordError) throw this.recordError;
    const candidate = this._record(overrides);
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(candidate));
    } catch (error) {
      throw new SyncClientError('Could not persist sync data; the pending queue was kept in memory', { code: 'storage_error', cause: error });
    }
  }

  _emitStatus(state, extra = {}) {
    this.currentState = state;
    const status = {
      state,
      authenticated: Boolean(this.session?.token) && state !== 'unauthenticated',
      user: this.session?.user ? cloneJson(this.session.user) : null,
      pendingCount: this.queue?.length ?? 0,
      revision: this.revision ?? 0,
      lastSyncedAt: this.lastSyncedAt,
      conflicts: cloneJson(this.lastConflicts),
      error: this.lastError ? cloneJson(this.lastError) : null,
      conflict: this.lastConflict ? cloneJson(this.lastConflict) : null,
      ...extra,
    };
    try { this.onStatus(status); } catch { /* Observer failures must not interrupt queue persistence. */ }
    return status;
  }

  _serializeError(error) {
    return {
      name: error?.name ?? 'Error',
      message: error?.message ?? String(error),
      status: error?.status ?? 0,
      code: error?.code ?? 'sync_error',
      details: error?.details ?? null,
    };
  }

  getStatus() {
    return {
      state: this.currentState,
      authenticated: Boolean(this.session?.token) && this.currentState !== 'unauthenticated',
      user: this.session?.user ? cloneJson(this.session.user) : null,
      pendingCount: this.queue.length,
      revision: this.revision,
      lastSyncedAt: this.lastSyncedAt,
      conflicts: cloneJson(this.lastConflicts),
      error: this.lastError ? cloneJson(this.lastError) : null,
      conflict: this.lastConflict ? cloneJson(this.lastConflict) : null,
    };
  }

  getToken() {
    return this.session?.token ?? null;
  }

  getPendingOperations() {
    return cloneJson(this.queue);
  }

  getRecoveryItems() {
    return cloneJson(this.recovery);
  }

  _invalidateSession() {
    if (!this.session) return;
    try {
      this._save({ session: null, hydrated: false });
      this.session = null;
      this.hydrated = false;
      this._clearRetryTimer();
      this.lastError = null;
      this._emitStatus('unauthenticated');
    } catch (error) {
      this.lastError = this._serializeError(error);
      this._emitStatus('error');
    }
  }

  resolveExpiredBase(mergedState) {
    if (this.lastConflict?.reason !== 'base_revision_expired') {
      throw new SyncClientError('There is no expired-base conflict to resolve', { code: 'no_expired_base_conflict' });
    }
    if (!isObject(mergedState)) throw new SyncClientError('A resolved sync state is required', { code: 'invalid_state' });
    const remote = this.lastConflict.remote;
    if (!isSnapshot(remote)) throw new SyncClientError('The server did not provide a usable current snapshot', { code: 'invalid_conflict_snapshot' });
    const resolvedState = cloneJson(mergedState, 'Resolved state');
    if (!isObject(resolvedState)) throw new SyncClientError('Resolved state must be a JSON object', { code: 'invalid_state' });
    const operation = {
      type: 'state',
      operationId: this.makeOperationId(),
      state: resolvedState,
      baseRevision: null,
      attempted: false,
    };
    const archived = {
      reason: 'base_revision_expired',
      archivedAt: new Date().toISOString(),
      queuedOperations: cloneJson(this.queue),
      remote: cloneJson(remote),
    };
    const recovery = [...this.recovery, archived];
    const queue = [operation];
    const queueOwnerId = this.queueOwnerId ?? this.session?.user?.id ?? null;
    const lastSyncedAt = remote.updatedAt ?? this.lastSyncedAt;
    this._save({
      queue,
      revision: remote.revision,
      hydrated: true,
      queueOwnerId,
      recovery,
      lastRemoteState: remote.state,
      lastRemoteTombstones: remote.tombstones ?? [],
      lastSyncedAt,
    });
    this.queue = queue;
    this.revision = remote.revision;
    this.hydrated = true;
    this.queueOwnerId = queueOwnerId;
    this.recovery = recovery;
    this.lastRemoteState = cloneJson(remote.state);
    this.lastRemoteTombstones = cloneJson(remote.tombstones ?? []);
    this.lastSyncedAt = lastSyncedAt;
    this.lastConflict = null;
    this.lastError = null;
    this._emitStatus('pending');
    if (this.started) this._kickSync();
    return operation.operationId;
  }

  async _request(path, { method = 'GET', body, authenticated = true } = {}) {
    if (typeof this.fetchImpl !== 'function') throw new SyncClientError('Fetch is unavailable', { code: 'fetch_unavailable' });
    if (authenticated && !this.session?.token) throw new SyncClientError('Sign in to sync this account', { status: 401, code: 'unauthenticated' });
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (authenticated && this.session?.token) headers.Authorization = `Bearer ${this.session.token}`;
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new SyncClientError('Network request failed', { code: 'network_error', cause: error });
    }
    const data = await readResponseBody(response);
    if (!response.ok) {
      const error = errorFromResponse(response, data);
      if (authenticated && response.status === 401) this._invalidateSession();
      throw error;
    }
    return data;
  }

  async register(email, password) {
    return this._authenticate('register', email, password);
  }

  async login(email, password) {
    return this._authenticate('login', email, password);
  }

  async _authenticate(action, email, password) {
    if (typeof email !== 'string' || typeof password !== 'string') {
      throw new SyncClientError('Email and password are required', { code: 'invalid_credentials' });
    }
    const previousUserId = this.session?.user?.id ?? null;
    const data = await this._request(`/api/auth/${action}`, {
      method: 'POST',
      authenticated: false,
      body: { email, password },
    });
    if (!isObject(data) || typeof data.token !== 'string' || !data.token) {
      throw new SyncClientError('Authentication response did not include a bearer token', { code: 'invalid_auth_response' });
    }
    const session = {
      token: data.token,
      tokenType: data.tokenType ?? 'Bearer',
      expiresAt: data.expiresAt ?? null,
      user: data.user ?? null,
    };
    const newUserId = session.user?.id ?? null;
    const queueOwnerMismatch = Boolean(this.queue.length && this.queueOwnerId && newUserId && this.queueOwnerId !== newUserId);
    const hydrated = previousUserId === newUserId ? this.hydrated : false;
    const ownerId = this.queueOwnerId ?? (this.queue.length ? newUserId : null);
    try {
      this._save({ session, hydrated, queueOwnerId: ownerId });
    } catch (error) {
      this.lastError = this._serializeError(error);
      this._emitStatus('error');
      throw error;
    }
    this.session = session;
    this.hydrated = hydrated;
    this.queueOwnerId = ownerId;
    this.lastError = null;
    this.lastConflict = null;
    if (queueOwnerMismatch) {
      this.lastConflict = { reason: 'account_mismatch', queuedUserId: this.queueOwnerId, signedInUserId: newUserId };
      this._emitStatus('conflict');
      try { this.onConflict(cloneJson(this.lastConflict)); } catch { /* Observers do not interrupt authentication. */ }
    } else {
      this._emitStatus('idle');
      if (this.started) this._kickSync();
    }
    return { ...data };
  }

  async logout() {
    if (!this.session?.token) return { loggedOut: true };
    try {
      await this._request('/api/auth/logout', { method: 'POST' });
    } catch (error) {
      if (!(error instanceof SyncApiError && error.status === 401)) {
        this.lastError = this._serializeError(error);
        this._emitStatus('error');
        throw error;
      }
    }
    const session = null;
    this._save({ session });
    this.session = session;
    this.hydrated = false;
    this._clearRetryTimer();
    this.lastError = null;
    this._emitStatus('unauthenticated');
    return { loggedOut: true };
  }

  setLocalState(state) {
    if (!isObject(state)) throw new SyncClientError('Sync state must be an object', { code: 'invalid_state' });
    const clonedState = cloneJson(state, 'Sync state');
    if (!isObject(clonedState)) throw new SyncClientError('Sync state must be a JSON object', { code: 'invalid_state' });
    const currentQueue = this.queue;
    let nextQueue;
    if (currentQueue.length === 0) {
      nextQueue = [{ type: 'state', operationId: this.makeOperationId(), state: clonedState, baseRevision: null, attempted: false }];
    } else {
      const last = currentQueue.at(-1);
      if (last.type === 'state' && !last.attempted) {
        nextQueue = currentQueue.map((item, index) => index === currentQueue.length - 1 ? { ...item, state: clonedState } : item);
      } else {
        nextQueue = [...currentQueue, { type: 'state', operationId: this.makeOperationId(), state: clonedState, baseRevision: null, attempted: false }];
      }
    }
    const ownerId = this.queueOwnerId ?? this.session?.user?.id ?? null;
    try {
      this._save({ queue: nextQueue, queueOwnerId: ownerId });
    } catch (error) {
      this.lastError = this._serializeError(error);
      this._emitStatus('error');
      throw error;
    }
    this.queue = nextQueue;
    this.queueOwnerId = ownerId;
    this.lastError = null;
    this._emitStatus(this.session ? 'pending' : 'unauthenticated');
    if (this.started) this._kickSync();
    return nextQueue.at(-1).operationId;
  }

  async getHistory() {
    const data = await this._request('/api/sync/history');
    if (!isObject(data) || !Array.isArray(data.history)) {
      throw new SyncClientError('Sync history response was invalid', { code: 'invalid_sync_response' });
    }
    return cloneJson(data);
  }

  async restore(historyId, version) {
    if (typeof historyId !== 'string' || !historyId) throw new SyncClientError('A history item is required', { code: 'invalid_history_id' });
    if (!['losing', 'winning'].includes(version)) throw new SyncClientError('Version must be losing or winning', { code: 'invalid_restore_version' });
    if (!this.session?.token) throw new SyncClientError('Sign in to restore sync history', { status: 401, code: 'unauthenticated' });
    if (this.queue.length > 0) throw new SyncClientError('Sync pending local changes before restoring history', { code: 'pending_changes' });
    const operation = {
      type: 'restore',
      historyId,
      version: version === 'losing' ? 'incoming' : 'server',
      operationId: this.makeOperationId(),
      baseRevision: null,
      attempted: false,
    };
    const nextQueue = [operation];
    this._save({ queue: nextQueue, queueOwnerId: this.session.user?.id ?? this.queueOwnerId });
    this.queue = nextQueue;
    this.lastConflict = null;
    this.lastError = null;
    this._emitStatus('pending');
    try {
      await this.syncNow();
    } catch {
      // The durable restore operation remains queued for retry or inspection.
    }
    if (this.queue.length) {
      throw new SyncClientError('History restore is still pending', { code: 'restore_pending', details: this.getStatus() });
    }
    return { revision: this.revision, state: this.lastRemoteState ?? null, updatedAt: this.lastSyncedAt, tombstones: cloneJson(this.lastRemoteTombstones ?? []) };
  }

  start() {
    if (this.started) return this;
    this.started = true;
    this.onlineTarget?.addEventListener?.('online', this._onOnline);
    this.visibilityTarget?.addEventListener?.('visibilitychange', this._onVisibility);
    this._startPolling();
    this._kickSync();
    return this;
  }

  stop() {
    if (!this.started) return this;
    this.started = false;
    this.onlineTarget?.removeEventListener?.('online', this._onOnline);
    this.visibilityTarget?.removeEventListener?.('visibilitychange', this._onVisibility);
    this._clearRetryTimer();
    this._clearPolling();
    return this;
  }

  _isForeground() {
    return !this.visibilityTarget || this.visibilityTarget.visibilityState === 'visible';
  }

  _startPolling() {
    if (!this.started || !this._isForeground() || this.pollIntervalMs <= 0 || !this.setIntervalFn || this.pollTimer !== null) return;
    this.pollTimer = this.setIntervalFn(() => {
      if (!this.started || !this._isForeground() || this.navigator?.onLine === false || !this.session?.token || this.inFlight) return;
      this._kickSync();
    }, this.pollIntervalMs);
  }

  _clearPolling() {
    if (this.pollTimer !== null && this.clearIntervalFn) this.clearIntervalFn(this.pollTimer);
    this.pollTimer = null;
  }

  _kickSync() {
    if (!this.started || !this.session?.token || this.lastConflict?.reason === 'base_revision_expired' || this.lastConflict?.reason === 'account_mismatch') return;
    this.syncNow().catch(() => {});
  }

  _clearRetryTimer() {
    if (this.retryTimer !== null && this.clearTimeoutFn) this.clearTimeoutFn(this.retryTimer);
    this.retryTimer = null;
  }

  _scheduleRetry(error) {
    if (!this.started || !this.autoRetry || !this.setTimeoutFn || this.retryTimer !== null) return;
    if (error instanceof SyncApiError && error.status < 500 && error.status !== 408 && error.status !== 429) return;
    const delay = Math.min(this.maxRetryDelayMs, this.retryDelayMs * (2 ** Math.min(this.retryAttempt, 8)));
    this.retryAttempt += 1;
    this._emitStatus('retrying', { retryInMs: delay });
    this.retryTimer = this.setTimeoutFn(() => {
      this.retryTimer = null;
      this._kickSync();
    }, delay);
  }

  async syncNow() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this._drainQueue();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  async _drainQueue() {
    if (this.recordError) throw this.recordError;
    if (!this.session?.token) {
      this._emitStatus('unauthenticated');
      return this.getStatus();
    }
    if (this.queueOwnerId && this.session.user?.id && this.queueOwnerId !== this.session.user.id) {
      this.lastConflict = { reason: 'account_mismatch', queuedUserId: this.queueOwnerId, signedInUserId: this.session.user.id };
      this._emitStatus('conflict');
      return this.getStatus();
    }
    if (this.navigator?.onLine === false) {
      this._emitStatus('offline');
      this._scheduleRetry(new SyncClientError('Browser is offline', { code: 'offline' }));
      return this.getStatus();
    }

    this.lastError = null;
    this.lastConflict = null;
    let processedWrite = false;
    while (this.queue.length > 0) {
      const head = this.queue[0];
      if (!head.attempted) {
        const attemptedHead = { ...head, baseRevision: this.revision, attempted: true };
        const nextQueue = [attemptedHead, ...this.queue.slice(1)];
        try {
          this._save({ queue: nextQueue });
        } catch (error) {
          this.lastError = this._serializeError(error);
          this._emitStatus('error');
          throw error;
        }
        this.queue = nextQueue;
      }
      const requestOperation = this.queue[0];
      this._emitStatus('syncing');
      let snapshot;
      try {
        snapshot = requestOperation.type === 'restore'
          ? await this._request('/api/sync/restore', {
            method: 'POST',
            body: {
              historyId: requestOperation.historyId,
              version: requestOperation.version,
              baseRevision: requestOperation.baseRevision,
              operationId: requestOperation.operationId,
            },
          })
          : await this._request('/api/sync', {
            method: 'PUT',
            body: {
              baseRevision: requestOperation.baseRevision,
              operationId: requestOperation.operationId,
              state: requestOperation.state,
            },
          });
      } catch (error) {
        this.lastError = this._serializeError(error);
        if (error instanceof SyncApiError && error.status === 401) {
          this._emitStatus('unauthenticated');
        } else if (error instanceof SyncApiError && error.status === 409 && error.code === 'base_revision_expired') {
          this.lastConflict = {
            reason: 'base_revision_expired',
            operationId: requestOperation.operationId,
            submittedState: requestOperation.type === 'state' ? cloneJson(requestOperation.state) : null,
            localState: [...this.queue].reverse().find((operation) => operation.type === 'state')?.state
              ? cloneJson([...this.queue].reverse().find((operation) => operation.type === 'state').state)
              : null,
            pendingOperations: cloneJson(this.queue),
            remote: error.details,
          };
          this._emitStatus('conflict');
          try { this.onConflict(cloneJson(this.lastConflict)); } catch { /* Observer failures do not change queue state. */ }
        } else {
          this._emitStatus('error');
          this._scheduleRetry(error);
        }
        throw error;
      }

      if (!isSnapshot(snapshot)) {
        const error = new SyncClientError('Sync response did not include a valid revision and state', { code: 'invalid_sync_response' });
        this.lastError = this._serializeError(error);
        this._emitStatus('error');
        throw error;
      }
      const previous = requestOperation.type === 'state' ? requestOperation.state : this.lastRemoteState ?? {};
      const tail = this.queue.slice(1);
      let nextQueue = tail;
      if (tail.length && tail[0].type === 'state') {
        const rebased = mergeLocalChanges(previous, tail[0].state, snapshot.state);
        nextQueue = [{ ...tail[0], state: rebased }, ...tail.slice(1)];
      }
      const nextRevision = snapshot.revision;
      const nextHydrated = true;
      const nextOwnerId = nextQueue.length ? this.queueOwnerId ?? this.session.user?.id ?? null : null;
      try {
        this._save({ queue: nextQueue, revision: nextRevision, hydrated: nextHydrated, queueOwnerId: nextOwnerId, lastRemoteState: snapshot.state, lastRemoteTombstones: snapshot.tombstones ?? [], lastSyncedAt: snapshot.updatedAt ?? null });
      } catch (error) {
        this.lastError = this._serializeError(error);
        this._emitStatus('error');
        throw error;
      }
      this.queue = nextQueue;
      this.revision = nextRevision;
      this.hydrated = nextHydrated;
      this.queueOwnerId = nextOwnerId;
      this.lastRemoteState = cloneJson(snapshot.state);
      this.lastRemoteTombstones = cloneJson(snapshot.tombstones ?? []);
      processedWrite = true;
      this.lastSyncedAt = snapshot.updatedAt ?? null;
      this.lastConflicts = Array.isArray(snapshot.conflicts) ? cloneJson(snapshot.conflicts) : [];
      this.lastError = null;
      this.lastConflict = null;
      this.retryAttempt = 0;
      this._clearRetryTimer();

      if (nextQueue.length === 0) {
        try {
          this.onRemoteState(cloneJson(snapshot.state), {
            revision: this.revision,
            updatedAt: this.lastSyncedAt,
            conflicts: cloneJson(this.lastConflicts),
            operationId: requestOperation.operationId,
            source: requestOperation.type,
            tombstones: cloneJson(this.lastRemoteTombstones),
          });
        } catch { /* Observer failures must not undo an acknowledged sync. */ }
      }
      if (nextQueue.length === 0 && this.lastConflicts.length) {
        this._emitStatus('conflict', { conflicts: this.lastConflicts });
      } else if (nextQueue.length > 0) {
        this._emitStatus('pending');
      } else {
        this._emitStatus('synced');
      }
    }

    if (!processedWrite) {
      const pullBaseRevision = this.revision;
      let snapshot;
      try {
        snapshot = await this._request('/api/sync');
        if (!isSnapshot(snapshot)) throw new SyncClientError('Sync response did not include a valid revision and state', { code: 'invalid_sync_response' });
      } catch (error) {
        this.lastError = this._serializeError(error);
        if (error instanceof SyncApiError && error.status === 401) this._emitStatus('unauthenticated');
        else {
          this._emitStatus('error');
          this._scheduleRetry(error);
        }
        throw error;
      }

      if (this.queue.length > 0) {
        // A local save can arrive while a foreground pull is in flight. Keep it as an
        // immutable request based on the revision known before the pull, so the server
        // can merge it against the just-fetched revision and record any overlap.
        const head = this.queue[0];
        const attemptedHead = {
          ...head,
          baseRevision: head.type === 'restore' ? snapshot.revision : pullBaseRevision,
          attempted: true,
        };
        const nextQueue = [attemptedHead, ...this.queue.slice(1)];
        try {
          this._save({
            queue: nextQueue,
            revision: snapshot.revision,
            hydrated: true,
            lastRemoteState: snapshot.state,
            lastRemoteTombstones: snapshot.tombstones ?? [],
            lastSyncedAt: snapshot.updatedAt ?? null,
          });
        } catch (error) {
          this.lastError = this._serializeError(error);
          this._emitStatus('error');
          throw error;
        }
        this.queue = nextQueue;
        this.revision = snapshot.revision;
        this.hydrated = true;
        this.lastRemoteState = cloneJson(snapshot.state);
        this.lastRemoteTombstones = cloneJson(snapshot.tombstones ?? []);
        this.lastSyncedAt = snapshot.updatedAt ?? null;
        this.lastConflicts = [];
        this.lastError = null;
        this._emitStatus('pending');
        return this._drainQueue();
      }

      try {
        this._save({ revision: snapshot.revision, hydrated: true, lastRemoteState: snapshot.state, lastRemoteTombstones: snapshot.tombstones ?? [], lastSyncedAt: snapshot.updatedAt ?? null });
      } catch (error) {
        this.lastError = this._serializeError(error);
        this._emitStatus('error');
        throw error;
      }
      this.revision = snapshot.revision;
      this.hydrated = true;
      this.lastRemoteState = cloneJson(snapshot.state);
      this.lastRemoteTombstones = cloneJson(snapshot.tombstones ?? []);
      this.lastSyncedAt = snapshot.updatedAt ?? null;
      this.lastConflicts = [];
      this.lastError = null;
      try {
        this.onRemoteState(cloneJson(snapshot.state), {
          revision: this.revision,
          updatedAt: this.lastSyncedAt,
          conflicts: [],
          operationId: null,
          source: 'pull',
          tombstones: cloneJson(this.lastRemoteTombstones),
        });
      } catch { /* Observer failures do not change hydrated state. */ }
      this._emitStatus('synced');
    }
    return this.getStatus();
  }
}

export function createSyncClient(options) {
  return new SyncClient(options);
}

export const SYNC_CLIENT_STORAGE_KEY = STORAGE_KEY;
