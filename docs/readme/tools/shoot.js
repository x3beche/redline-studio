// The README's pictures: the landing page (frontend/src/app/landing.ts), section by
// section, cropped to its 1120 px content column, at 1920 wide and device scale 2.
//   docker run --rm --network host -v $PWD/docs/readme:/out \
//     -v $PWD/docs/readme/tools/shoot.js:/usr/src/app/s.js \
//     zenika/alpine-chrome:with-puppeteer node /usr/src/app/s.js [name,name]
// against the UI on http://127.0.0.1:4200/. Existing files are skipped (delete one to
// retake it); the page reloads while the dev server rebuilds, so run it again if it stops.
// captureBeyondViewport stays off: resizing the page for the shot blanks the iframes.
// Then: pngquant --quality 80-95 --speed 1 --ext .png --force *.png; optipng -o2 *.png
const puppeteer = require('puppeteer');
const fs = require('fs');
const G = [ // [file, section selector, first child, last child]
  ['hero', 'header.hero', 1, 2], ['numbers', 'app-landing > section:not([id])', 1, 1],
  ['rooms', '#rooms', 1, 1], ['draw', '#draw', 1, 1],
  ['chat-tools', '#work', 1, 1], ['chat-usage', '#work', 2, 3], ['asks', '.stmt', 1, 1],
  ['analytics-llm', '#analytics', 1, 3], ['analytics-machine', '#analytics', 4, 5],
  ['taste-stats', '#taste', 1, 1], ['taste-views', '#taste', 2, 4], ['taste-rules', '#taste', 5, 6],
  ['themes', '#themes', 1, 1], ['cost-savings', '#cost', 1, 2], ['cost-llm', '#cost', 3, 4],
  ['proxy', '#proxy', 1, 1], ['platform', '#platform', 1, 1],
];
const only = process.argv[2] ? process.argv[2].split(',') : null;
(async () => {
  const b = await puppeteer.launch({ args: ['--no-sandbox'], executablePath: '/usr/bin/chromium-browser' });
  const p = await b.newPage();
  await p.setViewport({ width: 1920, height: 1400, deviceScaleFactor: 2 });
  await p.goto('http://127.0.0.1:4200/', { waitUntil: 'networkidle2' });
  await p.waitForSelector('app-landing');
  await new Promise(r => setTimeout(r, 5000));
  await p.evaluate(async () => {
    const L = document.querySelector('app-landing'); L.classList.add('static');
    await document.fonts.ready;
  });
  await new Promise(r => setTimeout(r, 1500));
  for (const [name, sel, a, z] of G) {
    if (only && !only.includes(name)) continue;
    if (fs.existsSync(`/out/${name}.png`)) continue;
    const box = async () => p.evaluate((sel, a, z) => {
      const L = document.querySelector('app-landing'), s = document.querySelector(sel);
      const kids = [...s.children].slice(a, z + 1);
      const rs = kids.map(k => k.getBoundingClientRect());
      const top = Math.min(...rs.map(r => r.top)) + L.scrollTop, bot = Math.max(...rs.map(r => r.bottom)) + L.scrollTop;
      return { top, h: bot - top };
    }, sel, a, z);
    let { top, h } = await box();
    const vh = Math.max(1080, Math.ceil(h) + 200);
    await p.evaluate(t => { document.querySelector('app-landing').scrollTop = t - 104; }, top);
    await new Promise(r => setTimeout(r, 1500));
    // wait for every iframe in the group to have loaded its document and pictures
    for (let i = 0; i < 40; i++) {
      const ok = await p.evaluate((sel, a, z) => {
        const s = document.querySelector(sel);
        const fr = [...s.children].slice(a, z + 1).flatMap(k => [...k.querySelectorAll('iframe')]);
        return fr.every(f => { try { const d = f.contentDocument; return d && d.readyState === 'complete' && d.body && d.body.children.length > 0
          && [...d.images].every(im => im.complete) && f.style.transform !== 'scale(0)'; } catch (e) { return false; } });
      }, sel, a, z);
      if (ok) break;
      await new Promise(r => setTimeout(r, 500));
    }
    await new Promise(r => setTimeout(r, 1200));
    const r = await p.evaluate((sel, a, z) => {
      const s = document.querySelector(sel);
      const rs = [...s.children].slice(a, z + 1).map(k => k.getBoundingClientRect());
      const top = Math.min(...rs.map(r => r.top)), bot = Math.max(...rs.map(r => r.bottom));
      return { top, h: bot - top };
    }, sel, a, z);
    const x = (1920 - 1120) / 2;
    await p.screenshot({ path: `/out/${name}.png`, clip: { x, y: Math.floor(r.top), width: 1120, height: Math.ceil(r.h) }, captureBeyondViewport: false });
    console.log(name, Math.round(r.top), Math.round(r.h));
  }
  await b.close();
})();
