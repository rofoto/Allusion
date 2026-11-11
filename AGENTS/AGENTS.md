# AGENTS — Allusion

This directory is the knowledge base for AI agents (and humans) working on **Allusion**.
It contains an audit of the repository, an architecture overview, and the implementation
plan for extending image format support and adding video support.

> **Snapshot:** Allusion `v1.0.0-rc.10`, branch `master` (HEAD `ec91ecc9`, 2026-11-11).
> Originally forked from upstream `631cfb5f` (`allusion-app/Allusion`); this checkout's git
> remote is `https://github.com/rofoto/Allusion.git` while `package.json` still points at
> `https://github.com/allusion-app/Allusion`. Media-support work (A0/A1, B0–B4) has landed on
> this branch; see [MEDIA_SUPPORT_PLAN.md](MEDIA_SUPPORT_PLAN.md).

## Documentation index

| Document | Contents |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System architecture, data flow, module map, DB schema, IPC, build pipeline |
| [AUDIT.md](AUDIT.md) | Repository audit: strengths, defects, gaps, risks, test coverage, prioritized recommendations |
| [MEDIA_SUPPORT_PLAN.md](MEDIA_SUPPORT_PLAN.md) | Implementation status/plan: extending image formats and adding video support (phased, file-by-file) |
| [ELECTRON_UPGRADE_PLAN.md](ELECTRON_UPGRADE_PLAN.md) | Phased plan for upgrading Electron/Chromium/Node and related tooling |

## What Allusion is

Allusion is an Electron desktop app for artists to organize a **visual library**: images and
videos are discovered from user-chosen **Locations**, tagged, searched and viewed in a
masonry/list/grid gallery, a slide view, and a separate preview window. Video files get poster
thumbnails and in-app playback when the platform codec is supported (`canPlayType`), with an
external-open fallback. Full-resolution RAW/HEIC/JXL/XCF decoding remains out of scope for now
(AVIF is supported as a browser-native image format).

## Tech stack

| Layer | Technology |
| --- | --- |
| Shell | Electron `21.3.0` (Chromium 96, Node 16) |
| UI | React 18 + TypeScript 4.9, SCSS |
| State | MobX 6 (`mobx-react-lite`), strict actions enabled |
| Persistence | IndexedDB via Dexie 3 (runs in the renderer) |
| Backend | Local API (`src/api/*` + `src/backend/backend.ts`) over the same IndexedDB |
| Metadata | ExifTool 12.54 via `node-exiftool` (bundled in `resources/exiftool`) |
| Image decoding | Browser (`createImageBitmap` / `<img>`), `utif` (TIFF), `ag-psd` (PSD), Rust→WASM (EXR, masonry layout) |
| Build | Webpack 5 (dev/prod configs), `ts-loader`, `sass-loader` |
| Tests | Jest 29 + `ts-jest` + `fake-indexeddb` (node environment) |
| Packaging | `electron-builder` (AppImage / NSIS / DMG) |

## Commands

The repository pins Node 16.20.2 with mise (`.mise.toml`). From the repository root:

```bash
mise install                  # install the pinned Node version
mise exec -- yarn install     # install dependencies (node_modules is NOT committed)
mise exec -- yarn dev         # webpack --watch -> /build
mise exec -- yarn start       # electron ./build/main.bundle.js (run in a second terminal)
mise exec -- yarn production  # one-off production build
mise exec -- yarn test        # jest
mise exec -- yarn lint        # eslint --fix over src/ and widgets/
mise exec -- yarn package     # build + Linux AppImage -> dist/
```

`mise exec -- <cmd>` runs the command with the project's pinned Node/Yarn. If Node 16 and
Yarn 1.x are already on PATH, the plain `yarn ...` commands work too.

The main build target is the **Linux AppImage**. `yarn package` produces
`dist/Allusion-<version>.AppImage`; Windows and macOS packaging are configured but are not
required for the current work. The WASM artifacts under `wasm/packages/` are committed and do
not need rebuilding for normal development.

