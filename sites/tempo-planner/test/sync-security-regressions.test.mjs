import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { D1SyncRepository } from "../lib/d1-sync-repository.ts";
import { handleSyncRequest } from "../lib/sync-api.js";
import { sha256 } from "../lib/sync-core.js";
import { createSyncClient } from "../public/src/sync-client.js";

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
      const results = statements.map((statement) =>
        this.database.prepare(statement.sql).run(...statement.values),
      );
      this.database.exec("COMMIT");
      return results.map((result) => ({ meta: { changes: Number(result.changes) } }));
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function barrier(count) {
  let arrivals = 0;
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  return async () => {
    arrivals += 1;
    if (arrivals === count) release();
    await waiting;
  };
}

async function makeRepository() {
  const database = new DatabaseSync(":memory:");
  const migration = await readFile(new URL("../drizzle/0000_next_scarlet_spider.sql", import.meta.url), "utf8");
  database.exec(migration);
  database.exec(await readFile(new URL("../drizzle/0001_sync_commit_guard.sql", import.meta.url), "utf8"));
  const repository = new D1SyncRepository(new SqliteD1(database));
  return { repository, database };
}

function syncRequest(body) {
  return new Request("https://tempo.test/api/sync", {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${"A".repeat(43)}` },
    body: JSON.stringify(body),
  });
}

function jsonResponse(body) {
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}

test("concurrent identical changed requests with one operation ID replay idempotently", async () => {
  const { repository, database } = await makeRepository();
  try {
    const digest = await sha256("A".repeat(43));
    const body = {
      baseRevision: 0,
      operationId: "same-changed-op-0001",
      state: {
        schema: 1,
        tasks: [{ id: "private-a", title: "Keep this task" }],
        captures: [],
        focus: null,
        settings: {},
      },
    };
    const bothLookupsFinished = barrier(2);
    const bothCommitsReached = barrier(2);
    const originalGetOperation = repository.getOperation.bind(repository);
    const originalCommit = repository.commit.bind(repository);
    let initialLookups = 0;
    repository.getOperation = async (...args) => {
      const operation = await originalGetOperation(...args);
      if (initialLookups < 2) {
        initialLookups += 1;
        await bothLookupsFinished();
      }
      return operation;
    };
    repository.commit = async (...args) => {
      await bothCommitsReached();
      return originalCommit(...args);
    };

    const responses = await Promise.all([
      handleSyncRequest(syncRequest(body), repository, digest),
      handleSyncRequest(syncRequest(body), repository, digest),
    ]);
    const responseBodies = await Promise.all(responses.map((response) => response.json()));

    assert.deepEqual(responses.map((response) => response.status), [200, 200], JSON.stringify(responseBodies));
    assert.equal(responseBodies.filter((response) => response.duplicate === true).length, 1);
    const snapshot = await repository.getSnapshot("tempo-shared-planner-v1");
    assert.equal(snapshot.revision, 1);
    assert.deepEqual(snapshot.state, body.state);
    assert.equal(Number(database.prepare("SELECT COUNT(*) AS count FROM tempo_sync_operations WHERE user_id = ?").get("tempo-shared-planner-v1").count), 1);
  } finally {
    database.close();
  }
});

test("the browser sends the link capability only as a same-origin bearer header", async () => {
  const token = "B".repeat(43);
  const values = new Map([["tempo-shared-capability-v1", token]]);
  const storage = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
  const requests = [];
  const client = createSyncClient({
    storage,
    siteAuth: true,
    autoRetry: false,
    navigator: { onLine: true },
    onlineTarget: null,
    visibilityTarget: { visibilityState: "visible" },
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      if (url === "/api/session") return jsonResponse({ user: { id: "tempo-shared-planner-v1", displayName: "Shared planner" } });
      if (url === "/api/sync") return jsonResponse({ revision: 0, state: { schema: 1, tasks: [], captures: [], focus: null, settings: {} }, updatedAt: null, tombstones: [] });
      throw new Error(`Unexpected request: ${options.method ?? "GET"} ${url}`);
    },
  });
  client.start();
  await client.identityRequest;
  await client.inFlight;
  client.stop();
  assert.ok(requests.length >= 2);
  assert.ok(requests.every(({ url }) => typeof url === "string" && url.startsWith("/api/")));
  assert.ok(requests.every(({ url }) => !url.includes(token)));
  assert.ok(requests.every(({ options }) => options.headers.Authorization === `Bearer ${token}`));
  assert.equal(JSON.parse(values.get("tempo-sync-client-v1")).capability, undefined);

  let externalRequests = 0;
  const guarded = createSyncClient({
    storage,
    siteAuth: true,
    baseUrl: "https://third-party.test",
    autoRetry: false,
    onlineTarget: null,
    visibilityTarget: { visibilityState: "visible" },
    fetch: async () => { externalRequests += 1; return jsonResponse({}); },
  });
  guarded.start();
  await guarded.identityRequest;
  guarded.stop();
  assert.equal(externalRequests, 0);
  assert.equal(guarded.getStatus().error.code, "unsafe_sync_origin");
});
