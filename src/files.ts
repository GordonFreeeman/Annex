import { LinuxFileType, type AdbSyncEntry } from "@yume-chan/adb";
import type { AndroidDevice } from "./device";
import { $, confirmDialog, downloadBlob, errorMessage, formatBytes, formatDate, h, icon, promptDialog, shQuote, toast } from "./ui";

// ---------------------------------------------------------------- transfers tray
export class Transfers {
    readonly el: HTMLElement;
    constructor(el: HTMLElement) {
        this.el = el;
    }
    add(name: string, kind: "up" | "down" | "install") {
        const bar = h("div", { class: "tr-bar" });
        const meta = h("span", { class: "tr-meta", text: "starting…" });
        const row = h(
            "div",
            { class: "tr-row" },
            icon(kind === "down" ? "download" : kind === "install" ? "package" : "upload"),
            h("div", { class: "tr-main" }, h("div", { class: "tr-name", text: name, title: name }), h("div", { class: "tr-track" }, bar), meta),
        );
        this.el.append(row);
        this.el.hidden = false;
        const t0 = performance.now();
        return {
            progress: (done: number, total: number) => {
                const pct = total ? Math.min(100, (done / total) * 100) : 0;
                bar.style.width = pct.toFixed(1) + "%";
                const rate = done / Math.max(0.001, (performance.now() - t0) / 1000);
                meta.textContent = `${formatBytes(done)}${total ? " / " + formatBytes(total) : ""} · ${formatBytes(rate)}/s`;
            },
            phase: (text: string) => {
                meta.textContent = text;
                bar.classList.add("indeterminate");
            },
            finish: (ok: boolean, text?: string) => {
                bar.classList.remove("indeterminate");
                bar.style.width = "100%";
                row.classList.add(ok ? "ok" : "fail");
                meta.textContent = text ?? (ok ? "done" : "failed");
                setTimeout(() => {
                    row.remove();
                    if (!this.el.children.length) this.el.hidden = true;
                }, ok ? 2500 : 8000);
            },
        };
    }
}

// ---------------------------------------------------------------- upload / install helper
export async function sendFiles(dev: AndroidDevice, files: File[], dir: string, transfers: Transfers, onDone?: () => void) {
    if (!dir.endsWith("/")) dir += "/";
    for (const f of files) {
        const isApk = /\.apk$/i.test(f.name);
        const t = transfers.add(f.name, isApk ? "install" : "up");
        try {
            if (isApk) {
                await dev.installApk(f, f.name, (d, n) => {
                    t.progress(d, n);
                    if (d >= n) t.phase("installing…");
                });
                t.finish(true, "installed");
                toast(`Installed ${f.name}`, "ok");
            } else {
                await dev.push(dir + f.name, f, { onProgress: t.progress });
                t.finish(true, "saved to " + dir);
            }
        } catch (e) {
            t.finish(false, errorMessage(e).slice(0, 120));
            toast(`${isApk ? "Install" : "Upload"} failed: ${f.name}`, "error", 8000, errorMessage(e));
        }
    }
    onDone?.();
}

// ---------------------------------------------------------------- panel
const PLACES: [string, string, string][] = [
    ["Internal storage", "/sdcard/", "hard-drive"],
    ["Downloads", "/sdcard/Download/", "download"],
    ["Camera", "/sdcard/DCIM/Camera/", "camera"],
    ["Pictures", "/sdcard/Pictures/", "image"],
    ["Documents", "/sdcard/Documents/", "file-text"],
    ["Temp (adb)", "/data/local/tmp/", "folder-cog"],
];

function isDir(e: AdbSyncEntry) {
    return e.type === LinuxFileType.Directory;
}

export class FilesPanel {
    readonly root: HTMLElement;
    readonly getDev: () => AndroidDevice | undefined;
    readonly transfers: Transfers;
    cwd = "/sdcard/";
    #entries: AdbSyncEntry[] = [];
    #loaded = false;
    #busy = false;
    #showHidden = false;
    #list!: HTMLElement;
    #path!: HTMLInputElement;
    #status!: HTMLElement;

    constructor(root: HTMLElement, getDev: () => AndroidDevice | undefined, transfers: Transfers) {
        this.root = root;
        this.getDev = getDev;
        this.transfers = transfers;
        this.#build();
    }

