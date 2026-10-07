export type DeviceRole = 'camera' | 'remote';

export type CameraFacing = 'front' | 'back';

export type FlashMode = 'off' | 'on' | 'auto';

export type CaptureMode = 'photo' | 'video';

export type RecordingState = 'idle' | 'recording';

export type StreamMode = 'webrtc' | 'frame-based';

export interface CameraState {
  zoom: number;
  flash: FlashMode;
  facing: CameraFacing;
  captureMode: CaptureMode;
  isRecording: boolean;
  streamMode?: StreamMode;
}

export interface LensInfo {
  id: string;
  label: string;
  zoom: number;
  isActive: boolean;
}

export type Command =
  | { type: 'TAKE_PHOTO' }
  | { type: 'START_RECORDING' }
  | { type: 'STOP_RECORDING' }
  | { type: 'SET_ZOOM'; level: number }
  | { type: 'SET_FLASH'; mode: FlashMode }
  | { type: 'SET_CAPTURE_MODE'; mode: CaptureMode }
  | { type: 'SWITCH_CAMERA' }
  | { type: 'GET_STATE' };

export interface FrameDataMessage {
  type: 'FRAME_DATA';
  frameId: number;
  data: string;
  timestamp: number;
}

export interface PhotoDataMessage {
  type: 'PHOTO_DATA';
  data: string;
  timestamp: number;
}

export type Response =
  | { type: 'PHOTO_TAKEN'; success: boolean; error?: string }
  | { type: 'RECORDING_STARTED' }
  | { type: 'RECORDING_STOPPED'; success: boolean; error?: string }
  | {
      type: 'STATE_UPDATE';
      state: CameraState;
      lenses?: LensInfo[];
      videoNeedsRotation?: boolean;
      previewZoomLimited?: boolean;
      streamMode?: StreamMode;
    }
  | { type: 'ERROR'; message: string }
  // The camera device is mid-capture, so the live preview is dead: WebRTC and
  // vision-camera can't hold the camera at once. Sent true when the camera is
  // taken and false once the stream is back, so the remote can show the
  // captured shot instead of a frozen frame.
  | { type: 'CAPTURE_STATE'; capturing: boolean }
  | FrameDataMessage
  | PhotoDataMessage;

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'failed';
