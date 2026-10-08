import { PhotoFile } from 'react-native-vision-camera';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { mediaService } from '../../services/MediaService';
import { settingsService } from '../../services/SettingsService';

const SAF = FileSystem.StorageAccessFramework as unknown as {
  createFileAsync: jest.Mock;
  readDirectoryAsync: jest.Mock;
};

const FOLDER = 'content://com.android.externalstorage.documents/tree/primary%3ADCIM%2FShoots';

const photo = { path: '/data/user/0/cache/capture.jpg' } as PhotoFile;

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  await settingsService.resetSettings();

  SAF.createFileAsync.mockResolvedValue(`${FOLDER}/document/SecondShooter_IMG.jpg`);
  (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue('BASE64DATA');
  (FileSystem.writeAsStringAsync as jest.Mock).mockResolvedValue(undefined);
  (MediaLibrary.createAssetAsync as jest.Mock).mockResolvedValue({
    uri: 'file:///storage/emulated/0/DCIM/Camera/roll.jpg',
  });
});

describe('savePhoto', () => {
  it('writes into the save folder when one is set', async () => {
    await settingsService.updateSetting('saveFolderUri', FOLDER);

    const saved = await mediaService.savePhoto(photo);

    expect(SAF.createFileAsync).toHaveBeenCalledWith(
      FOLDER,
      expect.stringContaining('SecondShooter_IMG_'),
      'image/jpeg'
    );
    expect(saved?.uri).toBe(`${FOLDER}/document/SecondShooter_IMG.jpg`);
    // A folder save produces no media library entry.
    expect(saved?.asset).toBeNull();
    expect(MediaLibrary.createAssetAsync).not.toHaveBeenCalled();
  });

  it('uses the camera roll when no folder is set', async () => {
    const saved = await mediaService.savePhoto(photo);

    expect(MediaLibrary.createAssetAsync).toHaveBeenCalledWith(`file://${photo.path}`);
    expect(saved?.uri).toBe('file:///storage/emulated/0/DCIM/Camera/roll.jpg');
    expect(SAF.createFileAsync).not.toHaveBeenCalled();
  });

  it('falls back to the camera roll rather than losing the shot', async () => {
    await settingsService.updateSetting('saveFolderUri', FOLDER);
    SAF.createFileAsync.mockRejectedValue(new Error('permission revoked'));

    const saved = await mediaService.savePhoto(photo);

    expect(saved?.uri).toBe('file:///storage/emulated/0/DCIM/Camera/roll.jpg');
  });
});

// Settings warns from this rather than probing the folder, because the probe
// was a full directory listing on the screen the picker is launched from.
describe('broken save folder', () => {
  it('is unset while saves are working', async () => {
    await settingsService.updateSetting('saveFolderUri', FOLDER);
    await mediaService.savePhoto(photo);

    await expect(mediaService.getBrokenSaveFolder()).resolves.toBeNull();
  });

  it('names the folder a save failed against', async () => {
    await settingsService.updateSetting('saveFolderUri', FOLDER);
    SAF.createFileAsync.mockRejectedValue(new Error('permission revoked'));

    await mediaService.savePhoto(photo);

    await expect(mediaService.getBrokenSaveFolder()).resolves.toBe(FOLDER);
  });

  it('clears once a save works again', async () => {
    await settingsService.updateSetting('saveFolderUri', FOLDER);
    SAF.createFileAsync.mockRejectedValueOnce(new Error('permission revoked'));
    await mediaService.savePhoto(photo);

    await mediaService.savePhoto(photo);

    await expect(mediaService.getBrokenSaveFolder()).resolves.toBeNull();
  });

  it('clears when the user re-picks a folder', async () => {
    await settingsService.updateSetting('saveFolderUri', FOLDER);
    SAF.createFileAsync.mockRejectedValue(new Error('permission revoked'));
    await mediaService.savePhoto(photo);

    await mediaService.clearBrokenSaveFolder();

    await expect(mediaService.getBrokenSaveFolder()).resolves.toBeNull();
  });

  it('never lists the folder to find out', async () => {
    await settingsService.updateSetting('saveFolderUri', FOLDER);
    SAF.createFileAsync.mockRejectedValue(new Error('permission revoked'));
    await mediaService.savePhoto(photo);

    await mediaService.getBrokenSaveFolder();

    expect(SAF.readDirectoryAsync).not.toHaveBeenCalled();
  });
});

