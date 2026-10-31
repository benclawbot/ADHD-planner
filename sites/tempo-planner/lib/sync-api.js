import {
  cloneJson,
  emptyState,
  mergeState,
  restoreConflict,
  sha256,
  stableStringify,
  SyncError,
  SYNC_LIMITS,
  updateTombstones,
  validateState,
} from "./sync-core.js";

const MAX_BODY_BYTES = 1024 * 1024;
const RETRY_LIMIT = 5;

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 120;

const rateLimitBuckets = new Map();

function rateLimitKey(request) {
  const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "")?.[1];
  return token ?? "anonymous";
}

function checkRateLimit(key, now = Date.now()) {
  const bucket = rateLimitBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true, retryAfterMs: 0 };
  }
  bucket.count += 1;
  if (bucket.count > RATE_LIMIT_MAX) {
    return { allowed: false, retryAfterMs: bucket.resetAt - now };
  }
  return { allowed: true, retryAfterMs: 0 };
}

function json(body, status = 200, headers = {}) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...headers,
    },
  });
}

function fail(status, code, message, details, headers) {
  const error = { code, message };
  if (details !== undefined) error.details = details;
  return json({ error }, status, headers);
}

export function apiErrorResponse(error) {
  if (error instanceof SyncError) {
    const headers = error.status === 429 && error.details?.retryAfterMs != null
      ? { "Retry-After": String(Math.ceil(error.details.retryAfterMs / 1000)) }
      : undefined;
    return fail(error.status, error.code, error.message, error.details, headers);
  }
  return fail(500, "internal_error", "The sync request could not be completed.");
}

async function readJson(request) {
  const contentType = (request.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw new SyncError(415, "json_required", "Send a JSON request body.");
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new SyncError(413, "body_too_large", "The request body is too large.");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES) throw new SyncError(413, "body_too_large", "The request body is too large.");
  if (bytes.byteLength === 0) throw new SyncError(400, "invalid_json", "The request body must contain JSON.");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new SyncError(400, "invalid_json", "The request body must contain valid JSON.");
  }
}

const SHARED_USER_ID = "tempo-shared-planner-v1";

function constantTimeHexEqual(left, right) {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  let difference = 0;
  for (let index = 0; index < 64; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export async function authorizeSharedCapability(request, expectedDigest) {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "");
  if (!match || typeof expectedDigest !== "string") return false;
  return constantTimeHexEqual(await sha256(match[1]), expectedDigest.toLowerCase());
}

function validateObject(value, message = "Send a JSON object.") {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new SyncError(400, "invalid_request", message);
  }
  return value;
}

function validateRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new SyncError(400, "invalid_revision", "baseRevision must be a non-negative integer.");
  return value;
}

function validateOperationId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
    throw new SyncError(400, "invalid_operation_id", "operationId must contain 8 to 128 safe characters.");
  }
  return value;
}

function snapshotError(snapshot, code, message) {
  throw new SyncError(409, code, message, publicSnapshot(snapshot));
}

function publicSnapshot(snapshot) {
  return {
    revision: snapshot.revision,
    state: cloneJson(snapshot.state),
    updatedAt: snapshot.updatedAt,
    tombstones: cloneJson(snapshot.tombstones ?? []),
  };
}

