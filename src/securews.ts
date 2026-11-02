// End-to-end encrypted byte channel over WebSocket, talking to AnnexBridge on the phone.
// See bridge/AnnexBridge.java for the wire protocol.

const MAGIC = [0x41, 0x4e, 0x58, 0x31]; // "ANX1"
const enc = new TextEncoder();
const dec = new TextDecoder();

export class BridgeError extends Error {
    constructor(message: string, readonly code?: number) {
        super(message);
        this.name = "BridgeError";
    }
}

async function deriveKey(master: CryptoKey, salt: Uint8Array, info: string, usage: KeyUsage) {
    return crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: enc.encode(info) },
        master,
        { name: "AES-GCM", length: 256 },
        false,
        [usage],
    );
}

function nonce(counter: bigint) {
    const n = new Uint8Array(12);
    new DataView(n.buffer).setBigUint64(4, counter, false);
    return n;
}

export function hexToBytes(hex: string) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
}

export function bytesToHex(b: Uint8Array) {
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function randomKeyHex() {
    return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * A duplex byte pipe. `onData` receives decrypted chunks in order;
 * `send` encrypts and sends in order.
 */
export class SecureSocket {
    #ws: WebSocket;
    #encKey: CryptoKey;
    #decKey: CryptoKey;
    #sendCounter = 1n;
    #recvCounter = 1n;
    #sendChain: Promise<void> = Promise.resolve();
    #recvChain: Promise<void> = Promise.resolve();
    #closed = false;
    #closeWaiters: ((e?: Error) => void)[] = [];
    onData: (chunk: Uint8Array) => void = () => {};
    onClose: (reason?: Error) => void = () => {};

    private constructor(ws: WebSocket, encKey: CryptoKey, decKey: CryptoKey) {
        this.#ws = ws;
        this.#encKey = encKey;
        this.#decKey = decKey;
        ws.onmessage = (ev) => {
            const data = new Uint8Array(ev.data as ArrayBuffer);
            const counter = this.#recvCounter++;
            this.#recvChain = this.#recvChain.then(async () => {
                if (this.#closed) return;
                try {
                    const plain = await crypto.subtle.decrypt(
                        { name: "AES-GCM", iv: nonce(counter) },
                        this.#decKey,
                        data,
                    );
                    this.onData(new Uint8Array(plain));
                } catch {
                    this.#fail(new BridgeError("Decryption failed — connection tampered or out of sync"));
                }
            });
        };
        ws.onclose = (ev) => {
            // Drain pending decrypts before reporting the close.
            void this.#recvChain.then(() =>
                this.#fail(ev.code === 1000 ? undefined : new BridgeError(`Wi-Fi link closed (${ev.code}${ev.reason ? ": " + ev.reason : ""})`, ev.code)),
            );
        };
        ws.onerror = () => {};
    }

    get bufferedAmount() {
        return this.#ws.bufferedAmount;
    }

    #fail(e?: Error) {
        if (this.#closed) return;
        this.#closed = true;
        try {
            this.#ws.close();
        } catch {
            /* ignore */
        }
        this.onClose(e);
        for (const w of this.#closeWaiters) w(e);
    }

    get closed() {
        return this.#closed;
    }

    waitClosed() {
        return new Promise<Error | undefined>((r) => {
            if (this.#closed) r(undefined);
            else this.#closeWaiters.push(r);
        });
    }

    send(data: Uint8Array): Promise<void> {
        const counter = this.#sendCounter++;
        // copy now: callers may reuse buffers
        const copy = data.slice();
        this.#sendChain = this.#sendChain.then(async () => {
            if (this.#closed) throw new BridgeError("Wi-Fi link is closed");
            const c = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce(counter) }, this.#encKey, copy);
            this.#ws.send(c);
            // simple backpressure
            while (this.#ws.bufferedAmount > 8 * 1024 * 1024 && !this.#closed) {
                await new Promise((r) => setTimeout(r, 5));
            }
        });
        return this.#sendChain;
    }

    close() {
        this.#fail();
    }

    static connect(url: string, keyHex: string, timeoutMs = 8000): Promise<SecureSocket> {
        return new Promise((resolve, reject) => {
            let ws: WebSocket;
            try {
                ws = new WebSocket(url);
            } catch (e) {
                reject(new BridgeError(`Invalid address: ${(e as Error).message}`));
                return;
            }
            ws.binaryType = "arraybuffer";
            let stage = 0;
            let encKey: CryptoKey, decKey: CryptoKey;
            const timer = setTimeout(() => {
                fail(new BridgeError("Timed out reaching the phone. Is it on the same network and is Wi-Fi mode enabled?"));
            }, timeoutMs);
            const fail = (e: Error) => {
                clearTimeout(timer);
                ws.onmessage = ws.onclose = ws.onerror = null;
                try {
                    ws.close();
                } catch {
                    /* ignore */
                }
                reject(e);
            };
            ws.onerror = () => {};
            ws.onclose = (ev) => {
                if (ev.code === 4003) fail(new BridgeError("Phone rejected the pairing key. Re-enable Wi-Fi mode over USB.", 4003));
                else fail(new BridgeError(stage === 0 ? "Could not reach the phone bridge (connection refused or blocked)." : `Bridge closed during handshake (${ev.code})`, ev.code));
            };
            let chain = Promise.resolve();
            ws.onmessage = (ev) => {
                const data = new Uint8Array(ev.data as ArrayBuffer);
                chain = chain.then(async () => {
                    try {
                        if (stage === 0) {
                            if (data.length !== 20 || MAGIC.some((m, i) => data[i] !== m)) throw new BridgeError("Not an Annex bridge");
                            const serverSalt = data.subarray(4, 20);
                            const clientSalt = crypto.getRandomValues(new Uint8Array(16));
                            const salt = new Uint8Array(32);
                            salt.set(serverSalt, 0);
                            salt.set(clientSalt, 16);
                            const master = await crypto.subtle.importKey("raw", hexToBytes(keyHex), "HKDF", false, ["deriveKey"]);
                            encKey = await deriveKey(master, salt, "annex/1 c2s", "encrypt");
                            decKey = await deriveKey(master, salt, "annex/1 s2c", "decrypt");
                            const hello = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce(0n) }, encKey, enc.encode("ANNEX-HELLO"));
                            const msg = new Uint8Array(16 + hello.byteLength);
                            msg.set(clientSalt, 0);
                            msg.set(new Uint8Array(hello), 16);
                            stage = 1;
                            ws.send(msg);
                        } else if (stage === 1) {
                            let plain: string;
                            try {
                                plain = dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce(0n) }, decKey, data));
                            } catch {
                                throw new BridgeError("Bridge answered with an invalid signature (wrong key?)");
                            }
                            if (plain !== "OK") throw new BridgeError(plain.startsWith("ERR:") ? plain.slice(4) : "Bridge refused connection");
                            stage = 2;
                            clearTimeout(timer);
                            ws.onmessage = ws.onclose = ws.onerror = null;
                            resolve(new SecureSocket(ws, encKey, decKey));
                        }
                    } catch (e) {
                        fail(e as Error);
                    }
                });
            };
        });
    }
}
