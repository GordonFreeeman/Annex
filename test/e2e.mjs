// End-to-end test: real page (dist/annex.html) in Chromium ↔ WebUSB mock / real encrypted bridge ↔ fake device.
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright-core");
import fs from "node:fs";
import path from "node:path";
import { startTcp, startUsbRelay, events, sandboxRoot, device } from "./fake-device.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const OUT = process.env.SHOTS || "/tmp/annex-shots";
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const S = process.env.SMALL ? 0.5 : 1; const PW = 720 * S, PH = 1600 * S, LW = 1600 * S, LH = 720 * S;
const ok = (name, cond, extra = "") => { results.push([cond ? "PASS" : "FAIL", name, extra]); console.log(cond ? "  ✓" : "  ✗", name, extra); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const since = (t0, type) => events.filter((e) => e.t >= t0 && e.type === type);
async function waitFor(fn, ms = 8000, step = 50) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(step); } return null; }

await startTcp(15555);
startUsbRelay(15556);

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ["--autoplay-policy=no-user-gesture-required", "--no-proxy-server"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, deviceScaleFactor: 1 });
await ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
await ctx.addInitScript({ path: path.join(HERE, "usb-mock.js") });
await ctx.addInitScript(() => { window.__kbLocks = []; if (navigator.keyboard) { navigator.keyboard.lock = async (c) => { window.__kbLocks.push(c ? [...c] : ["*"]); }; navigator.keyboard.unlock = () => window.__kbLocks.push("unlock"); } });
await ctx.addInitScript(() => { delete window.showSaveFilePicker; const r = navigator.clipboard.readText.bind(navigator.clipboard); window.__readTextCalls = 0; navigator.clipboard.readText = () => { window.__readTextCalls++; return r(); }; }); // headless can't show native pickers
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => { pageErrors.push(String(e)); console.log("[pageerror]", e); });
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log(`[console.${m.type()}]`, m.text().slice(0, 300)); });
const failedRequests = [];
page.on("requestfailed", (r) => failedRequests.push(r.url()));
page.on("request", (r) => { if (!/^(file|data|blob|ws):/.test(r.url())) failedRequests.push("EXTERNAL " + r.url()); });

await page.goto("file://" + path.resolve(HERE, "../dist/annex.html"));
await sleep(600);
await page.screenshot({ path: `${OUT}/01-welcome.png` });
ok("welcome renders", await page.isVisible("#btnUsb"));
ok("capability checks all ok", (await page.locator(".check-pill.bad").count()) === 0);

// ------------------------------------------------------------------ USB connect
console.log("USB");
let t0 = Date.now();
await page.click("#btnUsb");
const size = await waitFor(() => page.evaluate(() => window.annex.session?.width && `${window.annex.session.width}x${window.annex.session.height}`), 20000);
ok("USB: stream starts", !!size, size ?? "");
ok("USB: server pushed via sync", since(t0, "sync-send").some((e) => /annex-scrcpy-3\.3\.jar/.test(e.path)));
ok("USB: CBR + constant 60 fps codec options", (() => { const s = since(t0, "scrcpy-start")[0]; return s?.opts.video_codec_options === "bitrate-mode:int=2,repeat-previous-frame-after:long=16667"; })(), since(t0, "scrcpy-start")[0]?.opts.video_codec_options);
ok("USB: scrcpy args", (() => { const s = since(t0, "scrcpy-start")[0]; return s && s.opts.tunnel_forward === "true" && s.opts.audio_codec === "raw" && s.opts.max_fps === "60"; })());
await sleep(1500);
const frames = await page.evaluate(() => window.annex.session?.decoder?.framesRendered ?? 0);
ok("USB: frames decoded & rendered", frames > 40, `frames=${frames}`);
ok("USB: link badge", (await page.textContent("#linkBadge")) === "USB");
ok("USB: audio player running (raw)", await page.evaluate(() => window.annex.session?.audio?.codecName === "raw"));
await page.mouse.click(5, 300);
await sleep(800);
{ const a = await page.evaluate(() => { const x = window.annex.session.audio; return { n: x.samplesIn, l: x.level(), st: x.state }; }); ok("USB: audio samples arrive and play (level > 0)", a.n > 20000 && a.l > 0.01 && a.st === "running", JSON.stringify(a)); }
await page.screenshot({ path: `${OUT}/02-usb-mirroring.png` });

