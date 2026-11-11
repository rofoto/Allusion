# Media Support Plan — More Image Formats + Video

This plan extends Allusion's media support in two workstreams:

1. **More image formats** (AVIF, HEIC/HEIF, JPEG XL, XCF, RAW previews, legacy formats).
2. **Video support** (discovery, metadata, poster thumbnails, playback, UI, import).

It is written against commit `631cfb5f`. Each workstream is split into phases that can be
landed independently. File paths are relative to the repository root.

---

## 0. Progress log

- **Phase A0 — Registry refactor: DONE.**
  - `src/api/file.ts` now exports `IMAGE_EXTENSIONS`, `VIDEO_EXTENSIONS`, `FILE_EXTENSIONS`,
    `FileKind`, `FILE_EXTENSION_KIND`, `isImageExtension`, `isVideoExtension` and
    `getFileKind`. `IMG_EXTENSIONS`/`IMG_EXTENSIONS_TYPE` remain as deprecated aliases.
  - `src/frontend/image/format-handlers.ts` holds the per-kind handler maps and
    `getFormatHandler`.
  - All consumers migrated. `OrderBy<T>` was fixed with `-?` so optional `FileDTO` fields do
    not add `undefined` to the orderable-key union.
  - Tests: `tests/media-extensions.test.ts`.
- **Phase B0 — Foundation: DONE.**
  - `FileDTO` gained optional `kind` and `duration`.
  - `ExifIO.getMediaMetadata` reads `ImageWidth`, `ImageHeight` and `Duration#`;
    `getDimensions` delegates to it. `parseDuration` normalizes numeric values, formatted
    strings (`2.00 s`) and HMS timestamps (`00:00:02.000000000`, used by WebM/MKV) to
    seconds.
  - `ImageLoader.getImageResolution` returns duration; `getMetaData` populates
    `kind`/`duration`.
  - `ImageLoader.needsThumbnail` returns true for video; `ensureThumbnail`/`getImageSrc`
    handle the `video` handler with explicit "not supported yet" fallbacks.
  - Tests: `tests/media-metadata.test.ts`.
- **Verified:** `yarn test` (38 tests, 6 suites), `yarn production`, `yarn package`
  (Linux AppImage), ESLint (0 errors). Tooling pinned with mise (`.mise.toml`, Node
  16.20.2).

---

## 1. Goals and non-goals

### Goals

- Support additional image formats with the same UX as existing ones: discovery,
  thumbnails, full-size viewing, search by extension, per-format enable/disable.
- Support common video files: discovery, dimension/duration metadata, poster thumbnails,
  in-app playback when the platform codec allows it, and a graceful fallback otherwise.
- Keep the existing image pipeline working unchanged for current formats.
- Keep the change testable: pure logic (registries, MIME maps, metadata parsing) unit-tested;
  media pipelines covered by manual/integration fixtures.

### Non-goals (for the first iteration)

- Full-resolution RAW decoding (embedded previews only, plus "open externally").
- Transcoding or re-encoding media.
- Video editing, frame-accurate seeking, audio mixing.
- Replacing ExifTool with a metadata library.
- Upgrading Electron/Chromium (separate project; see [AUDIT.md](AUDIT.md) M1).

---

## 2. Key design decisions

### D1 — Separate extension registries by media kind

Replace the overloaded `IMG_EXTENSIONS` with three registries and a kind lookup:

```ts
// src/api/file.ts
export const IMAGE_EXTENSIONS = [
  'gif','png','apng','jpg','jpeg','jfif','webp','tif','tiff','bmp','ico','svg','psd','kra','exr',
  // new:
  'avif', 'heic', 'heif', 'jxl', 'xcf',
] as const;

export const VIDEO_EXTENSIONS = [
  'mp4','m4v','mov','webm','ogv','mkv','avi','wmv','flv','ts','mts','m2ts','3gp','3g2',
] as const;

export const FILE_EXTENSIONS = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS] as const;

export type IMAGE_EXTENSIONS_TYPE = typeof IMAGE_EXTENSIONS[number];
export type VIDEO_EXTENSIONS_TYPE = typeof VIDEO_EXTENSIONS[number];
export type FILE_EXTENSIONS_TYPE  = typeof FILE_EXTENSIONS[number];

export type FileKind = 'image' | 'video';

export const FILE_EXTENSION_KIND: Record<FILE_EXTENSIONS_TYPE, FileKind> = { ... };

export const isImageExtension = (ext: string): ext is IMAGE_EXTENSIONS_TYPE =>
  (IMAGE_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());

export const isVideoExtension = (ext: string): ext is VIDEO_EXTENSIONS_TYPE =>
  (VIDEO_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());

export const getFileKind = (ext: string): FileKind | undefined =>
  isImageExtension(ext) ? 'image' : isVideoExtension(ext) ? 'video' : undefined;
```

