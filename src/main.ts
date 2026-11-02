import { AndroidKeyCode, AndroidKeyEventAction, AndroidKeyEventMeta } from "@yume-chan/scrcpy";
import { AdbScrcpyExitedError } from "@yume-chan/adb-scrcpy";
import type { AdbDaemonWebUsbDevice } from "@yume-chan/adb-daemon-webusb";
import { AndroidDevice, UserCancelled, usbManager } from "./device";
import { AppsPanel } from "./apps";
import { FilesPanel, Transfers, sendFiles } from "./files";
import { HOTKEYS, InputController, type Hotkey } from "./input";
import { ScreenRecorder } from "./recorder";
import { MirrorSession, probeCodec } from "./session";
import { DEFAULTS, SOFT_KEY_ACTIONS, getPref, loadSettings, loadWifiDevices, removeWifiDevice, saveSettings, setPref, type Settings, type WifiDevice } from "./settings";
import { ShellPanel } from "./shell";
import { isServed, isStandalone, setupPwa } from "./pwa";
import { $, $$, confirmDialog, downloadBlob, errorMessage, formatBytes, h, icon, timestamp, toast } from "./ui";

// ======================================================================= state
let settings: Settings = loadSettings();
let dev: AndroidDevice | undefined;
let session: MirrorSession | undefined;
let busy = false;
let switchingToWifi = false;
let lastDeviceClip = "";
let lastPushedClip = "";
let pendingClipWrite: string | null = null;
let userDisconnected = false;
let abortConnect: (() => void) | null = null;
const logLines: string[] = [];
const recorder = new ScreenRecorder();

const app = $("#app");
const stage = $("#stage");
const screen = $("#screen");
const welcome = $("#welcome");
const transfers = new Transfers($("#transfers"));

const getDev = () => (dev && !dev.closed ? dev : undefined);

// ======================================================================= helpers
function setState(s: "idle" | "connecting" | "connected") {
    app.dataset.state = s;
    welcome.hidden = s === "connected";
    stage.hidden = s !== "connected";
    $$("[data-needs-device]").forEach((b) => ((b as HTMLButtonElement).disabled = s !== "connected"));
}

function log(line: string) {
    logLines.push(line);
    if (logLines.length > 600) logLines.splice(0, logLines.length - 600);
    const pre = $("#serverLog");
    if (pre) {
        pre.textContent = logLines.join("\n");
        pre.scrollTop = pre.scrollHeight;
    }
    if (/ERROR|Exception/.test(line)) console.warn("[scrcpy]", line);
}

function connectingUi(text: string, sub = "") {
    $("#connText").textContent = text;
    $("#connSub").textContent = sub;
    setState("connecting");
}

function updateDeviceUi() {
    const d = getDev();
    const pill = $("#devPill");
    pill.hidden = !d;
    if (!d) return;
    $("#devName").textContent = d.displayName;
    const badge = $("#linkBadge");
    badge.textContent = d.kind === "usb" ? "USB" : "Wi‑Fi";
    badge.className = "link-badge " + d.kind;
    const bat = $("#devBattery");
    bat.textContent = d.info.battery !== undefined ? `${d.info.battery}%${d.info.charging ? " ⚡" : ""}` : "";
    const info = d.info;
    $("#infoModel").textContent = `${info.manufacturer} ${info.model}`.trim();
    $("#infoAndroid").textContent = info.android ? `Android ${info.android} · SDK ${info.sdk}` : "–";
    $("#infoScreen").textContent = info.screen ?? "–";
    $("#infoBattery").textContent = info.battery !== undefined ? `${info.battery}%${info.charging ? " (charging)" : ""}` : "–";
    $("#infoLink").textContent = d.kind === "usb" ? `USB · ${d.serial}` : `Wi‑Fi · ${d.wifi?.host}:${d.wifi?.port} · end-to-end encrypted`;
    $("#infoIp").textContent = info.ip ?? "not on Wi‑Fi";
    $("#btnWifiOn").hidden = d.kind !== "usb";
    $("#btnWifiOff").hidden = !(d.kind === "wifi" || loadWifiDevices().some((x) => x.serial === d.serial));
    $("#wifiState").textContent =
        d.kind === "wifi"
            ? "Connected over Wi‑Fi. The cable is not needed. Wi‑Fi mode lasts until the phone reboots."
            : loadWifiDevices().some((x) => x.serial === d.serial)
              ? "Paired for Wi‑Fi. You can enable it again to refresh the bridge (e.g. after a reboot)."
              : "Enable once over USB, then unplug and keep working over the local network.";
}

// ======================================================================= layout
let videoW = 0;
let videoH = 0;
function layout() {
    const canvas = screen.querySelector("canvas");
    if (!canvas || !videoW) return;
    const r = screen.getBoundingClientRect();
    const pad = document.fullscreenElement ? 0 : 16;
    const W = Math.max(50, r.width - pad * 2);
    const H = Math.max(50, r.height - pad * 2);
    const dpr = window.devicePixelRatio || 1;
    const fit = Math.min(W / videoW, H / videoH);
    let scale = fit;
    if (settings.scaleMode === "native") scale = 1 / dpr;
    else if (settings.scaleMode === "integer") {
        const k = Math.floor(fit * dpr);
        scale = k >= 1 ? k / dpr : fit;
    }
    const cw = Math.round(videoW * scale);
    const ch = Math.round(videoH * scale);
    canvas.style.width = cw + "px";
    canvas.style.height = ch + "px";
    canvas.style.imageRendering = settings.smoothing ? "auto" : "pixelated";
    screen.classList.toggle("overflow", cw > W + 1 || ch > H + 1);
    screen.classList.toggle("landscape", videoW > videoH);
}
new ResizeObserver(() => layout()).observe(screen);

