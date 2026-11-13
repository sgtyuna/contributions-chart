// Draws the app icon (house with a heart) and saves the PNG sizes.
import { chromium } from 'playwright';
const svg = (pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="${pad ? 0 : 112}" fill="#5f7f63"/>
  <g transform="translate(256 270) scale(${pad ? 0.72 : 0.9}) translate(-256 -270)">
    <path d="M256 104 L420 236 L420 404 Q420 420 404 420 L108 420 Q92 420 92 404 L92 236 Z" fill="#f7f3ec"/>
    <path d="M256 360 C200 320 168 292 168 258 C168 232 188 214 212 214 C232 214 246 226 256 242 C266 226 280 214 300 214 C324 214 344 232 344 258 C344 292 312 320 256 360 Z" fill="#b8774f"/>
  </g></svg>`;
const browser = await chromium.launch({ channel: 'chrome' });
for (const [name, size, pad] of [['icon-192', 192, false], ['icon-512', 512, false], ['icon-512-maskable', 512, true], ['apple-touch-icon', 180, true]]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>html,body{margin:0;background:transparent}img{display:block}</style><img src="data:image/svg+xml;base64,${Buffer.from(svg(pad)).toString('base64')}" width="${size}" height="${size}">`);
  await page.locator('img').screenshot({ path: `../web/icons/${name}.png`, omitBackground: !pad });
  await page.close();
}
await browser.close();