During migration, keep a deprecated alias to avoid a big-bang rename:

```ts
/** @deprecated Use IMAGE_EXTENSIONS or FILE_EXTENSIONS. */
export const IMG_EXTENSIONS = IMAGE_EXTENSIONS;
/** @deprecated Use IMAGE_EXTENSIONS_TYPE or FILE_EXTENSIONS_TYPE. */
export type IMG_EXTENSIONS_TYPE = IMAGE_EXTENSIONS_TYPE;
```

Remove the aliases once all consumers are migrated.

### D2 — Split format handlers by kind

```ts
// src/frontend/image/ImageLoader.ts
type ImageHandlerType =
  | 'web' | 'tifLoader' | 'exrLoader' | 'psdLoader'
  | 'heicLoader' | 'jxlLoader'
  | 'extractEmbeddedThumbnailOnly' | 'none';

type VideoHandlerType = 'browserVideo' | 'extractEmbeddedThumbnailOnly' | 'none';

const IMAGE_HANDLERS: Record<IMAGE_EXTENSIONS_TYPE, ImageHandlerType> = { ... };
const VIDEO_HANDLERS: Record<VIDEO_EXTENSIONS_TYPE, VideoHandlerType> = { ... };
```

Keeping two maps makes `Record<...>` exhaustiveness checking work per kind and avoids a
meaningless `video → tifLoader` mapping. Export the maps (or a `getHandler(kind, ext)`
helper) so unit tests can assert that every registered extension has a handler.

### D3 — Metadata via ExifTool, including duration

`ExifIO` already shells out to ExifTool. Add a method that reads both image and video
metadata:

```ts
async getMediaMetadata(filepath: string): Promise<{
  width: number; height: number; duration?: number; kind?: FileKind;
}>
```

- Tags: `ImageWidth`, `ImageHeight`, `Duration#`, `FileType`, `MIMEType`.
- `Duration#` returns a number for MP4/AVI (e.g. `2`), but an HMS string for WebM/MKV
  (`00:00:02.000000000`). `parseDuration` in `common/ExifIO.ts` normalizes both (plus
  formatted values such as `2.00 s`) to seconds.
- Verified against the bundled ExifTool 12.54: MP4, WebM, AVI and MKV all return
  width/height/duration (see [AUDIT.md](AUDIT.md) §2.2).

### D4 — Video thumbnails: embedded thumbnail → frame capture → placeholder

1. **Fast path:** ExifTool `-ThumbnailImage -b` / `-PhotoshopThumbnail -b` (existing
   `ExifIO.extractThumbnail`). Many camera files have an embedded poster.
2. **Frame capture:** a hidden `<video>` element in the renderer seeks to a small offset
   and draws the current frame to a `<canvas>`, then writes a WebP thumbnail. This works for
   codecs Chromium can decode (Electron 21 / Chromium 96: H.264/AAC in MP4/MOV, VP8/VP9/AV1
   in WebM, Theora in Ogg).
3. **Placeholder:** if neither works, write/copy a generic video placeholder image (or leave
   the thumbnail absent and let the UI show an icon). Never block the UI.

Do **not** add an FFmpeg dependency in phase 1. Revisit if unsupported codecs (MKV/AVI/WMV)
must be thumbnailed in-app; options are a bundled `ffmpeg-static` or WebCodecs in a worker.

### D5 — Playback via the browser, with external fallback

Use a plain `<video controls>` element for video files. Detect support with
`video.canPlayType(mimeType)` and the file extension. If the codec is unsupported, show the
poster thumbnail plus an "Open in external application" button (reuse the existing
`ImageFallback` pattern).

