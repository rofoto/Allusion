import {
  FILE_EXTENSIONS_TYPE,
  IMAGE_EXTENSIONS_TYPE,
  VIDEO_EXTENSIONS_TYPE,
  isImageExtension,
} from '../../api/file';

/** How an image format is decoded for thumbnails and full-size viewing. */
export type ImageHandlerType =
  | 'web'
  | 'tifLoader'
  | 'exrLoader'
  | 'psdLoader'
  | 'extractEmbeddedThumbnailOnly'
  | 'none';

/** How a video format is handled. Poster generation/playback is added in later phases. */
export type VideoHandlerType = 'video' | 'none';

/**
 * Maps every image extension to its handler.
 * Exhaustiveness is enforced by TypeScript: adding an extension requires a handler here.
 */
export const IMAGE_FORMAT_HANDLERS: Record<IMAGE_EXTENSIONS_TYPE, ImageHandlerType> = {
  gif: 'web',
  png: 'web',
  apng: 'web',
  jpg: 'web',
  jpeg: 'web',
  jfif: 'web',
  webp: 'web',
  bmp: 'web',
  ico: 'web',
  svg: 'none',
  tif: 'tifLoader',
  tiff: 'tifLoader',
  psd: 'psdLoader',
  kra: 'extractEmbeddedThumbnailOnly',
  // xcf: 'extractEmbeddedThumbnailOnly',
  exr: 'exrLoader',
  // avif: 'sharp',
};

/**
 * Maps every video extension to its handler.
 * Exhaustiveness is enforced by TypeScript: adding an extension requires a handler here.
 */
export const VIDEO_FORMAT_HANDLERS: Record<VIDEO_EXTENSIONS_TYPE, VideoHandlerType> = {
  mp4: 'video',
  m4v: 'video',
  mov: 'video',
  webm: 'video',
  ogv: 'video',
  mkv: 'video',
  avi: 'video',
  wmv: 'video',
  flv: 'video',
  ts: 'video',
  mts: 'video',
  m2ts: 'video',
  '3gp': 'video',
  '3g2': 'video',
};

/** Returns the format handler for a known file extension. */
export const getFormatHandler = (
  extension: FILE_EXTENSIONS_TYPE,
): ImageHandlerType | VideoHandlerType =>
  isImageExtension(extension) ? IMAGE_FORMAT_HANDLERS[extension] : VIDEO_FORMAT_HANDLERS[extension];
