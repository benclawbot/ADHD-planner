import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_LIFETIME_MS = 30 * DAY_MS;
const HISTORY_RETENTION_MS = 30 * DAY_MS;
const SNAPSHOT_RETENTION_MS = 30 * DAY_MS;
const MAX_SNAPSHOTS = 256;
const MAX_OPERATIONS = 10_000;
const MAX_CONFLICTS_PER_OPERATION = 1_000;
const MAX_HISTORY_ENTRIES = 10_000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_STATE_BYTES = 512 * 1024;
const MAX_ENTITIES = 20_000;
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const DUMMY_SALT = Buffer.alloc(16, 0x54);
const DUMMY_PASSWORD = 'tempo sync invalid login sentinel';

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sameSecret(left, right) {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function sameValue(leftExists, left, rightExists, right) {
  if (leftExists !== rightExists) return false;
  if (!leftExists) return true;
  return stableStringify(left) === stableStringify(right);
}

function isoDate(date) {
  return date.toISOString();
}

function parseIsoMs(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function jsonResponse(res, status, body, headers = {}) {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': bytes.length,
    ...headers,
  });
  res.end(bytes);
}

function emptyResponse(res, status = 204, headers = {}) {
  res.writeHead(status, headers);
  res.end();
}

function sendError(res, error) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (error instanceof HttpError) {
    const body = { error: { code: error.code, message: error.message } };
    if (error.details !== undefined) body.error.details = error.details;
    const retryAfter = error.code === 'registration_limit' ? '3600' : '300';
    jsonResponse(res, error.status, body, error.status === 429 ? { 'Retry-After': retryAfter } : {});
    return;
  }
  jsonResponse(res, 500, { error: { code: 'internal_error', message: 'The request could not be completed.' } });
}

async function readJson(req, maxBytes = MAX_BODY_BYTES) {
  const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new HttpError(415, 'json_required', 'Send a JSON request body.');
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > maxBytes) throw new HttpError(413, 'body_too_large', 'The request body is too large.');
    chunks.push(chunk);
  }
  if (length === 0) throw new HttpError(400, 'invalid_json', 'The request body must contain JSON.');
  try {
    return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', 'The request body must contain valid JSON.');
  }
}

function isPlainJsonObject(value) {
  return isRecord(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function validateJsonTree(value, pathParts = []) {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) validateJsonTree(value[index], [...pathParts, index]);
    return;
  }
  if (isRecord(value)) {
    if (!isPlainJsonObject(value)) throw new HttpError(400, 'invalid_state', 'State values must be plain JSON objects.');
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) throw new HttpError(400, 'invalid_state', 'State contains a disallowed property name.');
      validateJsonTree(child, [...pathParts, key]);
    }
    return;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  throw new HttpError(400, 'invalid_state', 'State must contain JSON values only.');
}

function validateState(rawState) {
  if (!isPlainJsonObject(rawState)) throw new HttpError(400, 'invalid_state', 'State must be a JSON object.');
  validateJsonTree(rawState);
  if (rawState.schema !== 1 || !Array.isArray(rawState.tasks) || !Array.isArray(rawState.captures)) {
    throw new HttpError(400, 'invalid_state', 'State must include schema 1, tasks, and captures.');
  }
  if (rawState.tasks.length + rawState.captures.length > MAX_ENTITIES) {
    throw new HttpError(413, 'too_many_entities', 'State contains too many tasks or captures.');
  }
  for (const [collection, entities] of [['tasks', rawState.tasks], ['captures', rawState.captures]]) {
    const ids = new Set();
    for (const entity of entities) {
      if (!isPlainJsonObject(entity) || typeof entity.id !== 'string' || entity.id.length < 1 || entity.id.length > 200) {
        throw new HttpError(400, 'invalid_state', `${collection} entries need a stable string id.`);
      }
      if (ids.has(entity.id)) throw new HttpError(400, 'invalid_state', `${collection} contains duplicate ids.`);
      ids.add(entity.id);
    }
  }
  const state = cloneJson(rawState);
  if (Buffer.byteLength(JSON.stringify(state)) > MAX_STATE_BYTES) {
    throw new HttpError(413, 'state_too_large', 'State exceeds the 512 KiB limit.');
  }
  return state;
}

function emptyState() {
  return { schema: 1, tasks: [], captures: [], focus: null, settings: {} };
}

function validateEmail(rawEmail) {
  if (typeof rawEmail !== 'string') throw new HttpError(400, 'invalid_email', 'Provide a valid email address.');
  const email = rawEmail.trim().toLowerCase();
  if (email.length > 320 || !/^[^@\s]+@[^@\s]+$/.test(email)) {
    throw new HttpError(400, 'invalid_email', 'Provide a valid email address.');
  }
  return email;
}

