import {
    AndroidKeyCode,
    AndroidKeyEventAction,
    AndroidKeyEventMeta,
    AndroidMotionEventAction,
    AndroidMotionEventButton,
    ScrcpyPointerId,
} from "@yume-chan/scrcpy";
import type { ScrcpyControlMessageWriter } from "@yume-chan/scrcpy";
import { HID_BUTTON, HidKeyboardState, KEYBOARD_DESCRIPTOR, MOUSE_DESCRIPTOR, mouseReport } from "./hid";
import { SOFT_KEY_ACTIONS, type Settings } from "./settings";

export type Hotkey =
    | "help" | "gaming" | "capture" | "fullscreen" | "screenshot" | "record" | "rotate" | "screen"
    | "notifications" | "apps" | "files" | "shell" | "settings" | "stats" | "keyboard"
    | "back" | "home" | "recents" | "volup" | "voldown";

/** App hotkeys: always Ctrl + Alt + key (left Alt — AltGr is left alone so @, €, {, } still type). */
export const HOTKEYS: { code: string; key: string; action: Hotkey; desc: string; repeat?: boolean }[] = [
    { code: "KeyH", key: "H", action: "help", desc: "Show this help" },
    { code: "KeyG", key: "G", action: "gaming", desc: "Toggle OG Gaming mode (real PC mouse & keyboard)" },
    { code: "KeyC", key: "C", action: "capture", desc: "Capture / release mouse & keyboard" },
    { code: "KeyF", key: "F", action: "fullscreen", desc: "Fullscreen" },
    { code: "KeyS", key: "S", action: "screenshot", desc: "Screenshot (saved + copied)" },
    { code: "KeyR", key: "R", action: "record", desc: "Start / stop screen recording" },
    { code: "KeyO", key: "O", action: "rotate", desc: "Rotate phone (orientation)" },
    { code: "KeyP", key: "P", action: "screen", desc: "Phone screen off / on (keeps mirroring)" },
    { code: "KeyN", key: "N", action: "notifications", desc: "Notifications (again: close)" },
    { code: "Backspace", key: "Backspace", action: "back", desc: "Back" },
    { code: "Home", key: "Home", action: "home", desc: "Home" },
    { code: "End", key: "End", action: "recents", desc: "Recent apps" },
    { code: "PageUp", key: "PgUp", action: "volup", desc: "Volume up", repeat: true },
    { code: "PageDown", key: "PgDn", action: "voldown", desc: "Volume down", repeat: true },
    { code: "KeyA", key: "A", action: "apps", desc: "Apps panel" },
    { code: "KeyL", key: "L", action: "files", desc: "Files panel" },
    { code: "KeyT", key: "T", action: "shell", desc: "Shell panel" },
    { code: "KeyK", key: "K", action: "keyboard", desc: "Switch keyboard: smart ↔ physical (HID)" },
    { code: "KeyI", key: "I", action: "stats", desc: "Stats overlay" },
    { code: "Comma", key: ",", action: "settings", desc: "Settings" },
];

/** Every key code except KeyW and F4, so Ctrl+W / Alt+F4 always stay with the browser/OS. */
const LOCK_CODES = (() => {
    const codes: string[] = [];
    for (let i = 0; i < 26; i++) codes.push("Key" + String.fromCharCode(65 + i));
    for (let i = 0; i < 10; i++) codes.push("Digit" + i, "Numpad" + i);
    for (let i = 1; i <= 24; i++) codes.push("F" + i);
    codes.push(
        "Escape", "Tab", "CapsLock", "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight",
        "MetaLeft", "MetaRight", "ContextMenu", "Space", "Enter", "Backspace", "Delete", "Insert", "Home", "End",
        "PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Backquote", "Minus", "Equal",
        "BracketLeft", "BracketRight", "Backslash", "Semicolon", "Quote", "Comma", "Period", "Slash", "IntlBackslash",
        "IntlHash", "IntlRo", "IntlYen", "PrintScreen", "ScrollLock", "Pause", "NumLock", "NumpadAdd", "NumpadSubtract",
        "NumpadMultiply", "NumpadDivide", "NumpadDecimal", "NumpadEnter", "NumpadEqual",
    );
    return codes.filter((c) => c !== "KeyW" && c !== "F4");
})();

const UHID_KEYBOARD_ID = 1;
const UHID_MOUSE_ID = 2;

const MODIFIER_CODES = new Set(["ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight", "CapsLock", "NumLock", "ScrollLock"]);

