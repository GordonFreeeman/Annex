import { Adb, AdbDaemonTransport } from "@yume-chan/adb";
import AdbWebCredentialStore from "@yume-chan/adb-credential-web";
import { AdbDaemonWebUsbDevice, AdbDaemonWebUsbDeviceManager } from "@yume-chan/adb-daemon-webusb";
import { ReadableStream } from "@yume-chan/stream-extra";
import { BRIDGE_JAR } from "./assets";
import { SecureSocket, randomKeyHex } from "./securews";
import { loadWifiDevices, upsertWifiDevice, removeWifiDevice, type WifiDevice } from "./settings";
import { createSecureAdbConnection } from "./wsconn";
import { shQuote } from "./ui";
import { pickLanIp } from "./netutil";

export type LinkKind = "usb" | "wifi";

export interface DeviceInfo {
    manufacturer: string;
    model: string;
    android: string;
    sdk: number;
    battery?: number;
    charging?: boolean;
    ip?: string;
    screen?: string;
}

export const credentialStore = new AdbWebCredentialStore("Annex");
export const usbManager = AdbDaemonWebUsbDeviceManager.BROWSER;

export const BRIDGE_PORT = 27183;
const BRIDGE_DIR = "/data/local/tmp";
const BRIDGE_PATH = `${BRIDGE_DIR}/annex-bridge.jar`;
const BRIDGE_KEY = `${BRIDGE_DIR}/annex-bridge.key`;
const BRIDGE_LOG = `${BRIDGE_DIR}/annex-bridge.log`;
const BRIDGE_PID = `${BRIDGE_DIR}/annex-bridge.pid`;
const KILL_BRIDGE = `kill $(cat ${BRIDGE_PID} 2>/dev/null) 2>/dev/null; pkill -x annex-bridge 2>/dev/null; rm -f ${BRIDGE_PID}`;

export class UserCancelled extends Error {
    constructor() {
        super("Cancelled");
    }
}

export function blobStream(src: Blob | Uint8Array, onProgress?: (done: number, total: number) => void): ReadableStream<Uint8Array> {
    const blob = src instanceof Blob ? src : new Blob([src as BlobPart]);
    const total = blob.size;
    let offset = 0;
    const CHUNK = 256 * 1024;
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            if (offset >= total) {
                controller.close();
                return;
            }
            const end = Math.min(total, offset + CHUNK);
            const buf = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
            offset = end;
            controller.enqueue(buf);
            onProgress?.(offset, total);
        },
    });
}

export class AndroidDevice {
    readonly adb: Adb;
    readonly kind: LinkKind;
    readonly serial: string;
    readonly usb?: AdbDaemonWebUsbDevice;
    readonly wifi?: WifiDevice;
    info: DeviceInfo = { manufacturer: "", model: "Android device", android: "", sdk: 0 };
    #closed = false;

