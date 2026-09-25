// Layout Inspector Mapper: a point or rectangle on a screenshot -> the view in a
// uiautomator window dump (adb shell uiautomator dump) that sits there.
//   Dump format: AOSP uiautomator "window_dump.xml": <node ... bounds="[x1,y1][x2,y2]"/>,
//   bounds in physical screen pixels, end-exclusive (Rect semantics).
//   Point: the smallest node whose bounds contain the point (the deepest view).
//   Rectangle: the node with the highest intersection-over-union (IoU = |A∩B| / |A∪B|,
//   the usual box-matching score) with the rectangle.
//   Screenshot scale: device width (from the root node) / screenshot width.
// Selectors follow Espresso ViewMatchers, UiAutomator2 BySelector and Appium locator strategies.

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
  return ENT[e] ?? m;
});

function parseDump(xml) {
  const nodes = [];
  const stack = [];
  let bad = 0;
  const re = /<(\/?)node\b([^>]*?)(\/?)>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[1]) { stack.pop(); continue; }
    const attrs = {};
    for (const a of m[2].matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) attrs[a[1]] = decode(a[2]);
    const b = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(attrs.bounds || '');
    const parent = stack.length ? stack[stack.length - 1] : null;
    const n = { i: nodes.length, attrs, parent, depth: stack.length,
      cls: attrs.class || '', id: attrs['resource-id'] || '', text: attrs.text || '', desc: attrs['content-desc'] || '',
      clickable: attrs.clickable === 'true' || attrs['long-clickable'] === 'true', pkg: attrs.package || '' };
    if (b) { n.x1 = +b[1]; n.y1 = +b[2]; n.x2 = +b[3]; n.y2 = +b[4]; n.area = Math.max(0, n.x2 - n.x1) * Math.max(0, n.y2 - n.y1); }
    else { n.area = 0; bad++; }
    nodes.push(n);
    if (!m[3]) stack.push(n.i);
  }
  return { nodes, bad };
}

