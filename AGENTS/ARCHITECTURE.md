# Allusion — Architecture

This document describes how the application is put together. It is intentionally concise;
for the current state of format support and known problems see [AUDIT.md](AUDIT.md).

## High-level diagram

```
┌──────────────────────────── Electron main process (src/main.ts) ───────────────────────────┐
│  BrowserWindow (main)          BrowserWindow (preview)        Tray / Menu / Auto-updater     │
│  ClipServer (localhost:5454)   IPC (src/ipc/*)                electron-builder resources      │
└───────────────────────────────────────┬──────────────────────────────────────────────────────┘
                                        │ window-level messaging only
┌───────────────────────────────────────▼──────────────────────────────────────────────────────┐
│                              Renderer (src/renderer.tsx / Preview.tsx)                       │
│                                                                                              │
│  React UI (containers/, components/, widgets/)                                               │
│       │                                                                                      │
│       ▼                                                                                      │
│  MobX stores (RootStore → FileStore / TagStore / LocationStore / UiStore / SearchStore)      │
│       │                                     │                                                │
│       │                                     ▼                                                │
│       │                             ImageLoader (format handlers, thumbnails)                 │
│       │                                     │                                                │
│       ▼                                     ▼                                                │
│  Backend API (src/api/*)  ◄──────────  Dexie/IndexedDB (src/backend/backend.ts)               │
│       ▲                                                                                      │
│       │ Web Workers: folderWatcher (chokidar) · thumbnailGenerator (createImageBitmap)       │
│       │                psdReader (ag-psd) · masonry layout (WASM)                             │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
                              Filesystem (user Locations, thumbnails)
```

The main process owns native concerns (windows, tray, menus, file dialogs, trash, drag
export, auto-update, the clip server). All library data lives in the renderer's IndexedDB.

## Process model

### Main process (`src/main.ts`)

- Creates and owns the main window and the hidden preview window.
- Custom frameless window (`titleBarStyle: 'hidden'`, `frame: false`) with a custom titlebar.
- Registers the app menu, tray icon, and auto-updater (`electron-updater`).
- Starts the `ClipServer` for the browser extension on `localhost:5454`.
- Registers all `MainMessenger` handlers (`src/ipc/main.ts`): window state, dialogs, file
  operations, theme, zoom, updates, drag export, preview forwarding, clip server control.
- Sets `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` on all responses.

### Renderer

- `src/renderer.tsx` is the single renderer entry point; it branches on
  `IS_PREVIEW_WINDOW` (`?preview=true`) and renders either `App` (main window) or
  `PreviewApp` (`src/Preview.tsx`, Quick View window).
- `RootStore.main()` / `RootStore.preview()` construct the stores and kick off initialization:
  locations → tags → ExifTool → ImageLoader → search → files → watch locations. The preview
  window skips ExifTool and receives the selected file IDs from the main process over IPC.
- `App.tsx` / `Main.tsx` / `Overlay.tsx` compose the UI: toolbar, outliner, content view,
  inspector, settings, help center, splash screen.

## Data model and persistence

### IndexedDB (Dexie)

Database name: `Allusion`. Version history in `src/backend/config.ts`:

| Version | Change |
| --- | --- |
| 4 | Initial `files` schema: `++id, locationId, *tags, relativePath, &absolutePath, name, extension, size, width, height, dateAdded, dateModified, dateCreated` |
| 5 | `locations.subLocations` added (backfilled to `[]`) |
| 6 | `files.dateLastIndexed` added (backfilled to `dateAdded`) |
| 7 | `searches` table added |
| 8 | `files.ino` added (backfilled from `fs.statSync().ino`) |

Tables: `files`, `tags`, `locations`, `searches`. Only indexed fields are declared in the
schema; all other fields are stored but not queryable through Dexie indexes.

### DTOs (`src/api/`)

