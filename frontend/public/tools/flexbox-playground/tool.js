// Flexbox layout of fixed-size boxes, computed the way the CSS Flexible Box
// Layout Module Level 1 (W3C) lays them out, so the positions are available
// without a browser:
//   9.3  collect items into lines (wrap when the next item's hypothetical main
//        size and the gap no longer fit)
//   9.7  resolve flexible lengths: grow shares positive free space by
//        flex-grow; shrink takes negative free space by flex-shrink x basis;
//        items clamped at their min size are frozen and the rest re-run;
//        a sum of factors below 1 distributes only that fraction
//   9.5/8.2  justify-content on the leftover space (space-between falls back
//        to flex-start, space-around/evenly to safe center, per CSS Box Alignment 3)
//   9.4/8.4  line cross sizes, align-content (normal = stretch), align-self
// Simplifications, the same in the preview: items have no content, a min size
// of 24 px in both axes, no margins, no padding or border on the container;
// baseline alignment is not offered.
import { parseEng } from '../kit/eng.js';

const MIN = 24;
const num = (v) => { const n = parseEng(v); return n != null && n >= 0 ? n : null; };
const r1 = (v) => Math.round(v * 10) / 10 || 0;

// 9.7 Resolving flexible lengths for one line.
function resolve(items, avail) {
  const sumHypo = items.reduce((s, it) => s + it.hypo, 0);
  const growing = sumHypo < avail;
  for (const it of items) {
    const factor = growing ? it.grow : it.shrink;
    it.frozen = factor === 0 || (growing && it.base > it.hypo) || (!growing && it.base < it.hypo);
    it.target = it.frozen ? it.hypo : it.base;
  }
  const initialFree = avail - items.reduce((s, it) => s + (it.frozen ? it.target : it.base), 0);
  for (let guard = 0; guard < 50 && items.some((it) => !it.frozen); guard++) {
    const open = items.filter((it) => !it.frozen);
    let free = avail - items.reduce((s, it) => s + (it.frozen ? it.target : it.base), 0);
    const sumFlex = open.reduce((s, it) => s + (growing ? it.grow : it.shrink), 0);
    if (sumFlex < 1 && Math.abs(initialFree * sumFlex) < Math.abs(free)) free = initialFree * sumFlex;
    if (growing) {
      for (const it of open) it.target = it.base + (free * it.grow) / sumFlex;
    } else {
      const sumScaled = open.reduce((s, it) => s + it.shrink * it.base, 0);
      for (const it of open) it.target = sumScaled > 0 ? it.base - (Math.abs(free) * it.shrink * it.base) / sumScaled : it.base;
    }
    let violation = 0;
    for (const it of open) { const c = Math.max(MIN, it.target); it.violation = c - it.target; violation += it.violation; it.target = c; }
    if (violation === 0) for (const it of open) it.frozen = true;
    else for (const it of open) if (it.violation > 0) it.frozen = true;
  }
  return items.map((it) => it.target);
}

// Leftover space -> [offset of the first item, extra gap between items].
function distribute(mode, free, n, rev = false) {
  const safe = rev ? free : 0;               // overflow start: the top/left edge, even when reversed
  if (mode === 'flex-end') return [free, 0];
  if (mode === 'center') return [free / 2, 0];
  if (mode === 'space-between') return free > 0 && n > 1 ? [0, free / (n - 1)] : [0, 0];
  // space-around/evenly fall back to "safe center" (CSS Box Alignment 3):
  // centred when there is room, start-aligned when the items overflow.
  if (mode === 'space-around') return free > 0 && n > 1 ? [free / n / 2, free / n] : [free > 0 ? free / 2 : safe, 0];
  if (mode === 'space-evenly') return free > 0 && n > 1 ? [free / (n + 1), free / (n + 1)] : [free > 0 ? free / 2 : safe, 0];
  return [0, 0];                                         // flex-start, normal
}