// ------------------------------------------------------------------ pointer
const canvas = page.locator("#screen canvas");
let box = await canvas.boundingBox();
t0 = Date.now();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await sleep(200);
let touches = since(t0, "touch");
const down = touches.find((e) => e.action === 0);
ok("click → finger tap (touch mode) at centre", !!down && touches.some((e) => e.action === 1) && Math.abs(down.x - PW / 2) < 3 && Math.abs(down.y - PH / 2) < 3 && down.w === PW && down.h === PH && down.pointerId === "-2" && down.actionButton === 0, JSON.stringify(down));
t0 = Date.now();
await page.mouse.move(box.x + 50, box.y + 100);
await page.mouse.down();
await page.mouse.move(box.x + 50, box.y + 300, { steps: 5 });
await page.mouse.up();
await sleep(150);
touches = since(t0, "touch");
ok("drag → move events", touches.filter((e) => e.action === 2).length >= 4);
t0 = Date.now();
await page.mouse.click(box.x + 100, box.y + 100, { button: "right" });
await sleep(150);
ok("right click → back", since(t0, "back-or-screen-on").length === 2);
t0 = Date.now();
await page.mouse.move(box.x + 200, box.y + 200);
await page.mouse.wheel(0, 100);
await sleep(150);
const sc = since(t0, "scroll")[0];
ok("wheel → scroll -1 notch", !!sc && sc.vs === -32768, JSON.stringify(sc));
t0 = Date.now();
await page.keyboard.down("Control");
await page.mouse.move(box.x + 100, box.y + 150);
await page.mouse.down();
await page.mouse.move(box.x + 60, box.y + 120, { steps: 3 });
await page.mouse.up();
await page.keyboard.up("Control");
await sleep(150);
{ const ids = new Set(since(t0, "touch").map((e) => e.pointerId)); ok("ctrl+drag → two-finger pinch", ids.has("-2") && ids.has("-4") && !ids.has("-1"), [...ids].join(",")); }

// ------------------------------------------------------------------ keyboard
t0 = Date.now();
await page.keyboard.type("Hi!");
await page.keyboard.press("Enter");
await sleep(200);
const keys = since(t0, "key");
const texts = since(t0, "text");
ok("typing letters → keycodes w/ shift meta", keys.some((k) => k.keyCode === 36 && k.action === 0 && (k.meta & 1)) && keys.some((k) => k.keyCode === 37 && k.action === 0), JSON.stringify(keys.slice(0, 4)));
ok("punctuation → text injection", texts.some((t) => t.text === "!"));
ok("Enter → keycode 66 down+up", keys.filter((k) => k.keyCode === 66).length === 2);
t0 = Date.now();
await page.keyboard.press("Control+Alt+Home");
await sleep(200);
ok("Ctrl+Alt+Home → HOME", since(t0, "key").filter((k) => k.keyCode === 3).length === 2 && !since(t0, "key").some((k) => k.keyCode === 122));
t0 = Date.now();
await page.mouse.click(box.x + 60, box.y + 60, { button: "middle" });
await sleep(200);
ok("middle click → HOME", since(t0, "key").filter((k) => k.keyCode === 3).length === 2 && !since(t0, "touch").length);
await page.keyboard.press("Control+Alt+KeyH");
await sleep(200);
ok("Ctrl+Alt+H → hotkey help popup", await page.isVisible("dialog.hotkeys"));
await page.screenshot({ path: `${OUT}/02b-hotkeys.png` });
t0 = Date.now();
await page.keyboard.press("Escape");
await sleep(200);
ok("Esc closes help without sending Back", !(await page.isVisible("dialog.hotkeys")) && !since(t0, "key").some((k) => k.keyCode === 4));
// AltGr (Windows: Ctrl + AltRight) must not trigger hotkeys
await canvas.click({ position: { x: 20, y: 20 } });
await page.keyboard.down("Control"); await page.keyboard.down("AltRight"); await page.keyboard.press("KeyH"); await page.keyboard.up("AltRight"); await page.keyboard.up("Control");
await sleep(150);
ok("AltGr+H does not open help", !(await page.isVisible("dialog.hotkeys")));
// OG Gaming mode
await page.keyboard.press("Control+Alt+KeyG");
await sleep(150);
ok("Ctrl+Alt+G → OG Gaming mode", await page.evaluate(() => window.annex.settings.inputMode === "pc") && (await page.getAttribute("#btnGaming", "class")).includes("on"));
t0 = Date.now();
await page.mouse.click(box.x + 80, box.y + 80);
await page.mouse.click(box.x + 80, box.y + 80, { button: "right" });
await page.mouse.click(box.x + 80, box.y + 80, { button: "middle" });
await page.mouse.move(box.x + 120, box.y + 140);
await sleep(250);
{ const t = since(t0, "touch"); const downs = t.filter((e) => e.action === 0);
  ok("gaming: LMB/RMB/MMB sent as real mouse buttons", downs.length === 3 && downs.every((e) => e.pointerId === "-1") && downs.map((e) => e.actionButton).join() === "1,2,4" && !since(t0, "back-or-screen-on").length && !since(t0, "key").length, JSON.stringify(downs.map((e) => [e.pointerId, e.actionButton, e.buttons])));
  ok("gaming: hover moves", t.some((e) => e.action === 7)); }
