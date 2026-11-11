import { clamp } from 'common/core';
import { encodeFilePath } from 'common/fs';
import { thumbnailFormat } from 'common/config';
import fse from 'fs-extra';

export interface Loader extends Decoder {
  init: () => Promise<void>;
}

export interface Decoder {
  decode: (buffer: Buffer) => Promise<ImageData>;
}

/** Returns a string that can be used as img src attribute */
export async function getBlob(decoder: Decoder, path: string): Promise<string> {
  const buf = await fse.readFile(path);
  const data = await decoder.decode(buf);
  const blob = await new Promise<Blob>((resolve, reject) =>
    dataToCanvas(data).toBlob(
      (blob) => (blob !== null ? resolve(blob) : reject()),
      'image/avif',
      1.0,
    ),
  );
  return URL.createObjectURL(blob);
}

export async function generateThumbnail(
  decoder: Decoder,
  inputPath: string,
  outputPath: string,
  thumbnailSize: number,
): Promise<void> {
  // TODO: merge this functionality with the thumbnail worker: it's basically duplicate code
  const buffer = await fse.readFile(inputPath);
  const data = await decoder.decode(buffer);
  const sampledCanvas = getSampledCanvas(dataToCanvas(data), thumbnailSize);
  const quality = computeQuality(sampledCanvas, thumbnailSize);
  const blobBuffer = await new Promise<ArrayBuffer>((resolve, reject) =>
    sampledCanvas.toBlob(
      (blob) => (blob !== null ? resolve(blob.arrayBuffer()) : reject()),
      `image/${thumbnailFormat}`,
      quality, // Allows to further compress image
    ),
  );
  return fse.writeFile(outputPath, Buffer.from(blobBuffer));
}

/**
 * Generates a thumbnail for a video file by capturing a poster frame.
 * Runs on the renderer thread (needs a DOM <video> element and canvas).
 */
export async function generateVideoThumbnail(
  inputPath: string,
  outputPath: string,
  thumbnailSize: number,
): Promise<void> {
  const frameCanvas = await captureVideoFrame(inputPath);
  const sampledCanvas = getSampledCanvas(frameCanvas, thumbnailSize);
  const quality = computeQuality(sampledCanvas, thumbnailSize);
  const blobBuffer = await new Promise<ArrayBuffer>((resolve, reject) =>
    sampledCanvas.toBlob(
      (blob) => (blob !== null ? resolve(blob.arrayBuffer()) : reject()),
      `image/${thumbnailFormat}`,
      quality,
    ),
  );
  return fse.writeFile(outputPath, Buffer.from(blobBuffer));
}

function captureVideoFrame(inputPath: string): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    let settled = false;
    const cleanup = () => {
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
    const fail = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const succeed = () => {
      if (settled) {
        return;
      }
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (!width || !height) {
        fail(new Error('Video has no dimensions'));
        return;
      }
      settled = true;
      clearTimeout(timeout);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        cleanup();
        fail(new Error('Could not get canvas context'));
        return;
      }
      ctx.drawImage(video, 0, 0, width, height);
      cleanup();
      resolve(canvas);
    };

    const timeout = window.setTimeout(
      () => fail(new Error('Timed out capturing video frame')),
      15000,
    );

    video.muted = true;
    video.preload = 'auto';
    // Required in some environments to allow seeking/loading before play
    video.playsInline = true;

    video.addEventListener('error', () => {
      const mediaError = video.error;
      fail(
        new Error(
          mediaError ? `Video error ${mediaError.code}: ${mediaError.message}` : 'Video error',
        ),
      );
    });
    video.addEventListener('seeked', succeed, { once: true });
    video.addEventListener(
      'loadeddata',
      () => {
        // Seek a bit in to avoid black first frames; fall back to 0 for very short clips
        const duration = Number.isFinite(video.duration) ? video.duration : 0;
        const target = duration > 1 ? Math.min(1, duration * 0.1) : 0;
        if (target <= 0 || target >= duration) {
          // Capture current frame
          if (video.readyState >= 2) {
            succeed();
          } else {
            video.addEventListener('canplay', succeed, { once: true });
          }
          return;
        }
        try {
          video.currentTime = target;
        } catch (e) {
          // Some codecs/containers may not support seeking; capture what we have
          if (video.readyState >= 2) {
            succeed();
          } else {
            fail(e);
          }
        }
      },
      { once: true },
    );

    // Use a file URL so Chromium can stream/seek the local file
    video.src = encodeFilePath(inputPath);
  });
}

function dataToCanvas(data: ImageData): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = data.width;
  canvas.height = data.height;
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(data, 0, 0);
  return canvas;
}

function getSampledCanvas(canvas: HTMLCanvasElement, targetSize: number): HTMLCanvasElement {
  const [sx, sy, swidth, sheight] = getAreaOfInterest(canvas.width, canvas.height);
  const [scaledWidth, scaledHeight] = getScaledSize(swidth, sheight, targetSize);
  const sampledCanvas = document.createElement('canvas');
  sampledCanvas.width = scaledWidth;
  sampledCanvas.height = scaledHeight;
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const sampledCtx = sampledCanvas.getContext('2d')!;
  sampledCtx.drawImage(canvas, sx, sy, swidth, sheight, 0, 0, scaledWidth, scaledHeight);
  return sampledCanvas;
}

/** Dynamically computes the compression quality for a thumbnail based on how much it is scaled compared to the maximum target size */
function computeQuality(canvas: HTMLCanvasElement, targetSize: number): number {
  const minSize = Math.min(canvas.width, canvas.height);
  // A low minimum size needs to correspond to a high quality, to retain details when it is displayed as cropped
  return clamp(1 - minSize / targetSize, 0.5, 0.9);
}

/** Scales the width and height to be the targetSize in the largest dimension, while retaining the aspect ratio */
function getScaledSize(
  width: number,
  height: number,
  targetSize: number,
): [width: number, height: number] {
  const widthScale = targetSize / width;
  const heightScale = targetSize / height;
  const scale = Math.min(widthScale, heightScale);
  return [Math.floor(width * scale), Math.floor(height * scale)];
}

/** Cut out rectangle in center if image has extreme aspect ratios. */
function getAreaOfInterest(
  width: number,
  height: number,
): [sx: number, sy: number, swidth: number, sheight: number] {
  const aspectRatio = width / height;
  let w = width;
  let h = height;

  if (aspectRatio > 3) {
    w = Math.floor(height * 3);
  } else if (aspectRatio < 1 / 3) {
    h = Math.floor(width * 3);
  }
  return [Math.floor((width - w) / 2), Math.floor((height - h) / 2), w, h];
}
