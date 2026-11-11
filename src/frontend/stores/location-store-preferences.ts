import { FILE_EXTENSIONS_TYPE, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS_TYPE } from '../../api/file';

export const PREFERENCES_STORAGE_KEY = 'location-store-preferences';

/**
 * Preferences schema version.
 *
 * Version 2 introduced default video formats. Preferences stored by older versions are
 * migrated once by enabling the default video extensions.
 */
export const PREFERENCES_VERSION = 2;

/** Video formats that are enabled by default. */
export const DEFAULT_VIDEO_EXTENSIONS: VIDEO_EXTENSIONS_TYPE[] = ['mp4', 'm4v', 'mov', 'webm'];

/** Extensions used when no preferences have been stored yet. */
export const DEFAULT_ENABLED_EXTENSIONS: FILE_EXTENSIONS_TYPE[] = [
  // EXR is experimental and therefore disabled by default
  ...IMAGE_EXTENSIONS.filter((ext) => ext !== 'exr'),
  ...DEFAULT_VIDEO_EXTENSIONS,
];

export type LocationPreferences = {
  version?: number;
  extensions?: FILE_EXTENSIONS_TYPE[];
};

/**
 * Resolves the enabled extensions from a stored preferences JSON string.
 * Falls back to {@link DEFAULT_ENABLED_EXTENSIONS} when the string is missing or invalid.
 *
 * Preferences created before video support (version < 2) are migrated by enabling the
 * default video extensions once. After the user saves their preferences, the current
 * version is stored, so their explicit choices are preserved.
 */
export function resolveEnabledExtensions(preferencesJson: string | null): FILE_EXTENSIONS_TYPE[] {
  try {
    const prefs = JSON.parse(preferencesJson || '') as LocationPreferences;
    if (!prefs.extensions) {
      return [...DEFAULT_ENABLED_EXTENSIONS];
    }

    const extensions = [...prefs.extensions] as FILE_EXTENSIONS_TYPE[];
    if ((prefs.version ?? 1) < PREFERENCES_VERSION) {
      for (const ext of DEFAULT_VIDEO_EXTENSIONS) {
        if (!extensions.includes(ext)) {
          extensions.push(ext);
        }
      }
    }
    return extensions;
  } catch (e) {
    return [...DEFAULT_ENABLED_EXTENSIONS];
  }
}

/** Serializes the enabled extensions for storage. */
export function serializeEnabledExtensions(extensions: Iterable<FILE_EXTENSIONS_TYPE>): string {
  return JSON.stringify(
    {
      version: PREFERENCES_VERSION,
      extensions: Array.from(extensions),
    } as LocationPreferences,
    null,
    2,
  );
}
