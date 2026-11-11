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
  dateLastIndexed, name, extension, size, width, height, dateCreated.
- `TagDTO`: id, name, dateAdded, color, subTags, isHidden.
- `LocationDTO`: id, path, dateAdded, subLocations, index.
- `FileSearchDTO`: id, name, criteria, matchAny, index.

### Client entities (`src/frontend/entities/`)

`ClientFile`, `ClientTag`, `ClientLocation`, `ClientSubLocation`, `ClientFileSearchCriteria`
wrap DTOs in MobX observables. `ClientFile` has a `reaction` on `serialize()` that debounces
saves back to the backend (`FileStore.save`).

## Media pipeline (the part this repo's plan touches)

```
Location on disk
   │  chokidar (folderWatcher worker, extension filter)
   ▼
FileStats { absolutePath, dateModified, dateCreated, size, ino }
   │  LocationStore.pathToIFile
   ▼
FileDTO  ── getMetaData ──► ImageLoader.getImageResolution (ExifTool)
   │                                          │
   │                                          └─ width/height (and planned: duration)
   ▼
Backend.createFilesFromPath ──► IndexedDB
   │
   ▼
FileStore.updateFromBackend ──► ClientFile (MobX)
   │
   ├─ thumbnailPath seeded by ImageLoader.needsThumbnail()
   │
   ▼
Thumbnail component / SlideMode
   │  ImageLoader.ensureThumbnail() / getImageSrc()
   ▼
Format handler:
   web                      → createImageBitmap worker → WebP thumbnail / <img src=file>
   tifLoader                → utif decode → ImageData → WebP thumbnail / blob URL
   exrLoader                → Rust/WASM decode → ImageData → WebP thumbnail / blob URL
   psdLoader                → ag-psd worker → ImageData → WebP thumbnail / blob URL
   extractEmbeddedThumbnailOnly → ExifTool/Krita zip → thumbnail
   none                     → use original file (e.g. SVG)
```

### Format registry

- `IMG_EXTENSIONS` (`src/api/file.ts`) is a `const` tuple; `IMG_EXTENSIONS_TYPE` is derived
  from it and used in `FileDTO.extension`, the watcher, settings, search, DnD and
  `ImageLoader.FormatHandlers`.
- `LocationStore.enabledFileExtensions` (a `Set<IMG_EXTENSIONS_TYPE>`) is persisted in
  `localStorage` under `location-store-preferences`. Defaults: all extensions except `exr`.
- `ClientLocation.extensions` is a snapshot of that set at location creation/change time.

### Thumbnail generation

- `ImageLoader.ensureThumbnail` checks existence and mtime, then dispatches on the handler.
- `generateThumbnailUsingWorker` round-robins messages across 4
  `thumbnailGenerator.worker` instances; each worker has its own queue with
  `MAX_PARALLEL_THUMBNAILS = 4`.
- `common/fs.getThumbnailPath` builds `<thumbnailDir>/<basename>-<hash>.webp`.
- Thumbnails are invalidated when the source file's mtime/size changes
  (`LocationStore.watchLocations`) or when the file is replaced/moved.

### Full-size viewing

- `Thumbnail` (gallery/list) uses thumbnails, or the full image when the on-screen size
  exceeds the thumbnail size, or for GIFs.
- `SlideMode/ZoomableImage` asks `ImageLoader.getImageSrc` for a decodable source and falls
  back to the thumbnail; `ZoomPan` provides pan/zoom for still images.
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