t0 = Date.now();
await page.keyboard.press("Escape");
await page.keyboard.press("KeyW");
await sleep(250);
{ const u = since(t0, "uhid-input").filter((e) => e.id === 1);
  ok("gaming: keyboard is HID, Esc goes to the game", since(t0, "uhid-create").some((e) => e.id === 1) || u.length, JSON.stringify(u.slice(0, 2)));
  ok("gaming: Esc not mapped to Back", !since(t0, "key").some((k) => k.keyCode === 4) && u.some((e) => e.data[2] === 0x29) && u.some((e) => e.data[2] === 0x1a)); }
await page.keyboard.press("Control+Alt+KeyG");
await sleep(150);
ok("Ctrl+Alt+G again → touch mode", await page.evaluate(() => window.annex.settings.inputMode === "touch"));
t0 = Date.now();
await page.keyboard.press("Control+KeyA");
await sleep(150);
const ca = since(t0, "key").find((k) => k.keyCode === 29);
ok("Ctrl+A → keycode A with ctrl meta", !!ca && (ca.meta & 0x1000) !== 0);

// soft keys: Esc → Back by default
await canvas.click({ position: { x: 20, y: 20 } });
t0 = Date.now();
await page.keyboard.press("Escape");
await sleep(200);
{ const k = since(t0, "key").map((e) => e.keyCode); ok("Esc → Android BACK (soft key)", k.filter((c) => c === 4).length === 2 && !k.includes(111), k.join(",")); }
// remap via settings UI: add F2 → Home
await page.click('.rail-btn[data-panel="settings"]');
await page.click("#btnAddMap");
await page.keyboard.press("F2");
await sleep(100);
ok("soft key recorded in settings", (await page.locator(".km-key").last().textContent()) === "F2");
await page.locator(".km-row").last().locator("select").selectOption("recents");
await page.click('.rail-btn[data-panel="settings"]');
await canvas.click({ position: { x: 20, y: 20 } });
t0 = Date.now();
await page.keyboard.press("F2");
await sleep(200);
{ const k = since(t0, "key").map((e) => e.keyCode); ok("remapped F2 → RECENTS", k.filter((c) => c === 187).length === 2 && !k.includes(132), k.join(",")); }
// fullscreen locks Escape so only a long press leaves it
await page.click("#btnFullscreen");
await sleep(400);
const fsOn = await page.evaluate(() => !!document.fullscreenElement);
const locks = await page.evaluate(() => window.__kbLocks);
ok("fullscreen → keyboard.lock(['Escape'])", fsOn && locks.some((l) => Array.isArray(l) && l.length === 1 && l[0] === "Escape"), JSON.stringify(locks));
t0 = Date.now();
await page.click("#navHome");
await page.keyboard.press("Escape");
await sleep(200);
ok("fullscreen: Esc reaches phone even after clicking the dock", since(t0, "key").filter((e) => e.keyCode === 4).length === 2);
await page.evaluate(() => document.exitFullscreen());
await sleep(300);