function isNuke(e: KeyboardEvent) {
    // Browser-side escape hatches that are never forwarded.
    if (e.code === "KeyW" && (e.ctrlKey || e.metaKey) && !e.altKey) return true; // Ctrl+W, Ctrl+Shift+W
    if (e.code === "F4" && (e.altKey || e.ctrlKey)) return true; // Alt+F4, Ctrl+F4
    return false;
}

function metaState(e: KeyboardEvent | MouseEvent) {
    let m = 0;
    if (e.shiftKey) m |= AndroidKeyEventMeta.Shift | AndroidKeyEventMeta.ShiftLeft;
    const altGr = "getModifierState" in e && e.getModifierState("AltGraph");
    if (e.ctrlKey && !altGr) m |= AndroidKeyEventMeta.Ctrl | AndroidKeyEventMeta.CtrlLeft;
    if (e.altKey && !altGr) m |= AndroidKeyEventMeta.Alt | AndroidKeyEventMeta.AltLeft;
    if (e.metaKey) m |= AndroidKeyEventMeta.Meta | AndroidKeyEventMeta.MetaLeft;
    if (e.getModifierState?.("CapsLock")) m |= AndroidKeyEventMeta.CapsLock;
    if (e.getModifierState?.("NumLock")) m |= AndroidKeyEventMeta.NumLock;
    return m;
}

function letterMeta(meta: number, upper: boolean) {
    meta &= ~(AndroidKeyEventMeta.Shift | AndroidKeyEventMeta.ShiftLeft | AndroidKeyEventMeta.CapsLock);
    if (upper) meta |= AndroidKeyEventMeta.Shift | AndroidKeyEventMeta.ShiftLeft;
    return meta;
}

export interface InputHost {
    stage: HTMLElement;
    cursor: HTMLElement;
    controller(): ScrcpyControlMessageWriter | undefined;
    videoSize(): { width: number; height: number };
    canvasRect(): DOMRect;
    settings(): Settings;
    onCaptureChange(captured: boolean): void;
    onHotkey(a: Hotkey): void;
    onPaste(typeIt: boolean): void;
    onError(msg: string): void;
}

type Pressed = { kind: "key" | "mapped"; keyCode: AndroidKeyCode; repeat: number } | { kind: "text" } | { kind: "uhid" } | { kind: "none" };

export class InputController {
    readonly host: InputHost;
    captured = false;
    #hostDown = false;
    #altRight = false;
    #hostUsed = false;
    #pressed = new Map<string, Pressed>();
    #hid = new HidKeyboardState();
    #uhidKeyboard = false;
    #uhidMouse = false;
    #mouseButtons = 0; // HID bits while captured
    #acc = { dx: 0, dy: 0, wheel: 0, hwheel: 0, scheduled: false };
    #cursor = { x: 0, y: 0, down: false };
    #pointers = new Map<number, { pinch: boolean }>();
    #hoverPending: PointerEvent | null = null;
    #wheelAcc = { x: 0, y: 0 };
    #detach: (() => void)[] = [];

    constructor(host: InputHost) {
        this.host = host;
    }

    /** Set while the settings panel records a key for remapping. */
    suspended = false;

    get active() {
        if (document.querySelector("dialog[open]")) return false;
        if (this.captured || document.activeElement === this.host.stage) return true;
        // In fullscreen the phone owns the keyboard unless a text field has focus.
        const a = document.activeElement as HTMLElement | null;
        return !!document.fullscreenElement && !a?.closest?.("input, textarea, select, [contenteditable]");
    }

