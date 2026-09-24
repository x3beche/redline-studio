// The contract as the project's record: loaded from /api/tools/data/interface-contract
// when the tool opens (into the form, with api.set), saved with "Save to project".
// Agents read and write the same record with MCP tool_data. If the record changed
// since it was loaded, the first Save press says so instead of overwriting.

const KEYS = ['board', 'mcu_rail', 'five_tolerant', 'rails', 'gpio', 'i2c'];
const S = { draw: () => {}, tried: false, busy: false, project: null, updated: null, saved: null, msg: '', tone: '', confirm: false };

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

const pick = (raw) => Object.fromEntries(KEYS.map((k) => [k, raw[k]]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// The API's times may come without a zone (stored as UTC): read them as UTC.
const ms = (iso) => (iso ? Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`) : NaN);
const when = (iso) => { if (!iso) return 'never'; const t = ms(iso); return Number.isFinite(t) ? new Date(t).toLocaleString() : String(iso); };
const sameTime = (a, b) => (!a && !b) || Math.abs(ms(a) - ms(b)) < 2;
const url = (project) => `/api/tools/data/interface-contract?project=${encodeURIComponent(project || 'default')}`;

async function load(api, redraw, quiet) {
  const project = String(api.raw.project || 'default').trim() || 'default';
  S.busy = true; S.msg = `Loading the ${project} record…`; S.tone = ''; redraw();
  try {
    const r = await fetch(url(project));
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`);
    const body = await r.json();
    S.project = project; S.updated = body.updated || null; S.confirm = false;
    const data = body.data || {};
    if (!Object.keys(data).length) {
      S.saved = null;
      S.msg = `No saved contract for project "${project}" yet: the tables below are local. Save to project to share them.`; S.tone = 'warn';
    } else {
      S.saved = pick({ ...pick(api.raw), ...data });
      S.msg = `Loaded the "${project}" record, saved ${when(S.updated)}.`; S.tone = 'ok';
      S.busy = false;
      for (const k of KEYS) if (k in data && !same(data[k], api.raw[k])) api.set(k, data[k]);
      return;
    }
  } catch (e) {
    S.msg = `Could not load the record: ${e.message || e}`; S.tone = 'bad';
    if (quiet) S.msg += ' (working locally).';
  } finally { S.busy = false; redraw(); }
}

async function save(api, redraw) {
  const project = String(api.raw.project || 'default').trim() || 'default';
  S.busy = true; S.msg = 'Saving…'; S.tone = ''; redraw();
  try {
    if (!S.confirm) {
      // Someone (another room, an agent) may have saved since we loaded.
      const cur = await (await fetch(url(project))).json();
      const theirs = cur.data || {};
      const changed = Object.keys(theirs).length && !sameTime(cur.updated, project === S.project ? S.updated : null) && !same(pick({ ...pick(api.raw), ...theirs }), pick(api.raw));
      if (changed) {
        S.confirm = true; S.busy = false;
        S.msg = `The "${project}" record was changed ${when(cur.updated)} by someone else. Press Save again to overwrite it, or Reload to take theirs.`; S.tone = 'warn';
        redraw(); return;
      }
    }
    const data = pick(api.raw);
    const r = await fetch(url(project), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`);
    const body = await r.json();
    S.project = project; S.updated = body.updated || new Date().toISOString(); S.saved = structuredClone(data); S.confirm = false;
    S.msg = `Saved to project "${project}" at ${when(S.updated)}.`; S.tone = 'ok';
  } catch (e) {
    S.msg = `Could not save: ${e.message || e}`; S.tone = 'bad';
  } finally { S.busy = false; redraw(); }
}

export function view(el, result, input, api) {
  const served = /^https?:/.test(location.protocol);
  const draw = () => {
    const project = String(api.raw.project || 'default').trim() || 'default';
    const dirty = S.saved ? !same(pick(api.raw), S.saved) : true;
    const other = S.project && S.project !== project;
    el.replaceChildren($('div', { class: 'k-block' },
      $('div', { class: 'k-title' }, 'Project record'),
      !served
        ? $('div', { style: 'font-size:12px;color:var(--ink-soft)' }, 'Open this tool in the app to load and save the contract as the project\'s record. Here the tables are only local to this browser.')
        : $('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' },
          $('button', { class: 'k-btn k-primary', disabled: S.busy, onclick: () => save(api, () => S.draw()) }, S.confirm ? 'Save anyway' : 'Save to project'),
          $('button', { class: 'k-btn', disabled: S.busy, onclick: () => load(api, () => S.draw()) }, other ? `Load "${project}"` : 'Reload'),
          $('span', { style: `font-size:12px;color:var(${S.tone === 'ok' ? '--ok' : S.tone === 'warn' ? '--warn' : S.tone === 'bad' ? '--danger' : '--ink-soft'})`, role: 'status' }, S.msg || ''),
          $('span', { style: 'font-size:11px;color:var(--ink-soft);flex-basis:100%' },
            `Project "${S.project || project}" · last saved ${when(S.updated)}${S.saved && dirty && !S.busy ? ' · unsaved changes' : ''}${other ? ` · the form now names "${project}"` : ''}`))));
  };
  S.draw = () => { if (el.isConnected) draw(); };
  if (served && !S.tried) { S.tried = true; load(api, () => S.draw(), true); return; }
  draw();
}
