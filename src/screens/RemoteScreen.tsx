import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import {
  View,
  StyleSheet,
  Text,
  Alert,
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
import { webRTCService } from '../services/WebRTCService';
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

  // UI state
  const [showScanner, setShowScanner] = useState(!initialSessionId);
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
    onOffer,
    addIceCandidate: addSignalingIceCandidate,
    onIceCandidate: listenForIceCandidate,
    cleanup: cleanupSignaling,
  } = useSignaling('remote');

  // Handle frame data from camera device (for frame-based streaming)
  const framesReceivedRef = useRef(0);
  const autoJoinAttemptedRef = useRef<string | null>(null);
  const connectingSessionRef = useRef<string | null>(null);
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
    webRTCService.onFrameData(handleFrameData);
  }, [handleFrameData]);

  const handleDataChannelClose = useCallback(() => {
    console.log('Data channel closed on controller');
    setIsDataChannelReady(false);
  }, []);

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
    cleanupSignaling();
    closeConnection();
    connectingSessionRef.current = null;
    setIsDataChannelReady(false);
  }, [cleanupSignaling, closeConnection]);

  const connectToSession = useCallback(async (scannedSessionId: string) => {
    // Not re-entrant: each run registers another pair of Firestore listeners,
    // which would duplicate every offer and candidate delivery.
    if (connectingSessionRef.current) {
      return;
    }
    connectingSessionRef.current = scannedSessionId;

    console.log('Scanned session ID:', scannedSessionId);

    try {
      const joined = await joinSession(scannedSessionId);
      if (!joined) {
        Alert.alert('Error', 'Session not found. Please scan the QR code again.');
        connectingSessionRef.current = null;
        setShowScanner(true);
        if (initialSessionId) {
          router.replace('/remote');
        }
        return;
      }

      await createConnection();

      listenForIceCandidate(async (candidate) => {
        console.log('Received ICE candidate from camera');
        await addPeerIceCandidate(candidate);
      });

      onOffer(async (offer) => {
        console.log('Received offer from camera');

        await setRemoteDescription({ type: 'offer', sdp: offer.sdp });

        const answer = await createAnswer();
        await sendAnswer({ type: 'answer', sdp: answer.sdp! });
      });

      setShowScanner(false);
    } catch (error) {
      console.error('Error connecting to camera:', error);
      Alert.alert('Error', 'Failed to connect to camera. Please try again.');
      connectingSessionRef.current = null;
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
    setRemoteDescription,
  ]);

  useEffect(() => {
    if (!initialSessionId) {
      return;
    }

    if (autoJoinAttemptedRef.current === initialSessionId) {
      return;
    }

    autoJoinAttemptedRef.current = initialSessionId;
    setShowScanner(false);
    connectToSession(initialSessionId);
  }, [connectToSession, initialSessionId]);

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

  // Handle QR scanner button - show scanner to connect to a new camera
  const handleQRPress = () => {
    clearActiveConnection();
    setShowScanner(true);
    router.replace('/remote');
  };

  // Handle mode toggle - navigate back to camera mode
  const handleModeToggle = () => {
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
    if (connectionState !== 'connected') return;
    if (remoteState.captureMode === 'photo') {
      handleTakePhoto();
    } else if (remoteState.isRecording) {
      handleStopRecording();
    } else {
      handleStartRecording();
    }
  }, [connectionState, remoteState.captureMode, remoteState.isRecording, handleTakePhoto, handleStartRecording, handleStopRecording]);

  useVolumeShutter({ onShutterPress: handleVolumeShutter, enabled: !showScanner });

  // Ask the camera for its state on every (re)connect.
  //
  // Not just on data channel open: recovery from a backgrounded app is an ICE
  // restart, which reuses the existing channel, so open fires exactly once for
  // the life of the pairing. Without re-asking, a remote that dropped while in
  // WebRTC mode comes back rendering an RTCView for a track the camera has
  // since abandoned - a black screen that never resolves.
  useEffect(() => {
    if (!isDataChannelReady || showScanner) return;
    if (connectionState !== 'connected') return;

    console.log('Connected with data channel ready, requesting camera state');
    sendCommand({ type: 'GET_STATE' });
  }, [isDataChannelReady, showScanner, connectionState, sendCommand]);

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
    }
  }, [connectionState]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      clearActiveConnection();
    };
  }, [clearActiveConnection]);

  return (
    <View style={styles.container}>
      {showScanner ? (
        <QRCodeScanner
          onScan={connectToSession}
          onClose={handleBack}
        />
      ) : (
        <>
          <HybridPreview
            stream={remoteStream}
            connectionState={connectionState}
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