// nav dock
t0 = Date.now();
await page.click("#navHome");
await page.click("#navBack");
await page.click("#navRecents");
await sleep(200);
const navKeys = since(t0, "key").map((k) => k.keyCode);
ok("dock buttons → HOME/BACK/APP_SWITCH", [3, 4, 187].every((c) => navKeys.filter((x) => x === c).length === 2), navKeys.join(","));
t0 = Date.now();
await page.click("#btnScreenOff");
await sleep(150);
ok("screen off button", since(t0, "display-power").some((e) => e.on === 0));
await page.click("#btnScreenOff");

// ------------------------------------------------------------------ clipboard
t0 = Date.now();
await page.evaluate(() => navigator.clipboard.writeText("from the pc"));
await canvas.click({ position: { x: 20, y: 20 } });
await page.keyboard.press("Control+KeyV");
await sleep(300);
const sc2 = since(t0, "set-clipboard").find((e) => e.paste === 1);
ok("Ctrl+V → set clipboard + paste", !!sc2 && sc2.text === "from the pc", JSON.stringify(since(t0, "set-clipboard")));
await page.evaluate(() => window.annex.session.controller.injectText("annex-clip-test"));
const pc = await waitFor(() => page.evaluate(() => (window.__testReads = (window.__testReads || 0) + 1, navigator.clipboard.readText()).catch(() => "")).then((t) => t === "Hello from phone" && t), 3000);
ok("phone clipboard → PC clipboard", !!pc);

// ------------------------------------------------------------------ rotation
t0 = Date.now();
await page.click("#navRotate");
const rot = await waitFor(() => page.evaluate(`window.annex.session.width === ${LW} && window.annex.session.height === ${LH}`), 5000);
ok("rotate → locks rotation via shell (not scrcpy ROTATE_DEVICE)", since(t0, "user-rotation").some((e) => e.rotation === 1) && !since(t0, "rotate").length);
ok("rotate → landscape stream 1600x720 relayout", !!rot);
await sleep(800);
box = await canvas.boundingBox();
ok("landscape canvas aspect", Math.abs(box.width / box.height - LW / LH) < 0.02, `${box.width}x${box.height}`);
await page.screenshot({ path: `${OUT}/03-landscape.png` });
t0 = Date.now();
await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.5);
await sleep(150);
const lt = since(t0, "touch")[0];
ok("landscape touch mapping", !!lt && lt.w === LW && lt.h === LH && Math.abs(lt.x - LW / 4) < 4 && Math.abs(lt.y - LH / 2) < 4, JSON.stringify(lt));
await page.click("#navRotate");
await waitFor(() => page.evaluate(`window.annex.session.width === ${PW}`), 5000);

// ------------------------------------------------------------------ stats, screenshot
await page.click("#btnStats");
await sleep(1300);
const statsTxt = await page.textContent("#stats");
ok("stats overlay shows fps", /\d+ fps/.test(statsTxt ?? ""), (statsTxt ?? "").replace(/\n/g, " | "));
await page.click("#btnStats");
const [shot] = await Promise.all([page.waitForEvent("download", { timeout: 5000 }).catch(() => null), page.click("#btnShot")]);
ok("screenshot downloads PNG", !!shot && /\.png$/.test(shot.suggestedFilename()));
if (shot) { const p = await shot.path(); const b = fs.readFileSync(p); ok("screenshot is a real PNG", b.length > 1000 && b[1] === 0x50 && b[2] === 0x4e); }

// recording (short)
await page.click("#btnRecord");
await sleep(1500);
const [rec] = await Promise.all([page.waitForEvent("download", { timeout: 8000 }).catch(() => null), page.click("#btnRecord")]);
ok("recording downloads video", !!rec && /\.(webm|mp4)$/.test(rec.suggestedFilename()), rec?.suggestedFilename());
if (rec) ok("recording has data", fs.statSync(await rec.path()).size > 5000, String(fs.statSync(await rec.path()).size));

