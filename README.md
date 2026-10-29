<p align="center"><img src="docs/assets/hero.png" alt="Abstract timeline of calm blue planning blocks" width="100%"></p>

<p align="center"><img src="src/assets/icon-192.png" alt="Tempo clock icon" width="96"></p>

# Tempo Planner

Tempo is a calm planning PWA delivered as one shared planner through a private capability link. The hosted Site is live at [tempo-adhd-planner.benclawbot.chatgpt.site](https://tempo-adhd-planner.benclawbot.chatgpt.site). Do not add or share the capability fragment in this public repository.

## Hosted Site source

The source for the currently hosted Site v5 is in [`sites/tempo-planner/`](sites/tempo-planner/). This is a regular directory in this repository, not a submodule. It contains the Next/Vinext app, Worker API, D1 schema and migrations, PWA source and public assets, local voice model/runtime, scripts, and tests. Generated output, dependencies, local databases, Site identifiers, credentials, and the shared capability are excluded.

The supplied HTML and its extracted screen templates remain the visual authority. The hosted page embeds the retained PWA from `public/src/`; the original root app described below is a separate standalone implementation. The screenshots here are early prototype references and do not establish current hosted visual fidelity.

### Build and verify the hosted source

Requires Node.js 22.13 or newer. From the Site source directory:

```sh
cd sites/tempo-planner
npm ci
npm test
npm run lint
npm run build
```

`hosting.config.json` contains only the local D1 binding name used to build and preview; it contains no Site ID or credential. Cloudflare production bindings and secrets are managed outside this repository. `npm run build` creates ignored `dist/` output and does not deploy. To run the built Worker locally, first build, then run `npm start`; the local D1 preview uses Wrangler state under ignored `.wrangler/`. See [`sites/tempo-planner/README.md`](sites/tempo-planner/README.md) for migration and preview details.

### Hosted planner behavior and privacy

The hosted version provides one shared plan with no accounts. The shared link carries a 256-bit capability in its URL fragment. The PWA stores it locally after opening the link, removes it from the address bar, and sends it only as a Bearer header to the same-origin session and sync APIs. The Worker validates its digest before database access and maps authorized links to a fixed D1 planner identity. Anyone with the shared link can view and edit the same plan. Do not put the capability in a query string, HTTP URL, logs, or third-party requests.

Voice capture records and transcribes in the browser using the bundled Transformers.js runtime and Whisper Tiny model. Audio is not sent to the sync server. The first use downloads the runtime/model from same-origin static assets; microphone access requires permission and HTTPS or localhost.

## Standalone root app

The root `src/`, `server/`, and root `package.json` are an earlier standalone local-first PWA and optional self-hosted sync server. They are not the source for the hosted Site. Run it from the repository root with Node.js 20 or newer:

```sh
npm start
npm test
```

The root version stores data in browser `localStorage` unless its separately configured sync server is used. Its feature state and limitations are described in [PRODUCT.md](PRODUCT.md) and [server/README.md](server/README.md). The approved original HTML remains the visual reference; rendered visual fidelity and target-device behavior have not been fully verified.

## Design previews

These screenshots were captured from an early prototype on 29 October 2026. They use example data and do not verify the current build or its appearance on target devices.

| Desktop preview | Mobile preview |
| --- | --- |
| ![Early desktop Today screen](docs/assets/early-desktop-preview.png) | ![Early mobile Today screen](docs/assets/early-mobile-preview.png) |

The four 390 × 844 phone reference screens and two 1280 × 800 desktop reference screens are retained as standalone templates in the root app. Task decomposition remains user-reviewed, editable, reorderable, and removable; the departure reminder is gentle and optional.

## Licensing and credits

The bundled Atkinson Hyperlegible fonts are covered by the [SIL Open Font License](src/assets/fonts/OFL.txt). The Site's speech runtime is vendored from Transformers.js under its Apache 2.0 license, and the model is separately identified in its source. A project-wide source code license has not yet been selected. The clock icon is included in `src/assets/`; the hero banner is an AI-generated illustration.