## Repository layout

```
common/                 Shared code used by main + renderer (config, fs, ExifIO, fmt, ...)
src/
  main.ts               Electron main process: windows, tray, menu, auto-update, IPC, clip server
  renderer.tsx          Renderer entry point (branches on ?preview=true)
  Preview.tsx           Quick View window component
  api/                  Data-transfer types + storage API interfaces (no Electron deps)
  backend/              Dexie/IndexedDB implementation of the storage API + DB versioning
  ipc/                  Type-safe IPC message definitions (main <-> renderer)
  clipper/              Local HTTP clip server used by the browser extension
  frontend/
    entities/           Client-side MobX entities (File, Tag, Location, SearchCriteria)
    stores/             MobX stores (RootStore, FileStore, TagStore, LocationStore, UiStore, SearchStore)
    image/              ImageLoader + format-specific loaders + thumbnail generation
    workers/            folderWatcher, thumbnailGenerator, psdReader
    containers/         AppToolbar, ContentView (gallery/list/masonry/slide), Outliner, Inspector, Settings
    components/         Small reusable UI components
    hooks/              React hooks
widgets/                Generic UI widgets (buttons, menus, toolbar, popovers, tree, ...)
wasm/                   Rust→WASM crates (exr-decoder, masonry) + committed build artifacts
resources/              ExifTool binaries, icons, themes, test images, help-center images
tests/                  Jest tests (backend, tag store, utils, masonry renderer)
AGENTS/                 This directory
.mise.toml              Pins Node 16.20.2 for mise
```

## Key concepts agents must know

- **DTO vs client entity.** `src/api/*` defines plain data-transfer objects (`FileDTO`,
  `TagDTO`, `LocationDTO`). `src/frontend/entities/*` defines MobX-wrapped client entities
  (`ClientFile`, `ClientTag`, `ClientLocation`) that auto-save changes to the backend.
  Never put MobX observables into DTOs; `serialize()` strips them. `FileDTO`/`ClientFile`
  include optional `kind?: FileKind` (`'image' | 'video'`) and `duration?: number` (seconds,
  non-indexed).
- **Backend is in the renderer.** `Backend` (`src/backend/backend.ts`) implements
  `DataStorage` over Dexie. The main process does not touch IndexedDB directly; it uses IPC
  for window/system operations only. Schema is at v8 (`src/backend/config.ts`); `kind`/`duration`
  are not indexed yet.
- **Format handling is extension-driven.** `src/api/file.ts` is the source of truth:
  `IMAGE_EXTENSIONS`, `VIDEO_EXTENSIONS`, `FILE_EXTENSIONS`, `FILE_EXTENSION_KIND`, and helpers
  (`isImageExtension`, `isVideoExtension`, `getFileKind`). `IMG_EXTENSIONS`/`IMG_EXTENSIONS_TYPE`
  remain as deprecated aliases. Per-kind handlers live in
  `src/frontend/image/format-handlers.ts` (`getFormatHandler`). Discovery is done by the
  `folderWatcher` web worker using the location's enabled extension list.
- **Thumbnails & playback.** Generated on demand by `ImageLoader.ensureThumbnail`, stored as
  WebP in a user-configurable directory (`UiStore.thumbnailDirectory`), named
  `<basename>-<hash>.webp`. Web-native images use `thumbnailGenerator` workers; TIFF/PSD/EXR are
  decoded on the main thread; embedded thumbnails are extracted via ExifTool/`node-stream-zip`.
  Video posters are captured in the renderer (`util.generateVideoThumbnail`) by seeking a
  `<video>` element and drawing to canvas. `getImageSrc` returns `undefined` for video; slide/
  preview mode renders a `<video>` player (with `canPlayType` gating and external-open fallback).
  `FileStore.filesFromBackend` seeds `thumbnailPath` and `Thumbnail`/gallery views trigger
  generation.