// ======================================================================= input
const input = new InputController({
    stage,
    cursor: $("#vcursor"),
    controller: () => (session?.running ? session.controller : undefined),
    videoSize: () => ({ width: session?.width || videoW, height: session?.height || videoH }),
    canvasRect: () => (screen.querySelector("canvas") ?? screen).getBoundingClientRect(),
    settings: () => settings,
    onCaptureChange(c) {
        app.classList.toggle("captured", c);
        $("#btnCapture").classList.toggle("on", c);
        const hint = $("#captureHint");
        hint.hidden = !c;
        if (c) {
            hint.classList.remove("fade");
            setTimeout(() => hint.classList.add("fade"), 2200);
        }
    },
    onHotkey: (a) => void onHotkey(a),
    onPaste: (typeIt) => onPasteKey(typeIt),
    onError: (m) => toast(m, "warn", 6000),
});
input.attach();
$("#hostKeyName").textContent = hostKeyLabel();

function hostKeyLabel() {
    return ({ ControlRight: "Right Ctrl", AltRight: "Right Alt", MetaRight: "Right ⊞/⌘", ScrollLock: "Scroll Lock", Pause: "Pause" } as Record<string, string>)[settings.hostKey] ?? settings.hostKey;
}

let notifOpenHk = false;
async function onHotkey(a: Hotkey) {
    const c = session?.controller;
    switch (a) {
        case "help": return showHotkeyHelp();
        case "gaming": return toggleGaming();
        case "capture": return input.setCapture(!input.captured);
        case "fullscreen": return toggleFullscreen();
        case "screenshot": return screenshot();
        case "record": return toggleRecord();
        case "rotate": return rotate();
        case "screen": return setScreen(!!session?.screenOff);
        case "notifications":
            notifOpenHk = !notifOpenHk;
            return notifOpenHk ? c?.expandNotificationPanel() : c?.collapseNotificationPanel();
        case "back": return input.pressKey(AndroidKeyCode.AndroidBack);
        case "home": return input.pressKey(AndroidKeyCode.AndroidHome);
        case "recents": return input.pressKey(AndroidKeyCode.AndroidAppSwitch);
        case "volup": return input.pressKey(AndroidKeyCode.VolumeUp);
        case "voldown": return input.pressKey(AndroidKeyCode.VolumeDown);
        case "apps": return openPanel("apps");
        case "files": return openPanel("files");
        case "shell": return openPanel("shell");
        case "settings": return openPanel("settings");
        case "stats": return toggleStats();
        case "keyboard": {
            settings.keyboardMode = settings.keyboardMode === "sdk" ? "uhid" : "sdk";
            saveSettings(settings);
            syncSettingsForm();
            input.releaseAll();
            return toast(settings.keyboardMode === "sdk" ? "Keyboard: smart (follows PC layout)" : "Keyboard: physical HID", "info", 2200);
        }
    }
}

function toggleGaming(force?: boolean) {
    input.releaseAll();
    settings.inputMode = (force ?? settings.inputMode !== "pc") ? "pc" : "touch";
    saveSettings(settings);
    syncSettingsForm();
    syncGamingUi();
    toast(
        settings.inputMode === "pc" ? "OG Gaming mode on" : "Touch mode",
        "info",
        2600,
        settings.inputMode === "pc" ? "Mouse buttons and keyboard go to the phone as real PC input. Ctrl+Alt+G to switch back." : "Left = finger tap · middle = Home · right = Back",
    );
}

function syncGamingUi() {
    const on = settings.inputMode === "pc";
    $("#btnGaming").classList.toggle("on", on);
    app.classList.toggle("gaming", on);
}

function showHotkeyHelp() {
    if (input.captured) void input.setCapture(false);
    document.querySelector("dialog.hotkeys")?.remove();
    const rows = HOTKEYS.map((k) => h("div", { class: "hk" }, h("span", { class: "hk-keys" }, h("kbd", { text: "Ctrl" }), h("kbd", { text: "Alt" }), h("kbd", { class: "hk-main", text: k.key })), h("span", { class: "hk-desc", text: k.desc })));
    const dlg = h(
        "dialog",
        { class: "dialog hotkeys" },
        h("h3", { text: "Hotkeys" }),
        h("p", { class: "muted small", text: `Mode: ${settings.inputMode === "pc" ? "OG Gaming (real PC input)" : "Touch (left = tap, middle = Home, right = Back)"} · tap ${hostKeyLabel()} to release a capture · hold Esc to leave fullscreen` }),
        h("div", { class: "hk-grid" }, ...rows),
        h("div", { class: "dialog-actions" }, h("button", { class: "btn primary", text: "Close", onclick: () => close() })),
    );
    const close = () => {
        dlg.close();
        dlg.remove();
        stage.focus({ preventScroll: true });
    };
    dlg.addEventListener("cancel", (e) => {
        e.preventDefault();
        close();
    });
    dlg.addEventListener("keydown", (e) => {
        if (e.ctrlKey && e.altKey && e.code === "KeyH") {
            e.preventDefault();
            close();
        }
    });
    (document.fullscreenElement ?? document.body).append(dlg);
    dlg.showModal();
}


// scrcpy's ROTATE_DEVICE re-enables auto-rotate immediately, so with auto-rotate on the phone snaps
// straight back. Lock the rotation ourselves instead and restore the user's setting on disconnect.
let savedRotation: { auto: string; user: string; serial: string } | null = null;
async function rotate() {
    const d = getDev();
    if (!d || !session) return;
    if (settings.virtualDisplay) return toast("The virtual display (desktop mode) has a fixed orientation.", "info", 3500);
    if (!savedRotation || savedRotation.serial !== d.serial) {
        const out = (await d.sh("settings get system accelerometer_rotation; settings get system user_rotation").catch(() => "")).split("\n");
        savedRotation = { auto: out[0]?.trim() || "1", user: out[1]?.trim() || "0", serial: d.serial };
    }
    const landscape = (session.width || videoW) > (session.height || videoH);
    const target = landscape ? 0 : 1;
    const w0 = session.width;
    await d.sh(`cmd window user-rotation lock ${target} >/dev/null 2>&1 || (settings put system accelerometer_rotation 0; settings put system user_rotation ${target})`).catch(() => {});
    setTimeout(() => {
        if (session && session.width === w0) toast("The app on screen has a fixed orientation — it ignores rotation.", "info", 4000);
    }, 2000);
}

