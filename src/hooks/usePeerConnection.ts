import { useState, useCallback, useEffect, useRef } from 'react';
import { MediaStream } from 'react-native-webrtc';
import { webRTCService } from '../services/WebRTCService';
import { ConnectionState, Command, Response, IceCandidate, CameraState, LensInfo, StreamMode } from '../types';

type Role = 'camera' | 'remote';

interface UsePeerConnectionOptions {
  role: Role;
  onCommand?: (command: Command) => void;
  onResponse?: (response: Response) => void;
  onRemoteStream?: (stream: MediaStream) => void;
  onIceCandidate?: (candidate: IceCandidate) => void;
  onDataChannelOpen?: () => void;
}

interface UsePeerConnectionReturn {
  connectionState: ConnectionState;
  remoteStream: MediaStream | null;
  localStream: MediaStream | null;
  isDataChannelReady: boolean;
  createConnection: () => Promise<void>;
  createOffer: (options?: { iceRestart?: boolean }) => Promise<RTCSessionDescriptionInit>;
  createAnswer: () => Promise<RTCSessionDescriptionInit>;
  setRemoteDescription: (description: RTCSessionDescriptionInit) => Promise<void>;
  addIceCandidate: (candidate: IceCandidate) => Promise<void>;
  sendCommand: (command: Command) => void;
  sendResponse: (response: Response) => void;
  sendStateUpdate: (state: CameraState, lenses?: LensInfo[], videoNeedsRotation?: boolean, previewZoomLimited?: boolean, streamMode?: StreamMode) => void;
  startLocalStream: () => Promise<MediaStream>;
  pauseLocalStream: () => void;
  resumeLocalStream: (facingMode?: 'front' | 'back') => Promise<void>;
  close: () => void;
}

