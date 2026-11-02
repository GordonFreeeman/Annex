// PWA glue: manifest + service worker (only when served over http(s) — file:// can't be installed),
// install button, standalone detection and "Open with Annex" for .apk files.

type BeforeInstallPromptEvent = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> };

export const isServed = location.protocol === "http:" || location.protocol === "https:";
export const isStandalone = () =>
    matchMedia("(display-mode: standalone)").matches || matchMedia("(display-mode: window-controls-overlay)").matches;

export function setupPwa(opts: { installButton: HTMLButtonElement; onFiles(files: File[]): void; onInstalled(): void }) {
    if (!isServed) return;
    const link = document.createElement("link");
    link.rel = "manifest";
    link.href = "manifest.json";
    document.head.append(link);
    if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("sw.js", { scope: "./" }).catch((e) => console.warn("[annex] service worker", e));
    }
    let deferred: BeforeInstallPromptEvent | null = null;
    window.addEventListener("beforeinstallprompt", (e) => {
        e.preventDefault();
        deferred = e as BeforeInstallPromptEvent;
        opts.installButton.hidden = isStandalone();
    });
    opts.installButton.addEventListener("click", async () => {
        if (!deferred) return;
        await deferred.prompt();
        await deferred.userChoice.catch(() => {});
        deferred = null;
        opts.installButton.hidden = true;
    });
    window.addEventListener("appinstalled", () => {
        opts.installButton.hidden = true;
        opts.onInstalled();
    });
    const lq = (window as unknown as { launchQueue?: { setConsumer(cb: (p: { files: FileSystemFileHandle[] }) => void): void } }).launchQueue;
    lq?.setConsumer(async (params) => {
        if (!params.files?.length) return;
        const files = await Promise.all(params.files.map((h) => h.getFile()));
        opts.onFiles(files);
    });
}