async function restoreRotation(d: AndroidDevice) {
    const r = savedRotation;
    if (!r || r.serial !== d.serial) return;
    savedRotation = null;
    const auto = r.auto === "1";
    await d.sh(auto
        ? "cmd window user-rotation free >/dev/null 2>&1; settings put system accelerometer_rotation 1"
        : `settings put system user_rotation ${r.user}`).catch(() => {});
}

async function setScreen(on: boolean) {
    if (!session) return;
    await session.setScreenPower(on).catch(() => {});
    $("#btnScreenOff").classList.toggle("on", !on);
    toast(on ? "Phone screen on" : "Phone screen off — mirroring continues", "info", 1800);
}

// ======================================================================= clipboard
// The PC clipboard is never read through navigator.clipboard.readText(): on file:// pages Chrome
// cannot remember that permission and would prompt again on every read. Instead, Ctrl+V lets the
// browser perform a native paste, whose `paste` event carries the text without any prompt.
let pasteMode: "paste" | "type" | null = null;

function onPasteKey(typeIt: boolean) {
    pasteMode = typeIt ? "type" : "paste";
    setTimeout(() => (pasteMode = null), 500);
}

async function sendPcText(text: string, typeIt: boolean) {
    const c = session?.controller;
    if (!c || !text) return;
    if (typeIt) {
        for (let i = 0; i < text.length; i += 300) await c.injectText(text.slice(i, i + 300));
        return;
    }
    lastPushedClip = text;
    await c.setClipboard({ content: text, paste: true, sequence: 0n });
}

document.addEventListener(
    "paste",
    (e) => {
        if (!pasteMode && !input.active) return; // a normal paste into a panel input
        if ((e.target as HTMLElement)?.closest?.("input, textarea, [contenteditable]") && !input.captured) return;
        e.preventDefault();
        const mode = pasteMode ?? "paste";
        pasteMode = null;
        void sendPcText(e.clipboardData?.getData("text/plain") ?? "", mode === "type");
    },
    { capture: true },
);

// Text copied inside this page (shell output, file names…) goes to the phone clipboard too.
document.addEventListener("copy", () => {
    const text = document.getSelection()?.toString() ?? "";
    if (!settings.clipboardSync || !text || !session?.controller) return;
    lastPushedClip = text;
    void session.controller.setClipboard({ content: text, paste: false, sequence: 0n }).catch(() => {});
});

function onDeviceClipboard(text: string) {
    if (!settings.clipboardSync || text === lastPushedClip) return;
    lastDeviceClip = text;
    pendingClipWrite = text;
    void flushClipWrite();
}

async function flushClipWrite() {
    if (pendingClipWrite === null || !document.hasFocus()) return;
    const t = pendingClipWrite;
    try {
        await navigator.clipboard.writeText(t);
        pendingClipWrite = null;
        lastPushedClip = t;
        flashChip("Copied from phone");
    } catch {
        /* retry on next focus */
    }
}

window.addEventListener("focus", () => void flushClipWrite());

function flashChip(text: string) {
    const c = $("#clipChip");
    c.textContent = text;
    c.classList.remove("show");
    void c.offsetWidth;
    c.classList.add("show");
}

// ======================================================================= session
async function startSession() {
    const d = getDev();
    if (!d) return;
    await stopSession();
    const canvas = h("canvas", { id: "video", "aria-label": "Phone screen" }) as HTMLCanvasElement;
    screen.querySelector("canvas")?.remove();
    screen.prepend(canvas);
    $("#screenLoading").hidden = false;
    videoW = videoH = 0;
    const s = new MirrorSession(d, canvas);
    session = s;
    input.resetSession();
    try {
        await s.start(settings, {
            onSize(w, hh) {
                videoW = w;
                videoH = hh;
                $("#screenLoading").hidden = true;
                layout();
            },
            onClipboard: onDeviceClipboard,
            onLog: log,
            onExit(reason) {
                if (session !== s) return;
                if (encoderRejectedOptions(s)) return;
                if (getDev()) toast(reason ?? "Mirroring stopped", "warn", 6000, "Click ▶ in the dock to restart.");
                $("#screenLoading").hidden = true;
                app.classList.add("stopped");
            },
        }, !getPref("noCodecOpts:" + d.serial, false), getPref("audioPlayback:" + d.serial, false));
        app.classList.remove("stopped");
        if (s.audio) {
            s.audio.muted = getPref("muted", false);
            syncVolumeUi();
            if (s.audio.suspended) toast("Click anywhere to enable phone audio", "info", 4000);
            audioWatchdog(s, d);
        }
        if (!s.audio && s.audioProblem && settings.audio) toast("No phone audio", "warn", 8000, s.audioProblem + "\n" + audioLogTail());
        $("#btnScreenOff").classList.toggle("on", s.screenOff || (settings.screenOffOnStart && settings.videoSource === "display"));
        stage.focus({ preventScroll: true });
    } catch (e) {
        if (session === s && encoderRejectedOptions(s)) return;
        if (session === s) session = undefined;
        $("#screenLoading").hidden = true;
        app.classList.add("stopped");
        let detail = errorMessage(e);
        if (e instanceof AdbScrcpyExitedError) detail = e.output.slice(-6).join("\n") || detail;
        e instanceof AdbScrcpyExitedError && e.output.forEach(log);
        toast("Could not start mirroring", "error", 10000, detail);
    }
}

function audioLogTail() {
    return logLines.filter((l) => /audio|AudioRecord|submix|capture/i.test(l)).slice(-4).join("\n");
}

