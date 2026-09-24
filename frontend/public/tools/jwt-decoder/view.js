// A timeline of the token's life: issued (iat), valid from (nbf), expires
// (exp), the check time if given, and now by this browser's clock.
const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};
const iso = (sec) => new Date(sec * 1000).toISOString().replace('.000Z', 'Z').replace('T', ' ');
function span(sec) {
  const a = Math.abs(sec);
  if (a < 90) return `${Math.round(a)} s`;
  if (a < 5400) return `${Math.round(a / 60)} min`;
  if (a < 172800) return `${Math.floor(a / 3600)} h ${Math.round((a % 3600) / 60)} min`;
  return `${Math.round(a / 86400)} days`;
}

export function view(el, result) {
  el.replaceChildren();
  const t = result?.times;
  if (!t) return;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const iat = num(t.iat), nbf = num(t.nbf), exp = num(t.exp), check = num(t.check);
  const now = Math.floor(Date.now() / 1000);
  const start = nbf ?? iat;
  if (start == null && exp == null) return;
  const marks = [
    iat != null && { at: iat, label: 'iat', col: 'var(--ink-soft)' },
    nbf != null && nbf !== iat && { at: nbf, label: 'nbf', col: 'var(--ink-soft)' },
    exp != null && { at: exp, label: 'exp', col: 'var(--danger)' },
    check != null && { at: check, label: 'check', col: 'var(--tool-s1)' },
    { at: now, label: 'now', col: 'var(--accent)' },
  ].filter(Boolean);
  let lo = Math.min(...marks.map((m) => m.at)), hi = Math.max(...marks.map((m) => m.at));
  if (hi - lo < 60) { lo -= 30; hi += 30; }
  // If now is far outside the token's life, draw the life and put now at the edge with an arrow.
  const life = exp != null && start != null ? exp - start : null;
  let clampNow = false;
  if (life && (now > exp + life * 3 || now < start - life * 3)) {
    clampNow = true;
    const others = marks.filter((m) => m.label !== 'now').map((m) => m.at);
    lo = Math.min(...others) - life * 0.3; hi = Math.max(...others) + life * 0.3;
  } else { const pad = (hi - lo) * 0.08; lo -= pad; hi += pad; }
  const W = Math.max(260, Math.round(el.clientWidth || el.parentElement?.clientWidth || 600) - 22);
  const H = 128, L = 12, R = 12, Y = 52;
  const X = (v) => L + ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * (W - L - R);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': 'token lifetime', style: 'display:block' });
  svg.append(s('line', { x1: L, x2: W - R, y1: Y, y2: Y, stroke: 'var(--line)', 'stroke-width': 2 }));
  if (start != null) svg.append(s('rect', { x: X(start), y: Y - 7, width: Math.max(2, (exp != null ? X(exp) : W - R) - X(start)), height: 14, rx: 3, fill: 'var(--ok)', 'fill-opacity': 0.35 }));
  // Labels go to the first row (above, below, further below) where they do not overlap.
  const rows = [{ y: Y - 20, dy: -12, end: -1e9 }, { y: Y + 30, dy: 12, end: -1e9 }, { y: Y + 58, dy: 12, end: -1e9 }];
  for (const m of marks.sort((a, b) => a.at - b.at)) {
    const x = X(m.at);
    const isNow = m.label === 'now';
    svg.append(s('line', { x1: x, x2: x, y1: Y - 14, y2: Y + 14, stroke: m.col, 'stroke-width': isNow ? 2.5 : 1.5 }));
    const txt = isNow && clampNow ? `now ${now > hi ? '→' : '←'} ${now > (exp ?? 0) ? `expired ${span(now - exp)} ago` : 'far before'}` : m.label;
    const w = Math.max(txt.length * 6.6, 64);
    const anchor = x - w / 2 < L ? 'start' : x + w / 2 > W - R ? 'end' : 'middle';
    const left = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2;
    const row = rows.find((r) => left > r.end + 6) || rows[rows.length - 1];
    row.end = left + w;
    svg.append(s('text', { x, y: row.y, 'text-anchor': anchor, fill: m.col, 'font-size': 11, 'font-weight': isNow ? 600 : 400 }, txt));
    svg.append(s('text', { x, y: row.y + row.dy, 'text-anchor': anchor, fill: 'var(--ink-soft)', 'font-size': 9.5 }, iso(m.at).slice(5, 16)));
  }
  const block = document.createElement('div');
  block.className = 'k-block';
  const title = document.createElement('div');
  title.className = 'k-title';
  const state = exp != null && now >= exp ? `expired ${span(now - exp)} ago` : nbf != null && now < nbf ? `not valid for ${span(nbf - now)}` : exp != null ? `valid for ${span(exp - now)} more` : 'no expiry';
  title.textContent = `Lifetime — by your clock: ${state}`;
  block.append(title, svg);
  el.append(block);
}
