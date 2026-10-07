import { useState, useCallback, useRef, useEffect } from 'react';
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

  // Start video recording
  const startRecording = useCallback(async (
    onFinished?: (video: VideoFile) => void,
    onError?: (error: unknown) => void
  ): Promise<void> => {
    if (!cameraRef.current) {
      console.error('Camera ref not set');
      return;
    }

    if (state.isRecording) {
      console.warn('Already recording');
      return;
    }

    updateState({ isRecording: true });

    cameraRef.current.startRecording({
      flash: state.flash === 'auto' ? 'on' : state.flash,
      onRecordingFinished: async (video) => {
        updateState({ isRecording: false });

        // Save to the configured location
        await mediaService.saveVideo(video);

        onFinished?.(video);
      },
      onRecordingError: (error) => {
        updateState({ isRecording: false });
        console.error('Recording error:', error);
        onError?.(error);
      },
    });
  }, [state.flash, state.isRecording, updateState]);

  // Stop video recording
  const stopRecording = useCallback(async (): Promise<void> => {
    if (!cameraRef.current) {
      console.error('Camera ref not set');
      return;
    }

    if (!state.isRecording) {
      console.warn('Not recording');
      return;
    }

    try {
      await cameraRef.current.stopRecording();
    } catch (error) {
      console.error('Error stopping recording:', error);
      throw error;
    }
  }, [state.isRecording]);

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
