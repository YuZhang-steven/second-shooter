// Mock for react-native-webrtc
export class RTCPeerConnection {
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  signalingState: string = 'stable';
  connectionState: string = 'new';
  iceConnectionState: string = 'new';

  onicecandidate: ((event: { candidate: RTCIceCandidate | null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((event: { channel: RTCDataChannel }) => void) | null = null;
  ontrack: ((event: { streams: MediaStream[] }) => void) | null = null;

  constructor(config?: RTCConfiguration) {}

  createOffer = jest.fn().mockResolvedValue({ type: 'offer', sdp: 'mock-offer-sdp' });
  createAnswer = jest.fn().mockResolvedValue({ type: 'answer', sdp: 'mock-answer-sdp' });
  setLocalDescription = jest.fn().mockResolvedValue(undefined);
  // Mirrors the real behaviour: the description becomes readable afterwards,
  // which is what gates ICE candidate application.
  setRemoteDescription = jest.fn(async (description: RTCSessionDescription) => {
    this.remoteDescription = description;
  });
  addIceCandidate = jest.fn().mockResolvedValue(undefined);
  createDataChannel = jest.fn().mockReturnValue({
    onopen: null,
    onclose: null,
    onmessage: null,
    send: jest.fn(),
    close: jest.fn(),
  });

  private senders: any[] = [];
  addTrack = jest.fn((track: any) => {
    const sender: any = {
      track,
      replaceTrack: jest.fn(async (nextTrack: any) => {
        sender.track = nextTrack;
      }),
    };
    this.senders.push(sender);
    return sender;
  });
  getSenders = jest.fn(() => this.senders);
  close = jest.fn();
}

export class RTCSessionDescription {
  type: string;
  sdp: string;

  constructor(init: { type: string; sdp: string }) {
    this.type = init.type;
    this.sdp = init.sdp;
  }
}

export class RTCIceCandidate {
  candidate: string;
  sdpMLineIndex: number | null;
  sdpMid: string | null;

  constructor(init: { candidate: string; sdpMLineIndex?: number; sdpMid?: string }) {
    this.candidate = init.candidate;
    this.sdpMLineIndex = init.sdpMLineIndex ?? null;
    this.sdpMid = init.sdpMid ?? null;
  }
}

export class MediaStream {
  id: string = 'mock-stream-id';

  getTracks = jest.fn().mockReturnValue([]);
  getVideoTracks = jest.fn().mockReturnValue([]);
  getAudioTracks = jest.fn().mockReturnValue([]);
  addTrack = jest.fn();
  removeTrack = jest.fn();
}

export const mediaDevices = {
  getUserMedia: jest.fn().mockResolvedValue(new MediaStream()),
  enumerateDevices: jest.fn().mockResolvedValue([]),
};

export interface RTCConfiguration {
  iceServers?: Array<{ urls: string | string[]; username?: string; credential?: string }>;
}

export interface RTCDataChannel {
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  send: (data: string) => void;
  close: () => void;
}