describe('getLastPhotoUri', () => {
  it('returns the photo remembered for the current folder', async () => {
    await settingsService.updateSetting('saveFolderUri', FOLDER);
    const saved = await mediaService.savePhoto(photo);

    await expect(mediaService.getLastPhotoUri()).resolves.toBe(saved?.uri);
  });

  // The whole point of remembering the URI: listing a folder of a few thousand
  // files costs over a second, and this path runs whenever the folder changes.
  it('never lists the folder', async () => {
    await settingsService.updateSetting('saveFolderUri', FOLDER);
    await mediaService.savePhoto(photo);

    await mediaService.getLastPhotoUri();

    expect(SAF.readDirectoryAsync).not.toHaveBeenCalled();
  });

  it('ignores a photo remembered for a folder the user has moved away from', async () => {
    await settingsService.updateSetting('saveFolderUri', FOLDER);
    await mediaService.savePhoto(photo);

    await settingsService.updateSetting('saveFolderUri', `${FOLDER}Other`);

    await expect(mediaService.getLastPhotoUri()).resolves.toBeNull();
    expect(SAF.readDirectoryAsync).not.toHaveBeenCalled();
  });

  it('asks the media library when no folder is set and nothing is remembered', async () => {
    (MediaLibrary.getAssetsAsync as jest.Mock).mockResolvedValue({
      assets: [{ uri: 'file:///storage/emulated/0/DCIM/Camera/newest.jpg' }],
    });

    await expect(mediaService.getLastPhotoUri()).resolves.toBe(
      'file:///storage/emulated/0/DCIM/Camera/newest.jpg'
    );
  });
});


describe('interrupted video recording recovery', () => {
  const recoveryDir = `${FileSystem.documentDirectory}SecondShooterRecordings/`;
  const stagedFile = `${recoveryDir}clip.mov`;

  beforeEach(() => {
    (FileSystem.makeDirectoryAsync as jest.Mock).mockResolvedValue(undefined);
    (FileSystem.deleteAsync as jest.Mock).mockResolvedValue(undefined);
    (FileSystem.readDirectoryAsync as jest.Mock).mockResolvedValue(['clip.mov']);
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === recoveryDir) return { exists: true, isDirectory: true };
      if (uri === stagedFile) {
        return { exists: true, isDirectory: false, size: 1024 };
      }
      return { exists: false };
    });
  });

  it('records to a recoverable Documents directory', async () => {
    const path = await mediaService.prepareVideoRecordingDirectory();
    expect(path).toBe(recoveryDir);
    expect(FileSystem.makeDirectoryAsync).toHaveBeenCalledWith(recoveryDir, {
      intermediates: true,
    });
  });

  it('deletes staging only after successful Photos import', async () => {
    const saved = await mediaService.saveCompletedVideo({ path: stagedFile } as any);

    expect(saved?.uri).toBeTruthy();
    expect(MediaLibrary.createAssetAsync).toHaveBeenCalledWith(stagedFile);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(stagedFile, {
      idempotent: true,
    });
  });

  it('keeps the staged recording if Photos import fails', async () => {
    (MediaLibrary.createAssetAsync as jest.Mock).mockRejectedValueOnce(
      new Error('Photos temporarily unavailable')
    );

    await expect(
      mediaService.saveCompletedVideo({ path: stagedFile } as any)
    ).rejects.toThrow('Photos temporarily unavailable');

    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
  });

  it('recovers previously finalized clips on a later launch', async () => {
    const recovered = await mediaService.recoverPendingVideos();

    expect(recovered).toBe(1);
    expect(MediaLibrary.createAssetAsync).toHaveBeenCalledWith(stagedFile);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(stagedFile, {
      idempotent: true,
    });
  });

  it('does not try to import empty or unfinished staged files', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      if (uri === recoveryDir) return { exists: true, isDirectory: true };
      return { exists: true, isDirectory: false, size: 0 };
    });

    const recovered = await mediaService.recoverPendingVideos();

    expect(recovered).toBe(0);
    expect(MediaLibrary.createAssetAsync).not.toHaveBeenCalled();
    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
  });
});
