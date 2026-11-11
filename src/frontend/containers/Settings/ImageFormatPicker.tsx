import { observer } from 'mobx-react-lite';
import React, { ReactNode, useCallback, useState } from 'react';
import {
  FILE_EXTENSIONS,
  FILE_EXTENSIONS_TYPE,
  IMAGE_EXTENSIONS,
  IMAGE_EXTENSIONS_TYPE,
  isVideoExtension,
  VIDEO_EXTENSIONS,
  VIDEO_EXTENSIONS_TYPE,
} from 'src/api/file';
import { RendererMessenger } from 'src/ipc/renderer';
import { Button, Checkbox, IconSet, Toggle } from 'widgets';
import { Callout } from 'widgets/notifications';
import { useStore } from '../../contexts/StoreContext';

export const ImageFormatPicker = observer(() => {
  const { locationStore, fileStore } = useStore();

  const [removeDisabledFiles, setRemoveDisabledFiles] = useState(true);
  const toggleRemoveDisabledFiles = useCallback(() => setRemoveDisabledFiles((val) => !val), []);

  const [newEnabledFileExtensions, setNewEnabledFileExtensions] = useState(
    new Set(locationStore.enabledFileExtensions),
  );
  const toggleExtension = useCallback(
    (ext: FILE_EXTENSIONS_TYPE) => {
      const newNewEnabledFileExtensions = new Set(newEnabledFileExtensions);
      if (newEnabledFileExtensions.has(ext)) {
        newNewEnabledFileExtensions.delete(ext);
      } else {
        newNewEnabledFileExtensions.add(ext);
      }
      setNewEnabledFileExtensions(newNewEnabledFileExtensions);
    },
    [newEnabledFileExtensions],
  );

  const onSubmit = useCallback(async () => {
    const extensionsToDelete = FILE_EXTENSIONS.filter((ext) => !newEnabledFileExtensions.has(ext));

    if (removeDisabledFiles) {
      const disabledVideos = extensionsToDelete.filter((ext) => isVideoExtension(ext));
      const shouldDeleteFiles =
        disabledVideos.length === 0 ||
        window.confirm(
          `You are disabling video formats (${disabledVideos.join(
            ', ',
          )}). Delete all matching video files from Allusion?`,
        );

      if (shouldDeleteFiles) {
        for (const ext of extensionsToDelete) {
          await fileStore.deleteFilesByExtension(ext);
        }
      }
    }

    locationStore.setSupportedImageExtensions(newEnabledFileExtensions);

    window.alert('Allusion will restart to load your new preferences.');

    RendererMessenger.reload();
  }, [fileStore, locationStore, newEnabledFileExtensions, removeDisabledFiles]);

  // TODO: group extensions by type: JPG+JPEG+JFIF, TIF+TIFF, etc
  return (
    <>
      <fieldset>
        <legend>Image formats to be discovered by Allusion in your Locations</legend>
        <div className="checkbox-set-container">
          {IMAGE_EXTENSIONS.map((ext) => (
            <Checkbox
              key={ext}
              checked={newEnabledFileExtensions.has(ext)}
              onChange={() => toggleExtension(ext)}
            >
              {ext}
              {imageFormatInts[ext] && <> {imageFormatInts[ext]}</>}
            </Checkbox>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>Video formats to be discovered by Allusion in your Locations</legend>
        <div className="checkbox-set-container">
          {VIDEO_EXTENSIONS.map((ext) => (
            <Checkbox
              key={ext}
              checked={newEnabledFileExtensions.has(ext)}
              onChange={() => toggleExtension(ext)}
            >
              {ext}
              {videoFormatInts[ext] && <> {videoFormatInts[ext]}</>}
            </Checkbox>
          ))}
        </div>
        <Callout icon={IconSet.INFO}>
          Playback depends on your platform&apos;s codecs. Unsupported formats can still be tagged
          and opened with an external application.
        </Callout>
      </fieldset>

      <Toggle checked={removeDisabledFiles} onChange={toggleRemoveDisabledFiles}>
        Remove files with disabled extensions after save
      </Toggle>

      <Button
        text="Reset"
        onClick={() => setNewEnabledFileExtensions(new Set(locationStore.enabledFileExtensions))}
      />
      <Button
        text="Save"
        styling="filled"
        onClick={onSubmit}
        disabled={
          newEnabledFileExtensions.size === 0 ||
          // Disabled if identical
          (newEnabledFileExtensions.size === locationStore.enabledFileExtensions.size &&
            Array.from(newEnabledFileExtensions.values()).every((ext) =>
              locationStore.enabledFileExtensions.has(ext),
            ))
        }
      />
    </>
  );
});

const imageFormatInts: Partial<Record<IMAGE_EXTENSIONS_TYPE, ReactNode>> = {
  exr: (
    <span
      // TODO: Get TooltipLayer working in PopupWindow: tried a bunch of things but no bueno
      title="Experimental: May slow down the application when enabled (disabled by default)"
      className="info-icon"
    >
      {IconSet.WARNING}
    </span>
  ),
};

const videoFormatInts: Partial<Record<VIDEO_EXTENSIONS_TYPE, ReactNode>> = {
  mkv: <PreviewOnlyHint />,
  avi: <PreviewOnlyHint />,
  wmv: <PreviewOnlyHint />,
  flv: <PreviewOnlyHint />,
  ts: <PreviewOnlyHint />,
  mts: <PreviewOnlyHint />,
  m2ts: <PreviewOnlyHint />,
};

function PreviewOnlyHint() {
  return (
    <span title="Preview only: playback may require an external application" className="info-icon">
      {IconSet.WARNING}
    </span>
  );
}
