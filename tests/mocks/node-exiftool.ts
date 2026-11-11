/**
 * Shared mock for the `node-exiftool` module.
 *
 * The real module spawns a long-running ExifTool child process, which we don't
 * want in unit tests. The `readMetadata` mock is shared with the test file so
 * tests can control and assert ExifTool calls.
 */
export const readMetadata = jest.fn();

export default {
  ExiftoolProcess: jest.fn().mockImplementation(() => ({
    readMetadata,
    _open: true,
  })),
};
