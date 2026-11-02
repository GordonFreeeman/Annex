import type { VideoFrameRenderer } from "@yume-chan/scrcpy-decoder-webcodecs";

/**
 * Presents decoded frames in step with the display's refresh.
 *
 * Frames from the phone arrive with jitter (USB/ADB batching, encoder pacing): two can land inside
 * one 16.7 ms vsync and none in the next. Drawing them immediately ("latency" mode) means one of the
 * pair is never seen, so a 60 fps stream looks like ~45 fps. "smooth" mode keeps a tiny queue and
 * shows exactly one new frame per vsync, adding at most ~1 frame of delay; when the queue grows it
 * drops the oldest frames so latency can never build up.
 */
export class PacedRenderer implements VideoFrameRenderer {
    readonly inner: VideoFrameRenderer;
    mode: "smooth" | "latency";
    #queue: VideoFrame[] = [];
    #raf = 0;
    #disposed = false;
    #drewSinceVsync = false;
    // counters (cumulative)
    decoded = 0;
    presented = 0;
    dropped = 0;

    constructor(inner: VideoFrameRenderer, mode: "smooth" | "latency") {
        this.inner = inner;
        this.mode = mode;
        const tick = () => {
            if (this.#disposed) return;
            this.#raf = requestAnimationFrame(tick);
            void this.#onVsync();
        };
        this.#raf = requestAnimationFrame(tick);
    }

    setSize(width: number, height: number) {
        this.inner.setSize(width, height);
    }

    async draw(frame: VideoFrame) {
        this.decoded++;
        if (this.mode === "latency") {
            await this.inner.draw(frame);
            this.#drewSinceVsync = true;
            return;
        }
        // The decoder closes `frame` after we return; keep a (cheap, zero-copy) clone.
        this.#queue.push(frame.clone());
        // Never hold more than 2 frames (≈ 33 ms): drop the oldest.
        while (this.#queue.length > 2) {
            this.#queue.shift()!.close();
            this.dropped++;
        }
    }

    async #onVsync() {
        if (this.mode === "latency") {
            if (this.#drewSinceVsync) this.presented++;
            this.#drewSinceVsync = false;
            return;
        }
        const f = this.#queue.shift();
        if (!f) return;
        // If we're running behind (2 queued), skip straight to the newest after this one next vsync.
        try {
            await this.inner.draw(f);
            this.presented++;
        } finally {
            f.close();
        }
    }

    dispose() {
        this.#disposed = true;
        cancelAnimationFrame(this.#raf);
        for (const f of this.#queue) f.close();
        this.#queue = [];
    }
}
