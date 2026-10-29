import { emptyState } from "./sync-core.js";

type Tombstone = {
  collection: "tasks" | "captures";
  id: string;
  revision: number;
  deletedAt: string;
};

type Snapshot = {
  revision: number;
  state: Record<string, unknown>;
  updatedAt: string | null;
  tombstones: Tombstone[];
  operationId: string | null;
};

type Operation = {
  id: string;
  kind: "sync" | "restore";
  requestHash: string;
  revision: number;
  createdAt: string;
};

type CommitInput = {
  userId: string;
  expectedRevision: number;
  snapshot: Snapshot;
  operation: Operation;
  conflicts: Array<Record<string, unknown>>;
  changed: boolean;
  now: Date;
};

type D1StatementLike = {
  bind(...values: unknown[]): D1StatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  run(): Promise<unknown>;
};

type D1DatabaseLike = {
  prepare(sql: string): D1StatementLike;
  batch(statements: D1StatementLike[]): Promise<Array<{ meta?: { changes?: number } }>>;
};

type AccountRow = {
  revision: number;
  state: string;
  updated_at: string | null;
  last_operation_id: string | null;
};

type SnapshotRow = {
  revision: number;
  state: string;
  updated_at: string | null;
  operation_id: string | null;
};

const MAX_JSON_CHUNK_BYTES = 96 * 1024;
const MAX_D1_ROW_BYTES = 2_000_000;
const MAX_SNAPSHOTS = 256;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`Stored ${label} is not valid JSON.`);
  }
}

function splitJsonRows(rows: Array<Record<string, unknown>>): string[] {
  const chunks: string[] = [];
  let current: Array<Record<string, unknown>> = [];
  let size = 2;
  for (const row of rows) {
    const rowSize = new TextEncoder().encode(JSON.stringify(row)).byteLength;
    if (rowSize > MAX_D1_ROW_BYTES) throw new Error("A single sync history record exceeds D1's 2 MB row limit.");
    if (current.length && size + rowSize + 1 > MAX_JSON_CHUNK_BYTES) {
      chunks.push(JSON.stringify(current));
      current = [];
      size = 2;
    }
    current.push(row);
    size += rowSize + 1;
  }
  if (current.length) chunks.push(JSON.stringify(current));
  return chunks;
}

export class D1SyncRepository {
  private readonly db: D1DatabaseLike;

  constructor(db: D1DatabaseLike) {
    this.db = db;
  }

  async ensureAccount(userId: string): Promise<void> {
    const initialState = JSON.stringify(emptyState());
    const createdAt = new Date().toISOString();
    await this.db.batch([
      this.db.prepare(`
        INSERT OR IGNORE INTO tempo_sync_accounts (user_id, revision, state, updated_at, last_operation_id)
        VALUES (?, 0, ?, NULL, NULL)
      `).bind(userId, initialState),
      this.db.prepare(`
        INSERT OR IGNORE INTO tempo_sync_snapshots (user_id, revision, state, updated_at, operation_id, created_at)
        SELECT user_id, revision, state, updated_at, NULL, ?
        FROM tempo_sync_accounts
        WHERE user_id = ? AND revision = 0
      `).bind(createdAt, userId),
    ]);
  }

  async getSnapshot(userId: string): Promise<Snapshot> {
    await this.ensureAccount(userId);
    const row = await this.db.prepare(`
      SELECT revision, state, updated_at, last_operation_id
      FROM tempo_sync_accounts
      WHERE user_id = ?
    `).bind(userId).first<AccountRow>();
    if (!row) throw new Error("The account snapshot could not be loaded.");
    const cutoff = new Date(Date.now() - RETENTION_MS).toISOString();
    const tombstoneRows = await this.db.prepare(`
      SELECT collection, entity_id, revision, deleted_at
      FROM tempo_sync_tombstones
      WHERE user_id = ? AND deleted_at > ?
      ORDER BY deleted_at ASC
    `).bind(userId, cutoff).all<{ collection: Tombstone["collection"]; entity_id: string; revision: number; deleted_at: string }>();
    return {
      revision: row.revision,
      state: parseJson<Record<string, unknown>>(row.state, "state"),
      updatedAt: row.updated_at,
      operationId: row.last_operation_id,
      tombstones: (tombstoneRows.results ?? []).map((entry) => ({
        collection: entry.collection,
        id: entry.entity_id,
        revision: entry.revision,
        deletedAt: entry.deleted_at,
      })),
    };
  }

