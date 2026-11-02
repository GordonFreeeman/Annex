# Annex

Control your Android phone from a browser tab. Like [scrcpy](https://github.com/Genymobile/scrcpy), but the whole app is **one offline HTML file**: no install, no server, no cloud. It talks to the phone directly over USB (WebUSB) or, optionally, your local Wi‑Fi.

- Mirroring up to 60 fps, constant-rate H.264/H.265/AV1, audio forwarding
- Mouse, keyboard, touch, and an "OG Gaming" mode that sends real PC mouse and keyboard input
- Pointer/keyboard capture with a release key; `Ctrl+W` and `Alt+F4` always stay with the browser
- File transfer (drag and drop, APK install), clipboard sync, app launcher, shell, screenshots, recording
- Remappable Android soft keys (Esc = Back), `Ctrl+Alt+H` shows every hotkey
- Installable as a standalone PWA; works fully offline

## Quick start

1. On the phone: enable **Developer options → USB debugging**.
2. Open `annex.html` (from [Releases](../../releases), or build it below) in Chrome, Edge, Brave or Opera. For the best experience (and to install it as an app), run `start-annex.cmd` / `start-annex.sh` from `annex-pwa.zip`, which serves it on `http://localhost:27180`.
3. Plug in the phone, click **Connect**, accept the USB debugging prompt.

Close any running `adb` server first (`adb kill-server`); only one program can own the USB interface.

## Wi‑Fi (optional)

Connect once over USB, then enable Wi‑Fi in the Device panel. Annex starts a small bridge on the phone and pairs with a random 256‑bit key that only ever travels over the USB cable. All Wi‑Fi traffic is end-to-end AES‑256‑GCM, goes straight from your PC to your phone, and nothing leaves your network. The page's CSP forbids every other connection.

## Build

```sh
npm ci
npm run build        # -> dist/annex.html and dist/pwa/
npm run typecheck
```

Tests run against a simulated phone and need ffmpeg and Chromium:

```sh
npm run test:media
npm test             # set CHROME_PATH to use an existing Chromium
```

The Wi‑Fi bridge (`bridge/*.java`) is committed prebuilt in `bridge/prebuilt/`. To rebuild it, see [BUILD.md](BUILD.md).

## Limitations

Chromium-based browsers only (WebUSB, WebCodecs). Not yet tested against a wide range of real devices; please open an issue with your phone model and Android version if something misbehaves. Camera mirroring and some encoder options depend on Android version and vendor.

## License

MIT. Bundles the unmodified scrcpy server (Apache‑2.0) and Tango libraries (MIT); see [NOTICE](NOTICE).