const short = (cls) => cls.split('.').pop() || '(view)';
const idName = (id) => id.includes(':id/') ? id.split(':id/')[1] : id;
const q = (s) => JSON.stringify(s);
const xq = (s) => (s.includes('"') ? `'${s}'` : `"${s}"`);
const clip = (s, n = 40) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function run({ dump, x, y, w, h, shotWidth }) {
  const warnings = [], notes = [];
  const xml = String(dump ?? '');
  if (!xml.trim()) return { warnings: ['Paste a window dump: run adb shell uiautomator dump /sdcard/window_dump.xml, adb pull it and paste the XML.'] };
  const { nodes, bad } = parseDump(xml);
  if (!nodes.length) return { warnings: ['No <node> elements found: this is not a uiautomator dump. (Android Studio Layout Inspector exports and Espresso hierarchies are not read; use uiautomator dump.)'] };
  if (bad) warnings.push(`${bad} node${bad > 1 ? 's have' : ' has'} no readable bounds="[x1,y1][x2,y2]" and ${bad > 1 ? 'were' : 'was'} skipped.`);
  const boxed = nodes.filter((n) => n.x2 != null);
  if (!boxed.length) return { warnings: ['No node has bounds, so nothing can be located.'] };
  const devW = Math.max(...boxed.map((n) => n.x2)), devH = Math.max(...boxed.map((n) => n.y2));
  const pkgs = [...new Set(nodes.map((n) => n.pkg).filter(Boolean))];

  if (x == null || y == null) return { warnings: [...warnings, 'Give the x and y of the point (or of the rectangle\'s top-left corner) in screenshot pixels.'] };
  let scale = 1;
  if (shotWidth != null && shotWidth !== 0) {
    if (!(shotWidth > 0)) warnings.push('Screenshot width must be positive; the dump\'s own pixels were used.');
    else scale = devW / shotWidth;
  }
  if (Math.abs(scale - 1) > 1e-9) notes.push(`Screenshot pixels are scaled by ${+(scale.toFixed(4))} to device pixels.`);
  const rw = w > 0 ? w : 0, rh = h > 0 ? h : 0;
  if ((w != null && w < 0) || (h != null && h < 0)) warnings.push('Width and height cannot be negative; they were treated as 0 (a point).');
  const isPoint = !(rw > 0 && rh > 0);
  if (!isPoint && (rw > 0) !== (rh > 0)) warnings.push('Only one of width/height is set: matched as a point. Give both for a rectangle.');
  const R = { x1: x * scale, y1: y * scale, x2: (x + rw) * scale, y2: (y + rh) * scale };
  const px = R.x1, py = R.y1;
  if (px < 0 || py < 0 || px >= devW || py >= devH || R.x2 > devW + 1 || R.y2 > devH + 1) {
    warnings.push(`The ${isPoint ? 'point' : 'rectangle'} (${Math.round(px)}, ${Math.round(py)}${isPoint ? '' : ` to ${Math.round(R.x2)}, ${Math.round(R.y2)}`} device px) lies outside the ${devW}×${devH} screen of this dump. Check the screenshot width, or that the dump is from the same screen.`);
  }

  // ---- score ----
  let scored;
  if (isPoint) {
    scored = boxed.filter((n) => px >= n.x1 && px < n.x2 && py >= n.y1 && py < n.y2 && n.area > 0)
      .map((n) => ({ n, score: 1 - n.area / (devW * devH) }))
      .sort((a, b) => a.n.area - b.n.area || b.n.depth - a.n.depth);
  } else {
    const ra = (R.x2 - R.x1) * (R.y2 - R.y1);
    scored = boxed.map((n) => {
      const ix = Math.max(0, Math.min(n.x2, R.x2) - Math.max(n.x1, R.x1));
      const iy = Math.max(0, Math.min(n.y2, R.y2) - Math.max(n.y1, R.y1));
      const inter = ix * iy;
      return { n, score: inter / (ra + n.area - inter || 1) };
    }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score || b.n.depth - a.n.depth);
  }
  if (!scored.length) return { values: [{ label: 'Screen (device px)', value: `${devW}×${devH}` }, { label: 'Nodes', value: nodes.length }], warnings: [...warnings, 'No view lies at that place.'],
    view: { devW, devH, scale, isPoint, rect: R, nodes: nodes.map((n) => ({ i: n.i, parent: n.parent, depth: n.depth, cls: short(n.cls), id: idName(n.id), text: n.text, desc: n.desc, clickable: n.clickable, x1: n.x1, y1: n.y1, x2: n.x2, y2: n.y2 })), best: null, act: null, chain: [], tap: null, candidates: [] } };

  const best = scored[0].n;
  // The node a test would act on: itself if clickable, else the nearest clickable ancestor.
  let act = best;
  while (act && !act.clickable && act.parent != null) act = nodes[act.parent];
  if (act && !act.clickable) act = null;

  const chain = [];
  for (let k = best; k; k = k.parent != null ? nodes[k.parent] : null) chain.unshift(`${short(k.cls)}${k.id ? `#${idName(k.id)}` : ''}`);

  const count = (key, v) => nodes.filter((n) => n[key] === v).length;
  const target = act || best;
  const sel = [];
  const uniq = (k, v) => (count(k, v) === 1 ? 'unique' : `${count(k, v)} matches`);
  if (target.id) {
    const nm = idName(target.id);
    sel.push(['resource-id', uniq('id', target.id), `onView(withId(R.id.${nm}))`, `device.findObject(By.res(${q(target.id)}))`, `driver.findElement(AppiumBy.id(${q(target.id)}))`]);
  }
  if (target.desc) sel.push(['content-desc', uniq('desc', target.desc), `onView(withContentDescription(${q(target.desc)}))`, `device.findObject(By.desc(${q(target.desc)}))`, `driver.findElement(AppiumBy.accessibilityId(${q(target.desc)}))`]);
  const txtNode = target.text ? target : (best.text ? best : null);
  if (txtNode) sel.push(['text', uniq('text', txtNode.text), `onView(withText(${q(txtNode.text)}))`, `device.findObject(By.text(${q(txtNode.text)}))`, `driver.findElement(AppiumBy.androidUIAutomator(${q(`new UiSelector().text(${q(txtNode.text)})`)}))`]);
  // XPath by class and index path, always available
  const xp = (() => {
    const parts = [];
    for (let k = target; k; k = k.parent != null ? nodes[k.parent] : null) {
      const sibs = nodes.filter((n) => n.parent === k.parent && n.cls === k.cls);
      parts.unshift(`${k.cls || 'node'}${sibs.length > 1 ? `[${sibs.indexOf(k) + 1}]` : ''}`);
    }
    return '/hierarchy/' + parts.join('/');
  })();
  const xpShort = target.id ? `//${target.cls}[@resource-id=${xq(target.id)}]` : target.text ? `//${target.cls}[@text=${xq(target.text)}]` : xp;
  sel.push(['XPath', target.id || target.text ? 'by attribute' : 'by position (fragile)', '–', '–', `driver.findElement(AppiumBy.xpath(${q(xpShort)}))`]);

  const cx = Math.round((target.x1 + target.x2) / 2), cy = Math.round((target.y1 + target.y2) / 2);
  if (!sel.some((s) => s[1] === 'unique')) warnings.push(`The view has no unique resource-id, content description or text, so tests must find it by position. Give it an id (android:id, or Modifier.testTag with testTagsAsResourceId in Compose) or a contentDescription.`);
  if (!act) warnings.push('Neither the view nor any parent is clickable: a tap there does nothing. You may have picked a label; the clickable view is probably a sibling.');
  if (!isPoint && scored[0].score < 0.5) warnings.push(`Best overlap is only ${Math.round(scored[0].score * 100)} %: the rectangle does not line up with any single view. Draw it around one control, or use a point.`);

  const fmtB = (n) => `[${n.x1},${n.y1}][${n.x2},${n.y2}]`;
  const label = (n) => clip(n.text || n.desc || '');
  const values = [
    { label: 'Matched view', value: short(best.cls), hint: best.id ? idName(best.id) : label(best) || 'no id or text', tone: 'ok' },
    { label: 'Bounds (device px)', value: fmtB(best) },
    { label: isPoint ? 'Views under the point' : 'Overlap (IoU)', value: isPoint ? scored.length : `${Math.round(scored[0].score * 100)} %` },
    { label: 'Tap target', value: act ? `${short(act.cls)}${act.id ? '#' + idName(act.id) : ''}` : 'none clickable', tone: act ? 'ok' : 'warn' },
    { label: 'Tap at (device px)', value: `${cx}, ${cy}` },
    { label: 'Screen (device px)', value: `${devW}×${devH}`, hint: scale !== 1 ? `screenshot ×${+(scale.toFixed(4))}` : null },
  ];
  const tables = [
    { title: 'Selectors for the tap target', columns: ['By', 'Matches', 'Framework', 'Selector'],
      rows: sel.flatMap(([by, u, esp, ua, ap]) => [['Espresso', esp], ['UiAutomator', ua], ['Appium (Java)', ap]].filter(([, c]) => c !== '–').map(([fw, c]) => [by, u, fw, c])) },
    { title: isPoint ? 'Views at the point, innermost first' : 'Best overlapping views', columns: ['Class', 'resource-id', 'Text / description', 'Bounds', isPoint ? 'Depth' : 'IoU', 'Clickable'],
      rows: scored.slice(0, 8).map(({ n, score }) => [short(n.cls), idName(n.id) || '–', label(n) || '–', fmtB(n), isPoint ? n.depth : `${Math.round(score * 100)} %`, n.clickable ? 'yes' : 'no']) },
  ];
  const texts = [
    { title: 'Hierarchy path', body: chain.join(' > ') + '\n\nXPath of the tap target (full path): ' + xp + '\n', lang: 'text' },
    { title: 'adb tap', body: `adb shell input tap ${cx} ${cy}\n`, lang: 'bash' },
  ];
  notes.push(`${nodes.length} nodes read${pkgs.length ? ` from ${pkgs.join(', ')}` : ''}. Bounds are device pixels, right and bottom edges exclusive.`);
  notes.push('A uiautomator dump sees only accessibility nodes: Compose and custom-drawn views appear as one node unless they expose semantics.');
  // For the page's drawing only (manifest agentOmit): the parsed screen and the match.
  const chainIdx = [];
  for (let k = best; k; k = k.parent != null ? nodes[k.parent] : null) chainIdx.unshift(k.i);
  const view = {
    devW, devH, scale, isPoint, rect: R,
    nodes: nodes.map((n) => ({ i: n.i, parent: n.parent, depth: n.depth, cls: short(n.cls), id: idName(n.id), text: n.text, desc: n.desc,
      clickable: n.clickable, x1: n.x1, y1: n.y1, x2: n.x2, y2: n.y2 })),
    best: best.i, act: act ? act.i : null, chain: chainIdx, tap: { x: cx, y: cy },
    candidates: scored.slice(0, 8).map(({ n, score }) => ({ i: n.i, score })),
  };
  return { values, tables, texts, warnings, notes, view };
}
