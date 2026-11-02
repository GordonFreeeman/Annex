// Renders the PWA icons from the Annex logo (run once; PNGs are committed in pwa/).
const { chromium } = require("/home/claude/.npm-global/lib/node_modules/playwright");
const svg = (maskable) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6ff0c2"/><stop offset="1" stop-color="#2fb4e8"/></linearGradient></defs>
${maskable ? '<rect width="512" height="512" fill="url(#g)"/>' : '<rect x="24" y="24" width="464" height="464" rx="112" fill="url(#g)"/>'}
<g transform="translate(256 256) scale(${maskable ? 0.72 : 1}) translate(-256 -256)">
<rect x="168" y="104" width="176" height="304" rx="44" fill="none" stroke="#0b0d10" stroke-width="34"/>
<circle cx="256" cy="352" r="18" fill="#0b0d10"/></g></svg>`;
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 512, height: 512 } });
  for (const [name, size, mask] of [["icon-512.png", 512, false], ["icon-192.png", 192, false], ["icon-maskable-512.png", 512, true]]) {
    await p.setViewportSize({ width: size, height: size });
    await p.setContent(`<html><body style="margin:0;background:transparent"><div style="width:${size}px;height:${size}px">${svg(mask).replace('width="512" height="512"', `width="${size}" height="${size}"`)}</div></body></html>`);
    await p.screenshot({ path: __dirname + "/" + name, omitBackground: true });
  }
  await b.close();
})();
