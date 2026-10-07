import {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
  MediaStream,
  mediaDevices,
  MediaStreamTrack,
} from 'react-native-webrtc';
import { getRtcConfig, DATA_CHANNEL_CONFIG, COMMAND_CHANNEL_NAME } from '../config/webrtc';
import { Command, Response, IceCandidate, ConnectionState, FrameDataMessage } from '../types';

type CommandCallback = (command: Command) => void;
type ResponseCallback = (response: Response) => void;
type StreamCallback = (stream: MediaStream) => void;
type StateCallback = (state: ConnectionState) => void;
type IceCandidateEmitCallback = (candidate: IceCandidate) => void;
type DataChannelOpenCallback = () => void;
type DataChannelCloseCallback = () => void;
type FrameDataCallback = (frameData: FrameDataMessage) => void;

// Type definitions for react-native-webrtc events
interface RTCPeerConnectionIceEvent {
  candidate: RTCIceCandidate | null;
}

interface RTCTrackEvent {
  streams: MediaStream[];
  track: MediaStreamTrack;
}

interface RTCDataChannelEvent {
  channel: any;
}

class WebRTCService {
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: any = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;

  // Keep the original video sender even when its camera track is temporarily
  // detached for a long-running Vision Camera recording. The transceiver/media
  // section stays in the peer connection, but WebRTC no longer owns an
  // AVFoundation capture track until recording explicitly stops.
  private videoSender: any = null;

  // ICE candidates that arrived before there was a remote description to
  // attach them to. See addIceCandidate for why this is the normal case.
  private pendingIceCandidates: IceCandidate[] = [];

  // Bumped on every create/close. Callers that tear down on unmount pass the
  // generation they created so a stale screen can't close a live connection.
  private generation = 0;

  // Lock to prevent concurrent stream switching operations
  private isSwitchingStream: boolean = false;
  private pendingSwitch: { facingMode: 'front' | 'back'; zoom: number } | null = null;

  private onCommandCallback: CommandCallback | null = null;
  private onResponseCallback: ResponseCallback | null = null;
  private onRemoteStreamCallback: StreamCallback | null = null;
  private onConnectionStateCallback: StateCallback | null = null;
  private onIceCandidateCallback: IceCandidateEmitCallback | null = null;
  private onDataChannelOpenCallback: DataChannelOpenCallback | null = null;
  private onDataChannelCloseCallback: DataChannelCloseCallback | null = null;
  private onFrameDataCallback: FrameDataCallback | null = null;

  // Create peer connection
  // Async because TURN credentials are minted on demand by a Cloud Function.
  async createPeerConnection(): Promise<RTCPeerConnection> {
    if (this.peerConnection) {
      this.peerConnection.close();
      // Null it before awaiting: minting TURN credentials takes a round trip,
      // and anything arriving in that window should queue rather than be
      // applied to a connection that's already closed.
      this.peerConnection = null;
    }
    this.pendingIceCandidates = [];
    this.videoSender = null;
    this.generation++;

    const rtcConfig = await getRtcConfig();
    this.peerConnection = new RTCPeerConnection(rtcConfig as any);

    // Handle ICE candidates
    (this.peerConnection as any).onicecandidate = (event: RTCPeerConnectionIceEvent) => {
      if (event.candidate && this.onIceCandidateCallback) {
        this.onIceCandidateCallback({
          candidate: event.candidate.candidate as string,
          sdpMLineIndex: event.candidate.sdpMLineIndex as number,
          sdpMid: event.candidate.sdpMid as string,
        });
      }
    };

    // Handle connection state changes
    (this.peerConnection as any).onconnectionstatechange = () => {
      if (this.onConnectionStateCallback && this.peerConnection) {
        const state = this.mapConnectionState(
          (this.peerConnection as any).connectionState
        );
        this.onConnectionStateCallback(state);
      }
    };

    // Handle ICE connection state changes
    (this.peerConnection as any).oniceconnectionstatechange = () => {
      console.log(
        'ICE connection state:',
        this.peerConnection?.iceConnectionState
      );
    };

    // Handle incoming tracks (remote stream)
    (this.peerConnection as any).ontrack = (event: RTCTrackEvent) => {
      console.log(`[WebRTC] ontrack event: track kind=${event.track?.kind}, id=${event.track?.id}, readyState=${event.track?.readyState}`);
      console.log(`[WebRTC] ontrack event: streams count=${event.streams?.length}`);
      if (event.streams && event.streams[0]) {
        this.remoteStream = event.streams[0];
        const tracks = this.remoteStream.getTracks();
        console.log(`[WebRTC] ontrack: Remote stream has ${tracks.length} tracks:`, tracks.map(t => `${t.kind}:${t.id}:${t.readyState}`));
        if (this.onRemoteStreamCallback) {
          this.onRemoteStreamCallback(event.streams[0]);
        }
      } else {
        console.log(`[WebRTC] ontrack: No streams in event`);
      }
    };

    // Handle incoming data channel
    (this.peerConnection as any).ondatachannel = (event: RTCDataChannelEvent) => {
      this.setupDataChannel(event.channel);
    };

    return this.peerConnection;
  }