/** If no samples arrive, show the phone's reason and (Android 13+) retry with the playback-capture source. */
function audioWatchdog(s: MirrorSession, d: AndroidDevice) {
    setTimeout(() => {
        if (session !== s || !s.audio || s.audio.samplesIn > 0) return;
        const tail = audioLogTail();
        if (s.audioSourceUsed === "output" && d.info.sdk >= 33 && !getPref("audioPlayback:" + d.serial, false)) {
            setPref("audioPlayback:" + d.serial, true);
            log("[annex] no audio from the default source — retrying with playback capture");
            toast("No audio from the phone — retrying with Android's playback capture.", "warn", 6000, tail || undefined);
            void startSession();
        } else {
            toast("The phone sends no audio", "warn", 12000, (tail || "No error reported by the phone.") + "\nUnlock the phone, then restart the stream (▶). Some apps block audio capture.");
        }
    }, 4000);
}

/** Some phone encoders refuse CBR / frame-repeat options; fall back once and remember per device. */
function encoderRejectedOptions(s: MirrorSession): boolean {
    const d = getDev();
    if (!d || !s.codecOptions || (s.decoder?.framesRendered ?? 0) > 3 || Date.now() - s.startedAt > 10000) return false;
    setPref("noCodecOpts:" + d.serial, true);
    log(`[annex] phone encoder rejected "${s.codecOptions}" — retrying without (CBR / constant fps unavailable on this phone)`);
    toast("This phone's encoder doesn't support constant bitrate / frame rate — using its default mode.", "warn", 7000);
    void startSession();
    return true;
}

async function stopSession() {
    const s = session;
    session = undefined;
    if (recorder.recording) await toggleRecord();
    await input.setCapture(false);
    input.releaseAll();
    await s?.stop().catch(() => {});
}

// ======================================================================= connect / disconnect
async function adopt(d: AndroidDevice) {
    dev = d;
    setTimeout(flushLaunchFiles, 1500);
    userDisconnected = false;
    setPref("lastSerial", d.serial);
    files.reset();
    apps.reset();
    setState("connected");
    updateDeviceUi();
    void d.adb.disconnected.then(() => onLinkLost(d));
    await startSession();
}

function onLinkLost(d: AndroidDevice) {
    if (dev !== d) return;
    const wasWifi = d.kind === "wifi";
    void stopSession();
    dev = undefined;
    updateDeviceUi();
    if (switchingToWifi) return;
    setState("idle");
    renderKnown();
    if (!userDisconnected) {
        toast(wasWifi ? "Wi‑Fi link lost" : "Phone disconnected", "warn", 5000);
        if (wasWifi && d.wifi && settings.autoConnect) void reconnectWifi(d.wifi);
    }
}

async function reconnectWifi(w: WifiDevice) {
    for (let i = 0; i < 3 && !getDev() && !userDisconnected; i++) {
        await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
        if (getDev() || busy) return;
        try {
            await connectWifi(w, true);
            return;
        } catch {
            /* retry */
        }
    }
}

function withCancel<T>(p: Promise<T>, onCancel: () => void): Promise<T> {
    return new Promise((resolve, reject) => {
        abortConnect = () => {
            onCancel();
            reject(new UserCancelled());
        };
        p.then(resolve, reject).finally(() => (abortConnect = null));
    });
}

async function connectUsb(device?: AdbDaemonWebUsbDevice) {
    if (busy) return;
    busy = true;
    try {
        const target = device ?? (await AndroidDevice.requestUsb());
        connectingUi(`Connecting to ${target.name || "phone"}…`, "Opening the USB debugging interface");
        let raw: USBDevice | undefined = target.raw;
        const d = await withCancel(
            AndroidDevice.connectUsb(target, () =>
                connectingUi("Check your phone", "Tap “Allow” on the USB debugging prompt. Tick “Always allow from this computer” to skip this next time."),
            ),
            () => void raw?.close().catch(() => {}),
        );
        raw = undefined;
        await adopt(d);
    } catch (e) {
        setState(getDev() ? "connected" : "idle");
        if (!(e instanceof UserCancelled) && !(e instanceof DOMException && e.name === "NotFoundError")) {
            toast("USB connection failed", "error", 12000, errorMessage(e));
        }
    } finally {
        busy = false;
        renderKnown();
    }
}

async function connectWifi(w: WifiDevice, silent = false) {
    if (busy) throw new Error("busy");
    busy = true;
    try {
        if (!silent) connectingUi(`Connecting to ${w.name} over Wi‑Fi…`, `${w.host}:${w.port} · end-to-end encrypted`);
        const d = await withCancel(
            AndroidDevice.connectWifi(w, () => connectingUi("Check your phone", "Tap “Allow” if the phone asks to allow debugging.")),
            () => {},
        );
        if (dev && dev !== d) {
            const old = dev;
            dev = undefined;
            await stopSession();
            await old.close();
        }
        await adopt(d);
    } catch (e) {
        if (!getDev()) setState("idle");
        if (!silent && !(e instanceof UserCancelled)) toast(`Could not connect to ${w.name}`, "error", 9000, errorMessage(e));
        throw e;
    } finally {
        busy = false;
        renderKnown();
    }
}

async function disconnect() {
    const d = dev;
    if (!d) return;
    userDisconnected = true;
    await stopSession();
    await restoreRotation(d);
    dev = undefined;
    await d.close();
    try {
        await d.usb?.raw.close();
    } catch {
        /* ignore */
    }
    updateDeviceUi();
    setState("idle");
    renderKnown();
}

async function enableWifi() {
    const d = getDev();
    if (!d || d.kind !== "usb" || busy) return;
    const t = toast("Setting up Wi‑Fi mode…", "info", 60000);
    try {
        switchingToWifi = true;
        const { record, restarting } = await d.enableWifi((m) => t.update(m));
        if (restarting) {
            t.update("Waiting for ADB to restart in network mode…");
            await stopSession();
            await Promise.race([d.adb.disconnected, new Promise((r) => setTimeout(r, 5000))]);
            await new Promise((r) => setTimeout(r, 1500));
        }
        t.update("Connecting over Wi‑Fi…");
        let lastErr: unknown;
        for (let i = 0; i < 6; i++) {
            try {
                await connectWifi(record, true);
                lastErr = undefined;
                break;
            } catch (e) {
                lastErr = e;
                await new Promise((r) => setTimeout(r, 1200));
            }
        }
        if (lastErr) throw lastErr;
        if (!d.closed) {
            await d.close();
            await d.usb?.raw.close().catch(() => {});
        }
        t.dismiss();
        toast("Wi‑Fi mode is on. You can unplug the cable.", "ok", 6000);
    } catch (e) {
        t.dismiss();
        toast("Wi‑Fi setup failed", "error", 12000, errorMessage(e));
        if (!getDev()) {
            setState("idle");
            renderKnown();
        }
    } finally {
        switchingToWifi = false;
    }
}

