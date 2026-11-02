export type ScaleMode = "fit" | "native" | "integer";
export type KeyboardMode = "sdk" | "uhid";
export type CaptureMouseMode = "uhid" | "cursor";
export type HostKey = "ControlRight" | "AltRight" | "MetaRight" | "ScrollLock" | "Pause";
export type AudioCodecChoice = "auto" | "raw" | "opus";

/** Android actions a PC key can be remapped to. */
export const SOFT_KEY_ACTIONS: { id: string; label: string; keyCode?: number; panel?: "notifications" | "quicksettings" }[] = [
    { id: "back", label: "Back", keyCode: 4 },
    { id: "home", label: "Home", keyCode: 3 },
    { id: "recents", label: "Recent apps", keyCode: 187 },
    { id: "menu", label: "Menu", keyCode: 82 },
    { id: "power", label: "Power", keyCode: 26 },
    { id: "volup", label: "Volume up", keyCode: 24 },
    { id: "voldown", label: "Volume down", keyCode: 25 },
    { id: "mute", label: "Mute", keyCode: 164 },
    { id: "notifications", label: "Notifications", panel: "notifications" },
    { id: "quicksettings", label: "Quick settings", panel: "quicksettings" },
    { id: "screenshot", label: "Phone screenshot", keyCode: 120 },
    { id: "assistant", label: "Assistant", keyCode: 219 },
    { id: "search", label: "Search", keyCode: 84 },
    { id: "playpause", label: "Play / pause", keyCode: 85 },
    { id: "next", label: "Next track", keyCode: 87 },
    { id: "previous", label: "Previous track", keyCode: 88 },
    { id: "brightnessup", label: "Brightness up", keyCode: 221 },
    { id: "brightnessdown", label: "Brightness down", keyCode: 220 },
    { id: "camera", label: "Camera", keyCode: 27 },
    { id: "sleep", label: "Sleep", keyCode: 223 },
    { id: "wakeup", label: "Wake up", keyCode: 224 },
];

export interface KeyMapping {
    code: string; // KeyboardEvent.code
    action: string; // SOFT_KEY_ACTIONS id
}

export interface Settings {
    // stream
    maxSize: number; // 0 = native
    maxFps: number;
    bitrateMbps: number;
    videoCodec: "h264" | "h265" | "av1";
    videoSource: "display" | "camera";
    cameraFacing: "back" | "front" | "external";
    virtualDisplay: boolean;
    virtualWidth: number;
    virtualHeight: number;
    virtualDpi: number;
    // audio
    audio: boolean;
    audioCodec: AudioCodecChoice;
    audioDup: boolean; // keep playing on phone (Android 13+)
    volume: number; // 0..1
    // display
    scaleMode: ScaleMode;
    smoothing: boolean;
    showStats: boolean;
    // behaviour
    stayAwake: boolean;
    screenOffOnStart: boolean;
    powerOffOnClose: boolean;
    showTouches: boolean;
    clipboardSync: boolean;
    constantFps: boolean; // encoder repeats frames when the screen is idle
    cbr: boolean; // constant-bitrate encoder mode
    frameDelivery: "smooth" | "latency";
    autoConnect: boolean;
    // input
    keyboardMode: KeyboardMode;
    captureMouse: CaptureMouseMode;
    hostKey: HostKey;
    /** "touch": LMB = finger, MMB = Home, RMB = Back. "pc": OG Gaming — real mouse buttons + HID keyboard. */
    inputMode: "touch" | "pc";
    scrollSpeed: number;
    keyMap: KeyMapping[];
    // files
    uploadDir: string;
}

export const DEFAULTS: Settings = {
    maxSize: 0,
    maxFps: 60,
    bitrateMbps: 12,
    videoCodec: "h264",
    videoSource: "display",
    cameraFacing: "back",
    virtualDisplay: false,
    virtualWidth: 1920,
    virtualHeight: 1080,
    virtualDpi: 220,
    audio: true,
    audioCodec: "auto",
    audioDup: false,
    volume: 1,
    scaleMode: "fit",
    smoothing: true,
    showStats: false,
    stayAwake: true,
    screenOffOnStart: false,
    powerOffOnClose: false,
    showTouches: false,
    clipboardSync: true,
    constantFps: true,
    cbr: true,
    frameDelivery: "smooth",
    autoConnect: true,
    keyboardMode: "sdk",
    captureMouse: "uhid",
    hostKey: "ControlRight",
    inputMode: "touch",
    scrollSpeed: 1,
    keyMap: [{ code: "Escape", action: "back" }],
    uploadDir: "/sdcard/Download/",
};

const KEY = "annex.settings.v1";

export function loadSettings(): Settings {
    try {
        const raw = localStorage.getItem(KEY);
        if (raw) return { ...structuredClone(DEFAULTS), ...JSON.parse(raw) };
    } catch {
        /* storage unavailable */
    }
    return structuredClone(DEFAULTS);
}

export function saveSettings(s: Settings) {
    try {
        localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
        /* ignore */
    }
}

// ---- Wi-Fi paired devices ------------------------------------------------
export interface WifiDevice {
    serial: string;
    name: string;
    host: string;
    port: number;
    key: string; // hex, 32 bytes
    lastUsed: number;
}

const WKEY = "annex.wifi.v1";

export function loadWifiDevices(): WifiDevice[] {
    try {
        const raw = localStorage.getItem(WKEY);
        if (raw) return JSON.parse(raw) as WifiDevice[];
    } catch {
        /* ignore */
    }
    return [];
}

export function saveWifiDevices(list: WifiDevice[]) {
    try {
        localStorage.setItem(WKEY, JSON.stringify(list));
    } catch {
        /* ignore */
    }
}

export function upsertWifiDevice(d: WifiDevice) {
    const list = loadWifiDevices().filter((x) => x.serial !== d.serial);
    list.unshift(d);
    saveWifiDevices(list);
}

export function removeWifiDevice(serial: string) {
    saveWifiDevices(loadWifiDevices().filter((x) => x.serial !== serial));
}

// ---- small per-viewer prefs ----------------------------------------------
export function getPref<T>(k: string, d: T): T {
    try {
        const v = localStorage.getItem("annex.pref." + k);
        return v === null ? d : (JSON.parse(v) as T);
    } catch {
        return d;
    }
}

export function setPref(k: string, v: unknown) {
    try {
        localStorage.setItem("annex.pref." + k, JSON.stringify(v));
    } catch {
        /* ignore */
    }
}
