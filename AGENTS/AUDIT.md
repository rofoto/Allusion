# Allusion — Repository Audit

Initial audit performed on commit `631cfb5f` (Allusion `v1.0.0-rc.10`, 2023-05-30).
Method: static analysis of the full source tree, dependency/version review, and a live
metadata check with the bundled ExifTool against generated MP4/WebM/AVI/MKV samples.

**Update (2026-11-11, `ec91ecc9`):** media-support phases A0/A1 and B0–B4 have landed
(images: AVIF; video: discovery, metadata/duration, poster thumbnails, slide/preview playback
with `canPlayType` gating + fallback, settings/search grouping, DnD/clipboard import). The
repo now has 7 Jest suites / 50 tests (including media registry/metadata/preferences). Sections
below retain original findings for history; current status is summarized in §7.

---

## 1. Executive summary

Allusion is a well-structured Electron app with a clear separation between DTOs, client
entities, stores and the storage backend. The media pipeline is extension-driven and easy to
extend in principle, but it is **image-only** and has a number of small correctness and
maintainability issues.

The most important findings:

1. **No video support anywhere** — discovery, metadata, thumbnails, playback, drag & drop,
   settings and search are all hard-wired to images.
2. **`IMG_EXTENSIONS` is overloaded** as both the image-format registry and the universal
   "allowed file" list. Adding video (or more image formats) requires a registry redesign.
3. **Drag & drop MIME handling is wrong/incomplete** (`image/jpg`, `image/svg`, …) and has no
   video path.
4. **`Backend.createFilesFromPath` does not await `bulkAdd`** inside its transaction, which
   can lose writes or produce unhandled rejections.
5. **Browser/Electron and ExifTool versions are old** (Chromium 96, ExifTool 12.54), which
   limits native format and codec support.
6. **Test coverage is minimal** (4 test files, no renderer/DOM tests, no format tests).

---

## 2. Current format support

### 2.1 Registry

`src/api/file.ts`:

```ts
export const IMG_EXTENSIONS = [
  'gif', 'png', 'apng', 'jpg', 'jpeg', 'jfif', 'webp', 'tif', 'tiff', 'bmp', 'ico',
  'svg', 'psd', 'kra',
  // 'xcf', // Gimp
  'exr',
  // 'raw', ... many RAW extensions
  // 'avif',
  // 'heic',
] as const;
```

`ImageLoader.FormatHandlers` (`src/frontend/image/ImageLoader.ts`):

| Handler | Extensions | Decoding path |
| --- | --- | --- |
| `web` | gif, png, apng, jpg, jpeg, jfif, webp, bmp, ico | Browser `createImageBitmap` worker / `<img>` |
| `tifLoader` | tif, tiff | `utif` on main thread |
| `exrLoader` | exr | Rust/WASM (`wasm/packages/exr`) |
| `psdLoader` | psd | `ag-psd` in a Web Worker |
| `extractEmbeddedThumbnailOnly` | kra | `preview.png` extracted from the Krita zip |
| `none` | svg | No thumbnail; original file used as its own "thumbnail" |

### 2.2 Verified metadata support (ExifTool 12.54)

Generated 320×240, 2-second samples with FFmpeg and ran the bundled ExifTool:

```bash
perl resources/exiftool/exiftool.pl -ImageWidth -ImageHeight -Duration# -FileType -MIMEType ...
```

| File | Width | Height | Duration | FileType | MIME |
| --- | --- | --- | --- | --- | --- |
| MP4 (H.264) | 320 | 240 | 2 | MP4 | video/mp4 |
| WebM (VP9) | 320 | 240 | 2 | WEBM | video/webm |
| AVI (MPEG-4) | 320 | 240 | 2 | AVI | video/x-msvideo |
| MKV (H.264) | 320 | 240 | 2 | MKV | video/x-matroska |