  async getSnapshotAt(userId: string, revision: number): Promise<Snapshot | null> {
    await this.ensureAccount(userId);
    const row = await this.db.prepare(`
      SELECT revision, state, updated_at, operation_id
      FROM tempo_sync_snapshots
      WHERE user_id = ? AND revision = ?
    `).bind(userId, revision).first<SnapshotRow>();
    if (!row) return null;
    return {
      revision: row.revision,
      state: parseJson<Record<string, unknown>>(row.state, "snapshot"),
      updatedAt: row.updated_at,
      operationId: row.operation_id,
      tombstones: [],
    };
  }

  async getOperation(userId: string, id: string): Promise<Operation | null> {
    const row = await this.db.prepare(`
      SELECT id, kind, request_hash, revision, created_at
      FROM tempo_sync_operations
      WHERE user_id = ? AND id = ?
    `).bind(userId, id).first<{ id: string; kind: Operation["kind"]; request_hash: string; revision: number; created_at: string }>();
    return row ? {
      id: row.id,
      kind: row.kind,
      requestHash: row.request_hash,
      revision: row.revision,
      createdAt: row.created_at,
    } : null;
  }

  async countOperations(userId: string, now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - RETENTION_MS).toISOString();
    const row = await this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM tempo_sync_operations
      WHERE user_id = ? AND created_at >= ?
    `).bind(userId, cutoff).first<{ count: number }>();
    return row?.count ?? 0;
  }

  async countHistory(userId: string, now: Date): Promise<number> {
    const row = await this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM tempo_sync_history
      WHERE user_id = ? AND expires_at >= ?
    `).bind(userId, now.toISOString()).first<{ count: number }>();
    return row?.count ?? 0;
  }

  async listHistory(userId: string, options: { before: string | null; limit: number; nowIso: string }): Promise<Array<Record<string, unknown>>> {
    if (!options.before) {
      const rows = await this.db.prepare(`
        SELECT payload
        FROM tempo_sync_history
        WHERE user_id = ? AND expires_at >= ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).bind(userId, options.nowIso, options.limit).all<{ payload: string }>();
      return (rows.results ?? []).map((row) => parseJson<Record<string, unknown>>(row.payload, "history record"));
    }

    const cursor = await this.db.prepare(`
      SELECT created_at, id
      FROM tempo_sync_history
      WHERE user_id = ? AND id = ? AND expires_at >= ?
    `).bind(userId, options.before, options.nowIso).first<{ created_at: string; id: string }>();
    if (!cursor) return [];
    const rows = await this.db.prepare(`
      SELECT payload
      FROM tempo_sync_history
      WHERE user_id = ? AND expires_at >= ?
        AND (created_at < ? OR (created_at = ? AND id < ?))
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).bind(userId, options.nowIso, cursor.created_at, cursor.created_at, cursor.id, options.limit).all<{ payload: string }>();
    return (rows.results ?? []).map((row) => parseJson<Record<string, unknown>>(row.payload, "history record"));
  }

  async getHistoryEntry(userId: string, id: string, nowIso: string): Promise<Record<string, unknown> | null> {
    const row = await this.db.prepare(`
      SELECT payload
      FROM tempo_sync_history
      WHERE user_id = ? AND id = ? AND expires_at >= ?
    `).bind(userId, id, nowIso).first<{ payload: string }>();
    return row ? parseJson<Record<string, unknown>>(row.payload, "history record") : null;
  }

  async commit(input: CommitInput): Promise<{ committed: boolean; snapshot: Snapshot | null }> {
    const { userId, expectedRevision, snapshot, operation, conflicts, changed, now } = input;
    const operationInsert = () => this.db.prepare(`
      INSERT OR IGNORE INTO tempo_sync_operations (user_id, id, kind, request_hash, revision, created_at)
      SELECT ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM tempo_sync_accounts WHERE user_id = ? AND revision = ?
      )
    `).bind(userId, operation.id, operation.kind, operation.requestHash, operation.revision, operation.createdAt, userId, expectedRevision);

    if (!changed) {
      const results = await this.db.batch([operationInsert()]);
      if ((results[0]?.meta?.changes ?? 0) !== 1) return { committed: false, snapshot: null };
      return { committed: true, snapshot: await this.getSnapshot(userId) };
    }

    const nowIso = now.toISOString();
    const cutoff = new Date(now.getTime() - RETENTION_MS).toISOString();
    const newRevision = snapshot.revision;
    const commitToken = globalThis.crypto.randomUUID();
    const guardUser = userId;
    const guardRevision = newRevision;
    const guardOperation = operation.id;
    const guardCommitToken = commitToken;
    const guard = `EXISTS (
      SELECT 1 FROM tempo_sync_accounts
      WHERE user_id = ? AND revision = ? AND last_operation_id = ? AND last_commit_token = ?
    )`;
    const statements: D1StatementLike[] = [
      this.db.prepare(`
        UPDATE tempo_sync_accounts
        SET revision = ?, state = ?, updated_at = ?, last_operation_id = ?, last_commit_token = ?
        WHERE user_id = ? AND revision = ?
          AND NOT EXISTS (
            SELECT 1 FROM tempo_sync_operations
            WHERE user_id = ? AND id = ?
          )
      `).bind(newRevision, JSON.stringify(snapshot.state), snapshot.updatedAt, operation.id, commitToken, userId, expectedRevision, userId, operation.id),
      this.db.prepare(`
        INSERT INTO tempo_sync_snapshots (user_id, revision, state, updated_at, operation_id, created_at)
        SELECT ?, ?, ?, ?, ?, ?
        WHERE ${guard}
      `).bind(userId, newRevision, JSON.stringify(snapshot.state), snapshot.updatedAt, operation.id, nowIso, guardUser, guardRevision, guardOperation, guardCommitToken),
    ];

    for (const chunk of splitJsonRows(conflicts)) {
      statements.push(this.db.prepare(`
        INSERT INTO tempo_sync_history (id, user_id, payload, created_at, expires_at)
        SELECT json_extract(value, '$.id'), ?, value,
          json_extract(value, '$.createdAt'), json_extract(value, '$.expiresAt')
        FROM json_each(?)
        WHERE ${guard}
      `).bind(userId, chunk, guardUser, guardRevision, guardOperation, guardCommitToken));
    }

    statements.push(this.db.prepare(`
      DELETE FROM tempo_sync_tombstones
      WHERE user_id = ? AND ${guard}
    `).bind(userId, guardUser, guardRevision, guardOperation, guardCommitToken));

    for (const chunk of splitJsonRows(snapshot.tombstones as unknown as Array<Record<string, unknown>>)) {
      statements.push(this.db.prepare(`
        INSERT OR REPLACE INTO tempo_sync_tombstones (user_id, collection, entity_id, revision, deleted_at)
        SELECT ?, json_extract(value, '$.collection'), json_extract(value, '$.id'),
          json_extract(value, '$.revision'), json_extract(value, '$.deletedAt')
        FROM json_each(?)
        WHERE ${guard}
      `).bind(userId, chunk, guardUser, guardRevision, guardOperation, guardCommitToken));
    }

    statements.push(this.db.prepare(`
      INSERT OR IGNORE INTO tempo_sync_operations (user_id, id, kind, request_hash, revision, created_at)
      SELECT ?, ?, ?, ?, ?, ?
      WHERE ${guard}
    `).bind(userId, operation.id, operation.kind, operation.requestHash, operation.revision, operation.createdAt, guardUser, guardRevision, guardOperation, guardCommitToken));
    statements.push(this.db.prepare(`
      DELETE FROM tempo_sync_snapshots
      WHERE user_id = ? AND revision != ? AND (
        created_at < ? OR revision NOT IN (
          SELECT revision FROM tempo_sync_snapshots
          WHERE user_id = ? ORDER BY revision DESC LIMIT ${MAX_SNAPSHOTS}
        )
      ) AND ${guard}
    `).bind(userId, newRevision, cutoff, userId, guardUser, guardRevision, guardOperation, guardCommitToken));
    statements.push(this.db.prepare(`
      DELETE FROM tempo_sync_history WHERE user_id = ? AND expires_at < ? AND ${guard}
    `).bind(userId, nowIso, guardUser, guardRevision, guardOperation, guardCommitToken));
    statements.push(this.db.prepare(`
      DELETE FROM tempo_sync_operations WHERE user_id = ? AND created_at < ? AND ${guard}
    `).bind(userId, cutoff, guardUser, guardRevision, guardOperation, guardCommitToken));
    statements.push(this.db.prepare(`
      DELETE FROM tempo_sync_tombstones WHERE user_id = ? AND deleted_at <= ? AND ${guard}
    `).bind(userId, cutoff, guardUser, guardRevision, guardOperation, guardCommitToken));

    const results = await this.db.batch(statements);
    if ((results[0]?.meta?.changes ?? 0) !== 1) return { committed: false, snapshot: null };
    return { committed: true, snapshot: await this.getSnapshot(userId) };
  }
}
