# Second Shooter

A mobile camera remote control system that allows one device to remotely operate another device's camera over a peer-to-peer connection.

You can use this to take a video/photo of yourself by using a secondary phone to frame yourself and trigger the photo. You can set the main phone on a tripod and use the remote phone to see how you look on the main camera. Use that to frame yourself and then remotely trigger the shutter. Or start and end the video recording from the secondary phone. The photos and videos will be stored on the main phone.

This can be done by activating the remote mode on the main phone that will show a QR code. This QR code will be scanned by the secondary phone which will open the same app in the secondary phone. It should be installed already, and then you will get remote functions from the secondary phone. 

If the second device does not have the app installed, the QR code can now open the browser-based remote at `https://apps.binnyva.com/second-shooter/s/{sessionId}` instead.

## Features

- **Remote Camera Control**: Take photos and record videos from another device
- **QR Code Pairing**: Simple, fast device pairing via QR code scanning
- **Browser Remote Fallback**: If the second device doesn't have the app, the QR code opens a web remote at `https://apps.binnyva.com/second-shooter/s/{sessionId}` (deep links open the app when installed)
- **Peer-to-Peer Connection**: Direct device-to-device communication over the internet with no intermediary server (Firebase Firestore is used only for signaling)
- **Cross-Platform**: Single codebase for both iOS and Android
- **Live Preview**: Real-time camera viewfinder streaming to the remote device, with a hybrid WebRTC/frame-based mode so zoomed previews display correctly
- **Camera Controls**: Zoom (with per-lens detection), flash, front/back switch, photo/video modes
- **Photo Preview on Remote**: Captured photos are sent back to the remote device for review
- **Volume Button Shutter**: Use the volume buttons as a physical shutter trigger
- **Settings**: Timer (2/5/10s), grid overlays (3x3, 4x4), aspect ratio (1:1, 4:5, 9:16), save location, preview quality

## Tech Stack

### Framework
- **Expo (React Native)** - Cross-platform mobile development with a custom dev client (prebuild for native modules)
- **Expo Router** - File-based navigation (`app/` directory)

### Key Libraries
- **react-native-vision-camera** - Advanced camera functionality and control
- **react-native-webrtc** - Peer-to-peer connection and video streaming
- **expo-camera** - QR code scanning for pairing
- **react-native-qrcode-svg** - QR code generation
- **Firebase Firestore** - Signaling for WebRTC connection establishment
- **react-native-volume-manager** - Volume button shutter trigger
- **expo-media-library** - Saving photos/videos to the device

### Architecture
- **WebRTC** - Handles P2P connection, data channels, and media streaming
- **STUN/TURN servers** - NAT traversal (only for connection establishment, not for media relay)
- **Hybrid preview streaming** - WebRTC video stream for front camera and back camera at 1x zoom; frame-based JPEG streaming over the data channel at other zoom levels (WebRTC can't capture vision-camera's zoomed preview)
- **Web remote** - A Vite + React browser client in `web-remote/` that shares the signaling/protocol code in `shared/`

## How It Works

### Pairing Process

1. **Camera Device**: User clicks on Remote option to generates a unique session ID and displays it as a QR code
2. **Remote Device**: Scans the QR code to obtain session credentials
3. **Connection Establishment**: 
   - Devices exchange WebRTC signaling data
   - P2P connection established using ICE candidates
   - Direct peer-to-peer data channel created
4. **Ready**: Remote device can now control the camera

### Connection Flow

```
┌─────────────┐                           ┌─────────────┐
│   Camera    │                           │   Remote    │
│   Device    │                           │   Device    │
└──────┬──────┘                           └──────┬──────┘
       │                                         │
       │  1. Generate QR Code                    │
       │     (Session ID + ICE config)           │
       │◄────────────────────────────────────────┤
       │  2. Scan QR Code                        │
       │                                         │
       │  3. WebRTC Offer/Answer Exchange        │
       │◄───────────────────────────────────────►│
       │     (via signaling channel)             │
       │                                         │
       │  4. P2P Connection Established          │
       │◄═══════════════════════════════════════►│
       │        (Direct connection)              │
       │                                         │
       │  5. Camera Control Commands             │
       │◄────────────────────────────────────────┤
       │                                         │
       │  6. Live Preview Stream                 │
       ├────────────────────────────────────────►│
       │                                         │
```

## Project Structure