async function disableWifi() {
    const d = getDev();
    if (!d) return;
    const ok = await confirmDialog(
        "Turn off Wi‑Fi mode?",
        d.kind === "wifi"
            ? "The bridge on the phone is stopped and ADB returns to USB-only. This Wi‑Fi connection will end — reconnect with the cable."
            : "The bridge on the phone is stopped, ADB returns to USB-only and the pairing key is forgotten. The USB link restarts briefly.",
        "Turn off",
    );
    if (!ok) return;
    userDisconnected = d.kind === "wifi";
    await d.disableWifi();
    toast("Wi‑Fi mode turned off", "ok");
    updateDeviceUi();
    renderKnown();
}

// ======================================================================= welcome / known devices
async function renderKnown() {
    const box = $("#known");
    box.replaceChildren();
    const usb = await AndroidDevice.knownUsbDevices();
    const wifi = loadWifiDevices();
    for (const u of usb) {
        box.append(
            h("button", { class: "known-item", onclick: () => void connectUsb(u) }, icon("usb"), h("span", { class: "k-name", text: u.name || u.serial }), h("span", { class: "k-sub", text: "USB · " + u.serial }), icon("chevron-right", "k-go")),
        );
    }
    for (const w of wifi) {
        const item = h(
            "div",
            { class: "known-item wifi" },
            icon("wifi"),
            h("span", { class: "k-name", text: w.name }),
            h("span", { class: "k-sub", text: `Wi‑Fi · ${w.host}` }),
            h("button", { class: "icon-btn sm", title: "Edit address", "aria-label": "Edit address", onclick: (e: Event) => { e.stopPropagation(); void editWifi(w); } }, icon("pencil")),
            h("button", { class: "icon-btn sm danger", title: "Forget", "aria-label": "Forget device", onclick: (e: Event) => { e.stopPropagation(); removeWifiDevice(w.serial); void renderKnown(); } }, icon("x")),
            icon("chevron-right", "k-go"),
        );
        item.tabIndex = 0;
        item.addEventListener("click", () => void connectWifi(w).catch(() => {}));
        item.addEventListener("keydown", (e) => e.key === "Enter" && void connectWifi(w).catch(() => {}));
        box.append(item);
    }
    box.hidden = !box.children.length;
    $("#knownLabel").hidden = !box.children.length;
}

async function editWifi(w: WifiDevice) {
    const { promptDialog } = await import("./ui");
    const v = await promptDialog("Phone address", "IP address (shown in the phone's Wi‑Fi settings)", w.host, "Save");
    if (!v) return;
    const list = loadWifiDevices().map((x) => (x.serial === w.serial ? { ...x, host: v.trim() } : x));
    localStorage.setItem("annex.wifi.v1", JSON.stringify(list));
    void renderKnown();
}

function wifiChooser() {
    const list = loadWifiDevices();
    if (!list.length) {
        toast("No phone paired for Wi‑Fi yet", "info", 9000, "Connect once via USB, then open Device ▸ Enable Wi‑Fi mode. After that you can connect here without a cable.");
        return;
    }
    if (list.length === 1) void connectWifi(list[0]).catch(() => {});
    else $("#known").querySelector<HTMLElement>(".known-item.wifi")?.focus();
}

// ======================================================================= top bar actions
function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void app.requestFullscreen({ navigationUI: "hide" }).catch(() => toast("Fullscreen was blocked by the browser", "warn"));
}
document.addEventListener("fullscreenchange", () => {
    app.classList.toggle("fs", !!document.fullscreenElement);
    $("#btnFullscreen").classList.toggle("on", !!document.fullscreenElement);
    setTimeout(layout, 50);
});

async function screenshot() {
    const blob = await session?.snapshot();
    if (!blob) return;
    downloadBlob(blob, `annex-${timestamp()}.png`);
    try {
        await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
        toast("Screenshot saved and copied to clipboard", "ok", 2500);
    } catch {
        toast("Screenshot saved", "ok", 2000);
    }
}

let recTimer = 0;
async function toggleRecord() {
    const btn = $("#btnRecord");
    if (recorder.recording) {
        clearInterval(recTimer);
        await recorder.stop();
        btn.classList.remove("rec");
        $("#recTime").textContent = "";
        toast("Recording saved", "ok");
        return;
    }
    const canvas = screen.querySelector("canvas");
    if (!canvas || !session) return;
    try {
        recorder.start(canvas, session.audio?.mediaStream, settings.maxFps);
    } catch (e) {
        toast("Recording is not supported here", "error", 6000, errorMessage(e));
        return;
    }
    btn.classList.add("rec");
    const t0 = Date.now();
    recTimer = window.setInterval(() => {
        const s = Math.floor((Date.now() - t0) / 1000);
        $("#recTime").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    }, 500);
}

let statsTimer = 0;
function toggleStats(force?: boolean) {
    settings.showStats = force ?? !settings.showStats;
    saveSettings(settings);
    $("#btnStats").classList.toggle("on", settings.showStats);
    const el = $("#stats");
    el.hidden = !settings.showStats;
    clearInterval(statsTimer);
    if (settings.showStats) {
        session?.stats();
        statsTimer = window.setInterval(() => {
            const s = session?.stats();
            if (!s) {
                el.textContent = "no stream";
                return;
            }
            el.textContent = `${s.width}×${s.height}  ${s.codec}\nshown ${s.fps.toFixed(0)} fps · in ${s.inFps.toFixed(0)} fps\n${(s.kbps / 1000).toFixed(1)} Mbps · skipped ${s.skipped}\naudio ${s.audio}\n${dev?.kind === "wifi" ? "Wi‑Fi (encrypted)" : "USB"}`;
        }, 1000);
    }
}

