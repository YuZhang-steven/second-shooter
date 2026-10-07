# iOS Install and Two-iPhone Testing

This is the working iOS development flow for **Second Shooter** as of October 2026.

The project is Expo SDK 54 / React Native 0.81 and uses native modules such as
`react-native-vision-camera` and `react-native-webrtc`. Real camera/WebRTC testing
therefore requires **two physical iPhones** and a native development build on both
phones. Expo Go is not part of the real test workflow.

The two phones use the **same app, same bundle identifier, and same Apple signing
team**. One phone acts as the Camera and the other acts as the Remote.

---

## The short version

Once both phones have a valid development build installed, normal development is
only:

```bash
npx expo start --dev-client
```

Open SecondShooter on both phones while both phones can reach the Mac running
Metro.

- Phone A: Camera / QR-code side.
- Phone B: Remote / controller side.
- One Metro server serves both phones.
- JavaScript/TypeScript changes do **not** require reinstalling either phone.

Reinstall/rebuild the native app only when:

- the development provisioning profile has expired;
- a native dependency was added/removed/changed;
- `app.json`, native iOS configuration, or native code changed;
- the generated `ios/` project was recreated.

With a free Apple **Personal Team**, expect a development install/profile to
expire after roughly seven days. If iOS says **"SecondShooter is no longer
available"**, reinstall the development build on that phone.

---

# 1. Machine setup

Requirements:

- macOS with Xcode installed.
- Node.js and npm.
- CocoaPods.
- Two physical iPhones.
- Firebase configuration in the local `.env`.
- Developer Mode enabled on both iPhones.

Check that Xcode command-line tools point to the full Xcode install:

```bash
xcode-select -p
```

Expected:

```text
/Applications/Xcode.app/Contents/Developer
```

If necessary:

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```

Install project dependencies:

```bash
npm install
```

## Firebase environment

`.env` is intentionally gitignored and there is currently no
`.env.example` in the repository. Keep the working local `.env`, or create it
manually with:

```text
EXPO_PUBLIC_FIREBASE_API_KEY=...
EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN=...
EXPO_PUBLIC_FIREBASE_PROJECT_ID=...
EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET=...
EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
EXPO_PUBLIC_FIREBASE_APP_ID=...
```

Anonymous authentication must be enabled in the Firebase project because the
mobile app signs in anonymously before using Firestore signaling.

---

# 2. Generate the iOS project only when needed

The `ios/` directory is generated and gitignored.

If `ios/SecondShooter.xcworkspace` already exists, **do not prebuild again just
to start development**.

If `ios/` is missing:

```bash
npx expo prebuild --platform ios
```

Avoid using:

```bash
npx expo prebuild --clean
```

during normal development. `--clean` deletes the generated iOS project and also
deletes the local Xcode/Podfile fixes described below.

---

# 3. Xcode 27 compatibility fixes

The current project is Expo SDK 54, while the development machine uses Xcode 27.
Two local generated-iOS fixes are currently required.

These changes live inside the gitignored `ios/` directory. Reapply them if
`ios/` is regenerated.

## 3.1 Raise old Pod deployment targets to iOS 15.1

Xcode 27 rejects several dependency/resource targets that still declare old iOS
versions, for example:

```text
RNSVG-RNSVGFilters                  12.4
RNCAsyncStorage_resources           13.4
Mute-Mute                            9.0
```

Open:

```bash
open ios/Podfile
```

Find the existing `post_install do |installer|` block. After
`react_native_post_install(...)` inside that same block, add:

```ruby
installer.pods_project.targets.each do |target|
  target.build_configurations.each do |config|
    deployment_target = config.build_settings['IPHONEOS_DEPLOYMENT_TARGET']

    if deployment_target && deployment_target.to_f < 15.1
      config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '15.1'
    end
  end
