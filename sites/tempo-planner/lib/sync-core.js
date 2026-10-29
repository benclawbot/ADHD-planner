const MAX_STATE_BYTES = 512 * 1024;
const MAX_ENTITIES = 20_000;
const MAX_CONFLICTS_PER_OPERATION = 1_000;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export class SyncError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "SyncError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlainRecord(value) {
  return isRecord(value) && Object.getPrototypeOf(value) === Object.prototype;
}

export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameValue(leftExists, left, rightExists, right) {
  if (leftExists !== rightExists) return false;
  if (!leftExists) return true;
  return stableStringify(left) === stableStringify(right);
}

function validateJsonTree(value, path = []) {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) validateJsonTree(value[index], [...path, index]);
    return;
  }
  if (isRecord(value)) {
    if (!isPlainRecord(value)) throw new SyncError(400, "invalid_state", "State values must be plain JSON objects.");
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) throw new SyncError(400, "invalid_state", "State contains a disallowed property name.");
      validateJsonTree(child, [...path, key]);
    }
    return;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  throw new SyncError(400, "invalid_state", "State must contain JSON values only.");
}

export function emptyState() {
  return { schema: 1, tasks: [], captures: [], focus: null, settings: {} };
}

export function validateState(rawState) {
  if (!isPlainRecord(rawState)) throw new SyncError(400, "invalid_state", "State must be a JSON object.");
  validateJsonTree(rawState);
  if (rawState.schema !== 1 || !Array.isArray(rawState.tasks) || !Array.isArray(rawState.captures)) {
    throw new SyncError(400, "invalid_state", "State must include schema 1, tasks, and captures.");
  }
  if (rawState.tasks.length + rawState.captures.length > MAX_ENTITIES) {
    throw new SyncError(413, "too_many_entities", "State contains too many tasks or captures.");
  }
  for (const [collection, entities] of [["tasks", rawState.tasks], ["captures", rawState.captures]]) {
    const ids = new Set();
    for (const entity of entities) {
      if (!isPlainRecord(entity) || typeof entity.id !== "string" || entity.id.length < 1 || entity.id.length > 200) {
        throw new SyncError(400, "invalid_state", `${collection} entries need a stable string id.`);
      }
      if (ids.has(entity.id)) throw new SyncError(400, "invalid_state", `${collection} contains duplicate ids.`);
      ids.add(entity.id);
    }
  }
  const state = cloneJson(rawState);
  if (new TextEncoder().encode(JSON.stringify(state)).byteLength > MAX_STATE_BYTES) {
    throw new SyncError(413, "state_too_large", "State exceeds the 512 KiB limit.");
  }
  return state;
}

function pathLabel(pathParts) {
  return pathParts.map((part, index) => {
    if (part.entityId !== undefined) return `[${JSON.stringify(part.entityId)}]`;
    return index === 0 ? part.key : `.${part.key}`;
  }).join("");
}

function encodeVersion(exists, value, extra = {}) {
  return exists ? { exists: true, value: cloneJson(value), ...extra } : { exists: false, ...extra };
}

function createConflict(pathParts, baseExists, baseValue, serverExists, serverValue, incomingExists, incomingValue, context) {
  const createdAt = context.now.toISOString();
  return {
    id: crypto.randomUUID(),
    path: pathParts.map((part) => ({ ...part })),
    label: pathLabel(pathParts),
    createdAt,
    expiresAt: new Date(context.now.getTime() + context.historyRetentionMs).toISOString(),
    winner: "server",
    policy: "server_revision_wins",
    resolvedRevision: context.serverRevision + 1,
    base: encodeVersion(baseExists, baseValue, { revision: context.baseRevision }),
    server: encodeVersion(serverExists, serverValue, { revision: context.serverRevision, operationId: context.serverOperationId }),
    incoming: encodeVersion(incomingExists, incomingValue, { operationId: context.operationId }),
  };
}