- `FileDTO`: id, ino, locationId, relativePath, absolutePath, tags, dateAdded, dateModified,
  dateLastIndexed, name, extension (`FILE_EXTENSIONS_TYPE`), size, width, height, dateCreated,
  optional `kind` (`'image' | 'video'`, derived from extension) and optional `duration`
  (seconds, for video). `kind`/`duration` are not indexed in the current Dexie schema (v8).
- `TagDTO`: id, name, dateAdded, color, subTags, isHidden.
- `LocationDTO`: id, path, dateAdded, subLocations, index.
- `FileSearchDTO`: id, name, criteria, matchAny, index.

### Client entities (`src/frontend/entities/`)

`ClientFile`, `ClientTag`, `ClientLocation`, `ClientSubLocation`, `ClientFileSearchCriteria`
wrap DTOs in MobX observables. `ClientFile` has a `reaction` on `serialize()` that debounces
saves back to the backend (`FileStore.save`).

## Media pipeline

```
Location on disk
   │  chokidar (folderWatcher worker, extension filter from FILE_EXTENSIONS)
   ▼
FileStats { absolutePath, dateModified, dateCreated, size, ino }
   │  LocationStore.pathToIFile
   ▼
FileDTO  ── getMetaData ──► ImageLoader.getImageResolution (ExifIO.getMediaMetadata)
   │                                          │
   │                                          └─ width/height (+ duration for video)
   ▼
Backend.createFilesFromPath ──► IndexedDB
   │
   ▼
FileStore.updateFromBackend ──► ClientFile (MobX, with kind/duration)
   │
   ├─ thumbnailPath seeded by ImageLoader.needsThumbnail() (always for video)
   │
   ▼
Thumbnail / Gallery / SlideMode
   │  ImageLoader.ensureThumbnail() (+ getImageSrc() for still images)
   ▼
Handlers (src/frontend/image/format-handlers.ts):
   image/web                   → createImageBitmap worker → WebP thumbnail / <img src=file>
   image/tifLoader             → utif decode → ImageData → WebP thumbnail / blob URL
   image/exrLoader             → Rust/WASM decode → ImageData → WebP thumbnail / blob URL
   image/psdLoader             → ag-psd worker → ImageData → WebP thumbnail / blob URL
   image/extractEmbedded...    → ExifTool/Krita zip → thumbnail
   image/none                  → use original file (e.g. SVG)
   video/video                 → <video> frame capture → WebP poster; playback via <video> in slide/preview
```

### Format registry

- `src/api/file.ts` defines `IMAGE_EXTENSIONS`, `VIDEO_EXTENSIONS`, `FILE_EXTENSIONS`
  (`const` tuples), `IMAGE/VIDEO/FILE_EXTENSIONS_TYPE`, `FileKind`, `FILE_EXTENSION_KIND`, and
  helpers (`isImageExtension`, `isVideoExtension`, `getFileKind`). `IMG_EXTENSIONS` /
  `IMG_EXTENSIONS_TYPE` are deprecated aliases.
- `src/frontend/image/format-handlers.ts` maps each extension to a handler via per-kind maps
  and `getFormatHandler` (image: `web`/`tifLoader`/`exrLoader`/`psdLoader`/
  `extractEmbeddedThumbnailOnly`/`none`; video: `video`/`none`).
- `LocationStore.enabledFileExtensions` (a `Set<FILE_EXTENSIONS_TYPE>`) is persisted in
  `localStorage` (`PREFERENCES_STORAGE_KEY`, schema version 2 via
  `location-store-preferences.ts`). Defaults: all image extensions except `exr` plus default
  videos (`mp4`, `m4v`, `mov`, `webm`). Pre-video prefs are migrated once to enable default
  videos. `ClientLocation.extensions` is a snapshot at location creation/change time.

### Thumbnail generation

