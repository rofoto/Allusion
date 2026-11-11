import { ID } from './id';

export type FileDTO = {
  id: ID;
  /** Identifier for a file that persists after renaming/moving (retrieved from fs.Stats.ino) */
  ino: string;
  locationId: ID;
  /** Path relative to Location */
  relativePath: string;
  absolutePath: string;
  tags: ID[];
  /** When the file was imported into Allusion */
  dateAdded: Date;
  /** When the file was modified in Allusion, not related to OS modified date */
  dateModified: Date;
  /**
   * When the file was last indexed in Allusion: concerning the metadata and thumbnail.
   * If the system's modified date of the file exceeds this date, those properties shoudld be re-initialized
   **/
  dateLastIndexed: Date;

  /** Duplicate data; also exists as part of the absolutePath. Used for DB queries */
  name: string;
  /** in lowercase, without the dot */
  extension: FILE_EXTENSIONS_TYPE;
  /** Size in bytes */
  size: number;
  width: number;
  height: number;
  /** Duration in seconds. Only set for video files. */
  duration?: number;
  /** Date when this file was created (from the OS, not related to Allusion) */
  dateCreated: Date;
  /** Whether this file is an image or a video. Derived from the extension when indexing. */
  kind?: FileKind;
};

/** The kind of media a file contains. */
export type FileKind = 'image' | 'video';

export const IMAGE_EXTENSIONS = [
  'gif',
  'png',
  'apng',
  'jpg',
  'jpeg',
  'jfif',
  'webp',
  'avif',
  'tif',
  'tiff',
  'bmp',
  'ico',
  'svg',
  'psd',
  'kra',

  // 'xcf', // Gimp
  'exr', // OpenEXR
  // 'raw', there are many RAW file extensions :( https://fileinfo.com/filetypes/camera_raw
  // 'heic', // not supported by Sharp out of the box https://github.com/lovell/sharp/issues/2871
  // TODO: 'blend', raw, etc.?
] as const;

export const VIDEO_EXTENSIONS = [
  'mp4',
  'm4v',
  'mov',
  'webm',
  'ogv',
  'mkv',
  'avi',
  'wmv',
  'flv',
  'ts',
  'mts',
  'm2ts',
  '3gp',
  '3g2',
] as const;

/** Every file extension that Allusion can index, images and videos combined. */
export const FILE_EXTENSIONS = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS] as const;

export type IMAGE_EXTENSIONS_TYPE = (typeof IMAGE_EXTENSIONS)[number];
export type VIDEO_EXTENSIONS_TYPE = (typeof VIDEO_EXTENSIONS)[number];
export type FILE_EXTENSIONS_TYPE = (typeof FILE_EXTENSIONS)[number];

/** Maps every supported file extension to its media kind. */
export const FILE_EXTENSION_KIND: Record<FILE_EXTENSIONS_TYPE, FileKind> = {
  ...Object.fromEntries(IMAGE_EXTENSIONS.map((ext) => [ext, 'image'])),
  ...Object.fromEntries(VIDEO_EXTENSIONS.map((ext) => [ext, 'video'])),
} as Record<FILE_EXTENSIONS_TYPE, FileKind>;

/** Case-insensitive check whether an extension belongs to an image format. */
export const isImageExtension = (extension: string): extension is IMAGE_EXTENSIONS_TYPE =>
  (IMAGE_EXTENSIONS as readonly string[]).includes(extension.toLowerCase());

/** Case-insensitive check whether an extension belongs to a video format. */
export const isVideoExtension = (extension: string): extension is VIDEO_EXTENSIONS_TYPE =>
  (VIDEO_EXTENSIONS as readonly string[]).includes(extension.toLowerCase());

/** Returns the media kind for a known extension, or undefined for unknown extensions. */
export const getFileKind = (extension: string): FileKind | undefined =>
  isImageExtension(extension) ? 'image' : isVideoExtension(extension) ? 'video' : undefined;

/**
 * @deprecated Use `IMAGE_EXTENSIONS` or `FILE_EXTENSIONS` instead.
 */
export const IMG_EXTENSIONS = IMAGE_EXTENSIONS;
/**
 * @deprecated Use `IMAGE_EXTENSIONS_TYPE` or `FILE_EXTENSIONS_TYPE` instead.
 */
export type IMG_EXTENSIONS_TYPE = IMAGE_EXTENSIONS_TYPE;