**Conclusion:** ExifTool can provide width, height and duration for all common container
formats, so metadata extraction needs no new dependency. Note that MP4/AVI return a numeric
duration while WebM/MKV return an HMS string (`00:00:02.000000000`); `ExifIO.parseDuration`
normalizes both to seconds. Embedded video thumbnails are usually absent (the test MP4
produced 0 bytes with `-ThumbnailImage -b`), so poster frames must be captured by decoding
the video.

---

## 3. Strengths

- **Clear layered architecture.** DTOs in `src/api`, storage API + Dexie backend in
  `src/backend`, MobX entities/stores in `src/frontend`, generic UI in `widgets/`.
- **Type-safe IPC** (`src/ipc/messages.ts`) with payload types for every channel.
- **Extension-driven discovery.** Adding an extension is a one-line change in
  `IMG_EXTENSIONS`; the watcher, settings picker, search dropdown and `ImageLoader` are all
  driven from it. TypeScript's `Record<IMG_EXTENSIONS_TYPE, FormatHandlerType>` forces a
  handler for every extension.
- **Worker-based heavy lifting** for folder watching, thumbnail generation and PSD decode.
- **Good thumbnail invalidation** based on mtime/size and explicit removal on delete/move.
- **Database versioning** is in place (`src/backend/config.ts`) with backfills.
- **Committed WASM artifacts** and a documented build tool (`wasm/README.md`).
- **Accessibility touches**: ARIA roles/labels in the list, toolbar, inspector and settings.

---

## 4. Findings

### 4.1 High severity

#### H1 — No video support

- Discovery: `folderWatcher.worker.ts` filters on `IMG_EXTENSIONS` only.
- Metadata: `ExifIO.getDimensions` reads only `ImageWidth`/`ImageHeight`; `FileDTO` has no
  duration field.
- Thumbnails: `ImageLoader.ensureThumbnail` has no video handler; `needsThumbnail` special-
  cases only GIF.
- Playback: `SlideMode/ZoomableImage` and `ZoomPan` render only `<img>`; there is no
  `<video>` element anywhere in the app.
- UI: `ImageFormatPicker`, `AdvancedSearch`, `LocationRecoveryDialog`, `dnd.ts`,
  `ImageInfo`, `ListItem` are all image-oriented.

Impact: the stated goal (video support) cannot be met without changes across ~15 files.

#### H2 — `IMG_EXTENSIONS` is overloaded

The same constant is used for:

- image format support (`ImageLoader`, `ImageFormatPicker`),
- universal allowed-file list (`LocationRecoveryDialog`, `dnd.ts`, `AdvancedSearch`,
  `folderWatcher.worker`),
- the `FileDTO.extension` type.

Adding video means either mixing media kinds into an "image" list (wrong semantics, wrong
MIME types, wrong settings grouping) or renaming/redesigning the registry and touching every
consumer. There is no `FileKind`/`isVideo` concept.

#### H3 — Drag & drop MIME mapping is incorrect

`src/frontend/containers/Outliner/LocationsPanel/dnd.ts`:

```ts
const ALLOWED_FILE_DROP_TYPES = IMG_EXTENSIONS.map((ext) => `image/${ext}`);
```

This produces `image/jpg`, `image/tif`, `image/tiff`, `image/psd`, `image/kra`, `image/exr`,
none of which are the correct MIME types (`image/jpeg`, `image/tiff`, `image/vnd.adobe.photoshop`,
`image/x-krita`, `image/x-exr`, …). Browsers report `image/jpeg` for `.jpg`, so dropping
local JPEGs may not even be accepted. `testImage()` checks `blob.type.endsWith(ext)`, which
fails for `image/svg+xml`, `image/vnd.microsoft.icon`, etc. There is no `video/*` handling.

#### H4 — `Backend.createFilesFromPath` does not await `bulkAdd`

`src/backend/backend.ts`:

```ts
await this.#db.transaction('rw', this.#files, async () => {
  ...
  this.#files.bulkAdd(files);   // not awaited / not returned
});
```

