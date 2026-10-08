import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { PhotoFile, VideoFile } from 'react-native-vision-camera';
import { Linking, Platform } from 'react-native';
import { settingsService } from './SettingsService';
import { openGalleryApp } from '../utils/galleryApps';
import { SYSTEM_DEFAULT_GALLERY } from '../types';

const { StorageAccessFramework: SAF } = FileSystem;

// Pointer to the newest photo we saved, so the shutter thumbnail survives a
// restart. Stored with the folder it belongs to: a photo in the folder the
// user has since moved away from is not the thumbnail for the current one.
const LAST_PHOTO_KEY = '@secondshooter_last_photo';

interface LastPhotoRecord {
  uri: string;
  folderUri: string | null;
}

// The save folder we last failed to write to. This is how Settings knows a
// folder has stopped working: it's what actually happened on the last save,
// and it costs nothing - the alternative, listing the directory to see whether
// it still answers, is over a second on a large folder and hits the same
// provider the folder picker needs.
const FOLDER_ERROR_KEY = '@secondshooter_broken_folder';

// Vision Camera normally records to a temporary directory that can disappear
// if iOS interrupts the app before the Photos import finishes. Record into an
// app-owned Documents folder instead; an already-finalized clip can then be
// imported into Photos the next time Second Shooter launches.
const PENDING_VIDEO_DIR = FileSystem.documentDirectory
  ? `${FileSystem.documentDirectory}SecondShooterRecordings/`
  : null;

/**
 * The result of a save, whatever the destination.
 *
 * `asset` is only set for camera-roll saves - a folder save doesn't produce a
 * media library entry, so callers that just want to show the file (the
 * thumbnail, mainly) should use `uri`.
 */
export interface SavedMedia {
  uri: string;
  asset: MediaLibrary.Asset | null;
}