function sameSequence(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
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
    const isDeleted = (exists, item) => !exists || item?.status === "removed";
    const baseDeleted = isDeleted(baseExists, baseItem);
    const serverDeleted = isDeleted(serverExists, serverItem);
    const incomingDeleted = isDeleted(incomingExists, incomingItem);

    if (!baseDeleted && serverDeleted && incomingDeleted) {
      if (serverExists) mergedMap.set(id, cloneJson(serverItem));
      continue;
    }

    const serverHasNewerDelete = !baseDeleted && serverDeleted && !incomingDeleted
      && !sameValue(true, incomingItem, true, baseItem);
    const incomingDeleteAgainstServerEdit = !baseDeleted && incomingDeleted && !serverDeleted
      && !sameValue(true, serverItem, true, baseItem);
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
      baseExists, baseItem, serverExists, serverItem, incomingExists, incomingItem,
      [...pathParts, { entityId: id }], context, conflicts,
    );
    if (merged.exists) mergedMap.set(id, merged.value);
  }

  const common = base.map((entry) => entry.id).filter((id) => mergedMap.has(id) && serverMap.has(id) && incomingMap.has(id));
  const commonSet = new Set(common);
  const serverOrder = server.map((entry) => entry.id).filter((id) => commonSet.has(id));
  const incomingOrder = incoming.map((entry) => entry.id).filter((id) => commonSet.has(id));
  const serverReordered = !sameSequence(serverOrder, common);
  const incomingReordered = !sameSequence(incomingOrder, common);

  if (serverReordered && incomingReordered && !sameSequence(serverOrder, incomingOrder)) {
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

function mergeNode(baseExists, baseValue, serverExists, serverValue, incomingExists, incomingValue, pathParts, context, conflicts) {
  if (sameValue(incomingExists, incomingValue, baseExists, baseValue)) return { exists: serverExists, value: serverExists ? cloneJson(serverValue) : undefined };
  if (sameValue(serverExists, serverValue, baseExists, baseValue)) return { exists: incomingExists, value: incomingExists ? cloneJson(incomingValue) : undefined };
  if (sameValue(serverExists, serverValue, incomingExists, incomingValue)) return { exists: serverExists, value: serverExists ? cloneJson(serverValue) : undefined };

  const lastPath = pathParts.at(-1);
  const collectionKey = pathParts.length === 1 && lastPath?.key;
  if (serverExists && incomingExists && Array.isArray(serverValue) && Array.isArray(incomingValue)
      && Array.isArray(baseValue) && (collectionKey === "tasks" || collectionKey === "captures")) {
    return { exists: true, value: mergeEntityArray(baseValue, serverValue, incomingValue, pathParts, context, conflicts) };
  }

  const canMergeObjects = serverExists && incomingExists && isPlainRecord(serverValue) && isPlainRecord(incomingValue)
    && (!baseExists || isPlainRecord(baseValue));
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

export function mergeState(baseState, serverState, incomingState, context) {
  const conflicts = [];
  const merged = mergeNode(true, baseState, true, serverState, true, incomingState, [], {
    ...context,
    historyRetentionMs: context.historyRetentionMs ?? 30 * 24 * 60 * 60 * 1000,
  }, conflicts);
  if (conflicts.length > MAX_CONFLICTS_PER_OPERATION) {
    throw new SyncError(413, "too_many_conflicts", "This change contains too many overlapping edits to record safely. Pull the current state and retry with a reviewed merge.");
  }
  return { state: validateState(merged.value), conflicts };
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

export function restoreConflict(currentState, conflict, versionName) {
  const version = conflict[versionName];
  if (!version || typeof version.exists !== "boolean") throw new SyncError(400, "invalid_history_version", "The selected conflict version is invalid.");
  return validateState(assignAtPath(cloneJson(currentState), conflict.path, version));
}

export function updateTombstones(existing, previousState, nextState, revision, now) {
  const keyed = new Map((existing ?? []).map((entry) => [`${entry.collection}\u0000${entry.id}`, cloneJson(entry)]));
  for (const collection of ["tasks", "captures"]) {
    const before = new Map((previousState?.[collection] ?? []).map((entry) => [entry.id, entry]));
    const after = new Map((nextState?.[collection] ?? []).map((entry) => [entry.id, entry]));
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      const wasDeleted = !before.has(id) || before.get(id)?.status === "removed";
      const isDeleted = !after.has(id) || after.get(id)?.status === "removed";
      const key = `${collection}\u0000${id}`;
      if (isDeleted && (!wasDeleted || !keyed.has(key))) {
        keyed.set(key, { collection, id, revision, deletedAt: now.toISOString() });
      } else if (!isDeleted) {
        keyed.delete(key);
      }
    }
  }
  const cutoff = now.getTime() - 30 * 24 * 60 * 60 * 1000;
  return [...keyed.values()].filter((entry) => Date.parse(entry.deletedAt) > cutoff);
}

export const SYNC_LIMITS = {
  maxConflictsPerOperation: MAX_CONFLICTS_PER_OPERATION,
  maxHistoryEntries: 10_000,
  maxOperations: 10_000,
  maxSnapshots: 256,
  retentionMs: 30 * 24 * 60 * 60 * 1000,
};
