import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";

const minify = !process.argv.includes("--dev");
const r = await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "iife",
  target: ["chrome114", "edge114"],
  minify,
  sourcemap: false,
  write: false,
  legalComments: "eof",
  loader: { ".dex": "binary", ".jar": "binary" },
  define: { "import.meta.url": '"about:blank"' },
  logLevel: "warning",
});
let js = r.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const css = fs.readFileSync("src/styles.css", "utf8");
let html = fs.readFileSync("src/index.html", "utf8");

// icons: inline <i data-icon> and emit <template>s for runtime icon()
const iconDir = "node_modules/lucide-static/icons";
const svgOf = (name, cls = "ic") => {
  const f = path.join(iconDir, name + ".svg");
  if (!fs.existsSync(f)) throw new Error("missing icon " + name);
  return fs.readFileSync(f, "utf8").replace(/<!--.*?-->/s, "").replace(/\s*\n\s*/g, " ").replace(/class="[^"]*"/, `class="${cls}" aria-hidden="true"`).trim();
};
html = html.replace(/<i data-icon="([a-z0-9-]+)"><\/i>/g, (_, n) => svgOf(n));
const src = fs.readdirSync("src").filter((f) => f.endsWith(".ts")).map((f) => fs.readFileSync("src/" + f, "utf8")).join("\n");
const names = new Set([...src.matchAll(/["'`]([a-z][a-z0-9]*(?:-[a-z0-9]+)*)["'`]/g)].map((m) => m[1]).filter((n) => fs.existsSync(path.join(iconDir, n + ".svg"))));
const templates = [...names].sort().map((n) => `<template id="icon-${n}">${svgOf(n)}</template>`).join("\n");
html = html.replace("/*__CSS__*/", () => css).replace("<!--__ICONS__-->", () => templates).replace("/*__JS__*/", () => js);
fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync("dist/annex.html", html);

// PWA bundle: same page + manifest, service worker, icons and a tiny local server launcher
const crypto = await import("node:crypto");
const version = crypto.createHash("sha256").update(html).digest("hex").slice(0, 12);
fs.rmSync("dist/pwa", { recursive: true, force: true });
fs.mkdirSync("dist/pwa", { recursive: true });
fs.writeFileSync("dist/pwa/index.html", html);
fs.writeFileSync("dist/pwa/sw.js", fs.readFileSync("pwa/sw.js", "utf8").replace("__VERSION__", version));
for (const f of ["manifest.json", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "start-annex.cmd", "start-annex.ps1", "start-annex.sh"]) fs.copyFileSync("pwa/" + f, "dist/pwa/" + f);
fs.chmodSync("dist/pwa/start-annex.sh", 0o755);
console.log("dist/pwa/ version", version);
console.log("dist/annex.html", (html.length / 1024).toFixed(0) + " KB", "icons:", names.size);