Dexie transactions auto-commit when the returned promise resolves. Because `bulkAdd` is not
returned/awaited, the transaction can commit before the inserts finish, and a rejection
becomes an unhandled promise rejection. `this.#notifyChange()` then runs after the
transaction resolves, so the UI can be notified before the inserts settle. This can cause
lost or partially-applied imports and inconsistent UI state.

### 4.2 Medium severity

#### M1 — Old Electron / Chromium

Electron `21.3.0` → Chromium 96 (2021). Consequences:

- AVIF is supported (Chrome 85+), but **JPEG XL and HEIC are not**.
- Video codecs are limited to what Chromium 96 + Electron's ffmpeg build support
  (H.264/AAC in MP4/MOV, VP8/VP9/AV1 in WebM, Theora in Ogg). MKV/AVI/WMV/FLV are not
  playable.
- WebCodecs exists in Chromium 96, but using it would require a separate container demuxer;
  there is no ready-made video-file decoder pipeline.

Upgrading Electron is a larger project (native deps, `electron-builder`, Node version), but
it materially improves format/codec support.

#### M2 — Old ExifTool

Bundled ExifTool is **12.54 (2023-01-06)**. It handles common image/video formats well (see
§2.2), but newer formats (e.g. JPEG XL metadata, some HEIC/AVIF variants, newer RAW
cameras) may be unsupported. Upgrading the bundled binaries is low risk.

#### M3 — Settings UI is a flat, image-only list

`ImageFormatPicker.tsx` renders every extension with a checkbox and has a TODO to group
extensions. There is no image/video separation, no codec information, and no "experimental"
badge except for EXR. `removeDisabledImages` deletes all files of a disabled extension,
which would be surprising if applied to a large video collection.

#### M4 — No duration/codec metadata in the UI

`FileDTO` has no duration; `ImageInfo.tsx` shows only dimensions; `ListItem` shows only
dimensions; `AdvancedSearch` has no duration criterion. ExifTool already exposes `Duration`,
`VideoFrameRate`, `CompressorName`, etc.

#### M5 — Browser extension import is image-only

`src/clipper/server.ts` exposes `import-image` and stores arbitrary bytes, but the web
extension only sends images (`useClipboardImporter` also filters `image/*`). Video import
would need extension changes plus a new endpoint or a generalized `import-media`.

#### M6 — Default extension preferences are fragile

`LocationStore.init`:

```ts
const prefs = JSON.parse(localStorage.getItem(PREFERENCES_STORAGE_KEY) || '') as Preferences;
(prefs.extensions || IMG_EXTENSIONS).forEach(...)
```

The `||` fallback only triggers for `undefined`/`null`; an empty array is truthy and would
disable every format. The picker prevents saving an empty set, so this is minor, but there is
no migration path when new extensions are added: existing users will not see newly added
formats unless they reset preferences or the code explicitly merges defaults.

#### M7 — TIFF loader makes unsafe assumptions

`TifLoader.decode` does `(img[BaselineTag.BitsPerSample] as number[]).length` without
checking existence. Grayscale/CMYK/1-bit TIFFs may not have `BitsPerSample` on the first IFD
or may have a scalar value, causing a throw. `UTIF.toRGBA8` also does not handle every TIFF
flavor.

#### M8 — Thumbnail pipeline has rough edges

- `ThumbnailGeneration` keeps a module-level listener map; timeouts reject but the worker may
  still finish later and log "No callbacks found".
- `thumbnailGenerator.worker` has an unbounded queue and a TODO about discarding old work.
- `ImageLoader.ensureThumbnail` returns `false` if `fileStats.mtime < thumbStats.ctime`, but
  uses `ctime` (metadata change time) rather than `mtime` for the thumbnail; copying or
  permission changes can therefore skip regeneration.
- `updateThumbnailPath` appends `?v=1` to force React re-render; a `?v=2` scheme would be
  more robust than the string-splitting used in several places.

### 4.3 Low severity / technical debt