export function run({ direction, wrap, justify, alignItems, alignContent, gap, width, height, items }) {
  const warnings = [];
  const notes = [];
  const W = width > 0 ? width : null, H = height > 0 ? height : null;
  if (!W || !H) return { warnings: ['Give the container width and height in px, e.g. 480 and 240.'] };
  const g = gap >= 0 ? gap : 0;
  const row = direction === 'row' || direction === 'row-reverse';
  const mainRev = direction === 'row-reverse' || direction === 'column-reverse';
  const mainSize = row ? W : H, crossSize = row ? H : W;
  const multi = wrap === 'wrap' || wrap === 'wrap-reverse';
  const crossRev = wrap === 'wrap-reverse';

  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return { warnings: ['Add at least one item.'] };
  if (rows.length > 24) warnings.push('Only the first 24 items are laid out.');
  const bad = [];
  const list = rows.slice(0, 24).map((r, i) => {
    const w = String(r.w ?? '').trim().toLowerCase() === 'auto' ? 'auto' : num(r.w);
    const h = String(r.h ?? '').trim().toLowerCase() === 'auto' ? 'auto' : num(r.h);
    const grow = num(r.grow ?? 0), shrink = num(r.shrink ?? 1), order = Number.parseInt(r.order ?? 0, 10);
    if (w == null || h == null || grow == null || shrink == null) bad.push(i + 1);
    const mainDim = row ? w : h, crossDim = row ? h : w;
    const base = mainDim === 'auto' || mainDim == null ? 0 : mainDim;
    return { i: i + 1, w, h, grow: grow ?? 0, shrink: shrink ?? 1, order: Number.isFinite(order) ? order : 0,
      self: r.self || 'auto', base, hypo: Math.max(MIN, base), crossAuto: crossDim === 'auto' || crossDim == null,
      crossHypo: crossDim === 'auto' || crossDim == null ? MIN : Math.max(MIN, crossDim) };
  });
  if (bad.length) warnings.push(`Item${bad.length > 1 ? 's' : ''} ${bad.join(', ')}: width and height take a px number or "auto", grow and shrink a number 0 or more. Blank or unreadable cells count as auto / 0 / 1.`);
  // The order property, stable for equal values.
  const seq = [...list].sort((a, b) => a.order - b.order || a.i - b.i);

  // 9.3 Lines.
  const lines = [];
  if (!multi) lines.push(seq);
  else {
    let cur = [], used = 0;
    for (const it of seq) {
      const need = it.hypo + (cur.length ? g : 0);
      if (cur.length && used + need > mainSize) { lines.push(cur); cur = []; used = 0; }
      used += it.hypo + (cur.length ? g : 0);
      cur.push(it);
    }
    if (cur.length) lines.push(cur);
  }

  // 9.7 + justify-content per line.
  let justifyIdle = true, overflowMain = 0;
  for (const line of lines) {
    const gaps = g * (line.length - 1);
    const sizes = resolve(line, mainSize - gaps);
    line.forEach((it, k) => { it.main = sizes[k]; });
    const free = mainSize - gaps - sizes.reduce((s, v) => s + v, 0);
    if (Math.abs(free) > 0.5) justifyIdle = false;
    if (free < -0.5) overflowMain = Math.max(overflowMain, -free);
    const [start, extra] = distribute(justify, free, line.length, mainRev);
    let pos = start;
    for (const it of line) { it.mainPos = pos; pos += it.main + g + extra; }
    line.free = free;
  }

  // 9.4 cross sizes of the lines, then align-content.
  for (const line of lines) line.cross = Math.max(...line.map((it) => it.crossHypo));
  if (!multi) lines[0].cross = crossSize;
  let crossFree = 0;
  if (multi) {
    crossFree = crossSize - lines.reduce((s, l) => s + l.cross, 0) - g * (lines.length - 1);
    const mode = alignContent === 'normal' ? 'stretch' : alignContent;
    if (mode === 'stretch' && crossFree > 0) for (const l of lines) l.cross += crossFree / lines.length;
    const [start, extra] = mode === 'stretch' ? [0, 0] : distribute(mode, crossFree, lines.length, crossRev);
    let pos = start;
    for (const l of lines) { l.pos = pos; pos += l.cross + g + extra; }
  } else lines[0].pos = 0;

  // align-self within each line.
  const stretchIgnored = [];
  for (const l of lines) {
    for (const it of l) {
      const a = it.self === 'auto' ? alignItems : it.self;
      it.cross = a === 'stretch' && it.crossAuto ? Math.max(MIN, l.cross) : it.crossHypo;
      if (a === 'stretch' && !it.crossAuto) stretchIgnored.push(it.i);
      const off = a === 'flex-end' ? l.cross - it.cross : a === 'center' ? (l.cross - it.cross) / 2 : 0;
      it.crossPos = l.pos + off;
    }
  }

  // Logical main/cross -> x, y (reverse directions start from the far edge).
  const out = seq.map((it) => {
    const m = mainRev ? mainSize - it.mainPos - it.main : it.mainPos;
    const c = crossRev ? crossSize - it.crossPos - it.cross : it.crossPos;
    return { i: it.i, line: lines.findIndex((l) => l.includes(it)) + 1, order: it.order,
      x: r1(row ? m : c), y: r1(row ? c : m), w: r1(row ? it.main : it.cross), h: r1(row ? it.cross : it.main) };
  }).sort((a, b) => a.i - b.i);

  // What each property is doing right now.
  if (justifyIdle && justify !== 'flex-start') notes.push(`justify-content: ${justify} has no effect: the items fill every line exactly (grown or shrunk), so there is no leftover space to place.`);
  if (!multi && alignContent !== 'normal') notes.push('align-content has no effect: it only places lines, and a nowrap container has a single line.');
  if (stretchIgnored.length) notes.push(`Stretch has no effect on item${stretchIgnored.length > 1 ? 's' : ''} ${stretchIgnored.join(', ')}: ${row ? 'height' : 'width'} is set. Set it to auto to stretch.`);
  if (overflowMain > 0.5) warnings.push(`Items overflow the ${row ? 'width' : 'height'} by ${r1(overflowMain)} px: flex-shrink is 0 or they reached their ${MIN} px minimum. Allow wrapping, raise flex-shrink, or make the container larger.`);
  if (multi && crossFree < -0.5) warnings.push(`The lines need ${r1(-crossFree)} px more ${row ? 'height' : 'width'} than the container has.`);
  notes.push(`Main axis: ${row ? 'horizontal' : 'vertical'}, from ${row ? (mainRev ? 'right to left' : 'left to right') : (mainRev ? 'bottom to top' : 'top to bottom')}. justify-content works along it; align-items / align-self across it.`,
    `Preview items have no content and a ${MIN} px minimum size in both directions; the layout table uses the same rule.`);

  const containerCss = ['.container {', '  display: flex;', `  flex-direction: ${direction};`, `  flex-wrap: ${wrap};`, `  justify-content: ${justify};`,
    `  align-items: ${alignItems};`, ...(multi ? [`  align-content: ${alignContent};`] : []), `  gap: ${g}px;`, `  width: ${W}px;`, `  height: ${H}px;`, '}'];
  const itemCss = list.map((it) => {
    const p = [`flex: ${it.grow} ${it.shrink} ${row ? (it.w === 'auto' ? 'auto' : `${it.w}px`) : (it.h === 'auto' ? 'auto' : `${it.h}px`)};`];
    const crossDim = row ? it.h : it.w;
    if (crossDim !== 'auto' && crossDim != null) p.push(`${row ? 'height' : 'width'}: ${crossDim}px;`);
    p.push(`min-width: ${MIN}px; min-height: ${MIN}px;`);
    if (it.order) p.push(`order: ${it.order};`);
    if (it.self !== 'auto') p.push(`align-self: ${it.self};`);
    return `.item:nth-child(${it.i}) { ${p.join(' ')} }`;
  });
  const css = [...containerCss, '', ...itemCss, ''].join('\n');

  return {
    values: [
      { label: 'Main axis', value: row ? 'horizontal' : 'vertical', hint: direction },
      { label: 'Lines', value: lines.length, hint: multi ? wrap : 'nowrap: always one' },
      { label: 'Free space', value: r1(lines[0].free), unit: 'px', hint: lines.length > 1 ? 'first line' : 'after flexing', tone: lines.some((l) => l.free < -0.5) ? 'bad' : undefined },
      { label: 'Items', value: list.length },
    ],
    warnings,
    tables: [{ title: 'Layout (px, from the container\'s top-left)', columns: ['Item', 'x', 'y', 'width', 'height', 'line', 'order'], rows: out.map((o) => [o.i, o.x, o.y, o.w, o.h, o.line, o.order]) }],
    texts: [{ title: 'CSS', body: css, lang: 'css' }],
    notes,
    drawing: { width: W, height: H, direction, wrap, justify, alignItems, alignContent, gap: g, items: list.map((it) => ({ i: it.i, w: it.w, h: it.h, grow: it.grow, shrink: it.shrink, order: it.order, self: it.self })), boxes: out },
    // For the page only (manifest agentOmit): each line's leftover main-axis space and its
    // logical cross position (from the cross-start edge), and the cross space left over.
    flexLines: { lines: lines.map((l) => ({ items: l.map((it) => it.i), free: r1(l.free), pos: r1(l.pos), cross: r1(l.cross) })), crossFree: r1(crossFree) },
  };
}
