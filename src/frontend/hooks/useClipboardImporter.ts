import { useCallback, useEffect } from 'react';
import { RendererMessenger } from 'src/ipc/renderer';
import { AppToaster } from '../components/Toaster';
import UiStore from '../stores/UiStore';

const DEFAULT_FILE_NAME = 'image.png';

export function useClipboardImporter(uiStore: UiStore) {
  const pasteHandle = useCallback(
    (e: ClipboardEvent) => {
      const clipboardData = e.clipboardData;
      if (!clipboardData) {
        return;
      }
      const { items, files } = clipboardData;
      if (!items || items.length === 0) {
        return;
      }

      // Find the first supported media item
      let item: DataTransferItem | undefined;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/') || items[i].type.startsWith('video/')) {
          item = items[i];
          break;
        }
      }
      if (!item) {
        return;
      }

      const type = item.type;
      const blob = item.getAsFile();
      if (!blob) {
        return;
      }

      let fileName = `allusion_${Date.now()}`;
      const file = files && files.length > 0 ? files[0] : undefined;
      if (file && (file.type.startsWith('image/') || file.type.startsWith('video/'))) {
        fileName =
          file.name === DEFAULT_FILE_NAME ? `allusion_${file.lastModified}.png` : file.name;
      }

      const reader = new FileReader();
      const directory = uiStore.importDirectory;
      if (!directory) {
        AppToaster.show({
          message: 'Please choose a location. Settings>BackgroundProcesses>Browse',
          timeout: 5000,
        });
        return;
      }
      reader.addEventListener('loadend', async function (e) {
        const imgBase64 = e.target?.result?.toString();
        if (!imgBase64) {
          return;
        }
        if (!fileName.includes('.')) {
          let ext = (type.split('/')[1] || 'bin').toLowerCase();
          if (ext === 'jpeg') {
            ext = 'jpg';
          }
          if (ext === 'quicktime') {
            ext = 'mov';
          }
          if (ext === 'x-matroska') {
            ext = 'mkv';
          }
          fileName = `${fileName}.${ext}`;
        }
        await RendererMessenger.storeFile({
          directory,
          filenameWithExt: fileName,
          imgBase64,
        });
      });
      reader.readAsDataURL(blob);
    },
    [uiStore.importDirectory],
  );

  return useEffect(() => {
    document.body.addEventListener('paste', pasteHandle);
    return () => document.body.removeEventListener('paste', pasteHandle);
  }, [pasteHandle]);
}
