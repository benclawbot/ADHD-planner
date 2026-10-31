import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { D1SyncRepository } from "../lib/d1-sync-repository.ts";
import { handleSessionRequest, handleSyncRequest } from "../lib/sync-api.js";
import { sha256 } from "../lib/sync-core.js";

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() { return this.db.prepare(this.sql).get(...this.values) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.values) }; }
  async run() { return this.db.prepare(this.sql).run(...this.values); }
}

class D1Fixture {
  constructor(db) { this.db = db; }
  prepare(sql) { return new Statement(this.db, sql); }
  async batch(statements) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => this.db.prepare(statement.sql).run(...statement.values));
      this.db.exec("COMMIT");
      return results.map((result) => ({ meta: { changes: Number(result.changes) } }));
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

async function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(await readFile(new URL("../drizzle/0000_next_scarlet_spider.sql", import.meta.url), "utf8"));
  db.exec(await readFile(new URL("../drizzle/0001_sync_commit_guard.sql", import.meta.url), "utf8"));
  return { db, repo: new D1SyncRepository(new D1Fixture(db)) };
}

const CAPABILITY = "E2E".padEnd(43, "E");
const SHARED_ID = "tempo-shared-planner-v1";
const auth = () => ({ authorization: `Bearer ${CAPABILITY}` });

function request(method, pathname, headers, body) {
  return new Request(`https://tempo.test${pathname}`, {
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

test("shared planner session, sync write, read, conflict, and restore flow end to end", async () => {
  const { db, repo } = await setup();
  const d = await sha256(CAPABILITY);
  try {
    // 1. Session authenticates the shared capability.
    const session = await handleSessionRequest(request("GET", "/api/session", auth()), d);
    assert.equal(session.status, 200);
    assert.deepEqual(await session.json(), { user: { id: SHARED_ID, displayName: "Shared planner" } });

    // 2. Client A writes the initial plan (base revision 0).
    const stateA = {
      schema: 1,
      tasks: [{ id: "task-1", title: "Draft the budget", status: "open", notes: "" }],
      captures: [],
      focus: null,
      settings: {},
    };
    const writeA = await handleSyncRequest(
      request("PUT", "/api/sync", auth(), { baseRevision: 0, operationId: "op-write-a", state: stateA }),
      repo, d,
    );
    assert.equal(writeA.status, 200);
    assert.equal((await writeA.json()).revision, 1);

    // 3. Client B reads the same shared plan.
    const readB = await handleSyncRequest(request("GET", "/api/sync", auth()), repo, d);
    assert.equal(readB.status, 200);
    assert.deepEqual((await readB.json()).state.tasks, stateA.tasks);

    // 4. Client A writes from a stale base revision 0 while server is at revision 1.
    //    The server wins; a conflict is recorded and history retains it.
    const writeStale = await handleSyncRequest(
      request("PUT", "/api/sync", auth(), {
        baseRevision: 0,
        operationId: "op-write-stale",
        state: { ...stateA, tasks: [{ ...stateA.tasks[0], title: "Stale edit" }] },
      }),
      repo, d,
    );
    assert.equal(writeStale.status, 200);
    const staleBody = await writeStale.json();
    assert.equal(staleBody.revision, 2);
    assert.equal(staleBody.conflicts.length, 1);
    assert.equal(staleBody.state.tasks[0].title, "Draft the budget");

    // 5. Conflict history retains the overlapping version.
    const history = await handleSyncRequest(request("GET", "/api/sync/history", auth()), repo, d);
    assert.equal(history.status, 200);
    const historyBody = await history.json();
    assert.ok(historyBody.history.length >= 1, "conflict history retained");
    const historyId = historyBody.history[0].id;

    // 6. Restore the conflicting (losing/incoming) version into the current state.
    const restore = await handleSyncRequest(
      request("POST", "/api/sync/restore", auth(), {
        baseRevision: 2,
        operationId: "op-restore",
        historyId,
        version: "losing",
      }),
      repo, d,
    );
    assert.equal(restore.status, 200);
    assert.equal((await restore.json()).revision, 3);

    // 7. Unauthorized requests are rejected before any database access.
    const rejected = await handleSyncRequest(request("GET", "/api/sync"), repo, d);
    assert.equal(rejected.status, 401);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM tempo_sync_accounts").get().count), 1);
  } finally {
    db.close();
  }
});