function sameState(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function operationResponse(snapshot, prior) {
  return {
    ...publicSnapshot(snapshot),
    conflicts: [],
    duplicate: true,
    operationRevision: prior.revision,
  };
}

async function findDuplicate(repository, userId, operationId, kind, requestHash) {
  const prior = await repository.getOperation(userId, operationId);
  if (!prior) return null;
  if (prior.requestHash !== requestHash || prior.kind !== kind) {
    throw new SyncError(409, "idempotency_key_reused", "operationId was already used for a different request.");
  }
  return operationResponse(await repository.getSnapshot(userId), prior);
}

function snapshotAt(current, state, revision, updatedAt, tombstones, operationId) {
  return { revision, state, updatedAt, tombstones, operationId };
}

export async function handleSessionRequest(request, expectedDigest) {
  try {
    if (!await authorizeSharedCapability(request, expectedDigest)) throw new SyncError(401, "invalid_shared_link", "Open Tempo using the shared planner link to sync.");
    return json({ user: { id: SHARED_USER_ID, displayName: "Shared planner" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function handleSyncRequest(request, repository, expectedDigest, now = new Date()) {
  try {
    const limit = checkRateLimit(rateLimitKey(request), now.getTime());
    if (!limit.allowed) {
      throw new SyncError(429, "rate_limited", "Too many sync requests. Please wait before trying again.", { retryAfterMs: limit.retryAfterMs });
    }
    if (!await authorizeSharedCapability(request, expectedDigest)) throw new SyncError(401, "invalid_shared_link", "Open Tempo using the shared planner link to sync.");
    const authorizedRepository = typeof repository === "function" ? repository() : repository;
    const syncRepository = await authorizedRepository;
    const url = new URL(request.url);
    const userId = SHARED_USER_ID;

    if (request.method === "GET" && url.pathname === "/api/sync") {
      return json(publicSnapshot(await syncRepository.getSnapshot(userId)));
    }

    if (request.method === "PUT" && url.pathname === "/api/sync") {
      const body = validateObject(await readJson(request));
      const baseRevision = validateRevision(body.baseRevision);
      const operationId = validateOperationId(body.operationId);
      const incomingState = validateState(body.state);
      const requestHash = await sha256(stableStringify({ baseRevision, state: incomingState }));
      const duplicate = await findDuplicate(syncRepository, userId, operationId, "sync", requestHash);
      if (duplicate) return json(duplicate);

      for (let attempt = 0; attempt < RETRY_LIMIT; attempt += 1) {
        const server = await syncRepository.getSnapshot(userId);
        if (baseRevision > server.revision) snapshotError(server, "base_revision_ahead", "baseRevision is ahead of the server revision.");
        const base = await syncRepository.getSnapshotAt(userId, baseRevision);
        if (!base) snapshotError(server, "base_revision_expired", "The server no longer has this base revision. Pull current state and review before retrying.");

        const existingOperation = await syncRepository.getOperation(userId, operationId);
        if (existingOperation) {
          const retryDuplicate = await findDuplicate(syncRepository, userId, operationId, "sync", requestHash);
          if (retryDuplicate) return json(retryDuplicate);
        }
        if (await syncRepository.countOperations(userId, now) >= SYNC_LIMITS.maxOperations) {
          throw new SyncError(507, "idempotency_capacity_reached", "Recent idempotency records are at capacity; wait for older records to expire before syncing more changes.");
        }

        const merged = mergeState(base.state, server.state, incomingState, {
          now,
          baseRevision,
          serverRevision: server.revision,
          serverOperationId: server.operationId,
          operationId,
        });
        const changed = !sameState(merged.state, server.state) || merged.conflicts.length > 0;
        if (merged.conflicts.length && await syncRepository.countHistory(userId, now) + merged.conflicts.length > SYNC_LIMITS.maxHistoryEntries) {
          throw new SyncError(507, "history_capacity_reached", "Conflict history is at capacity; wait for older entries to expire before syncing more conflicts.");
        }

        const revision = changed ? server.revision + 1 : server.revision;
        const updatedAt = changed ? now.toISOString() : server.updatedAt;
        const tombstones = changed
          ? updateTombstones(server.tombstones, server.state, merged.state, revision, now)
          : server.tombstones;
        const resultSnapshot = snapshotAt(server, merged.state, revision, updatedAt, tombstones, operationId);
        const commit = await syncRepository.commit({
          userId,
          expectedRevision: server.revision,
          snapshot: resultSnapshot,
          operation: { id: operationId, kind: "sync", requestHash, revision, createdAt: now.toISOString() },
          conflicts: merged.conflicts,
          changed,
          now,
        });
        if (commit.committed) {
          return json({
            ...publicSnapshot(commit.snapshot),
            conflicts: merged.conflicts,
            operationRevision: revision,
          });
        }

        const retryDuplicate = await findDuplicate(syncRepository, userId, operationId, "sync", requestHash);
        if (retryDuplicate) return json(retryDuplicate);
      }
      throw new SyncError(503, "sync_busy", "Another device saved changes at the same time. Tempo will retry against the latest copy.");
    }

    if (request.method === "GET" && url.pathname === "/api/sync/history") {
      const nowIso = now.toISOString();
      const limitValue = Number(url.searchParams.get("limit") ?? "100");
      const limit = Number.isInteger(limitValue) ? Math.max(1, Math.min(100, limitValue)) : 100;
      const before = url.searchParams.get("before");
      const page = await syncRepository.listHistory(userId, { before, limit: limit + 1, nowIso });
      return json({ history: page.slice(0, limit), hasMore: page.length > limit });
    }

    if (request.method === "POST" && url.pathname === "/api/sync/restore") {
      const body = validateObject(await readJson(request));
      if (typeof body.historyId !== "string" || !body.historyId || body.historyId.length > 100) {
        throw new SyncError(400, "invalid_history_id", "historyId is invalid.");
      }
      const baseRevision = validateRevision(body.baseRevision);
      const operationId = validateOperationId(body.operationId);
      const selectedName = body.version === "losing" || body.version === "incoming" ? "incoming"
        : body.version === "winning" || body.version === "server" ? "server" : null;
      if (!selectedName) throw new SyncError(400, "invalid_history_version", "version must be losing or winning.");
      const requestHash = await sha256(stableStringify({ historyId: body.historyId, baseRevision, selectedName }));
      const duplicate = await findDuplicate(syncRepository, userId, operationId, "restore", requestHash);
      if (duplicate) return json(duplicate);

      const server = await syncRepository.getSnapshot(userId);
      if (baseRevision !== server.revision) snapshotError(server, "revision_changed", "The server changed since this history was opened. Pull current state and review again.");
      if (await syncRepository.countOperations(userId, now) >= SYNC_LIMITS.maxOperations) {
        throw new SyncError(507, "idempotency_capacity_reached", "Recent idempotency records are at capacity; wait for older records to expire before syncing more changes.");
      }
      const historyEntry = await syncRepository.getHistoryEntry(userId, body.historyId, now.toISOString());
      if (!historyEntry) throw new SyncError(404, "history_not_found", "This history entry is no longer available.");

      const restoredState = restoreConflict(server.state, historyEntry, selectedName);
      const changed = !sameState(restoredState, server.state);
      const revision = changed ? server.revision + 1 : server.revision;
      const updatedAt = changed ? now.toISOString() : server.updatedAt;
      const tombstones = changed
        ? updateTombstones(server.tombstones, server.state, restoredState, revision, now)
        : server.tombstones;
      const resultSnapshot = snapshotAt(server, restoredState, revision, updatedAt, tombstones, operationId);
      const commit = await syncRepository.commit({
        userId,
        expectedRevision: server.revision,
        snapshot: resultSnapshot,
        operation: { id: operationId, kind: "restore", requestHash, revision, createdAt: now.toISOString() },
        conflicts: [],
        changed,
        now,
      });
      if (!commit.committed) {
        const retryDuplicate = await findDuplicate(syncRepository, userId, operationId, "restore", requestHash);
        if (retryDuplicate) return json(retryDuplicate);
        snapshotError(await syncRepository.getSnapshot(userId), "revision_changed", "The server changed since this history was opened. Pull current state and review again.");
      }
      return json({ ...publicSnapshot(commit.snapshot), conflicts: [], operationRevision: revision });
    }

    throw new SyncError(404, "not_found", "No endpoint exists at this path.");
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export function createEmptySyncSnapshot() {
  const state = emptyState();
  return { revision: 0, state, updatedAt: null, tombstones: [], operationId: null };
}
