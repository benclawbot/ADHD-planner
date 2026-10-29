import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { D1SyncRepository } from "../lib/d1-sync-repository.ts";
import { emptyState } from "../lib/sync-core.js";

class SqliteStatement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.values) ?? null;
  }

  async all() {
    return { results: this.database.prepare(this.sql).all(...this.values) };
  }

  async run() {
    return this.database.prepare(this.sql).run(...this.values);
  }
}

class SqliteD1 {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new SqliteStatement(this.database, sql);
  }

  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.database.prepare(statement.sql).run(...statement.values));
      this.database.exec("COMMIT");
      return results.map((result) => ({ meta: { changes: Number(result.changes) } }));
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

async function makeRepository() {
  const database = new DatabaseSync(":memory:");
  const migration = await readFile(new URL("../drizzle/0000_next_scarlet_spider.sql", import.meta.url), "utf8");
  database.exec(migration);
  database.exec(await readFile(new URL("../drizzle/0001_sync_commit_guard.sql", import.meta.url), "utf8"));
  const repository = new D1SyncRepository(new SqliteD1(database));
  return { repository, database };
}

function commitInput({ snapshot, operationHash, changed, state, revision = 0 }) {
  const userId = "sites-user-1";
  const now = new Date("2026-10-29T12:00:00.000Z");
  const operation = {
    id: "same-op-id-0001",
    kind: "sync",
    requestHash: operationHash,
    revision,
    createdAt: now.toISOString(),
  };
  return {
    userId,
    expectedRevision: 0,
    snapshot: {
      ...snapshot,
      revision,
      state,
      updatedAt: changed ? now.toISOString() : snapshot.updatedAt,
      operationId: changed ? operation.id : snapshot.operationId,
    },
    operation,
    conflicts: [],
    changed,
    now,
  };
}

test("D1 commit rejects a changed request when the same key already won as an unchanged operation", async () => {
  const { repository, database } = await makeRepository();
  try {
    const userId = "sites-user-1";
    const initial = await repository.getSnapshot(userId);
    const nextState = { ...emptyState(), tasks: [{ id: "task-1", title: "changed payload" }] };

    // Schedule both requests without waiting between them. The no-op reaches D1 first,
    // so its idempotency row must prevent the stale changed request from mutating state.
    const unchangedRequest = repository.commit(commitInput({
      snapshot: initial,
      operationHash: "hash-for-unchanged-request",
      changed: false,
      state: initial.state,
      revision: 0,
    }));
    const changedRequest = repository.commit(commitInput({
      snapshot: initial,
      operationHash: "hash-for-different-changed-request",
      changed: true,
      state: nextState,
      revision: 1,
    }));

    const [unchangedResult, changedResult] = await Promise.all([unchangedRequest, changedRequest]);
    assert.equal(unchangedResult.committed, true);
    assert.equal(changedResult.committed, false);

    const snapshot = await repository.getSnapshot(userId);
    const operation = await repository.getOperation(userId, "same-op-id-0001");
    assert.equal(snapshot.revision, 0);
    assert.deepEqual(snapshot.state, initial.state);
    assert.equal(operation.requestHash, "hash-for-unchanged-request");
    assert.equal(Number(database.prepare("SELECT COUNT(*) AS count FROM tempo_sync_snapshots WHERE user_id = ?").get(userId).count), 1);
  } finally {
    database.close();
  }
});

test("D1 commit lets a changed request win first and rejects a stale unchanged duplicate", async () => {
  const { repository, database } = await makeRepository();
  try {
    const userId = "sites-user-1";
    const initial = await repository.getSnapshot(userId);
    const nextState = { ...emptyState(), tasks: [{ id: "task-1", title: "changed payload" }] };

    const changedRequest = repository.commit(commitInput({
      snapshot: initial,
      operationHash: "hash-for-changed-request",
      changed: true,
      state: nextState,
      revision: 1,
    }));
    const unchangedRequest = repository.commit(commitInput({
      snapshot: initial,
      operationHash: "hash-for-different-unchanged-request",
      changed: false,
      state: initial.state,
      revision: 0,
    }));

    const [changedResult, unchangedResult] = await Promise.all([changedRequest, unchangedRequest]);
    assert.equal(changedResult.committed, true);
    assert.equal(unchangedResult.committed, false);

    const snapshot = await repository.getSnapshot(userId);
    const operation = await repository.getOperation(userId, "same-op-id-0001");
    assert.equal(snapshot.revision, 1);
    assert.deepEqual(snapshot.state, nextState);
    assert.equal(operation.requestHash, "hash-for-changed-request");
  } finally {
    database.close();
  }
});