end
```

Do **not** create a second `post_install` block.

Then:

```bash
cd ios
pod install
cd ..
```

## 3.2 Disable User Script Sandboxing

A Debug build on a physical iPhone writes Metro's IP address to
`SecondShooter.app/ip.txt`. Xcode 27 can block that React Native build script
with an error similar to:

```text
Sandbox: bash(...) deny(1) file-write-data .../SecondShooter.app/ip.txt
```

Open the workspace:

```bash
open ios/SecondShooter.xcworkspace
```

In Xcode:

```text
SecondShooter target
→ Build Settings
→ User Script Sandboxing
→ No
```

Set it to **No** for Debug; using No for both Debug and Release is also fine for
this generated local project.

If changing the setting after a failed build, use:

```text
Product → Clean Build Folder
```

or press **Shift + Command + K**, then build again.

---

# 4. Install on Phone A

Connect and unlock Phone A. Trust the Mac if iOS asks.

Because the Expo SDK 54 CLI does not correctly detect Xcode 27's new device
environment, use a current Expo CLI to perform the build:

```bash
npx expo@latest run:ios --device
```

This may temporarily download a newer `expo` package for the CLI. It does not
change the project's Expo SDK version in `package.json`.

Select Phone A from the device list.

The expected sequence is:

```text
select device
→ sign
→ build
→ install SecondShooter.app
→ launch app
```

## If install succeeds but iOS refuses to launch it

An error such as:

```text
Unable to launch com.secondshooter.app because it has an invalid code signature,
inadequate entitlements or its profile has not been explicitly trusted
```

usually means the development certificate needs to be trusted on that phone.

On the iPhone:

```text
Settings
→ General
→ VPN & Device Management
→ Developer App
→ Trust the developer
```

Also verify:

```text
Settings
→ Privacy & Security
→ Developer Mode
→ On
```

Then open SecondShooter directly from the Home Screen. A rebuild is usually not
needed if installation already completed.

---

# 5. Install on Phone B

Phone B uses the **same** SecondShooter app and the **same bundle identifier**:

```text
com.secondshooter.app
```

Do not create a second bundle ID for the Remote phone.

Connect/unlock Phone B and run:

```bash
npx expo@latest run:ios --device
```

Select Phone B.

## If the provisioning profile does not include Phone B

Example:

```text
Provisioning profile "iOS Team Provisioning Profile: com.secondshooter.app"
doesn't include the currently selected device
```

Open:

```bash
open ios/SecondShooter.xcworkspace
```

In Xcode:

```text
SecondShooter target
→ Signing & Capabilities
→ Automatically manage signing = On
→ Team = the same Personal Team used for Phone A
```

Choose Phone B as the Xcode run destination and press **Command + R**. Xcode
should register the device and refresh the development provisioning profile.

If Xcode offers **Register Device**, accept it.

If signing seems stuck on an old profile, toggle **Automatically manage signing**
Off and back On, then reselect the correct team.

After successful installation, trust the developer profile on Phone B as
described for Phone A if iOS asks.

---

# 6. Normal daily development

Once both development builds are valid and installed, do **not** rebuild both
phones every time.

From the project root:

```bash
npx expo start --dev-client
```

Keep that single Metro process running.

Both iPhones should normally be on the same local network as the Mac so they can
reach Metro. Open SecondShooter on each phone.

Conceptually:

```text
                         Mac
                  Metro on :8081
                       |
              +--------+--------+
              |                 |
          iPhone A           iPhone B
       SecondShooter       SecondShooter
          Camera              Remote