Do not route video through `ZoomPan`; pan/zoom is image-only. Use `object-fit: contain` and
native controls for the first iteration.

---

## 3. Workstream A — Extend image formats

### 3.1 Candidate formats

| Extension | Proposed handler | Decoder | Chromium 96 native? | Default | Effort | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `avif` | `web` | `createImageBitmap` / `<img>` | Yes (Chrome 85+) | On | XS | Verify on Linux/Windows Electron builds; add WASM fallback later if needed |
| `heic`, `heif` | `heicLoader` | `libheif-js` or `@jsquash/heic` (WASM) | No | Off | M | Needs WASM packaging + `custom.d.ts`; large images are memory-heavy |
| `jxl` | `jxlLoader` | `libjxl`/`jxl.js` (WASM) | No | Off | M | Experimental; Chrome never shipped JXL |
| `xcf` | `extractEmbeddedThumbnailOnly` | ExifTool embedded preview | No | Off | XS | GIMP; full-size unsupported (show preview + open externally) |
| `dng`, `cr2`, `cr3`, `nef`, `arw`, `orf`, `rw2`, `raf`, `pef`, `srw`, `x3f` | `extractEmbeddedThumbnailOnly` | ExifTool embedded preview | No | Off | S | Huge extension list; full-size unsupported in-app |
| `dds`, `tga`, `hdr`, `pnm`/`pbm`/`pgm`/`ppm`, `pcx`, `farbfeld` | `web`/`none` or small WASM | Various | No | Off | M | Low demand; add only if requested |
| `svg` | `none` (keep) | Original file via `<img>` | Yes | On | — | No thumbnail generated today; a huge SVG can be slow to load |
| `apng`, `bmp`, `ico`, `jfif` | `web` (keep) | Browser | Yes | On | — | Already work |
| `tif`, `tiff` | `tifLoader` (keep) | `utif` | n/a | On | — | Harden `TifLoader` (see M7) |
| `psd` | `psdLoader` (keep) | `ag-psd` | n/a | On | — | |
| `exr` | `exrLoader` (keep) | Rust/WASM | n/a | Off | — | Experimental badge already exists |

### 3.2 Phases

#### Phase A0 — Registry refactor (no user-visible change) — DONE

1. `src/api/file.ts`: add `IMAGE_EXTENSIONS`, `VIDEO_EXTENSIONS`, `FILE_EXTENSIONS`,
   `FileKind`, kind helpers, and deprecated `IMG_EXTENSIONS` aliases.
2. Migrate all consumers (see §3.3) from `IMG_EXTENSIONS` to the appropriate registry.
3. `FileDTO.extension` becomes `FILE_EXTENSIONS_TYPE` (or stays `IMAGE_EXTENSIONS_TYPE`
   until video lands; prefer the combined type now to avoid a second migration).
4. Add unit tests for the registries and helpers.

**Exit criteria:** existing formats behave exactly as before; `yarn test` passes.

#### Phase A1 — AVIF (browser-native)

1. Add `'avif'` to `IMAGE_EXTENSIONS`.
2. `IMAGE_HANDLERS.avif = 'web'`.
3. Verify `createImageBitmap` decodes AVIF in the thumbnail worker on all target OSes;
   if not, add a WASM fallback handler.
4. Add a small `.avif` fixture to `resources/test_images` and a manual checklist entry.

#### Phase A2 — Embedded-preview formats (XCF + RAW family)

1. Add `'xcf'` and the chosen RAW extensions to `IMAGE_EXTENSIONS`, default **off**.
2. Map them to `extractEmbeddedThumbnailOnly`.
3. `ImageLoader.getImageSrc` returns `undefined` for them, so full-size view shows the
   embedded thumbnail; add an "open externally" affordance if desired.
4. `ImageFormatPicker` marks them "preview only / experimental".
5. Add fixtures (one small RAW/XCF file) and a manual checklist.

#### Phase A3 — HEIC/HEIF and JPEG XL (WASM)

1. Add a decoder wrapper implementing the existing `Loader` interface
   (`init()` + `decode(buffer): Promise<ImageData>`).
