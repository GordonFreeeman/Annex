import type { ScrcpyAudioCodec, ScrcpyMediaStreamPacket } from "@yume-chan/scrcpy";
import type { ReadableStream } from "@yume-chan/stream-extra";
import { WritableStream } from "@yume-chan/stream-extra";

// Low-latency PCM player: an AudioWorklet ring buffer that drops old audio when it
// falls behind, so phone audio never drifts out of sync with the video.
const WORKLET = `
class AnnexPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = 48000 * 2;            // 1 s stereo, interleaved
    this.buf = new Float32Array(this.cap);
    this.r = 0; this.w = 0; this.n = 0;
    this.target = 0.045 * 48000;     // frames kept when catching up
    this.max = 0.15 * 48000;         // frames before we drop
    this.primed = false;
    this.port.onmessage = (e) => {
      if (e.data && e.data.cmd === 'latency') { this.target = e.data.target * 48000; this.max = e.data.max * 48000; return; }
      const s = e.data; const len = s.length;
      for (let i = 0; i < len; i++) { this.buf[this.w] = s[i]; this.w = (this.w + 1) % this.cap; }
      this.n += len;
      if (this.n > this.cap) { this.r = (this.w) % this.cap; this.n = this.cap; }
      const frames = this.n / 2;
      if (frames > this.max) { const drop = Math.floor(frames - this.target) * 2; this.r = (this.r + drop) % this.cap; this.n -= drop; }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0]; const L = out[0]; const R = out[1] || out[0]; const frames = L.length;
    if (!this.primed) { if (this.n / 2 >= Math.min(this.target, 960)) this.primed = true; else { L.fill(0); R.fill(0); return true; } }
    for (let i = 0; i < frames; i++) {
      if (this.n >= 2) { L[i] = this.buf[this.r]; R[i] = this.buf[(this.r + 1) % this.cap]; this.r = (this.r + 2) % this.cap; this.n -= 2; }
      else { L[i] = 0; R[i] = 0; this.primed = false; }
    }
    return true;
  }
}
registerProcessor('annex-pcm', AnnexPcm);
`;

export class AudioPlayer {
    readonly ctx: AudioContext;
    #node?: AudioWorkletNode;
    #gain: GainNode;
    #dest?: MediaStreamAudioDestinationNode;
    #decoder?: AudioDecoder;
    #stopped = false;
    #volume = 1;
    #muted = false;
    codecName = "";
    #resume: () => void;
    #analyser: AnalyserNode;
    /** Samples received from the phone (for diagnostics). */
    samplesIn = 0;

    /** Peak output level 0..1 of the last ~20 ms. */
    level(): number {
        const b = new Float32Array(this.#analyser.fftSize);
        this.#analyser.getFloatTimeDomainData(b);
        let m = 0;
        for (const v of b) m = Math.max(m, Math.abs(v));
        return m;
    }

    get state() {
        return this.ctx.state;
    }

    constructor() {
        this.ctx = new AudioContext({ latencyHint: "interactive", sampleRate: 48000 });
        this.#gain = this.ctx.createGain();
        this.#gain.connect(this.ctx.destination);
        this.#analyser = this.ctx.createAnalyser();
        this.#analyser.fftSize = 1024;
        this.#gain.connect(this.#analyser);
        this.#resume = () => {
            if (this.ctx.state === "suspended") void this.ctx.resume();
        };
        for (const ev of ["pointerdown", "keydown"]) window.addEventListener(ev, this.#resume, { capture: true });
    }

    get suspended() {
        return this.ctx.state === "suspended";
    }

    async #init() {
        // data: works from file:// (opaque origin); blob: is the fallback for http(s) origins.
        try {
            await this.ctx.audioWorklet.addModule("data:text/javascript;base64," + btoa(WORKLET));
        } catch {
            const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
            try {
                await this.ctx.audioWorklet.addModule(url);
            } finally {
                URL.revokeObjectURL(url);
            }
        }
        this.#node = new AudioWorkletNode(this.ctx, "annex-pcm", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
        this.#node.connect(this.#gain);
        void this.ctx.resume().catch(() => {});
    }