  // Map WebRTC connection state to our state
  private mapConnectionState(state: string): ConnectionState {
    switch (state) {
      case 'connected':
        return 'connected';
      case 'connecting':
        return 'connecting';
      case 'failed':
      case 'closed':
        return 'failed';
      default:
        return 'disconnected';
    }
  }

  // Create data channel (called by the initiator/camera device)
  createDataChannel(): any {
    if (!this.peerConnection) {
      console.error('Peer connection not initialized');
      return null;
    }

    const channel = this.peerConnection.createDataChannel(
      COMMAND_CHANNEL_NAME,
      DATA_CHANNEL_CONFIG as any
    );

    this.setupDataChannel(channel);
    return channel;
  }

  // Set up data channel event handlers
  private setupDataChannel(channel: any): void {
    this.dataChannel = channel;

    channel.onopen = () => {
      console.log('Data channel opened');
      if (this.onDataChannelOpenCallback) {
        this.onDataChannelOpenCallback();
      }
    };

    channel.onclose = () => {
      console.log('Data channel closed');

      // Ignore a stale channel closing after a replacement channel has already
      // been installed. Only the currently active channel owns readiness.
      if (this.dataChannel === channel) {
        this.dataChannel = null;
        if (this.onDataChannelCloseCallback) {
          this.onDataChannelCloseCallback();
        }
      }
    };

    channel.onmessage = (event: { data: string }) => {
      try {
        const message = JSON.parse(event.data);

        // Check if it's a frame data message (high frequency, handle first)
        if (this.isFrameData(message) && this.onFrameDataCallback) {
          this.onFrameDataCallback(message);
        } else if (this.isCommand(message) && this.onCommandCallback) {
          this.onCommandCallback(message);
        } else if (this.isResponse(message) && this.onResponseCallback) {
          this.onResponseCallback(message);
        }
      } catch (error) {
        console.error('Error parsing data channel message:', error);
      }
    };

    channel.onerror = (error: any) => {
      console.error('Data channel error:', error);
    };
  }

  // Type guards for messages
  private isCommand(message: unknown): message is Command {
    if (!message || typeof message !== 'object') return false;
    const m = message as { type?: string };
    return [
      'TAKE_PHOTO',
      'START_RECORDING',
      'STOP_RECORDING',
      'SET_ZOOM',
      'SET_FLASH',
      'SET_CAPTURE_MODE',
      'SWITCH_CAMERA',
      'GET_STATE',
    ].includes(m.type || '');
  }

  private isResponse(message: unknown): message is Response {
    if (!message || typeof message !== 'object') return false;
    const m = message as { type?: string };
    return [
      'PHOTO_TAKEN',
      'RECORDING_STARTED',
      'RECORDING_STOPPED',
      'STATE_UPDATE',
      'ERROR',
      'CAPTURE_STATE',
      'FRAME_DATA',
      'PHOTO_DATA',
    ].includes(m.type || '');
  }

  // Type guard for frame data messages
  private isFrameData(message: unknown): message is FrameDataMessage {
    if (!message || typeof message !== 'object') return false;
    const m = message as { type?: string };
    return m.type === 'FRAME_DATA';
  }