2. Add WASM assets and `custom.d.ts` declarations.
3. Add extensions and handler mappings, default off (memory/CPU cost).
4. Add unit tests around the wrapper's error handling (missing WASM, corrupt input).
5. Re-evaluate after an Electron upgrade; newer Chromium may support AV1/HEIF natively.

#### Phase A4 — Harden existing loaders

- `TifLoader`: guard `BitsPerSample` absence/scalar; fall back to the first IFD with a
  decodable layout; handle `PhotometricInterpretation`.
- `ImageLoader.getImageResolution`: keep ExifTool as the primary source; keep the PSD
  fallback.
- `thumbnailGenerator.worker`: bound the queue; discard stale requests when scrolling fast.

### 3.3 File-by-file changes (image formats)

| File | Change |
| --- | --- |
| `src/api/file.ts` | Registries, types, kind helpers, `FileDTO` extension type |
| `src/frontend/image/ImageLoader.ts` | Split handler maps; add new handler cases; `needsThumbnail`; `getImageSrc`; `getImageResolution` |
| `src/frontend/image/HeicLoader.ts`, `src/frontend/image/JxlLoader.ts` (new) | WASM decoder wrappers |
| `src/frontend/image/util.ts` | Reuse `Loader` interface for new decoders |
| `src/frontend/image/TifLoader.ts` | Robustness fixes |
| `src/frontend/entities/File.ts` | `getMetaData` uses new metadata API; populate `duration` |
| `src/frontend/stores/LocationStore.ts` | Default extension sets; prefs migration |
| `src/frontend/stores/FileStore.ts` | `deleteFilesByExtension` type |
| `src/frontend/entities/Location.ts` | `extensions` type |
| `src/frontend/workers/folderWatcher.worker.ts` | Extension type |
| `src/frontend/containers/Settings/ImageFormatPicker.tsx` | Group by kind; per-format badges |
| `src/frontend/containers/AdvancedSearch/{data,Inputs}.tsx` | Extension dropdown includes all kinds |
| `src/frontend/containers/Outliner/LocationsPanel/LocationRecoveryDialog.tsx` | Use `FILE_EXTENSIONS` |
| `src/frontend/containers/Outliner/LocationsPanel/dnd.ts` | MIME map; accept new formats |
| `src/backend/config.ts` | Only if new indexed fields are added (not needed for extension values) |
| `README.md`, Help Center copy | Document supported formats |

---

## 4. Workstream B — Video support

### 4.1 Candidate extensions and codec expectations (Chromium 96 / Electron 21)

| Extension | MIME | Playable in-app? | Default | Notes |
| --- | --- | --- | --- | --- |
| `mp4`, `m4v` | `video/mp4` | Yes (H.264/AAC) | On | Most common |
| `mov` | `video/quicktime` | Yes (H.264) | On | |
| `webm` | `video/webm` | Yes (VP8/VP9/AV1) | On | |
| `ogv` | `video/ogg` | Yes (Theora) | Off | |
| `mkv` | `video/x-matroska` | No | Off | Poster via ExifTool/frame capture only when possible |
| `avi` | `video/x-msvideo` | No | Off | |
| `wmv` | `video/x-ms-wmv` | No | Off | |
| `flv` | `video/x-flv` | No | Off | |
| `ts`, `mts`, `m2ts` | `video/mp2t` | No | Off | |
| `3gp`, `3g2` | `video/3gpp` | Sometimes | Off | |

`canPlayType()` is the runtime source of truth; the table is a planning aid.

### 4.2 Phases

#### Phase B0 — Foundation — DONE

1. Registry changes from A0.
2. `FileDTO`: add `kind?: FileKind` and `duration?: number` (both non-indexed initially).
3. `ExifIO.getMediaMetadata` (D3); `ImageLoader.getImageResolution` delegates to it and
   returns `duration` when present.
4. `getMetaData` populates `kind` and `duration` from the extension/metadata.
5. `ImageLoader.needsThumbnail`: return `true` for video; keep GIF `false`.
6. Unit tests for metadata parsing and kind detection.

**Exit criteria:** no UI change yet; existing tests pass.

#### Phase B1 — Discovery and metadata

1. Default-enable `mp4`, `m4v`, `mov`, `webm` in `VIDEO_EXTENSIONS` (the Phase A0 registry
   already contains the full list).
