# Tempo Planner

Tempo is a calm planning PWA. This repository contains two delivery shapes:

- **Standalone root app** (`src/`, `server/`, root `package.json`) — local-first PWA with `localStorage` and an optional Node sync server (`server/sync-server.mjs`). Run from the repo root.
- **Hosted Site v5** (`sites/tempo-planner/`) — Vinext/Next.js shell that iframes the retained PWA at `public/src/`, plus a Cloudflare Worker sync API backed by D1.

## Repository layout

```
src/                Standalone PWA (canonical core PWA source)
server/             Optional Node sync server (file-based)
sites/tempo-planner/   Hosted Site (Vinext + Next.js + Cloudflare Worker + D1)
  app/              Next.js pages + API routes (/api/session, /api/sync/...)
  public/src/       Retained PWA iframe source (core synced from src/)
  worker/           Cloudflare Worker entrypoint
  lib/              sync-api, sync-core, sync-runtime, D1 repository
  db/               Drizzle schema + migrations
  test/             Node-based sync tests
scripts/            sync-pwa-core.mjs (keeps site PWA core in sync), serve.mjs
test/               Root PWA tests (node --test)
```

## The two PWA copies

The shared PWA core (`index.html`, `manifest.webmanifest`, `model.js`, `planning.js`, `recurrence.js`, `subtasks.js`, `voice-capture.js`) is single-sourced in `src/` and copied into `sites/tempo-planner/public/src/` with:

```
npm run sync:pwa-core
```

Run this after editing any core file so the hosted Site stays in sync.

Contextual files genuinely differ between the two shapes and must be edited in both:
- `app.js`, `sync-client.js` (account-based root vs shared-link site)
- `sw.js`, `voice-worker.js` (serving path and voice asset layout)

## Commands (repo root)

```
npm start        Run the standalone PWA + local sync server
npm test         Run root PWA tests (node --test)
npm run lint     ESLint on src/, test/, scripts/
npm run typecheck tsc --noEmit (syntax/module-resolution gate)
npm run sync:pwa-core Copy canonical PWA core into the hosted Site
```

The hosted Site has its own commands in `sites/tempo-planner/package.json`:
`npm ci`, `npm test`, `npm run lint`, `npm run build`, `npm run dev`, `npm run start`.

## Testing

Root tests run with `node --test`. The Site tests run with `node --experimental-strip-types --test` from `sites/tempo-planner/` (requires `npm ci` first — no `node_modules` is committed).

## Conventions

- No comments added to code unless asked (code style rule).
- 2-space indent, single quotes, semicolons, trailing commas in multiline.
- Prefer existing libraries already in `package.json`; do not add new dependencies without checking.
- Never commit secrets or keys. Local dev values go in `.env` (never committed); see `.env.example`.

## Sync security note

The shared planner link carries a 256-bit capability in its URL fragment. It is stored in `localStorage` and sent only as a `Bearer` header to same-origin `/api/session` and `/api/sync`. Never put it in a query string, HTTP URL, log, or third-party request. `TEMPO_SHARED_KEY_SHA256` must be set in the Worker environment; the repo contains neither the secret nor the shared link.
