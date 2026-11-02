import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright-core");
import path from "node:path";
import { startTcp, startUsbRelay } from "./fake-device.mjs";
const HERE = path.dirname(new URL(import.meta.url).pathname);
await startTcp(15555); startUsbRelay(15556);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ["--no-proxy-server"] }); // default autoplay policy
const ctx = await browser.newContext();
await ctx.addInitScript({ path: path.join(HERE, "usb-mock.js") });
const page = await ctx.newPage();
page.on("console", (m) => /audio|annex/i.test(m.text()) && console.log("[c]", m.text().slice(0, 200)));
await page.goto("file://" + path.resolve(HERE, "../dist/annex.html"));
await page.click("#btnUsb");
await page.waitForFunction(() => window.annex.session?.width > 0);
const probe = () => page.evaluate(() => { const a = window.annex.session.audio; return a ? { state: a.state, samples: a.samplesIn, level: +a.level().toFixed(3), log: document.getElementById("serverLog").textContent.split("\n").filter(l => /audio/i.test(l)).slice(-3) } : "no player"; });
await new Promise(r => setTimeout(r, 1500)); console.log("before click", await probe());
await page.mouse.click(10, 10);
await new Promise(r => setTimeout(r, 1500)); console.log("after click", await probe());
await browser.close(); process.exit(0);
