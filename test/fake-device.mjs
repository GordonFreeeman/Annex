// Fake Android device for end-to-end tests.
// - ADB daemon protocol over TCP (and over a raw WebSocket relay used by the WebUSB mock)
// - exec:/shell:/shell,v2 services run through /bin/sh with Android paths remapped to a sandbox
// - sync: v1 (STAT/LIST/SEND/RECV/QUIT)
// - a fake scrcpy 3.3 server: H.264 video (portrait/landscape, rotate), raw/opus audio, control parsing
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const BRIDGE_JAR = path.join(HERE, "../bridge/prebuilt/roundtrip.jar");
let tcpPort = 5555;
const A = { CNXN: 0x4e584e43, AUTH: 0x48545541, OPEN: 0x4e45504f, OKAY: 0x59414b4f, CLSE: 0x45534c43, WRTE: 0x45545257 };
const MAXDATA = 256 * 1024;
const FEATURES = "shell_v2,cmd";

export const events = [];
function ev(type, data) {
    const e = { t: Date.now(), type, ...data };
    events.push(e);
    if (process.env.FAKE_VERBOSE) console.log("[fake]", JSON.stringify(e).slice(0, 300));
}

// ------------------------------------------------------------------ sandbox
const ROOT = fs.mkdtempSync("/tmp/fake-android-");
for (const d of ["sdcard/Download", "sdcard/DCIM/Camera", "sdcard/Pictures", "sdcard/Documents", "data/local/tmp", "bin"]) fs.mkdirSync(path.join(ROOT, d), { recursive: true });
fs.writeFileSync(path.join(ROOT, "sdcard/Download/readme.txt"), "hello from the fake phone\n");
fs.writeFileSync(path.join(ROOT, "sdcard/DCIM/Camera/IMG_0001.jpg"), crypto.randomBytes(150000));
const BIN = path.join(ROOT, "bin");
// the container's own LAN address stands in for the phone's Wi-Fi IP (bridge binds 0.0.0.0)
const LAN_IP = (await import("node:os")).networkInterfaces() && Object.values((await import("node:os")).networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal)?.address || "127.0.0.1";
const script = (name, body) => { fs.writeFileSync(path.join(BIN, name), "#!/bin/sh\n" + body + "\n"); fs.chmodSync(path.join(BIN, name), 0o755); };
script("getprop", `case "$1" in
ro.product.model) echo "Pixel 9 Pro";; ro.product.manufacturer) echo Google;; ro.build.version.release) echo 15;;
ro.build.version.sdk) echo 35;; ro.product.device) echo caiman;; ro.serialno) echo FAKE123;; *) echo "";; esac`);
script("ip", `echo "1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever"; echo "12: rmnet_data0    inet 10.21.3.4/30 scope global rmnet_data0"; echo "34: wlan0    inet ${LAN_IP}/24 brd 192.168.1.255 scope global wlan0\\       valid_lft forever"`);
script("dumpsys", `if [ "$1" = battery ]; then printf "Current Battery Service state:\\n  AC powered: false\\n  USB powered: true\\n  status: 2\\n  level: 87\\n  temperature: 301\\n"; fi`);
script("wm", `if [ "$1" = size ]; then echo "Physical size: 1440x3200"; fi; if [ "$1" = density ]; then echo "Physical density: 560"; fi`);
script("pm", `if [ "$1" = install ]; then echo Success; else echo "package:com.example.app"; fi`);
script("pkill", `exit 0`);
script("input", `exit 0`);
script("settings", `if [ "$1" = get ] && [ "$3" = accelerometer_rotation ]; then echo 1; elif [ "$1" = get ]; then echo 0; fi`);
script("cmd", `echo ""`);
const remap = (cmd) => cmd
    .replace(/\/storage\/emulated\/0/g, ROOT + "/sdcard")
    .replace(/(^|[\s'"=:])\/sdcard/g, `$1${ROOT}/sdcard`)
    .replace(/(^|[\s'"=:])\/data\/local\/tmp/g, `$1${ROOT}/data/local/tmp`);
const mapPath = (p) => {
    if (p.startsWith("/storage/emulated/0")) p = "/sdcard" + p.slice("/storage/emulated/0".length);
    if (p === "/sdcard" || p.startsWith("/sdcard/")) return ROOT + p;
    if (p.startsWith("/data/local/tmp")) return ROOT + p;
    if (p === "/") return ROOT;
    return ROOT + "/" + p.replace(/^\/+/, "");
};
export const sandboxRoot = ROOT;

// ------------------------------------------------------------------ media
function splitH264(buf) {
    const nals = [];
    let i = 0, start = -1;
    while (i < buf.length - 3) {
        if (buf[i] === 0 && buf[i + 1] === 0 && (buf[i + 2] === 1 || (buf[i + 2] === 0 && buf[i + 3] === 1))) {
            if (start >= 0) nals.push(buf.subarray(start, i));
            start = i;
            i += buf[i + 2] === 1 ? 3 : 4;
        } else i++;
    }
    if (start >= 0) nals.push(buf.subarray(start));
    const nalType = (n) => n[n[2] === 1 ? 3 : 4] & 0x1f;
    let config = [], frames = [], cur = null;
    for (const n of nals) {
        const t = nalType(n);
        if (t === 9) { if (cur && cur.parts.length) frames.push(cur); cur = { parts: [], key: false }; continue; }
        if (t === 7 || t === 8) { if (frames.length === 0) config.push(n); continue; }
        if (t === 6) continue;
        if (!cur) cur = { parts: [], key: false };
        if (t === 5) cur.key = true;
        cur.parts.push(n);
    }
    if (cur && cur.parts.length) frames.push(cur);
    return { config: Buffer.concat(config), frames: frames.map((f) => ({ key: f.key, data: Buffer.concat(f.parts) })) };
}
const VIDEO = {
    portrait: { w: process.env.SMALL ? 360 : 720, h: process.env.SMALL ? 800 : 1600, ...splitH264(fs.readFileSync(path.join(HERE, `media/portrait${process.env.SMALL ? "-s" : ""}.h264`))) },
    landscape: { w: process.env.SMALL ? 800 : 1600, h: process.env.SMALL ? 360 : 720, ...splitH264(fs.readFileSync(path.join(HERE, `media/landscape${process.env.SMALL ? "-s" : ""}.h264`))) },
};
function oggPackets(buf) {
    const packets = [];
    let off = 0, partial = [];
    while (off + 27 <= buf.length && buf.toString("ascii", off, off + 4) === "OggS") {
        const nseg = buf[off + 26];
        const lacing = buf.subarray(off + 27, off + 27 + nseg);
        let p = off + 27 + nseg;
        for (const l of lacing) {
            partial.push(buf.subarray(p, p + l));
            p += l;
            if (l < 255) { packets.push(Buffer.concat(partial)); partial = []; }
        }
        off = p;
    }
    return packets;
}
const OPUS = oggPackets(fs.readFileSync(path.join(HERE, "media/tone.ogg")));
const OPUS_HEAD = OPUS[0];
const OPUS_DATA = OPUS.slice(2); // skip OpusHead, OpusTags
const RAW = fs.readFileSync(path.join(HERE, "media/tone.raw"));

// ------------------------------------------------------------------ device state
export const device = {
    clipboard: "",
    scrcpy: null, // running fake server
    serverPushed: false,
    bridge: null,
};

function be32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; }
function mediaHeader(config, key, pts, len) {
    const b = Buffer.alloc(12);
    let v = BigInt(pts);
    if (config) v = 1n << 63n;
    else if (key) v |= 1n << 62n;
    b.writeBigUInt64BE(v, 0);
    b.writeUInt32BE(len, 8);
    return b;
}

class FakeScrcpy {
    constructor(args, out) {
        this.opts = {};
        for (const a of args) { const m = /^([a-z_]+)=(.*)$/.exec(a); if (m) this.opts[m[1]] = m[2]; }
        this.out = out;
        this.video = this.opts.video !== "false";
        this.audio = this.opts.audio !== "false";
        this.control = this.opts.control !== "false";
        this.socketName = "scrcpy" + (this.opts.scid ? "_" + this.opts.scid.padStart(8, "0") : "");
        this.pending = [];
        if (this.video) this.pending.push("video");
        if (this.audio) this.pending.push("audio");
        if (this.control) this.pending.push("control");
        this.first = true;
        this.orientation = "portrait";
        this.timers = [];
        this.closed = false;
        ev("scrcpy-start", { opts: this.opts });
        out(`[server] INFO: Device: [Google] Pixel 9 Pro (Android 15)\n`);
    }
    accept(stream) {
        const kind = this.pending.shift();
        if (!kind) return false;
        if (this.first && this.opts.send_dummy_byte !== "false") stream.write(Buffer.from([0]));
        if (this.first && this.opts.send_device_meta !== "false") {
            const name = Buffer.alloc(64);
            name.write("Pixel 9 Pro");
            stream.write(name);
        }
        this.first = false;
        ev("scrcpy-socket", { kind });
        if (kind === "video") this.startVideo(stream);
        if (kind === "audio") this.startAudio(stream);
        if (kind === "control") this.startControl(stream);
        stream.onClose = () => this.stop();
        return true;
    }
    startVideo(s) {
        this.videoStream = s;
        if (device.rejectCodecOptions && this.opts.video_codec_options) return;
        const v = VIDEO[this.orientation];
        s.write(Buffer.concat([Buffer.from("h264", "ascii"), be32(v.w), be32(v.h)]));
        this.restartVideo();
    }
    restartVideo() {
        const s = this.videoStream;
        if (!s || this.closed) return;
        clearInterval(this.vtimer);
        const v = VIDEO[this.orientation];
        s.write(Buffer.concat([mediaHeader(true, false, 0, v.config.length), v.config]));
        let i = 0, pts = 0;
        const fps = Math.min(60, Number(this.opts.max_fps) || 60);
        this.vtimer = setInterval(() => {
            if (this.closed) return;
            if (s.queued() > 40) return; // simulate encoder skipping when the link is congested
            const f = v.frames[i % v.frames.length];
            s.write(Buffer.concat([mediaHeader(false, f.key, pts, f.data.length), f.data]));
            i++;
            pts += Math.round(1e6 / fps);
        }, 1000 / fps);
    }
    startAudio(s) {
        const codec = this.opts.audio_codec || "opus";
        if (device.silentAudio && this.opts.audio_source !== "playback") { s.write(Buffer.from([0x00, 0x72, 0x61, 0x77])); return; }
        if (codec === "raw") {
            s.write(Buffer.from([0x00, 0x72, 0x61, 0x77]));
            let off = 0, pts = 0;
            this.atimer = setInterval(() => {
                if (this.closed) return;
                const n = 960 * 4;
                if (off + n > RAW.length) off = 0;
                const d = RAW.subarray(off, off + n);
                off += n;
                s.write(Buffer.concat([mediaHeader(false, false, pts, d.length), d]));
                pts += 20000;
            }, 20);
        } else {
            s.write(Buffer.from("opus", "ascii"));
            s.write(Buffer.concat([mediaHeader(true, false, 0, OPUS_HEAD.length), OPUS_HEAD]));
            let i = 0, pts = 0;
            this.atimer = setInterval(() => {
                if (this.closed) return;
                const d = OPUS_DATA[i++ % OPUS_DATA.length];
                s.write(Buffer.concat([mediaHeader(false, false, pts, d.length), d]));
                pts += 20000;
            }, 20);
        }
    }
    startControl(s) {
        this.controlStream = s;
        let buf = Buffer.alloc(0);
        s.onData = (d) => {
            buf = Buffer.concat([buf, d]);
            for (;;) {
                const r = this.parseControl(buf);
                if (!r) break;
                buf = buf.subarray(r);
            }
        };
    }
    sendDevice(b) { this.controlStream?.write(b); }
    parseControl(b) {
        if (b.length < 1) return 0;
        const t = b[0];
        const need = (n) => (b.length >= n ? n : 0);
        switch (t) {
            case 0: { if (!need(14)) return 0; ev("key", { action: b[1], keyCode: b.readUInt32BE(2), repeat: b.readUInt32BE(6), meta: b.readUInt32BE(10) }); return 14; }
            case 1: { if (!need(5)) return 0; const l = b.readUInt32BE(1); if (!need(5 + l)) return 0; const text = b.toString("utf8", 5, 5 + l); ev("text", { text });
                if (text === "annex-clip-test") this.sendDevice(Buffer.concat([Buffer.from([0]), be32(Buffer.byteLength("Hello from phone")), Buffer.from("Hello from phone")]));
                return 5 + l; }
            case 2: { if (!need(32)) return 0; ev("touch", { action: b[1], pointerId: b.readBigInt64BE(2).toString(), x: b.readUInt32BE(10), y: b.readUInt32BE(14), w: b.readUInt16BE(18), h: b.readUInt16BE(20), pressure: b.readUInt16BE(22), actionButton: b.readUInt32BE(24), buttons: b.readUInt32BE(28) }); return 32; }
            case 3: { if (!need(21)) return 0; ev("scroll", { x: b.readUInt32BE(1), y: b.readUInt32BE(5), w: b.readUInt16BE(9), h: b.readUInt16BE(11), hs: b.readInt16BE(13), vs: b.readInt16BE(15), buttons: b.readUInt32BE(17) }); return 21; }
            case 4: { if (!need(2)) return 0; ev("back-or-screen-on", { action: b[1] }); return 2; }
            case 5: case 6: case 7: case 11: case 15: case 17: {
                const names = { 5: "expand-notifications", 6: "expand-settings", 7: "collapse-panels", 11: "rotate", 15: "hard-keyboard-settings", 17: "reset-video" };
                ev(names[t], {});
                if (t === 11) { this.orientation = this.orientation === "portrait" ? "landscape" : "portrait"; this.restartVideo(); }
                if (t === 17) this.restartVideo();
                return 1; }
            case 8: { if (!need(2)) return 0; ev("get-clipboard", { copyKey: b[1] });
                this.sendDevice(Buffer.concat([Buffer.from([0]), be32(Buffer.byteLength(device.clipboard)), Buffer.from(device.clipboard)])); return 2; }
            case 9: { if (!need(14)) return 0; const seq = b.readBigUInt64BE(1); const paste = b[9]; const l = b.readUInt32BE(10); if (!need(14 + l)) return 0;
                device.clipboard = b.toString("utf8", 14, 14 + l); ev("set-clipboard", { seq: seq.toString(), paste, text: device.clipboard });
                if (seq !== 0n) { const a = Buffer.alloc(9); a[0] = 1; a.writeBigUInt64BE(seq, 1); this.sendDevice(a); }
                return 14 + l; }
            case 10: { if (!need(2)) return 0; ev("display-power", { on: b[1] }); return 2; }
            case 12: { if (!need(8)) return 0; const id = b.readUInt16BE(1); const vid = b.readUInt16BE(3); const pid = b.readUInt16BE(5); const nl = b[7]; if (!need(8 + nl + 2)) return 0;
                const name = b.toString("utf8", 8, 8 + nl); const dl = b.readUInt16BE(8 + nl); if (!need(10 + nl + dl)) return 0;
                ev("uhid-create", { id, vid, pid, name, descLen: dl }); return 10 + nl + dl; }
            case 13: { if (!need(5)) return 0; const id = b.readUInt16BE(1); const l = b.readUInt16BE(3); if (!need(5 + l)) return 0; ev("uhid-input", { id, data: [...b.subarray(5, 5 + l)] }); return 5 + l; }
            case 14: { if (!need(3)) return 0; ev("uhid-destroy", { id: b.readUInt16BE(1) }); return 3; }
            case 16: { if (!need(2)) return 0; const l = b[1]; if (!need(2 + l)) return 0; ev("start-app", { name: b.toString("utf8", 2, 2 + l) }); return 2 + l; }
            default:
                ev("unknown-control", { type: t, bytes: [...b.subarray(0, 16)] });
                return b.length; // desync: drop everything
        }
    }
    stop() {
        if (this.closed) return;
        this.closed = true;
        clearInterval(this.vtimer);
        clearInterval(this.atimer);
        ev("scrcpy-stop", {});
        if (device.scrcpy === this) device.scrcpy = null;
        this.onExit?.();
    }
}

// ------------------------------------------------------------------ ADB connection
function packet(cmd, a0, a1, data = Buffer.alloc(0)) {
    const h = Buffer.alloc(24);
    h.writeUInt32LE(cmd, 0);
    h.writeUInt32LE(a0 >>> 0, 4);
    h.writeUInt32LE(a1 >>> 0, 8);
    h.writeUInt32LE(data.length, 12);
    let sum = 0;
    for (const x of data) sum += x;
    h.writeUInt32LE(sum >>> 0, 16);
    h.writeUInt32LE((cmd ^ 0xffffffff) >>> 0, 20);
    return Buffer.concat([h, data]);
}

class AdbStream {
    constructor(conn, localId, remoteId) {
        this.conn = conn; this.localId = localId; this.remoteId = remoteId;
        this.queue = []; this.inflight = false; this.closed = false;
        this.onData = () => {}; this.onClose = () => {};
    }
    queued() { return this.queue.length; }
    write(buf) {
        if (this.closed) return;
        for (let o = 0; o < buf.length; o += this.conn.maxdata) this.queue.push(Buffer.from(buf.subarray(o, o + this.conn.maxdata)));
        this.pump();
    }
    pump() {
        if (this.inflight || this.closed || !this.queue.length) {
            if (!this.inflight && this.endAfterFlush && !this.queue.length) this.close();
            return;
        }
        this.inflight = true;
        this.conn.send(packet(A.WRTE, this.localId, this.remoteId, this.queue.shift()));
    }
    ack() { this.inflight = false; this.pump(); }
    end() { this.endAfterFlush = true; this.pump(); }
    close(fromRemote = false) {
        if (this.closed) return;
        this.closed = true;
        this.conn.streams.delete(this.localId);
        this.conn.send(packet(A.CLSE, fromRemote ? 0 : this.localId, this.remoteId));
        this.onClose();
    }
}

class AdbConnection {
    constructor(sendRaw, label) {
        this.sendRaw = sendRaw; this.label = label;
        this.buf = Buffer.alloc(0); this.streams = new Map(); this.nextId = 1; this.maxdata = 4096; this.online = false;
    }
    send(b) { this.sendRaw(b); }
    feed(d) {
        this.buf = Buffer.concat([this.buf, d]);
        while (this.buf.length >= 24) {
            const len = this.buf.readUInt32LE(12);
            if (this.buf.length < 24 + len) break;
            const cmd = this.buf.readUInt32LE(0), a0 = this.buf.readUInt32LE(4), a1 = this.buf.readUInt32LE(8);
            const data = Buffer.from(this.buf.subarray(24, 24 + len));
            this.buf = this.buf.subarray(24 + len);
            this.handle(cmd, a0, a1, data);
        }
    }
    handle(cmd, a0, a1, data) {
        switch (cmd) {
            case A.CNXN:
                this.maxdata = Math.min(a1, MAXDATA);
                ev("cnxn", { label: this.label, banner: data.toString().slice(0, 200) });
                this.send(packet(A.AUTH, 1, 0, crypto.randomBytes(20)));
                break;
            case A.AUTH:
                ev("auth", { type: a0 });
                this.online = true;
                this.send(packet(A.CNXN, 0x01000001, MAXDATA, Buffer.from(`device::ro.product.name=caiman;ro.product.model=Pixel 9 Pro;ro.product.device=caiman;features=${FEATURES}`)));
                break;
            case A.OPEN: {
                const service = data.toString().replace(/\0$/, "");
                const id = this.nextId++;
                const s = new AdbStream(this, id, a0);
                if (!this.openService(service, s)) {
                    this.send(packet(A.CLSE, 0, a0));
                    return;
                }
                this.streams.set(id, s);
                this.send(packet(A.OKAY, id, a0));
                s.ready?.();
                break;
            }
            case A.OKAY: { const s = this.streams.get(a1); if (s) { s.remoteId = a0; s.ack(); } break; }
            case A.WRTE: { const s = this.streams.get(a1); if (s) { this.send(packet(A.OKAY, a1, a0)); s.onData(data); } break; }
            case A.CLSE: { const s = this.streams.get(a1); if (s) s.close(true); break; }
        }
    }
    openService(service, s) {
        ev("open", { service: service.slice(0, 300) });
        let m;
        if ((m = /^(exec|shell(?:,v2)?(?:,raw|,pty)?):(.*)$/s.exec(service))) {
            const v2 = m[1].includes("v2");
            const cmd = m[2];
            s.ready = () => runCommand(cmd, s, v2);
            return true;
        }
        if (service === "sync:") { s.ready = () => syncService(s); return true; }
        if ((m = /^localabstract:(scrcpy.*)$/.exec(service))) {
            const srv = device.scrcpy;
            if (!srv || srv.closed || srv.socketName !== m[1] || !srv.pending.length) return false;
            s.ready = () => srv.accept(s);
            return true;
        }
        if (/^tcpip:/.test(service)) { s.ready = () => { s.write(Buffer.from("restarting in TCP mode port: 5555\n")); s.end(); }; return true; }
        if (service === "usb:") { s.ready = () => { s.write(Buffer.from("restarting in USB mode\n")); s.end(); }; return true; }
        if (/^reverse:/.test(service)) { s.ready = () => { s.write(Buffer.from("FAILreverse not supported in fake")); s.end(); }; return true; }
        return false;
    }
}

// ------------------------------------------------------------------ shell
function shellV2Frame(id, data) { const h = Buffer.alloc(5); h[0] = id; h.writeUInt32LE(data.length, 1); return Buffer.concat([h, data]); }

function runCommand(command, s, v2) {
    const out = (d, id = 1) => s.write(v2 ? shellV2Frame(id, Buffer.from(d)) : Buffer.from(d));
    const exit = (code) => { if (v2) s.write(shellV2Frame(3, Buffer.from([code]))); s.end(); };
    ev("shell", { command: command.slice(0, 400), v2 });

    if (command.includes("com.genymobile.scrcpy.Server")) {
        const args = command.split(/\s+/);
        const idx = args.indexOf("com.genymobile.scrcpy.Server");
        const version = args[idx + 1];
        const rest = args.slice(idx + 2);
        if (version !== "3.3") { out(`[server] ERROR: The server version (3.3) does not match the client (${version})\n`); exit(1); return; }
        if (rest.includes("list_apps=true")) {
            out("[server] INFO: List of apps:\n    * Chrome                         com.android.chrome\n    * Settings                       com.android.settings\n    - Spotify                        com.spotify.music\n    - Firefox Nightly                org.mozilla.fenix\n    - Microsoft Authenticator: Passwords\n                                   com.azure.authenticator\n");
            exit(0);
            return;
        }
        if (rest.includes("list_encoders=true") || rest.includes("list_displays=true")) { out("[server] INFO: (fake)\n"); exit(0); return; }
        if (!fs.existsSync(mapPath(command.match(/CLASSPATH=(\S+)/)?.[1] ?? "/nonexistent"))) { out("Error: Could not find class\n"); exit(1); return; }
        device.scrcpy?.stop();
        const srv = new FakeScrcpy(rest, (t) => out(t));
        srv.onExit = () => exit(0);
        s.onClose = () => srv.stop();
        device.scrcpy = srv;
        if (device.rejectCodecOptions && srv.opts.video_codec_options) {
            out("[server] ERROR: Encoding error: android.media.MediaCodec$CodecException: Error 0xfffffff4\n");
            setTimeout(() => srv.stop(), 300);
        }
        return;
    }
    if (command.includes("annex.AppList")) {
        if (device.appListFails) { out("java.lang.ClassNotFoundException: annex.AppList\n"); exit(1); return; }
        const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
        out(["APP\tcom.android.chrome\tcom.google.android.apps.chrome.Main\t1\tChrome\t" + png,
             "APP\tcom.android.settings\tcom.android.settings.Settings\t1\tEinstellungen\t" + png,
             "APP\tcom.spotify.music\tcom.spotify.music.MainActivity\t0\tSpotify\t" + png,
             "APP\tcom.google.android.googlequicksearchbox\tcom.google.android.googlequicksearchbox.SearchActivity\t1\tGoogle\t" + png,
             "APP\tcom.google.android.googlequicksearchbox\tcom.google.android.apps.gsa.binaries.velvet.VoiceActivity\t1\tSprachsuche\t",
             "END\t5"].join("\n") + "\n");
        exit(0);
        return;
    }
    if (command.includes("annex.AnnexBridge")) {
        // Run the REAL bridge (dex round-tripped to JVM bytecode) against this fake adbd.
        const m = /annex\.AnnexBridge\s+(\d+)\s+(\S+)\s+(\d+)\s+(\S+)/.exec(command);
        const log = command.match(/>\s*(\S+annex-bridge\.log)/)?.[1];
        device.bridge?.kill();
        const out = log ? fs.openSync(mapPath(log), "w") : "ignore";
        device.bridge = spawn("java", ["-cp", BRIDGE_JAR, "annex.AnnexBridge", m[1], mapPath(m[2]), String(tcpPort), mapPath(m[4])], { stdio: ["ignore", out, out] });
        ev("bridge-start", { port: m[1], keyMode: (fs.statSync(mapPath(m[2])).mode & 0o777).toString(8) });
        exit(0);
        return;
    }
    const rot = /user-rotation lock (\d)/.exec(command);
    if (rot && device.scrcpy) {
        const o = rot[1] === "1" || rot[1] === "3" ? "landscape" : "portrait";
        ev("user-rotation", { rotation: Number(rot[1]) });
        if (device.scrcpy.orientation !== o) { device.scrcpy.orientation = o; device.scrcpy.restartVideo(); }
    }
    if (/accelerometer_rotation 1/.test(command)) ev("rotation-restored", {});
    if (command.includes("annex-bridge.pid")) {
        const delay = /sleep 1/.test(command) ? 1000 : 0;
        setTimeout(() => { device.bridge?.kill(); device.bridge = null; ev("bridge-kill", {}); }, delay);
    }
    const child = spawn("/bin/sh", ["-c", remap(command)], { cwd: ROOT, env: { ...process.env, PATH: BIN + ":" + process.env.PATH } });
    child.stdout.on("data", (d) => out(d, 1));
    child.stderr.on("data", (d) => out(d, v2 ? 2 : 1));
    child.on("close", (code) => exit(code ?? 0));
    s.onData = (d) => {
        if (!v2) { child.stdin.write(d); return; }
        // minimal v2 stdin parsing
        let o = 0;
        while (o + 5 <= d.length) {
            const id = d[o], l = d.readUInt32LE(o + 1);
            const payload = d.subarray(o + 5, o + 5 + l);
            if (id === 0) child.stdin.write(payload);
            if (id === 4) child.stdin.end();
            o += 5 + l;
        }
    };
    s.onClose = () => { try { child.kill(); } catch { /* */ } };
}

// ------------------------------------------------------------------ sync v1
function syncService(s) {
    let buf = Buffer.alloc(0);
    let send = null; // { file, fd, path }
    const reply = (id, ...parts) => s.write(Buffer.concat([Buffer.from(id, "ascii"), ...parts]));
    const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
    const statBuf = (p) => {
        try { const st = fs.lstatSync(p); return Buffer.concat([u32(st.mode), u32(Math.min(st.size, 0xffffffff)), u32(Math.floor(st.mtimeMs / 1000))]); }
        catch { return Buffer.concat([u32(0), u32(0), u32(0)]); }
    };
    s.onData = (d) => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
            if (send) {
                if (buf.length < 8) return;
                const id = buf.toString("ascii", 0, 4), n = buf.readUInt32LE(4);
                if (id === "DATA") {
                    if (buf.length < 8 + n) return;
                    fs.writeSync(send.fd, buf.subarray(8, 8 + n));
                    buf = buf.subarray(8 + n);
                    continue;
                }
                if (id === "DONE") {
                    fs.closeSync(send.fd);
                    fs.chmodSync(send.path, send.mode & 0o777);
                    ev("sync-send", { path: send.devicePath, size: fs.statSync(send.path).size });
                    if (send.devicePath.endsWith(".jar")) device.serverPushed = true;
                    send = null;
                    buf = buf.subarray(8);
                    reply("OKAY", u32(0));
                    continue;
                }
                reply("FAIL", u32(11), Buffer.from("bad packet")); return;
            }
            if (buf.length < 8) return;
            const id = buf.toString("ascii", 0, 4), n = buf.readUInt32LE(4);
            if (buf.length < 8 + n) return;
            const arg = buf.toString("utf8", 8, 8 + n);
            buf = buf.subarray(8 + n);
            ev("sync", { id, arg: arg.slice(0, 200) });
            if (id === "STAT" || id === "LSTA") { reply(id === "LSTA" ? "LSTA" : "STAT", statBuf(mapPath(arg))); }
            else if (id === "LIST") {
                const dir = mapPath(arg);
                let names = [];
                try { names = fs.readdirSync(dir); } catch { /* */ }
                for (const name of [".", "..", ...names]) {
                    const nb = Buffer.from(name);
                    reply("DENT", statBuf(path.join(dir, name)), u32(nb.length), nb);
                }
                reply("DONE", Buffer.alloc(16));
            } else if (id === "SEND") {
                const comma = arg.lastIndexOf(",");
                const devicePath = arg.slice(0, comma), mode = Number(arg.slice(comma + 1));
                const p = mapPath(devicePath);
                fs.mkdirSync(path.dirname(p), { recursive: true });
                send = { path: p, devicePath, mode, fd: fs.openSync(p, "w") };
            } else if (id === "RECV") {
                const p = mapPath(arg);
                let data;
                try { data = fs.readFileSync(p); } catch { reply("FAIL", u32(14), Buffer.from("No such file")); continue; }
                for (let o = 0; o < data.length; o += 64 * 1024) { const c = data.subarray(o, o + 64 * 1024); reply("DATA", u32(c.length), c); }
                reply("DONE", u32(0));
            } else if (id === "QUIT") { s.end(); return; }
            else { reply("FAIL", u32(7), Buffer.from("unsupported")); }
        }
    };
}

// ------------------------------------------------------------------ servers
export function startTcp(port) {
    tcpPort = port;
    return new Promise((r) => {
        const srv = net.createServer((sock) => {
            sock.setNoDelay(true);
            const c = new AdbConnection((b) => sock.write(b), "tcp");
            sock.on("data", (d) => c.feed(d));
            sock.on("error", () => {});
            sock.on("close", () => { for (const s of [...c.streams.values()]) s.close(true); });
        });
        srv.listen(port, "127.0.0.1", () => r(srv));
    });
}

/** Raw (unencrypted) byte relay used by the in-page WebUSB mock. */
export function startUsbRelay(port) {
    const wss = new WebSocketServer({ port, host: "127.0.0.1" });
    wss.on("connection", (ws) => {
        const c = new AdbConnection((b) => ws.send(b), "usb");
        ws.on("message", (d) => c.feed(Buffer.from(d)));
        ws.on("close", () => { for (const s of [...c.streams.values()]) s.close(true); });
    });
    return wss;
}

if (process.argv[1] && process.argv[1].endsWith("fake-device.mjs")) {
    const tcp = Number(process.argv[2] || 15555);
    const usb = Number(process.argv[3] || 15556);
    await startTcp(tcp);
    startUsbRelay(usb);
    console.log(`fake device: adb tcp ${tcp}, usb relay ws ${usb}, root ${ROOT}`);
}

process.on("exit", () => { try { device.bridge?.kill(); } catch { /* */ } });