```
second-shooter/
├── app/                            # Expo Router screens
│   ├── _layout.tsx                 # Root layout
│   ├── index.tsx                   # Home = Camera mode (default)
│   ├── remote.tsx                  # Remote control screen
│   ├── settings.tsx                # Settings screen
│   └── s/[sessionId].tsx           # Deep link handler for session URLs
├── src/
│   ├── components/
│   │   ├── CameraView.tsx          # Camera interface
│   │   ├── CameraControls.tsx      # Shutter, zoom, flash, mode controls
│   │   ├── HybridPreview.tsx       # WebRTC / frame-based preview switcher
│   │   ├── RemotePreview.tsx       # Remote live preview
│   │   ├── PhotoViewer.tsx         # Captured photo review
│   │   ├── QRCodeDisplay.tsx       # QR code display for pairing
│   │   ├── QRCodeScanner.tsx       # QR code scanning component
│   │   ├── GridOverlay.tsx         # Composition grid overlays
│   │   ├── TimerCountdown.tsx      # Shutter timer countdown
│   │   └── AspectRatioContainer.tsx
│   ├── services/
│   │   ├── WebRTCService.ts        # WebRTC connection management
│   │   ├── CameraService.ts        # Camera operations wrapper
│   │   ├── SignalingService.ts     # Firebase Firestore signaling handler
│   │   ├── MediaService.ts         # Photo/video save operations
│   │   └── SettingsService.ts      # Persistent app settings (AsyncStorage)
│   ├── hooks/
│   │   ├── useCamera.ts            # Camera functionality hook
│   │   ├── usePeerConnection.ts    # WebRTC peer connection hook
│   │   ├── useSignaling.ts         # Firebase signaling hook
│   │   ├── useSettings.ts          # App settings hook
│   │   └── useVolumeShutter.ts     # Volume button shutter trigger
│   ├── config/
│   │   ├── firebase.ts             # Firebase initialization (env vars)
│   │   └── webrtc.ts               # ICE server / data channel config
│   ├── types/                      # TypeScript type definitions
│   ├── utils/
│   │   ├── permissions.ts          # Camera/mic permission helpers
│   │   ├── sessionId.ts            # Session ID generation
│   │   ├── lensDetection.ts        # Physical lens detection (0.5x/1x/2x)
│   │   └── streamMode.ts           # WebRTC vs frame-based mode selection
│   └── __tests__/                  # Jest unit tests
├── shared/                         # Code shared with the web remote
│   ├── protocol.ts                 # Data channel command/response types
│   ├── signaling.ts                # Signaling message types
│   └── session-link.ts             # Session URL build/parse helpers
├── web-remote/                     # Browser-based remote (Vite + React)
├── android/                        # Android native code
├── ios/                            # iOS native code
├── app.json                        # Expo configuration (permissions, deep links)
├── package.json
└── README.md
```

## Installation

### Prerequisites

