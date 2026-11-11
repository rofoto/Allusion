# Electron Upgrade Plan

> **Status:** planning (not started). Target: move Allusion off Electron 21 (Chromium 96, Node 16)
> to a supported Electron release with modern Chromium/Node, while preserving Linux AppImage builds
> and existing library behavior.

## 1. Current baseline (as of `ec91ecc9`)

| Component | Current | Notes |
| --- | --- | --- |
| Electron | `21.3.0` (devDependency, pinned) | Chromium 96, Node 16.x runtime; EOL and missing modern codecs/APIs |
| electron-builder | `23.6.0` | AppImage/NSIS/DMG packaging config in `package.json` |
| Node (dev/tooling) | `16.20.2` (`.mise.toml`) | Required for current native-module/build expectations; CI also Node 16-era |
| TypeScript | `4.9.5` | `ts-loader` 9, target/lib per `tsconfig.json` |
| Webpack | `5.75.0` | Two configs: `electron-main` + `electron-renderer` (`target: electron-renderer`, `asyncWebAssembly`) |
| React | `18.2.0` | MobX 6 frontend |
| Native/runtime deps | `chokidar@3.6.0`, `fs-extra`, `node-exiftool`, `ag-psd`, `utif`, `dexie@3` | `chokidar` drives folder watching in a worker; ExifTool is an external bundled binary |
| WASM | `wasm/packages/{masonry,exr}` committed | Loaded as async WebAssembly assets; COOP/COEP enabled |
| Security posture | `nodeIntegration: true`, `nodeIntegrationInWorker: true`, `contextIsolation: false`, `webSecurity: false` | Legacy; preload not used for isolation. Changing this is high-risk and should be staged |

**Primary build target:** Linux AppImage (`yarn package` → `dist/Allusion-<version>.AppImage`).
Windows/macOS configs exist but are not the current validation focus.

## 2. Goals

- Run on a **supported Electron** release (current stable at time of execution) with up-to-date
  Chromium (better AVIF/video codec behavior, security fixes) and a supported Node runtime.
- Keep **renderer `nodeIntegration` behavior working initially** (compatibility-first), then
  optionally harden (`contextIsolation`/preload) as a follow-up.
- Keep **WASM (masonry/exr), workers (watcher/thumbnail/PSD), ExifTool, DnD/clipboard, and
  IndexedDB** functioning.
- Keep `yarn test` (Jest 29, node env, `fake-indexeddb`) and **Linux AppImage packaging** passing.
- Update dev tooling (`.mise.toml`, CI, lockfile) to match the chosen Electron/Node pair.

## 3. Non-goals (for the upgrade project)

- Refactoring the app to `contextIsolation: true` / preload APIs in the same PR as the version
  bump (do as a staged follow-up once the app runs).
- Replacing Dexie, MobX, Webpack, or the media pipeline architecture.
- Upgrading ExifTool binaries (separate, low-risk task; can be bundled in if convenient).
- Adding HEVC/licensed codec support beyond what the target Electron/Chromium provides.

## 4. Key risks and breaking-change areas

| Area | Risk | Why |
| --- | --- | --- |
| **Node version jump (16 → 20/22+)** | High | Native module ABI changes; `chokidar`/fsevents behavior; Node API deprecations; worker `nodeIntegration` semantics. May require dependency updates and rebuilds. |
| **Chromium jump (96 → current)** | Medium/High | Codec/decoder differences (usually improvements), stricter autoplay/media policies, rendering/layout quirks, `file://`/CORS/COEP interactions. |
| **Electron API changes** | Medium | `BrowserWindow`/`webPreferences` defaults, `remote` removal (not used?), dialog/clipboard/shell API signatures, protocol/permission handling, `nativeTheme`, `app` lifecycle. |
| **electron-builder** | Medium | v23 → current has config/signing/notarization and packaging changes; AppImage target behavior may differ. |
| **Webpack/bundling** | Medium | `target: 'electron-renderer'`/`electron-main` with nodeIntegration relies on Node builtins; future Electron/security defaults may push toward `electron-preload`/isolated builds. Asset/wasm handling must keep working. |
| **Workers + nodeIntegration** | High | Folder watcher and thumbnail workers rely on Node/fs in renderer-worker context; behavior sensitive to Electron/webPreferences changes. |
| **WASM + COOP/COEP** | Low/Medium | Headers already set in `main.ts`; verify SIMD/threads assumptions unchanged. |
| **Linux/AppImage runtime** | Medium | Sandbox, `--no-sandbox` flags, GTK/lib dependencies, Wayland/X11 differences on newer Electron. |
| **Tests/CI** | Medium | Jest/ts-jest/Node version alignment; CI image/toolchain must match. |

## 5. Recommended strategy

1. **Compatibility-first, incremental jumps.** Do not jump 21 → latest in one shot if breakage is
   opaque. Move through intermediate major milestones (e.g. 22/24 → 28 → latest supported) with a
   green AppImage + smoke tests at each stop, or at least bisect to isolate breaks.
2. **Decouple concerns.** Upgrade Electron/electron-builder/Node toolchain first while keeping
   `nodeIntegration` and existing bundling targets; treat security hardening (`contextIsolation`)
   as a separate project once stable.
3. **Automate a smoke checklist.** Because renderer/DOM/worker behavior is not unit-tested, rely
   on a repeatable manual checklist (and consider Playwright/Electron test later).

## 6. Phased plan

### Phase 0 — Discovery and baseline (prerequisite)

- [ ] **Inventory Electron/Node API usage:** `BrowserWindow`/`webPreferences`, `ipcMain`/`ipcRenderer`,
  `dialog`, `shell`, `clipboard`, `nativeImage`, `screen`, `app`, `protocol`, `webContents`,
  `Menu`/`Tray`, `autoUpdater` usage in `src/main.ts`, `src/ipc/*`, preload (none today).
