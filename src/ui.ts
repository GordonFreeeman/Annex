// Tiny DOM helpers, toasts, dialogs, formatting.

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
export const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => Array.from(root.querySelectorAll(sel)) as T[];

export function h<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attrs: Record<string, unknown> = {},
    ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === "class") el.className = String(v);
        else if (k === "text") el.textContent = String(v);
        else if (k === "html") el.innerHTML = String(v);
        else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
        else if (k === "dataset") Object.assign(el.dataset, v);
        else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
    return el;
}

/** Icons are inlined at build time into <template id="icons">; clone by name. */
export function icon(name: string, cls = ""): SVGElement {
    const tpl = document.getElementById("icon-" + name) as HTMLTemplateElement | null;
    const svg = tpl?.content.firstElementChild?.cloneNode(true) as SVGElement | undefined;
    if (!svg) {
        const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        return s;
    }
    if (cls) svg.setAttribute("class", "ic " + cls);
    return svg;
}

export function escapeHtml(s: string) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export type ToastKind = "info" | "ok" | "warn" | "error";

export function toast(message: string, kind: ToastKind = "info", ms = kind === "error" ? 7000 : 3500, detail?: string) {
    const box = document.getElementById("toasts")!;
    const el = h(
        "div",
        { class: `toast ${kind}`, role: kind === "error" ? "alert" : "status" },
        icon(kind === "ok" ? "circle-check" : kind === "warn" ? "triangle-alert" : kind === "error" ? "circle-x" : "info"),
        h("div", { class: "toast-body" }, h("div", { class: "toast-msg", text: message }), detail ? h("div", { class: "toast-detail", text: detail }) : null),
    );
    el.addEventListener("click", () => dismiss());
    box.append(el);
    requestAnimationFrame(() => el.classList.add("in"));
    let t = setTimeout(dismiss, ms);
    function dismiss() {
        clearTimeout(t);
        el.classList.remove("in");
        setTimeout(() => el.remove(), 250);
    }
    return { dismiss, update(msg: string) { el.querySelector(".toast-msg")!.textContent = msg; clearTimeout(t); t = setTimeout(dismiss, ms); } };
}

export function confirmDialog(title: string, body: string, okLabel = "Confirm", danger = false): Promise<boolean> {
    return new Promise((resolve) => {
        const dlg = h(
            "dialog",
            { class: "dialog" },
            h("h3", { text: title }),
            h("p", { text: body }),
            h(
                "div",
                { class: "dialog-actions" },
                h("button", { class: "btn ghost", text: "Cancel", onclick: () => done(false) }),
                h("button", { class: `btn ${danger ? "danger" : "primary"}`, text: okLabel, onclick: () => done(true) }),
            ),
        );
        function done(v: boolean) {
            dlg.close();
            dlg.remove();
            resolve(v);
        }
        dlg.addEventListener("cancel", () => done(false));
        document.body.append(dlg);
        dlg.showModal();
    });
}

export function promptDialog(title: string, label: string, value = "", okLabel = "OK"): Promise<string | null> {
    return new Promise((resolve) => {
        const input = h("input", { class: "input", value, spellcheck: "false" }) as HTMLInputElement;
        const dlg = h(
            "dialog",
            { class: "dialog" },
            h("h3", { text: title }),
            h("label", { class: "field" }, h("span", { text: label }), input),
            h(
                "div",
                { class: "dialog-actions" },
                h("button", { class: "btn ghost", text: "Cancel", onclick: () => done(null) }),
                h("button", { class: "btn primary", text: okLabel, onclick: () => done(input.value) }),
            ),
        );
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") done(input.value);
        });
        function done(v: string | null) {
            dlg.close();
            dlg.remove();
            resolve(v);
        }
        dlg.addEventListener("cancel", () => done(null));
        document.body.append(dlg);
        dlg.showModal();
        input.select();
    });
}

export function formatBytes(n: number) {
    if (!isFinite(n)) return "–";
    const u = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) {
        n /= 1024;
        i++;
    }
    return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

export function formatDate(sec: number) {
    if (!sec) return "";
    const d = new Date(sec * 1000);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay
        ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
        : d.toLocaleDateString(undefined, { year: d.getFullYear() === now.getFullYear() ? undefined : "numeric", month: "short", day: "numeric" });
}

export function downloadBlob(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob);
    const a = h("a", { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function shQuote(s: string) {
    return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function timestamp() {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function errorMessage(e: unknown): string {
    if (e instanceof Error) return e.message || e.name;
    return String(e);
}