2. `folderWatcher.worker` already filters by the extension list passed from
   `ClientLocation.extensions`; verify case-insensitive matching and dot-directory behavior.
3. `LocationStore.init` / `setSupportedImageExtensions`: handle defaults for new extensions
   and migrate existing `localStorage` prefs (merge defaults instead of
   `prefs.extensions || IMG_EXTENSIONS`).
4. `ImageFormatPicker`: add a "Video formats" fieldset with the same enable/disable and
   "remove disabled files" behavior (warn before deleting videos).
5. `AdvancedSearch`: include video extensions in the extension dropdown (grouped with
   `<optgroup>` if desired).

**Exit criteria:** videos appear in the library with correct dimensions/duration; existing
images unaffected.

#### Phase B2 — Poster thumbnails

1. New `src/frontend/image/VideoLoader.ts` implementing `Loader`-like behavior:
   - `ensureThumbnail(file, outputPath)`:
     a. `ExifIO.extractThumbnail` → convert to WebP (via `createImageBitmap` + canvas) →
        write.
     b. Else `captureFrame(absolutePath, outputPath)` (see below).
     c. Else copy a placeholder / throw.
   - `getImageSrc(file)`: return `file.absolutePath` (the `<video>` element will use it).
   - `canPlay(file)`: `document.createElement('video').canPlayType(mime) !== ''`.
2. `captureFrame` implementation sketch:

   ```ts
   async function captureFrame(videoPath: string, outputPath: string, timeout = 10_000) {
     const video = document.createElement('video');
     video.muted = true;
     video.preload = 'auto';
     video.src = encodeFilePath(videoPath);

     await once(video, 'loadedmetadata');
     const seekTo = Math.min(1, (video.duration || 2) * 0.1);
     video.currentTime = seekTo;
     await once(video, 'seeked');

     const canvas = document.createElement('canvas');
     canvas.width = video.videoWidth;
     canvas.height = video.videoHeight;
     canvas.getContext('2d')!.drawImage(video, 0, 0);

     const blob = await new Promise<Blob | null>((resolve) =>
       canvas.toBlob(resolve, `image/${thumbnailFormat}`, 0.75));
     if (!blob) throw new Error('Could not capture video frame');
     await fse.outputFile(outputPath, Buffer.from(await blob.arrayBuffer()));

     // Release decoder resources
     video.src = '';
     video.load();
   }
   ```

   Wrap in a concurrency limiter (1–2 simultaneous captures) and a timeout. Prefer
   `OffscreenCanvas` where available.
3. Wire `ensureThumbnail` case `'browserVideo'` in `ImageLoader`; update
   `Thumbnail`/`ZoomableImage` so they never try to load a video into an `<img>`.
4. Add `resources/test_images/sample.mp4` and `sample.webm` (tiny generated files) plus a
   manual checklist; note that binary fixtures should be kept small.

**Exit criteria:** video cells show poster thumbnails in all view modes; no jank while
scrolling large libraries (captures are queued and limited).

#### Phase B3 — Playback UI

1. New `src/frontend/containers/ContentView/SlideMode/VideoView.tsx`:
   - `<video src={absolutePath} poster={thumbnailPath} controls preload="metadata" />`
   - `object-fit: contain`, max dimensions of the container.
   - If `VideoLoader.canPlay(file)` is false, render the poster plus an
     "Open in external application" button (reuse `ImageFallback`).
2. `SlideMode/ZoomableImage`: branch on `isVideoExtension(file.extension)` and render
   `VideoView` instead of `ZoomPan`.
3. `Preview.tsx` inherits the behavior via `ContentView`.
4. Keyboard: keep previous/next navigation; optionally map space to play/pause inside
   `VideoView` (stop propagation so it does not trigger the global preview shortcut).
5. `ListItem`: show duration (`hh:mm:ss`) next to dimensions for videos.
6. `ImageInfo`: read and show `Duration`, `VideoFrameRate`, `CompressorName`, `MIMEType`.

**Exit criteria:** double-clicking a video opens slide mode and plays it (when the codec is
supported); unsupported videos show a clear fallback.

#### Phase B4 — Drag & drop and import

