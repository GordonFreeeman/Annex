import { AdbScrcpyClient, AdbScrcpyOptions3_3 } from "@yume-chan/adb-scrcpy";
import type { ScrcpyControlMessageWriter, ScrcpyMediaStreamPacket } from "@yume-chan/scrcpy";
import { AndroidScreenPowerMode, ScrcpyInstanceId, ScrcpyVideoCodecId } from "@yume-chan/scrcpy";
import { BitmapVideoFrameRenderer, WebCodecsVideoDecoder, WebGLVideoFrameRenderer } from "@yume-chan/scrcpy-decoder-webcodecs";
import { TransformStream, WritableStream } from "@yume-chan/stream-extra";
import { AudioPlayer } from "./audio";
import { PacedRenderer } from "./pacer";
import { BRIDGE_JAR, SCRCPY_SERVER, SCRCPY_VERSION } from "./assets";
import type { AndroidDevice } from "./device";
import type { Settings } from "./settings";

export const SERVER_PATH = `/data/local/tmp/annex-scrcpy-${SCRCPY_VERSION}.jar`;

export interface SessionEvents {
    onSize(width: number, height: number): void;
    onClipboard(text: string): void;
    onLog(line: string): void;
    onExit(reason?: string): void;
}

export interface SessionStats {
    /** frames received from the phone per second */
    inFps: number;
    /** frames shown on screen per second */
    fps: number;
    /** frames received but never shown (two arrived within one display refresh) */
    skipped: number;
    kbps: number;
    width: number;
    height: number;
    codec: string;
    audio: string;
}

const CODEC_PROBE: Record<string, string> = {
    h264: "avc1.640033",
    h265: "hvc1.1.6.L153.B0",
    av1: "av01.0.08M.08",
};

export async function probeCodec(codec: string): Promise<boolean> {
    if (typeof VideoDecoder === "undefined") return false;
    try {
        const r = await VideoDecoder.isConfigSupported({ codec: CODEC_PROBE[codec] ?? codec, optimizeForLatency: true });
        return !!r.supported;
    } catch {
        return false;
    }
}

export const BRIDGE_JAR_PATH = "/data/local/tmp/annex-bridge.jar";

export async function ensureBridgeJar(dev: AndroidDevice) {
    const size = await dev.statSize(BRIDGE_JAR_PATH);
    if (size === BRIDGE_JAR.length) return;
    await dev.push(BRIDGE_JAR_PATH, BRIDGE_JAR, { permission: 0o644 });
}

export async function ensureServer(dev: AndroidDevice) {
    const size = await dev.statSize(SERVER_PATH);
    if (size === SCRCPY_SERVER.length) return;
    await dev.push(SERVER_PATH, SCRCPY_SERVER, { permission: 0o644 });
}

export interface AppEntry {
    name: string;
    pkg: string;
    system: boolean;
    /** launcher activity (component class), when known */
    activity?: string;
    /** PNG data URL of the real launcher icon, when known */
    icon?: string;
}

/**
 * Lists what the phone's app drawer shows: launcher activities with their real, localised labels and
 * icons (annex.AppList inside the Annex jar). Falls back to scrcpy's list_apps if that fails.
 */
export async function listApps(dev: AndroidDevice, log?: (s: string) => void): Promise<AppEntry[]> {
    try {
        await ensureBridgeJar(dev);
        const out = await dev.sh(`CLASSPATH=${BRIDGE_JAR_PATH} app_process / annex.AppList 64 2>&1`);
        const apps = parseAnnexAppList(out);
        if (apps.length) return apps;
        log?.("[annex] app list helper returned nothing: " + out.slice(0, 300));
    } catch (e) {
        log?.("[annex] app list helper failed: " + (e as Error).message);
    }
    await ensureServer(dev);
    const out = await dev.sh(`CLASSPATH=${SERVER_PATH} app_process / com.genymobile.scrcpy.Server ${SCRCPY_VERSION} list_apps=true log_level=info 2>&1`);
    return parseScrcpyAppList(out);
}

export function parseAnnexAppList(out: string): AppEntry[] {
    const apps: AppEntry[] = [];
    for (const line of out.split("\n")) {
        const f = line.replace(/\r$/, "").split("\t");
        if (f[0] !== "APP" || f.length < 6 || !f[1]) continue;
        apps.push({ pkg: f[1], activity: f[2] || undefined, system: f[3] === "1", name: f[4] || f[1], icon: f[5] ? "data:image/png;base64," + f[5] : undefined });
    }
    apps.sort((a, b) => a.name.localeCompare(b.name));
    return apps;
}