```

If a phone does not discover Metro automatically, use the development-client URL
shown by Expo, for example:

```text
exp+secondshooter://expo-development-client/?url=http://<mac-ip>:8081
```

## Do I need to rebuild after editing code?

Usually no.

No reinstall is needed for normal changes in:

```text
app/
src/
shared/
*.ts
*.tsx
```

For example, changing:

```text
src/services/WebRTCService.ts
```

only requires Metro reload/Fast Refresh. Both phones can receive the new
JavaScript from the same Metro process.

Rebuild when changing native dependencies, generated iOS/native code, or native
configuration.

---

# 7. Two-phone pairing test

## Camera phone

On Phone A:

1. Open SecondShooter.
2. Enter/use the Camera side.
3. Confirm the camera preview works.
4. Display the session QR code.

## Remote phone

On Phone B:

1. Open SecondShooter.
2. Enter the Remote/controller side.
3. Scan Phone A's QR code.
4. Wait for the connection to become connected.

The session link has the form:

```text
https://apps.binnyva.com/second-shooter/s/{sessionId}
```

Firestore is used for signaling, so both devices need internet access even when
the peer-to-peer media connection is local.

Test at least:

- remote photo capture;
- video start/stop;
- live/frame preview;
- zoom;
- reconnect after briefly backgrounding/locking a phone;
- camera permissions and Photo Library saving.

For connection architecture and preview-mode details, see `AGENTS.md`.

---

# 8. Testing without the Mac

A Debug development build normally depends on Metro for the JavaScript bundle.
For a field test where the Mac will not be present, install a Release build on
each phone:

```bash
npx expo@latest run:ios --configuration Release --device
```

Run it once for Phone A and once for Phone B.

A Release build embeds the JavaScript bundle, so Metro does not need to be
running during the field test.

This does **not** remove Firebase/WebRTC network requirements. It only removes
the Mac/Metro dependency.

A Personal Team signed Release build is still subject to the Personal Team's
short-lived provisioning profile.

---

# 9. Troubleshooting

| Symptom | What to do |
|---|---|
| `Can't determine id of Simulator app` even with a physical phone | Xcode path may be correct; with Xcode 27 + Expo SDK 54 use `npx expo@latest run:ios --device` instead of the project's older CLI. |
| Pod deployment target is 9.0 / 12.4 / 13.4 but Xcode requires 15+ | Apply the Podfile deployment-target loop in section 3.1, then run `pod install`. |
| `Sandbox: bash ... deny ... SecondShooter.app/ip.txt` | Set **User Script Sandboxing = No** on the SecondShooter target, clean build folder, rebuild. |
| Provisioning profile does not include the second phone | Open the workspace, use the same signing team, enable automatic signing, select Phone B and build once from Xcode. |
| App installs but launch is denied for security/trust | Trust the developer profile under **General → VPN & Device Management** and enable Developer Mode. |
| iOS says `SecondShooter is no longer available` | Personal Team development profile likely expired. Reinstall the development build on that phone. |
| Camera is black | Check Camera permission under iOS Settings → SecondShooter. |
| Firebase initialization error | Verify the local `.env` and restart/reload Metro. |
| Pairing remains `connecting` | Verify Firebase Anonymous auth, Firestore configuration, internet on both phones, and then inspect TURN/STUN if devices are on different networks. |
| Same-WiFi test works but different-network test fails | Verify Cloudflare TURN / `getIceServers` deployment described in `AGENTS.md`. |
| `npm warn Unknown user config "always-auth"` | This warning is unrelated to the iOS build failure and can be cleaned up separately in npm configuration. |

If build state becomes confusing, a safe first cleanup is:

```bash
rm -rf ~/Library/Developer/Xcode/DerivedData/SecondShooter-*
```

Then reopen the workspace and rebuild.

Do not immediately use `expo prebuild --clean`, because it also removes the
local generated-iOS fixes.

---

# 10. Quick reference

```bash
# Normal day: no reinstall
npx expo start --dev-client

# Reinstall/build one physical iPhone
npx expo@latest run:ios --device

# Install a standalone field-test build
npx expo@latest run:ios --configuration Release --device

# Only if ios/ is missing
npx expo prebuild --platform ios

# Unit tests
npm test
```

## Mental model

```text
Expired / missing native app?
    YES → build/install that phone
    NO
     |
     v
Native dependency/config changed?
    YES → rebuild affected phones
    NO
     |
     v
Only JS/TS changed?
    YES → start/keep Metro running; no reinstall
```