function validatePassword(rawPassword, { registering = false } = {}) {
  if (typeof rawPassword !== 'string' || Buffer.byteLength(rawPassword, 'utf8') > 1024) {
    throw new HttpError(400, 'invalid_password', 'Password is missing or too long.');
  }
  if (registering && Buffer.byteLength(rawPassword, 'utf8') < 12) {
    throw new HttpError(400, 'weak_password', 'Use a password with at least 12 bytes.');
  }
  return rawPassword;
}

function validateOperationId(raw) {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(raw)) {
    throw new HttpError(400, 'invalid_operation_id', 'operationId must contain 8 to 128 safe characters.');
  }
  return raw;
}

function validateRevision(raw) {
  if (!Number.isSafeInteger(raw) || raw < 0) throw new HttpError(400, 'invalid_revision', 'baseRevision must be a non-negative integer.');
  return raw;
}

function pathLabel(pathParts) {
  return pathParts.map((part, index) => {
    if (part.entityId !== undefined) return `[${JSON.stringify(part.entityId)}]`;
    const key = part.key;
    return index === 0 ? key : `.${key}`;
  }).join('');
}

function snapshotExists(sync, revision) {
  return sync.snapshots.find((item) => item.revision === revision) ?? null;
}

function publicSnapshot(sync) {
  return {
    revision: sync.revision,
    state: cloneJson(sync.state),
    updatedAt: sync.updatedAt,
    tombstones: cloneJson(sync.tombstones ?? []),
  };
}

function encodeVersion(exists, value, extra = {}) {
  return exists ? { exists: true, value: cloneJson(value), ...extra } : { exists: false, ...extra };
}

function createConflict(pathParts, baseExists, baseValue, serverExists, serverValue, incomingExists, incomingValue, context) {
  const id = randomUUID();
  const createdAt = isoDate(context.now);
  return {
    id,
    path: pathParts.map((part) => ({ ...part })),
    label: pathLabel(pathParts),
    createdAt,
    expiresAt: isoDate(new Date(context.now.getTime() + HISTORY_RETENTION_MS)),
    winner: 'server',
    policy: 'server_revision_wins',
    resolvedRevision: context.resolvedRevision,
    base: encodeVersion(baseExists, baseValue, { revision: context.baseRevision }),
    server: encodeVersion(serverExists, serverValue, { revision: context.serverRevision, operationId: context.serverOperationId }),
    incoming: encodeVersion(incomingExists, incomingValue, { operationId: context.operationId }),
  };
}

function hasVersionChange(valueExists, value, baseExists, baseValue) {
  return !sameValue(valueExists, value, baseExists, baseValue);
}