| ID | Finding | Location |
| --- | --- | --- |
| L1 | Duplicate thumbnail-generation code (worker vs `image/util.ts`) | `thumbnailGenerator.worker.ts` / `image/util.ts` |
| L2 | `hashString` is a 32-bit non-cryptographic hash; collisions are possible in large libraries | `common/fs.ts` |
| L3 | `encodeFilePath` only escapes `#` in the directory portion, not the filename; `?` in filenames is not handled | `common/fs.ts` |
| L4 | `IMG_EXTENSIONS` order is arbitrary; search dropdown and settings list are not grouped | `src/api/file.ts` |
| L5 | `file.extension` is stored denormalized and must stay in sync with `name`/`absolutePath` on rename | `src/frontend/entities/File.ts` |
| L6 | `mergeMovedFile` copies `extension` from the new file but not `dateLastIndexed` | `src/frontend/entities/File.ts` |
| L7 | `main.ts` `onDragExport` uses `nativeImage.createThumbnailFromPath` for the drag icon; for videos it will likely be empty | `src/main.ts` |
| L8 | `FileStore.updateFromBackend` does not `await` existence checks intentionally; `isBroken` updates can race with rendering | `src/frontend/stores/FileStore.ts` |
| L9 | `prefs.extensions || IMG_EXTENSIONS` pattern and no default-merge for new extensions | `src/frontend/stores/LocationStore.ts` |
| L10 | Many TODOs around per-location extension settings, batch metadata reading, and thumbnail resolution tiers | various |
| L11 | `README.md` is minimal; no contributor docs, no architecture docs (until this `AGENTS/` directory) | root |
| L12 | `package.json` `yarn lint` uses `--fix` by default | `package.json` |
| L13 | `resources/test_images` contains a "currently not supported" TIFF and an "unsupported" PSD, but no automated format test consumes them | `resources/test_images` |

### 4.4 Security observations

- `nodeIntegration: true`, `nodeIntegrationInWorker: true`, `contextIsolation: false`
  (`src/main.ts`). This is a legacy, high-privilege setup; any XSS or malicious renderer code
  has full Node access. Consider migrating to `contextIsolation: true` + a preload script
  with `contextBridge`.
- CSP is `script-src 'self'; worker-src 'self' blob:`; `wasm-unsafe-eval` is not present, but
  the existing WASM modules work, so Chromium's `script-src` handling is sufficient here.
- The clip server has no authentication and listens on `localhost`; a local process can
  import files/tags. It is disabled by default.
- `shell.openExternal` is used with `file://` URLs and user-controlled paths; paths are
  escaped by the OS, but this should be kept in mind.

---

## 5. Test coverage

Existing tests (`tests/`):

| File | Coverage |
| --- | --- |
| `backend.test.ts` | Tag CRUD, tag removal/merge behavior on files |
| `tag-store.test.ts` | Tag tree store logic |
| `utils.test.ts` | Utility functions |
| `virtualized-renderer.test.ts` | Masonry viewport binary search |

What is **not** covered:

- Extension registry, format-handler completeness, MIME mapping.
- Metadata extraction / `FileDTO` construction.
- ImageLoader/thumbnail pipeline (workers, WASM, DOM).
- Stores beyond tags (FileStore, LocationStore, UiStore).
- React components (no testing-library setup; jest environment is `node`).
- Drag & drop, settings picker, search criteria.

CI (`.github/workflows/test.yml`) runs `yarn install` + `yarn test` on Node 16, and a build
job for non-master branches. `yarn test` was not run in this audit because `node_modules`
is absent.

---

## 6. Recommendations (prioritized)

1. **Fix `createFilesFromPath`** to `return this.#files.bulkAdd(files)` (or `await` it) and
   handle errors. Low risk, high correctness value.
2. **Introduce a media-kind registry** (`IMAGE_EXTENSIONS`, `VIDEO_EXTENSIONS`,
   `FILE_EXTENSIONS`, `FileKind`) and migrate all consumers. This is the foundation for both
   goals.