function syncVolumeUi() {
    const a = session?.audio;
    const muted = a ? a.muted : getPref("muted", false);
    const btn = $("#btnVolume");
    btn.replaceChildren(icon(muted ? "volume-x" : settings.volume < 0.5 ? "volume-1" : "volume-2"));
    btn.classList.toggle("on", !muted && !!a);
    ($("#volSlider") as HTMLInputElement).value = String(Math.round(settings.volume * 100));
}

// ======================================================================= panels
const files = new FilesPanel($("#panel-files"), getDev, transfers);
const apps = new AppsPanel($("#panel-apps"), getDev, async (pkg, forceStop) => {
    if (!session?.controller) return false;
    await session.controller.startApp(pkg, { forceStop });
    stage.focus({ preventScroll: true });
    return true;
});
const shell = new ShellPanel($("#panel-shell"), getDev);
const PANEL_TITLES: Record<string, string> = { device: "Device", files: "Files", apps: "Apps", shell: "Shell", settings: "Settings", help: "Help & shortcuts" };
let openPanelName: string | null = null;

function openPanel(name: string | null) {
    if (name === openPanelName) name = null;
    openPanelName = name;
    const panel = $("#panel");
    panel.hidden = !name;
    app.classList.toggle("panel-open", !!name);
    $$(".rail-btn").forEach((b) => b.classList.toggle("on", b.dataset.panel === name));
    $$(".panel-section").forEach((s) => (s.hidden = s.dataset.panel !== name));
    if (name) $("#panelTitle").textContent = PANEL_TITLES[name];
    if (name === "files" && getDev()) void files.show();
    if (name === "apps" && getDev()) void apps.show();
    if (name === "shell") shell.focus();
    if (name === "device" && getDev()) void getDev()!.refreshInfo().then(updateDeviceUi).catch(() => {});
    setPref("panel", name);
    setTimeout(layout, 220);
}
$$(".rail-btn").forEach((b) => b.addEventListener("click", () => openPanel(b.dataset.panel!)));
$("#panelClose").addEventListener("click", () => openPanel(null));

// ======================================================================= settings form
const RESTART_KEYS: (keyof Settings)[] = ["maxSize", "maxFps", "bitrateMbps", "videoCodec", "videoSource", "cameraFacing", "virtualDisplay", "virtualWidth", "virtualHeight", "virtualDpi", "audio", "audioCodec", "audioDup", "stayAwake", "powerOffOnClose", "showTouches", "clipboardSync", "cbr", "constantFps"];
let needsRestart = false;

function syncSettingsForm() {
    $$<HTMLInputElement | HTMLSelectElement>("[data-setting]").forEach((el) => {
        const k = el.dataset.setting as keyof Settings;
        const v = settings[k];
        if (el instanceof HTMLInputElement && el.type === "checkbox") el.checked = !!v;
        else el.value = String(v);
        const out = el.parentElement?.querySelector("output");
        if (out) out.textContent = fmtSetting(k, v);
    });
    $("#virtualFields").hidden = !settings.virtualDisplay;
    $("#cameraFields").hidden = settings.videoSource !== "camera";
    $("#hostKeyName").textContent = hostKeyLabel();
    $$(".host-name").forEach((e) => (e.textContent = hostKeyLabel()));
}

function fmtSetting(k: keyof Settings, v: unknown) {
    if (k === "bitrateMbps") return `${v} Mbps`;
    if (k === "volume") return `${Math.round(Number(v) * 100)}%`;
    if (k === "scrollSpeed") return `${Number(v).toFixed(1)}×`;
    return String(v);
}

$$<HTMLInputElement | HTMLSelectElement>("[data-setting]").forEach((el) => {
    el.addEventListener(el instanceof HTMLInputElement && el.type === "range" ? "input" : "change", () => {
        const k = el.dataset.setting as keyof Settings;
        const def = DEFAULTS[k];
        let v: unknown;
        if (el instanceof HTMLInputElement && el.type === "checkbox") v = el.checked;
        else if (typeof def === "number") v = Number(el.value);
        else v = el.value;
        (settings as unknown as Record<string, unknown>)[k] = v;
        saveSettings(settings);
        syncSettingsForm();
        if (RESTART_KEYS.includes(k) && session) {
            needsRestart = true;
            $("#applyBar").hidden = false;
        }
        if (k === "scaleMode" || k === "smoothing") layout();
        if (k === "showStats") toggleStats(settings.showStats);
        if (k === "frameDelivery" && session?.pacer) session.pacer.mode = settings.frameDelivery;
        if (k === "videoCodec" && v !== "h264") void probeCodec(String(v)).then((ok) => !ok && toast(`This browser cannot decode ${String(v).toUpperCase()} — H.264 will be used.`, "warn", 6000));
        if (k === "keyboardMode" || k === "captureMouse" || k === "inputMode") input.releaseAll();
        if (k === "inputMode") syncGamingUi();
    });
});
$("#btnApply").addEventListener("click", () => {
    needsRestart = false;
    $("#applyBar").hidden = true;
    void startSession();
});
$("#btnResetSettings").addEventListener("click", async () => {
    if (!(await confirmDialog("Reset settings?", "All settings return to their defaults. Paired Wi‑Fi devices are kept.", "Reset"))) return;
    settings = structuredClone(DEFAULTS);
    saveSettings(settings);
    syncSettingsForm();
    renderKeyMap();
    syncGamingUi();
    layout();
    if (session) $("#applyBar").hidden = false;
});
$("#btnKbSettings").addEventListener("click", async () => {
    const c = session?.controller;
    if (!c) return toast("Connect a phone first", "info");
    await c.write(new Uint8Array([15])); // OPEN_HARD_KEYBOARD_SETTINGS
    toast("Opened the physical keyboard settings on the phone — pick your layout for “Annex Keyboard”.", "info", 7000);
});