function mergeEntityArray(base, server, incoming, pathParts, context, conflicts) {
  const baseMap = new Map(base.map((entry) => [entry.id, entry]));
  const serverMap = new Map(server.map((entry) => [entry.id, entry]));
  const incomingMap = new Map(incoming.map((entry) => [entry.id, entry]));
  const mergedMap = new Map();
  const allIds = new Set([...baseMap.keys(), ...serverMap.keys(), ...incomingMap.keys()]);

  for (const id of allIds) {
    const baseExists = baseMap.has(id);
    const serverExists = serverMap.has(id);
    const incomingExists = incomingMap.has(id);
    const baseItem = baseMap.get(id);
    const serverItem = serverMap.get(id);
    const incomingItem = incomingMap.get(id);
    const isDeleted = (exists, item) => !exists || item?.status === 'removed';
    const baseDeleted = isDeleted(baseExists, baseItem);
    const serverDeleted = isDeleted(serverExists, serverItem);
    const incomingDeleted = isDeleted(incomingExists, incomingItem);

    if (!baseDeleted && serverDeleted && incomingDeleted) {
      if (serverExists) mergedMap.set(id, cloneJson(serverItem));
      continue;
    }

    // The current model represents task deletion with status="removed". Treat it
    // as a tombstone so a stale edit cannot silently update a deleted task.
    const serverHasNewerDelete = !baseDeleted && serverDeleted && !incomingDeleted
      && hasVersionChange(true, incomingItem, true, baseItem);
    const incomingDeleteAgainstServerEdit = !baseDeleted && incomingDeleted && !serverDeleted
      && hasVersionChange(true, serverItem, true, baseItem);
    if (serverHasNewerDelete || incomingDeleteAgainstServerEdit) {
      conflicts.push(createConflict(
        [...pathParts, { entityId: id }],
        baseExists, baseItem, serverExists, serverItem, incomingExists, incomingItem,
        context,
      ));
      if (serverExists) mergedMap.set(id, cloneJson(serverItem));
      continue;
    }

    const merged = mergeNode(
      baseExists, baseMap.get(id), serverExists, serverMap.get(id), incomingExists, incomingMap.get(id),
      [...pathParts, { entityId: id }], context, conflicts,
    );
    if (merged.exists) mergedMap.set(id, merged.value);
  }

  const common = base.map((entry) => entry.id).filter((id) => mergedMap.has(id) && serverMap.has(id) && incomingMap.has(id));
  const commonSet = new Set(common);
  const baseOrder = common;
  const serverOrder = server.map((entry) => entry.id).filter((id) => commonSet.has(id));
  const incomingOrder = incoming.map((entry) => entry.id).filter((id) => commonSet.has(id));
  const serverReordered = !sameSequence(serverOrder, baseOrder);
  const incomingReordered = !sameSequence(incomingOrder, baseOrder);
  const orderConflict = serverReordered && incomingReordered && !sameSequence(serverOrder, incomingOrder);

  if (orderConflict) {
    conflicts.push(createConflict(
      pathParts,
      true, base.map((entry) => cloneJson(entry)),
      true, server.map((entry) => cloneJson(entry)),
      true, incoming.map((entry) => cloneJson(entry)),
      context,
    ));
  }

  const primary = incomingReordered && !serverReordered ? incoming : server;
  const orderedIds = [];
  for (const entity of primary) if (mergedMap.has(entity.id) && !orderedIds.includes(entity.id)) orderedIds.push(entity.id);
  for (const entity of server) if (mergedMap.has(entity.id) && !orderedIds.includes(entity.id)) orderedIds.push(entity.id);
  for (const entity of incoming) if (mergedMap.has(entity.id) && !orderedIds.includes(entity.id)) orderedIds.push(entity.id);
  for (const id of [...mergedMap.keys()].sort()) if (!orderedIds.includes(id)) orderedIds.push(id);
  return orderedIds.map((id) => mergedMap.get(id));
}

