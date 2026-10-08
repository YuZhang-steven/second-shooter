import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import {
  View,
  StyleSheet,
  Text,
  Alert,
  TouchableOpacity,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { MediaStream } from 'react-native-webrtc';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { QRCodeScanner } from '../components/QRCodeScanner';
import { HybridPreview } from '../components/HybridPreview';
import { CameraControls } from '../components/CameraControls';
import { useSignaling } from '../hooks/useSignaling';
import { usePeerConnection } from '../hooks/usePeerConnection';
import { useSettings } from '../hooks/useSettings';
import { useVolumeShutter } from '../hooks/useVolumeShutter';
import { useAppState } from '../hooks/useAppState';
import { webRTCService } from '../services/WebRTCService';
import { pairingService } from '../services/PairingService';
import {
  CameraState,
  Response,
  FlashMode,
  CaptureMode,
  LensInfo,
  StreamMode,
  FrameDataMessage,
} from '../types';
import { parseSessionIdFromInput } from '../../shared/session-link';
import { generateConnectionId } from '../utils/sessionId';

const RECONNECT_ATTEMPT_TIMEOUT_MS = 15000;
const RECONNECT_RETRY_DELAY_MS = 5000;

// A Firestore setDoc can wait for connectivity for a long time. A remembered
// pairing must show a meaningful status and retry rather than hanging forever.
async function withReconnectTimeout<T>(task: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after 15 seconds`)),
          RECONNECT_ATTEMPT_TIMEOUT_MS
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const DEFAULT_STATE: CameraState = {
  zoom: 1,
  flash: 'off',
  facing: 'back',
  captureMode: 'photo',
  isRecording: false,
};

export default function RemoteScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ sessionId?: string | string[] }>();
  const initialSessionId = useMemo(() => {
    const rawSessionId = Array.isArray(params.sessionId)
      ? params.sessionId[0]
      : params.sessionId;
    return rawSessionId ? parseSessionIdFromInput(String(rawSessionId)) : null;
  }, [params.sessionId]);

  // Settings
  const { settings } = useSettings();
  const isForeground = useAppState();

  // Keep screen awake based on setting
  useEffect(() => {
    if (settings.keepScreenAwake) {
      activateKeepAwakeAsync('remote-screen');
    } else {
      deactivateKeepAwake('remote-screen');
    }
    return () => {
      deactivateKeepAwake('remote-screen');
    };
  }, [settings.keepScreenAwake]);

  // UI state. Pairing is loaded asynchronously so avoid flashing the QR
  // scanner before we know whether this controller already remembers a camera.
  const [showScanner, setShowScanner] = useState(false);
  const [pairingLoaded, setPairingLoaded] = useState(Boolean(initialSessionId));
  const [rememberedPairId, setRememberedPairId] = useState<string | null>(null);
  const [isRestoringPairing, setIsRestoringPairing] = useState(false);
  const [reconnectError, setReconnectError] = useState<string | null>(null);
  const [reconnectTick, setReconnectTick] = useState(0);
  const [remoteState, setRemoteState] = useState<CameraState>(DEFAULT_STATE);
  const [remoteLenses, setRemoteLenses] = useState<LensInfo[]>([]);
  const [videoNeedsRotation, setVideoNeedsRotation] = useState(false);
  const [previewZoomLimited, setPreviewZoomLimited] = useState(false);
  const [streamMode, setStreamMode] = useState<StreamMode>('webrtc');
  const [latestFrame, setLatestFrame] = useState<FrameDataMessage | null>(null);

  // The camera device's WebRTC preview pauses while Vision Camera owns the
  // lens for a photo or video. No captured media is transferred to controller.
  const [isCameraCapturing, setIsCameraCapturing] = useState(false);

  // Signaling
  const {
    sessionId,
    joinSession,
    sendAnswer,
    requestReconnect,
    onOffer,
    addIceCandidate: addSignalingIceCandidate,
    onIceCandidate: listenForIceCandidate,
    cleanup: cleanupSignaling,
  } = useSignaling('remote');

  // Handle frame data from camera device (for frame-based streaming)
  const framesReceivedRef = useRef(0);
  const autoJoinAttemptedRef = useRef<string | null>(null);
  const connectingSessionRef = useRef<string | null>(null);
  const rememberedRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateSyncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectAttemptNumberRef = useRef(0);
  const handleFrameData = useCallback((frameData: FrameDataMessage) => {
    framesReceivedRef.current++;
    // Log every 30 frames (~3 seconds)
    if (framesReceivedRef.current % 30 === 0) {
      console.log(`[REMOTE] Received ${framesReceivedRef.current} frames, latest id: ${frameData.frameId}, size: ${frameData.data?.length || 0} bytes`);
    }
    setLatestFrame(frameData);
  }, []);

  // Handle responses from camera device
  const handleResponse = useCallback((response: Response) => {
    // Handle frame data separately (high frequency)
    if (response.type === 'FRAME_DATA') {
      handleFrameData(response);
      return;
    }

    if (response.type === 'CAPTURE_STATE') {
      console.log(`[REMOTE] Camera capture state: ${response.capturing}`);
      setIsCameraCapturing(response.capturing);
      return;
    }

    console.log('Received response:', response.type);

    switch (response.type) {
      case 'STATE_UPDATE':
        console.log(`[REMOTE] STATE_UPDATE: zoom=${response.state.zoom}, facing=${response.state.facing}, streamMode=${response.streamMode}`);
        if (connectWatchdogRef.current) {
          clearTimeout(connectWatchdogRef.current);
          connectWatchdogRef.current = null;
        }
        setReconnectError(null);
        if (stateSyncTimeoutRef.current) {
          clearTimeout(stateSyncTimeoutRef.current);
          stateSyncTimeoutRef.current = null;
        }
        setIsRestoringPairing(false);
        setRemoteState(response.state);
        if (response.lenses) {
          setRemoteLenses(response.lenses);
        }
        if (response.videoNeedsRotation !== undefined) {
          setVideoNeedsRotation(response.videoNeedsRotation);
        }
        if (response.previewZoomLimited !== undefined) {
          setPreviewZoomLimited(response.previewZoomLimited);
        }
        if (response.streamMode !== undefined) {
          if (response.streamMode !== streamMode) {
            console.log(`[REMOTE] Stream mode changing: ${streamMode} -> ${response.streamMode}`);
          }
          setStreamMode(response.streamMode);
        }
        break;

      case 'PHOTO_TAKEN':
        if (response.success) {
          console.log('Photo taken successfully');
        } else {
          Alert.alert('Error', response.error || 'Failed to take photo');
        }
        break;

      case 'RECORDING_STARTED':
        setRemoteState((prev) => ({ ...prev, isRecording: true }));
        break;

      case 'RECORDING_STOPPED':
        setRemoteState((prev) => ({ ...prev, isRecording: false }));
        if (!response.success) {
          Alert.alert('Error', response.error || 'Failed to stop recording');
        }
        break;

      case 'ERROR':
        Alert.alert('Error', response.message);
        break;
    }
  }, [handleFrameData, streamMode]);

  // Handle remote stream from camera
  const handleRemoteStream = useCallback((stream: MediaStream) => {
    const tracks = stream.getTracks();
    const videoTracks = stream.getVideoTracks();
    console.log(`[REMOTE] Received remote stream: ${tracks.length} tracks total, ${videoTracks.length} video tracks`);
    videoTracks.forEach((track, i) => {
      console.log(`[REMOTE] Video track ${i}: id=${track.id}, readyState=${track.readyState}, enabled=${track.enabled}`);
    });
  }, []);

  // Track data channel ready state
  const [isDataChannelReady, setIsDataChannelReady] = useState(false);

  // Handle data channel open
  const handleDataChannelOpen = useCallback(() => {
    console.log('Data channel is now ready');
    setIsDataChannelReady(true);
    // DataChannel open is not proof that camera commands are being received.
    // Keep reconnect status until a real STATE_UPDATE arrives.
    webRTCService.onFrameData(handleFrameData);
  }, [handleFrameData]);

  const handleDataChannelClose = useCallback(() => {
    console.log('Data channel closed on controller');
    setIsDataChannelReady(false);
  }, []);

  // iOS can suspend JS while the native WebRTC/SCTP connection remains alive.
  // If the channel opened while JS was suspended (or React missed that event),
  // restore readiness from the native service as soon as the app is foreground.
  useEffect(() => {
    if (!isForeground) return;

    const nativeReady = webRTCService.isDataChannelReady();
    if (nativeReady && !isDataChannelReady) {
      console.log('[REMOTE] Restoring DataChannel readiness from native state');
      setIsDataChannelReady(true);
      // Wait for a real STATE_UPDATE before declaring reconnect complete.
      webRTCService.onFrameData(handleFrameData);
    }
  }, [isForeground, isDataChannelReady, handleFrameData]);

  // WebRTC connection
  const {
    connectionState,
    remoteStream,
    createConnection,
    createAnswer,
    setRemoteDescription,
    addIceCandidate: addPeerIceCandidate,
    sendCommand,
    close: closeConnection,
  } = usePeerConnection({
    role: 'remote',
    onResponse: handleResponse,
    onRemoteStream: handleRemoteStream,
    onIceCandidate: async (candidate) => {
      console.log('Sending ICE candidate to signaling');
      await addSignalingIceCandidate(candidate);
    },
    onDataChannelOpen: handleDataChannelOpen,
    onDataChannelClose: handleDataChannelClose,
  });

  const clearActiveConnection = useCallback(() => {
    if (connectWatchdogRef.current) {
      clearTimeout(connectWatchdogRef.current);
      connectWatchdogRef.current = null;
    }
    if (stateSyncTimeoutRef.current) {
      clearTimeout(stateSyncTimeoutRef.current);
      stateSyncTimeoutRef.current = null;
    }
    cleanupSignaling();
    closeConnection();
    connectingSessionRef.current = null;
    setIsDataChannelReady(false);
  }, [cleanupSignaling, closeConnection]);

  const restartRememberedConnection = useCallback(() => {
    if (!rememberedPairId) return;

    if (stateSyncTimeoutRef.current) {
      clearTimeout(stateSyncTimeoutRef.current);
      stateSyncTimeoutRef.current = null;
    }

    console.log('[REMOTE] Restarting stale remembered controller connection');
    connectAttemptNumberRef.current += 1;
    clearActiveConnection();
    autoJoinAttemptedRef.current = null;
    setIsRestoringPairing(true);
    setReconnectTick((value) => value + 1);
  }, [clearActiveConnection, rememberedPairId]);

  // Every failed attempt gets a bounded retry. Without this, Firestore can
  // report an existing Pair ID while the camera never publishes a fresh offer,
  // and the controller will wait on a black screen forever.
  const scheduleRememberedRetry = useCallback((message: string) => {
    console.warn('[REMOTE] Remembered pairing retry:', message);
    setReconnectError(message);
    setIsRestoringPairing(true);

    if (rememberedRetryTimerRef.current) {
      clearTimeout(rememberedRetryTimerRef.current);
    }
    rememberedRetryTimerRef.current = setTimeout(() => {
      rememberedRetryTimerRef.current = null;
      restartRememberedConnection();
    }, RECONNECT_RETRY_DELAY_MS);
  }, [restartRememberedConnection]);

  const connectToSession = useCallback(async (
    scannedSessionId: string,
    options: { remembered?: boolean } = {}
  ) => {
    const isRememberedReconnect = options.remembered ?? false;

    // Not re-entrant: each run registers another pair of Firestore listeners,
    // which would duplicate every offer and candidate delivery.
    if (connectingSessionRef.current) {
      return;
    }
    connectingSessionRef.current = scannedSessionId;
    const attemptNumber = ++connectAttemptNumberRef.current;
    setReconnectError(null);

    console.log(
      isRememberedReconnect
        ? `[REMOTE] Reconnecting remembered Pair ID: ${scannedSessionId}`
        : `Scanned session ID: ${scannedSessionId}`
    );

    try {
      const joined = await withReconnectTimeout(joinSession(scannedSessionId), 'Looking up paired camera');
      if (attemptNumber !== connectAttemptNumberRef.current) return;
      if (!joined) {
        connectingSessionRef.current = null;

        if (isRememberedReconnect) {
          scheduleRememberedRetry('Camera is not advertising this pairing yet.');
          return;
        }

        Alert.alert('Error', 'Session not found. Please scan the QR code again.');
        setShowScanner(true);
        if (initialSessionId) {
          router.replace('/remote');
        }
        return;
      }

      await pairingService.saveRemotePairId(scannedSessionId);
      await pairingService.setPreferredMode('remote');
      setRememberedPairId(scannedSessionId);
      if (!isRememberedReconnect) {
        setIsRestoringPairing(false);
      }
      if (rememberedRetryTimerRef.current) {
        clearTimeout(rememberedRetryTimerRef.current);
        rememberedRetryTimerRef.current = null;
      }

      await withReconnectTimeout(createConnection(), 'Creating WebRTC connection');
      if (attemptNumber !== connectAttemptNumberRef.current) return;

      listenForIceCandidate(async (candidate) => {
        console.log('Received ICE candidate from camera');
        await addPeerIceCandidate(candidate);
      });

      // A remembered controller is a new peer generation after a long
      // suspension/relaunch. Invalidate stale SDP first, then wait only for the
      // camera's fresh offer for this generation.
      if (isRememberedReconnect) {
        const connectionId = generateConnectionId();
        console.log(`[REMOTE] Requesting fresh controller generation ${connectionId}`);
        await withReconnectTimeout(requestReconnect(connectionId), 'Publishing reconnect request');
        if (attemptNumber !== connectAttemptNumberRef.current) return;
        console.log('[REMOTE] Firestore accepted fresh controller request');

        // Even an accepted Firestore write does not mean the camera is running
        // or listening. Give it time to create an offer, answer, and open the
        // command channel. A real STATE_UPDATE clears this watchdog.
        connectWatchdogRef.current = setTimeout(() => {
          if (attemptNumber !== connectAttemptNumberRef.current) return;
          console.warn('[REMOTE] No camera state received after reconnect request');
          restartRememberedConnection();
        }, RECONNECT_ATTEMPT_TIMEOUT_MS);
      }

      onOffer(async (offer) => {
        if (attemptNumber !== connectAttemptNumberRef.current) return;
        console.log('[REMOTE] Received fresh offer from camera');
        try {
          await setRemoteDescription({ type: 'offer', sdp: offer.sdp });
          if (attemptNumber !== connectAttemptNumberRef.current) return;
          const answer = await createAnswer();
          await sendAnswer({ type: 'answer', sdp: answer.sdp! });
          console.log('[REMOTE] Published answer for camera');
        } catch (error) {
          console.error('[REMOTE] Could not answer camera offer:', error);
          if (isRememberedReconnect) {
            scheduleRememberedRetry('Camera offer could not be negotiated.');
          }
        }
      });

      setShowScanner(false);
    } catch (error) {
      if (attemptNumber !== connectAttemptNumberRef.current) return;
      console.error('[REMOTE] Could not connect to paired camera:', error);
      connectingSessionRef.current = null;

      if (isRememberedReconnect) {
        const message = error instanceof Error ? error.message : String(error);
        const actionable = /permission-denied|insufficient permissions/i.test(message)
          ? 'Firestore rejected reconnection. Publish updated firestore.rules.'
          : message;
        setShowScanner(false);
        scheduleRememberedRetry(actionable);
        return;
      }

      Alert.alert('Error', 'Failed to connect to camera. Please try again.');
      setShowScanner(true);
      if (initialSessionId) {
        router.replace('/remote');
      }
    }
  }, [
    addPeerIceCandidate,
    createAnswer,
    createConnection,
    initialSessionId,
    joinSession,
    listenForIceCandidate,
    onOffer,
    router,
    sendAnswer,
    requestReconnect,
    setRemoteDescription,
    restartRememberedConnection,
    scheduleRememberedRetry,
  ]);

  // Load the remembered camera once. A route/deep-link Pair ID takes priority;
  // otherwise the controller automatically returns to its previously paired
  // camera without opening the scanner.
  useEffect(() => {
    if (initialSessionId) {
      setPairingLoaded(true);
      return;
    }

    let cancelled = false;
    pairingService.getRemotePairId().then((savedPairId) => {
      if (cancelled) return;
      setRememberedPairId(savedPairId);
      setPairingLoaded(true);
      if (!savedPairId) {
        setShowScanner(true);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [initialSessionId]);

  useEffect(() => {
    if (!pairingLoaded) return;

    const targetPairId = initialSessionId ?? rememberedPairId;
    if (!targetPairId) return;

    if (autoJoinAttemptedRef.current === targetPairId) {
      return;
    }

    autoJoinAttemptedRef.current = targetPairId;
    setShowScanner(false);
    setIsRestoringPairing(!initialSessionId);
    void connectToSession(targetPairId, { remembered: !initialSessionId });
  }, [
    connectToSession,
    initialSessionId,
    pairingLoaded,
    rememberedPairId,
    reconnectTick,
  ]);

  // Control handlers
  const handleTakePhoto = useCallback(() => {
    sendCommand({ type: 'TAKE_PHOTO' });
  }, [sendCommand]);

  const handleStartRecording = useCallback(() => {
    sendCommand({ type: 'START_RECORDING' });
  }, [sendCommand]);

  const handleStopRecording = useCallback(() => {
    sendCommand({ type: 'STOP_RECORDING' });
  }, [sendCommand]);

  const handleToggleFlash = useCallback(() => {
    const modes: FlashMode[] = ['off', 'on', 'auto'];
    const currentIndex = modes.indexOf(remoteState.flash);
    const nextIndex = (currentIndex + 1) % modes.length;
    sendCommand({ type: 'SET_FLASH', mode: modes[nextIndex] });
  }, [sendCommand, remoteState.flash]);

  const handleSwitchCamera = useCallback(() => {
    sendCommand({ type: 'SWITCH_CAMERA' });
  }, [sendCommand]);

  const handleZoomChange = useCallback((zoom: number) => {
    sendCommand({ type: 'SET_ZOOM', level: zoom });
  }, [sendCommand]);

  const handleCaptureModeChange = useCallback((mode: CaptureMode) => {
    // Update immediately for responsive UI, and also synchronize the camera
    // phone so subsequent STATE_UPDATE messages cannot reset us to Photo.
    setRemoteState((prev) => ({ ...prev, captureMode: mode }));
    sendCommand({ type: 'SET_CAPTURE_MODE', mode });
  }, [sendCommand]);

  // Handle back navigation
  const handleBack = () => {
    clearActiveConnection();
    router.back();
  };

  // QR is now an explicit "pair a different camera" action. Normal app
  // reopen/reconnect never clears the remembered Pair ID.
  const handleQRPress = async () => {
    connectAttemptNumberRef.current += 1;
    setReconnectError(null);
    if (rememberedRetryTimerRef.current) {
      clearTimeout(rememberedRetryTimerRef.current);
      rememberedRetryTimerRef.current = null;
    }
    await pairingService.clearRemotePairId();
    setRememberedPairId(null);
    setIsRestoringPairing(false);
    autoJoinAttemptedRef.current = null;
    clearActiveConnection();
    setShowScanner(true);
    router.replace('/remote');
  };

  // Handle mode toggle - navigate back to camera mode
  const handleModeToggle = async () => {
    connectAttemptNumberRef.current += 1;
    await pairingService.setPreferredMode('camera');
    clearActiveConnection();
    router.replace('/');
  };

  // Handle settings press
  const handleSettingsPress = () => {
    router.push('/settings');
  };

  // Handle lens selection - send command to camera
  const handleLensSelect = useCallback((zoom: number) => {
    sendCommand({ type: 'SET_ZOOM', level: zoom });
  }, [sendCommand]);

  // Volume button shutter
  const handleVolumeShutter = useCallback(() => {
    if (connectionState !== 'connected' || !isDataChannelReady) return;
    if (remoteState.captureMode === 'photo') {
      handleTakePhoto();
    } else if (remoteState.isRecording) {
      handleStopRecording();
    } else {
      handleStartRecording();
    }
  }, [connectionState, isDataChannelReady, remoteState.captureMode, remoteState.isRecording, handleTakePhoto, handleStartRecording, handleStopRecording]);

  useVolumeShutter({ onShutterPress: handleVolumeShutter, enabled: !showScanner });

  // Ask the camera for its state on every (re)connect.
  //
  // Not just on data channel open: recovery from a backgrounded app is an ICE
  // restart, which reuses the existing channel, so open fires exactly once for
  // the life of the pairing. Without re-asking, a remote that dropped while in
  // WebRTC mode comes back rendering an RTCView for a track the camera has
  // since abandoned - a black screen that never resolves.
  useEffect(() => {
    if (!isForeground) return;
    if (!isDataChannelReady || showScanner) return;
    if (connectionState !== 'connected') return;

    console.log('Connected/foreground with data channel ready, requesting camera state');
    sendCommand({ type: 'GET_STATE' });

    // "connected" + "open" are native transport states, not proof that the
    // returning controller can actually exchange commands with the camera.
    // Require an application-level STATE_UPDATE acknowledgement. If it never
    // arrives, rebuild this remembered controller as a fresh peer generation.
    if (rememberedPairId) {
      if (stateSyncTimeoutRef.current) {
        clearTimeout(stateSyncTimeoutRef.current);
      }
      stateSyncTimeoutRef.current = setTimeout(() => {
        stateSyncTimeoutRef.current = null;
        console.warn('[REMOTE] GET_STATE timed out; treating connection as stale');
        restartRememberedConnection();
      }, 4000);
    }

    return () => {
      // Do not cancel merely because another render changes transport state;
      // STATE_UPDATE is the acknowledgement that owns this timer.
    };
  }, [
    isForeground,
    isDataChannelReady,
    showScanner,
    connectionState,
    sendCommand,
    rememberedPairId,
    restartRememberedConnection,
  ]);

  // The camera device normally pairs capturing:true with a later false. Clear
  // a stale busy state if the capture/recording path is interrupted.
  useEffect(() => {
    if (!isCameraCapturing) return;
    const timeout = setTimeout(() => {
      console.warn('[REMOTE] No capture-finished signal - clearing busy state');
      setIsCameraCapturing(false);
    }, 15000);
    return () => clearTimeout(timeout);
  }, [isCameraCapturing]);

  useEffect(() => {
    if (connectionState !== 'connected') {
      setIsCameraCapturing(false);
      if (rememberedPairId) {
        setIsRestoringPairing(true);
      }
    }
  }, [connectionState, rememberedPairId]);

  // Cleanup on unmount. Persistent pairing is intentionally NOT cleared.
  useEffect(() => {
    return () => {
      if (rememberedRetryTimerRef.current) {
        clearTimeout(rememberedRetryTimerRef.current);
        rememberedRetryTimerRef.current = null;
      }
      if (stateSyncTimeoutRef.current) {
        clearTimeout(stateSyncTimeoutRef.current);
        stateSyncTimeoutRef.current = null;
      }
      connectAttemptNumberRef.current += 1;
      clearActiveConnection();
    };
  }, [clearActiveConnection]);

  const effectiveConnectionState =
    connectionState === 'connected' && !isDataChannelReady
      ? 'connecting'
      : connectionState;

  return (
    <View style={styles.container}>
      {!pairingLoaded ? (
        <View style={styles.reconnectContainer} pointerEvents="none">
          <Text style={styles.reconnectText}>Loading paired camera…</Text>
        </View>
      ) : showScanner ? (
        <QRCodeScanner
          onScan={connectToSession}
          onClose={handleBack}
        />
      ) : (
        <>
          <HybridPreview
            stream={remoteStream}
            connectionState={effectiveConnectionState}
            streamMode={streamMode}
            latestFrame={latestFrame}
            facing={remoteState.facing}
            videoNeedsRotation={videoNeedsRotation}
            isCapturing={isCameraCapturing}
          />

          <CameraControls
            cameraState={remoteState}
            onTakePhoto={handleTakePhoto}
            onStartRecording={handleStartRecording}
            onStopRecording={handleStopRecording}
            onToggleFlash={handleToggleFlash}
            onSwitchCamera={handleSwitchCamera}
            onZoomChange={handleZoomChange}
            onCaptureModeChange={handleCaptureModeChange}
            disabled={connectionState !== 'connected' || !isDataChannelReady}
            onSettingsPress={handleSettingsPress}
            onQRPress={handleQRPress}
            onModeToggle={handleModeToggle}
            onLensSelect={handleLensSelect}
            availableLenses={remoteLenses}
            currentMode="remote"
            previewZoomLimited={previewZoomLimited}
          />

          {sessionId && (
            <View style={styles.sessionInfo}>
              <Text style={styles.sessionText}>
                Session: {sessionId}
              </Text>
            </View>
          )}

          {isRestoringPairing && (
            <View style={styles.reconnectBanner}>
              <Text style={styles.reconnectText}>
                {reconnectError ? 'Connection problem' : 'Connecting to paired camera…'}
              </Text>
              {reconnectError && (
                <Text style={styles.reconnectErrorText}>{reconnectError}</Text>
              )}
              {rememberedPairId && (
                <Text style={styles.reconnectSubtext}>Pair {rememberedPairId}</Text>
              )}
              <TouchableOpacity
                onPress={() => restartRememberedConnection()}
                style={styles.reconnectRetryButton}
              >
                <Text style={styles.reconnectRetryText}>Retry now</Text>
              </TouchableOpacity>
            </View>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  reconnectContainer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#000',
    zIndex: 20,
  },
  reconnectBanner: {
    position: 'absolute',
    top: 105,
    left: 20,
    right: 20,
    zIndex: 20,
    backgroundColor: 'rgba(15, 18, 24, 0.95)',
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
  },
  reconnectText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  reconnectErrorText: {
    color: '#ffb2a5',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 7,
  },
  reconnectRetryButton: {
    marginTop: 10,
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: '#374151',
  },
  reconnectRetryText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  reconnectSubtext: {
    color: '#888',
    fontSize: 12,
    marginTop: 8,
    fontFamily: 'monospace',
  },
  sessionInfo: {
    position: 'absolute',
    top: 60,
    alignSelf: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
  },
  sessionText: {
    color: '#888',
    fontSize: 10,
    fontFamily: 'monospace',
  },
});