- **Preferences.** `src/frontend/stores/location-store-preferences.ts` defines
  `PREFERENCES_STORAGE_KEY`, default enabled extensions (all images except `exr` + default
  videos `mp4,m4v,mov,webm`) and versioned migration/serialization. `LocationStore` persists
  enabled extensions to `localStorage`.
- **MobX is strict.** `configure({ observableRequiresReaction: true, reactionRequiresObservable: true })`
  in `RootStore` means state reads outside reactions and mutations outside actions throw.
- **Imports use path aliases.** `common/*`, `widgets/*`, `src/*`, `wasm/*`, `resources/*`
  (see `tsconfig.json` and `webpack.*.js`).
- **WASM is committed.** `wasm/packages/**` must be committed after rebuilding; feature
  detection (scalar vs SIMD masonry) happens in JS.
- **ExifTool is a long-running child process.** `ExifIO` opens one `ExiftoolProcess` and
  keeps it alive. `getMediaMetadata` reads width/height/duration (normalizing numeric, formatted
  and HMS duration strings). The preview window intentionally does not initialize it (see
  `RootStore.preview`).

## Agent conventions and gotchas

- Run `yarn lint` (or `npm run lint`) before finishing; the repo uses Prettier via ESLint.
- Do **not** run `yarn lint` with `--fix` over generated/`wasm/packages` files.
- Tests run in a plain node environment with `fake-indexeddb`; they do not exercise Electron,
  DOM, workers or WASM. Keep pure logic in importable modules so it can be tested.
- `src/backend/config.ts` contains the Dexie version history. Adding an **indexed** field
  requires a new DB version; adding a non-indexed field does not.
- The app is pinned to Electron 21 (Chromium 96). Browser codec/decoder support is therefore
  older than current Chrome; verify with `video.canPlayType` / `createImageBitmap` at runtime.
- `nodeIntegration` is enabled and `contextIsolation` is disabled (legacy Electron setup).
  Do not add remote-content loading or untrusted HTML injection without revisiting this.
- `yarn.lock` is the source of truth for dependencies. Prefer `yarn`; `npm` can be used in a
  pinch but may produce a different tree.

## Known limitations / planned work

See [AUDIT.md](AUDIT.md) for the full list. Major items:

1. **Additional image formats** beyond AVIF (HEIC/HEIF, JPEG XL, XCF, RAW previews, …) — phases
   A2–A4 in [MEDIA_SUPPORT_PLAN.md](MEDIA_SUPPORT_PLAN.md).
2. **Video polish**: B5 (optional) search/filter by `kind`/duration (needs DB schema bump),
   browser-extension video import, drag-export icon for videos, Help Center copy.
3. **Correctness/quality**: `Backend.createFilesFromPath` bulkAdd await issue (AUDIT H4),
   thumbnail/loader hardening (AUDIT M7/M8).
4. **Platform modernization**: upgrade Electron/Chromium/Node and ExifTool (separate, higher
   risk) — see [ELECTRON_UPGRADE_PLAN.md](ELECTRON_UPGRADE_PLAN.md).

Phased status and file-by-file details are in [MEDIA_SUPPORT_PLAN.md](MEDIA_SUPPORT_PLAN.md).

## Maintaining this documentation

- Update [AUDIT.md](AUDIT.md) when a finding is fixed or a new issue is discovered; move
  resolved items to a short "Resolved" section instead of deleting the history.
- Update [MEDIA_SUPPORT_PLAN.md](MEDIA_SUPPORT_PLAN.md) as phases land: tick the acceptance
  criteria and note any deviation from the plan (decision, reason, commit/PR).
- Record significant architecture changes in [ARCHITECTURE.md](ARCHITECTURE.md), especially
  changes to the data model, IPC contracts, worker boundaries and the media pipeline.
- Prefer small, dated entries over rewriting history; future agents need to know *why* the
  code looks the way it does.
- When adding a new file format or decoder, update the support tables in
  [MEDIA_SUPPORT_PLAN.md](MEDIA_SUPPORT_PLAN.md) and add a fixture/manual check.