/** scrcpy prints "    - Name<padding> package"; names ≥ 30 chars put the package on the next line. */
export function parseScrcpyAppList(out: string): AppEntry[] {
    const apps: AppEntry[] = [];
    const lines = out.split("\n").map((l) => l.replace(/\r$/, ""));
    for (let i = 0; i < lines.length; i++) {
        const m = /^\s*([*-]) (.*)$/.exec(lines[i]);
        if (!m) continue;
        const rest = m[2].trimEnd();
        let name: string, pkg: string | undefined;
        const same = /^(.*\S)\s+([A-Za-z][\w]*(?:\.[\w]+)+)$/.exec(rest);
        if (same) {
            name = same[1];
            pkg = same[2];
        } else {
            name = rest;
            const next = /^\s+([A-Za-z][\w]*(?:\.[\w]+)+)\s*$/.exec(lines[i + 1] ?? "");
            if (next) {
                pkg = next[1];
                i++;
            }
        }
        if (pkg) apps.push({ system: m[1] === "*", name: name.trim(), pkg });
    }
    apps.sort((a, b) => a.name.localeCompare(b.name));
    return apps;
}

export class MirrorSession {
    readonly dev: AndroidDevice;
    readonly canvas: HTMLCanvasElement;
    client?: AdbScrcpyClient<AdbScrcpyOptions3_3<true>>;
    controller?: ScrcpyControlMessageWriter;
    decoder?: WebCodecsVideoDecoder;
    audio?: AudioPlayer;
    width = 0;
    height = 0;
    codec = "";
    #bytes = 0;
    #packets = 0;
    #lastStat = { t: performance.now(), frames: 0, bytes: 0, skipped: 0, packets: 0 };
    pacer?: PacedRenderer;
    #stopped = false;
    #screenOff = false;
    readonly startedAt = Date.now();
    /** MediaCodec options for the phone encoder (scrcpy `video_codec_options`); "" disables them. */
    codecOptions = "";

    constructor(dev: AndroidDevice, canvas: HTMLCanvasElement) {
        this.dev = dev;
        this.canvas = canvas;
    }

    get running() {
        return !this.#stopped && !!this.client;
    }

    get screenOff() {
        return this.#screenOff;
    }

    /** "output" (default, whole device mix) or "playback" (Android 13+ fallback). */
    audioSourceUsed = "output";
    audioProblem?: string;

