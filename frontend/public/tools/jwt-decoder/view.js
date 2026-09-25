// JWT & Base64 Decoder, custom page: the token itself is the tool.
//
// The token is shown as one strip of text coloured by part (header, payload,
// signature) and stays editable in place. Under it the three parts are laid
// open: every header field and claim is a row, and pointing at a row lights
// up exactly the characters of the token that carry it. The signature is
// drawn as its bytes against the length its algorithm needs, with the key
// to check it. The token's life (iat, nbf, exp) is a ruler with a check-time
// handle you drag, or step with the arrow keys; the verdict at the handle is
// run()'s. Plain base64 shows every 4 characters over the 3 bytes they carry.
// All values, meanings and verdicts come from run()'s result.

const NS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
};
const iso = (sec) => new Date(sec * 1000).toISOString().replace('.000Z', 'Z');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const PART_CLASS = { header: 'p-h', payload: 'p-p', signature: 'p-s', key: 'p-x', iv: 'p-x', ciphertext: 'p-p', tag: 'p-s' };

export function page(root, ctx) {
  const st = { hi: null, dom: null, drag: false, focusPart: null };

  // ------------------------------------------------------------ token strip
  const ta = h('textarea', { class: 'jw-ta', spellcheck: 'false', 'aria-label': 'Token or base64',
    placeholder: 'eyJhbGciOi...  (a "Bearer " prefix is removed)',
    oninput: (e) => { drawStrip(e.target.value); ctx.set('token', e.target.value); } });
  const back = h('div', { class: 'jw-back', 'aria-hidden': 'true' });
  const modeSeg = h('span', { class: 'jw-seg', role: 'group', 'aria-label': 'Read as' },
    [['auto', 'Detect'], ['jwt', 'JWT'], ['base64', 'Base64']].map(([v, t]) =>
      h('button', { 'data-v': v, 'aria-pressed': 'false', onclick: () => ctx.set('mode', v) }, t)));
  const legend = h('span', { class: 'jw-legend' });
  const stripWarn = h('div', { class: 'jw-warn' });
  const strip = h('section', { class: 'jw-panel jw-strip' },
    h('div', { class: 'jw-head' }, h('span', { class: 'jw-h' }, 'Token'), legend, h('span', { class: 'jw-grow' }), modeSeg),
    h('div', { class: 'jw-tok' }, back, ta), stripWarn);

  // ------------------------------------------------------------ opened parts
  const parts = h('div', { class: 'jw-parts' });

  // ------------------------------------------------------------ lifetime ruler
  const atIn = h('input', { type: 'text', class: 'jw-atin', spellcheck: 'false', 'aria-label': 'Check time (UTC)',
    placeholder: 'ISO UTC or Unix seconds', onchange: (e) => ctx.set('at', e.target.value) });
  const qb = (label, title, fn) => h('button', { class: 'jw-q', title, onclick: fn }, label);
  const times = () => ctx.result?.times || {};
  const quick = h('span', { class: 'jw-quick' },
    qb('iat', 'Check at the issue time', () => { const t = num(times().iat); if (t != null) ctx.set('at', iso(t)); }),
    qb('exp − 1 s', 'The last second it is valid', () => { const t = num(times().exp); if (t != null) ctx.set('at', iso(t - 1)); }),
    qb('exp', 'The first second it is expired', () => { const t = num(times().exp); if (t != null) ctx.set('at', iso(t)); }),
    qb('my clock', 'Check at this computer\'s time', () => ctx.set('at', iso(Math.floor(Date.now() / 1000)))),
    qb('clear', 'No check time', () => ctx.set('at', '')));
  const ruler = h('div', { class: 'jw-ruler' });
  const verdict = h('div', { class: 'jw-verdict', 'aria-live': 'polite' });
  const lifeWarn = h('div', { class: 'jw-warn' });
  const life = h('section', { class: 'jw-panel jw-life' },
    h('div', { class: 'jw-head' }, h('span', { class: 'jw-h' }, 'Lifetime'), verdict, h('span', { class: 'jw-grow' }),
      h('label', { class: 'jw-soft jw-atl' }, 'check at ', atIn)),
    ruler, h('div', { class: 'jw-rfoot' }, h('span', { class: 'jw-soft' }, 'Drag the check handle, or focus it and use ← → (1 min), Shift (1 h), Home / End.'), quick),
    lifeWarn);

  const outCol = h('section', { class: 'jw-out' }, ctx.outputs);
  const bottom = h('div', { class: 'jw-bottom' }, life, outCol);
  root.append(h('div', { class: 'jw-page' }, strip, parts, bottom));

  // ------------------------------------------------------------ helpers
  const seg = () => ctx.result?.segments || null;
  const findValue = (pred) => (ctx.result?.values || []).find(pred);
  // Warnings go next to the part they are about.
  function routeWarnings(ws) {
    const out = { header: [], payload: [], signature: [], life: [], strip: [] };
    for (const w of ws || []) {
      if (/signature|key|secret|RSA|WebCrypto/i.test(w) && !/key URL|own key/.test(w)) out.signature.push(w);
      else if (/\b(exp|iat|nbf|Lifetime|Check time|expires|NumericDate)\b/.test(w)) out.life.push(w);
      else if (/alg|header|jku|x5u|jwk|crit|JWE/i.test(w)) out.header.push(w);
      else if (/payload|claims/i.test(w)) out.payload.push(w);
      else out.strip.push(w);
    }
    return out;
  }
  const warnBox = (list) => (list.length ? h('div', { class: 'jw-warn' }, list.map((w) => h('div', {}, w))) : null);

  // ------------------------------------------------------------ strip drawing
  function drawStrip(text) {
    const sg = seg();
    const raw = String(text ?? '');
    back.replaceChildren();
    // the part of the raw text that is the token (after any "Bearer " and quotes)
    const lead = (/^\s*(authorization:\s*)?(bearer\s+)?["']?/i.exec(raw) || [''])[0].length;
    if (sg && (sg.kind === 'jwt' || sg.kind === 'jwe')) {
      back.append(h('span', { class: 'jw-lead' }, raw.slice(0, lead)));
      let pos = lead;
      sg.parts.forEach((p, i) => {
        const cls = PART_CLASS[p.name] || 'p-x';
        const span = h('span', { class: `jw-part ${cls}${st.focusPart && st.focusPart !== p.name ? ' is-dim' : ''}` });
        const enc = raw.slice(pos, pos + p.enc.length);
        const r = st.hi && st.hi.part === p.name ? st.hi : null;
        if (r) span.append(enc.slice(0, r.c0), h('mark', { class: 'jw-mark' }, enc.slice(r.c0, r.c1)), enc.slice(r.c1));
        else span.append(enc);
        back.append(span);
        pos += p.enc.length;
        if (i < sg.parts.length - 1) { back.append(h('span', { class: 'jw-dot' }, raw.slice(pos, pos + 1))); pos += 1; }
      });
      back.append(raw.slice(pos));
    } else if (sg && sg.kind === 'base64') {
      back.append(raw.slice(0, lead));
      const body = raw.slice(lead);
      if (st.hi && st.hi.part === 'b64') {
        // groups of 4 characters, ignoring whitespace in the raw text
        let seen = 0, a = -1, b = body.length;
        for (let i = 0; i < body.length; i++) {
          if (/\s/.test(body[i])) continue;
          if (seen === st.hi.c0) a = i;
          if (seen === st.hi.c1) { b = i; break; }
          seen++;
        }
        if (a >= 0) back.append(h('span', { class: 'p-b' }, body.slice(0, a)), h('mark', { class: 'jw-mark' }, body.slice(a, b)), h('span', { class: 'p-b' }, body.slice(b)));
        else back.append(h('span', { class: 'p-b' }, body));
      } else back.append(h('span', { class: 'p-b' }, body));
    } else back.append(raw);
    back.append('​');
  }
  function highlight(part, c0, c1) {
    st.hi = part ? { part, c0, c1 } : null;
    drawStrip(ta.value);
  }
  function focusPart(name) {
    st.focusPart = name;
    drawStrip(ta.value);
  }

  // ------------------------------------------------------------ part cards
  function rowsFor(p, table, colour) {
    const byKey = new Map((table?.rows || []).map((r) => [String(r[0]), r]));
    return p.ranges.map((rg) => {
      const r = byKey.get(rg.key) || [rg.key, '', ''];
      const isTime = /^\d+ = \d{4}-/.test(String(r[1]));
      const [secs, date] = isTime ? String(r[1]).split(' = ') : [null, null];
      return h('button', { class: `jw-row ${colour}`, 'data-key': rg.key,
        onmouseenter: () => highlight(p.name, rg.c0, rg.c1), onmouseleave: () => highlight(null),
        onfocus: () => highlight(p.name, rg.c0, rg.c1), onblur: () => highlight(null),
        title: `characters ${rg.c0 + 1}-${rg.c1} of the ${p.name}` },
      h('span', { class: 'jw-k' }, rg.key),
      h('span', { class: 'jw-v' }, isTime ? [h('b', {}, date.replace('T', ' ').replace('Z', '')), h('span', { class: 'jw-soft' }, ` UTC · ${secs}`)] : String(r[1])),
      h('span', { class: 'jw-m' }, r[2] === '–' ? '' : r[2]));
    });
  }
  function partCard(p, title, colour, kids, extra) {
    const card = h('article', { class: `jw-card ${colour}`,
      onmouseenter: () => focusPart(p.name), onmouseleave: () => focusPart(null) },
    h('header', { class: 'jw-chead' }, h('span', { class: 'jw-swatch' }), h('span', { class: 'jw-ct' }, title),
      h('span', { class: 'jw-soft jw-mono' }, `${p.enc.length} chars`), h('span', { class: 'jw-grow' }), extra), kids);
    return card;
  }

  function sigCard(p, res, warnList) {
    const bytes = p.bytes ?? 0, want = p.want;
    const alg = findValue((v) => v.label === 'Algorithm')?.value || '';
    const n = Math.max(bytes, want || 0);
    const hexs = (p.hex || '').replace('…', '').match(/../g) || [];
    const cells = h('div', { class: `jw-bytes${n > 96 ? ' is-small' : ''}`, role: 'img',
      'aria-label': `${bytes} signature bytes${want ? `, ${alg} needs ${want}` : ''}` });
    for (let i = 0; i < n; i++) {
      const cls = i >= bytes ? 'is-missing' : want && i >= want ? 'is-extra' : '';
      cells.append(h('i', { class: cls, title: i < bytes ? `byte ${i}${hexs[i] ? ` = 0x${hexs[i]}` : ''}` : `byte ${i} missing` }, n <= 96 && hexs[i] ? hexs[i] : ''));
    }
    const sigV = findValue((v) => v.label === 'Signature');
    const chk = findValue((v) => v.label === 'Signature check');
    const keyTa = h('textarea', { class: 'jw-key', rows: 2, spellcheck: 'false', 'aria-label': 'Secret or public key',
      placeholder: /^HS/.test(alg) ? 'the shared secret' : 'PEM public key or a JWK', onchange: (e) => ctx.set('key', e.target.value) });
    keyTa.value = String(ctx.raw.key ?? '');
    const encSeg = /^HS/.test(alg) ? h('span', { class: 'jw-seg jw-seg-s', role: 'group', 'aria-label': 'Secret is' },
      [['text', 'text'], ['base64', 'base64']].map(([v, t]) => h('button', { 'aria-pressed': String((ctx.raw.keyEnc || 'text') === v), onclick: () => ctx.set('keyEnc', v) }, t))) : null;
    const badge = chk ? h('span', { class: `jw-badge t-${chk.tone || 'none'}` }, chk.value) : null;
    return partCard(p, 'Signature', 'p-s', [
      h('div', { class: 'jw-sigline' }, h('b', { class: `jw-mono t-${sigV?.tone || 'none'}` }, sigV?.value || ''), h('span', { class: 'jw-soft' }, sigV?.hint || '')),
      cells,
      want && bytes !== want ? h('div', { class: 'jw-bad jw-small' }, `${bytes} of ${want} bytes`) : null,
      h('div', { class: 'jw-keyhead' }, h('span', { class: 'jw-h' }, /^HS/.test(alg) ? 'Secret' : 'Public key'), encSeg, h('span', { class: 'jw-grow' }), badge),
      keyTa,
      h('div', { class: 'jw-soft jw-small' }, chk && chk.value !== 'not checked' ? `checked with ${chk.hint}; the key stays in this page` : 'Paste the key to verify here, in this page (WebCrypto).'),
      warnBox(warnList),
    ], null);
  }

  function drawParts(res) {
    const sg = res.segments;
    const tables = new Map((res.tables || []).map((t) => [t.title, t]));
    const w = routeWarnings(res.warnings);
    parts.replaceChildren();
    parts.className = 'jw-parts';
    if (!sg) return;
    if (sg.kind === 'base64') {
      parts.classList.add('is-b64');
      const hexs = (sg.hex || '').replace('…', '').match(/../g) || [];
      const grid = h('div', { class: 'jw-groups' });
      const enc = sg.enc.replace(/=+$/, '');
      for (let g = 0; g * 3 < hexs.length; g++) {
        const bs = hexs.slice(g * 3, g * 3 + 3);
        const ch = enc.slice(g * 4, g * 4 + 4);
        grid.append(h('button', { class: 'jw-grp', title: `characters ${g * 4 + 1}-${g * 4 + ch.length} carry bytes ${g * 3}-${g * 3 + bs.length - 1}`,
          onmouseenter: () => highlight('b64', g * 4, g * 4 + ch.length), onmouseleave: () => highlight(null),
          onfocus: () => highlight('b64', g * 4, g * 4 + ch.length), onblur: () => highlight(null) },
        h('span', { class: 'jw-gc' }, ch),
        h('span', { class: 'jw-gb' }, bs.join(' ')),
        h('span', { class: 'jw-ga' }, bs.map((x) => { const c = parseInt(x, 16); return c >= 32 && c < 127 ? String.fromCharCode(c) : '·'; }).join(''))));
      }
      const vals = (res.values || []).map((v) => h('span', { class: 'jw-kv' }, h('span', { class: 'jw-soft' }, v.label), h('b', {}, v.value), v.hint ? h('span', { class: 'jw-soft' }, v.hint) : null));
      parts.append(h('article', { class: 'jw-card p-b jw-wide' },
        h('header', { class: 'jw-chead' }, h('span', { class: 'jw-swatch' }), h('span', { class: 'jw-ct' }, 'Decoded bytes'),
          h('span', { class: 'jw-soft' }, 'every 4 characters carry 3 bytes: point at a group to find it in the text'), h('span', { class: 'jw-grow' }), vals),
        grid, sg.bytes > hexs.length ? h('div', { class: 'jw-soft jw-small' }, `first ${hexs.length} of ${sg.bytes} bytes; the Hex dump tab has them all`) : null,
        warnBox(w.strip.concat(w.header, w.payload, w.signature, w.life))));
      return;
    }
    const [hp, pp, sp] = sg.parts;
    const algV = findValue((v) => v.label === 'Algorithm');
    parts.append(partCard(hp, 'Header', 'p-h', [
      h('div', { class: 'jw-rows' }, rowsFor(hp, tables.get('Header'), 'p-h')),
      warnBox(w.header)], algV ? h('span', { class: `jw-badge t-${algV.tone || 'none'}` }, algV.value) : null));
    if (sg.kind === 'jwe') {
      parts.append(h('article', { class: 'jw-card p-p' },
        h('header', { class: 'jw-chead' }, h('span', { class: 'jw-swatch' }), h('span', { class: 'jw-ct' }, 'Encrypted parts')),
        h('div', { class: 'jw-rows' }, sg.parts.slice(1).map((p) => h('div', { class: 'jw-row is-static' },
          h('span', { class: 'jw-k' }, p.name), h('span', { class: 'jw-v' }, `${p.enc.length} chars`), h('span', { class: 'jw-m' }, p.name === 'ciphertext' ? 'the claims, unreadable without the private key' : '')))),
        warnBox(w.payload.concat(w.strip))));
      return;
    }
    const audV = findValue((v) => v.label === 'Audience');
    parts.append(partCard(pp, 'Payload · claims', 'p-p', [
      h('div', { class: 'jw-rows' }, pp.ranges.length ? rowsFor(pp, tables.get('Claims'), 'p-p') : h('div', { class: 'jw-soft jw-small' }, 'not readable')),
      warnBox(w.payload)], audV ? h('span', { class: 'jw-soft jw-mono' }, `aud ${audV.value}`) : null));
    parts.append(sigCard(sp, res, w.signature));
  }

  // ------------------------------------------------------------ lifetime drawing
  function domainFor(t) {
    const pts = [num(t.iat), num(t.nbf), num(t.exp), num(t.check)].filter((x) => x != null);
    const core = [num(t.iat), num(t.nbf), num(t.exp)].filter((x) => x != null);
    if (!core.length) return null;
    let lo = Math.min(...pts), hi = Math.max(...pts);
    const lifeSpan = Math.max(60, (Math.max(...core) - Math.min(...core)) || 3600);
    const pad = Math.max(lifeSpan * 0.18, (hi - lo) * 0.06);
    return { lo: lo - pad, hi: hi + pad };
  }
  const niceStep = (secs) => [1, 5, 10, 30, 60, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800, 2592000, 31536000]
    .find((s) => s >= secs) || 31536000;

  function drawLife(res) {
    const t = res.times;
    ruler.replaceChildren();
    const w = routeWarnings(res.warnings);
    lifeWarn.replaceChildren(...w.life.map((x) => h('div', {}, x)));
    const atV = findValue((v) => /^At /.test(v.label));
    verdict.replaceChildren(...(atV ? [h('span', { class: `jw-badge t-${atV.tone || 'none'}` }, atV.value), h('span', { class: 'jw-soft' }, atV.hint || '')] : [h('span', { class: 'jw-soft' }, 'no check time')]));
    if (!t) { life.classList.add('is-off'); ruler.append(h('div', { class: 'jw-soft jw-small' }, 'No readable time claims.')); return; }
    life.classList.remove('is-off');
    if (!st.drag || !st.dom) st.dom = domainFor(t);
    const dom = st.dom;
    if (!dom) { ruler.append(h('div', { class: 'jw-soft jw-small' }, 'The token has no iat, nbf or exp: it never expires.')); return; }
    const W = Math.max(300, ruler.clientWidth || 600), H = 150, L = 14, R = 14, Y = 78;
    const X = (v) => L + ((v - dom.lo) / (dom.hi - dom.lo)) * (W - L - R);
    const T = (x) => dom.lo + ((x - L) / (W - L - R)) * (dom.hi - dom.lo);
    const svg = sv('svg', { class: 'jw-svg', viewBox: `0 0 ${W} ${H}`, width: W, height: H });
    const iat = num(t.iat), nbf = num(t.nbf), exp = num(t.exp), chk = num(t.check);
    const start = nbf ?? iat;
    // bands: before valid, valid, expired
    if (start != null) svg.append(sv('rect', { x: L, y: Y - 16, width: Math.max(0, X(start) - L), height: 32, class: 'b-pre' }));
    svg.append(sv('rect', { x: start != null ? X(start) : L, y: Y - 16, width: Math.max(0, (exp != null ? X(exp) : W - R) - (start != null ? X(start) : L)), height: 32, class: 'b-ok' }));
    if (exp != null) svg.append(sv('rect', { x: X(exp), y: Y - 16, width: Math.max(0, W - R - X(exp)), height: 32, class: 'b-exp' }));
    svg.append(sv('text', { x: (start != null ? X(start) : L) + 8, y: Y + 4, class: 'l-band' }, 'valid'));
    if (exp != null && W - R - X(exp) > 60) svg.append(sv('text', { x: (X(exp) + W - R) / 2, y: Y + 4, class: 'l-band l-exp', 'text-anchor': 'middle' }, 'expired'));
    if (start != null && X(start) - L > 70) svg.append(sv('text', { x: (L + X(start)) / 2, y: Y + 4, class: 'l-band l-pre', 'text-anchor': 'middle' }, 'not yet'));
    // ticks
    const step = niceStep((dom.hi - dom.lo) / Math.max(3, Math.floor((W - L - R) / 110)));
    for (let v = Math.ceil(dom.lo / step) * step; v <= dom.hi; v += step) {
      const x = X(v);
      svg.append(sv('line', { x1: x, x2: x, y1: Y + 16, y2: Y + 22, class: 'tick' }));
      const s = iso(v);
      svg.append(sv('text', { x, y: Y + 34, class: 'l-tick', 'text-anchor': 'middle' }, step >= 86400 ? s.slice(0, 10) : step < 60 ? s.slice(11, 19) : s.slice(11, 16)));
    }
    svg.append(sv('text', { x: L, y: H - 4, class: 'l-tick' }, `UTC · ${iso(dom.lo).slice(0, 10)}`));
    // claim marks
    const marks = [];
    if (iat != null) marks.push({ at: iat, label: 'iat', cls: 'm-iat' });
    if (nbf != null && nbf !== iat) marks.push({ at: nbf, label: 'nbf', cls: 'm-iat' });
    if (nbf != null && nbf === iat) marks[0].label = 'iat = nbf';
    if (exp != null) marks.push({ at: exp, label: 'exp', cls: 'm-exp' });
    const ends = [];
    for (const m of marks) {
      const x = X(m.at);
      const txt = `${m.label} ${iso(m.at).slice(11, 19)}`;
      const tw = txt.length * 6.7;
      const anchor = x - tw / 2 < L ? 'start' : x + tw / 2 > W - R ? 'end' : 'middle';
      const left = anchor === 'start' ? x : anchor === 'end' ? x - tw : x - tw / 2;
      let row = ends.findIndex((e) => left > e + 6);
      if (row < 0) row = ends.length;
      ends[row] = left + tw;
      svg.append(sv('line', { x1: x, x2: x, y1: Y - 26 - row * 13, y2: Y + 16, class: m.cls }));
      svg.append(sv('text', { x, y: Y - 30 - row * 13, class: `l-mark ${m.cls}`, 'text-anchor': anchor }, txt));
    }
    // this computer's clock, when it falls inside
    const now = Math.floor(Date.now() / 1000);
    if (now > dom.lo && now < dom.hi) {
      svg.append(sv('line', { x1: X(now), x2: X(now), y1: Y - 16, y2: Y + 16, class: 'm-now' }));
      svg.append(sv('text', { x: X(now) + 3, y: Y + 13, class: 'l-now' }, 'my clock'));
    }
    // the check handle
    const handle = sv('g', { class: 'jw-handle', tabindex: '0', role: 'slider', 'aria-label': 'Check time',
      'aria-valuemin': Math.round(dom.lo), 'aria-valuemax': Math.round(dom.hi), 'aria-valuenow': chk ?? '', 'aria-valuetext': chk != null ? `${iso(chk)}, ${atV?.value || ''}` : 'none' });
    if (chk != null) {
      const x = X(chk);
      const tone = atV?.tone || 'none';
      handle.append(sv('line', { x1: x, x2: x, y1: 12, y2: Y + 16, class: `h-line t-${tone}` }));
      handle.append(sv('rect', { x: x - 7, y: Y - 7, width: 14, height: 14, rx: 3, class: `h-knob t-${tone}` }));
      const lab = `${iso(chk).replace('T', ' ').replace('Z', '')}  ${atV?.value || ''}`;
      const lw = lab.length * 6.4 + 12;
      const lx = Math.min(W - R - lw, Math.max(L, x - lw / 2));
      handle.append(sv('rect', { x: lx, y: 0, width: lw, height: 16, rx: 3, class: `h-lab t-${tone}` }));
      handle.append(sv('text', { x: lx + 6, y: 12, class: 'h-txt' }, lab));
    }
    svg.append(handle);
    ruler.append(svg);

    st.geo = { W, L, R, dom };
    handle.addEventListener('keydown', (e) => {
      const base = chk ?? start ?? iat ?? exp;
      if (base == null) return;
      const big = e.shiftKey ? 3600 : 60;
      let v = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v = base + big;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v = base - big;
      else if (e.key === 'Home' && start != null) v = start;
      else if (e.key === 'End' && exp != null) v = exp;
      if (v == null) return;
      e.preventDefault();
      st.keyFocus = true;
      ctx.set('at', iso(v));
    });
    if (st.keyFocus) { st.keyFocus = false; handle.focus({ preventScroll: true }); }
  }

  // dragging: the ruler keeps the pointer while the drawing inside it is
  // redrawn; the scale stays frozen until the handle is let go
  const setAtX = (clientX) => {
    const g = st.geo;
    const svg = ruler.querySelector('svg');
    if (!g || !svg) return;
    const r = svg.getBoundingClientRect();
    const x = ((clientX - r.left) / r.width) * g.W;
    const sec = g.dom.lo + ((x - g.L) / (g.W - g.L - g.R)) * (g.dom.hi - g.dom.lo);
    const stp = Math.max(1, Math.round(niceStep((g.dom.hi - g.dom.lo) / (g.W - g.L - g.R)) / 5));
    const v = Math.round(Math.min(g.dom.hi, Math.max(g.dom.lo, sec)) / stp) * stp;
    if (v !== st.lastSet) { st.lastSet = v; ctx.set('at', iso(v)); }
  };
  ruler.addEventListener('pointerdown', (e) => {
    if (!st.geo || e.button > 0) return;
    e.preventDefault();
    st.drag = true;
    ruler.setPointerCapture(e.pointerId);
    setAtX(e.clientX);
  });
  ruler.addEventListener('pointermove', (e) => { if (st.drag) setAtX(e.clientX); });
  const endDrag = () => {
    if (!st.drag) return;
    st.drag = false;
    st.keyFocus = true;
    drawLife(ctx.result);
  };
  ruler.addEventListener('pointerup', endDrag);
  ruler.addEventListener('pointercancel', endDrag);
  new ResizeObserver(() => { if (ctx.result?.times && !st.drag) drawLife(ctx.result); }).observe(ruler);

  // ------------------------------------------------------------ result in
  ctx.onResult((res) => {
    const raw = ctx.raw;
    if (document.activeElement !== ta && ta.value !== String(raw.token ?? '')) ta.value = String(raw.token ?? '');
    if (document.activeElement !== atIn) atIn.value = String(raw.at ?? '');
    for (const b of modeSeg.querySelectorAll('button')) b.setAttribute('aria-pressed', String((raw.mode || 'auto') === b.dataset.v));
    const sg = res.segments;
    legend.replaceChildren(...(sg?.kind === 'jwt' || sg?.kind === 'jwe'
      ? sg.parts.map((p) => h('span', { class: `jw-lg ${PART_CLASS[p.name] || 'p-x'}` }, h('i'), `${p.name} ${p.enc.length}`))
      : sg?.kind === 'base64' ? [h('span', { class: 'jw-lg p-b' }, h('i'), `base64 · ${sg.bytes} bytes`)] : []));
    const w = routeWarnings(res.warnings);
    stripWarn.replaceChildren(...(sg ? w.strip : res.warnings || []).map((x) => h('div', {}, x)));
    st.hi = null;
    drawStrip(ta.value);
    // keep keyboard focus in the key box across re-renders
    const keyFocused = document.activeElement?.classList.contains('jw-key');
    drawParts(res);
    if (keyFocused) parts.querySelector('.jw-key')?.focus();
    life.hidden = !(sg && sg.kind === 'jwt');
    bottom.classList.toggle('no-life', life.hidden);
    if (!life.hidden) drawLife(res);
    // open on the decoded payload unless a tab was picked before
    if (!st.tabDone && sg?.kind === 'jwt') {
      st.tabDone = true;
      let picked = null;
      try { picked = localStorage.getItem(`redline.tool.${ctx.manifest.id}.input.tab`); } catch { /* private window */ }
      if (!picked) [...ctx.outputs.querySelectorAll('.k-tab')].find((b) => b.textContent === 'Payload')?.click();
    }
  });
}
