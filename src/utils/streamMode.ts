import { StreamMode, CameraFacing, PreviewMode } from '../types';

/**
 * Chooses the transport for the remote preview.
 *
 * Continuous JPEG frame streaming over the command data channel is disabled.
 * The remote preview is only for framing, so the app stays on the lower
 * bandwidth WebRTC video path and keeps command traffic independent of frame
 * snapshots.
 *
 * At zoom levels where WebRTC cannot match the capture framing exactly, the
 * camera reports previewZoomLimited separately. The captured photo/video still
 * uses the requested zoom.
 *
 * previewMode remains in the signature for compatibility with stored settings.
 */
export function determineStreamMode(
  _facing: CameraFacing,
  _zoom: number,
  _previewMode: PreviewMode
): StreamMode {
  return 'webrtc';
}
