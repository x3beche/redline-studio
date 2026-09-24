// The live half: a "Search LCSC" button that asks the app's /api/parts/search
// and writes the rows into the Candidates table (api.set), so run() - and the
// Prompt/JSON - rank what was found. One request per press, never per keystroke.
// Opened as a file there is no app to ask: it says so, and the table still
// works by hand.

let state = { busy: false, msg: '', tone: '' };

const $ = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
};

const CLASS = (c) => {
  const t = String(c || '').toLowerCase();
  return t.startsWith('basic') ? 'basic' : t.startsWith('pref') ? 'preferred' : t.startsWith('ext') ? 'extended' : null;
};

export function view(el, result, input, api) {
  const served = /^https?:/.test(location.protocol);
  const q = String(api.raw.query || '').trim();
  const status = $('span', { style: `font-size:12px;color:var(${state.tone === 'bad' ? '--danger' : state.tone === 'ok' ? '--ok' : '--ink-soft'})`, role: 'status' }, state.msg);
  const go = async () => {
    if (!q || state.busy) return;
    state = { busy: true, msg: `Searching LCSC for "${q}"…`, tone: '' };
    view(el, result, input, api);
    try {
      const r = await fetch(`/api/parts/search?q=${encodeURIComponent(q)}&limit=20`);
      if (!r.ok) {
        let why = `${r.status}`;
        try { why = (await r.json()).detail || why; } catch { /* not JSON */ }
        throw new Error(r.status === 502 || r.status === 503 ? `LCSC did not answer (${why}); try again in a minute.` : `search failed: ${why}`);
      }
      const rows = await r.json();
      // Keep a class the user already set for a part that comes back again.
      const had = new Map((api.raw.candidates || []).map((c) => [String(c.lcsc), c.class]));
      const cand = rows.map((p) => ({
        lcsc: p.lcsc || '', mpn: p.mpn || '', package: p.package || '', maker: p.maker || p.manufacturer || '',
        stock: p.stock == null ? '' : String(p.stock), price: p.price == null ? '' : String(p.price),
        class: CLASS(p.jlc_class) || (had.get(String(p.lcsc)) && had.get(String(p.lcsc)) !== 'unknown' ? had.get(String(p.lcsc)) : 'unknown'),
      }));
      state = { busy: false, msg: cand.length ? `${cand.length} parts found for "${q}". Set the class where you know it (jlcpcb.com/parts).` : `Nothing found for "${q}": try the bare MPN or a shorter description.`, tone: cand.length ? 'ok' : 'bad' };
      api.set('candidates', cand);
    } catch (e) {
      state = { busy: false, msg: `${e.message || e}`, tone: 'bad' };
      view(el, result, input, api);
    }
  };
  el.replaceChildren($('div', { class: 'k-block' },
    $('div', { class: 'k-title' }, 'Live search'),
    served
      ? $('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' },
        $('button', { class: 'k-btn k-primary', disabled: state.busy || !q, onclick: go }, state.busy ? 'Searching…' : `Search LCSC for "${q.length > 28 ? q.slice(0, 28) + '…' : q}"`),
        status,
        $('span', { style: 'font-size:11px;color:var(--ink-soft);flex-basis:100%' }, 'Replaces the Candidates table with up to 20 catalogue rows. The original part is left out of the ranking by its LCSC number.'))
      : $('div', { style: 'font-size:12px;color:var(--ink-soft)' }, 'Open this tool in the app to search LCSC live. Opened as a file it cannot reach the catalogue; fill the Candidates table by hand instead.')));
}
