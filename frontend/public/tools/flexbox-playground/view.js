// The live flex container, laid out by the browser with the same CSS the tool
// prints. Scaled down to fit narrow screens; click an item to toggle its
// flex-grow between 0 and 1. Items have no border (an inset box-shadow draws
// it), so an auto flex-basis is 0 px as in the tool's computation.
const COLORS = ['var(--tool-s0)', 'var(--tool-s1)', 'var(--tool-s2)', 'var(--tool-s3)'];

export function view(el, result, input, api) {
  el.replaceChildren();
  const d = result && result.drawing;
  if (!d) return;
  const row = d.direction === 'row' || d.direction === 'row-reverse';
  const wrap = document.createElement('div');
  wrap.className = 'k-block';
  const title = document.createElement('div');
  title.className = 'k-title';
  title.textContent = 'Live result (click an item to toggle flex-grow 0 / 1)';
  wrap.append(title);
  el.append(wrap);
  const avail = Math.max(200, (wrap.clientWidth || 600) - 22);
  const k = Math.min(1, avail / d.width);
  const frame = document.createElement('div');
  frame.style.cssText = `position:relative;width:${d.width * k}px;height:${d.height * k}px;max-width:100%`;
  const box = document.createElement('div');
  box.className = 'fx-container';
  box.style.cssText = `display:flex;flex-direction:${d.direction};flex-wrap:${d.wrap};justify-content:${d.justify};align-items:${d.alignItems};`
    + `align-content:${d.alignContent};gap:${d.gap}px;width:${d.width}px;height:${d.height}px;box-sizing:content-box;padding:0;border:0;`
    + `outline:1px dashed var(--ink-soft);background:var(--sunken);transform:scale(${k});transform-origin:0 0;position:absolute;left:0;top:0`;
  for (const it of d.items) {
    const item = document.createElement('div');
    item.className = 'fx-item';
    const main = row ? it.w : it.h, cross = row ? it.h : it.w;
    const basis = main === 'auto' || main == null ? 'auto' : `${main}px`;
    item.style.cssText = `flex:${it.grow} ${it.shrink} ${basis};min-width:24px;min-height:24px;box-sizing:border-box;position:relative;cursor:pointer;`
      + `box-shadow:inset 0 0 0 1px ${COLORS[(it.i - 1) % 4]};border-radius:3px;background:color-mix(in srgb, ${COLORS[(it.i - 1) % 4]} 22%, var(--surface))`
      + (cross !== 'auto' && cross != null ? `;${row ? 'height' : 'width'}:${cross}px` : '')
      + (it.order ? `;order:${it.order}` : '') + (it.self !== 'auto' ? `;align-self:${it.self}` : '');
    const label = document.createElement('span');
    label.textContent = it.grow ? `${it.i}↔` : String(it.i);
    label.style.cssText = 'position:absolute;left:4px;top:2px;font:600 12px "IBM Plex Mono",ui-monospace,monospace;color:var(--ink)';
    item.append(label);
    item.title = `Item ${it.i}: flex ${it.grow} ${it.shrink} ${basis}. Click to set flex-grow ${it.grow ? 0 : 1}.`;
    item.addEventListener('click', () => {
      const rows = (api.raw.items || []).map((r) => ({ ...r }));
      if (!rows[it.i - 1]) return;
      rows[it.i - 1].grow = it.grow ? '0' : '1';
      api.set('items', rows);
    });
    box.append(item);
  }
  frame.append(box);
  wrap.append(frame);
  if (k < 1) {
    const note = document.createElement('div');
    note.className = 'k-help';
    note.textContent = `Shown at ${Math.round(k * 100)} % to fit.`;
    wrap.append(note);
  }
}