// ======================================================================= soft-key remapping
function keyLabel(code: string) {
    return code.replace(/^Key/, "").replace(/^Digit/, "").replace(/^Numpad/, "Num ").replace(/Left$/, " L").replace(/Right$/, " R").replace("Escape", "Esc").replace("Backquote", "`") || code;
}

function renderKeyMap() {
    const box = $("#keyMapList");
    box.replaceChildren(
        ...settings.keyMap.map((m, i) => {
            const keyBtn = h("button", { class: "km-key", title: "Click, then press the PC key", text: keyLabel(m.code) });
            keyBtn.addEventListener("click", () => recordKey(keyBtn, i));
            const sel = h("select", { "aria-label": "Android action" }, ...SOFT_KEY_ACTIONS.map((a) => h("option", { value: a.id, text: a.label, selected: a.id === m.action }))) as HTMLSelectElement;
            sel.addEventListener("change", () => {
                settings.keyMap[i].action = sel.value;
                saveSettings(settings);
            });
            const del = h("button", { class: "icon-btn sm danger", title: "Remove", "aria-label": "Remove soft key", onclick: () => { settings.keyMap.splice(i, 1); saveSettings(settings); renderKeyMap(); } }, icon("x"));
            return h("div", { class: "km-row" }, keyBtn, sel, del);
        }),
    );
    if (!settings.keyMap.length) box.append(h("div", { class: "muted small", text: "No soft keys. Esc will reach the phone as a plain Escape key." }));
}

function recordKey(btn: HTMLElement, index: number) {
    btn.classList.add("rec");
    btn.textContent = "Press a key…";
    input.suspended = true;
    const onKey = (e: KeyboardEvent) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.type !== "keydown") return;
        window.removeEventListener("keydown", onKey, true);
        window.removeEventListener("keyup", onKey, true);
        setTimeout(() => (input.suspended = false), 0);
        if (["ControlLeft", "ControlRight", "AltLeft", "MetaLeft", "MetaRight", "ShiftLeft", "ShiftRight"].includes(e.code) || e.code === settings.hostKey) {
            toast("Modifier keys and the host key can't be soft keys.", "warn", 3500);
            if (!settings.keyMap[index]?.code) settings.keyMap.splice(index, 1);
        } else {
            settings.keyMap = settings.keyMap.filter((m, i) => i === index || m.code !== e.code);
            const idx = settings.keyMap.findIndex((_, i) => i === index);
            if (idx >= 0) settings.keyMap[idx].code = e.code;
            saveSettings(settings);
        }
        renderKeyMap();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
}

$("#btnAddMap").addEventListener("click", () => {
    settings.keyMap.push({ code: "", action: "home" });
    renderKeyMap();
    const btns = $$<HTMLElement>(".km-key");
    recordKey(btns[btns.length - 1], settings.keyMap.length - 1);
});

// ======================================================================= dock (navigation buttons)
function holdButton(el: HTMLElement, keyCode: AndroidKeyCode) {
    let down = false;
    const release = () => {
        if (!down) return;
        down = false;
        void input.keyUp(keyCode);
    };
    el.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        down = true;
        el.setPointerCapture(e.pointerId);
        void input.keyDown(keyCode);
    });
    el.addEventListener("pointerup", release);
    el.addEventListener("pointercancel", release);
    el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            void input.pressKey(keyCode);
        }
    });
}
holdButton($("#navBack"), AndroidKeyCode.AndroidBack);
holdButton($("#navHome"), AndroidKeyCode.AndroidHome);
holdButton($("#navRecents"), AndroidKeyCode.AndroidAppSwitch);
holdButton($("#navVolUp"), AndroidKeyCode.VolumeUp);
holdButton($("#navVolDown"), AndroidKeyCode.VolumeDown);
holdButton($("#navPower"), AndroidKeyCode.Power);
$("#navRotate").addEventListener("click", () => void rotate());
let notifOpen = false;
$("#navNotif").addEventListener("click", () => {
    const c = session?.controller;
    if (!c) return;
    notifOpen = !notifOpen;
    void (notifOpen ? c.expandNotificationPanel() : c.collapseNotificationPanel());
});
$("#btnScreenOff").addEventListener("click", () => void setScreen(!!session?.screenOff));
$("#navRestart").addEventListener("click", () => void startSession());

// ======================================================================= top bar wiring
$("#btnUsb").addEventListener("click", () => void connectUsb());
$("#btnWifi").addEventListener("click", wifiChooser);
$("#btnCancelConnect").addEventListener("click", () => {
    abortConnect?.();
    setState(getDev() ? "connected" : "idle");
});
$("#btnGaming").addEventListener("click", () => toggleGaming());
$("#btnCapture").addEventListener("click", () => void input.setCapture(!input.captured));
$("#btnFullscreen").addEventListener("click", toggleFullscreen);
$("#btnShot").addEventListener("click", () => void screenshot());
$("#btnRecord").addEventListener("click", () => void toggleRecord());
$("#btnStats").addEventListener("click", () => toggleStats());
$("#btnDisconnect").addEventListener("click", () => void disconnect());
setInterval(() => {
    const a = session?.audio;
    $("#btnVolume").classList.toggle("needs-click", !!a && a.suspended);
}, 1000);
$("#btnVolume").addEventListener("click", () => {
    const a = session?.audio;
    if (a?.suspended) {
        void a.ctx.resume();
        return;
    }
    const m = !(a ? a.muted : getPref("muted", false));
    setPref("muted", m);
    if (a) a.muted = m;
    syncVolumeUi();
});
$("#volSlider").addEventListener("input", (e) => {
    settings.volume = Number((e.target as HTMLInputElement).value) / 100;
    saveSettings(settings);
    if (session?.audio) {
        session.audio.volume = settings.volume;
        if (session.audio.muted && settings.volume > 0) {
            session.audio.muted = false;
            setPref("muted", false);
        }
    }
    syncVolumeUi();
});
$("#btnWifiOn").addEventListener("click", () => void enableWifi());
$("#btnWifiOff").addEventListener("click", () => void disableWifi());
$("#btnRefreshInfo").addEventListener("click", () => void getDev()?.refreshInfo().then(updateDeviceUi));
$$("[data-reboot]").forEach((b) =>
    b.addEventListener("click", async () => {
        const d = getDev();
        if (!d) return;
        const mode = b.dataset.reboot!;
        if (!(await confirmDialog("Reboot phone?", mode === "system" ? "The phone restarts. Wi‑Fi mode must be re-enabled over USB afterwards." : `The phone restarts into ${mode}.`, "Reboot", true))) return;
        userDisconnected = true;
        if (mode === "system") await d.adb.power.reboot().catch(() => {});
        else if (mode === "recovery") await d.adb.power.recovery().catch(() => {});
        else await d.adb.power.bootloader().catch(() => {});
    }),
);
$("#btnCopyLog").addEventListener("click", () => void navigator.clipboard.writeText(logLines.join("\n")).then(() => toast("Log copied", "ok", 1500)));