- Node.js (v18 or higher)
- Android: Android Studio and JDK
- iOS: Xcode and CocoaPods
- Physical devices for testing (camera and WebRTC don't work in emulators/simulators)

### Initial Setup (one-time)

```bash
# Clone the repository
git clone https://github.com/yourusername/second-shooter.git
cd second-shooter

# Install dependencies
npm install

# Build and install the development client on your Android device
npx expo run:android
```

This builds the native app with all required modules and installs it on your device.

> **Testing on two iPhones?** See [`docs/IOS_TESTING.md`](docs/IOS_TESTING.md) — it covers prebuild, Apple signing, dev-client install on two devices, the same-WiFi vs different-network paths, and TURN setup.

### Ongoing Development

```bash
# Start the development server
npx expo start --dev-client
```

Your device connects to this server and hot-reloads JavaScript changes instantly - no new APK needed. Make sure your device and development machine are on the same network.

**When to rebuild**: Only run `npx expo run:android` again if you add/remove native dependencies, change `app.json` config, or modify the `android/` directory.

### Web Remote

The browser fallback remote lives in [`web-remote/`](web-remote/).

```bash
# Start the browser remote locally
npm run web-remote:dev
```

It expects the same Firebase public env vars as the Expo app, and gets TURN credentials
from the same `getIceServers` Cloud Function.

### Release Build

```bash
npx expo run:android --variant release
```

### Running Tests

```bash
npm test
```

Unit tests (Jest) cover the services and utilities in `src/__tests__/`. Use `npm run test:watch` or `npm run test:coverage` for watch mode and coverage reports.

## Configuration

### Firebase (Signaling)

Signaling uses Firebase Firestore. Copy `.env.example` to `.env` and fill in your Firebase project credentials:

```bash
cp .env.example .env
```

```
EXPO_PUBLIC_FIREBASE_API_KEY=...
EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN=...
EXPO_PUBLIC_FIREBASE_PROJECT_ID=...
EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET=...
EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
EXPO_PUBLIC_FIREBASE_APP_ID=...
```

### WebRTC Configuration

The STUN server list lives in `shared/ice.ts`, shared by the app and the web remote.

TURN (needed when both devices are on mobile data, or behind symmetric NAT) uses
Cloudflare Realtime, which only issues short-lived credentials through its API. Both
clients call the `getIceServers` Cloud Function in `functions/` to mint them; there is
nothing to configure in `.env`. If that call fails, pairing falls back to STUN only.

Deploying the function requires two config values, both from the Cloudflare
dashboard (Realtime → TURN Keys):

```bash
cp functions/.env.example functions/.env   # then fill in CLOUDFLARE_TURN_TOKEN_ID
firebase functions:secrets:set CLOUDFLARE_TURN_API_TOKEN
firebase deploy --only functions
```

The API token is a Secret Manager secret and never touches the repo.
`CLOUDFLARE_TURN_TOKEN_ID` only names the key and can't mint credentials on its
own, but `functions/.env` is untracked too — this repo is public, and there's no
reason to publish an identifier that points at your Cloudflare account.

### Camera Permissions

The app requires camera, microphone, and photo library permissions. These are configured in `app.json` (Expo config) — `ios.infoPlist` for iOS and `android.permissions` for Android — and applied to the native projects on prebuild.

## Usage

### As Camera Device

1. Launch the app. It will open in camera mode by default
2. Grant camera and microphone permissions
3. A QR code will be displayed
4. Wait for remote device to scan and connect
5. Your camera is now ready to be controlled remotely

### As Remote Device

1. Launch the app and select "Remote Mode".
2. Grant camera permissions (for QR scanning)
3. Scan the QR code from the camera device
4. Wait for P2P connection to establish
5. Use the on-screen controls to operate the remote camera

### Camera Controls

- **Capture Photo**: Single tap the shutter button, or press a volume button (if enabled in Settings)
- **Record Video**: Change to video mode, then shutter button
- **Zoom**: Pinch gesture, zoom slider, or lens buttons (0.5x / 1x / 2x based on detected lenses)
- **Flash**: Toggle flash modes
- **Switch Camera**: Front/back camera toggle
- **Timer / Grid / Aspect Ratio**: Configured in the Settings screen

## Technical Challenges & Solutions

### NAT Traversal

**Challenge**: Devices behind different NATs cannot directly connect.

**Solution**: Use STUN servers for NAT hole punching. For difficult network scenarios, TURN servers can relay traffic (though this reduces the "serverless" benefit).

### Signaling

**Challenge**: WebRTC requires signaling to exchange connection information.

**Solution**: The QR code carries only a short session ID; the WebRTC offer/answer and ICE candidates are exchanged through temporary Firebase Firestore documents. Once the P2P connection is established, Firestore is no longer involved.

### Zoomed Preview Streaming

**Challenge**: WebRTC's `getUserMedia` stream doesn't respect vision-camera's zoom on Android, so the remote preview wouldn't match what will be captured.

**Solution**: A hybrid preview — WebRTC video for the front camera and back camera at 1x, switching to frame-based JPEG streaming over the data channel at other zoom levels (see `src/utils/streamMode.ts` and `HybridPreview.tsx`).

### Low Latency Streaming

**Challenge**: Minimizing delay between camera and remote preview.

**Solutions**:
- Use WebRTC's low-latency media streaming
- Configure camera for lower resolution during preview
- Optimize video encoding settings
- Use data channels for control commands (faster than media stream)

## Roadmap

- [x] Basic camera control (photo/video)
- [x] QR code pairing implementation
- [x] WebRTC P2P connection
- [x] Live camera preview streaming
- [x] Settings and preferences
- [x] Timer
- [x] Grid overlays and composition guides
- [x] Volume button shutter
- [x] Browser-based remote fallback with deep links
- [ ] Advanced camera controls (ISO, shutter speed, white balance)
- [ ] Multiple camera device support
- [ ] Photo/video gallery and review
- [ ] Gesture controls (swipe to adjust settings)
- [ ] Burst mode

## Known Limitations

- **Network Requirements**: Both devices need internet access for initial connection establishment
- **Battery Usage**: Streaming video consumes significant battery on both devices
- **Firewall Restrictions**: Some corporate/restrictive networks may block P2P connections
- **Platform Differences**: Some advanced camera features may only be available on one platform
- **Preview Loss During Recording**: Remote preview stops during video recording due to camera resource conflict between WebRTC and vision-camera

## TODO / Future Improvements

- **Unified Camera Architecture**: Currently WebRTC's `getUserMedia` and react-native-vision-camera compete for camera access, causing preview loss during capture. A future improvement would be to use vision-camera's frame processor to feed frames directly to WebRTC, eliminating the resource conflict and enabling seamless preview during photo/video capture. Note that frame processors are currently disabled (`enableFrameProcessors: false` in `app.json`); pursuing this would mean re-enabling them and re-adding `react-native-worklets-core`.

## License

MIT License - feel free to use this project for your own purposes.

## Acknowledgments

- react-native-vision-camera for excellent camera APIs
- WebRTC for enabling peer-to-peer connections
- The React Native community

## Support

For issues, questions, or suggestions, please open an issue on GitHub.
