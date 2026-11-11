import { FILE_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from '../src/api/file';
import {
  DEFAULT_ENABLED_EXTENSIONS,
  DEFAULT_VIDEO_EXTENSIONS,
  PREFERENCES_VERSION,
  resolveEnabledExtensions,
  serializeEnabledExtensions,
} from '../src/frontend/stores/location-store-preferences';

describe('location store preferences', () => {
  it('enables all image formats except EXR and the default video formats when no prefs exist', () => {
    const enabled = resolveEnabledExtensions(null);

    for (const ext of IMAGE_EXTENSIONS) {
      if (ext === 'exr') {
        expect(enabled).not.toContain(ext);
      } else {
        expect(enabled).toContain(ext);
      }
    }
    for (const ext of DEFAULT_VIDEO_EXTENSIONS) {
      expect(enabled).toContain(ext);
    }
  });

  it('includes AVIF in the default image formats', () => {
    expect(resolveEnabledExtensions(null)).toContain('avif');
  });

  it('returns the defaults for missing or invalid JSON', () => {
    expect(resolveEnabledExtensions(null)).toEqual(DEFAULT_ENABLED_EXTENSIONS);
    expect(resolveEnabledExtensions('')).toEqual(DEFAULT_ENABLED_EXTENSIONS);
    expect(resolveEnabledExtensions('{invalid')).toEqual(DEFAULT_ENABLED_EXTENSIONS);
  });

  it('migrates pre-video preferences by enabling the default video formats once', () => {
    const prefs = JSON.stringify({ version: 1, extensions: ['jpg', 'png'] });

    const enabled = resolveEnabledExtensions(prefs);

    expect(enabled).toContain('jpg');
    expect(enabled).toContain('png');
    for (const ext of DEFAULT_VIDEO_EXTENSIONS) {
      expect(enabled).toContain(ext);
    }
  });

  it('preserves explicit choices for current preferences', () => {
    const prefs = JSON.stringify({
      version: PREFERENCES_VERSION,
      extensions: ['jpg', 'mp4'],
    });

    expect(resolveEnabledExtensions(prefs)).toEqual(['jpg', 'mp4']);
  });

  it('does not re-enable videos that were disabled in current preferences', () => {
    const prefs = JSON.stringify({
      version: PREFERENCES_VERSION,
      extensions: ['jpg', 'png'],
    });

    expect(resolveEnabledExtensions(prefs)).not.toContain('mp4');
  });

  it('serializes the current version and extensions', () => {
    const json = serializeEnabledExtensions(['jpg', 'mp4']);

    expect(JSON.parse(json)).toEqual({
      version: PREFERENCES_VERSION,
      extensions: ['jpg', 'mp4'],
    });
  });

  it('round-trips through serialize and resolve', () => {
    const enabled = new Set(DEFAULT_ENABLED_EXTENSIONS);
    const resolved = resolveEnabledExtensions(serializeEnabledExtensions(enabled));

    expect(resolved).toEqual([...enabled]);
  });

  it('covers every registered extension in the defaults or as an opt-in', () => {
    const defaultSet = new Set(DEFAULT_ENABLED_EXTENSIONS);
    const nonDefault = FILE_EXTENSIONS.filter((ext) => !defaultSet.has(ext));

    // Everything that is not enabled by default is opt-in; make sure the list is explicit.
    expect(nonDefault).toContain('exr');
    expect(nonDefault).toEqual(
      expect.arrayContaining(
        VIDEO_EXTENSIONS.filter((ext) => !DEFAULT_VIDEO_EXTENSIONS.includes(ext)),
      ),
    );
  });
});