// ======================================================================= drag & drop onto the phone
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
    if (!getDev() || !e.dataTransfer?.types.includes("Files")) return;
    dragDepth++;
    $("#dropOverlay").hidden = false;
    $("#dropDir").textContent = settings.uploadDir;
});
window.addEventListener("dragleave", () => {
    if (--dragDepth <= 0) {
        dragDepth = 0;
        $("#dropOverlay").hidden = true;
    }
});
window.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
});
window.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    $("#dropOverlay").hidden = true;
    const d = getDev();
    const list = [...(e.dataTransfer?.files ?? [])];
    if (!d || !list.length) return;
    void sendFiles(d, list, settings.uploadDir, transfers, () => openPanelName === "files" && void files.refresh());
});

// ======================================================================= USB hotplug
navigator.usb?.addEventListener("connect", async () => {
    void renderKnown();
    if (getDev() || busy || switchingToWifi || !settings.autoConnect) return;
    const last = getPref<string>("lastSerial", "");
    const list = await AndroidDevice.knownUsbDevices();
    const match = list.find((x) => x.serial === last) ?? (list.length === 1 ? list[0] : undefined);
    if (match) setTimeout(() => void connectUsb(match), 400);
});
navigator.usb?.addEventListener("disconnect", (e) => {
    void renderKnown();
    const d = getDev();
    if (d?.kind === "usb" && d.usb?.raw === (e as USBConnectionEvent).device) void d.close();
});

// ======================================================================= help / checks
function renderHelp() {
    $("#comboTable").replaceChildren(
        ...HOTKEYS.map((k) => h("tr", {}, h("td", {}, h("kbd", { text: "Ctrl" }), "+", h("kbd", { text: "Alt" }), "+", h("kbd", { text: k.key })), h("td", { text: k.desc }))),
    );
}

async function renderChecks() {
    const checks: [string, boolean, string][] = [
        ["WebUSB", !!usbManager, "Chrome, Edge, Brave or Opera (desktop)"],
        ["WebCodecs", typeof VideoDecoder !== "undefined", "hardware video decoding"],
        ["H.264", await probeCodec("h264"), "decoder available"],
        ["Secure context", isSecureContext, "file:// or localhost"],
    ];
    $("#checks").replaceChildren(
        ...checks.map(([n, ok, tip]) => h("span", { class: "check-pill " + (ok ? "ok" : "bad"), title: tip }, icon(ok ? "check" : "x"), n)),
    );
    if (!usbManager) {
        ($("#btnUsb") as HTMLButtonElement).disabled = true;
        $("#usbMissing").hidden = false;
    }
}

// ======================================================================= boot
setState("idle");
syncSettingsForm();
renderKeyMap();
syncGamingUi();
syncVolumeUi();
renderHelp();
void renderChecks();
void renderKnown();
toggleStats(settings.showStats);
const savedPanel = getPref<string | null>("panel", null);
if (savedPanel) openPanel(savedPanel);

window.addEventListener("beforeunload", () => {
    // Best effort: restore the phone screen and release keys.
    input.releaseAll();
    if (session?.screenOff) void session.setScreenPower(true);
    const d = getDev();
    if (d) void restoreRotation(d);
});

// Auto-connect a previously authorised USB phone.
void (async () => {
    if (!settings.autoConnect) return;
    const list = await AndroidDevice.knownUsbDevices();
    const last = getPref<string>("lastSerial", "");
    const match = list.find((x) => x.serial === last) ?? (list.length === 1 ? list[0] : undefined);
    if (match) await connectUsb(match);
})();

// ======================================================================= PWA
let pendingLaunchFiles: File[] = [];
function flushLaunchFiles() {
    const d = getDev();
    if (!d || !pendingLaunchFiles.length) return;
    const files = pendingLaunchFiles;
    pendingLaunchFiles = [];
    void sendFiles(d, files, settings.uploadDir, transfers);
}
setupPwa({
    installButton: $("#btnInstall") as HTMLButtonElement,
    onFiles(files) {
        pendingLaunchFiles.push(...files);
        if (getDev()) flushLaunchFiles();
        else toast(`Connect a phone to install ${files.map((f) => f.name).join(", ")}`, "info", 8000);
    },
    onInstalled: () => toast("Annex is installed — open it from your Start menu / app launcher.", "ok", 7000),
});
app.classList.toggle("standalone", isStandalone());
matchMedia("(display-mode: standalone), (display-mode: window-controls-overlay)").addEventListener("change", () => app.classList.toggle("standalone", isStandalone()));
$("#pwaHint").hidden = isServed;

// expose for debugging / tests
(window as unknown as { annex: unknown }).annex = {
    get dev() { return dev; },
    get session() { return session; },
    get settings() { return settings; },
    input,
    connectWifi,
    connectUsb,
    disconnect,
    enableWifi,
    formatBytes,
};