3. **Add image formats in order of value/effort**: AVIF (browser-native) → XCF (embedded
   thumbnail) → HEIC/HEIF (WASM) → JPEG XL (WASM) → RAW previews (embedded thumbnail) →
   miscellaneous legacy formats.
4. **Add video support in phases**: discovery + metadata + poster thumbnails → `<video>`
   playback with graceful fallback → DnD/import → search/UI polish.
5. **Fix DnD MIME handling** with a proper extension→MIME map and `video/*` support.
6. **Add duration/codec metadata** to `FileDTO` and surface it in the inspector/list.
7. **Add tests** for registries, MIME mapping, metadata parsing and handler completeness;
   add tiny generated media fixtures to `resources/test_images`.
8. **Plan an Electron + ExifTool upgrade** as a separate, higher-risk project.
9. **Improve settings UX**: group by media kind, mark experimental formats, warn before
   deleting files by extension.
10. **Address security posture** (context isolation) as a dedicated effort.

The detailed implementation plan for items 2–7 is in
[MEDIA_SUPPORT_PLAN.md](MEDIA_SUPPORT_PLAN.md).

---

## 7. Status update (as of `ec91ecc9`)

### Resolved / largely addressed

- **H1 (video support, largely done):** video extensions registered and discoverable; metadata
  (dimensions + duration) extracted via ExifTool (`parseDuration` handles numeric/HMS/formatted);
  poster thumbnails generated; slide/preview playback via `<video>` with `canPlayType` gating and
  external-open fallback (playable-video nav overlay fix in `ec91ecc9`); duration/kind surfaced
  in gallery/list/inspector; DnD and clipboard import accept supported video media. **Remaining:**
  browser-extension video import, search/filter by kind/duration (B5, needs schema/index bump),
  optional drag-export icon/polish.
- **H2 (registry redesign, largely done):** `IMAGE_EXTENSIONS`/`VIDEO_EXTENSIONS`/
  `FILE_EXTENSIONS`, `FileKind`, kind helpers and per-kind handler maps (`format-handlers.ts`)
  are in place; `IMG_EXTENSIONS` kept as deprecated alias. Some consumers may still use aliases.
- **H3 (DnD MIME handling, fixed):** `dnd.ts` now uses `EXTENSION_TO_MIME` over
  `FILE_EXTENSIONS`, accepts `image/*`/`video/*` and known mimes/extensions, handles URL/media
  drops, and generalizes to `storeDroppedMedia`.
- **M3 (settings UI, mostly done):** image/video grouped in picker, preview-only formats badged,
  confirm before deleting disabled video files.
- **M4 (duration/codec metadata, mostly done):** `FileDTO`/`ClientFile` store `duration` and
  `kind`; UI shows duration and exposes video-related exif fields. Not indexed/searchable yet.
- **M6 (prefs/default migration, addressed):** versioned preferences with default merge/migration
  for newly enabled default video formats (`location-store-preferences.ts`).
- **A1 (AVIF):** added as browser-native image format.
- **Side fix:** `OrderBy<T>` uses `-?` for optional fields.

### Still open / relevant

- **H4:** `Backend.createFilesFromPath` does not await/return `bulkAdd` inside the transaction
  (correctness risk) — not addressed.
- **M1/M2:** Electron 21 / Chromium 96 and bundled ExifTool 12.54 are old (limits codecs/format
  support) — upgrade planned separately ([ELECTRON_UPGRADE_PLAN.md](ELECTRON_UPGRADE_PLAN.md)).
- **M5:** browser extension remains image-only (local server stores arbitrary bytes).
- **M7/M8:** TIFF loader assumptions and thumbnail pipeline edge cases remain.
- **Low/tech debt:** L1–L13 largely unchanged except format-related items improved by the new
  registries/MIME map.

### Test coverage (current)

7 suites, 50 tests (`backend`, `tag-store`, `utils`, `virtualized-renderer`,
`media-extensions`, `media-metadata`, `location-store-preferences`). Still no renderer/DOM/
worker/WASM integration tests; media pipelines rely on manual checks and small fixtures in
`resources/test_images`.