- [ ] **Inventory Node-in-renderer/worker usage:** `fs`, `path`, `child_process` (ExifTool),
  `worker_threads`/Web Workers, `Buffer`, `process` globals relied on by renderer bundles.
- [ ] **Record baseline behavior:** `yarn test`, `yarn production`, `yarn package` (AppImage),
  and manual smoke (launch, scan location, thumbnails for image+video, EXIF, slide playback,
  DnD/clipboard import, tag/search, preview window, settings persistence).
- [ ] **Capture environment matrix:** Linux distro/kernel, X11/Wayland, GPU driver (relevant for
  media decode).
- [ ] **Choose target version:** pick "latest stable Electron supported by chosen electron-builder"
  at execution time; document the Electron↔Node↔Chromium mapping and required dev Node version.

**Exit:** written inventory + chosen target + reproducible baseline.

### Phase 1 — Toolchain alignment (no Electron bump yet, if possible)

- [ ] Update **`.mise.toml`** and CI to a Node version compatible with the target Electron's
  native-module/tooling needs (often latest LTS). Keep app runtime unchanged in this phase if
  feasible.
- [ ] Bump **TypeScript** and **@types/node** as needed for newer Electron/Node typings (can be
  staged with Phase 2).
- [ ] Refresh **`yarn.lock`** in a controlled way; avoid opportunistic dependency churn.
- [ ] Ensure `yarn test` and AppImage build still pass on the new dev Node.

**Exit:** dev/CI toolchain ready for the target Electron.

### Phase 2 — electron-builder and packaging

- [ ] Upgrade **`electron-builder`** to a version compatible with the target Electron (review
  breaking changes: config schema, asar, extraResources handling, AppImage settings, fpm deps).
- [ ] Validate `extraResources` (ExifTool binaries, themes) and `files`/`asar` still package
  correctly.
- [ ] Confirm `yarn package` produces a working AppImage on Linux.

**Exit:** packaging works independently of the Electron runtime bump (or in lockstep if required).

### Phase 3 — Electron upgrade (incremental)

- [ ] Bump `electron` devDependency (and `@types` if used) to the chosen milestone; run
  `yarn install` to rebuild native bits as needed.
- [ ] Address compile/build breaks: webpack main/renderer configs, `tsconfig` lib/target,
  removed/changed Electron APIs, `remote` assumptions (none expected), preload/webPreferences
  deprecations.
- [ ] **Renderer compatibility:** keep `nodeIntegration: true`, `contextIsolation: false`,
  `nodeIntegrationInWorker: true` initially; explicitly set any new defaults that would break
  this (e.g. sandbox flags) only as needed for compatibility, documenting tradeoffs.
- [ ] **Workers:** verify folder watcher (chokidar/fs), thumbnail generator, PSD worker under the
  new Electron/Node.
- [ ] **WASM:** verify masonry/exr load and run (COOP/COEP headers, SIMD path).
- [ ] **Media:** re-verify AVIF decode, video poster capture, and `<video>` playback/fallback
  across formats (Chromium codec behavior may change).
- [ ] **Clipboard/DnD/file dialogs/shell/external open** and preview window IPC.
- [ ] Repeat at each intermediate milestone if doing a stepped upgrade.

**Exit:** app runs on target Electron with smoke checklist green and AppImage packaged.

### Phase 4 — Stabilization and regression fixes

- [ ] Fix behavioral regressions (focus, menus, tray, window controls, theme, zoom, drag export).
- [ ] Re-check `canPlayType`/thumbnail behavior for video containers that were borderline on
  Chromium 96.
- [ ] Run `yarn test`, `yarn lint`, `yarn production`, `yarn package`; update CI workflow.
- [ ] Update docs: `AGENTS.md` tech stack/snapshot, `ARCHITECTURE.md` process/security notes,
  `AUDIT.md` (M1 status), and this plan with actual target/commits.

**Exit:** releasable candidate on supported Electron.

### Phase 5 — Follow-ups (separate efforts)

- [ ] **Security hardening:** migrate to `contextIsolation: true`, `nodeIntegration: false`, add a
  preload with `contextBridge`, and move privileged fs/exif/shell operations behind IPC.
- [ ] **ExifTool refresh:** update bundled binaries and verify parsing.
- [ ] **Dependency modernization:** chokidar v4, etc., once runtime is stable.
- [ ] **Automated UI/media tests:** Playwright or Spectron-alternative for Electron.

## 7. Validation checklist (smoke)

- [ ] App launches (main + preview window), no console errors on init.
- [ ] Add/scan a location; images and videos (mp4/webm/mov/m4v and at least one "preview-only"
  container) are discovered with correct dimensions/duration.
- [ ] Thumbnails/posters generated and persist; missing/broken handling works.
- [ ] Gallery/list/masonry render; slide/preview playback works for supported codecs and falls
  back gracefully for unsupported ones.
- [ ] Tagging, search, saved searches, drag & drop and clipboard import work.
- [ ] Settings persist (enabled formats, theme, thumbnail dir); ExifTool read/write paths work.
- [ ] `yarn test` passes; Linux AppImage builds and runs on a clean environment.

## 8. References / notes

- Electron release cadence and version mapping: https://www.electronjs.org/docs/latest/tutorial/electron-timelines
- Breaking changes per major: https://www.electronjs.org/docs/latest/breaking-changes
- electron-builder: https://www.electron.build/
- Current app security posture is documented in `AGENTS/ARCHITECTURE.md` and `AGENTS/AUDIT.md`;
  this plan intentionally treats isolation hardening as a follow-up to reduce upgrade risk.