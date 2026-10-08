import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  StyleSheet,
  TouchableOpacity,
  Text,
  Alert,
  AppState,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import {
  Camera,
  CameraRuntimeError,
  PhotoFile,
  useCameraDevice,
  useCameraPermission,
  useMicrophonePermission,
} from 'react-native-vision-camera';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { CameraControls } from '../src/components/CameraControls';
import { QRCodeDisplay } from '../src/components/QRCodeDisplay';
import { GridOverlay } from '../src/components/GridOverlay';
import { TimerCountdown } from '../src/components/TimerCountdown';
import { AspectRatioContainer } from '../src/components/AspectRatioContainer';
import { useCamera } from '../src/hooks/useCamera';
import { useSignaling } from '../src/hooks/useSignaling';
import { usePeerConnection } from '../src/hooks/usePeerConnection';
import { useSettings } from '../src/hooks/useSettings';
import { useVolumeShutter } from '../src/hooks/useVolumeShutter';
import { useCaptureController } from '../src/hooks/useCaptureController';
import { useAppState } from '../src/hooks/useAppState';
import { requestMediaLibraryPermission } from '../src/utils/permissions';
import { detectLenses } from '../src/utils/lensDetection';
import { determineStreamMode } from '../src/utils/streamMode';
import { mediaService, SavedMedia } from '../src/services/MediaService';
import { pairingService } from '../src/services/PairingService';
import { webRTCService } from '../src/services/WebRTCService';
import { Command, CameraState, LensInfo, StreamMode } from '../src/types';

// Reconnection pacing. Recording belongs to the camera phone and may continue
// for hours while there is no network, so recovery must not have a final retry
// limit. Retry quickly at first, then settle at a low-frequency cadence to
// avoid burning battery or hammering Firestore during a long outage.
const RECONNECT_GRACE_MS = 3000;
const RECONNECT_RETRY_MS = 5000;
const RECONNECT_MAX_RETRY_MS = 30000;

// Neither vision-camera nor WebRTC releases the camera synchronously, and
// neither reports when it's done, so every handoff between them waits this out.
// Measured on a Pixel: CameraX signalled onClosed() 58ms after WebRTC had
// already begun opening, and WebRTC's device closed 106ms after CameraX started
// force-opening - i.e. the old 200ms lost the race in both directions and only
// got away with it because CameraX force-opens and retries. When it doesn't,
// the HAL rejects the stream combination and the session fails to configure.
const CAMERA_HANDOFF_MS = 500;

// A failed handoff is transient by nature - the camera is simply still held.
// Remounting reconfigures against a (by then) free device.
const CAMERA_RETRY_MS = 700;
const CAMERA_MAX_RETRIES = 3;

function isPreviewZoomLimited(state: CameraState, mode: StreamMode): boolean {
  return (
    mode === 'webrtc' &&
    state.facing === 'back' &&
    Math.abs(state.zoom - 1) >= 0.05
  );
}

