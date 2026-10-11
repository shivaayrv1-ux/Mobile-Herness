# MH Cloud - Phase 1

Mobile Harness, but everything runs on **your VPS** (AWS EC2 / Lightsail / any Ubuntu or Debian server) instead of the phone.
Based on [Mobile Harness](https://github.com/techjarves/Mobile-Harness) (MIT License) by techjarves.

## Phase 1 includes
- Connect screen: VPS IP + username, then **Password** or **PEM file** login
- Trust-on-first-use server fingerprint check, credentials saved encrypted (Android Keystore AES-256-GCM)
- One-time VPS setup: git, curl, tmux, unzip, extra swap for 1 GB RAM servers, `~/mobile-harness/projects`
- Home: RAM / swap / disk, Node.js, OmniRoute status (+ start button, runs in tmux)
- Real terminal (xterm.js) with Esc / Tab / Ctrl / arrow keys row
- Auto-reconnect when you come back to the app

Coming next: Phase 2 (projects, Claude Code via OmniRoute, files, checkpoints) and Phase 3 (web preview tunnel, Android build on VPS, APK install).

## Build the APK (GitHub Actions)
1. Extract this zip in the root of your GitHub repo (the `.github` folder must be there).
2. `git add . && git commit -m "MH Cloud phase 1" && git push`
3. GitHub > Actions > **Build APK** > open the latest run > Artifacts > `mh-cloud-debug-apk`.
4. Unzip the artifact and install `app-debug.apk`.

The workflow creates the Android project itself (`npx cap add android`), adds the native SSH plugin from `native/android`, and builds a debug APK. Nothing to configure.

## Notes
- Android 8.0+ (minSdk 26).
- RSA / ECDSA `.pem` keys work (AWS and Lightsail default keys are RSA). ed25519 keys may not work on all phones yet.
- Password login must be enabled on the server (`PasswordAuthentication yes` in sshd_config), or use the .pem key.
