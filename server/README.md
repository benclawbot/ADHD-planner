# Tempo sync API

This is a small, self-hostable Node.js API for Tempo's schema-1 task and capture state. It has no third-party runtime dependencies or externally supplied credentials. It does not make the PWA multi-device-ready by itself: deploy it with the client, HTTPS, backups, recovery procedures, and the device/runtime checks required by the product specification.

## Run

Requires Node.js 20 or newer.

```sh
TEMPO_SYNC_DATA_DIR=/var/lib/tempo-sync PORT=8787 HOST=127.0.0.1 node server/sync-server.mjs
```

The process binds to `127.0.0.1` by default. Its default database path is outside the project/static tree: `$XDG_DATA_HOME/tempo-sync/store.json` when set; otherwise `~/.local/share/tempo-sync/store.json` on Linux, `%LOCALAPPDATA%/Tempo/Sync/store.json` on Windows, or `~/Library/Application Support/Tempo/Sync/store.json` on macOS. Set `TEMPO_SYNC_DATA_DIR` to choose another dedicated directory. New data directories are created with owner-only permissions where supported; the JSON file is atomically replaced and created with owner-only permissions. Use one server process for a data directory. To expose it to the PWA, route `/api` through the same-origin HTTPS reverse proxy. If the PWA must call the API from a different origin, set `TEMPO_SYNC_ALLOWED_ORIGINS` to a comma-separated exact origin allowlist. `HOST=0.0.0.0` is available when required behind a firewall or reverse proxy; the API itself does not terminate TLS.

`GET /api/health` is an unauthenticated liveness check and returns `{ "ok": true }`.

## API

All request bodies use JSON. Account endpoints:

```http
POST /api/auth/register
{ "email": "person@example.test", "password": "at least 12 bytes" }
```

`POST /api/auth/login` accepts the same fields. Both return `token`, `tokenType`, `expiresAt`, and `{id,email}` in `user`. Send the opaque token on protected requests as `Authorization: Bearer <token>`. Tokens expire after 30 days; sign in again to get another. `POST /api/auth/logout` revokes the presented token and returns 204.

An account starts at revision 0 with an empty state:

```json
{
  "revision": 0,
  "state": { "schema": 1, "tasks": [], "captures": [], "focus": null, "settings": {} },
  "updatedAt": null,
  "tombstones": []
}
```

`GET /api/sync` returns the authenticated account's current snapshot. `PUT /api/sync` submits a complete local snapshot and stable idempotency key:

```http
PUT /api/sync
Authorization: Bearer <token>
Content-Type: application/json

{
  "baseRevision": 12,
  "operationId": "device-a-change-1234",
  "state": { "schema": 1, "tasks": [], "captures": [], "focus": null, "settings": {} }
}
```

The response contains the authoritative `revision`, merged `state`, `updatedAt`, `tombstones`, and any `conflicts`. The server merges independent object fields and task/capture entities by stable `id`. If both devices change the same value, or one deletes an entity while the other edits it, the current server revision wins and the incoming version is retained in conflict history. Task and capture deletion is represented by removing the item from its array; the existing Tempo model's `status: "removed"` is also treated as a task tombstone. The response's tombstones identify the collection, stable ID, deleting revision, and server timestamp for 30 days.

`GET /api/sync/history` returns retained conflicting versions, newest first. `POST /api/sync/restore` restores a chosen conflict version as a new revision:

```http
POST /api/sync/restore
Authorization: Bearer <token>
Content-Type: application/json

{
  "historyId": "<id returned by history>",
  "version": "losing",
  "baseRevision": 14,
  "operationId": "device-a-restore-1234"
}
```

Use `version: "winning"` to restore the server version instead. A restore requires the current revision as `baseRevision`; if another commit arrived, the server returns 409 with the current snapshot so the user can review again. Reuse an `operationId` unchanged when retrying after an uncertain response. Reusing it for a different request returns 409. Errors have the shape `{ "error": { "code": "...", "message": "...", "details": {} } }`; authentication failures use 401, stale or unavailable bases use 409, and body/state limits use 413.

## Security and deployment limits

- Passwords use Node's scrypt password hashing; the server stores only the salt and derived hash. Bearer tokens are random, returned once, and stored server-side only as SHA-256 hashes. Login failures receive a per-process IP rate limit.
- Account creation and sign-in attempts are rate limited per observed TCP peer address in each process. Behind a reverse proxy, the API deliberately ignores forwarded client-IP headers; put abuse controls at the proxy if many clients share that address.
- Every sync, history, and restore query is scoped to the user identified by the bearer token. No credentials or task contents are written to application logs.
- The JSON database is **not encrypted at rest**. Protect the host volume and backups as sensitive planning data. The API does not provide backups, account deletion, password reset, email verification, MFA, or account recovery.
- The API does not provide TLS. Keep it on loopback behind a TLS reverse proxy for remote use. CORS is disabled unless exact origins are configured; bearer tokens must remain private to the signed-in user.
- The JSON file and in-process write queue are intended for a single server process and a modest self-hosted deployment. Multiple processes sharing the same data directory, high availability, database failover, and large-scale traffic are unsupported. Back up `store.json` and test restoring backups before relying on the service.
- Sync state is limited to 512 KiB and 20,000 task/capture entries. The server retains at most 256 revision snapshots; bases older than 30 days or no longer retained return 409 rather than overwriting current data. Conflict history, deletion tombstones, and idempotency records are retained for 30 days (with explicit safety caps); hitting a cap rejects the change instead of silently dropping recovery data.
- Passwords must be at least 12 UTF-8 bytes. Registration is open to any caller who can reach the API; deployments that need invitation-only accounts should put an appropriate access control layer in front of it.

This is a pragmatic backend foundation, not a production security certification or a complete account/recovery service. Before launch, define privacy, backup, account-deletion and recovery policies and verify HTTPS, reverse-proxy, storage, concurrency, and target-device behavior in the actual deployment.