    private constructor(adb: Adb, kind: LinkKind, serial: string, extra: { usb?: AdbDaemonWebUsbDevice; wifi?: WifiDevice }) {
        this.adb = adb;
        this.kind = kind;
        this.serial = serial;
        this.usb = extra.usb;
        this.wifi = extra.wifi;
        void adb.disconnected.then(() => (this.#closed = true));
    }

    get closed() {
        return this.#closed;
    }

    get displayName() {
        return this.info.model || this.serial;
    }

    // ------------------------------------------------------------ connect
    static async requestUsb(): Promise<AdbDaemonWebUsbDevice> {
        if (!usbManager) throw new Error("WebUSB is not available in this browser. Use Chrome, Edge, Brave or Opera on desktop.");
        const dev = await usbManager.requestDevice();
        if (!dev) throw new UserCancelled();
        return dev;
    }

    static async knownUsbDevices(): Promise<AdbDaemonWebUsbDevice[]> {
        if (!usbManager) return [];
        try {
            return await usbManager.getDevices();
        } catch {
            return [];
        }
    }

    static async connectUsb(dev: AdbDaemonWebUsbDevice, onAuthWait?: () => void): Promise<AndroidDevice> {
        let connection;
        try {
            connection = await dev.connect();
        } catch (e) {
            if (e instanceof AdbDaemonWebUsbDevice.DeviceBusyError) {
                throw new Error(
                    "The phone's USB debugging interface is in use by another program — usually an ADB server (Android Studio, scrcpy, platform-tools). Run `adb kill-server` or close that program, then try again.",
                );
            }
            const msg = (e as Error)?.message ?? String(e);
            if (/Access denied|SecurityError/i.test(msg)) {
                throw new Error(
                    "The browser was denied access to the USB device. On Windows another ADB driver/program may hold it; on Linux add a udev rule for your phone (see Help).",
                );
            }
            throw e;
        }
        const authTimer = setTimeout(() => onAuthWait?.(), 600);
        try {
            const transport = await AdbDaemonTransport.authenticate({ serial: dev.serial, connection, credentialStore });
            const d = new AndroidDevice(new Adb(transport), "usb", dev.serial, { usb: dev });
            await d.refreshInfo();
            return d;
        } finally {
            clearTimeout(authTimer);
        }
    }

    static async connectWifi(w: WifiDevice, onAuthWait?: () => void): Promise<AndroidDevice> {
        const host = w.host.includes(":") && !w.host.startsWith("[") ? `[${w.host}]` : w.host;
        const sock = await SecureSocket.connect(`ws://${host}:${w.port}/annex`, w.key);
        const connection = createSecureAdbConnection(sock);
        const authTimer = setTimeout(() => onAuthWait?.(), 1500);
        try {
            const transport = await AdbDaemonTransport.authenticate({ serial: w.serial, connection, credentialStore });
            const d = new AndroidDevice(new Adb(transport), "wifi", w.serial, { wifi: w });
            await d.refreshInfo();
            upsertWifiDevice({ ...w, name: d.displayName, lastUsed: Date.now() });
            return d;
        } catch (e) {
            sock.close();
            throw e;
        } finally {
            clearTimeout(authTimer);
        }
    }

    // ------------------------------------------------------------ helpers
    async sh(command: string): Promise<string> {
        return this.adb.subprocess.noneProtocol.spawnWaitText(command);
    }

    async refreshInfo() {
        const out = await this.sh(
            "getprop ro.product.manufacturer; getprop ro.product.model; getprop ro.build.version.release; getprop ro.build.version.sdk; " +
                "echo @@; ip -4 -o addr show 2>/dev/null; echo @@; dumpsys battery 2>/dev/null | grep -E 'level|powered'; echo @@; wm size 2>/dev/null",
        );
        const [props, ip, battery, wm] = out.split("@@");
        const p = props.split("\n").map((l) => l.trim());
        this.info.manufacturer = p[0] || "";
        this.info.model = p[1] || this.serial;
        this.info.android = p[2] || "";
        this.info.sdk = Number(p[3]) || 0;
        this.info.ip = pickLanIp(ip ?? "");
        const lvl = /level:\s*(\d+)/.exec(battery ?? "");
        this.info.battery = lvl ? Number(lvl[1]) : undefined;
        this.info.charging = /powered:\s*true/.test(battery ?? "");
        const sz = /Override size:\s*(\d+x\d+)/.exec(wm ?? "") ?? /Physical size:\s*(\d+x\d+)/.exec(wm ?? "");
        this.info.screen = sz?.[1];
        return this.info;
    }

    async push(filename: string, data: Blob | Uint8Array, opts: { permission?: number; onProgress?: (done: number, total: number) => void } = {}) {
        const sync = await this.adb.sync();
        try {
            await sync.write({
                filename,
                file: blobStream(data, opts.onProgress),
                permission: opts.permission ?? 0o644,
                mtime: Math.floor(Date.now() / 1000),
            });
        } finally {
            await sync.dispose();
        }
    }

    async statSize(path: string): Promise<number | undefined> {
        const sync = await this.adb.sync();
        try {
            const st = await sync.stat(path);
            return Number(st.size);
        } catch {
            return undefined;
        } finally {
            await sync.dispose();
        }
    }

    async installApk(file: Blob, name: string, onProgress?: (done: number, total: number) => void): Promise<string> {
        const remote = `/data/local/tmp/annex-install-${Date.now()}.apk`;
        await this.push(remote, file, { onProgress });
        try {
            const out = await this.sh(`pm install -r -t ${shQuote(remote)} 2>&1`);
            if (!/Success/.test(out)) throw new Error(out.trim() || `Installing ${name} failed`);
            return out.trim();
        } finally {
            await this.sh(`rm -f ${shQuote(remote)}`).catch(() => {});
        }
    }

    // ------------------------------------------------------------ Wi-Fi mode
    async adbdTcpPort(): Promise<number | undefined> {
        try {
            const a = await this.adb.tcpip.getListenAddresses();
            if (a.servicePort) return a.servicePort;
            if (a.persistPort) return a.persistPort;
            for (const addr of a.serviceListenAddresses) {
                const m = /tcp:(\d+)/.exec(addr);
                if (m) return Number(m[1]);
            }
        } catch {
            /* ignore */
        }
        return undefined;
    }

    /**
     * Installs and starts the encrypted bridge, switches adbd to TCP mode if needed.
     * Returns the Wi-Fi pairing record. When `restarting` is true, the USB link will drop momentarily.
     */
    async enableWifi(log: (s: string) => void): Promise<{ record: WifiDevice; restarting: boolean }> {
        await this.refreshInfo();
        const ip = this.info.ip;
        if (!ip) throw new Error("The phone has no Wi-Fi IPv4 address. Connect it to the same Wi-Fi network as this computer first.");
        const existing = loadWifiDevices().find((x) => x.serial === this.serial);
        const key = existing?.key ?? randomKeyHex();

        let port = await this.adbdTcpPort();
        const needRestart = port === undefined;
        port ??= 5555;

        log("Installing bridge on the phone…");
        await this.push(BRIDGE_PATH, BRIDGE_JAR, { permission: 0o644 });
        await this.push(BRIDGE_KEY, new TextEncoder().encode(key + "\n"), { permission: 0o600 });
        await this.sh(`chmod 600 ${BRIDGE_KEY}; ${KILL_BRIDGE}; rm -f ${BRIDGE_LOG}; sleep 0.2; true`);
        log("Starting bridge…");
        // Detached (own session, immune to hangup) so it survives unplugging and the adbd restart.
        await this.sh(
            `N=$(command -v nohup); S=$(command -v setsid); CLASSPATH=${BRIDGE_PATH} $N $S app_process /system/bin --nice-name=annex-bridge annex.AnnexBridge ${BRIDGE_PORT} ${BRIDGE_KEY} ${port} ${BRIDGE_PID} </dev/null >${BRIDGE_LOG} 2>&1 &`,
        );
        let started = "";
        for (let i = 0; i < 30; i++) {
            await new Promise((r) => setTimeout(r, 200));
            started = await this.sh(`cat ${BRIDGE_LOG} 2>/dev/null`);
            if (/listening/.test(started) || /Exception|Error/.test(started)) break;
        }
        if (!/listening/.test(started)) throw new Error("The bridge did not start on the phone." + (started ? "\n" + started.trim().slice(0, 400) : ""));

        const record: WifiDevice = { serial: this.serial, name: this.displayName, host: ip, port: BRIDGE_PORT, key, lastUsed: Date.now() };
        upsertWifiDevice(record);
        if (needRestart) {
            log("Switching ADB to network mode (USB link restarts)…");
            await this.adb.tcpip.setPort(5555).catch(() => {});
        }
        return { record, restarting: needRestart };
    }

    /** Stops the bridge and returns adbd to USB-only mode. Drops a Wi-Fi link. */
    async disableWifi() {
        await this.sh(`(sleep 1; ${KILL_BRIDGE}) </dev/null >/dev/null 2>&1 &`).catch(() => {});
        removeWifiDevice(this.serial);
        await this.adb.tcpip.disable().catch(() => {});
    }

    async bridgeRunning(): Promise<boolean> {
        const out = await this.sh(`pidof annex-bridge 2>/dev/null || pgrep -x annex-bridge 2>/dev/null; true`).catch(() => "");
        return /\d+/.test(out);
    }

    async close() {
        this.#closed = true;
        try {
            await this.adb.close();
        } catch {
            /* ignore */
        }
    }
}
