import { downloadBlob, timestamp } from "./ui";

export class ScreenRecorder {
    #rec?: MediaRecorder;
    #chunks: Blob[] = [];
    #started = 0;
    #ext = "webm";

    get recording() {
        return !!this.#rec && this.#rec.state === "recording";
    }

    get elapsed() {
        return this.recording ? Date.now() - this.#started : 0;
    }

    start(canvas: HTMLCanvasElement, audio?: MediaStream, fps = 60) {
        const stream = canvas.captureStream(fps);
        audio?.getAudioTracks().forEach((t) => stream.addTrack(t));
        const types = [
            ["video/mp4;codecs=avc1.640033,mp4a.40.2", "mp4"],
            ["video/mp4;codecs=avc1", "mp4"],
            ["video/webm;codecs=vp9,opus", "webm"],
            ["video/webm;codecs=vp8,opus", "webm"],
            ["video/webm", "webm"],
        ];
        const pick = types.find(([t]) => MediaRecorder.isTypeSupported(t));
        this.#ext = pick?.[1] ?? "webm";
        this.#chunks = [];
        this.#rec = new MediaRecorder(stream, { mimeType: pick?.[0], videoBitsPerSecond: 16_000_000 });
        this.#rec.ondataavailable = (e) => e.data.size && this.#chunks.push(e.data);
        this.#rec.start(1000);
        this.#started = Date.now();
    }

    stop(): Promise<void> {
        const rec = this.#rec;
        if (!rec) return Promise.resolve();
        return new Promise((resolve) => {
            rec.onstop = () => {
                const blob = new Blob(this.#chunks, { type: rec.mimeType });
                this.#chunks = [];
                downloadBlob(blob, `annex-recording-${timestamp()}.${this.#ext}`);
                rec.stream.getTracks().forEach((t) => {
                    if (t.kind === "video") t.stop();
                });
                this.#rec = undefined;
                resolve();
            };
            rec.stop();
        });
    }
}