// ------------------------------------------------------------------ files
await page.click('.rail-btn[data-panel="files"]');
await page.waitForSelector(".file-row", { timeout: 5000 }).catch(() => {});
const names = await page.$$eval(".file-row .fn", (els) => els.map((e) => e.textContent));
ok("files: lists /sdcard", names.includes("Download") && names.includes("DCIM"), names.join(","));
await page.locator(".file-row", { hasText: "Download" }).dblclick();
await page.waitForSelector('.file-row:has-text("readme.txt")', { timeout: 5000 }).catch(() => {});
ok("files: navigate into Download", (await page.inputValue(".path-input")) === "/sdcard/Download/");
await page.screenshot({ path: `${OUT}/04-files.png` });
const row = page.locator(".file-row", { hasText: "readme.txt" });
await row.hover();
const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 5000 }).catch(() => null), row.locator('button[title="Download"]').click()]);
ok("files: download readme.txt", !!dl && fs.readFileSync(await dl.path(), "utf8") === "hello from the fake phone\n");
const upPath = "/tmp/annex-upload-test.bin";
fs.writeFileSync(upPath, Buffer.alloc(700 * 1024, 7));
await page.setInputFiles('#panel-files input[type="file"]', upPath);
const upOk = await waitFor(() => fs.existsSync(path.join(sandboxRoot, "sdcard/Download/annex-upload-test.bin")) && fs.statSync(path.join(sandboxRoot, "sdcard/Download/annex-upload-test.bin")).size === 700 * 1024, 8000);
ok("files: upload 700 KB", !!upOk);
await waitFor(() => page.locator('.file-row:has-text("annex-upload-test.bin")').count(), 4000);
ok("files: list refreshed after upload", (await page.locator('.file-row:has-text("annex-upload-test.bin")').count()) === 1);
// folder download as tar
await page.click('.chip:has-text("Internal storage")');
await page.waitForSelector('.file-row:has-text("DCIM")');
const dcim = page.locator(".file-row", { hasText: "DCIM" });
await dcim.hover();
const [tar] = await Promise.all([page.waitForEvent("download", { timeout: 8000 }).catch(() => null), dcim.locator('button[title="Download as .tar"]').click()]);
ok("files: folder download as .tar", !!tar && fs.statSync(await tar.path()).size > 150000, tar ? String(fs.statSync(await tar.path()).size) : "");
// apk install via drop handler path
t0 = Date.now();
fs.writeFileSync("/tmp/test-app.apk", Buffer.alloc(4096, 1));
await page.setInputFiles('#panel-files input[type="file"]', "/tmp/test-app.apk");
const inst = await waitFor(() => since(t0, "shell").find((e) => /pm install -r -t/.test(e.command)), 6000);
ok("files: APK → pm install", !!inst);

// ------------------------------------------------------------------ apps
await page.click('.rail-btn[data-panel="apps"]');
await page.waitForSelector(".app-tile", { timeout: 8000 }).catch(() => {});
const apps = await page.$$eval(".app-name", (els) => els.map((e) => e.textContent));
ok("apps: real launcher labels incl. system drawer apps", ["Chrome", "Einstellungen", "Spotify", "Google", "Sprachsuche"].every((n) => apps.includes(n)), apps.join(","));
ok("apps: real icons shown", (await page.locator(".app-tile img.app-icon").count()) === 4);
t0 = Date.now();
await page.click('.app-tile:has-text("Sprachsuche")');
await sleep(300);
ok("apps: multi-entry package opens exact activity", since(t0, "shell").some((e) => /am start -n 'com.google.android.googlequicksearchbox\/com.google.android.apps.gsa.binaries.velvet.VoiceActivity'/.test(e.command)));
device.appListFails = true;
await page.click('.apps-toolbar button[title="Reload list"]');
await page.waitForSelector('.app-tile:has-text("Firefox Nightly")', { timeout: 8000 }).catch(() => {});
await page.click("label.sys-toggle");
await sleep(200);
const apps2 = await page.$$eval(".app-name", (els) => els.map((e) => e.textContent));
ok("apps: fallback parses scrcpy list incl. long names", apps2.includes("Microsoft Authenticator: Passwords") && apps2.includes("Firefox Nightly"), apps2.join(","));
await page.click("label.sys-toggle");
device.appListFails = false;
await page.click('.apps-toolbar button[title="Reload list"]');
await page.waitForSelector('.app-tile:has-text("Einstellungen")', { timeout: 8000 }).catch(() => {});
await page.screenshot({ path: `${OUT}/05-apps.png` });
t0 = Date.now();
await page.click('.app-tile:has-text("Spotify")');
await sleep(300);
ok("apps: launch via START_APP", since(t0, "start-app").some((e) => e.name === "com.spotify.music"), JSON.stringify(since(t0, "start-app")));