function sameSequence(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function mergeNode(baseExists, baseValue, serverExists, serverValue, incomingExists, incomingValue, pathParts, context, conflicts) {
  if (sameValue(incomingExists, incomingValue, baseExists, baseValue)) return { exists: serverExists, value: serverExists ? cloneJson(serverValue) : undefined };
  if (sameValue(serverExists, serverValue, baseExists, baseValue)) return { exists: incomingExists, value: incomingExists ? cloneJson(incomingValue) : undefined };
  if (sameValue(serverExists, serverValue, incomingExists, incomingValue)) return { exists: serverExists, value: serverExists ? cloneJson(serverValue) : undefined };

  const lastPath = pathParts.at(-1);
  const collectionKey = pathParts.length === 1 && lastPath?.key;
  if (serverExists && incomingExists && Array.isArray(serverValue) && Array.isArray(incomingValue)
      && Array.isArray(baseValue) && (collectionKey === 'tasks' || collectionKey === 'captures')) {
    return { exists: true, value: mergeEntityArray(baseValue, serverValue, incomingValue, pathParts, context, conflicts) };
  }

  const canMergeObjects = serverExists && incomingExists && isPlainJsonObject(serverValue) && isPlainJsonObject(incomingValue)
    && (!baseExists || isPlainJsonObject(baseValue));
  if (canMergeObjects) {
    const result = {};
    const keys = new Set([...Object.keys(baseValue ?? {}), ...Object.keys(serverValue), ...Object.keys(incomingValue)]);
    for (const key of keys) {
      if (FORBIDDEN_KEYS.has(key)) continue;
      const nested = mergeNode(
        baseExists && Object.hasOwn(baseValue ?? {}, key), baseValue?.[key],
        Object.hasOwn(serverValue, key), serverValue[key],
        Object.hasOwn(incomingValue, key), incomingValue[key],
        [...pathParts, { key }], context, conflicts,
      );
      if (nested.exists) result[key] = nested.value;
    }
    return { exists: true, value: result };
  }

  conflicts.push(createConflict(pathParts, baseExists, baseValue, serverExists, serverValue, incomingExists, incomingValue, context));
  return { exists: serverExists, value: serverExists ? cloneJson(serverValue) : undefined };
}

function readAtPath(root, pathParts) {
  let node = root;
  for (const part of pathParts) {
    if (part.key !== undefined) {
      if (!isRecord(node) || !Object.hasOwn(node, part.key)) return { exists: false };
      node = node[part.key];
    } else if (part.entityId !== undefined) {
      if (!Array.isArray(node)) return { exists: false };
      const index = node.findIndex((entry) => entry?.id === part.entityId);
      if (index < 0) return { exists: false };
      node = node[index];
    } else {
      return { exists: false };
    }
  }
  return { exists: true, value: node };
}

function assignAtPath(root, pathParts, version) {
  if (!pathParts.length) return version.exists ? cloneJson(version.value) : emptyState();
  let node = root;
  for (let index = 0; index < pathParts.length - 1; index += 1) {
    const part = pathParts[index];
    const next = pathParts[index + 1];
    if (part.key !== undefined) {
      if (!isRecord(node)) return root;
      if (!Object.hasOwn(node, part.key)) node[part.key] = next.entityId !== undefined ? [] : {};
      node = node[part.key];
    } else if (part.entityId !== undefined) {
      if (!Array.isArray(node)) return root;
      let found = node.find((entry) => entry?.id === part.entityId);
      if (!found) {
        found = { id: part.entityId };
        node.push(found);
      }
      node = found;
    }
  }
  const last = pathParts.at(-1);
  if (last.key !== undefined) {
    if (!isRecord(node)) return root;
    if (version.exists) node[last.key] = cloneJson(version.value);
    else delete node[last.key];
  } else if (last.entityId !== undefined && Array.isArray(node)) {
    const index = node.findIndex((entry) => entry?.id === last.entityId);
    if (!version.exists) {
      if (index >= 0) node.splice(index, 1);
    } else if (index >= 0) {
      node[index] = cloneJson(version.value);
    } else {
      node.push(cloneJson(version.value));
    }
  }
  return root;
}

function pruneSync(sync, nowMs) {
  sync.history = sync.history.filter((entry) => parseIsoMs(entry.expiresAt) >= nowMs);
  sync.snapshots = sync.snapshots.filter((entry) => entry.revision === sync.revision || parseIsoMs(entry.updatedAt) >= nowMs - SNAPSHOT_RETENTION_MS);
  if (sync.snapshots.length > MAX_SNAPSHOTS) sync.snapshots.splice(0, sync.snapshots.length - MAX_SNAPSHOTS);
  sync.operations = sync.operations.filter((entry) => parseIsoMs(entry.createdAt) >= nowMs - HISTORY_RETENTION_MS);
  sync.tombstones = (sync.tombstones ?? []).filter((entry) => parseIsoMs(entry.deletedAt) > nowMs - HISTORY_RETENTION_MS);
}

function updateTombstones(sync, previousState, nextState, revision, now) {
  const tombstones = sync.tombstones ?? [];
  for (const collection of ['tasks', 'captures']) {
    const before = new Map((previousState?.[collection] ?? []).map((entry) => [entry.id, entry]));
    const after = new Map((nextState?.[collection] ?? []).map((entry) => [entry.id, entry]));
    const ids = new Set([...before.keys(), ...after.keys()]);
    for (const id of ids) {
      const beforeItem = before.get(id);
      const afterItem = after.get(id);
      const beforeDeleted = !before.has(id) || beforeItem?.status === 'removed';
      const afterDeleted = !after.has(id) || afterItem?.status === 'removed';
      const wasExplicitlyRemoved = after.has(id) && afterItem?.status === 'removed';
      if (afterDeleted && (!beforeDeleted || wasExplicitlyRemoved) && !tombstones.some((entry) => entry.collection === collection && entry.id === id)) {
        tombstones.push({ collection, id, revision, deletedAt: isoDate(now) });
      } else if (afterDeleted && !tombstones.some((entry) => entry.collection === collection && entry.id === id)) {
        tombstones.push({ collection, id, revision, deletedAt: isoDate(now) });
      } else if (!afterDeleted) {
        const retained = tombstones.filter((entry) => entry.collection !== collection || entry.id !== id);
        tombstones.splice(0, tombstones.length, ...retained);
      }
    }
  }
  sync.tombstones = tombstones;
}

function cleanConflict(conflict) {
  return cloneJson(conflict);
}

function snapshotError(sync, code, message) {
  return new HttpError(409, code, message, publicSnapshot(sync));
}

function validateStore(store) {
  if (!isPlainJsonObject(store) || store.version !== 1 || !Array.isArray(store.users) || !Array.isArray(store.sessions)) {
    throw new Error('Sync store has an unsupported or invalid format. Refusing to overwrite it.');
  }
  for (const user of store.users) {
    if (!isPlainJsonObject(user) || typeof user.id !== 'string' || !isPlainJsonObject(user.sync)) {
      throw new Error('Sync store contains an invalid account record. Refusing to overwrite it.');
    }
    const sync = user.sync;
    if (!Number.isSafeInteger(sync.revision) || sync.revision < 0 || !Array.isArray(sync.snapshots) || !Array.isArray(sync.history) || !Array.isArray(sync.operations)) {
      throw new Error('Sync store contains invalid sync metadata. Refusing to overwrite it.');
    }
    validateState(sync.state);
    if (sync.tombstones !== undefined && !Array.isArray(sync.tombstones)) {
      throw new Error('Sync store contains invalid tombstones. Refusing to overwrite it.');
    }
    for (const snapshot of sync.snapshots) validateState(snapshot.state);
  }
}

async function loadStore(dataDir) {
  const createdPath = await mkdir(dataDir, { recursive: true, mode: 0o700 });
  if (createdPath) {
    try {
      await chmod(dataDir, 0o700);
    } catch {
      // Permission enforcement is best effort on non-POSIX filesystems.
    }
  }
  const directoryInfo = await lstat(dataDir);
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
    throw new Error('Sync data path must be a directory, not a symlink or file.');
  }
  const filename = path.join(dataDir, 'store.json');
  try {
    const info = await lstat(filename);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('Sync store path must be a regular file, not a symlink.');
    try {
      await chmod(filename, 0o600);
    } catch {
      // Permission enforcement is best effort on non-POSIX filesystems.
    }
    const parsed = JSON.parse(await readFile(filename, 'utf8'));
    validateStore(parsed);
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, users: [], sessions: [] };
    throw error;
  }
}

