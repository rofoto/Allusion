import fse from 'fs-extra';
import { action } from 'mobx';
import path from 'path';

import { retainArray } from 'common/core';
import { timeoutPromise } from 'common/timeout';
import { FILE_EXTENSIONS, FILE_EXTENSIONS_TYPE } from '../../../../api/file';
import { StoreFileMessage } from '../../../../ipc/messages';
import { RendererMessenger } from '../../../../ipc/renderer';
import { DnDAttribute } from '../../../contexts/TagDnDContext';
import { ClientFile } from '../../../entities/File';
import FileStore from '../../../stores/FileStore';

const EXTENSION_TO_MIME: Record<FILE_EXTENSIONS_TYPE, string> = {
  gif: 'image/gif',
  png: 'image/png',
  apng: 'image/apng',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  psd: 'image/vnd.adobe.photoshop',
  kra: 'application/x-krita',
  exr: 'image/x-exr',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
  ts: 'video/mp2t',
  mts: 'video/mp2t',
  m2ts: 'video/mp2t',
  '3gp': 'video/3gpp',
  '3g2': 'video/3gpp2',
};

const ALLOWED_FILE_DROP_TYPES = new Set(Object.values(EXTENSION_TO_MIME));

export function getExtensionFromPath(filePath: string): FILE_EXTENSIONS_TYPE | undefined {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return (FILE_EXTENSIONS as readonly string[]).includes(ext)
    ? (ext as FILE_EXTENSIONS_TYPE)
    : undefined;
}

function isSupportedFile(file: File): boolean {
  if (getExtensionFromPath(file.name || file.path || '')) {
    return true;
  }
  if (ALLOWED_FILE_DROP_TYPES.has(file.type)) {
    return true;
  }
  // Be permissive for generic media types; we'll validate by extension/name when possible.
  return file.type.startsWith('image/') || file.type.startsWith('video/');
}

export const isAcceptableType = (e: React.DragEvent) => {
  const { types, items, files } = e.dataTransfer;
  if (files && files.length > 0) {
    return Array.from(files).some(isSupportedFile);
  }
  if (items && items.length > 0) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        if (
          ALLOWED_FILE_DROP_TYPES.has(item.type) ||
          item.type.startsWith('image/') ||
          item.type.startsWith('video/')
        ) {
          return true;
        }
      }
    }
  }
  return Array.from(types).some(
    (type) =>
      ALLOWED_FILE_DROP_TYPES.has(type) ||
      type.startsWith('image/') ||
      type.startsWith('video/') ||
      type === 'text/html' ||
      type === 'text/plain',
  );
};

/** Returns the IDs of the files that match those in Allusion given dropData. Returns false if one or files has no matches */
export const findDroppedFileMatches = action(
  (dropData: (File | string)[], fs: FileStore): ClientFile[] | false => {
    const matches = dropData.map(
      (file) =>
        typeof file !== 'string' &&
        file.path &&
        fs.fileList.find((f) => f.absolutePath === file.path),
    );
    return matches.every((m): m is ClientFile => m instanceof ClientFile) ? matches : false;
  },
);

/**
 * Executed callback function while dragging over a target.
 *
 * Do not pass an expansive function into the sideEffect parameter. The dragOver
 * event is fired constantly unlike dragEnter which is only fired once.
 */
export function onDragOver(event: React.DragEvent<HTMLDivElement>): boolean {
  const dropTarget = event.currentTarget;

  const isFile = isAcceptableType(event);
  if (isFile) {
    event.dataTransfer.dropEffect = 'copy';
    event.preventDefault();
    event.stopPropagation();
    dropTarget.dataset[DnDAttribute.Target] = 'true';
    return true;
  }
  return false;
}

export function handleDragLeave(event: React.DragEvent<HTMLDivElement>) {
  const isFile = isAcceptableType(event);
  if (isFile) {
    event.dataTransfer.dropEffect = 'none';
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.dataset[DnDAttribute.Target] = 'false';
  }
}

export async function storeDroppedMedia(dropData: (string | File)[], directory: string) {
  for (const dataItem of dropData) {
    let fileData: StoreFileMessage | undefined;

    // Store file -> detected by watching the directory -> automatically imported
    if (dataItem instanceof File) {
      const buffer = dataItem.path ? await fse.readFile(dataItem.path) : dataItem;
      fileData = {
        directory,
        filenameWithExt: path.basename(dataItem.name || dataItem.path || 'media'),
        imgBase64: buffer.toString('base64'),
      };
    } else if (typeof dataItem === 'string') {
      // It's probably a URL, so we can download it to get the media data
      const { imgBase64, blob } = await mediaAsBase64(dataItem);
      const fallbackExt = blob.type.split('/')[1] || 'bin';
      const filename = getFilenameFromUrl(dataItem, 'media');
      const hasKnownExt = FILE_EXTENSIONS.some((ext) => filename.toLowerCase().endsWith(`.${ext}`));
      const filenameWithExt = hasKnownExt ? filename : `${filename}.${fallbackExt}`;
      fileData = { directory, imgBase64, filenameWithExt };
    }
    if (fileData) {
      const { imgBase64, filenameWithExt } = fileData;

      // Send base64 file to main process, get back filename where it is stored
      // So it can be tagged immediately
      // Filename will be incremented if file already exists, e.g. `image.jpg -> image 1.jpg`
      try {
        const reply = await RendererMessenger.storeFile({ directory, filenameWithExt, imgBase64 });
        console.log('Imported dropped file', reply.downloadPath);
      } catch (e) {
        console.error('Could not import file', e);
      }
    }
  }
}