// ------------------------------------------------------------------ shell
await page.click('.rail-btn[data-panel="shell"]');
await page.fill("#panel-shell input", "echo annex-shell-ok; echo oops >&2; exit 3");
await page.press("#panel-shell input", "Enter");
await waitFor(() => page.textContent(".shell-out").then((t) => t.includes("[exit 3]")), 5000);
const shellOut = await page.textContent(".shell-out");
ok("shell: stdout/stderr/exit (shell v2)", shellOut.includes("annex-shell-ok") && shellOut.includes("oops") && shellOut.includes("[exit 3]"), shellOut.slice(0, 200));
await page.screenshot({ path: `${OUT}/06-shell.png` });

// ------------------------------------------------------------------ settings + restart
await page.click('.rail-btn[data-panel="settings"]');
await page.selectOption('select[data-setting="maxSize"]', "1280");
ok("settings: apply bar appears", await page.isVisible("#applyBar"));
await page.screenshot({ path: `${OUT}/07-settings.png` });
t0 = Date.now();
await page.click("#btnApply");
const restarted = await waitFor(() => since(t0, "scrcpy-start")[0], 8000);
ok("settings: restart with max_size=1280", restarted?.opts.max_size === "1280");
await waitFor(() => page.evaluate(() => window.annex.session?.width > 0), 8000);
await page.selectOption('select[data-setting="keyboardMode"]', "uhid");
await canvas.click({ position: { x: 30, y: 30 } });
t0 = Date.now();
await page.keyboard.press("KeyQ");
await sleep(200);
ok("UHID keyboard: create + reports", since(t0, "uhid-create").some((e) => e.id === 1 && e.descLen > 40) && since(t0, "uhid-input").some((e) => e.data[2] === 0x14), JSON.stringify(since(t0, "uhid-input").slice(0, 2)));
await page.selectOption('select[data-setting="keyboardMode"]', "sdk");

// capture (pointer lock may be unavailable headless)
await canvas.click({ position: { x: 30, y: 30 } });
await page.evaluate(() => window.annex.input.setCapture(true));
await sleep(300);
const captured = await page.evaluate(() => window.annex.input.captured);
if (captured) {
    t0 = Date.now();
    await page.mouse.move(700, 400);
    await page.mouse.move(760, 430);
    await page.mouse.down();
    await page.mouse.up();
    await sleep(200);
    ok("capture: UHID mouse created + movement", since(t0, "uhid-create").some((e) => e.id === 2) || since(t0, "uhid-input").some((e) => e.id === 2));
    await page.keyboard.down("ControlRight");
    await page.keyboard.up("ControlRight");
    await sleep(200);
    ok("capture: host key tap releases", !(await page.evaluate(() => window.annex.input.captured)));
} else {
    console.log("  (pointer lock unavailable in headless — capture test skipped)");
}

// phone that sends no audio from the default source → retry with playback capture
device.silentAudio = true;
t0 = Date.now();
await page.evaluate(() => document.getElementById("navRestart").click());
const pb = await waitFor(() => since(t0, "scrcpy-start").find((e) => e.opts.audio_source === "playback"), 12000, 200);
ok("silent audio → automatic retry with audio_source=playback", !!pb);
await sleep(1500);
ok("playback fallback delivers audio", await page.evaluate(() => (window.annex.session?.audio?.samplesIn ?? 0) > 10000));
device.silentAudio = false;
await page.evaluate((k) => localStorage.removeItem(k), "annex.pref.audioPlayback:FAKE123");

// encoder that rejects codec options → automatic fallback
device.rejectCodecOptions = true;
t0 = Date.now();
await page.evaluate(() => document.getElementById("navRestart").click());
const fb = await waitFor(() => { const st = since(t0, "scrcpy-start"); return st.length >= 2 && !st[st.length - 1].opts.video_codec_options && st; }, 10000);
ok("encoder rejects CBR/fps options → restarts without them", !!fb);
ok("fallback stream runs", !!(await waitFor(() => page.evaluate(() => (window.annex.session?.decoder?.framesRendered ?? 0) > 5), 8000)));
device.rejectCodecOptions = false;
await page.evaluate((k) => localStorage.removeItem(k), "annex.pref.noCodecOpts:FAKE123");