1. `dnd.ts`:
   - Add `EXTENSION_TO_MIME` (correct types: `image/jpeg`, `image/tiff`,
     `image/svg+xml`, `video/mp4`, …) and build `ALLOWED_FILE_DROP_TYPES` from it.
   - Accept `video/*` in `getDropData`; rename `testImage` → `testMedia`.
   - Generalize `storeDroppedImage` → `storeDroppedMedia` (same storage path).
2. `useClipboardImporter.ts`: accept `video/*` if clipboard import is desired.
3. Browser extension (`src/clipper/server.ts` + extension): add a generalized
   `import-media` endpoint; update the web extension to send video. **Optional / later** —
   the local server already stores arbitrary bytes, so the backend work is small, but the
   extension changes are out of this repo.

**Exit criteria:** dragging an MP4/WebM into a Location imports and indexes it.

#### Phase B5 — Search and polish (optional)

1. Add `kind` to the search criteria (`image` / `video`) and `duration` as a number
   criterion. This requires adding `kind` (and optionally `duration`) to the Dexie schema
   and a DB version bump.
2. Add a `FileKind` filter to the toolbar/search bar.
3. Consider per-kind default sort orders (e.g. duration for video).
4. Update Help Center copy.

### 4.3 File-by-file changes (video)

| File | Change |
| --- | --- |
| `src/api/file.ts` | `VIDEO_EXTENSIONS`, `FILE_EXTENSIONS`, `FileKind`, `FileDTO.kind`, `FileDTO.duration` |
| `common/ExifIO.ts` | `getMediaMetadata` with `Duration#`, `MIMEType`, `FileType` |
| `src/frontend/image/ImageLoader.ts` | Video handler cases; `needsThumbnail`; `getImageSrc`; delegate resolution |
| `src/frontend/image/VideoLoader.ts` (new) | Embedded thumbnail, frame capture, `canPlay` |
| `src/frontend/entities/File.ts` | `getMetaData` populates `kind`/`duration` |
| `src/frontend/containers/ContentView/SlideMode/VideoView.tsx` (new) | `<video>` player + fallback |
| `src/frontend/containers/ContentView/SlideMode/index.tsx` | Branch to `VideoView` |
| `src/frontend/containers/ContentView/ListItem.tsx` | Duration column |
| `src/frontend/components/ImageInfo.tsx` | Duration/codec/framerate fields |
| `src/frontend/containers/Settings/ImageFormatPicker.tsx` | Video fieldset |
| `src/frontend/containers/AdvancedSearch/{data,Inputs}.tsx` | Video extensions in dropdown |
| `src/frontend/containers/Outliner/LocationsPanel/dnd.ts` | MIME map, video acceptance |
| `src/frontend/hooks/useClipboardImporter.ts` | Accept video (optional) |
| `src/backend/config.ts` | Version 9 if `kind`/`duration` are indexed |
| `src/main.ts` | Drag-export icon for videos (fallback icon) |
| `resources/test_images/` | Tiny MP4/WebM fixtures |

---

## 5. Data model and database migration

- `FileDTO.extension`: change to `FILE_EXTENSIONS_TYPE`. Existing rows keep their string
  values; no migration needed.
- `FileDTO.kind`: optional, derived from extension. Storing it makes search/filter cheap;
  backfill in a Dexie upgrade if indexed.
- `FileDTO.duration`: optional number (seconds). Non-indexed initially.
- If `kind` and/or `duration` are indexed, add:

  ```ts
  {
    version: 9,
    collections: [{
      name: 'files',
      schema: '++id, ino, locationId, *tags, relativePath, &absolutePath, name, extension, kind, size, width, height, duration, dateAdded, dateModified, dateCreated',
    }],
    upgrade: (tx) => tx.table('files').toCollection().modify((file) => {
      file.kind = FILE_EXTENSION_KIND[file.extension] ?? 'image';
      return file;
    }),
  },
  ```

  Test the upgrade with an existing database before shipping.

---

## 6. Test plan

### Unit tests (Jest, node env)

- `tests/media-extensions.test.ts`
  - Registry completeness and uniqueness.
  - `getFileKind`, `isImageExtension`, `isVideoExtension`.
  - Every `IMAGE_EXTENSIONS_TYPE` has an `IMAGE_HANDLERS` entry and vice versa (and the
    same for video).
- `tests/mime-map.test.ts`
  - Extension→MIME correctness for all entries used by DnD.
