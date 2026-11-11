import ExifIO from '../common/ExifIO';
import { readMetadata } from './mocks/node-exiftool';

jest.mock('node-exiftool', () => require('./mocks/node-exiftool'));

describe('ExifIO media metadata', () => {
  beforeEach(() => {
    readMetadata.mockReset();
  });

  it('reads width, height and duration for video files', async () => {
    readMetadata.mockResolvedValue({
      data: [{ ImageWidth: 320, ImageHeight: 240, Duration: 2 }],
      error: null,
    });

    const exifIO = new ExifIO();
    await expect(exifIO.getMediaMetadata('clip.mp4')).resolves.toEqual({
      width: 320,
      height: 240,
      duration: 2,
    });
  });

  it('reads a string duration returned by ExifTool', async () => {
    readMetadata.mockResolvedValue({
      data: [{ ImageWidth: 1920, ImageHeight: 1080, Duration: '2.5' }],
      error: null,
    });

    const exifIO = new ExifIO();
    await expect(exifIO.getMediaMetadata('clip.mov')).resolves.toEqual({
      width: 1920,
      height: 1080,
      duration: 2.5,
    });
  });

  it('parses formatted durations such as "2.00 s"', async () => {
    readMetadata.mockResolvedValue({
      data: [{ ImageWidth: 1920, ImageHeight: 1080, Duration: '2.00 s' }],
      error: null,
    });

    const exifIO = new ExifIO();
    await expect(exifIO.getMediaMetadata('clip.mp4')).resolves.toEqual({
      width: 1920,
      height: 1080,
      duration: 2,
    });
  });

  it('parses HMS durations returned for WebM/MKV files', async () => {
    readMetadata.mockResolvedValue({
      data: [{ ImageWidth: 1920, ImageHeight: 1080, Duration: '00:00:02.000000000' }],
      error: null,
    });

    const exifIO = new ExifIO();
    await expect(exifIO.getMediaMetadata('clip.webm')).resolves.toEqual({
      width: 1920,
      height: 1080,
      duration: 2,
    });
  });

  it('parses HMS durations with hours', async () => {
    readMetadata.mockResolvedValue({
      data: [{ ImageWidth: 1920, ImageHeight: 1080, Duration: '01:02:03' }],
      error: null,
    });

    const exifIO = new ExifIO();
    await expect(exifIO.getMediaMetadata('clip.mkv')).resolves.toEqual({
      width: 1920,
      height: 1080,
      duration: 3723,
    });
  });

  it('leaves duration undefined for images', async () => {
    readMetadata.mockResolvedValue({
      data: [{ ImageWidth: 800, ImageHeight: 600 }],
      error: null,
    });

    const exifIO = new ExifIO();
    await expect(exifIO.getMediaMetadata('photo.jpg')).resolves.toEqual({
      width: 800,
      height: 600,
      duration: undefined,
    });
  });

  it('returns zero dimensions when metadata cannot be read', async () => {
    readMetadata.mockResolvedValue({ data: null, error: 'No metadata entry' });

    const exifIO = new ExifIO();
    await expect(exifIO.getMediaMetadata('broken')).resolves.toEqual({
      width: 0,
      height: 0,
    });
  });
});
