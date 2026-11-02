import type { AdbDaemonConnection, AdbPacketData } from "@yume-chan/adb";
import { AdbPacket, AdbPacketSerializeStream } from "@yume-chan/adb";
import { Consumable, ReadableStream, StructDeserializeStream } from "@yume-chan/stream-extra";
import type { SecureSocket } from "./securews";

/** Wraps an encrypted byte socket as an ADB daemon packet connection. One WS message per ADB packet. */
export function createSecureAdbConnection(sock: SecureSocket): AdbDaemonConnection {
    const bytes = new ReadableStream<Uint8Array>({
        start(controller) {
            sock.onData = (d) => controller.enqueue(d);
            sock.onClose = (e) => {
                try {
                    if (e) controller.error(e);
                    else controller.close();
                } catch {
                    /* already closed */
                }
            };
        },
        cancel() {
            sock.close();
        },
    });
    const readable = bytes.pipeThrough(new StructDeserializeStream(AdbPacket)) as unknown as ReadableStream<AdbPacketData>;

    // Re-frame serialized header/payload chunks into whole packets.
    let pending = new Uint8Array(0);
    const serialize = new AdbPacketSerializeStream();
    void serialize.readable
        .pipeTo(
            new Consumable.WritableStream<Uint8Array>({
                async write(chunk) {
                    const merged = new Uint8Array(pending.length + chunk.length);
                    merged.set(pending, 0);
                    merged.set(chunk, pending.length);
                    pending = merged;
                    while (pending.length >= 24) {
                        const len = new DataView(pending.buffer, pending.byteOffset + 12, 4).getUint32(0, true);
                        if (pending.length < 24 + len) break;
                        const pkt = pending.subarray(0, 24 + len);
                        pending = pending.slice(24 + len);
                        await sock.send(pkt);
                    }
                },
                close() {
                    sock.close();
                },
                abort() {
                    sock.close();
                },
            }),
        )
        .catch(() => sock.close());

    return { readable, writable: serialize.writable };
}