    async start(s: Settings, ev: SessionEvents, allowCodecOptions = true, audioPlayback = false) {
        const dev = this.dev;
        if (allowCodecOptions && s.videoSource === "display") {
            const o: string[] = [];
            // MediaFormat.BITRATE_MODE_CBR = 2
            if (s.cbr) o.push("bitrate-mode:int=2");
            // Re-emit the last frame every frame interval while the screen is static.
            if (s.constantFps) o.push(`repeat-previous-frame-after:long=${Math.round(1_000_000 / Math.max(1, s.maxFps))}`);
            this.codecOptions = o.join(",");
        }
        await ensureServer(dev);

        let codec = s.videoCodec;
        if (codec !== "h264" && !(await probeCodec(codec))) {
            ev.onLog(`[annex] ${codec} decoding is not supported by this browser — falling back to H.264`);
            codec = "h264";
        }
        const audioCodec = s.audioCodec === "auto" ? (dev.kind === "usb" ? "raw" : "opus") : s.audioCodec;
        const init: AdbScrcpyOptions3_3.Init<true> = {
            video: true,
            videoSource: s.videoSource,
            videoCodec: codec,
            videoBitRate: Math.round(s.bitrateMbps * 1_000_000),
            videoCodecOptions: this.codecOptions || undefined,
            maxFps: s.maxFps,
            maxSize: s.maxSize,
            audio: s.audio,
            audioCodec,
            audioDup: s.audio && s.audioDup && dev.info.sdk >= 33,
            // scrcpy only supports camera mirroring without input control
            control: s.videoSource !== "camera",
            clipboardAutosync: s.clipboardSync,
            showTouches: s.showTouches,
            stayAwake: s.stayAwake && dev.kind === "usb",
            powerOffOnClose: s.powerOffOnClose,
            powerOn: true,
            tunnelForward: true,
            logLevel: "info",
            scid: new ScrcpyInstanceId((Math.random() * 0x7fffffff) | 0),
        };
        if (init.audioDup || audioPlayback) init.audioSource = "playback"; // --audio-dup requires the playback source
        if (s.videoSource === "camera") {
            init.cameraFacing = s.cameraFacing;
            init.audioSource = "mic";
        } else if (s.virtualDisplay) {
            init.newDisplay = `${s.virtualWidth}x${s.virtualHeight}/${s.virtualDpi}`;
            init.vdSystemDecorations = true;
        }
        this.audioSourceUsed = init.audioSource ?? "output";
        const options = new AdbScrcpyOptions3_3<true>(init, { version: SCRCPY_VERSION });

        const client = await AdbScrcpyClient.start(dev.adb, SERVER_PATH, options);
        this.client = client;
        this.controller = client.controller;

        void client.output
            .pipeTo(new WritableStream<string>({ write: (line) => ev.onLog(line) }))
            .catch(() => {});
        void client.exited.then(() => {
            if (!this.#stopped) {
                this.#stopped = true;
                ev.onExit("The mirroring server on the phone stopped.");
            }
        });

        // --- video
        const video = await client.videoStream;
        this.codec = codec;
        let renderer;
        try {
            renderer = WebGLVideoFrameRenderer.isSupported ? new WebGLVideoFrameRenderer(this.canvas) : new BitmapVideoFrameRenderer(this.canvas);
        } catch {
            renderer = new BitmapVideoFrameRenderer(this.canvas);
        }
        const pacer = new PacedRenderer(renderer, s.frameDelivery);
        this.pacer = pacer;
        const decoder = new WebCodecsVideoDecoder({ codec: video.metadata.codec ?? ScrcpyVideoCodecId.H264, renderer: pacer });
        this.decoder = decoder;
        decoder.sizeChanged(({ width, height }) => {
            this.width = width;
            this.height = height;
            ev.onSize(width, height);
        });
        if (video.width && video.height) {
            this.width = video.width;
            this.height = video.height;
            ev.onSize(video.width, video.height);
        }
        void video.stream
            .pipeThrough(
                new TransformStream<ScrcpyMediaStreamPacket, ScrcpyMediaStreamPacket>({
                    transform: (chunk, controller) => {
                        this.#bytes += chunk.data.byteLength;
                        if (chunk.type === "data") this.#packets++;
                        controller.enqueue(chunk);
                    },
                }),
            )
            .pipeTo(decoder.writable)
            .catch((e) => {
                if (!this.#stopped) ev.onLog(`[annex] video stream ended: ${(e as Error)?.message ?? e}`);
            });

        // --- audio
        const audioMeta = client.audioStream ? await client.audioStream : undefined;
        if (audioMeta) {
            if (audioMeta.type === "success") {
                const player = new AudioPlayer();
                player.volume = s.volume;
                this.audio = player;
                void player.play(audioMeta.codec, audioMeta.stream).catch((e) => {
                    if (!this.#stopped) ev.onLog(`[annex] audio ended: ${(e as Error)?.message ?? e}`);
                });
            } else {
                this.audioProblem =
                    audioMeta.type === "disabled"
                        ? "Audio forwarding needs Android 11 or newer on the phone."
                        : "The phone refused to capture audio.";
                ev.onLog("[annex] " + this.audioProblem);
            }
        }

        // --- device messages
        const clip = client.clipboard;
        if (clip) {
            void clip
                .pipeTo(new WritableStream<string>({ write: (t) => ev.onClipboard(t) }))
                .catch(() => {});
        }
        const uhidOut = options.uHidOutput;
        if (uhidOut) void uhidOut.pipeTo(new WritableStream({ write: () => {} })).catch(() => {});

        if (s.screenOffOnStart && s.videoSource === "display" && !s.virtualDisplay) {
            setTimeout(() => void this.setScreenPower(false), 400);
        }
    }

    async setScreenPower(on: boolean) {
        if (!this.controller) return;
        await this.controller.setScreenPowerMode(on ? AndroidScreenPowerMode.Normal : AndroidScreenPowerMode.Off);
        this.#screenOff = !on;
    }

    stats(): SessionStats {
        const now = performance.now();
        const p = this.pacer;
        const frames = p?.presented ?? 0;
        const skipped = (p?.dropped ?? 0) + (this.decoder?.framesSkipped ?? 0) + (p && p.mode === "latency" ? Math.max(0, p.decoded - p.presented) : 0);
        const dt = Math.max(1, now - this.#lastStat.t) / 1000;
        const r: SessionStats = {
            inFps: (this.#packets - this.#lastStat.packets) / dt,
            fps: (frames - this.#lastStat.frames) / dt,
            skipped: Math.max(0, skipped - this.#lastStat.skipped),
            kbps: ((this.#bytes - this.#lastStat.bytes) * 8) / 1000 / dt,
            width: this.width,
            height: this.height,
            codec: this.codec.toUpperCase(),
            audio: this.audio ? `${this.audio.codecName} · ${this.audio.state}` : this.audioProblem ? "failed" : "off",
        };
        this.#lastStat = { t: now, frames, bytes: this.#bytes, skipped, packets: this.#packets };
        return r;
    }

    async snapshot(): Promise<Blob | undefined> {
        return this.decoder?.snapshot();
    }

    async stop() {
        if (this.#stopped && !this.client) return;
        this.#stopped = true;
        try {
            if (this.#screenOff) await this.setScreenPower(true).catch(() => {});
            this.controller?.releaseLock();
        } catch {
            /* ignore */
        }
        await this.client?.close().catch(() => {});
        this.client = undefined;
        this.decoder?.dispose();
        this.pacer?.dispose();
        await this.audio?.stop();
    }
}