export function usePeerConnection({
  role,
  onCommand,
  onResponse,
  onRemoteStream,
  onIceCandidate,
  onDataChannelOpen,
}: UsePeerConnectionOptions): UsePeerConnectionReturn {
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [isDataChannelReady, setIsDataChannelReady] = useState(false);

  // Holds the in-flight (or completed) connection setup so concurrent callers
  // await the same one. Cleared by close().
  const connectionPromiseRef = useRef<Promise<void> | null>(null);
  const generationRef = useRef<number | null>(null);

  // Cleanup on unmount
  //
  // WebRTCService is a singleton but RemoteScreen is exported from three routes
  // (/remote plus both deep-link routes), so two mounts can briefly overlap.
  // Only tear down the connection this mount created — otherwise the outgoing
  // screen closes the connection the incoming one just set up, and every
  // subsequent candidate/offer hits a null peer connection.
  useEffect(() => {
    return () => {
      if (generationRef.current === webRTCService.getGeneration()) {
        webRTCService.close();
      }
      generationRef.current = null;
      connectionPromiseRef.current = null;
    };
  }, []);

  // Create peer connection
  //
  // Concurrent callers must await the same setup rather than skipping it.
  // Minting TURN credentials is a network round trip, so there is a multi-second
  // window during which returning early would tell the caller the connection is
  // ready when peerConnection is still null — and the caller would then wire up
  // signaling listeners that immediately fire against nothing.
  const createConnection = useCallback(async (): Promise<void> => {
    if (connectionPromiseRef.current) {
      return connectionPromiseRef.current;
    }

    const setup = (async () => {
      await webRTCService.createPeerConnection();
      generationRef.current = webRTCService.getGeneration();

      // Set up callbacks
      webRTCService.onConnectionState((state) => {
        setConnectionState(state);
      });

      webRTCService.onRemoteStream((stream) => {
        setRemoteStream(stream);
        onRemoteStream?.(stream);
      });

      webRTCService.onIceCandidate((candidate) => {
        onIceCandidate?.(candidate);
      });

      if (onCommand) {
        webRTCService.onCommand(onCommand);
      }

      if (onResponse) {
        webRTCService.onResponse(onResponse);
      }

      webRTCService.onDataChannelOpen(() => {
        console.log('Data channel is now ready');
        setIsDataChannelReady(true);
        onDataChannelOpen?.();
      });

      webRTCService.onDataChannelClose(() => {
        console.log('Data channel is no longer ready');
        setIsDataChannelReady(false);
      });

      // Camera device creates the data channel
      if (role === 'camera') {
        webRTCService.createDataChannel();
      }

      setConnectionState('connecting');
    })();

    // Assigned before the first await returns to the caller, so a second call
    // can never slip in and start a competing connection.
    connectionPromiseRef.current = setup;

    try {
      await setup;
    } catch (error) {
      connectionPromiseRef.current = null;
      throw error;
    }
  }, [role, onCommand, onResponse, onRemoteStream, onIceCandidate, onDataChannelOpen]);

  // Create SDP offer (camera device)
  const createOffer = useCallback(async (
    options: { iceRestart?: boolean } = {}
  ): Promise<RTCSessionDescriptionInit> => {
    return webRTCService.createOffer(options);
  }, []);

  // Create SDP answer (remote device)
  const createAnswer = useCallback(async (): Promise<RTCSessionDescriptionInit> => {
    return webRTCService.createAnswer();
  }, []);

  // Set remote description
  const setRemoteDescription = useCallback(async (
    description: RTCSessionDescriptionInit
  ): Promise<void> => {
    await webRTCService.setRemoteDescription(description);
  }, []);

  // Add ICE candidate
  const addIceCandidate = useCallback(async (candidate: IceCandidate): Promise<void> => {
    try {
      await webRTCService.addIceCandidate(candidate);
    } catch (error) {
      console.error('Error adding ICE candidate:', error);
      // Don't throw - ICE failures are often recoverable
    }
  }, []);

  // Send command (remote device)
  const sendCommand = useCallback((command: Command): void => {
    webRTCService.sendCommand(command);
  }, []);

  // Send response (camera device)
  const sendResponse = useCallback((response: Response): void => {
    webRTCService.sendResponse(response);
  }, []);

  // Send state update (camera device)
  const sendStateUpdate = useCallback((state: CameraState, lenses?: LensInfo[], videoNeedsRotation?: boolean, previewZoomLimited?: boolean, streamMode?: StreamMode): void => {
    webRTCService.sendResponse({
      type: 'STATE_UPDATE',
      state,
      lenses,
      videoNeedsRotation,
      previewZoomLimited,
      streamMode,
    });
  }, []);

  // Start local stream and add to connection (camera device)
  const startLocalStream = useCallback(async (): Promise<MediaStream> => {
    console.log(`[usePeerConnection] startLocalStream called`);
    try {
      const stream = await webRTCService.getLocalStream('back');
      console.log(`[usePeerConnection] startLocalStream: Got stream, setting state`);
      setLocalStream(stream);
      console.log(`[usePeerConnection] startLocalStream: Adding stream to peer connection`);
      webRTCService.addLocalStream(stream);
      console.log(`[usePeerConnection] startLocalStream: Complete`);
      return stream;
    } catch (error) {
      console.error(`[usePeerConnection] startLocalStream FAILED:`, error);
      throw error;
    }
  }, []);

  // Pause local stream (releases camera hardware for vision-camera)
  const pauseLocalStream = useCallback((): void => {
    console.log(`[usePeerConnection] pauseLocalStream called`);
    webRTCService.pauseLocalStream();
  }, []);

  // Resume local stream (gets new stream after vision-camera is done)
  const resumeLocalStream = useCallback(async (facingMode: 'front' | 'back' = 'back'): Promise<void> => {
    console.log(`[usePeerConnection] resumeLocalStream called: facingMode=${facingMode}`);
    await webRTCService.resumeLocalStream(facingMode);
    const stream = webRTCService.getLocalStreamRef();
    console.log(`[usePeerConnection] resumeLocalStream: Got stream ref: ${!!stream}`);
    if (stream) {
      setLocalStream(stream);
    }
  }, []);

  // Close connection
  const close = useCallback((): void => {
    webRTCService.close();
    generationRef.current = null;
    connectionPromiseRef.current = null;
    setConnectionState('disconnected');
    setRemoteStream(null);
    setLocalStream(null);
    setIsDataChannelReady(false);
  }, []);

  return {
    connectionState,
    remoteStream,
    localStream,
    isDataChannelReady,
    createConnection,
    createOffer,
    createAnswer,
    setRemoteDescription,
    addIceCandidate,
    sendCommand,
    sendResponse,
    sendStateUpdate,
    startLocalStream,
    pauseLocalStream,
    resumeLocalStream,
    close,
  };
}

export default usePeerConnection;