async function persistStore(dataDir, store) {
  const filename = path.join(dataDir, 'store.json');
  const temporary = path.join(dataDir, `.store-${process.pid}-${randomBytes(8).toString('hex')}.tmp`);
  const contents = Buffer.from(JSON.stringify(store));
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filename);
    try {
      const directory = await open(dataDir, 'r');
      await directory.sync();
      await directory.close();
    } catch {
      // Some platforms cannot fsync directories; file contents are still synced before rename.
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function parseAllowedOrigins(raw) {
  if (Array.isArray(raw)) return new Set(raw.map((value) => String(value).trim()).filter(Boolean));
  if (typeof raw === 'string') return new Set(raw.split(',').map((value) => value.trim()).filter(Boolean));
  return new Set(String(process.env.TEMPO_SYNC_ALLOWED_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean));
}

function defaultDataDir() {
  if (process.env.XDG_DATA_HOME) return path.join(process.env.XDG_DATA_HOME, 'tempo-sync');
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'Tempo', 'Sync');
  }
  if (process.platform === 'darwin') return path.join(homedir(), 'Library', 'Application Support', 'Tempo', 'Sync');
  return path.join(homedir(), '.local', 'share', 'tempo-sync');
}

export async function createSyncServer({ dataDir = process.env.TEMPO_SYNC_DATA_DIR, now = () => new Date(), allowedOrigins } = {}) {
  const resolvedDataDir = path.resolve(dataDir || defaultDataDir());
  let store = await loadStore(resolvedDataDir);
  const dummyPasswordHash = Buffer.from(await scrypt(DUMMY_PASSWORD, DUMMY_SALT, 64, SCRYPT_OPTIONS)).toString('hex');
  const origins = parseAllowedOrigins(allowedOrigins);
  const loginAttempts = new Map();
  const registrationAttempts = new Map();
  let transactionQueue = Promise.resolve();

  async function transact(operation) {
    const result = transactionQueue.then(async () => {
      const next = cloneJson(store);
      const value = await operation(next);
      await persistStore(resolvedDataDir, next);
      store = next;
      return value;
    });
    transactionQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  function currentTime() {
    const date = now();
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error('Clock returned an invalid date.');
    return new Date(date.getTime());
  }

  function baseHeaders(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    const origin = req.headers.origin;
    if (origin && origins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
      res.setHeader('Vary', 'Origin');
    }
  }

  function requireAuth(req, database, time) {
    const match = /^Bearer ([A-Za-z0-9_-]{40,60})$/.exec(String(req.headers.authorization ?? ''));
    if (!match) throw new HttpError(401, 'authentication_required', 'Sign in to access this resource.');
    const tokenHash = hash(match[1]);
    const session = database.sessions.find((entry) => sameSecret(entry.tokenHash, tokenHash));
    if (!session || parseIsoMs(session.expiresAt) <= time.getTime()) {
      throw new HttpError(401, 'authentication_required', 'Sign in to access this resource.');
    }
    const user = database.users.find((entry) => entry.id === session.userId);
    if (!user) throw new HttpError(401, 'authentication_required', 'Sign in to access this resource.');
    return { user, session };
  }

  function checkLoginLimit(ip, timeMs) {
    const key = ip || 'unknown';
    const recent = (loginAttempts.get(key) ?? []).filter((attempt) => attempt > timeMs - 5 * 60 * 1000);
    loginAttempts.set(key, recent);
    if (recent.length >= 20) throw new HttpError(429, 'too_many_attempts', 'Too many sign-in attempts. Try again in a few minutes.');
    if (loginAttempts.size > 1_000) {
      for (const [address, attempts] of loginAttempts) {
        if (!attempts.some((attempt) => attempt > timeMs - 5 * 60 * 1000)) loginAttempts.delete(address);
      }
    }
  }

  function checkRegistrationLimit(ip, timeMs) {
    const key = ip || 'unknown';
    const recent = (registrationAttempts.get(key) ?? []).filter((attempt) => attempt > timeMs - 60 * 60 * 1000);
    if (recent.length >= 20) throw new HttpError(429, 'registration_limit', 'Too many accounts were created from this address. Try again later.');
    recent.push(timeMs);
    registrationAttempts.set(key, recent);
    if (registrationAttempts.size > 1_000) {
      for (const [address, attempts] of registrationAttempts) {
        if (!attempts.some((attempt) => attempt > timeMs - 60 * 60 * 1000)) registrationAttempts.delete(address);
      }
    }
  }

  function recordLoginFailure(ip, timeMs) {
    const key = ip || 'unknown';
    const recent = (loginAttempts.get(key) ?? []).filter((attempt) => attempt > timeMs - 5 * 60 * 1000);
    recent.push(timeMs);
    loginAttempts.set(key, recent);
  }

  async function handle(req, res) {
    baseHeaders(req, res);
    const requestUrl = new URL(req.url ?? '/', 'http://localhost');
    const pathname = requestUrl.pathname;
    if (req.method === 'OPTIONS') {
      const origin = req.headers.origin;
      if (!origin || !origins.has(origin)) throw new HttpError(403, 'origin_not_allowed', 'This origin is not allowed.');
      return emptyResponse(res, 204, {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
      });
    }

    if (req.method === 'GET' && pathname === '/api/health') return jsonResponse(res, 200, { ok: true });

    if (req.method === 'POST' && (pathname === '/api/auth/register' || pathname === '/api/auth/login')) {
      const body = await readJson(req, 16 * 1024);
      if (!isPlainJsonObject(body)) throw new HttpError(400, 'invalid_request', 'Send a JSON object.');
      const email = validateEmail(body.email);
      const password = validatePassword(body.password, { registering: pathname.endsWith('/register') });
      const isRegister = pathname.endsWith('/register');
      const time = currentTime();
      if (!isRegister) checkLoginLimit(req.socket.remoteAddress, time.getTime());
      else checkRegistrationLimit(req.socket.remoteAddress, time.getTime());

      if (isRegister) {
        const salt = randomBytes(16);
        const passwordHash = Buffer.from(await scrypt(password, salt, 64, SCRYPT_OPTIONS)).toString('hex');
        const token = randomBytes(32).toString('base64url');
        const userId = randomUUID();
        const expiresAt = isoDate(new Date(time.getTime() + TOKEN_LIFETIME_MS));
        await transact((database) => {
          if (database.users.some((entry) => entry.email === email)) throw new HttpError(409, 'account_exists', 'An account already exists for this email.');
          database.sessions = database.sessions.filter((entry) => parseIsoMs(entry.expiresAt) > time.getTime());
          const updatedAt = null;
          const state = emptyState();
          const user = {
            id: userId,
            email,
            passwordSalt: salt.toString('hex'),
            passwordHash,
            createdAt: isoDate(time),
            sync: {
              revision: 0,
              state,
              updatedAt,
              snapshots: [{ revision: 0, state: cloneJson(state), updatedAt, operationId: null }],
              history: [],
              operations: [],
              tombstones: [],
            },
          };
          database.users.push(user);
          database.sessions.push({ id: randomUUID(), userId, tokenHash: hash(token), createdAt: isoDate(time), expiresAt });
        });
        return jsonResponse(res, 201, { token, tokenType: 'Bearer', expiresAt, user: { id: userId, email } });
      }

      const user = store.users.find((entry) => entry.email === email);
      const salt = user ? Buffer.from(user.passwordSalt, 'hex') : DUMMY_SALT;
      const correctHash = user ? user.passwordHash : dummyPasswordHash;
      const actualHash = Buffer.from(await scrypt(password, salt, 64, SCRYPT_OPTIONS)).toString('hex');
      if (!user || !sameSecret(actualHash, correctHash)) {
        recordLoginFailure(req.socket.remoteAddress, time.getTime());
        throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect.');
      }
      const token = randomBytes(32).toString('base64url');
      const expiresAt = isoDate(new Date(time.getTime() + TOKEN_LIFETIME_MS));
      await transact((database) => {
        const currentUser = database.users.find((entry) => entry.id === user.id);
        if (!currentUser) throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect.');
        database.sessions = database.sessions.filter((entry) => parseIsoMs(entry.expiresAt) > time.getTime());
        database.sessions.push({ id: randomUUID(), userId: currentUser.id, tokenHash: hash(token), createdAt: isoDate(time), expiresAt });
      });
      loginAttempts.delete(req.socket.remoteAddress || 'unknown');
      return jsonResponse(res, 200, { token, tokenType: 'Bearer', expiresAt, user: { id: user.id, email: user.email } });
    }

    if (pathname.startsWith('/api/')) {
      const time = currentTime();
      const { user: authenticatedUser } = requireAuth(req, store, time);

      if (req.method === 'POST' && pathname === '/api/auth/logout') {
        await transact((database) => {
          requireAuth(req, database, time);
          const token = /^Bearer ([A-Za-z0-9_-]{40,60})$/.exec(String(req.headers.authorization ?? ''))?.[1];
          const tokenHash = hash(token);
          database.sessions = database.sessions.filter((entry) => !sameSecret(entry.tokenHash, tokenHash));
        });
        return emptyResponse(res, 204);
      }

      if (req.method === 'GET' && pathname === '/api/sync') {
        const user = store.users.find((entry) => entry.id === authenticatedUser.id);
        return jsonResponse(res, 200, publicSnapshot(user.sync));
      }

      if (req.method === 'PUT' && pathname === '/api/sync') {
        const body = await readJson(req);
        if (!isPlainJsonObject(body)) throw new HttpError(400, 'invalid_request', 'Send a JSON object.');
        const baseRevision = validateRevision(body.baseRevision);
        const operationId = validateOperationId(body.operationId);
        const state = validateState(body.state);
        const requestHash = hash(stableStringify({ baseRevision, state }));
        const time = currentTime();
        const response = await transact((database) => {
          const { user } = requireAuth(req, database, time);
          const sync = user.sync;
          pruneSync(sync, time.getTime());
          const prior = sync.operations.find((entry) => entry.id === operationId);
          if (prior) {
            if (prior.requestHash !== requestHash || prior.kind !== 'sync') {
              throw new HttpError(409, 'idempotency_key_reused', 'operationId was already used for a different request.');
            }
            return { ...publicSnapshot(sync), conflicts: [], duplicate: true, operationRevision: prior.revision };
          }
          if (baseRevision > sync.revision) throw snapshotError(sync, 'base_revision_ahead', 'baseRevision is ahead of the server revision.');
          const base = snapshotExists(sync, baseRevision);
          if (!base) throw snapshotError(sync, 'base_revision_expired', 'The server no longer has this base revision. Pull current state and review before retrying.');
          if (sync.operations.length >= MAX_OPERATIONS) throw new HttpError(507, 'idempotency_capacity_reached', 'The recent operation record is at capacity; wait for older entries to expire before syncing more changes.');
          const conflicts = [];
          const merged = mergeNode(true, base.state, true, sync.state, true, state, [], {
            now: time,
            baseRevision,
            serverRevision: sync.revision,
            serverOperationId: snapshotExists(sync, sync.revision)?.operationId ?? null,
            resolvedRevision: sync.revision + 1,
            operationId,
          }, conflicts);
          if (conflicts.length > MAX_CONFLICTS_PER_OPERATION) {
            throw new HttpError(413, 'too_many_conflicts', 'This change contains too many overlapping edits to record safely. Pull the current state and retry with a reviewed merge.');
          }
          const nextState = validateState(merged.value);
          const hasChange = !sameValue(true, nextState, true, sync.state);
          if (hasChange || conflicts.length > 0) {
            if (sync.history.length + conflicts.length > MAX_HISTORY_ENTRIES) {
              throw new HttpError(507, 'history_capacity_reached', 'Conflict history is at capacity; wait for older entries to expire before syncing more conflicts.');
            }
            const previousState = sync.state;
            sync.revision += 1;
            sync.state = nextState;
            sync.updatedAt = isoDate(time);
            updateTombstones(sync, previousState, nextState, sync.revision, time);
            sync.snapshots.push({ revision: sync.revision, state: cloneJson(nextState), updatedAt: sync.updatedAt, operationId });
            sync.history.push(...conflicts.map(cleanConflict));
            pruneSync(sync, time.getTime());
          }
          sync.operations.push({ id: operationId, kind: 'sync', requestHash, revision: sync.revision, createdAt: isoDate(time) });
          pruneSync(sync, time.getTime());
          return { ...publicSnapshot(sync), conflicts: conflicts.map(cleanConflict), operationRevision: sync.revision };
        });
        return jsonResponse(res, 200, response);
      }

      if (req.method === 'GET' && pathname === '/api/sync/history') {
        const user = store.users.find((entry) => entry.id === authenticatedUser.id);
        const nowMs = time.getTime();
        const active = user.sync.history.filter((entry) => parseIsoMs(entry.expiresAt) >= nowMs).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const limitParam = Number(requestUrl.searchParams.get('limit') ?? '100');
        const limit = Number.isInteger(limitParam) ? Math.max(1, Math.min(100, limitParam)) : 100;
        const before = requestUrl.searchParams.get('before');
        const startIndex = before ? active.findIndex((entry) => entry.id === before) + 1 : 0;
        const safeStart = startIndex < 0 ? active.length : startIndex;
        const history = active.slice(safeStart, safeStart + limit).map(cleanConflict);
        return jsonResponse(res, 200, { history, hasMore: safeStart + history.length < active.length });
      }

      if (req.method === 'POST' && pathname === '/api/sync/restore') {
        const body = await readJson(req);
        if (!isPlainJsonObject(body)) throw new HttpError(400, 'invalid_request', 'Send a JSON object.');
        if (typeof body.historyId !== 'string' || body.historyId.length > 100) throw new HttpError(400, 'invalid_history_id', 'historyId is invalid.');
        const baseRevision = validateRevision(body.baseRevision);
        const operationId = validateOperationId(body.operationId);
        const versionName = body.version;
        const selectedName = versionName === 'losing' || versionName === 'incoming' ? 'incoming'
          : versionName === 'winning' || versionName === 'server' ? 'server' : null;
        if (!selectedName) throw new HttpError(400, 'invalid_history_version', 'version must be losing or winning.');
        const requestHash = hash(stableStringify({ historyId: body.historyId, baseRevision, selectedName }));
        const time = currentTime();
        const restored = await transact((database) => {
          const { user } = requireAuth(req, database, time);
          const sync = user.sync;
          pruneSync(sync, time.getTime());
          const prior = sync.operations.find((entry) => entry.id === operationId);
          if (prior) {
            if (prior.requestHash !== requestHash || prior.kind !== 'restore') throw new HttpError(409, 'idempotency_key_reused', 'operationId was already used for a different request.');
            return { ...publicSnapshot(sync), conflicts: [], duplicate: true, operationRevision: prior.revision };
          }
          if (baseRevision !== sync.revision) throw snapshotError(sync, 'revision_changed', 'The server changed since this history was opened. Pull current state and review again.');
          if (sync.operations.length >= MAX_OPERATIONS) throw new HttpError(507, 'idempotency_capacity_reached', 'The recent operation record is at capacity; wait for older entries to expire before syncing more changes.');
          const entry = sync.history.find((item) => item.id === body.historyId && parseIsoMs(item.expiresAt) >= time.getTime());
          if (!entry) throw new HttpError(404, 'history_not_found', 'This history entry is no longer available.');
          const version = entry[selectedName];
          const restoredState = assignAtPath(cloneJson(sync.state), entry.path, version);
          const nextState = validateState(restoredState);
          const changed = !sameValue(true, nextState, true, sync.state);
          if (changed) {
            const previousState = sync.state;
            sync.revision += 1;
            sync.state = nextState;
            sync.updatedAt = isoDate(time);
            updateTombstones(sync, previousState, nextState, sync.revision, time);
            sync.snapshots.push({ revision: sync.revision, state: cloneJson(nextState), updatedAt: sync.updatedAt, operationId });
          }
          sync.operations.push({ id: operationId, kind: 'restore', requestHash, revision: sync.revision, createdAt: isoDate(time) });
          pruneSync(sync, time.getTime());
          return { ...publicSnapshot(sync), conflicts: [], operationRevision: sync.revision };
        });
        return jsonResponse(res, 200, restored);
      }
    }

    throw new HttpError(404, 'not_found', 'No endpoint exists at this path.');
  }

  return createServer((req, res) => {
    handle(req, res).catch((error) => sendError(res, error));
  });
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('PORT must be an integer from 0 to 65535.');
    process.exitCode = 1;
  } else {
    const server = await createSyncServer();
    server.listen(port, host, () => {
      const address = server.address();
      console.info(`Tempo sync API listening on http://${host}:${address.port}`);
    });
    const shutdown = () => server.close(() => process.exit(0));
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }
}
