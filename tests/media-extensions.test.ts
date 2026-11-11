import {
  FILE_EXTENSIONS,
  FILE_EXTENSION_KIND,
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  getFileKind,
  isImageExtension,
  isVideoExtension,
} from '../src/api/file';
import {
  IMAGE_FORMAT_HANDLERS,
  VIDEO_FORMAT_HANDLERS,
  getFormatHandler,
} from '../src/frontend/image/format-handlers';

describe('media extension registry', () => {
  it('contains no duplicate extensions', () => {
    expect(new Set(FILE_EXTENSIONS).size).toBe(FILE_EXTENSIONS.length);
  });

  it('has no overlap between image and video extensions', () => {
    const videoExtensions = new Set<string>(VIDEO_EXTENSIONS);
    for (const extension of IMAGE_EXTENSIONS) {
      expect(videoExtensions.has(extension)).toBe(false);
    }
  });

  it('maps every extension to a kind', () => {
    for (const extension of FILE_EXTENSIONS) {
      expect(FILE_EXTENSION_KIND[extension]).toBeDefined();
    }
  });

  it('detects image extensions case-insensitively', () => {
    expect(isImageExtension('jpg')).toBe(true);
    expect(isImageExtension('JPG')).toBe(true);
    expect(isImageExtension('mp4')).toBe(false);
    expect(isImageExtension('unknown')).toBe(false);
  });

  it('detects video extensions case-insensitively', () => {
    expect(isVideoExtension('mp4')).toBe(true);
    expect(isVideoExtension('WEBM')).toBe(true);
    expect(isVideoExtension('jpg')).toBe(false);
    expect(isVideoExtension('unknown')).toBe(false);
  });

  it('returns the kind for a known extension', () => {
    expect(getFileKind('png')).toBe('image');
    expect(getFileKind('mp4')).toBe('video');
    expect(getFileKind('unknown')).toBeUndefined();
  });
});

describe('format handlers', () => {
  it('has exactly one handler for every image extension', () => {
    for (const extension of IMAGE_EXTENSIONS) {
      expect(IMAGE_FORMAT_HANDLERS[extension]).toBeDefined();
    }
    expect(Object.keys(IMAGE_FORMAT_HANDLERS).sort()).toEqual([...IMAGE_EXTENSIONS].sort());
  });

  it('has exactly one handler for every video extension', () => {
    for (const extension of VIDEO_EXTENSIONS) {
      expect(VIDEO_FORMAT_HANDLERS[extension]).toBeDefined();
    }
    expect(Object.keys(VIDEO_FORMAT_HANDLERS).sort()).toEqual([...VIDEO_EXTENSIONS].sort());
  });

  it('resolves the handler for an extension', () => {
    expect(getFormatHandler('jpg')).toBe('web');
    expect(getFormatHandler('tif')).toBe('tifLoader');
    expect(getFormatHandler('psd')).toBe('psdLoader');
    expect(getFormatHandler('mp4')).toBe('video');
  });
});