export default function CameraScreen() {
  const router = useRouter();
  const isFocused = useIsFocused();

  // On a dedicated controller phone, reopen directly into Remote mode. This is
  // only a navigation preference; the remembered Pair ID remains independent.
  const startupRoleCheckedRef = useRef(false);
  useEffect(() => {
    if (startupRoleCheckedRef.current) return;
    startupRoleCheckedRef.current = true;

    pairingService.getPreferredMode().then((mode) => {
      if (mode === 'remote') {
        router.replace('/remote');
      }
    });
  }, [router]);

  // Permissions
  const { hasPermission: hasCameraPermission, requestPermission: requestCameraPermission } =
    useCameraPermission();
  const { hasPermission: hasMicPermission, requestPermission: requestMicPermission } =
    useMicrophonePermission();

  // Camera state - use cameraRef from the hook
  const {
    cameraRef,
    state: cameraState,
    setZoom,
    toggleFlash,
    switchCamera,
    setCaptureMode,
    takePhoto,
    startRecording,
    stopRecording,
    updateState,
  } = useCamera();

  // Settings
  const { settings } = useSettings();

  // Keep screen awake based on setting
  useEffect(() => {
    if (settings.keepScreenAwake) {
      activateKeepAwakeAsync('camera-screen');
    } else {
      deactivateKeepAwake('camera-screen');
    }
    return () => {
      deactivateKeepAwake('camera-screen');
    };
  }, [settings.keepScreenAwake]);

  // Timer countdown state
  const [showTimerCountdown, setShowTimerCountdown] = useState(false);
  const [timerSeconds, setTimerSeconds] = useState(0);
  const pendingTimerPhoto = useRef<(() => void) | null>(null);

  // QR code state
  const [showQR, setShowQR] = useState(false);
  const [isRemoteConnected, setIsRemoteConnected] = useState(false);
  const [isQRLoading, setIsQRLoading] = useState(false);

  // Last photo and lenses state
  const [lastPhotoUri, setLastPhotoUri] = useState<string | undefined>();
  const [availableLenses, setAvailableLenses] = useState<LensInfo[]>([]);

  // Remote preview stays on low-bandwidth WebRTC. Capture zoom can differ from
  // preview framing; that limitation is reported to the controller separately.
  const [currentStreamMode, setCurrentStreamMode] = useState<StreamMode>('webrtc');

  // Track if WebRTC is actively using the camera (to deactivate vision-camera during WebRTC streaming)
  const [isWebRTCUsingCamera, setIsWebRTCUsingCamera] = useState(false);

  // Track if remote connection is active (used for showing connection indicator)
  const [isStreamingToRemote, setIsStreamingToRemote] = useState(false);
  // Sticky: set once a pairing has actually come up, cleared only when the
  // session is torn down. Gates reconnection - see the reconnect effect.
  const [hasPaired, setHasPaired] = useState(false);
  // Key to force Camera remount when screen regains focus (fixes vision-camera not restarting)
  const [cameraKey, setCameraKey] = useState(0);
  // Zoom override - used to mount camera at 1x then update to target zoom after init
  // This works around vision-camera not applying zoom prop at mount time
  const [zoomOverride, setZoomOverride] = useState<number | null>(null);
  // Ref to track streaming state for use in callbacks (avoids stale closure issues)
  const isStreamingRef = useRef(false);

  // Ref to track current facing for use in callbacks (avoids stale closure issues)
  const facingRef = useRef<'front' | 'back'>('back');

  // Ref to track current stream mode for use in callbacks (avoids stale closure issues)
  const streamModeRef = useRef<StreamMode>('webrtc');

  // Forward references for the video recording handlers. They're defined later
  // in the component (they need usePeerConnection's pauseLocalStream/etc), and
  // handleCommand is defined here. The refs let handleCommand reach the current
  // implementation without sitting in the deps array, which would trip the
  // temporal dead zone on first render.
  const handleStartRecordingRef = useRef<(() => Promise<void>) | null>(null);
  const handleStopRecordingRef = useRef<(() => Promise<void>) | null>(null);

  // Signaling
  const {
    sessionId,
    createSession,
    sendOffer,
    onAnswer,
    onReconnectRequest,
    addIceCandidate: addSignalingIceCandidate,
    onIceCandidate: listenForIceCandidate,
    cleanup: cleanupSignaling,
  } = useSignaling('camera');


  // Track camera initialization state
  const [isCameraInitialized, setIsCameraInitialized] = useState(false);
  // Resolve function for awaiting camera initialization
  const cameraInitResolveRef = useRef<(() => void) | null>(null);

  // Handle camera becoming active again
  const handleCameraInitialized = useCallback(() => {
    setIsCameraInitialized(true);

    // Resolve any pending initialization promise after a brief delay
    // to allow Android's ImageCapture use case to fully bind
    if (cameraInitResolveRef.current) {
      const resolve = cameraInitResolveRef.current;
      cameraInitResolveRef.current = null;
      setTimeout(resolve, 300);
    }

    // Clear zoom override after a brief delay to apply the actual target zoom
    // This works around vision-camera not respecting zoom prop at mount time
    if (zoomOverride !== null) {
      setTimeout(() => {
        setZoomOverride(null);
      }, 100);
    }
  }, [zoomOverride]);

  // Returns a promise that resolves when camera finishes initializing
  const waitForCameraInit = useCallback(() => {
    return new Promise<void>((resolve) => {
      cameraInitResolveRef.current = resolve;
      // Safety timeout to avoid hanging forever
      setTimeout(resolve, 3000);
    });
  }, []);

  // Handle incoming commands from remote
  const handleCommand = useCallback(async (command: Command) => {
    switch (command.type) {
      case 'TAKE_PHOTO':
        // Never let a stale controller mode ask AVFoundation for a still while
        // the same Vision Camera session is recording video.
        if (cameraState.isRecording) {
          sendResponse({ type: 'ERROR', message: 'Cannot take a photo while recording' });
          break;
        }
        requestCapture({ notifyRemote: true }).catch((error) => {
          console.error('Remote capture failed:', error);
        });
        break;

      case 'START_RECORDING':
        try {
          // Keep the authoritative camera state in video mode even if an older
          // controller missed SET_CAPTURE_MODE. This also makes STATE_UPDATE
          // preserve the controller's Video UI while recording.
          setCaptureMode('video');

          // handleStartRecording is defined later than handleCommand in this
          // component, so it can't sit in the deps array (temporal dead zone).
          if (handleStartRecordingRef.current) {
            await handleStartRecordingRef.current();
            sendResponse({ type: 'RECORDING_STARTED' });
          }
        } catch (error) {
          sendResponse({ type: 'ERROR', message: String(error) });
        }
        break;

      case 'STOP_RECORDING':
        try {
          if (handleStopRecordingRef.current) {
            await handleStopRecordingRef.current();
            sendResponse({ type: 'RECORDING_STOPPED', success: true });
          }
          // Frame capture is automatically resumed after recording
          // (useEffect depends on cameraState.isRecording)
        } catch (error) {
          sendResponse({ type: 'RECORDING_STOPPED', success: false, error: String(error) });
        }
        break;

      case 'SET_ZOOM':
        setZoom(command.level);
        // Capture uses the requested zoom. The low-bandwidth WebRTC preview may
        // remain at 1x; STATE_UPDATE marks that limitation for the controller.
        break;

      case 'SET_FLASH':
        updateState({ flash: command.mode });
        // Note: STATE_UPDATE is sent automatically via useEffect when cameraState changes
        break;

      case 'SET_CAPTURE_MODE':
        setCaptureMode(command.mode);
        break;

      case 'SWITCH_CAMERA':
        switchCamera();
        // Vision-camera applies the new facing direction for capture.
        break;

      case 'GET_STATE':
        // Send state with current stream mode (uses ref to avoid stale closure)
        sendStateUpdate(
          cameraState,
          availableLenses,
          false,
          isPreviewZoomLimited(cameraState, streamModeRef.current),
          streamModeRef.current
        );
        break;
    }
  }, [setZoom, updateState, setCaptureMode, switchCamera, cameraState, availableLenses]);

  // WebRTC connection
  const {
    connectionState,
    isDataChannelReady,
    createConnection,
    createOffer,
    setRemoteDescription,
    addIceCandidate: addPeerIceCandidate,
    sendResponse,
    sendStateUpdate,
    startLocalStream,
    pauseLocalStream,
    detachLocalVideoTrackForRecording,
    resumeLocalStream,
    close: closeConnection,
  } = usePeerConnection({
    role: 'camera',
    onCommand: handleCommand,
    onIceCandidate: async (candidate) => {
      await addSignalingIceCandidate(candidate);
    },
  });

  // Mirrors isDataChannelReady so the capture callbacks can check it without
  // going stale, and without logging "data channel not ready" on every local
  // photo taken with no remote paired.
  const isDataChannelReadyRef = useRef(false);
  useEffect(() => {
    isDataChannelReadyRef.current = isDataChannelReady;
  }, [isDataChannelReady]);

  // Reconnect callbacks are registered once with Firestore, so read mutable
  // camera state through a ref instead of capturing an old render.
  const cameraStateRef = useRef(cameraState);
  useEffect(() => {
    cameraStateRef.current = cameraState;
  }, [cameraState]);

  const controllerRebuildInFlightRef = useRef(false);
  const needsPreviewRenegotiationRef = useRef(false);

  const notifyCaptureState = useCallback((capturing: boolean) => {
    if (!isDataChannelReadyRef.current) return;
    sendResponse({ type: 'CAPTURE_STATE', capturing });
  }, [sendResponse]);

  // Every shutter - remote command, volume button, on-screen - goes through
  // this one queue, so two captures can never overlap on the same camera.
  const { requestCapture, isCapturingRef } = useCaptureController({
    takePhoto,

    // WebRTC and vision-camera can't hold the camera at the same time.
    acquireCamera: useCallback(async () => {
      // Tell the remote its preview is about to go dark for the whole cycle.
      notifyCaptureState(true);

      const wasUsingWebRTC = streamModeRef.current === 'webrtc';
      if (wasUsingWebRTC) {
        pauseLocalStream();
        setIsWebRTCUsingCamera(false);
        await waitForCameraInit();
      }
      return wasUsingWebRTC;
    }, [notifyCaptureState, pauseLocalStream, waitForCameraInit]),

    releaseCamera: useCallback(async (wasHeld: boolean) => {
      try {
        if (!wasHeld) return;
        setIsWebRTCUsingCamera(true);
        await new Promise(resolve => setTimeout(resolve, CAMERA_HANDOFF_MS));
        await resumeLocalStream(facingRef.current);
      } finally {
        // Always clears, even if the resume failed - otherwise the remote
        // would sit behind a review image forever.
        notifyCaptureState(false);
      }
    }, [notifyCaptureState, resumeLocalStream]),

    // Show the freshly captured file straight away rather than waiting on the
    // save to finish.
    onPhotoCaptured: useCallback((photo: PhotoFile) => {
      setLastPhotoUri(photo.path.startsWith('file://') ? photo.path : `file://${photo.path}`);
    }, []),

    // Once saved, switch the thumbnail to the saved copy - the capture temp
    // file isn't ours to rely on long term.
    onPhotoSaved: useCallback((saved: SavedMedia | null) => {
      if (saved) {
        setLastPhotoUri(saved.uri);
      }
    }, []),

    onRemoteCaptureComplete: useCallback((success: boolean, error?: string) => {
      sendResponse({ type: 'PHOTO_TAKEN', success, error });
    }, [sendResponse]),
  });

  // Videos hold the camera for the whole recording, so they can't ride the
  // CaptureQueue the way photos do - a video is a long-running session that
  // has to start and stop on its own clock. The lock itself is the same one
  // the queue uses: pause WebRTC, mark vision-camera as the user, wait for
  // it to bind, then on stop mark WebRTC as the user again, wait the
  // CAMERA_HANDOFF_MS, and resume.
  //
  // Without this on iOS the AVFoundation session is already owned by
  // react-native-webrtc's getUserMedia, so vision-camera's startRecording
  // throws -11800 ("The operation could not be completed") immediately and
  // the clip is never written. On Android the same code path works because
  // the camera framework there is happier about brief overlaps.
  const recordingHeldCameraRef = useRef(false);

  const acquireCameraForVideo = useCallback(async (): Promise<boolean> => {
    // The remote's preview is going to be dark for the entire recording, so
    // tell it up front rather than letting it sit on a frozen frame.
    notifyCaptureState(true);

    const wasUsingWebRTC = streamModeRef.current === 'webrtc';
    if (wasUsingWebRTC) {
      // Video is a long-running camera owner. Unlike the short photo handoff,
      // do not leave a disabled WebRTC getUserMedia track attached: an ICE
      // restart on reconnect can wake that media path and make AVFoundation
      // finish the Vision Camera recording. Detach + stop the WebRTC track
      // completely while keeping its sender/transceiver and DataChannel alive.
      await detachLocalVideoTrackForRecording();
      setIsWebRTCUsingCamera(false);
      await waitForCameraInit();
    }
    return wasUsingWebRTC;
  }, [notifyCaptureState, detachLocalVideoTrackForRecording, waitForCameraInit]);

  const releaseCameraForVideo = useCallback(async (wasHeld: boolean): Promise<void> => {
    try {
      if (!wasHeld) return;

      // A recording may be stopped locally while the remote is still offline.
      // Do not hand the lens back to WebRTC unless there is an actual controller
      // to receive that preview; keep the camera usable locally instead.
      if (
        AppState.currentState !== 'active' ||
        !isFocusedRef.current ||
        connectionState !== 'connected' ||
        !isDataChannelReady
      ) {
        setIsWebRTCUsingCamera(false);
        setCurrentStreamMode('frame-based');
        return;
      }

      setCurrentStreamMode('webrtc');
      setIsWebRTCUsingCamera(true);
      await new Promise(resolve => setTimeout(resolve, CAMERA_HANDOFF_MS));
      await resumeLocalStream(facingRef.current);

      // If a remembered controller returned while recording, its fresh peer
      // was intentionally negotiated without a camera track. After explicit
      // Stop, publish a second offer so the newly added preview track becomes
      // part of that same controller generation.
      if (needsPreviewRenegotiationRef.current) {
        const previewOffer = await createOffer();
        await sendOffer({ type: 'offer', sdp: previewOffer.sdp! });
        needsPreviewRenegotiationRef.current = false;
        console.log('[CAMERA] Renegotiated preview after recording stopped');
      }
    } finally {
      // Always clears, same as the photo path - otherwise the remote would
      // sit behind a "camera busy" overlay forever.
      notifyCaptureState(false);
    }
  }, [
    connectionState,
    isDataChannelReady,
    notifyCaptureState,
    resumeLocalStream,
    createOffer,
    sendOffer,
  ]);

  // Wrap useCamera.startRecording so every shutter path - remote command,
  // volume button, on-screen - goes through the same lock acquisition.
  // The lock stays held for the entire recording and is released by
  // handleStopRecording or by the onRecordingError callback below.
  const handleStartRecording = useCallback(async (): Promise<void> => {
    if (cameraState.isRecording) {
      console.warn('[CAMERA] startRecording called while already recording');
      return;
    }

    const wasHeld = await acquireCameraForVideo();
    recordingHeldCameraRef.current = wasHeld;

    try {
      await startRecording(
        undefined,
        // vision-camera surfaces recording failures via this callback rather
        // than by rejecting the startRecording promise. Release the lock
        // before reporting the error so a future attempt can re-acquire.
        async (error) => {
          if (recordingHeldCameraRef.current) {
            const held = recordingHeldCameraRef.current;
            recordingHeldCameraRef.current = false;
            await releaseCameraForVideo(held);
          }
          console.error('[CAMERA] Recording error:', error);
        }
      );
    } catch (error) {
      // startRecording itself rejected - lock was acquired but recording
      // never began, so release the lock here.
      if (recordingHeldCameraRef.current) {
        const held = recordingHeldCameraRef.current;
        recordingHeldCameraRef.current = false;
        await releaseCameraForVideo(held);
      }
      throw error;
    }
  }, [cameraState.isRecording, acquireCameraForVideo, releaseCameraForVideo, startRecording]);

  const handleStopRecording = useCallback(async (): Promise<void> => {
    try {
      await stopRecording();
    } finally {
      // Always release if we held it, even if stopRecording threw - the
      // camera needs to go back to WebRTC regardless.
      if (recordingHeldCameraRef.current) {
        const held = recordingHeldCameraRef.current;
        recordingHeldCameraRef.current = false;
        await releaseCameraForVideo(held);
      }
    }
  }, [stopRecording, releaseCameraForVideo]);

  // Sync the recording handlers into the forward refs so handleCommand
  // (defined earlier) can dispatch to the current implementation when a
  // START_RECORDING / STOP_RECORDING command arrives.
  handleStartRecordingRef.current = handleStartRecording;
  handleStopRecordingRef.current = handleStopRecording;

  // The recording belongs to this phone, not the remote connection. If the
  // CAMERA app itself goes into the background, ask Vision Camera to finalize
  // immediately, before iOS suspends the JS runtime. Native output is staged
  // in Documents so a finalized file can also be recovered next launch.
  //
  // Do NOT stop merely on iOS 'inactive': opening Control Center to change
  // Wi-Fi/airplane mode also marks the app inactive temporarily, and a network
  // change must not decide when the video stops. Actual screen navigation is
  // handled explicitly below, before unmounting the Camera.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'background') return;

      void handleStopRecordingRef.current?.().catch((error) => {
        console.error('[CAMERA] Could not auto-save recording on app exit:', error);
      });
    });
    return () => subscription.remove();
  }, []);

  // Get camera devices with multi-camera support for optical zoom
  // Request all physical devices to enable lens switching
  const device = useCameraDevice(cameraState.facing, {
    physicalDevices: [
      'ultra-wide-angle-camera',
      'wide-angle-camera',
      'telephoto-camera',
    ],
  });
  // Always get back camera with all lenses for consistent lens detection
  const backDevice = useCameraDevice('back', {
    physicalDevices: [
      'ultra-wide-angle-camera',
      'wide-angle-camera',
      'telephoto-camera',
    ],
  });

  // Force camera remount when screen regains focus (fixes vision-camera not restarting)
  const wasFocusedRef = useRef(isFocused);
  useEffect(() => {
    // Never remount the native camera session while Vision Camera is recording.
    // Opening Control Center / Settings to change connectivity can move the app
    // out of focus briefly; remounting here would terminate AVFoundation.
    if (isFocused && !wasFocusedRef.current && !cameraState.isRecording) {
      setCameraKey(prev => prev + 1);
    }
    wasFocusedRef.current = isFocused;
  }, [isFocused, cameraState.isRecording]);

  // Read by the resume handler, which is memoised and would otherwise close
  // over a stale value.
  const isFocusedRef = useRef(isFocused);
  isFocusedRef.current = isFocused;

  // Vision Camera must stay active for the entire video recording. WebRTC is
  // already paused before recording starts, so recording itself is not a
  // reason to deactivate this camera session.
  const cameraIsActive = isFocused && !isWebRTCUsingCamera;

  // Recover from a lost camera handoff
  //
  // The camera is passed back and forth between vision-camera and WebRTC, and
  // neither releases the device synchronously. CameraX force-opens while the
  // other client is still closing, and when the HAL won't accept the resulting
  // stream combination the session fails to configure. Without an onError the
  // failure escapes as an unhandled error and the preview just stays dead, so
  // treat the contention codes as transient and reconfigure against a camera
  // that has had time to come free.
  const cameraRetriesRef = useRef(0);
  const handleCameraError = useCallback((error: CameraRuntimeError) => {
    const isContention =
      error.code === 'session/invalid-output-configuration' ||
      error.code === 'session/camera-not-ready' ||
      error.code === 'session/hardware-cost-too-high' ||
      error.code === 'device/camera-already-in-use';

    if (!isContention || cameraRetriesRef.current >= CAMERA_MAX_RETRIES) {
      console.error('[CAMERA] Camera error:', error.code, error.message);
      return;
    }

    cameraRetriesRef.current += 1;
    console.warn(
      `[CAMERA] ${error.code} - remounting (retry ${cameraRetriesRef.current}/${CAMERA_MAX_RETRIES})`
    );
    setTimeout(() => {
      setIsCameraInitialized(false);
      setCameraKey(prev => prev + 1);
    }, CAMERA_RETRY_MS);
  }, []);

  // A session that configures is proof the camera came free; let the next
  // handoff have the full retry budget again.
  useEffect(() => {
    if (isCameraInitialized) {
      cameraRetriesRef.current = 0;
    }
  }, [isCameraInitialized]);

  // Request permissions on mount
  useEffect(() => {
    const requestPermissions = async () => {
      if (!hasCameraPermission) {
        await requestCameraPermission();
      }
      if (!hasMicPermission) {
        await requestMicPermission();
      }
      await requestMediaLibraryPermission();
    };
    requestPermissions();
  }, [hasCameraPermission, hasMicPermission, requestCameraPermission, requestMicPermission]);

  // Re-import a native video which finished on a previous launch but whose
  // Photos save was interrupted when iOS suspended/terminated the app.
  useEffect(() => {
    void mediaService.recoverPendingVideos().then((count) => {
      if (count > 0) {
        console.log(`[CAMERA] Recovered ${count} interrupted recording(s)`);
      }
    }).catch((error) => {
      console.error('[CAMERA] Pending recording recovery failed:', error);
    });
  }, []);

  // Detect available lenses - always use backDevice for consistent lens list
  useEffect(() => {
    if (backDevice) {
      const lenses = detectLenses(backDevice, cameraState.facing, cameraState.zoom);
      setAvailableLenses(lenses);
    }
  }, [backDevice, cameraState.facing, cameraState.zoom]);

  // Load the last photo from wherever captures are being saved. Re-runs when
  // that changes, so the thumbnail doesn't keep showing a camera-roll shot
  // after the user points saves at a folder.
  useEffect(() => {
    const loadLastPhoto = async () => {
      const uri = await mediaService.getLastPhotoUri();
      if (uri) {
        setLastPhotoUri(uri);
      }
    };
    loadLastPhoto();
  }, [settings.saveFolderUri]);

  // Build/rebuild the camera side of a remembered pairing. "armOnly" is used
  // after app launch: negotiate the same Pair ID but immediately pause the
  // preview track so the local camera stays usable while waiting for the
  // controller to return.
  const startRemoteSession = useCallback(async (
    preferredPairId?: string,
    options: { showQr?: boolean; armOnly?: boolean } = {}
  ): Promise<void> => {
    const showQrForSession = options.showQr ?? false;
    const armOnly = options.armOnly ?? false;

    if (showQrForSession) {
      setIsQRLoading(true);
    }

    try {
      setIsStreamingToRemote(true);
      setHasPaired(false);

      // A remembered camera reuses the exact same 6-character Pair ID.
      const activePairId = await createSession(preferredPairId);
      await pairingService.saveCameraPairId(activePairId);
      await pairingService.setPreferredMode('camera');

      await createConnection();

      // A restored/background-ready pairing should not take over the lens while
      // no controller is present. We still briefly create the media track so
      // the video m-line exists in SDP, then pause it until a controller joins.
      const initialStreamMode: StreamMode = armOnly
        ? 'frame-based'
        : determineStreamMode(
            cameraState.facing,
            cameraState.zoom,
            settings.previewMode
          );

      if (initialStreamMode === 'webrtc') {
        setIsWebRTCUsingCamera(true);
        await new Promise(resolve => setTimeout(resolve, CAMERA_HANDOFF_MS));
      }

      await startLocalStream();
      setCurrentStreamMode(initialStreamMode);

      if (initialStreamMode === 'frame-based') {
        if (armOnly) {
          // A remembered-but-idle camera should not keep any AVFoundation
          // getUserMedia source alive just to stay pairable. Keep the sender
          // negotiated, but detach its track until a controller actually joins.
          await detachLocalVideoTrackForRecording();
        } else {
          pauseLocalStream();
        }
        setIsWebRTCUsingCamera(false);
      }

      const offer = await createOffer();
      await sendOffer({ type: 'offer', sdp: offer.sdp! });

      listenForIceCandidate(async (candidate) => {
        await addPeerIceCandidate(candidate);
      });

      onAnswer(async (answer) => {
        await setRemoteDescription({ type: 'answer', sdp: answer.sdp });
        setIsRemoteConnected(true);
        setShowQR(false);
      });

      // A returning remembered controller always requests a fresh generation.
      // Rebuild only WebRTC; Vision Camera recording is deliberately outside
      // this lifecycle and must continue uninterrupted.
      onReconnectRequest(async (connectionId) => {
        if (controllerRebuildInFlightRef.current) {
          console.warn('[CAMERA] Ignoring overlapping controller reconnect request');
          return;
        }

        controllerRebuildInFlightRef.current = true;
        console.log(`[CAMERA] Rebuilding peer for controller generation ${connectionId}`);

        try {
          const recording = cameraStateRef.current.isRecording;

          // Stop only WebRTC/SCTP. During an active video, its preview track is
          // already detached, so this cannot stop the Vision Camera recording.
          closeConnection();
          setIsRemoteConnected(false);
          setHasPaired(false);

          if (recording) {
            setIsWebRTCUsingCamera(false);
            setCurrentStreamMode('frame-based');
            needsPreviewRenegotiationRef.current = true;

            await createConnection();
          } else {
            // Keep Vision Camera inactive while reacquiring the WebRTC preview
            // so the handoff stays single-owner on iOS.
            setIsWebRTCUsingCamera(true);
            await new Promise(resolve => setTimeout(resolve, CAMERA_HANDOFF_MS));

            await createConnection();
            await startLocalStream();

            const targetMode = determineStreamMode(
              cameraStateRef.current.facing,
              cameraStateRef.current.zoom,
              settings.previewMode
            );
            setCurrentStreamMode(targetMode);

            if (targetMode === 'frame-based') {
              await detachLocalVideoTrackForRecording();
              setIsWebRTCUsingCamera(false);
              needsPreviewRenegotiationRef.current = true;
            } else {
              needsPreviewRenegotiationRef.current = false;
            }
          }

          const freshOffer = await createOffer();
          await sendOffer({ type: 'offer', sdp: freshOffer.sdp! });
          console.log(`[CAMERA] Published fresh offer for controller generation ${connectionId}`);
        } catch (error) {
          console.error('[CAMERA] Failed to rebuild controller connection:', error);
        } finally {
          controllerRebuildInFlightRef.current = false;
        }
      });

      setShowQR(showQrForSession);
    } catch (error) {
      console.error('[CAMERA] Connection setup error:', error);
      setIsStreamingToRemote(false);
      if (showQrForSession) {
        Alert.alert('Error', 'Failed to create remote connection');
      } else {
        console.warn('[CAMERA] Remembered pairing could not be armed yet');
      }
    } finally {
      if (showQrForSession) {
        setIsQRLoading(false);
      }
    }
  }, [
    addPeerIceCandidate,
    cameraState.facing,
    cameraState.zoom,
    createConnection,
    createOffer,
    createSession,
    detachLocalVideoTrackForRecording,
    listenForIceCandidate,
    onAnswer,
    onReconnectRequest,
    pauseLocalStream,
    sendOffer,
    setRemoteDescription,
    settings.previewMode,
    startLocalStream,
    closeConnection,
  ]);

  // Once this phone has been used as the camera, silently restore that Pair ID
  // on later launches. QR is no longer part of normal reconnect flow.
  const autoArmPairingAttemptedRef = useRef(false);
  useEffect(() => {
    if (autoArmPairingAttemptedRef.current) return;
    if (!hasCameraPermission || !hasMicPermission) return;

    autoArmPairingAttemptedRef.current = true;
    let cancelled = false;

    pairingService.getCameraPairId().then((savedPairId) => {
      if (cancelled || !savedPairId) return;
      console.log(`[CAMERA] Restoring remembered Pair ID ${savedPairId}`);
      startRemoteSession(savedPairId, { armOnly: true }).catch((error) => {
        console.error('[CAMERA] Failed to restore remembered pairing:', error);
      });
    });

    return () => {
      cancelled = true;
    };
  }, [hasCameraPermission, hasMicPermission, startRemoteSession]);

  // QR is now only needed for the first pairing, or to show the existing Pair
  // ID for troubleshooting. A remembered session always reuses the same ID.
  const handleShowQR = async () => {
    if (isStreamingToRemote && sessionId) {
      setShowQR(true);
      return;
    }

    const savedPairId = await pairingService.getCameraPairId();
    await startRemoteSession(savedPairId ?? undefined, { showQr: true });
  };

  const handleCloseQR = () => {
    setShowQR(false);

    // After the first successful pairing this QR is also the recovery key.
    // Hiding it must not destroy the session, especially during a recording.
    if (hasPaired) {
      return;
    }

    cleanupSignaling();
    closeConnection();
    setIsStreamingToRemote(false);
    setHasPaired(false);
    setIsWebRTCUsingCamera(false);
    setCurrentStreamMode('frame-based');
  };

  // Update remote connection state
  useEffect(() => {
    if (connectionState === 'connected') {
      setIsRemoteConnected(true);
      setHasPaired(true);
    } else if (connectionState === 'failed' || connectionState === 'disconnected') {
      setIsRemoteConnected(false);
      // Hand the camera back to vision-camera and fall back to frame-based:
      // it's the mode that doesn't need the lens, so the local preview works
      // again and the reconnect has one less thing to get right. Releasing
      // WebRTC's hold has to include stopping its track - otherwise both hold
      // the camera at once and the resume is a coin flip.
      if (isStreamingRef.current && streamModeRef.current === 'webrtc') {
        pauseLocalStream();
      }
      setIsWebRTCUsingCamera(false);
      setCurrentStreamMode('frame-based');
    }
  }, [connectionState, pauseLocalStream]);

  // Reconnecting after the app has been backgrounded
  //
  // Turning the screen off backgrounds the app, and Android hands the camera to
  // no one: every capture track ends and vision-camera's session is torn down.
  // ICE consent checks then go unanswered, so within ~30s both peer connections
  // drop. Neither of those comes back by itself - before this, the pairing was
  // dead until the app was force-quit and relaunched.
  //
  // The camera device owns recovery because it is the offerer, and it drives it
  // off connectionState rather than off its own resume, so it also covers the
  // case where only the remote's screen was off.
  const isForeground = useAppState(useCallback(() => {
    // vision-camera doesn't reliably restart its session after a background -
    // the same remount the navigation-focus path needs applies here.
    //
    // Guarded, because a remount tears down and rebuilds the CameraX session,
    // and configuring one over a session that is still going down is what
    // ERROR_STREAM_CONFIG (session/invalid-output-configuration) is. Skip it
    // mid-capture, and skip it when WebRTC holds the lens - vision-camera is
    // deactivated then, so there is no session to restart anyway.
    if (isCapturingRef.current) return;
    if (cameraState.isRecording) return;
    if (isStreamingRef.current && streamModeRef.current === 'webrtc') return;

    // Not while another screen is on top. Every trip out of the app and back -
    // the folder picker, the gallery - resumes this screen too, and rebuilding
    // a CameraX session there is wasted work at the worst moment: it lands
    // exactly as the user is waiting for the screen they're actually on to
    // respond. The camera isn't even active while unfocused, and the
    // focus effect above remounts it when they come back.
    if (!isFocusedRef.current) return;

    setIsCameraInitialized(false);
    setCameraKey(prev => prev + 1);
  }, [isCapturingRef, cameraState.isRecording]));

  // A short screen-off doesn't outlast ICE consent, so the connection can come
  // back reporting 'connected' over a track Android already ended - the remote
  // shows black under a "Live" badge, and the reconnect loop below never runs
  // because nothing looks wrong. Check the track itself on every resume.
  useEffect(() => {
    if (!isForeground) return;
    if (cameraState.isRecording) return;
    if (!isStreamingRef.current) return;
    if (streamModeRef.current !== 'webrtc') return;

    let cancelled = false;
    // The camera isn't handed back the instant the app is foregrounded;
    // grabbing at it immediately just fails.
    const timer = setTimeout(async () => {
      if (cancelled || webRTCService.hasLiveVideoTrack()) return;
      try {
        console.log('[CAMERA] Capture track ended while backgrounded - restoring');
        await resumeLocalStream(facingRef.current);
      } catch (error) {
        console.error('[CAMERA] Failed to restore capture track on resume:', error);
      }
    }, 500);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isForeground, cameraState.isRecording, resumeLocalStream]);

  useEffect(() => {
    if (!isStreamingToRemote) return;
    if (!hasPaired) return;                 // setup owns the connection until it exists
    if (!isForeground) return;              // no camera to stream, nothing to renegotiate onto
    // Media being green is not enough. A restored controller can have ICE/media
    // connected while the old SCTP command channel is dead, which would leave
    // every remote control disabled. Recovery only finishes when both are ready.
    if (connectionState === 'connected' && isDataChannelReady) return;

    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;

    const attempt = async () => {
      if (cancelled) return;
      // close() can land between a reconnect being scheduled and it firing -
      // the screen tearing down, or the user starting a new pairing.
      if (!webRTCService.hasPeerConnection()) {
        console.warn('[CAMERA] Reconnect skipped: connection is gone');
        return;
      }
      attempts += 1;

      try {
        // The first recovery offer deliberately replaces the old command
        // channel. This matters when the controller app has been suspended or
        // relaunched: the camera may still see the previous SCTP channel as
        // "open" even though the returning controller has a new peer process.
        if (attempts === 1) {
          webRTCService.replaceDataChannelForRecovery();
        } else {
          webRTCService.ensureDataChannel();
        }

        // Never reacquire the camera for preview while Vision Camera is
        // recording. During recording, recovery is control-only: the remote
        // gets state + Stop Recording, but no live preview until the clip ends.
        if (
          !cameraState.isRecording &&
          streamModeRef.current === 'webrtc' &&
          !webRTCService.hasLiveVideoTrack()
        ) {
          await resumeLocalStream(facingRef.current);
        }

        const offer = await createOffer({ iceRestart: true });
        await sendOffer({ type: 'offer', sdp: offer.sdp! });
        console.log(`[CAMERA] Sent ICE-restart offer (attempt ${attempts})`);
      } catch (error) {
        console.error(`[CAMERA] Reconnect attempt ${attempts} failed:`, error);
      }

      if (cancelled) return;

      // Keep trying for as long as the camera app/session is alive. Back off to
      // 30s so an hours-long outage doesn't turn into constant network traffic.
      const exponent = Math.min(Math.max(attempts - 1, 0), 3);
      const retryDelay = Math.min(
        RECONNECT_RETRY_MS * (2 ** exponent),
        RECONNECT_MAX_RETRY_MS
      );
      timer = setTimeout(attempt, retryDelay);
    };

    timer = setTimeout(attempt, RECONNECT_GRACE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    connectionState,
    isDataChannelReady,
    isStreamingToRemote,
    hasPaired,
    isForeground,
    createOffer,
    sendOffer,
    resumeLocalStream,
    cameraState.isRecording,
  ]);

  // Keep streaming ref in sync with state (for use in callbacks)
  useEffect(() => {
    isStreamingRef.current = isStreamingToRemote;
  }, [isStreamingToRemote]);

  // Keep facing ref in sync with state (for use in callbacks)
  useEffect(() => {
    facingRef.current = cameraState.facing;
  }, [cameraState.facing]);

  // Keep stream mode ref in sync with state (for use in callbacks)
  useEffect(() => {
    streamModeRef.current = currentStreamMode;
  }, [currentStreamMode]);

  // Handle stream mode switching between WebRTC and frame-based
  const handleStreamModeSwitch = useCallback(async (newMode: StreamMode) => {
    if (newMode === 'webrtc') {
      // Clear any pending zoom override
      if (zoomOverride !== null) {
        setZoomOverride(null);
      }
      // Deactivate vision-camera, then start WebRTC stream
      setIsWebRTCUsingCamera(true);
      await new Promise(resolve => setTimeout(resolve, CAMERA_HANDOFF_MS));
      try {
        await resumeLocalStream(cameraState.facing);
      } catch (error) {
        console.error('[CAMERA] WebRTC resume error:', error);
      }
    } else {
      // Pause WebRTC stream to release the camera
      pauseLocalStream();
      await new Promise(resolve => setTimeout(resolve, CAMERA_HANDOFF_MS));
      // Set zoom override to mount camera at 1x - actual zoom applied after init
      // (works around vision-camera not respecting zoom prop at mount time)
      setZoomOverride(1);
      setIsCameraInitialized(false);
      setCameraKey(prev => prev + 1);
      setIsWebRTCUsingCamera(false);
    }
    setCurrentStreamMode(newMode);
    sendStateUpdate(
      cameraState,
      availableLenses,
      false,
      isPreviewZoomLimited(cameraState, newMode),
      newMode
    );
  }, [resumeLocalStream, pauseLocalStream, sendStateUpdate, cameraState, availableLenses, zoomOverride]);

  // Debounced stream mode detection based on the preview mode setting, camera
  // facing and zoom
  //
  // Also the path back to WebRTC after a reconnect: a drop forces frame-based,
  // and currentStreamMode is a dependency so this re-evaluates once the
  // connection is back and promotes the mode again if the zoom warrants it.
  //
  // settings.previewMode is a dependency for the same reason, and that is what
  // makes the setting take effect mid-session: flipping it to 'frames' while
  // paired lands here and switches, rather than waiting for a re-pair. Costs
  // the one handoff you are turning the setting on to stop paying.
  useEffect(() => {
    if (!isDataChannelReady) return;
    // The data channel reads as open across a drop, so this is the real check.
    // Switching modes mid-outage would only fight the reconnect for the camera.
    if (connectionState !== 'connected') return;

    // A controller that reconnects during an active recording is allowed to
    // control/stop it, but preview must remain off. Reacquiring the lens here
    // would compete with Vision Camera and could terminate the recording.
    if (cameraState.isRecording) return;

    const targetMode = determineStreamMode(
      cameraState.facing,
      cameraState.zoom,
      settings.previewMode
    );
    if (targetMode === streamModeRef.current) return;

    // Debounce to avoid rapid switching during pinch-to-zoom
    const debounceTimer = setTimeout(() => {
      const currentTargetMode = determineStreamMode(
        cameraState.facing,
        cameraState.zoom,
        settings.previewMode
      );
      if (currentTargetMode !== streamModeRef.current) {
        handleStreamModeSwitch(currentTargetMode);
      }
    }, 300);

    return () => clearTimeout(debounceTimer);
  }, [
    cameraState.facing,
    cameraState.zoom,
    cameraState.isRecording,
    settings.previewMode,
    isDataChannelReady,
    connectionState,
    currentStreamMode,
    handleStreamModeSwitch,
  ]);

  // Send state updates when camera state changes and data channel is ready
  useEffect(() => {
    if (isDataChannelReady) {
      sendStateUpdate(
        cameraState,
        availableLenses,
        false,
        isPreviewZoomLimited(cameraState, currentStreamMode),
        currentStreamMode
      );
    }
  }, [cameraState, availableLenses, isDataChannelReady, sendStateUpdate, currentStreamMode]);

  // Reset camera initialized state when camera key changes (remount)
  useEffect(() => {
    setIsCameraInitialized(false);
  }, [cameraKey]);

  // Navigate to remote screen
  const handleGoToRemote = async () => {
    // Never unmount the native recording camera before finalizing its video.
    try {
      await handleStopRecording();
    } catch (error) {
      console.error('[CAMERA] Cannot navigate before video is safely finalized:', error);
      Alert.alert('Recording', 'Could not finish saving the video. Please try stopping again.');
      return;
    }
    await pairingService.setPreferredMode('remote');
    router.push('/remote');
  };

  // Handle opening gallery
  const handleOpenGallery = async () => {
    try {
      await handleStopRecording();
    } catch (error) {
      console.error('[CAMERA] Video was not saved before opening gallery:', error);
      Alert.alert('Recording', 'Could not finish saving the video. Please try stopping again.');
      return;
    }
    await mediaService.openGallery();
  };

  // Handle settings press
  const handleSettingsPress = async () => {
    try {
      await handleStopRecording();
    } catch (error) {
      console.error('[CAMERA] Video was not saved before opening settings:', error);
      Alert.alert('Recording', 'Could not finish saving the video. Please try stopping again.');
      return;
    }
    router.push('/settings');
  };

  // Handle lens selection
  const handleLensSelect = (zoom: number) => {
    setZoom(zoom);
  };

  // Actually take the photo (called directly or after timer)
  const actuallyTakePhoto = useCallback(async () => {
    try {
      // The controller handles the WebRTC camera lock and the thumbnail.
      await requestCapture({ notifyRemote: false });
    } catch (error) {
      // Suppress transient Android ImageCapture binding errors -
      // the photo still captures successfully via retry in useCamera
      const msg = error instanceof Error ? error.message : String(error);
      if (!msg.includes('Not bound to a valid Camera')) {
        console.error('Error taking photo:', error);
      }
    }
  }, [requestCapture]);

  // Handle timer countdown completion
  const handleTimerComplete = useCallback(() => {
    setShowTimerCountdown(false);
    actuallyTakePhoto();
  }, [actuallyTakePhoto]);

  // Wrap takePhoto to support timer
  const handleTakePhoto = async () => {
    if (settings.timer > 0) {
      setTimerSeconds(settings.timer);
      setShowTimerCountdown(true);
    } else {
      await actuallyTakePhoto();
    }
  };

  // Volume button shutter - the capture controller owns the WebRTC camera lock.
  // The busy guard stays: the volume manager can emit duplicate events for a
  // single press, and the queue would happily turn those into extra photos.
  const volumeShutterBusyRef = useRef(false);
  const handleVolumeShutter = useCallback(async () => {
    if (volumeShutterBusyRef.current) return;
    volumeShutterBusyRef.current = true;
    try {
      if (cameraState.captureMode === 'photo') {
        if (settings.timer > 0) {
          setTimerSeconds(settings.timer);
          setShowTimerCountdown(true);
        } else {
          await actuallyTakePhoto();
        }
      } else {
        if (cameraState.isRecording) {
          handleStopRecording();
        } else {
          handleStartRecording();
        }
      }
    } finally {
      volumeShutterBusyRef.current = false;
    }
  }, [cameraState.captureMode, cameraState.isRecording, settings.timer, actuallyTakePhoto, handleStartRecording, handleStopRecording]);

  useVolumeShutter({ onShutterPress: handleVolumeShutter, enabled: !showQR });

  if (!hasCameraPermission || !hasMicPermission) {
    return (
      <View style={styles.permissionContainer}>
        <Text style={styles.permissionText}>
          Camera and microphone permissions are required
        </Text>
        <TouchableOpacity
          style={styles.permissionButton}
          onPress={async () => {
            await requestCameraPermission();
            await requestMicPermission();
          }}
        >
          <Text style={styles.permissionButtonText}>Grant Permissions</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!device) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingText}>Loading camera...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Camera preview with aspect ratio container */}
      <AspectRatioContainer ratio={settings.aspectRatio}>
        {/* Vision camera preview - always used for local preview (supports zoom) */}
        <Camera
          key={`camera-${cameraKey}`}
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          device={device}
          isActive={cameraIsActive}
          photo={true}
          video={true}
          audio={true}
          zoom={zoomOverride ?? cameraState.zoom}
          enableZoomGesture={true}
          onInitialized={handleCameraInitialized}
          onError={handleCameraError}
        />

        {/* Grid overlay */}
        <GridOverlay type={settings.gridOverlay} />

        {/* Frozen preview notice when WebRTC is using the camera */}
        {isWebRTCUsingCamera && (
          <View style={styles.frozenOverlay}>
            <Text style={styles.frozenText}>Preview paused</Text>
            <Text style={styles.frozenSubtext}>Use remote device to see live preview</Text>
          </View>
        )}
      </AspectRatioContainer>

      {/* Timer countdown overlay */}
      {showTimerCountdown && (
        <TimerCountdown
          seconds={timerSeconds}
          onComplete={handleTimerComplete}
        />
      )}

      {/* Camera controls */}
      <CameraControls
        cameraState={cameraState}
        onTakePhoto={handleTakePhoto}
        onStartRecording={handleStartRecording}
        onStopRecording={handleStopRecording}
        onToggleFlash={toggleFlash}
        onSwitchCamera={switchCamera}
        onZoomChange={setZoom}
        onCaptureModeChange={setCaptureMode}
        lastPhotoUri={lastPhotoUri}
        onOpenGallery={handleOpenGallery}
        onSettingsPress={handleSettingsPress}
        onQRPress={handleShowQR}
        onModeToggle={handleGoToRemote}
        onLensSelect={handleLensSelect}
        availableLenses={availableLenses}
        currentMode="camera"
        isQRLoading={isQRLoading}
      />

      {/* Connection indicator */}
      {isRemoteConnected && (
        <View style={styles.connectionIndicator}>
          <View style={styles.connectionDot} />
          <Text style={styles.connectionText}>Remote Connected</Text>
        </View>
      )}

      {/* QR code overlay */}
      {showQR && sessionId && (
        <QRCodeDisplay sessionId={sessionId} onClose={handleCloseQR} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  permissionContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#000',
    padding: 20,
  },
  permissionText: {
    color: '#fff',
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 20,
  },
  permissionButton: {
    backgroundColor: '#007aff',
    paddingHorizontal: 30,
    paddingVertical: 14,
    borderRadius: 12,
  },
  permissionButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#000',
  },
  loadingText: {
    color: '#fff',
    fontSize: 16,
  },
  connectionIndicator: {
    position: 'absolute',
    top: 60,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  connectionDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#4cd964',
    marginRight: 8,
  },
  connectionText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  frozenOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  frozenText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 6,
  },
  frozenSubtext: {
    color: 'rgba(255, 255, 255, 0.7)',
    fontSize: 14,
  },
});