    setLatency(targetSec: number, maxSec: number) {
        this.#node?.port.postMessage({ cmd: "latency", target: targetSec, max: maxSec });
    }

    set volume(v: number) {
        this.#volume = v;
        this.#apply();
    }
    get volume() {
        return this.#volume;
    }
    set muted(m: boolean) {
        this.#muted = m;
        this.#apply();
    }
    get muted() {
        return this.#muted;
    }
    #apply() {
        this.#gain.gain.setTargetAtTime(this.#muted ? 0 : this.#volume, this.ctx.currentTime, 0.01);
    }

    /** For recording: a MediaStream carrying the phone audio. */
    get mediaStream(): MediaStream {
        if (!this.#dest) {
            this.#dest = this.ctx.createMediaStreamDestination();
            this.#gain.connect(this.#dest);
        }
        return this.#dest.stream;
    }

    #feed(interleaved: Float32Array) {
        if (this.#stopped || !this.#node) return;
        this.samplesIn += interleaved.length / 2;
        this.#node.port.postMessage(interleaved, [interleaved.buffer]);
    }

    async play(codec: ScrcpyAudioCodec, stream: ReadableStream<ScrcpyMediaStreamPacket>) {
        await this.#init();
        this.codecName = codec.optionValue;
        if (codec.optionValue === "raw") {
            await stream.pipeTo(
                new WritableStream<ScrcpyMediaStreamPacket>({
                    write: (p) => {
                        if (p.type !== "data") return;
                        const d = p.data;
                        const n = d.byteLength >> 1;
                        const f = new Float32Array(n);
                        const view = new DataView(d.buffer, d.byteOffset, n * 2);
                        for (let i = 0; i < n; i++) f[i] = view.getInt16(i * 2, true) / 32768;
                        this.#feed(f);
                    },
                }),
            );
            return;
        }

        const decoder = new AudioDecoder({
            output: (data) => {
                try {
                    const frames = data.numberOfFrames;
                    const ch = data.numberOfChannels;
                    const out = new Float32Array(frames * 2);
                    const tmp = new Float32Array(frames);
                    for (let c = 0; c < Math.min(ch, 2); c++) {
                        data.copyTo(tmp, { planeIndex: c, format: "f32-planar" });
                        for (let i = 0; i < frames; i++) out[i * 2 + c] = tmp[i];
                    }
                    if (ch === 1) for (let i = 0; i < frames; i++) out[i * 2 + 1] = out[i * 2];
                    this.#feed(out);
                } finally {
                    data.close();
                }
            },
            error: (e) => console.warn("[annex] audio decoder", e),
        });
        this.#decoder = decoder;
        let configured = false;
        const configure = (description?: Uint8Array) => {
            const config: AudioDecoderConfig = { codec: codec.webCodecId, sampleRate: 48000, numberOfChannels: 2 };
            // Opus decodes fine without OpusHead; AAC/FLAC need their config blob.
            if (description && codec.optionValue !== "opus") config.description = description;
            decoder.configure(config);
            configured = true;
        };
        await stream.pipeTo(
            new WritableStream<ScrcpyMediaStreamPacket>({
                write: (p) => {
                    if (this.#stopped || decoder.state === "closed") return;
                    if (p.type === "configuration") {
                        configure(p.data);
                        return;
                    }
                    if (!configured) configure();
                    decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: Number(p.pts ?? 0n), data: p.data }));
                },
            }),
        );
    }

    async stop() {
        if (this.#stopped) return;
        this.#stopped = true;
        for (const ev of ["pointerdown", "keydown"]) window.removeEventListener(ev, this.#resume, { capture: true });
        try {
            if (this.#decoder && this.#decoder.state !== "closed") this.#decoder.close();
        } catch {
            /* ignore */
        }
        this.#node?.disconnect();
        await this.ctx.close().catch(() => {});
    }
}
