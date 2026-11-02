// In-page WebUSB mock: a fake ADB USB device whose bulk endpoints are relayed over a
// WebSocket to the fake adbd. Preserves USB packet framing (header and payload transfers).
(() => {
  const RELAY = "ws://127.0.0.1:15556";
  class MockConnectionEvent extends Event { constructor(t, init) { super(t); this.device = init?.device; } }
  window.USBConnectionEvent = MockConnectionEvent;
  class MockUSBDevice {
    constructor() {
      this.vendorId = 0x18d1; this.productId = 0x4ee7; this.productName = "Pixel 9 Pro"; this.manufacturerName = "Google"; this.serialNumber = "FAKE123";
      this.opened = false;
      const alt = { alternateSetting: 0, interfaceClass: 0xff, interfaceSubclass: 0x42, interfaceProtocol: 1,
        endpoints: [{ endpointNumber: 1, direction: "in", type: "bulk", packetSize: 512 }, { endpointNumber: 2, direction: "out", type: "bulk", packetSize: 512 }] };
      this.configurations = [{ configurationValue: 1, interfaces: [{ interfaceNumber: 0, alternate: alt, alternates: [alt], claimed: false }] }];
      this.configuration = null;
      this._buf = new Uint8Array(0); this._waiters = []; this._payload = 0;
    }
    async open() {
      if (window.__usbBusy) { const e = new Error("busy"); e.name = "NetworkError"; throw e; }
      this._buf = new Uint8Array(0); this._payload = 0;
      this.ws = new WebSocket(RELAY); this.ws.binaryType = "arraybuffer";
      await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
      this.ws.onmessage = (e) => { const d = new Uint8Array(e.data); const m = new Uint8Array(this._buf.length + d.length); m.set(this._buf); m.set(d, this._buf.length); this._buf = m; this._wake(); };
      this.ws.onclose = () => { this._closed = true; this._wake(); };
      this._closed = false; this.opened = true;
    }
    _wake() { const w = this._waiters; this._waiters = []; w.forEach((f) => f()); }
    async selectConfiguration() { this.configuration = this.configurations[0]; }
    async claimInterface() { this.configurations[0].interfaces[0].claimed = true; }
    async releaseInterface() { this.configurations[0].interfaces[0].claimed = false; }
    async selectAlternateInterface() {}
    async transferIn(ep, len) {
      const need = this._payload || 24;
      while (this._buf.length < need) {
        if (this._closed) { const e = new Error("disconnected"); e.name = "NetworkError"; throw e; }
        await new Promise((r) => this._waiters.push(r));
      }
      const out = this._buf.slice(0, need);
      this._buf = this._buf.slice(need);
      if (this._payload) this._payload = 0;
      else this._payload = new DataView(out.buffer).getUint32(12, true);
      return { status: "ok", data: new DataView(out.buffer) };
    }
    async transferOut(ep, data) {
      const u = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (u.length) this.ws.send(u.slice());
      return { status: "ok", bytesWritten: u.length };
    }
    async close() { this.opened = false; this.configurations[0].interfaces[0].claimed = false; try { this.ws?.close(); } catch {} }
    async reset() {}
  }
  const device = new MockUSBDevice();
  class MockUSB extends EventTarget {
    async getDevices() { return localStorage.getItem("mockUsbGranted") ? [device] : []; }
    async requestDevice() { localStorage.setItem("mockUsbGranted", "1"); return device; }
  }
  const usb = new MockUSB();
  Object.defineProperty(Navigator.prototype, "usb", { get: () => usb, configurable: true });
  window.__mockUsbDevice = device;
})();