    // ---------------------------------------------------------------- setup
    attach() {
        const st = this.host.stage;
        const on = <K extends keyof HTMLElementEventMap>(t: EventTarget, type: K | string, fn: (e: any) => void, opts?: AddEventListenerOptions) => {
            t.addEventListener(type, fn, opts);
            this.#detach.push(() => t.removeEventListener(type, fn, opts));
        };
        on(st, "pointerdown", (e: PointerEvent) => this.#onPointerDown(e));
        on(st, "pointermove", (e: PointerEvent) => this.#onPointerMove(e));
        on(st, "pointerup", (e: PointerEvent) => this.#onPointerUp(e));
        on(st, "pointercancel", (e: PointerEvent) => this.#onPointerUp(e, true));
        on(st, "wheel", (e: WheelEvent) => this.#onWheel(e), { passive: false });
        on(st, "contextmenu", (e: Event) => e.preventDefault());
        on(st, "auxclick", (e: Event) => e.preventDefault());
        on(window, "keydown", (e: KeyboardEvent) => this.#onKey(e, true), { capture: true });
        on(window, "keyup", (e: KeyboardEvent) => this.#onKey(e, false), { capture: true });
        on(window, "blur", () => this.releaseAll());
        on(document, "visibilitychange", () => document.hidden && this.releaseAll());
        on(document, "pointerlockchange", () => this.#onLockChange());
        on(document, "mousemove", (e: MouseEvent) => this.captured && this.#capturedMove(e));
        on(document, "mousedown", (e: MouseEvent) => this.captured && this.#capturedButton(e, true));
        on(document, "mouseup", (e: MouseEvent) => this.captured && this.#capturedButton(e, false));
        on(document, "fullscreenchange", () => {
            if (!document.fullscreenElement) this.releaseAll();
            void this.#syncKeyboardLock();
        });
    }

    detach() {
        this.#detach.forEach((f) => f());
        this.#detach = [];
    }

    /** Call when a new mirroring session starts (UHID devices belong to the server process). */
    resetSession() {
        this.#uhidKeyboard = false;
        this.#uhidMouse = false;
        this.#hid.clear();
        this.#pressed.clear();
        this.#pointers.clear();
        this.#mouseButtons = 0;
    }

    #ctl() {
        return this.host.controller();
    }

    #toDevice(clientX: number, clientY: number) {
        const r = this.host.canvasRect();
        const { width, height } = this.host.videoSize();
        const x = ((clientX - r.left) / r.width) * width;
        const y = ((clientY - r.top) / r.height) * height;
        return { x: Math.max(0, Math.min(width - 1, x)), y: Math.max(0, Math.min(height - 1, y)), width, height, inside: x >= 0 && y >= 0 && x < width && y < height };
    }

    #touch(action: AndroidMotionEventAction, pointerId: bigint, x: number, y: number, pressure: number, actionButton: number, buttons: number) {
        const c = this.#ctl();
        const { width, height } = this.host.videoSize();
        if (!c || !width) return;
        void c
            .injectTouch({ action, pointerId, pointerX: x, pointerY: y, videoWidth: width, videoHeight: height, pressure, actionButton, buttons })
            .catch(() => {});
    }

    // ---------------------------------------------------------------- normal pointer
    #domButtonToAndroid(button: number) {
        return [AndroidMotionEventButton.Primary, AndroidMotionEventButton.Tertiary, AndroidMotionEventButton.Secondary, AndroidMotionEventButton.Back, AndroidMotionEventButton.Forward][button] ?? 0;
    }

    #androidButtons(domButtons: number) {
        // DOM: 1 left, 2 right, 4 middle, 8 back, 16 forward. Android: 1 primary, 2 secondary, 4 tertiary, 8 back, 16 forward.
        return domButtons & 0x1f;
    }

    get pcMode() {
        return this.host.settings().inputMode === "pc";
    }

    /** Effective keyboard mode: OG Gaming always uses the physical (HID) keyboard. */
    #kbMode() {
        return this.pcMode ? "uhid" : this.host.settings().keyboardMode;
    }

    #capMode() {
        return this.pcMode ? "uhid" : this.host.settings().captureMouse;
    }

    #onPointerDown(e: PointerEvent) {
        if (this.captured) return;
        if (!(e.target as HTMLElement).closest?.("canvas")) return;
        this.host.stage.focus({ preventScroll: true });
        e.preventDefault();
        const p = this.#toDevice(e.clientX, e.clientY);
        if (!p.inside) return;
        (e.target as Element).setPointerCapture?.(e.pointerId);

        if (e.pointerType !== "mouse") {
            this.#pointers.set(e.pointerId, { pinch: false });
            this.#touch(AndroidMotionEventAction.Down, BigInt(e.pointerId), p.x, p.y, e.pressure || 1, 0, 0);
            return;
        }
        if (this.pcMode) {
            // OG Gaming: a real mouse — every button goes through as itself.
            this.#pointers.set(-1, { pinch: false });
            this.#touch(AndroidMotionEventAction.Down, ScrcpyPointerId.Mouse, p.x, p.y, 1, this.#domButtonToAndroid(e.button), this.#androidButtons(e.buttons));
            return;
        }
        // Touch mode: LMB = finger, MMB = Home, RMB / X1 = Back, X2 = Recents
        if (e.button === 0) {
            const pinch = e.ctrlKey && !e.shiftKey;
            this.#pointers.set(-1, { pinch });
            if (pinch) this.#pinch(AndroidMotionEventAction.Down, p.x, p.y);
            else this.#touch(AndroidMotionEventAction.Down, ScrcpyPointerId.Finger, p.x, p.y, 1, 0, 0);
        } else this.#buttonKey(e.button, true);
    }

    /** Touch mode: non-left mouse buttons act as Android navigation keys (held while pressed). */
    #buttonKey(button: number, down: boolean) {
        const id = -10 - button;
        if (down === this.#pointers.has(id)) return;
        if (down) this.#pointers.set(id, { pinch: false });
        else this.#pointers.delete(id);
        const action = down ? AndroidKeyEventAction.Down : AndroidKeyEventAction.Up;
        if (button === 2 || button === 3) void this.#ctl()?.backOrScreenOn(action).catch(() => {});
        else if (button === 1) void this.#key(AndroidKeyCode.AndroidHome, action);
        else if (button === 4) void this.#key(AndroidKeyCode.AndroidAppSwitch, action);
    }

    #pinch(action: AndroidMotionEventAction, x: number, y: number) {
        const { width, height } = this.host.videoSize();
        const mx = width - x, my = height - y;
        this.#touch(action, ScrcpyPointerId.Finger, x, y, 1, 0, 0);
        this.#touch(action, ScrcpyPointerId.VirtualFinger, mx, my, 1, 0, 0);
    }

    #onPointerMove(e: PointerEvent) {
        if (this.captured) return;
        const p = this.#toDevice(e.clientX, e.clientY);
        if (e.pointerType !== "mouse") {
            if (this.#pointers.has(e.pointerId)) this.#touch(AndroidMotionEventAction.Move, BigInt(e.pointerId), p.x, p.y, e.pressure || 1, 0, 0);
            return;
        }
        const st = this.#pointers.get(-1);
        if (this.pcMode) {
            if (st) {
                if (e.button >= 0) {
                    // chorded button change while another button is held
                    const pressed = (e.buttons & [1, 4, 2, 8, 16][e.button]) !== 0;
                    this.#touch(pressed ? AndroidMotionEventAction.Down : AndroidMotionEventAction.Up, ScrcpyPointerId.Mouse, p.x, p.y, 1, this.#domButtonToAndroid(e.button), this.#androidButtons(e.buttons));
                } else {
                    this.#touch(AndroidMotionEventAction.Move, ScrcpyPointerId.Mouse, p.x, p.y, 1, 0, this.#androidButtons(e.buttons));
                }
                return;
            }
            if (e.buttons === 0 && p.inside && (e.target as HTMLElement).closest?.("canvas")) {
                // hover, throttled to one per frame
                if (!this.#hoverPending) {
                    requestAnimationFrame(() => {
                        const ev = this.#hoverPending;
                        this.#hoverPending = null;
                        if (!ev || this.#pointers.has(-1)) return;
                        const q = this.#toDevice(ev.clientX, ev.clientY);
                        this.#touch(AndroidMotionEventAction.HoverMove, ScrcpyPointerId.Mouse, q.x, q.y, 0, 0, 0);
                    });
                }
                this.#hoverPending = e;
            }
            return;
        }
        // touch mode
        if (e.button === 0) {
            // left pressed/released while another button is held (chord)
            const pressed = (e.buttons & 1) !== 0;
            if (pressed && !st) {
                this.#pointers.set(-1, { pinch: false });
                this.#touch(AndroidMotionEventAction.Down, ScrcpyPointerId.Finger, p.x, p.y, 1, 0, 0);
            } else if (!pressed && st) {
                this.#pointers.delete(-1);
                if (st.pinch) this.#pinch(AndroidMotionEventAction.Up, p.x, p.y);
                else this.#touch(AndroidMotionEventAction.Up, ScrcpyPointerId.Finger, p.x, p.y, 0, 0, 0);
            }
            return;
        }
        if (e.button > 0) this.#buttonKey(e.button, (e.buttons & [1, 4, 2, 8, 16][e.button]) !== 0);
        if (!st || !(e.buttons & 1)) return;
        if (st.pinch) this.#pinch(AndroidMotionEventAction.Move, p.x, p.y);
        else this.#touch(AndroidMotionEventAction.Move, ScrcpyPointerId.Finger, p.x, p.y, 1, 0, 0);
    }

    #onPointerUp(e: PointerEvent, cancel = false) {
        if (this.captured) return;
        const p = this.#toDevice(e.clientX, e.clientY);
        if (e.pointerType !== "mouse") {
            if (this.#pointers.delete(e.pointerId)) this.#touch(cancel ? AndroidMotionEventAction.Cancel : AndroidMotionEventAction.Up, BigInt(e.pointerId), p.x, p.y, 0, 0, 0);
            return;
        }
        const st = this.#pointers.get(-1);
        const up = cancel ? AndroidMotionEventAction.Cancel : AndroidMotionEventAction.Up;
        if (this.pcMode) {
            if (!st) return;
            this.#pointers.delete(-1);
            this.#touch(up, ScrcpyPointerId.Mouse, p.x, p.y, 0, this.#domButtonToAndroid(e.button), 0);
            return;
        }
        // touch mode: release whatever is still held
        for (const b of [1, 2, 3, 4]) if (this.#pointers.has(-10 - b)) this.#buttonKey(b, false);
        if (!st) return;
        this.#pointers.delete(-1);
        if (st.pinch) this.#pinch(up, p.x, p.y);
        else this.#touch(up, ScrcpyPointerId.Finger, p.x, p.y, 0, 0, 0);
    }

    #onWheel(e: WheelEvent) {
        if (this.captured) {
            this.capturedWheel(e);
            return;
        }
        if (!(e.target as HTMLElement).closest?.("canvas")) return;
        e.preventDefault();
        const s = this.host.settings();
        const unit = e.deltaMode === 1 ? 3 : e.deltaMode === 2 ? 0.1 : 100;
        this.#wheelAcc.x += (-e.deltaX / unit) * s.scrollSpeed;
        this.#wheelAcc.y += (-e.deltaY / unit) * s.scrollSpeed;
        const p = this.#toDevice(e.clientX, e.clientY);
        const c = this.#ctl();
        if (!c || !p.width) return;
        // send whole notches; keep the remainder for smooth trackpads
        for (let guard = 0; guard < 20; guard++) {
            const sx = Math.abs(this.#wheelAcc.x) >= 1 ? Math.sign(this.#wheelAcc.x) : Math.abs(this.#wheelAcc.x) > 0.2 ? this.#wheelAcc.x : 0;
            const sy = Math.abs(this.#wheelAcc.y) >= 1 ? Math.sign(this.#wheelAcc.y) : Math.abs(this.#wheelAcc.y) > 0.2 ? this.#wheelAcc.y : 0;
            if (!sx && !sy) break;
            this.#wheelAcc.x -= sx;
            this.#wheelAcc.y -= sy;
            void c
                .injectScroll({ pointerX: p.x, pointerY: p.y, videoWidth: p.width, videoHeight: p.height, scrollX: sx, scrollY: sy, buttons: 0 })
                .catch(() => {});
        }
    }

    // ---------------------------------------------------------------- keyboard
    #key(keyCode: AndroidKeyCode, action: AndroidKeyEventAction, metaState = 0, repeat = 0) {
        const c = this.#ctl();
        if (!c) return Promise.resolve();
        return c.injectKeyCode({ action, keyCode, repeat, metaState: metaState as AndroidKeyEventMeta }).catch(() => {});
    }

    /** Press-and-release (or hold for nav buttons). */
    async pressKey(keyCode: AndroidKeyCode, holdMs = 0) {
        await this.#key(keyCode, AndroidKeyEventAction.Down);
        if (holdMs) await new Promise((r) => setTimeout(r, holdMs));
        await this.#key(keyCode, AndroidKeyEventAction.Up);
    }

    keyDown(keyCode: AndroidKeyCode) {
        return this.#key(keyCode, AndroidKeyEventAction.Down);
    }
    keyUp(keyCode: AndroidKeyCode) {
        return this.#key(keyCode, AndroidKeyEventAction.Up);
    }

    #onKey(e: KeyboardEvent, down: boolean) {
        if (this.suspended) return;
        const s = this.host.settings();
        if (isNuke(e)) {
            if (down) this.releaseAll();
            return; // let the browser close the tab / window
        }
        if (e.code === "AltRight") this.#altRight = down;
        // App hotkeys: Ctrl + Alt + key, global (work whatever has focus, also when captured).
        if (e.ctrlKey && e.altKey && !e.metaKey && !this.#altRight) {
            const hk = HOTKEYS.find((x) => x.code === e.code);
            if (hk) {
                e.preventDefault();
                e.stopPropagation();
                if (down && (!e.repeat || hk.repeat)) this.host.onHotkey(hk.action);
                return;
            }
        }
        // host key (VirtualBox-style)
        if (e.code === s.hostKey) {
            if (!this.active && !this.captured) return;
            e.preventDefault();
            e.stopPropagation();
            if (down) {
                if (!e.repeat) {
                    this.#hostDown = true;
                    this.#hostUsed = false;
                }
            } else {
                const tap = this.#hostDown && !this.#hostUsed;
                this.#hostDown = false;
                if (tap) void this.setCapture(!this.captured);
            }
            return;
        }
        if (this.#hostDown) {
            // the host key is tap-only; swallow anything pressed while it is held
            this.#hostUsed = true;
            e.preventDefault();
            return;
        }
        if (!this.active) {
            // a key released after focus moved away: still release it on the phone
            if (!down && this.#pressed.has(e.code)) this.#release(e.code);
            return;
        }
        // Paste: let the browser run its native paste (fires a `paste` event carrying the
        // clipboard text — no permission prompt), then main.ts forwards it to the phone.
        if (!this.pcMode && e.code === "KeyV" && (e.ctrlKey || e.metaKey) && !e.altKey && s.clipboardSync && this.#ctl()) {
            e.stopPropagation();
            if (down) {
                this.host.onPaste(e.shiftKey);
                this.#pressed.set(e.code, { kind: "none" });
            } else this.#pressed.delete(e.code);
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        if (!this.#ctl()) return;

        // Remapped soft keys (plain key, no Ctrl/Alt/Meta), in every keyboard mode.
        const prevMapped = this.#pressed.get(e.code);
        const mapping = !this.pcMode && !e.ctrlKey && !e.altKey && !e.metaKey ? s.keyMap.find((m) => m.code === e.code) : undefined;
        if (mapping || prevMapped?.kind === "mapped") {
            if (!down) {
                this.#release(e.code);
                return;
            }
            if (prevMapped) return; // auto-repeat: Android detects long-press from the held key itself
            const act = SOFT_KEY_ACTIONS.find((a) => a.id === mapping!.action);
            if (!act) return;
            if (act.panel) {
                const c = this.#ctl()!;
                void (act.panel === "notifications" ? c.expandNotificationPanel() : c.expandSettingPanel()).catch(() => {});
                this.#pressed.set(e.code, { kind: "none" });
            } else if (act.keyCode !== undefined) {
                this.#pressed.set(e.code, { kind: "mapped", keyCode: act.keyCode as AndroidKeyCode, repeat: 0 });
                void this.#key(act.keyCode as AndroidKeyCode, AndroidKeyEventAction.Down);
            }
            return;
        }

        if (this.#kbMode() === "uhid") {
            this.#uhidKey(e, down);
            return;
        }
        if (down) this.#sdkDown(e);
        else this.#release(e.code);
    }

    #sdkDown(e: KeyboardEvent) {
        const prev = this.#pressed.get(e.code);
        const meta = metaState(e);
        if (prev && prev.kind === "key") {
            prev.repeat++;
            void this.#key(prev.keyCode, AndroidKeyEventAction.Down, meta, prev.repeat);
            return;
        }
        if (prev && prev.kind === "text") {
            if (e.key.length === 1 || /^\p{L}$/u.test(e.key)) void this.#ctl()?.injectText(e.key).catch(() => {});
            return;
        }
        if (prev) return;

        if (MODIFIER_CODES.has(e.code)) {
            // Modifiers travel as meta state on the actual key events.
            this.#pressed.set(e.code, { kind: "none" });
            return;
        }
        const altGr = e.getModifierState("AltGraph");
        const chord = (e.ctrlKey || e.metaKey || e.altKey) && !altGr;
        const ch = e.key;
        const printable = [...ch].length === 1 && ch !== "Dead";
        let keyCode: AndroidKeyCode | undefined;

        if (printable && /^[a-zA-Z]$/.test(ch)) {
            keyCode = AndroidKeyCode[("Key" + ch.toUpperCase()) as keyof typeof AndroidKeyCode];
            // Case comes from the produced character, not from Shift/CapsLock state.
            const upper = ch !== ch.toLowerCase();
            this.#pressed.set(e.code, { kind: "key", keyCode, repeat: 0 });
            void this.#key(keyCode, AndroidKeyEventAction.Down, letterMeta(meta, upper), 0);
            return;
        } else if (printable && /^[0-9]$/.test(ch) && !e.shiftKey) {
            keyCode = AndroidKeyCode[("Digit" + ch) as keyof typeof AndroidKeyCode];
        } else if (ch === " ") {
            keyCode = AndroidKeyCode.Space;
        } else if (printable && !chord) {
            // punctuation, umlauts, AltGr symbols, emoji — inject as text so the PC layout is respected
            this.#pressed.set(e.code, { kind: "text" });
            void this.#ctl()?.injectText(ch).catch(() => {});
            return;
        } else {
            keyCode = AndroidKeyCode[e.code as keyof typeof AndroidKeyCode];
            if (keyCode === undefined && e.code === "NumpadEqual") keyCode = AndroidKeyCode.NumpadEquals;
        }
        if (keyCode === undefined || ch === "Dead") {
            this.#pressed.set(e.code, { kind: "none" });
            return;
        }
        this.#pressed.set(e.code, { kind: "key", keyCode, repeat: 0 });
        void this.#key(keyCode, AndroidKeyEventAction.Down, meta, 0);
    }

    #release(code: string) {
        const p = this.#pressed.get(code);
        this.#pressed.delete(code);
        if (!p) return;
        if (p.kind === "key" || p.kind === "mapped") void this.#key(p.keyCode, AndroidKeyEventAction.Up, 0, 0);
        if (p.kind === "uhid" && this.#hid.up(code)) this.#sendKeyboardReport();
    }

    async #ensureUhidKeyboard() {
        if (this.#uhidKeyboard) return;
        const c = this.#ctl();
        if (!c) return;
        this.#uhidKeyboard = true;
        await c.uHidCreate({ id: UHID_KEYBOARD_ID, vendorId: 0, productId: 0, name: "Annex Keyboard", data: KEYBOARD_DESCRIPTOR }).catch((e) => {
            this.#uhidKeyboard = false;
            this.host.onError("UHID keyboard is not supported on this phone: " + (e as Error).message);
        });
    }

    #uhidKey(e: KeyboardEvent, down: boolean) {
        void this.#ensureUhidKeyboard().then(() => {
            if (down) {
                if (this.#hid.down(e.code)) {
                    this.#pressed.set(e.code, { kind: "uhid" });
                    this.#sendKeyboardReport();
                }
            } else {
                this.#release(e.code);
            }
        });
    }

    #sendKeyboardReport() {
        void this.#ctl()?.uHidInput({ id: UHID_KEYBOARD_ID, data: this.#hid.report() }).catch(() => {});
    }

    releaseAll() {
        for (const code of [...this.#pressed.keys()]) this.#release(code);
        if (this.#hid.clear() && this.#uhidKeyboard) this.#sendKeyboardReport();
        this.#hostDown = false;
        if (this.#mouseButtons) {
            this.#mouseButtons = 0;
            this.#flushMouse(true);
        }
        if (this.#cursor.down) {
            this.#cursor.down = false;
            this.#touch(AndroidMotionEventAction.Up, ScrcpyPointerId.Finger, this.#cursor.x, this.#cursor.y, 0, 0, 0);
        }
    }

    // ---------------------------------------------------------------- capture
    async setCapture(on: boolean) {
        if (on === this.captured) return;
        if (on) {
            if (!this.#ctl()) return;
            try {
                // unadjustedMovement = raw mouse input without OS acceleration (Chrome)
                await (this.host.stage.requestPointerLock as (o?: unknown) => Promise<void>).call(this.host.stage, { unadjustedMovement: true });
            } catch {
                try {
                    await (this.host.stage.requestPointerLock as () => Promise<void>).call(this.host.stage);
                } catch (e) {
                    this.host.onError("The browser refused to capture the mouse. Click the phone screen first, then try again.");
                    return;
                }
            }
            // pointerlockchange completes the switch
        } else {
            if (document.pointerLockElement) document.exitPointerLock();
            else this.#onLockChange();
        }
    }

    #onLockChange() {
        const locked = document.pointerLockElement === this.host.stage;
        if (locked === this.captured) return;
        this.releaseAll();
        this.captured = locked;
        const s = this.host.settings();
        if (locked) {
            this.host.stage.focus({ preventScroll: true });
            if (this.#capMode() === "uhid") void this.#ensureUhidMouse();
            else {
                const { width, height } = this.host.videoSize();
                this.#cursor = { x: width / 2, y: height / 2, down: false };
                this.#drawCursor();
            }
        }
        this.host.cursor.hidden = !(locked && this.#capMode() === "cursor");
        void this.#syncKeyboardLock();
        this.host.onCaptureChange(locked);
    }

    async #syncKeyboardLock() {
        const kb = (navigator as Navigator & { keyboard?: { lock(c?: string[]): Promise<void>; unlock(): void } }).keyboard;
        if (!kb?.lock) return;
        try {
            // In our fullscreen, Escape is always locked: a tap goes to the phone (Back by default) and
            // only press-and-hold Esc leaves fullscreen (enforced by the browser, cannot be remapped).
            if (document.fullscreenElement) await kb.lock(this.captured ? LOCK_CODES : ["Escape"]);
            else kb.unlock();
        } catch {
            /* not allowed outside fullscreen */
        }
    }

    async #ensureUhidMouse() {
        if (this.#uhidMouse) return;
        const c = this.#ctl();
        if (!c) return;
        this.#uhidMouse = true;
        await c.uHidCreate({ id: UHID_MOUSE_ID, vendorId: 0, productId: 0, name: "Annex Mouse", data: MOUSE_DESCRIPTOR }).catch((e) => {
            this.#uhidMouse = false;
            this.host.onError("UHID mouse is not supported on this phone: " + (e as Error).message);
        });
    }

    #capturedMove(e: MouseEvent) {
        const s = this.host.settings();
        if (this.#capMode() === "uhid") {
            this.#acc.dx += e.movementX;
            this.#acc.dy += e.movementY;
            this.#scheduleMouse();
        } else {
            const r = this.host.canvasRect();
            const { width, height } = this.host.videoSize();
            const scale = width / Math.max(1, r.width);
            this.#cursor.x = Math.max(0, Math.min(width - 1, this.#cursor.x + e.movementX * scale));
            this.#cursor.y = Math.max(0, Math.min(height - 1, this.#cursor.y + e.movementY * scale));
            this.#drawCursor();
            if (this.#cursor.down) this.#touch(AndroidMotionEventAction.Move, ScrcpyPointerId.Finger, this.#cursor.x, this.#cursor.y, 1, 0, 0);
        }
    }

    #capturedButton(e: MouseEvent, down: boolean) {
        e.preventDefault();
        const s = this.host.settings();
        if (this.#capMode() === "uhid") {
            const bit = HID_BUTTON[e.button] ?? 0;
            this.#mouseButtons = down ? this.#mouseButtons | bit : this.#mouseButtons & ~bit;
            this.#flushMouse(true);
        } else if (e.button === 0) {
            this.#cursor.down = down;
            this.#touch(down ? AndroidMotionEventAction.Down : AndroidMotionEventAction.Up, ScrcpyPointerId.Finger, this.#cursor.x, this.#cursor.y, down ? 1 : 0, 0, 0);
        } else if (e.button === 2) {
            void this.#ctl()?.backOrScreenOn(down ? AndroidKeyEventAction.Down : AndroidKeyEventAction.Up);
        }
    }

    capturedWheel(e: WheelEvent) {
        if (!this.captured) return;
        e.preventDefault();
        if (this.#capMode() === "uhid") {
            const unit = e.deltaMode === 1 ? 3 : 100;
            this.#acc.wheel += -e.deltaY / unit;
            this.#acc.hwheel += e.deltaX / unit;
            this.#scheduleMouse();
        } else {
            const c = this.#ctl();
            const { width, height } = this.host.videoSize();
            const unit = e.deltaMode === 1 ? 3 : 100;
            void c?.injectScroll({ pointerX: this.#cursor.x, pointerY: this.#cursor.y, videoWidth: width, videoHeight: height, scrollX: Math.max(-1, Math.min(1, -e.deltaX / unit)), scrollY: Math.max(-1, Math.min(1, -e.deltaY / unit)), buttons: 0 }).catch(() => {});
        }
    }

    #scheduleMouse() {
        if (this.#acc.scheduled) return;
        this.#acc.scheduled = true;
        queueMicrotask(() => this.#flushMouse(false));
    }

    #flushMouse(force: boolean) {
        this.#acc.scheduled = false;
        const c = this.#ctl();
        if (!c || !this.#uhidMouse) {
            this.#acc.dx = this.#acc.dy = this.#acc.wheel = this.#acc.hwheel = 0;
            return;
        }
        let sent = false;
        while (force || Math.abs(this.#acc.dx) >= 1 || Math.abs(this.#acc.dy) >= 1 || Math.abs(this.#acc.wheel) >= 1 || Math.abs(this.#acc.hwheel) >= 1) {
            const dx = Math.max(-127, Math.min(127, Math.trunc(this.#acc.dx)));
            const dy = Math.max(-127, Math.min(127, Math.trunc(this.#acc.dy)));
            const w = Math.max(-1, Math.min(1, Math.trunc(this.#acc.wheel)));
            const hw = Math.max(-1, Math.min(1, Math.trunc(this.#acc.hwheel)));
            this.#acc.dx -= dx;
            this.#acc.dy -= dy;
            this.#acc.wheel -= w;
            this.#acc.hwheel -= hw;
            void c.uHidInput({ id: UHID_MOUSE_ID, data: mouseReport(this.#mouseButtons, dx, dy, w, hw) }).catch(() => {});
            sent = true;
            force = false;
            if (!dx && !dy && !w && !hw) break;
        }
        return sent;
    }

    #drawCursor() {
        const r = this.host.canvasRect();
        const { width, height } = this.host.videoSize();
        const st = this.host.stage.getBoundingClientRect();
        if (!width) return;
        const x = r.left - st.left + (this.#cursor.x / width) * r.width;
        const y = r.top - st.top + (this.#cursor.y / height) * r.height;
        this.host.cursor.style.transform = `translate(${x}px, ${y}px)`;
    }
}