- `tests/metadata.test.ts`
  - Parse ExifTool output for width/height/duration (mock `ExifIO`).
  - `getMetaData` populates `kind`/`duration`.
- Extend `tests/backend.test.ts` with `kind`/`duration` round-trips if indexed.

### Integration / manual

- Add tiny fixtures to `resources/test_images`:
  - `sample.mp4` (H.264, ~2 s, < 20 KB), `sample.webm` (VP9, ~2 s), `sample.mkv`.
  - `sample.avif`, `sample.heic`, `sample.xcf` (small) as they are implemented.
- Manual checklist in the README or Help Center:
  - Location scan finds each format.
  - Thumbnail is generated and displayed.
  - Full-size view works (image) or playback works (video).
  - Search by extension returns the file.
  - Disable/enable an extension and verify removal/re-discovery.
- Run on Windows, macOS and Linux if possible; codec support differs.

---

## 7. Risks and open questions

| Risk / question | Impact | Mitigation |
| --- | --- | --- |
| Electron 21 / Chromium 96 codec support is old | Some videos won't play; AVIF may need fallbacks | Runtime `canPlayType` detection + external fallback; plan Electron upgrade |
| Main-thread video frame capture can jank the UI | Poor UX on large libraries | Concurrency limiter (1–2), queue, timeout, keep videos out of the image worker pool |
| WASM decoders (HEIC/JXL) increase bundle size and memory | Larger app, potential OOM on big images | Default off; lazy-init; consider native decoders after Electron upgrade |
| RAW full-size decoding is out of scope | Users must open RAW files externally | Clear "preview only" labeling in settings |
| Existing `localStorage` extension prefs don't include new formats | New formats invisible until prefs reset | Merge defaults on load; add a "reset to defaults" affordance |
| Dexie schema change for `kind`/`duration` | Migration risk | Keep non-indexed initially; test version 9 upgrade |
| Browser extension changes are outside this repo | Video import via extension lags | Phase B4 is optional; local server already accepts arbitrary bytes |
| `nodeIntegration`/security posture | Not directly related, but new decoders increase attack surface | Keep decoders WASM/JS only; no new native modules without review |
| Test infrastructure cannot run DOM/worker/WASM | Pipeline regressions may slip | Add pure-logic tests; add manual checklist; consider Playwright later |

**Open questions for the product owner:**

1. Which video extensions should be enabled by default? (Recommended: `mp4`, `m4v`, `mov`,
   `webm`.)
2. Should unsupported videos show a placeholder or be hidden by default?
3. Is full-size RAW decoding required, or are embedded previews + external open enough?
4. Is browser-extension video import in scope for the first release?
5. Is an Electron upgrade a prerequisite for HEVC/AV1 playback?

---

## 8. Acceptance criteria

- [ ] All existing image formats continue to work (discovery, thumbnails, full-size view).
- [ ] Newly added image formats can be enabled/disabled in Settings and behave like existing
      formats where the decoder supports them.
- [ ] Video files can be enabled/disabled in Settings and are discovered by the watcher.
- [ ] Video dimensions and duration are stored and shown in the inspector/list.
- [ ] Video poster thumbnails are generated and shown in all view modes.
- [ ] Supported videos play in slide mode; unsupported videos show a poster + external-open
      fallback.
- [ ] Drag & drop accepts images and videos with correct MIME handling.
- [ ] Search by extension includes all enabled media kinds.
- [ ] Unit tests cover registries, MIME mapping and metadata parsing; manual checklist
      passes on at least one platform.
- [ ] No regression in `yarn test` / production build.

## 9. Rollback plan

- Each phase is independently revertible:
  - A0 registry refactor: revert to `IMG_EXTENSIONS`; behavior is unchanged.
  - A1–A4 image formats: remove the extension entries and handler mappings; defaults stay
    off for experimental formats.
  - B0–B3 video: remove `VIDEO_EXTENSIONS` defaults and the video handler; existing images
    are untouched. `kind`/`duration` are optional fields and can be ignored.
  - B4/B5: DnD/search changes are additive.
- Keep the deprecated `IMG_EXTENSIONS` alias until the migration is confirmed stable, then
  remove it in a cleanup PR.
