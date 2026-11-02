import { TextDecoderStream, WritableStream } from "@yume-chan/stream-extra";
import type { AndroidDevice } from "./device";
import { getPref, setPref } from "./settings";
import { errorMessage, h, icon } from "./ui";

const QUICK: [string, string][] = [
    ["Battery", "dumpsys battery | grep -E 'level|status|temperature|powered'"],
    ["Network", "ip -4 addr show wlan0; getprop | grep -E 'dns|wifi.interface' | head -5"],
    ["Storage", "df -h /data /sdcard 2>/dev/null"],
    ["Top CPU", "top -b -n 1 -m 12"],
    ["Foreground app", "dumpsys activity activities | grep -E 'mResumedActivity|topResumedActivity' | head -3"],
    ["Device props", "getprop | grep -E 'ro.product|ro.build.version' "],
];

export class ShellPanel {
    readonly root: HTMLElement;
    readonly getDev: () => AndroidDevice | undefined;
    #out!: HTMLElement;
    #input!: HTMLInputElement;
    #history: string[] = getPref("shellHistory", [] as string[]);
    #hIdx = -1;
    #running?: { kill: () => void };

    constructor(root: HTMLElement, getDev: () => AndroidDevice | undefined) {
        this.root = root;
        this.getDev = getDev;
        this.#out = h("pre", { class: "shell-out", tabindex: "0" });
        this.#input = h("input", { class: "input mono", placeholder: "adb shell command…  (↑ history, Ctrl+C stop)", spellcheck: "false", autocomplete: "off" }) as HTMLInputElement;
        this.#input.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && this.#input.value.trim()) {
                void this.run(this.#input.value.trim());
                this.#input.value = "";
            } else if (e.key === "ArrowUp") {
                e.preventDefault();
                this.#hIdx = Math.min(this.#history.length - 1, this.#hIdx + 1);
                this.#input.value = this.#history[this.#hIdx] ?? "";
            } else if (e.key === "ArrowDown") {
                e.preventDefault();
                this.#hIdx = Math.max(-1, this.#hIdx - 1);
                this.#input.value = this.#hIdx < 0 ? "" : this.#history[this.#hIdx];
            } else if (e.key === "c" && e.ctrlKey && this.#running) {
                e.preventDefault();
                this.#running.kill();
            } else if (e.key === "l" && e.ctrlKey) {
                e.preventDefault();
                this.#out.replaceChildren();
            }
        });
        this.root.append(
            h("div", { class: "chips" }, ...QUICK.map(([label, cmd]) => h("button", { class: "chip", title: cmd, onclick: () => void this.run(cmd) }, label))),
            this.#out,
            h("div", { class: "shell-in" }, h("span", { class: "prompt mono", text: "$" }), this.#input, h("button", { class: "icon-btn", title: "Clear", "aria-label": "Clear output", onclick: () => this.#out.replaceChildren() }, icon("eraser"))),
        );
    }

    focus() {
        this.#input.focus();
    }

    #print(text: string, cls = "") {
        const atBottom = this.#out.scrollHeight - this.#out.scrollTop - this.#out.clientHeight < 40;
        this.#out.append(cls ? h("span", { class: cls, text }) : document.createTextNode(text));
        // cap output size
        while (this.#out.childNodes.length > 4000) this.#out.firstChild?.remove();
        if (atBottom) this.#out.scrollTop = this.#out.scrollHeight;
    }

    async run(cmd: string) {
        const dev = this.getDev();
        if (!dev) return;
        this.#history = [cmd, ...this.#history.filter((x) => x !== cmd)].slice(0, 100);
        setPref("shellHistory", this.#history);
        this.#hIdx = -1;
        this.#running?.kill();
        this.#print(`$ ${cmd}\n`, "cmd");
        try {
            const sp = dev.adb.subprocess.shellProtocol;
            if (sp) {
                const p = await sp.spawn(cmd);
                this.#running = { kill: () => void p.kill() };
                const sink = (cls: string) => new WritableStream<string>({ write: (t) => this.#print(t, cls) });
                await Promise.all([
                    p.stdout.pipeThrough(new TextDecoderStream()).pipeTo(sink("")),
                    p.stderr.pipeThrough(new TextDecoderStream()).pipeTo(sink("err")),
                ]);
                const code = await p.exited;
                if (code) this.#print(`[exit ${code}]\n`, "dim");
            } else {
                const p = await dev.adb.subprocess.noneProtocol.spawn(cmd + " 2>&1");
                this.#running = { kill: () => void p.kill() };
                await p.output.pipeThrough(new TextDecoderStream()).pipeTo(new WritableStream<string>({ write: (t) => this.#print(t) }));
            }
        } catch (e) {
            this.#print(errorMessage(e) + "\n", "err");
        } finally {
            this.#running = undefined;
        }
    }
}