    #build() {
        this.#path = h("input", { class: "input mono path-input", spellcheck: "false", "aria-label": "Path" }) as HTMLInputElement;
        this.#path.addEventListener("keydown", (e) => {
            if (e.key === "Enter") void this.go(this.#path.value);
        });
        const fileInput = h("input", { type: "file", multiple: true, hidden: true }) as HTMLInputElement;
        fileInput.addEventListener("change", () => {
            const dev = this.getDev();
            if (dev && fileInput.files?.length) void sendFiles(dev, [...fileInput.files], this.cwd, this.transfers, () => this.refresh());
            fileInput.value = "";
        });
        const btn = (ic: string, title: string, fn: () => void) => h("button", { class: "icon-btn", title, "aria-label": title, onclick: fn }, icon(ic));
        this.#list = h("div", { class: "file-list", role: "list" });
        this.#status = h("div", { class: "file-status" });
        const places = h(
            "div",
            { class: "places" },
            ...PLACES.map(([label, p, ic]) => h("button", { class: "chip", onclick: () => void this.go(p) }, icon(ic), label)),
        );
        const hiddenToggle = h("label", { class: "check small" }, h("input", { type: "checkbox", onchange: (e: Event) => { this.#showHidden = (e.target as HTMLInputElement).checked; this.#render(); } }), "Hidden");
        this.root.append(
            h(
                "div",
                { class: "file-toolbar" },
                btn("arrow-up", "Up one level", () => void this.go(this.#parent(this.cwd))),
                btn("refresh-cw", "Refresh", () => void this.refresh()),
                this.#path,
                btn("folder-plus", "New folder", () => void this.mkdir()),
                btn("upload", "Upload files", () => fileInput.click()),
            ),
            places,
            h("div", { class: "file-head" }, h("span", { text: "Name" }), hiddenToggle),
            this.#list,
            this.#status,
            fileInput,
        );
        // drop onto the list = upload here
        this.root.addEventListener("dragover", (e) => {
            if (e.dataTransfer?.types.includes("Files")) {
                e.preventDefault();
                this.root.classList.add("drop");
            }
        });
        this.root.addEventListener("dragleave", () => this.root.classList.remove("drop"));
        this.root.addEventListener("drop", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.root.classList.remove("drop");
            const dev = this.getDev();
            const files = [...(e.dataTransfer?.files ?? [])];
            if (dev && files.length) void sendFiles(dev, files, this.cwd, this.transfers, () => this.refresh());
        });
    }

    #parent(p: string) {
        const parts = p.replace(/\/+$/, "").split("/");
        parts.pop();
        const r = parts.join("/") + "/";
        return r || "/";
    }

    reset() {
        this.#loaded = false;
        this.#entries = [];
        this.#list.replaceChildren();
        this.cwd = "/sdcard/";
    }

    async show() {
        if (!this.#loaded) await this.go(this.cwd);
    }

    refresh() {
        return this.go(this.cwd);
    }

    async go(path: string) {
        const dev = this.getDev();
        if (!dev || this.#busy) return;
        if (!path.startsWith("/")) path = "/" + path;
        if (!path.endsWith("/")) path += "/";
        this.#busy = true;
        this.#status.textContent = "Loading…";
        try {
            const sync = await dev.adb.sync();
            try {
                const entries = (await sync.readdir(path)).filter((e) => e.name !== "." && e.name !== "..");
                // resolve symlinked folders (e.g. /sdcard)
                for (const e of entries) {
                    if (e.type === LinuxFileType.Link) {
                        try {
                            if (await sync.isDirectory(path + e.name)) (e as { type: LinuxFileType }).type = LinuxFileType.Directory;
                        } catch {
                            /* broken link */
                        }
                    }
                }
                this.#entries = entries;
            } finally {
                await sync.dispose();
            }
            this.cwd = path;
            this.#loaded = true;
            this.#render();
        } catch (e) {
            this.#status.textContent = "";
            toast(`Cannot open ${path}`, "error", 5000, errorMessage(e));
        } finally {
            this.#busy = false;
        }
    }

    #render() {
        this.#path.value = this.cwd;
        const list = this.#entries
            .filter((e) => this.#showHidden || !e.name.startsWith("."))
            .sort((a, b) => Number(isDir(b)) - Number(isDir(a)) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
        const rows = list.map((e) => {
            const dir = isDir(e);
            const ext = e.name.includes(".") ? e.name.split(".").pop()!.toLowerCase() : "";
            const ic = dir ? "folder" : /^(jpe?g|png|gif|webp|heic|bmp)$/.test(ext) ? "image" : /^(mp4|mkv|webm|mov|3gp)$/.test(ext) ? "film" : /^(mp3|m4a|ogg|opus|wav|flac)$/.test(ext) ? "music" : ext === "apk" ? "package" : /^(zip|rar|7z|tar|gz)$/.test(ext) ? "file-archive" : "file";
            const actBtn = (i: string, title: string, fn: () => void, cls = "") =>
                h("button", { class: "icon-btn sm " + cls, title, "aria-label": title, onclick: (ev: Event) => { ev.stopPropagation(); fn(); } }, icon(i));
            const row = h(
                "div",
                { class: "file-row" + (dir ? " dir" : ""), role: "listitem", tabindex: "0" },
                icon(ic, "file-ic"),
                h("div", { class: "file-name" }, h("span", { class: "fn", text: e.name, title: e.name }), h("span", { class: "fmeta", text: `${dir ? "Folder" : formatBytes(Number(e.size))} · ${formatDate(Number(e.mtime))}` })),
                h(
                    "div",
                    { class: "file-acts" },
                    actBtn("download", dir ? "Download as .tar" : "Download", () => void this.download(e)),
                    actBtn("pencil", "Rename", () => void this.rename(e)),
                    actBtn("trash-2", "Delete", () => void this.remove(e), "danger"),
                ),
            );
            const open = () => (dir ? void this.go(this.cwd + e.name + "/") : void this.download(e));
            row.addEventListener("dblclick", open);
            row.addEventListener("keydown", (ev) => {
                if (ev.key === "Enter") open();
                if (ev.key === "Delete") void this.remove(e);
            });
            return row;
        });
        this.#list.replaceChildren(...rows);
        if (!rows.length) this.#list.append(h("div", { class: "empty", text: "This folder is empty — drop files here to upload." }));
        const files = list.filter((e) => !isDir(e));
        const total = files.reduce((a, e) => a + Number(e.size), 0);
        this.#status.textContent = `${list.length} items · ${formatBytes(total)}`;
    }

    async mkdir() {
        const dev = this.getDev();
        if (!dev) return;
        const name = await promptDialog("New folder", "Name", "New folder", "Create");
        if (!name) return;
        try {
            const out = await dev.sh(`mkdir -p ${shQuote(this.cwd + name)} 2>&1`);
            if (out.trim()) throw new Error(out.trim());
            await this.refresh();
        } catch (e) {
            toast("Could not create folder", "error", 5000, errorMessage(e));
        }
    }

    async rename(e: AdbSyncEntry) {
        const dev = this.getDev();
        if (!dev) return;
        const name = await promptDialog("Rename", "New name", e.name, "Rename");
        if (!name || name === e.name) return;
        try {
            const out = await dev.sh(`mv -n ${shQuote(this.cwd + e.name)} ${shQuote(this.cwd + name)} 2>&1`);
            if (out.trim()) throw new Error(out.trim());
            await this.refresh();
        } catch (err) {
            toast("Rename failed", "error", 5000, errorMessage(err));
        }
    }

    async remove(e: AdbSyncEntry) {
        const dev = this.getDev();
        if (!dev) return;
        const ok = await confirmDialog(`Delete “${e.name}”?`, isDir(e) ? "The folder and everything inside it will be permanently deleted from the phone." : "The file will be permanently deleted from the phone.", "Delete", true);
        if (!ok) return;
        try {
            const out = await dev.sh(`rm -rf ${shQuote(this.cwd + e.name)} 2>&1`);
            if (out.trim()) throw new Error(out.trim());
            await this.refresh();
        } catch (err) {
            toast("Delete failed", "error", 5000, errorMessage(err));
        }
    }

    async download(e: AdbSyncEntry) {
        const dev = this.getDev();
        if (!dev) return;
        const dir = isDir(e);
        const name = dir ? e.name + ".tar" : e.name;
        const total = dir ? 0 : Number(e.size);
        // Large files stream straight to disk when the File System Access API is available.
        const picker = (window as Window & { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
        let writable: FileSystemWritableFileStream | undefined;
        if (picker && (dir || total > 64 * 1024 * 1024)) {
            try {
                const handle = await picker({ suggestedName: name });
                writable = await handle.createWritable();
            } catch {
                return; // user cancelled
            }
        }
        const t = this.transfers.add(name, "down");
        try {
            let reader: ReadableStreamDefaultReader<Uint8Array>;
            let dispose = async () => {};
            if (dir) {
                const proc = await dev.adb.subprocess.noneProtocol.spawn(["tar", "-cf", "-", "-C", shQuote(this.cwd), shQuote(e.name), "2>/dev/null"]);
                reader = (proc.output as unknown as ReadableStream<Uint8Array>).getReader();
            } else {
                const sync = await dev.adb.sync();
                reader = (sync.read(this.cwd + e.name) as unknown as ReadableStream<Uint8Array>).getReader();
                dispose = () => sync.dispose();
            }
            const chunks: Uint8Array[] = [];
            let done = 0;
            try {
                for (;;) {
                    const r = await reader.read();
                    if (r.done) break;
                    done += r.value.byteLength;
                    if (writable) await writable.write(r.value as BufferSource);
                    else chunks.push(r.value.slice());
                    t.progress(done, total);
                }
            } finally {
                await dispose();
            }
            if (writable) await writable.close();
            else downloadBlob(new Blob(chunks as BlobPart[]), name);
            t.finish(true, formatBytes(done));
        } catch (err) {
            await writable?.abort().catch(() => {});
            t.finish(false, errorMessage(err).slice(0, 100));
            toast(`Download failed: ${name}`, "error", 6000, errorMessage(err));
        }
    }

    focusPath() {
        $(".path-input", this.root)?.focus();
    }
}
