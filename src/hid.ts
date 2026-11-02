// USB HID descriptors and usage tables for the UHID keyboard/mouse (scrcpy UHID_CREATE/UHID_INPUT).

// Boot-protocol keyboard: [modifiers, reserved, k1..k6]
export const KEYBOARD_DESCRIPTOR = new Uint8Array([
    0x05, 0x01, 0x09, 0x06, 0xa1, 0x01,
    0x05, 0x07, 0x19, 0xe0, 0x29, 0xe7, 0x15, 0x00, 0x25, 0x01, 0x75, 0x01, 0x95, 0x08, 0x81, 0x02,
    0x95, 0x01, 0x75, 0x08, 0x81, 0x01,
    0x05, 0x08, 0x19, 0x01, 0x29, 0x05, 0x95, 0x05, 0x75, 0x01, 0x91, 0x02,
    0x95, 0x01, 0x75, 0x03, 0x91, 0x01,
    0x05, 0x07, 0x19, 0x00, 0x29, 0x65, 0x15, 0x00, 0x25, 0x65, 0x95, 0x06, 0x75, 0x08, 0x81, 0x00,
    0xc0,
]);

// Relative mouse: [buttons(5 bits)+pad, dx, dy, wheel, hwheel]
export const MOUSE_DESCRIPTOR = new Uint8Array([
    0x05, 0x01, 0x09, 0x02, 0xa1, 0x01,
    0x09, 0x01, 0xa1, 0x00,
    0x05, 0x09, 0x19, 0x01, 0x29, 0x05, 0x15, 0x00, 0x25, 0x01, 0x95, 0x05, 0x75, 0x01, 0x81, 0x02,
    0x95, 0x01, 0x75, 0x03, 0x81, 0x01,
    0x05, 0x01, 0x09, 0x30, 0x09, 0x31, 0x09, 0x38, 0x15, 0x81, 0x25, 0x7f, 0x75, 0x08, 0x95, 0x03, 0x81, 0x06,
    0x05, 0x0c, 0x0a, 0x38, 0x02, 0x15, 0x81, 0x25, 0x7f, 0x75, 0x08, 0x95, 0x01, 0x81, 0x06,
    0xc0, 0xc0,
]);

export const HID_MODIFIER_BITS: Record<string, number> = {
    ControlLeft: 0x01, ShiftLeft: 0x02, AltLeft: 0x04, MetaLeft: 0x08,
    ControlRight: 0x10, ShiftRight: 0x20, AltRight: 0x40, MetaRight: 0x80,
};

export const HID_USAGE: Record<string, number> = (() => {
    const m: Record<string, number> = {};
    for (let i = 0; i < 26; i++) m["Key" + String.fromCharCode(65 + i)] = 0x04 + i;
    for (let i = 1; i <= 9; i++) m["Digit" + i] = 0x1e + i - 1;
    m.Digit0 = 0x27;
    Object.assign(m, {
        Enter: 0x28, Escape: 0x29, Backspace: 0x2a, Tab: 0x2b, Space: 0x2c, Minus: 0x2d, Equal: 0x2e,
        BracketLeft: 0x2f, BracketRight: 0x30, Backslash: 0x31, IntlHash: 0x32, Semicolon: 0x33, Quote: 0x34,
        Backquote: 0x35, Comma: 0x36, Period: 0x37, Slash: 0x38, CapsLock: 0x39,
        PrintScreen: 0x46, ScrollLock: 0x47, Pause: 0x48, Insert: 0x49, Home: 0x4a, PageUp: 0x4b,
        Delete: 0x4c, End: 0x4d, PageDown: 0x4e, ArrowRight: 0x4f, ArrowLeft: 0x50, ArrowDown: 0x51, ArrowUp: 0x52,
        NumLock: 0x53, NumpadDivide: 0x54, NumpadMultiply: 0x55, NumpadSubtract: 0x56, NumpadAdd: 0x57, NumpadEnter: 0x58,
        Numpad1: 0x59, Numpad2: 0x5a, Numpad3: 0x5b, Numpad4: 0x5c, Numpad5: 0x5d, Numpad6: 0x5e, Numpad7: 0x5f,
        Numpad8: 0x60, Numpad9: 0x61, Numpad0: 0x62, NumpadDecimal: 0x63, IntlBackslash: 0x64, ContextMenu: 0x65,
        NumpadEqual: 0x67, IntlRo: 0x87, IntlYen: 0x89,
    });
    for (let i = 1; i <= 12; i++) m["F" + i] = 0x3a + i - 1;
    return m;
})();

export class HidKeyboardState {
    #mods = 0;
    #keys: number[] = [];

    /** Returns true when the report changed. */
    down(code: string): boolean {
        const bit = HID_MODIFIER_BITS[code];
        if (bit) {
            if (this.#mods & bit) return false;
            this.#mods |= bit;
            return true;
        }
        const u = HID_USAGE[code];
        if (!u || this.#keys.includes(u)) return false;
        if (this.#keys.length >= 6) this.#keys.shift();
        this.#keys.push(u);
        return true;
    }

    up(code: string): boolean {
        const bit = HID_MODIFIER_BITS[code];
        if (bit) {
            if (!(this.#mods & bit)) return false;
            this.#mods &= ~bit;
            return true;
        }
        const u = HID_USAGE[code];
        const i = this.#keys.indexOf(u);
        if (i < 0) return false;
        this.#keys.splice(i, 1);
        return true;
    }

    clear(): boolean {
        const had = this.#mods !== 0 || this.#keys.length > 0;
        this.#mods = 0;
        this.#keys = [];
        return had;
    }

    report(): Uint8Array {
        const r = new Uint8Array(8);
        r[0] = this.#mods;
        this.#keys.forEach((k, i) => (r[2 + i] = k));
        return r;
    }
}

export function mouseReport(buttons: number, dx: number, dy: number, wheel = 0, hwheel = 0) {
    const c = (v: number) => Math.max(-127, Math.min(127, Math.round(v)));
    return new Uint8Array([buttons & 0x1f, c(dx) & 0xff, c(dy) & 0xff, c(wheel) & 0xff, c(hwheel) & 0xff]);
}

/** DOM MouseEvent.button -> HID button bit */
export const HID_BUTTON = [0x01, 0x04, 0x02, 0x08, 0x10];
