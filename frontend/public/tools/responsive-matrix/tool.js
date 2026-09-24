// Responsive preview matrix. run() is pure: it resolves the breakpoint set
// (a framework's defaults or your own), says what each width is, and reads the
// overflow report that view.js writes after loading the page at every width in
// the app (or that an agent writes from its own headless run).
// Breakpoint sets: Tailwind CSS v3/v4 defaults (sm 640, md 768, lg 1024, xl 1280, 2xl 1536),
// Bootstrap 5 (576, 768, 992, 1200, 1400), Material 3 window size classes (compact < 600,
// medium 600-839, expanded 840-1199, large 1200-1599, extra-large >= 1600), and common
// device widths (360/390 phones, 768 tablet, 1280/1440 desktops) as a rule of thumb.
// Overflow = the document is wider than the viewport (scrollWidth > clientWidth): the
// page scrolls sideways, WCAG 2.1 SC 1.4.10 Reflow asks for no 2-D scrolling at 320 CSS px.
//
// Report line (what view.js writes): "<width> ok|overflow|blocked [sw=<px>] [offender(right px) ...]"

export const PRESETS = {
  common: [['phone S', 360, 780], ['phone', 390, 844], ['tablet', 768, 1024], ['laptop', 1280, 800], ['desktop', 1440, 900]],
  tailwind: [['base', 375, 812], ['sm', 640, 900], ['md', 768, 1024], ['lg', 1024, 800], ['xl', 1280, 800], ['2xl', 1536, 900]],
  bootstrap: [['xs', 375, 812], ['sm', 576, 900], ['md', 768, 1024], ['lg', 992, 800], ['xl', 1200, 800], ['xxl', 1400, 900]],
  material: [['compact', 390, 844], ['medium', 600, 960], ['expanded', 840, 900], ['large', 1200, 800], ['extra-large', 1600, 900]],
  reflow: [['WCAG reflow', 320, 640], ['phone', 390, 844], ['desktop', 1280, 800]],
};

const cls = (w) => (w < 600 ? 'phone' : w < 1024 ? 'tablet' : 'desktop');

export function breakpoints(input) {
  if (input.preset === 'custom') {
    return (Array.isArray(input.sizes) ? input.sizes : []).map((r, i) => {
      const w = Math.round(Number(r.width)), h = Math.round(Number(r.height) || 800);
      return [String(r.name || `#${i + 1}`).trim() || `#${i + 1}`, w, h];
    }).filter(([, w]) => Number.isFinite(w) && w >= 200 && w <= 3840);
  }
  return PRESETS[input.preset] || PRESETS.common;
}

