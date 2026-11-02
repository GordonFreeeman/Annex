import type { AndroidDevice } from "./device";
import { listApps, type AppEntry } from "./session";
import { getPref, setPref } from "./settings";
import { errorMessage, h, icon, shQuote, toast } from "./ui";

function hue(s: string) {
    let x = 0;
    for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) >>> 0;
    return x % 360;
}

export class AppsPanel {
    readonly root: HTMLElement;
    readonly getDev: () => AndroidDevice | undefined;
    readonly launch: (pkg: string, forceStop: boolean) => Promise<boolean>;
    #apps: AppEntry[] = [];
    #loadedFor = "";
    #grid!: HTMLElement;
    #search!: HTMLInputElement;
    #showSystem = false;
    #favs: string[] = getPref("favApps", [] as string[]);

    constructor(root: HTMLElement, getDev: () => AndroidDevice | undefined, launch: (pkg: string, forceStop: boolean) => Promise<boolean>) {
        this.root = root;
        this.getDev = getDev;
        this.launch = launch;
        this.#search = h("input", { class: "input", placeholder: "Search apps…", type: "search", spellcheck: "false" }) as HTMLInputElement;
        this.#search.addEventListener("input", () => this.#render());
        this.#search.addEventListener("keydown", (e) => {
            if (e.key === "Enter") (this.#grid.querySelector(".app-tile") as HTMLElement | null)?.click();
        });
        this.#grid = h("div", { class: "app-grid" });
        const sys = h("label", { class: "check small sys-toggle" }, h("input", { type: "checkbox", onchange: (e: Event) => { this.#showSystem = (e.target as HTMLInputElement).checked; this.#render(); } }), "System apps");
        this.root.append(
            h("div", { class: "apps-toolbar" }, this.#search, h("button", { class: "icon-btn", title: "Reload list", "aria-label": "Reload list", onclick: () => void this.load(true) }, icon("refresh-cw"))),
            h("div", { class: "apps-sub" }, sys, h("span", { class: "hint", text: "Click to open · ⇧-click to restart" })),
            this.#grid,
        );
    }

    reset() {
        this.#loadedFor = "";
        this.#apps = [];
        this.#grid.replaceChildren();
    }

    async show() {
        const dev = this.getDev();
        if (dev && this.#loadedFor !== dev.serial) await this.load();
        this.#search.focus();
    }

    async load(force = false) {
        const dev = this.getDev();
        if (!dev) return;
        if (!force && this.#loadedFor === dev.serial) return;
        this.#grid.replaceChildren(h("div", { class: "empty", text: "Reading installed apps…" }));
        try {
            this.#apps = await listApps(dev, (l) => console.warn(l));
            if (!this.#apps.length) {
                // very old Android: fall back to package names
                const out = await dev.sh("pm list packages -3");
                this.#apps = out.split("\n").map((l) => l.replace("package:", "").trim()).filter(Boolean).map((pkg) => ({ pkg, name: pkg.split(".").pop() ?? pkg, system: false }));
            }
            this.#loadedFor = dev.serial;
            // A real launcher list already matches the phone's app drawer; the toggle only applies to the fallback list.
            (this.root.querySelector(".sys-toggle") as HTMLElement).hidden = this.#apps.some((a) => a.activity);
            this.#render();
        } catch (e) {
            this.#grid.replaceChildren(h("div", { class: "empty", text: "Could not read apps: " + errorMessage(e) }));
        }
    }

    #render() {
        const q = this.#search.value.trim().toLowerCase();
        const list = this.#apps
            .filter((a) => this.#showSystem || !a.system || !!a.activity || this.#favs.includes(a.pkg))
            .filter((a) => !q || a.name.toLowerCase().includes(q) || a.pkg.toLowerCase().includes(q))
            .sort((a, b) => Number(this.#favs.includes(b.pkg)) - Number(this.#favs.includes(a.pkg)) || a.name.localeCompare(b.name));
        const tiles = list.map((a) => {
            const fav = this.#favs.includes(a.pkg);
            const star = h("button", { class: "app-star" + (fav ? " on" : ""), title: fav ? "Unpin" : "Pin to top", "aria-label": "Pin" }, icon("star"));
            star.addEventListener("click", (e) => {
                e.stopPropagation();
                this.#favs = fav ? this.#favs.filter((x) => x !== a.pkg) : [...this.#favs, a.pkg];
                setPref("favApps", this.#favs);
                this.#render();
            });
            const tile = h(
                "button",
                { class: "app-tile", title: a.pkg },
                a.icon
                    ? h("img", { class: "app-icon", src: a.icon, alt: "", loading: "lazy", draggable: "false" })
                    : h("span", { class: "app-avatar", style: `--h:${hue(a.pkg)}`, text: (a.name.match(/\p{L}|\d/u)?.[0] ?? "?").toUpperCase() }),
                h("span", { class: "app-name", text: a.name }),
                star,
            );
            tile.addEventListener("click", (e) => void this.#open(a, (e as MouseEvent).shiftKey));
            return tile;
        });
        this.#grid.replaceChildren(...tiles);
        if (!tiles.length) this.#grid.append(h("div", { class: "empty", text: q ? "No matching apps." : "No apps." }));
    }

    async #open(a: AppEntry, forceStop: boolean) {
        try {
            // Packages with several launcher entries: start the exact activity.
            const multi = a.activity && this.#apps.filter((x) => x.pkg === a.pkg).length > 1;
            if (multi) {
                const dev = this.getDev();
                if (!dev) return;
                if (forceStop) await dev.sh(`am force-stop ${shQuote(a.pkg)}`);
                const out = await dev.sh(`am start -n ${shQuote(a.pkg + "/" + a.activity)} 2>&1`);
                if (/Error/.test(out)) throw new Error(out.trim());
                toast(`Opening ${a.name}`, "info", 1800);
                return;
            }
            const viaSession = await this.launch(a.pkg, forceStop);
            if (!viaSession) {
                const dev = this.getDev();
                if (!dev) return;
                await dev.sh(`monkey -p ${shQuote(a.pkg)} -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1`);
            }
            toast(`Opening ${a.name}`, "info", 1800);
        } catch (e) {
            toast(`Could not open ${a.name}`, "error", 5000, errorMessage(e));
        }
    }
}