/** Backwards-compatible alias. */
export const storeDroppedImage = storeDroppedMedia;

/** Tests whether a URL points to a supported media file */
async function testMedia(url: string, timeout: number = 2000): Promise<boolean> {
  try {
    const response = await timeoutPromise(timeout, fetch(url, { method: 'HEAD' }));
    const type = response.headers.get('content-type') || '';
    if (type.startsWith('image/') || type.startsWith('video/')) {
      return true;
    }
    // Fall back to a GET if HEAD is inconclusive
    if (!type) {
      const blob = await timeoutPromise(timeout, fetch(url));
      return blob.type.startsWith('image/') || blob.type.startsWith('video/');
    }
    return false;
  } catch (e) {
    try {
      const blob = await timeoutPromise(timeout, fetch(url));
      return blob.type.startsWith('image/') || blob.type.startsWith('video/');
    } catch {
      return false;
    }
  }
}

function mediaAsBase64(url: string): Promise<{ imgBase64: string; blob: Blob }> {
  return new Promise(async (resolve, reject) => {
    try {
      const response = await fetch(url);
      const blob = await response.blob();
      const reader = new FileReader();

      reader.onerror = reject;
      reader.onload = () =>
        reader.result
          ? resolve({ imgBase64: reader.result.toString(), blob })
          : reject('Could not convert to base64 file');
      reader.readAsDataURL(blob);
    } catch (e) {
      reject(e);
    }
  });
}

function getFilenameFromUrl(url: string, fallback: string) {
  if (url.startsWith('data:')) {
    return fallback;
  }
  try {
    const pathname = new URL(url).pathname;
    const index = pathname.lastIndexOf('/');
    const name = index !== -1 ? pathname.substring(index + 1) : pathname;
    return name || fallback;
  } catch {
    return fallback;
  }
}

export async function getDropData(e: React.DragEvent): Promise<Array<File | string>> {
  // Using a set to filter out duplicates. For some reason, dropping URLs duplicates them 3 times (for me)
  const dropItems = new Set<File | string>();

  // First get all files in the drop event
  if (e.dataTransfer.files.length > 0) {
    // tslint:disable-next-line: prefer-for-of
    for (let i = 0; i < e.dataTransfer.files.length; i++) {
      const file = e.dataTransfer.files[i];
      // Check if file is a supported media file
      if (isSupportedFile(file)) {
        dropItems.add(file);
      }
    }
  }

  if (e.dataTransfer.types.includes('text/html')) {
    const droppedHtml = e.dataTransfer.getData('text/html');
    const container = document.createElement('html');
    container.innerHTML = droppedHtml;
    const imgs = container.getElementsByTagName('img');
    if (imgs.length === 1) {
      const src = imgs[0].src;
      dropItems.add(src);
    }
    const videos = container.getElementsByTagName('video');
    if (videos.length === 1) {
      const src = videos[0].src || videos[0].querySelector('source')?.getAttribute('src');
      if (src) {
        dropItems.add(src);
      }
    }
    const sources = container.getElementsByTagName('source');
    if (sources.length === 1) {
      const src = sources[0].getAttribute('src');
      if (src) {
        dropItems.add(src);
      }
    }
  } else if (e.dataTransfer.types.includes('text/plain')) {
    const plainText = e.dataTransfer.getData('text/plain');
    // Check if text is an URL
    if (/^https?:\/\//i.test(plainText)) {
      dropItems.add(plainText);
    }
  }

  const items = Array.from(dropItems);
  // Filter out URLs that are not supported media
  const checks = await Promise.all(
    items.map(async (item) => {
      if (item instanceof File) {
        return true;
        // Check if the URL has a known media extension, or perform a network request
      } else if (FILE_EXTENSIONS.some((ext) => item.toLowerCase().includes(`.${ext}`))) {
        return true;
      } else {
        return await testMedia(item);
      }
    }),
  );
  // Remove all items that are not media from the array.
  retainArray(items, (_, i) => checks[i]);
  return items;
}