- `ImageLoader.ensureThumbnail` checks existence and mtime, then dispatches on the handler.
- Images: `generateThumbnailUsingWorker` round-robins Web-native formats across 4
  `thumbnailGenerator.worker` instances (each with a queue, `MAX_PARALLEL_THUMBNAILS = 4`);
  TIFF/PSD/EXR are decoded on the main thread; embedded thumbnails extracted via ExifTool /
  Krita zip.
- Videos: `generateVideoThumbnail` (`src/frontend/image/util.ts`) captures a poster frame in
  the renderer by seeking a hidden `<video>` element and drawing to a `<canvas>`, then writes a
  WebP thumbnail (same sizing/quality logic). `needsThumbnail` is always true for video.
- `common/fs.getThumbnailPath` builds `<thumbnailDir>/<basename>-<hash>.webp`.
- Thumbnails are invalidated when the source file's mtime/size changes
  (`LocationStore.watchLocations`) or when the file is replaced/moved.

### Full-size viewing and playback

- `Thumbnail` (gallery/list/masonry) uses generated thumbnails/posters (including for video);
  videos never go through `getImageSrc` for full decode in the grid.
- `SlideMode`: branches on media kind — images use `ZoomPan` with a decodable source from
  `ImageLoader.getImageSrc` (falling back to thumbnail); videos render a `<video>` player with
  controls/poster (`object-fit: contain`) when `canPlayType` indicates support, otherwise show
  a poster + "Open in external application" fallback. Side navigation overlays are hidden for
  playable videos so native controls remain clickable.
- `Preview.tsx` reuses `ContentView`, so it inherits the same pipeline.

## State management

- `RootStore` owns the stores and the shared services (`ExifIO`, `ImageLoader`).
- `FileStore` owns the visible `fileList`, ordering, content mode (all/untagged/missing/query)
  and file selection counters.
- `UiStore` owns window/panel layout, theme, view method, thumbnail options, selection,
  search criteria and persisted UI preferences.
- `LocationStore` owns locations, enabled extensions, scanning/watching and file indexing.
- `TagStore` owns the tag tree and tag CRUD.
- `SearchStore` owns saved searches.

## IPC (`src/ipc/`)

`messages.ts` defines every channel and payload type. `main.ts` / `renderer.ts` expose
typed `on*` handlers and send functions. Categories: general window control, system buttons,
clip server, file storage, preview window forwarding, drag export, settings/theme, updates.

## Web workers

| Worker | File | Purpose |
| --- | --- | --- |
| Folder watcher | `src/frontend/workers/folderWatcher.worker.ts` | Chokidar recursive scan + add/remove events, filtered by extension |
| Thumbnail generator | `src/frontend/workers/thumbnailGenerator.worker.ts` | `createImageBitmap` → `OffscreenCanvas` → WebP, queued |
| PSD reader | `src/frontend/workers/psdReader.worker.ts` | `ag-psd` decode off the main thread |
| Masonry layout | `wasm/masonry` | Rust/WASM layout calculations |

## Build and packaging

- `webpack.dev.js` / `webpack.prod.js` export two configs: `electron-main` (`src/main.ts`) and
  `electron-renderer` (`src/renderer.tsx`).
- `experiments.asyncWebAssembly` is enabled for the renderer; `.wasm` files are emitted as
  assets.
- Path aliases are configured identically in `tsconfig.json` and both webpack configs.
- `electron-builder` config lives in `package.json` under `"build"`; ExifTool binaries and
  themes are shipped as `extraResources`.
- WASM crates are built with the custom `wasm-build` Rust tool (see `wasm/README.md`).

## Security posture (as found)

- `nodeIntegration: true`, `nodeIntegrationInWorker: true`, `contextIsolation: false`.
- CSP: `script-src 'self'; worker-src 'self' blob:` (no `wasm-unsafe-eval`, but existing
  WASM modules work under it).
- COOP/COEP are enabled, which is good for `SharedArrayBuffer`/WASM SIMD.
- The clip server binds to `localhost` only and has no authentication; it is off by default.