// Basename shared by every destination: sortable, and identifiable in a folder
// that isn't only ours.
function buildFileName(prefix: 'IMG' | 'VID', date: Date = new Date()): string {
  const pad = (value: number, length = 2) => String(value).padStart(length, '0');
  return [
    'SecondShooter',
    prefix,
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`,
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
    // Milliseconds, because a burst can put several shots in the same second.
    pad(date.getMilliseconds(), 3),
  ].join('_');
}

function toFileUri(path: string): string {
  return path.startsWith('file://') ? path : `file://${path}`;
}

class MediaService {
  // Serialises background saves so a burst lands in the gallery in capture
  // order instead of firing concurrent MediaStore writes
  private saveQueue: Promise<unknown> = Promise.resolve();

  /**
   * Save a photo without blocking the caller.
   *
   * Saving copies the file and (for the camera roll) inserts it into the media
   * store, which costs the better part of a second - long enough to stall the
   * next capture if it's awaited on the capture path.
   */
  savePhotoInBackground(
    photo: PhotoFile,
    onSaved?: (saved: SavedMedia | null) => void
  ): void {
    this.saveQueue = this.saveQueue
      .then(() => this.savePhoto(photo))
      .then((saved) => {
        onSaved?.(saved);
      })
      .catch((error) => {
        console.error('Background photo save failed:', error);
      });
  }

  /**
   * Save a photo to the folder the user picked, or the camera roll if they
   * haven't picked one.
   */
  async savePhoto(photo: PhotoFile): Promise<SavedMedia | null> {
    const saved = await this.save(photo.path, 'IMG', 'image/jpeg');
    if (saved) {
      // Remembered rather than searched for later - see getLastPhotoUri.
      await this.rememberLastPhoto(saved.uri);
    }
    return saved;
  }

  /**
   * Save a video to the folder the user picked, or the camera roll if they
   * haven't picked one.
   */
  async saveVideo(video: VideoFile): Promise<SavedMedia | null> {
    return this.save(video.path, 'VID', 'video/mp4');
  }

  /**
   * Give Vision Camera a persistent *directory* (not a filename). Its native
   * recorder creates and finalizes the file there instead of the temp cache.
   */
  async prepareVideoRecordingDirectory(): Promise<string> {
    if (!PENDING_VIDEO_DIR) {
      throw new Error('Persistent video storage is unavailable');
    }
    const info = await FileSystem.getInfoAsync(PENDING_VIDEO_DIR);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(PENDING_VIDEO_DIR, {
        intermediates: true,
      });
    }
    return PENDING_VIDEO_DIR;
  }

  /**
   * Import a finalized native recording. Only delete the recoverable source
   * after its destination save succeeds. An interrupted Photos import will be
   * retried on the next launch from our Documents folder.
   */
  async saveCompletedVideo(video: VideoFile): Promise<SavedMedia | null> {
    const saved = await this.saveVideo(video);
    if (saved && this.isPendingVideo(video.path)) {
      try {
        await FileSystem.deleteAsync(toFileUri(video.path), { idempotent: true });
      } catch (error) {
        // Safe failure: a duplicate import may be attempted on next launch,
        // but we never discard the only remaining copy.
        console.warn('[Media] Saved video but could not remove recovery source:', error);
      }
    }
    return saved;
  }

  private isPendingVideo(path: string): boolean {
    return Boolean(PENDING_VIDEO_DIR && toFileUri(path).startsWith(PENDING_VIDEO_DIR));
  }

  private pendingVideoRecovery: Promise<number> | null = null;

  /**
   * Recover clips that native Vision Camera managed to finalize but which
   * were not yet imported into Photos when the app was suspended/terminated.
   * Unfinalized/corrupt native output may not be recoverable; leave those
   * files intact rather than deleting them.
   */
  recoverPendingVideos(): Promise<number> {
    if (this.pendingVideoRecovery) return this.pendingVideoRecovery;

    const recovery = this.recoverPendingVideosOnce();
    this.pendingVideoRecovery = recovery;
    void recovery.finally(() => {
      this.pendingVideoRecovery = null;
    }).catch(() => {});
    return recovery;
  }

  private async recoverPendingVideosOnce(): Promise<number> {
    if (!PENDING_VIDEO_DIR) return 0;

    try {
      const dir = await FileSystem.getInfoAsync(PENDING_VIDEO_DIR);
      if (!dir.exists) return 0;

      const filenames = await FileSystem.readDirectoryAsync(PENDING_VIDEO_DIR);
      let recovered = 0;
      for (const filename of filenames) {
        if (!/\\.(mp4|mov)$/i.test(filename)) continue;
        const fileUri = `${PENDING_VIDEO_DIR}${filename}`;
        try {
          const info = await FileSystem.getInfoAsync(fileUri);
          if (!info.exists || info.isDirectory || !('size' in info) || !info.size) {
            continue;
          }

          // The file was generated by Vision Camera and is in the staging
          // directory. saveVideo only needs the path to re-import it.
          const saved = await this.saveCompletedVideo({ path: fileUri } as VideoFile);
          if (saved) {
            recovered += 1;
            console.log('[Media] Recovered interrupted video save:', saved.uri);
          }
        } catch (error) {
          console.warn('[Media] Could not recover pending video yet:', fileUri, error);
        }
      }
      return recovered;
    } catch (error) {
      console.error('[Media] Failed to scan unfinished video imports:', error);
      return 0;
    }
  }

  private async save(
    sourcePath: string,
    prefix: 'IMG' | 'VID',
    mimeType: string
  ): Promise<SavedMedia | null> {
    // A capture can land before the settings screen has ever been opened;
    // loadSettings is a no-op once they're in memory.
    const settings = await settingsService.loadSettings();
    const sourceUri = toFileUri(sourcePath);

    if (settings.saveFolderUri) {
      try {
        const uri = await this.saveToFolder(
          sourceUri,
          settings.saveFolderUri,
          buildFileName(prefix),
          mimeType
        );
        console.log('Media saved to folder:', uri);
        await this.setBrokenSaveFolder(null);
        return { uri, asset: null };
      } catch (error) {
        // The folder can be gone or its permission revoked, and nothing tells
        // the app until the write fails. Losing the shot would be the worse
        // outcome, so fall through to the camera roll - and remember, so
        // Settings can say where the photos are actually going.
        console.error(
          'Error saving to folder, falling back to camera roll:',
          error
        );
        await this.setBrokenSaveFolder(settings.saveFolderUri);
      }
    }

    const asset = await this.saveToCameraRoll(sourceUri);
    return asset ? { uri: asset.uri, asset } : null;
  }

  /**
   * Write into a folder the user picked, addressed by its SAF tree URI.
   *
   * There's no native file -> content:// copy in expo-file-system (its
   * `copyAsync` resolves the destination as a java File), so the bytes go
   * through base64. That means holding roughly 4/3 of the file in memory for
   * the duration - acceptable for stills on the background save queue.
   */
  private async saveToFolder(
    sourceUri: string,
    folderUri: string,
    baseName: string,
    mimeType: string
  ): Promise<string> {
    // createFileAsync takes the name *without* the extension and derives it
    // from the MIME type; it also de-duplicates names itself.
    const destinationUri = await SAF.createFileAsync(folderUri, baseName, mimeType);
    const contents = await FileSystem.readAsStringAsync(sourceUri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    await FileSystem.writeAsStringAsync(destinationUri, contents, {
      encoding: FileSystem.EncodingType.Base64,
    });
    return destinationUri;
  }

  private async saveToCameraRoll(
    sourceUri: string
  ): Promise<MediaLibrary.Asset | null> {
    try {
      const asset = await MediaLibrary.createAssetAsync(sourceUri);
      console.log('Media saved to camera roll:', asset.uri);
      return asset;
    } catch (error) {
      console.error('Error saving to camera roll:', error);
      throw error;
    }
  }

  // Save photo to the camera roll, ignoring the Save Location setting
  async savePhotoToGallery(photo: PhotoFile): Promise<MediaLibrary.Asset | null> {
    return this.saveToCameraRoll(toFileUri(photo.path));
  }

  // Save video to the camera roll, ignoring the Save Location setting
  async saveVideoToGallery(video: VideoFile): Promise<MediaLibrary.Asset | null> {
    return this.saveToCameraRoll(toFileUri(video.path));
  }

  // Save file by path to gallery
  async saveToGallery(filePath: string): Promise<MediaLibrary.Asset | null> {
    try {
      // Ensure file:// prefix
      const uri = filePath.startsWith('file://') ? filePath : `file://${filePath}`;
      const asset = await MediaLibrary.createAssetAsync(uri);
      console.log('File saved to gallery:', asset.uri);
      return asset;
    } catch (error) {
      console.error('Error saving file to gallery:', error);
      throw error;
    }
  }

  // Create album and move asset to it
  async saveToAlbum(
    asset: MediaLibrary.Asset,
    albumName: string = 'Second Shooter'
  ): Promise<void> {
    try {
      // Get or create album
      let album = await MediaLibrary.getAlbumAsync(albumName);

      if (!album) {
        album = await MediaLibrary.createAlbumAsync(albumName, asset, false);
      } else {
        await MediaLibrary.addAssetsToAlbumAsync([asset], album, false);
      }

      console.log('Asset added to album:', albumName);
    } catch (error) {
      console.error('Error adding asset to album:', error);
      // Don't throw - the file is already saved to camera roll
    }
  }

  // Check if we have media library permissions
  async checkPermissions(): Promise<boolean> {
    const { status } = await MediaLibrary.getPermissionsAsync();
    return status === 'granted';
  }

  // Request media library permissions
  async requestPermissions(): Promise<boolean> {
    const { status } = await MediaLibrary.requestPermissionsAsync();
    return status === 'granted';
  }

  // Get the most recent photo from the gallery
  async getLastPhoto(): Promise<MediaLibrary.Asset | null> {
    try {
      const hasPermission = await this.checkPermissions();
      if (!hasPermission) {
        console.log('No permission to access media library');
        return null;
      }

      const { assets } = await MediaLibrary.getAssetsAsync({
        first: 1,
        mediaType: MediaLibrary.MediaType.photo,
        sortBy: [MediaLibrary.SortBy.creationTime],
      });

      return assets.length > 0 ? assets[0] : null;
    } catch (error) {
      console.error('Error getting last photo:', error);
      return null;
    }
  }

  /**
   * URI of the most recent photo we saved, for the shutter-button thumbnail.
   * The camera roll's newest photo would be the wrong image once a folder is
   * set.
   *
   * A folder has no media store to query, and the obvious alternative - list
   * the folder and take the newest of our own files - is far too slow to sit
   * on this path. `SAF.readDirectoryAsync` is `DocumentFile.listFiles()`,
   * which queries every entry in the directory and marshals one URI string per
   * file across the bridge: measured at over a second for a folder of ~2000
   * files, on a path that runs whenever the save folder changes. So the URI is
   * written down at save time instead and simply read back here.
   *
   * The cost is that a folder we haven't saved to in this install shows no
   * thumbnail until the next capture. That's the right trade - it's a cold
   * start and one empty button, against a freeze every time the folder is
   * picked.
   */
  async getLastPhotoUri(): Promise<string | null> {
    const settings = await settingsService.loadSettings();

    const record = await this.readLastPhotoRecord();
    if (record && record.folderUri === settings.saveFolderUri) {
      return record.uri;
    }

    // No usable pointer. The camera roll can answer this cheaply (it's an
    // indexed query); a folder can't, so it waits for the next capture.
    if (settings.saveFolderUri) {
      return null;
    }

    const asset = await this.getLastPhoto();
    return asset?.uri ?? null;
  }

  /**
   * The save folder a write last failed against, or null if the last one
   * worked. Settings reads this to warn that photos are landing in the camera
   * roll instead of the chosen folder.
   */
  async getBrokenSaveFolder(): Promise<string | null> {
    if (this.brokenFolder === undefined) {
      try {
        this.brokenFolder = await AsyncStorage.getItem(FOLDER_ERROR_KEY);
      } catch (error) {
        console.error('Error reading broken folder marker:', error);
        this.brokenFolder = null;
      }
    }
    return this.brokenFolder;
  }

  /** Forget the failure - the user has re-picked a folder and it deserves a try. */
  async clearBrokenSaveFolder(): Promise<void> {
    await this.setBrokenSaveFolder(null);
  }

  // undefined until read back from storage, so a cold start doesn't report
  // "fine" before it knows.
  private brokenFolder: string | null | undefined = undefined;

  private async setBrokenSaveFolder(folderUri: string | null): Promise<void> {
    if (this.brokenFolder === folderUri) {
      return;
    }
    this.brokenFolder = folderUri;
    try {
      if (folderUri) {
        await AsyncStorage.setItem(FOLDER_ERROR_KEY, folderUri);
      } else {
        await AsyncStorage.removeItem(FOLDER_ERROR_KEY);
      }
    } catch (error) {
      console.error('Error recording broken folder marker:', error);
    }
  }

  private async rememberLastPhoto(uri: string): Promise<void> {
    try {
      const settings = await settingsService.loadSettings();
      const record: LastPhotoRecord = {
        uri,
        folderUri: settings.saveFolderUri,
      };
      await AsyncStorage.setItem(LAST_PHOTO_KEY, JSON.stringify(record));
    } catch (error) {
      // A lost pointer costs a blank thumbnail until the next shot, nothing
      // more - never let it fail the save.
      console.error('Error remembering last photo:', error);
    }
  }

  private async readLastPhotoRecord(): Promise<LastPhotoRecord | null> {
    try {
      const stored = await AsyncStorage.getItem(LAST_PHOTO_KEY);
      return stored ? (JSON.parse(stored) as LastPhotoRecord) : null;
    } catch (error) {
      console.error('Error reading last photo pointer:', error);
      return null;
    }
  }

  // Open the gallery app named by the `galleryApp` setting, or the device's
  // default one.
  async openGallery(): Promise<void> {
    try {
      // Android goes through the native module, because launching a *chosen*
      // app needs an explicit intent that Linking can't express. It also
      // covers 'system-default' - falling through to Linking below only
      // happens when the module isn't there at all.
      const settings = await settingsService.loadSettings();
      if (await openGalleryApp(settings.galleryApp)) {
        return;
      }

      // The chosen app may have been uninstalled since it was picked; the
      // system default is a better answer than nothing happening.
      if (settings.galleryApp !== SYSTEM_DEFAULT_GALLERY) {
        if (await openGalleryApp(SYSTEM_DEFAULT_GALLERY)) {
          return;
        }
      }

      if (Platform.OS === 'ios') {
        // Open iOS Photos app
        await Linking.openURL('photos-redirect://');
      } else {
        // Open Android Gallery/Photos
        await Linking.openURL('content://media/internal/images/media');
      }
    } catch (error) {
      console.error('Error opening gallery:', error);
      // Fallback: try to open the Photos app directly
      try {
        if (Platform.OS === 'ios') {
          await Linking.openURL('photos://');
        }
      } catch (fallbackError) {
        console.error('Fallback also failed:', fallbackError);
      }
    }
  }
}

// Export singleton instance
export const mediaService = new MediaService();
export default mediaService;