export function run(input) {
  const warnings = [], notes = [];
  const url = String(input.url || '').trim();
  if (!url) return { warnings: ['Give the page URL: a path on this app (/…) or http(s)://….'] };
  const relative = url.startsWith('/');
  if (!relative && !/^https?:\/\/[^\s/]+/i.test(url)) warnings.push('The URL must start with / (this app) or http:// / https://.');
  const bps = breakpoints(input);
  if (input.preset === 'custom') {
    const all = (Array.isArray(input.sizes) ? input.sizes : []).length;
    if (all > bps.length) warnings.push(`${all - bps.length} size row(s) left out: width must be a number from 200 to 3840 px.`);
  }
  if (!bps.length) return { warnings: [...warnings, 'No breakpoints: add rows with a name, width and height.'] };
  if (!relative) notes.push('Another origin: the frames show it, but the browser does not let this page look inside, so overflow cannot be measured (it is reported as blocked). Sites that send X-Frame-Options or CSP frame-ancestors show an empty frame.');

  // The report from view.js (or pasted).
  const rep = new Map();
  let unread = 0;
  for (const l of String(input.report || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) {
    const m = /^(\d+)\s+(ok|overflow|blocked)\b(?:\s+sw=(\d+))?\s*(.*)$/.exec(l);
    if (!m) { unread += 1; continue; }
    rep.set(Number(m[1]), { status: m[2], sw: m[3] ? Number(m[3]) : null, rest: m[4] });
  }
  if (unread) warnings.push(`${unread} report line(s) could not be read (expected: <width> ok|overflow|blocked [sw=<px>] [offenders]).`);
  const minW = Math.min(...bps.map(([, w]) => w));
  const rows = bps.map(([name, w, h]) => {
    const r = rep.get(w);
    const over = r && r.status === 'overflow' ? `+${(r.sw ?? w) - w} px` : r ? (r.status === 'ok' ? 'none' : 'n/a') : 'not measured';
    return [name, `${w} × ${h}`, cls(w), w === minW ? 'base styles' : `(min-width: ${w}px)`, over, r?.rest || ''];
  });
  const overflowing = bps.filter(([, w]) => rep.get(w)?.status === 'overflow');
  const measured = bps.filter(([, w]) => rep.has(w) && rep.get(w).status !== 'blocked');
  for (const [name, w] of overflowing) {
    const r = rep.get(w);
    warnings.push(`${name} (${w} px): the page is ${(r.sw ?? w) - w} px wider than the viewport and scrolls sideways${r.rest ? ` - widest culprits: ${r.rest}` : ''}. Give them max-width: 100%, min-width: 0 in flex/grid children, or overflow-wrap: anywhere for long words.`);
  }
  if (bps.some(([, w]) => w <= 320) && overflowing.some(([, w]) => w <= 320)) warnings.push('Overflow at 320 px fails WCAG 2.1 SC 1.4.10 Reflow.');
  const widths = bps.map(([, w]) => w).sort((a, b) => a - b);
  const css = ['/* mobile first: base styles are for the narrowest width */', ...widths.slice(1).map((w) => `@media (min-width: ${w}px) {\n  /* ${bps.find(([, x]) => x === w)[0]} */\n}`)].join('\n') + '\n';
  const target = relative ? `http://127.0.0.1:4201${url}` : url;
  const pw = `// Playwright: screenshot and overflow check at every breakpoint\nimport { chromium } from 'playwright';\nconst sizes = ${JSON.stringify(bps.map(([name, width, height]) => ({ name, width, height })))};\nconst browser = await chromium.launch();\nfor (const s of sizes) {\n  const page = await browser.newPage({ viewport: { width: s.width, height: s.height } });\n  await page.goto(${JSON.stringify(target)});\n  const sw = await page.evaluate(() => document.documentElement.scrollWidth);\n  console.log(s.width, sw > s.width ? 'overflow sw=' + sw : 'ok');\n  await page.screenshot({ path: \`shot-\${s.width}.png\`, fullPage: true });\n  await page.close();\n}\nawait browser.close();\n`;
  const finder = `// Paste into the DevTools console at a narrow width: lists what sticks out\n[...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5)\n  .filter((e) => !e.parentElement || e.parentElement.getBoundingClientRect().right <= document.documentElement.clientWidth + 0.5)\n  .forEach((e) => console.log(Math.round(e.getBoundingClientRect().right), e));\n`;
  return {
    values: [
      { label: 'Breakpoints', value: bps.length, hint: `${widths[0]}-${widths[widths.length - 1]} px` },
      { label: 'Measured', value: `${measured.length} / ${bps.length}`, hint: rep.size ? '' : 'open in the app to measure' },
      { label: 'Overflowing', value: overflowing.length, tone: rep.size ? (overflowing.length ? 'bad' : 'ok') : undefined, hint: overflowing.map(([n]) => n).join(', ') },
    ],
    warnings, notes: [...notes, 'Each frame is the page at that CSS width, scaled down; media queries see the real width.',
      'Culprits are the outermost elements whose right edge passes the viewport; fixing them usually fixes their children.'],
    tables: [{ title: 'Breakpoints', columns: ['Name', 'Size', 'Class', 'Media query', 'Overflow', 'Culprits'], rows }],
    texts: [{ title: 'Media queries', body: css, lang: 'css' }, { title: 'Playwright', body: pw, lang: 'js' }, { title: 'Overflow finder', body: finder, lang: 'js' }],
    breakpoints: bps.map(([name, width, height]) => ({ name, width, height })),
  };
}
