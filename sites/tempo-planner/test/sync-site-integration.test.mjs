import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile, stat } from "node:fs/promises";
import { test } from "node:test";

import { D1SyncRepository } from "../lib/d1-sync-repository.ts";
import { authorizeSharedCapability, handleSessionRequest, handleSyncRequest } from "../lib/sync-api.js";
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

const CAPABILITY = "C".repeat(43);
const SHARED_ID = "tempo-shared-planner-v1";
const call = (repo, method, pathname, digest, body, capability = CAPABILITY) => {
  const headers = {};
  if (capability) headers.authorization = `Bearer ${capability}`;
  if (body) headers["content-type"] = "application/json";
  return handleSyncRequest(new Request(`https://tempo.test${pathname}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  }), repo, digest);
};

test("a shared capability gates every data and session endpoint and selects one shared D1 identity", async () => {
  const { db, repo } = await setup();
  const digest = await sha256(CAPABILITY);
  try {
    for (const [method, path, body] of [
      ["GET", "/api/sync"],
      ["PUT", "/api/sync", { malformed: true }],
      ["GET", "/api/sync/history"],
      ["POST", "/api/sync/restore", { historyId: "private-history" }],
    ]) {
      const response = await call(repo, method, path, digest, body, null);
      assert.equal(response.status, 401, `${method} ${path}`);
    }
    assert.equal((await handleSessionRequest(new Request("https://tempo.test/api/session"), digest)).status, 401);
    assert.equal((await handleSessionRequest(new Request("https://tempo.test/api/session", { headers: { authorization: `Bearer ${"D".repeat(43)}` } }), digest)).status, 401);
    const noDatabaseAccess = await handleSyncRequest(
      new Request("https://tempo.test/api/sync"),
      () => { throw new Error("Unauthorized request constructed its D1 repository."); },
      digest,
    );
    assert.equal(noDatabaseAccess.status, 401);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM tempo_sync_accounts").get().count), 0);

    const session = await handleSessionRequest(new Request("https://tempo.test/api/session", { headers: { authorization: `Bearer ${CAPABILITY}` } }), digest);
    assert.deepEqual((await session.json()).user, { id: SHARED_ID, displayName: "Shared planner" });
    const state = { schema: 1, tasks: [{ id: "shared-task", title: "Shared by both clients" }], captures: [], focus: null, settings: {} };
    const write = await call(repo, "PUT", "/api/sync", digest, { baseRevision: 0, operationId: "op-shared-integration-01", state });
    assert.equal(write.status, 200);
    const secondClient = await call(repo, "GET", "/api/sync", digest);
    assert.deepEqual((await secondClient.json()).state, state);
    const history = await call(repo, "GET", "/api/sync/history", digest);
    assert.equal(history.status, 200);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM tempo_sync_accounts").get().count), 1);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM tempo_sync_operations WHERE user_id = ?").get(SHARED_ID).count), 1);
    assert.equal(await authorizeSharedCapability(new Request(`https://tempo.test/api/sync?token=${CAPABILITY}`), digest), false);
  } finally {
    db.close();
  }
});

test("browser voice inference and its required model/runtime assets are same-origin", async () => {
  const root = new URL("../", import.meta.url);
  const worker = await readFile(new URL("../public/src/voice-worker.js", import.meta.url), "utf8");
  const app = await readFile(new URL("../public/src/app.js", import.meta.url), "utf8");
  assert.match(app, /siteAuth:\s*true/);
  assert.match(app, /tempo-shared-capability-v1/);
  assert.doesNotMatch(app, /signin-with-chatgpt/);
  assert.match(worker, /allowRemoteModels\s*=\s*false/);
  assert.doesNotMatch(worker, /https?:\/\//);
  for (const path of [
    "public/src/vendor/transformers/transformers.min.js",
    "public/src/vendor/transformers/ort-wasm-simd-threaded.jsep.wasm",
    "public/src/vendor/whisper-tiny/config.json",
    "public/src/vendor/whisper-tiny/tokenizer.json",
    "public/src/vendor/whisper-tiny/onnx/encoder_model_quantized.onnx",
    "public/src/vendor/whisper-tiny/onnx/decoder_model_merged_quantized.onnx.part-000",
    "public/src/vendor/whisper-tiny/onnx/decoder_model_merged_quantized.onnx.part-001",
    "public/src/vendor/whisper-tiny/onnx/decoder_model_merged_quantized.onnx.part-002",
    "public/src/vendor/whisper-tiny/onnx/decoder_model_merged_quantized.onnx.part-003",
  ]) {
    const asset = await stat(new URL(path, root));
    assert.ok(asset.size > 0, `${path} is present and non-empty`);
  }
  const decoderParts = await Promise.all([0, 1, 2, 3].map((part) => stat(new URL(
    `../public/src/vendor/whisper-tiny/onnx/decoder_model_merged_quantized.onnx.part-${String(part).padStart(3, "0")}`,
    import.meta.url,
  ))));
  assert.equal(decoderParts.reduce((sum, part) => sum + part.size, 0), 30_719_241);
  assert.ok(decoderParts.every((part) => part.size < 25 * 1024 * 1024));
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256');
  for (let part=0; part<4; part++) digest.update(await readFile(new URL(`../public/src/vendor/whisper-tiny/onnx/decoder_model_merged_quantized.onnx.part-${String(part).padStart(3, '0')}`, import.meta.url)));
  assert.equal(digest.digest('hex'), '25e807a962b6349356d0ea5d0dfe530b7e5bf0e2a484aeca0359d03143faddd3');
  assert.match(worker, /decoder_model_merged_quantized\.onnx/);
});

test("planner embed uses the static directory URL that the production Worker serves", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const staticEntry = await readFile(new URL("../public/src/index.html", import.meta.url), "utf8");
  assert.match(page, /src="\/src\/"/);
  assert.doesNotMatch(page, /src="\/src\/index\.html"/);
  assert.match(page, /allow="microphone"/);
  assert.match(staticEntry, /<script type="module" src="\/src\/app\.js"><\/script>/);
});

test('screen navigation and offline cache use non-redirecting hosted paths', async () => {
  const app = await readFile(new URL('../public/src/app.js', import.meta.url), 'utf8');
  const sw = await readFile(new URL('../public/src/sw.js', import.meta.url), 'utf8');
  assert.match(app, /templateFor\(screenName, wide\)\.replace\(/);
  assert.doesNotMatch(sw, /\/src\/templates\/[^'\s]+\.html/);
  assert.doesNotMatch(sw, /\/src\/index\.html/);
});