// ------------------------------------------------------------------ Wi-Fi mode via the real bridge
console.log("Wi-Fi");
await page.click('.rail-btn[data-panel="device"]');
await page.screenshot({ path: `${OUT}/08-device.png` });
t0 = Date.now();
await page.click("#btnWifiOn");
const wifi = await waitFor(() => page.evaluate(() => window.annex.dev?.kind === "wifi" && window.annex.session?.width > 0), 25000, 200);
ok("Wi-Fi: bridge started, encrypted link up, streaming", !!wifi);
const bs = since(t0, "bridge-start")[0];
ok("Wi-Fi: key file pushed with 0600", bs?.keyMode === "600", JSON.stringify(bs));
ok("Wi-Fi: adbd switched to tcpip", since(t0, "open").some((e) => /^tcpip:5555/.test(e.service)));
ok("Wi-Fi: ADB handshake over bridge (tcp)", since(t0, "cnxn").some((e) => e.label === "tcp"));
ok("Wi-Fi: link badge", (await page.textContent("#linkBadge")) === "Wi‑Fi");
await sleep(1500);
const wf = await page.evaluate(() => ({ f: window.annex.session?.decoder?.framesRendered, a: window.annex.session?.audio?.codecName }));
ok("Wi-Fi: frames decoded over encrypted link", wf.f > 40, JSON.stringify(wf));
ok("Wi-Fi: audio auto = opus", wf.a === "opus");
{ const a = await page.evaluate(() => { const x = window.annex.session.audio; return { n: x.samplesIn, l: x.level() }; }); ok("Wi-Fi: opus decodes and plays", a.n > 20000 && a.l > 0.01, JSON.stringify(a)); }
await page.screenshot({ path: `${OUT}/09-wifi.png` });
t0 = Date.now();
await canvas.click({ position: { x: 100, y: 100 } });
await sleep(200);
ok("Wi-Fi: input works", since(t0, "touch").length >= 2);

// disconnect + reconnect from welcome
await page.click("#btnDisconnect");
await sleep(500);
ok("disconnect → welcome", await page.isVisible("#btnUsb"));
ok("auto-rotate restored on disconnect", events.some((e) => e.type === "rotation-restored"));
await page.screenshot({ path: `${OUT}/10-welcome-known.png` });
const knownWifi = page.locator(".known-item.wifi");
ok("welcome lists paired Wi-Fi device", (await knownWifi.count()) === 1);
await knownWifi.click();
const re = await waitFor(() => page.evaluate(() => window.annex.dev?.kind === "wifi" && window.annex.session?.width > 0), 15000, 200);
ok("reconnect over Wi-Fi from welcome", !!re);

// wrong key → clean error
await page.click("#btnDisconnect");
await page.evaluate(() => { const l = JSON.parse(localStorage.getItem("annex.wifi.v1")); l[0].key = "00".repeat(32); localStorage.setItem("annex.wifi.v1", JSON.stringify(l)); });
await page.reload();
await sleep(800);
// page reload with mock USB granted → auto-connects over USB; disconnect it first
if (await page.evaluate(() => !!window.annex.dev)) { await page.click("#btnDisconnect"); await sleep(300); }
await page.locator(".known-item.wifi").click();
const err = await waitFor(() => page.locator(".toast.error").count(), 10000);
ok("wrong key → rejected with error toast", !!err, (await page.locator(".toast.error .toast-detail").first().textContent().catch(() => "")) ?? "");

ok("app never calls clipboard.readText (no permission prompts)", (await page.evaluate(() => window.__readTextCalls - (window.__testReads || 0))) === 0);
ok("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
ok("no external requests", !failedRequests.some((u) => u.startsWith("EXTERNAL")), failedRequests.join(","));

const unknown = events.filter((e) => e.type === "unknown-control");
ok("control stream never desynced", unknown.length === 0, JSON.stringify(unknown.slice(0, 2)));

await browser.close();
device.bridge?.kill();
device.scrcpy?.stop();
const failed = results.filter((r) => r[0] === "FAIL");
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
