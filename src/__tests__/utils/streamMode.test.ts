import { determineStreamMode } from '../../utils/streamMode';
import { DEFAULT_SETTINGS } from '../../types';

describe('determineStreamMode', () => {
  it.each([
    ['front', 1, 'auto'],
    ['front', 3, 'auto'],
    ['back', 1, 'auto'],
    ['back', 0.5, 'auto'],
    ['back', 2, 'auto'],
    // Legacy stored values are harmless even before SettingsService migrates
    // them, because continuous frame streaming is no longer selected.
    ['back', 2, 'frames'],
  ] as const)('keeps %s camera at %sx on WebRTC for %s mode', (facing, zoom, mode) => {
    expect(determineStreamMode(facing, zoom, mode)).toBe('webrtc');
  });

  it('defaults to the low-bandwidth WebRTC mode', () => {
    expect(DEFAULT_SETTINGS.previewMode).toBe('auto');
    expect(determineStreamMode('back', 1, DEFAULT_SETTINGS.previewMode)).toBe('webrtc');
  });
});