  // Create and return SDP offer
  //
  // iceRestart re-gathers candidates with a fresh ufrag/pwd on the existing
  // connection. That's the recovery path after the app is backgrounded: it
  // keeps the data channel (SCTP survives an ICE restart) and the negotiated
  // media sections, so neither side has to re-pair.
  async createOffer(
    options: { iceRestart?: boolean } = {}
  ): Promise<RTCSessionDescriptionInit> {
    if (!this.peerConnection) {
      throw new Error('Peer connection not initialized');
    }

    const offer = await this.peerConnection.createOffer({
      offerToReceiveAudio: false,
      offerToReceiveVideo: true,
      iceRestart: options.iceRestart ?? false,
    } as any);

    await this.peerConnection.setLocalDescription(offer as any);
    return offer as RTCSessionDescriptionInit;
  }

  // Create and return SDP answer
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    if (!this.peerConnection) {
      throw new Error('Peer connection not initialized');
    }

    const answer = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answer as any);
    return answer as RTCSessionDescriptionInit;
  }

  // Set remote description
  async setRemoteDescription(
    description: RTCSessionDescriptionInit
  ): Promise<void> {
    if (!this.peerConnection) {
      throw new Error('Peer connection not initialized');
    }

    // Check signaling state - only set remote description if we're in the right state
    const signalingState = (this.peerConnection as any).signalingState;
    if (description.type === 'answer' && signalingState !== 'have-local-offer') {
      console.log(`Ignoring answer - signaling state is '${signalingState}', expected 'have-local-offer'`);
      // A duplicate description still means an earlier one landed, so any
      // candidates buffered since then are ready to apply.
      await this.flushPendingIceCandidates();
      return;
    }
    if (description.type === 'offer' && signalingState !== 'stable') {
      console.log(`Ignoring offer - signaling state is '${signalingState}', expected 'stable'`);
      await this.flushPendingIceCandidates();
      return;
    }

    const rtcDescription = new RTCSessionDescription({
      type: description.type as any,
      sdp: description.sdp || '',
    });
    await this.peerConnection.setRemoteDescription(rtcDescription as any);

    await this.flushPendingIceCandidates();
  }

  // Add ICE candidate
  //
  // Candidates routinely arrive before we can use them. The camera finishes
  // gathering while the QR code is still on screen, so when the remote joins,
  // Firestore replays the whole offerCandidates collection in one batch — and
  // that listener races the separate session-doc listener carrying the offer.
  // Queue anything that arrives early and flush once the remote description
  // is in place.
  async addIceCandidate(candidate: IceCandidate): Promise<void> {
    if (!this.peerConnection || !(this.peerConnection as any).remoteDescription) {
      this.pendingIceCandidates.push(candidate);
      return;
    }

    await this.applyIceCandidate(candidate);
  }

  private async applyIceCandidate(candidate: IceCandidate): Promise<void> {
    const rtcCandidate = new RTCIceCandidate({
      candidate: candidate.candidate,
      sdpMLineIndex: candidate.sdpMLineIndex,
      sdpMid: candidate.sdpMid,
    });

    await this.peerConnection!.addIceCandidate(rtcCandidate as any);
  }

  // Apply candidates that were buffered while the remote description was unset
  private async flushPendingIceCandidates(): Promise<void> {
    if (!this.peerConnection || !(this.peerConnection as any).remoteDescription) {
      return;
    }
    if (this.pendingIceCandidates.length === 0) {
      return;
    }

    const queued = this.pendingIceCandidates;
    this.pendingIceCandidates = [];
    console.log(`[WebRTC] Applying ${queued.length} buffered ICE candidates`);

    for (const candidate of queued) {
      try {
        await this.applyIceCandidate(candidate);
      } catch (error) {
        // One bad candidate shouldn't stop the rest; ICE only needs one to work.
        console.warn('[WebRTC] Failed to apply buffered ICE candidate:', error);
      }
    }
  }

  // Get local media stream for camera
  // zoom parameter helps select the appropriate physical lens (0.5 = ultra-wide, 1 = wide, 2+ = telephoto)
  async getLocalStream(facingMode: 'front' | 'back' = 'back', zoom: number = 1): Promise<MediaStream> {
    console.log(`[WebRTC] getLocalStream called: facingMode=${facingMode}, zoom=${zoom}`);
    console.log(`[WebRTC] Current localStream exists: ${!!this.localStream}`);
    if (this.localStream) {
      const tracks = this.localStream.getTracks();
      console.log(`[WebRTC] Existing stream has ${tracks.length} tracks:`, tracks.map(t => `${t.kind}:${t.readyState}`));
    }

    const sourceInfos = await mediaDevices.enumerateDevices() as any[];
    console.log(`[WebRTC] Found ${sourceInfos.length} media devices`);

    // Find all video devices matching the facing mode
    const targetFacing = facingMode === 'front' ? 'front' : 'environment';
    const matchingDevices = sourceInfos.filter(
      (info: any) => info.kind === 'videoinput' && info.facing === targetFacing
    );

    let videoSourceId: string | undefined;

    if (facingMode === 'back' && matchingDevices.length > 1) {
      // Multiple back cameras - try to select based on zoom level
      const sortedDevices = [...matchingDevices].sort((a: any, b: any) =>
        (a.label || '').localeCompare(b.label || '')
      );

      // Try to identify lenses by label patterns
      const ultraWide = sortedDevices.find((d: any) =>
        /ultra|wide.*angle|0\.5|0\.6/i.test(d.label || '')
      );
      const telephoto = sortedDevices.find((d: any) =>
        /tele|zoom|2x|3x|5x/i.test(d.label || '')
      );
      // Find main/wide camera - exclude ultra-wide and telephoto
      const wide = sortedDevices.find((d: any) =>
        d.deviceId !== ultraWide?.deviceId &&
        d.deviceId !== telephoto?.deviceId
      ) || sortedDevices[0];

      // Select device based on zoom level
      if (zoom < 0.8) {
        // Ultra-wide zoom range
        if (ultraWide) {
          videoSourceId = ultraWide.deviceId;
        } else if (sortedDevices.length >= 2) {
          // Fallback: ultra-wide often at index 1
          videoSourceId = sortedDevices[1]?.deviceId;
        }
      } else if (zoom >= 1.8) {
        // Telephoto zoom range
        if (telephoto) {
          videoSourceId = telephoto.deviceId;
        } else if (sortedDevices.length >= 3) {
          // Fallback: telephoto often at index 2
          videoSourceId = sortedDevices[2]?.deviceId;
        } else {
          // Device doesn't have 3 cameras, use main camera
          videoSourceId = wide?.deviceId || sortedDevices[0]?.deviceId;
        }
      } else {
        // Normal zoom range (0.8 - 1.8) - use main wide camera
        videoSourceId = wide?.deviceId || sortedDevices[0]?.deviceId;
      }
    }

    // Default fallback - use first matching device
    if (!videoSourceId && matchingDevices.length > 0) {
      videoSourceId = matchingDevices[0].deviceId;
    }

    const constraints: any = {
      audio: false,
      video: {
        // Remote preview is only for framing. Keep it deliberately small so
        // poor Wi-Fi / hotspot connections do not compete with camera control.
        width: { ideal: 640 },
        height: { ideal: 360 },
        frameRate: { ideal: 15 },
        facingMode: facingMode === 'front' ? 'user' : 'environment',
        ...(videoSourceId ? { deviceId: videoSourceId } : {}),
      },
    };

    // Try to request zoom if supported (note: not supported in react-native-webrtc)
    if (zoom !== 1) {
      constraints.video.advanced = [{ zoom: zoom }];
    }

    console.log(`[WebRTC] Calling getUserMedia with constraints:`, JSON.stringify(constraints));
    try {
      const stream = await mediaDevices.getUserMedia(constraints);
      this.localStream = stream as MediaStream;
      const tracks = this.localStream.getTracks();
      console.log(`[WebRTC] getUserMedia success: got ${tracks.length} tracks:`, tracks.map(t => `${t.kind}:${t.id}:${t.readyState}`));
      return this.localStream;
    } catch (error) {
      console.error(`[WebRTC] getUserMedia FAILED:`, error);
      throw error;
    }
  }

  // Add local stream to peer connection
  addLocalStream(stream: MediaStream): void {
    if (!this.peerConnection) {
      throw new Error('Peer connection not initialized');
    }

    const videoTracks = stream.getVideoTracks();
    console.log(`[WebRTC] addLocalStream: Adding ${videoTracks.length} video tracks to peer connection`);
    videoTracks.forEach((track, i) => {
      console.log(`[WebRTC] addLocalStream: Track ${i}: id=${track.id}, readyState=${track.readyState}`);
      const sender = this.peerConnection!.addTrack(track, stream);
      if (track.kind === 'video') {
        this.videoSender = sender;
      }
    });
    console.log(`[WebRTC] addLocalStream: Complete. Senders count: ${this.peerConnection.getSenders().length}`);
  }

  // Send command via data channel
  sendCommand(command: Command): void {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      console.error('Data channel not ready');
      return;
    }

    this.dataChannel.send(JSON.stringify(command));
  }

  // Send response via data channel
  sendResponse(response: Response): void {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      console.error('Data channel not ready');
      return;
    }

    this.dataChannel.send(JSON.stringify(response));
  }

  // Send frame data via data channel (for frame-based streaming)
  private framesSentCount = 0;
  private framesFailedCount = 0;
  sendFrameData(frameId: number, base64Data: string, timestamp: number): void {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      this.framesFailedCount++;
      if (this.framesFailedCount % 10 === 1) {
        console.log(`[WebRTC] sendFrameData: Data channel not ready (state=${this.dataChannel?.readyState}), failed=${this.framesFailedCount}`);
      }
      return;
    }

    const frameDataMessage: FrameDataMessage = {
      type: 'FRAME_DATA',
      frameId,
      data: base64Data,
      timestamp,
    };

    try {
      const msgSize = JSON.stringify(frameDataMessage).length;
      this.dataChannel.send(JSON.stringify(frameDataMessage));
      this.framesSentCount++;
      // Log every 10 frames
      if (this.framesSentCount % 10 === 1) {
        console.log(`[WebRTC] sendFrameData: Sent frame ${frameId}, size=${msgSize}, total sent=${this.framesSentCount}`);
      }
    } catch (error) {
      this.framesFailedCount++;
      console.log(`[WebRTC] sendFrameData FAILED: frameId=${frameId}, error=`, error);
    }
  }

  // Set callback for incoming commands
  onCommand(callback: CommandCallback): void {
    this.onCommandCallback = callback;
  }

  // Set callback for incoming responses
  onResponse(callback: ResponseCallback): void {
    this.onResponseCallback = callback;
  }

  // Set callback for remote stream
  onRemoteStream(callback: StreamCallback): void {
    this.onRemoteStreamCallback = callback;
  }

  // Set callback for connection state changes
  onConnectionState(callback: StateCallback): void {
    this.onConnectionStateCallback = callback;
  }

  // Set callback for ICE candidates
  onIceCandidate(callback: IceCandidateEmitCallback): void {
    this.onIceCandidateCallback = callback;
  }

  // Set callback for data channel open
  onDataChannelOpen(callback: DataChannelOpenCallback): void {
    this.onDataChannelOpenCallback = callback;
  }

  // Set callback for data channel close
  onDataChannelClose(callback: DataChannelCloseCallback): void {
    this.onDataChannelCloseCallback = callback;
  }

  // Set callback for frame data messages
  onFrameData(callback: FrameDataCallback): void {
    this.onFrameDataCallback = callback;
  }

  // Get remote stream
  getRemoteStream(): MediaStream | null {
    return this.remoteStream;
  }

  // Get local stream
  getLocalStreamRef(): MediaStream | null {
    return this.localStream;
  }

  // Pause local stream for short handoffs such as still photos.
  //
  // track.enabled = false is cheap and lets preview resume immediately. For a
  // long video recording we deliberately do something stronger in
  // detachLocalVideoTrackForRecording(): first replaceTrack(null) so the sender
  // remains negotiated, then stop the old native capture track. That ordering
  // keeps WebRTC signaling/DataChannel independent from AVFoundation ownership.
  pauseLocalStream(): void {
    console.log(`[WebRTC] pauseLocalStream called. localStream exists: ${!!this.localStream}`);
    if (this.localStream) {
      const tracks = this.localStream.getVideoTracks();
      console.log(`[WebRTC] pauseLocalStream: Disabling ${tracks.length} video tracks`);
      tracks.forEach((track, i) => {
        console.log(`[WebRTC] pauseLocalStream: Track ${i} before: id=${track.id}, readyState=${track.readyState}, enabled=${track.enabled}`);
        track.enabled = false;
        console.log(`[WebRTC] pauseLocalStream: Track ${i} after: readyState=${track.readyState}, enabled=${track.enabled}`);
      });
    } else {
      console.log(`[WebRTC] pauseLocalStream: No local stream to pause`);
    }
  }

  /**
   * Fully detach WebRTC's camera capture for a long-running local video.
   *
   * Disabling a track is enough for short photo handoffs, but on iOS the
   * disabled getUserMedia track still belongs to WebRTC/AVFoundation. An ICE
   * restart can renegotiate that media section and disturb Vision Camera,
   * causing its recording to finish as soon as connectivity returns.
   *
   * replaceTrack(null) keeps the negotiated video sender/transceiver in place
   * while removing the native capture source. We then stop the old track so
   * Vision Camera exclusively owns the camera until explicit Stop Recording.
   */
  async detachLocalVideoTrackForRecording(): Promise<void> {
    console.log(`[WebRTC] detachLocalVideoTrackForRecording called. localStream exists: ${!!this.localStream}`);

    const tracks = this.localStream?.getVideoTracks() ?? [];
    const sender =
      this.videoSender ??
      this.peerConnection?.getSenders().find((candidate: any) => candidate.track?.kind === 'video') ??
      null;

    if (sender) {
      this.videoSender = sender;
      try {
        console.log('[WebRTC] Detaching video sender track for recording');
        await sender.replaceTrack(null);
      } catch (error) {
        // Stopping the capture track below is still essential even if this
        // native implementation rejects replaceTrack(null).
        console.error('[WebRTC] Failed to detach video sender track:', error);
      }
    }

    tracks.forEach((track, i) => {
      console.log(`[WebRTC] Stopping recording handoff track ${i}: id=${track.id}, readyState=${track.readyState}`);
      track.stop();
    });

    this.localStream = null;
  }

  // Resume local stream. If the existing track is just paused
  // (enabled=false, readyState='live' - the pauseLocalStream path), re-enable
  // it. Only get a fresh stream and replace the sender's track if the track
  // is actually gone.
  async resumeLocalStream(facingMode: 'front' | 'back' = 'back', zoom: number = 1): Promise<void> {
    console.log(`[WebRTC] resumeLocalStream called: facingMode=${facingMode}, zoom=${zoom}`);
    if (!this.peerConnection) {
      console.error('[WebRTC] resumeLocalStream: Peer connection not initialized');
      return;
    }

    try {
      const existingTrack = this.localStream?.getVideoTracks()[0];
      if (existingTrack && existingTrack.readyState === 'live') {
        existingTrack.enabled = true;
        console.log(`[WebRTC] resumeLocalStream: Re-enabled existing track ${existingTrack.id} (readyState=${existingTrack.readyState})`);
        return;
      }

      // Get a new stream with the appropriate lens
      console.log(`[WebRTC] resumeLocalStream: Getting new local stream...`);
      const newStream = await this.getLocalStream(facingMode, zoom);

      // Replace the video track in the peer connection. During video recording
      // videoSender.track is intentionally null, so remember the sender rather
      // than trying to rediscover it by sender.track.kind.
      const senders = this.peerConnection.getSenders();
      const videoTrack = newStream.getVideoTracks()[0];
      console.log(`[WebRTC] resumeLocalStream: Got ${senders.length} senders, new videoTrack: ${videoTrack?.id}, readyState: ${videoTrack?.readyState}`);

      const sender =
        this.videoSender ??
        senders.find((candidate: any) => candidate.track?.kind === 'video') ??
        null;

      if (sender && videoTrack) {
        this.videoSender = sender;
        console.log(`[WebRTC] resumeLocalStream: Restoring video track on existing sender. New: ${videoTrack.id}`);
        await sender.replaceTrack(videoTrack);
        console.log('[WebRTC] resumeLocalStream: Track replaced successfully');
      } else if (videoTrack) {
        console.log('[WebRTC] resumeLocalStream: No existing video sender; adding track');
        this.videoSender = this.peerConnection.addTrack(videoTrack, newStream);
      }
    } catch (error) {
      console.error('[WebRTC] resumeLocalStream error:', error);
    }
  }

  // Switch to a different lens by replacing the video track
  async switchLens(facingMode: 'front' | 'back', zoom: number): Promise<void> {
    // If already switching, queue this request (only keep the latest)
    if (this.isSwitchingStream) {
      this.pendingSwitch = { facingMode, zoom };
      return;
    }

    if (!this.peerConnection || !this.localStream) {
      console.error('Peer connection or stream not initialized for lens switch');
      return;
    }

    this.isSwitchingStream = true;

    try {
      // First, try to apply zoom constraint to existing track
      // Note: This is not supported in react-native-webrtc on Android,
      // but we try anyway in case future versions add support
      const videoTrack = this.localStream.getVideoTracks()[0];
      if (videoTrack) {
        try {
          const capabilities = (videoTrack as any).getCapabilities?.();
          if (capabilities?.zoom) {
            const clampedZoom = Math.max(capabilities.zoom.min, Math.min(capabilities.zoom.max, zoom));
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (videoTrack as any).applyConstraints({
              advanced: [{ zoom: clampedZoom }]
            });
            this.isSwitchingStream = false;
            if (this.pendingSwitch) {
              const pending = this.pendingSwitch;
              this.pendingSwitch = null;
              setTimeout(() => {
                this.switchLens(pending.facingMode, pending.zoom);
              }, 50);
            }
            return;
          }
        } catch {
          // Zoom constraints not supported, fall through to camera switch
        }
      }

      // Fallback: Stop ALL tracks in the current stream to fully release the camera
      this.localStream.getTracks().forEach((track) => {
        track.stop();
      });

      // Small delay to ensure camera is fully released on Android
      await new Promise(resolve => setTimeout(resolve, 100));

      // Get new stream with the desired lens
      const newStream = await this.getLocalStream(facingMode, zoom);

      // Replace video track in the peer connection
      const senders = this.peerConnection.getSenders();
      const newVideoTrack = newStream.getVideoTracks()[0];

      for (const sender of senders) {
        if (sender.track?.kind === 'video' && newVideoTrack) {
          await sender.replaceTrack(newVideoTrack);
        }
      }
    } catch (error) {
      console.error('Error switching lens:', error);
    } finally {
      this.isSwitchingStream = false;

      // Process any pending switch request
      if (this.pendingSwitch) {
        const pending = this.pendingSwitch;
        this.pendingSwitch = null;
        setTimeout(() => {
          this.switchLens(pending.facingMode, pending.zoom);
        }, 50);
      }
    }
  }

  // Check if data channel is ready
  isDataChannelReady(): boolean {
    return this.dataChannel?.readyState === 'open';
  }

  /**
   * Long outages can permanently close SCTP while the RTCPeerConnection object
   * is still reusable for an ICE restart. Recreate the command channel before
   * renegotiating so a returning (or replacement) controller can control an
   * ongoing local recording.
   */
  ensureDataChannel(): void {
    if (!this.peerConnection) {
      return;
    }

    const state = this.dataChannel?.readyState;
    if (!this.dataChannel || state === 'closed' || state === 'closing') {
      console.log('[WebRTC] Recreating command data channel for recovery');
      this.createDataChannel();
    }
  }

  // Whether there is a connection to renegotiate onto at all. close() can land
  // between a reconnect being scheduled and it firing.
  hasPeerConnection(): boolean {
    return this.peerConnection !== null;
  }

  // Whether the capture track we're sending is still producing media.
  //
  // Android ends the track when the app is backgrounded, and an ended track
  // stays attached to its sender - ICE can come back with the remote still
  // seeing nothing. Callers replace the track before renegotiating.
  hasLiveVideoTrack(): boolean {
    const track = this.localStream?.getVideoTracks()[0];
    return track?.readyState === 'live';
  }

  // Generation of the current peer connection, for close() ownership checks
  getGeneration(): number {
    return this.generation;
  }

  // Close connection and cleanup
  close(): void {
    this.generation++;
    this.pendingIceCandidates = [];

    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }

    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }

    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }

    this.remoteStream = null;
    this.videoSender = null;
    this.onCommandCallback = null;
    this.onResponseCallback = null;
    this.onRemoteStreamCallback = null;
    this.onConnectionStateCallback = null;
    this.onIceCandidateCallback = null;
    this.onDataChannelOpenCallback = null;
    this.onDataChannelCloseCallback = null;
    this.onFrameDataCallback = null;

    // Reset switching state
    this.isSwitchingStream = false;
    this.pendingSwitch = null;
  }
}

// Export singleton instance
export const webRTCService = new WebRTCService();
export default webRTCService;
