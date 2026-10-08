import { useState, useCallback, useRef } from 'react';
import { AppState } from 'react-native';
import { Camera, PhotoFile, VideoFile } from 'react-native-vision-camera';
import { CameraState, FlashMode, CaptureMode, CameraFacing } from '../types';
import { mediaService, SavedMedia } from '../services/MediaService';

const DEFAULT_STATE: CameraState = {
  zoom: 1,
  flash: 'off',
  facing: 'back',
  captureMode: 'photo',
  isRecording: false,
};

export function useCamera(initialState?: Partial<CameraState>) {
  const cameraRef = useRef<Camera>(null);
  const [state, setState] = useState<CameraState>({
    ...DEFAULT_STATE,
    ...initialState,
  });

  // Update individual state properties
  const updateState = useCallback((updates: Partial<CameraState>) => {
    setState((prev) => ({ ...prev, ...updates }));
  }, []);

  // Set zoom level (0.5-10, supports ultra-wide)
  const setZoom = useCallback((zoom: number) => {
    const clampedZoom = Math.max(0.5, Math.min(10, zoom));
    updateState({ zoom: clampedZoom });
  }, [updateState]);

  // Set flash mode
  const setFlash = useCallback((flash: FlashMode) => {
    updateState({ flash });
  }, [updateState]);

  // Toggle flash through modes
  // Use functional update to avoid stale closure issues
  const toggleFlash = useCallback(() => {
    const modes: FlashMode[] = ['off', 'on', 'auto'];
    setState((prev) => {
      const currentIndex = modes.indexOf(prev.flash);
      const nextIndex = (currentIndex + 1) % modes.length;
      return { ...prev, flash: modes[nextIndex] };
    });
  }, []);

  // Set camera facing
  const setFacing = useCallback((facing: CameraFacing) => {
    updateState({ facing });
  }, [updateState]);

  // Switch camera between front and back
  // Use functional update to avoid stale closure issues
  const switchCamera = useCallback(() => {
    setState((prev) => ({
      ...prev,
      facing: prev.facing === 'back' ? 'front' : 'back',
    }));
  }, []);

  // Set capture mode
  const setCaptureMode = useCallback((captureMode: CaptureMode) => {
    updateState({ captureMode });
  }, [updateState]);

  // Guard against concurrent takePhoto calls (e.g. double volume button events)
  const isCapturingRef = useRef(false);

  // Take photo with retry for Android ImageCapture binding race.
  // Resolves as soon as the capture completes; `onPhotoSaved` fires later,
  // when the background gallery save finishes.
  const takePhoto = useCallback(async (
    onPhotoSaved?: (saved: SavedMedia | null) => void
  ): Promise<PhotoFile | null> => {
    if (!cameraRef.current) {
      console.error('Camera ref not set');
      return null;
    }

    if (isCapturingRef.current) {
      return null;
    }
    isCapturingRef.current = true;

    const capture = async () => {
      const photo = await cameraRef.current!.takePhoto({
        flash: state.flash === 'auto' ? 'on' : state.flash,
        enableShutterSound: false,
      });
      // Saving is slow (file copy, plus a media store insert for the camera
      // roll) and nothing on the capture path needs it to finish, so it runs
      // in the background - the camera is free for the next shot immediately.
      mediaService.savePhotoInBackground(photo, onPhotoSaved);
      return photo;
    };

    try {
      return await capture();
    } catch (error) {
      // Android's ImageCapture may not be fully bound yet after camera reactivation.
      // Retry once after a brief delay.
      const msg = error instanceof Error ? error.message : String(error);
      if (
        msg.includes('Not bound to a valid Camera') ||
        msg.includes('ImageCapture') ||
        msg.includes('Failure to submit capture request')
      ) {
        await new Promise(resolve => setTimeout(resolve, 500));
        return await capture();
      }
      throw error;
    } finally {
      isCapturingRef.current = false;
    }
  }, [state.flash]);

  // Take a quick snapshot for preview streaming (doesn't save to gallery)
  const takeSnapshot = useCallback(async (): Promise<string | null> => {
    if (!cameraRef.current) {
      return null;
    }

    try {
      const snapshot = await cameraRef.current.takeSnapshot({
        // This image is only a temporary remote reference, never the saved
        // photo. Keep it small so preview traffic cannot dominate controls.
        quality: 20,
      });
      return snapshot.path;
    } catch {
      return null;
    }
  }, []);

  // A synchronous ref is critical for AppState callbacks: they can fire before
  // React has rendered the isRecording state after START_RECORDING, or while
  // a Stop is already in progress.
  const isRecordingRef = useRef(false);
  const stopInFlightRef = useRef<Promise<void> | null>(null);
  const recordingFinishedRef = useRef<{
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: unknown) => void;
  } | null>(null);

  // Start video recording
  const startRecording = useCallback(async (
    onFinished?: (video: VideoFile) => void,
    onError?: (error: unknown) => void
  ): Promise<void> => {
    if (!cameraRef.current) {
      throw new Error('Camera ref not set');
    }

    if (isRecordingRef.current || stopInFlightRef.current) {
      console.warn('Already recording/stopping');
      return;
    }

    // Preparing the folder can cross a foreground/background transition. Never
    // start a fresh native camera recording after iOS has begun suspending us.
    const directory = await mediaService.prepareVideoRecordingDirectory();
    if (AppState.currentState !== 'active' || !cameraRef.current) {
      throw new Error('Camera app is no longer active');
    }

    let resolveFinished!: () => void;
    let rejectFinished!: (error: unknown) => void;
    const finished = new Promise<void>((resolve, reject) => {
      resolveFinished = resolve;
      rejectFinished = reject;
    });
    // A native error may precede a Stop caller awaiting this Promise.
    void finished.catch(() => {});
    const completion = {
      promise: finished,
      resolve: resolveFinished,
      reject: rejectFinished,
    };
    recordingFinishedRef.current = completion;
    isRecordingRef.current = true;
    updateState({ isRecording: true });

    try {
      await cameraRef.current.startRecording({
        path: directory,
        flash: state.flash === 'auto' ? 'on' : state.flash,
        onRecordingFinished: async (video) => {
          isRecordingRef.current = false;
          updateState({ isRecording: false });

          try {
            const saved = await mediaService.saveCompletedVideo(video);
            if (!saved) {
              throw new Error('Video could not be imported; recoverable copy was kept');
            }
            onFinished?.(video);
            completion.resolve();
          } catch (error) {
            console.error('[CAMERA] Video import failed; keeping recovery copy:', error);
            completion.reject(error);
            onError?.(error);
          } finally {
            if (recordingFinishedRef.current === completion) {
              recordingFinishedRef.current = null;
            }
          }
        },
        onRecordingError: (error) => {
          isRecordingRef.current = false;
          updateState({ isRecording: false });
          console.error('Recording error:', error);
          completion.reject(error);
          if (recordingFinishedRef.current === completion) {
            recordingFinishedRef.current = null;
          }
          onError?.(error);
        },
      });
    } catch (error) {
      isRecordingRef.current = false;
      updateState({ isRecording: false });
      completion.reject(error);
      if (recordingFinishedRef.current === completion) {
        recordingFinishedRef.current = null;
      }
      throw error;
    }
  }, [state.flash, updateState]);

  // Stop video recording. Deduplicate commands from the controller, shutter,
  // foreground transitions, and navigation so the native recorder sees one
  // Stop. Wait for onRecordingFinished AND the media import, not just the
  // initial stopRecording native request.
  const stopRecording = useCallback(async (): Promise<void> => {
    if (stopInFlightRef.current) return stopInFlightRef.current;

    if (!isRecordingRef.current) {
      return recordingFinishedRef.current?.promise;
    }

    const camera = cameraRef.current;
    if (!camera) {
      throw new Error('Recording camera is no longer mounted');
    }

    const completed = recordingFinishedRef.current?.promise;
    const stopTask = (async () => {
      await camera.stopRecording();
      if (completed) await completed;
    })();
    stopInFlightRef.current = stopTask;
    try {
      await stopTask;
    } finally {
      stopInFlightRef.current = null;
    }
  }, []);

  // Reset state to defaults
  const reset = useCallback(() => {
    setState({ ...DEFAULT_STATE, ...initialState });
  }, [initialState]);

  // Set full state (for external control)
  const setFullState = useCallback((newState: CameraState) => {
    setState(newState);
  }, []);

  return {
    cameraRef,
    state,
    setZoom,
    setFlash,
    toggleFlash,
    setFacing,
    switchCamera,
    setCaptureMode,
    takePhoto,
    takeSnapshot,
    startRecording,
    stopRecording,
    reset,
    setFullState,
    updateState,
  };
}

export default useCamera;
