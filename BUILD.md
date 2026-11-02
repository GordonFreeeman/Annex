# Annex: build notes

`dist/annex.html` is the whole app: one offline file. Open it in Chrome, Edge, Brave or Opera.

## Layout
- `src/`: TypeScript app (Tango ADB over WebUSB, scrcpy 3.3 client, UI). `node build.mjs` bundles it into `dist/annex.html`.
- `bridge/AnnexBridge.java`: Wi‑Fi bridge that runs on the phone. `build.sh` runs javac (Java 8 target), then d8, then baksmali/smali (canonical dex), and packages `annex-bridge.jar`.
  The result is committed in `bridge/prebuilt/`, so you only need this when editing the Java. Set `D8_JAR` (a JVM-runnable d8/R8 jar, e.g. the Android SDK's `build-tools/*/lib/d8.jar`) and `APKTOOL_JAR` (apktool 2.4.x), then run `sh bridge/build.sh`.
- `assets/scrcpy-server-v3.3.jar`: the unmodified scrcpy 3.3 server (Apache-2.0, Genymobile).
- `test/`: end-to-end tests. They use a fake Android device (ADB daemon + sync + shell + fake scrcpy 3.3 server), a WebUSB mock, and the real bridge running on a JVM.
  Generate the test media with `npm run test:media` (needs ffmpeg), then run `npm test`.

## Wi‑Fi protocol
WebSocket → AES‑256‑GCM. Per-connection keys come from HKDF-SHA256 over a 32-byte key that is only ever pushed over USB (`/data/local/tmp/annex-bridge.key`, mode 0600). Traffic is relayed to adbd on 127.0.0.1:5555. The wire format is documented at the top of AnnexBridge.java.
