/** The address and what is on screen, one to the other (nav.ts uses it).
 *
 *  The app keeps what is open as a set of named values - the room (`ws`),
 *  the model, the board, the conversation, the manufacturer and product, the
 *  Parts page's filters - the way it always has in the query string
 *  (?ws=pcb&board=ctl). In the address they are a path instead, so a link
 *  reads like where it goes and the browser's Back and Forward have places
 *  to go to:
 *
 *    /3d/<model>              /pcb/<board>             /firmware/<fw>
 *    /notes/<note>            /taste/<palette>         /taste/run/<run>
 *    /parts                   /parts/stock|sites|orphans
 *    /parts/<maker>           /parts/<maker>/<product>  /parts/run/<run>
 *    /parts[/<sub>]/product/<maker>/<product>  (a product open over the overview)
 *    /chat/<conversation>     /chat/thread/<room>      /dm/<conversation>
 *    /files                   /files/mine/<folder>     /files/app/<area…>
 *    /files/storage           /files/deleted
 *    /basic-tools/<tool>      /settings/<section>      /analytics
 *
 *  What has no place in the path (a search, a filter, ?rev=, ?shot=) stays in
 *  the query. An old link (?ws=catalog&m=…, ?model=…&rev=…, ?ws=chat&chat=…)
 *  reads as the same values, so it opens the same view - and is written back
 *  in the new form. Basic Tools is /basic-tools, not /tools: /tools/<name> is
 *  where the tools' own static pages are served (public/tools).
 *
 *  Pure functions only, so nav-url.spec.ts can check every way there and back.
 */

export type RoomId = 'cad' | 'pcb' | 'firmware' | 'notes' | 'taste' | 'mfr' | 'commandcode' | 'files' | 'tools' | 'settings' | 'analyze';

/** Each room's first path segment. */
export const ROOM_PATH: Record<RoomId, string> = {
  cad: '3d', pcb: 'pcb', firmware: 'firmware', notes: 'notes', taste: 'taste', mfr: 'parts',
  commandcode: 'chat', files: 'files', tools: 'basic-tools', settings: 'settings', analyze: 'analytics',
};
const PATH_ROOM: Record<string, RoomId> = Object.fromEntries(
  Object.entries(ROOM_PATH).map(([id, p]) => [p, id as RoomId])) as Record<string, RoomId>;

/** Every value that belongs to one room: left behind when another room is opened. */
export const ROOM_KEYS: Record<RoomId, string[]> = {
  cad: ['model', 'rev'],
  pcb: ['board', 'tab', 'sheet'],
  firmware: ['fw'],
  notes: ['note'],
  taste: ['palette', 'run'],
  mfr: ['m', 'run', 'p', 'pm', 'sub', 'item', 'q', 'cat', 'held', 'maker', 'seller', 'min', 'max', 'stock', 'check', 'sort', 'view',
        'sq', 'type', 'iloc', 'low', 'smaker', 'sview', 'iq', 'icat', 'paste'],
  commandcode: ['chat', 'thread', 'dm'],
  files: ['dir', 'file'],
  tools: ['tool'],
  settings: ['section'],
  analyze: ['range', 'project'],
};

/** The values that make a place of their own: a change of one is a new entry
 *  in the browser's history (Back comes back to it); a change of anything
 *  else - a search, a filter - is written over the entry on screen. A product
 *  open over Parts (p) and a file preview (file) are boxes: they have an
 *  entry of their own while open (BackCloses in nav.ts) rather than this way. */
export const PLACE_KEYS: Record<RoomId, string[]> = {
  cad: ['model'], pcb: ['board'], firmware: ['fw'], notes: ['note'], taste: ['palette', 'run'],
  mfr: ['m', 'run', 'sub'], commandcode: ['chat', 'thread', 'dm'], files: ['dir'], tools: ['tool'],
  settings: ['section'], analyze: [],
};

/** The names the rooms had in old addresses (?ws=chat, ?ws=catalog, ...). */
const OLD_WS: Record<string, RoomId> = {
  chat: 'commandcode', catalog: 'mfr', supply: 'mfr', inventory: 'mfr', parts: 'mfr', '3d': 'cad',
  analytics: 'analyze', 'basic-tools': 'tools',
};
export function roomOf(ws: string | null | undefined): RoomId | null {
  if (!ws) return null;
  if (ws in ROOM_PATH) return ws as RoomId;
  return OLD_WS[ws] ?? null;
}

const PARTS_SUBS = ['stock', 'sites', 'orphans'];

/** A path segment, readable: what a path may hold as it is (`:`, `@`, `~`, `,`) is left so. */
export function seg(s: string): string {
  return encodeURIComponent(s).replace(/%3A/gi, ':').replace(/%40/g, '@').replace(/%2C/gi, ',');
}
function unseg(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}
/** An id that may hold slashes itself (a model in a folder, iot/box): one segment per part. */
function segs(id: string): string { return id.split('/').map(seg).join('/'); }

/** The address, read: what is open, as named values. Path wins over the query. */
export function parse(pathname: string, search: string): URLSearchParams {
  const q = new URLSearchParams(search);
  const parts = pathname.split('/').filter(Boolean).map(unseg);
  // Old addresses: the room by its old name, or none named and only told by what is asked.
  const old = q.get('ws');
  if (old !== null) {
    const r = roomOf(old);
    if (r) q.set('ws', r); else q.delete('ws');
    if (old === 'inventory' && !q.has('sub')) q.set('sub', 'stock');
  }
  if (!parts.length) {
    if (!q.has('ws')) {
      const guess: RoomId | null = q.has('model') || q.has('rev') ? 'cad' : q.has('board') ? 'pcb' : q.has('fw') ? 'firmware'
        : q.has('chat') || q.has('thread') || q.has('dm') ? 'commandcode' : null;
      if (guess) q.set('ws', guess);
    }
    return q;
  }
  const [head, ...rest] = parts;
  if (head === 'dm') {
    q.set('ws', 'commandcode');
    if (rest[0]) q.set('dm', rest[0]);
    return q;
  }
  const room = PATH_ROOM[head];
  if (!room) return q;        // not one of the app's: left as it is
  q.set('ws', room);
  const put = (k: string, v: string | undefined) => { if (v) q.set(k, v); };
  switch (room) {
    case 'cad': put('model', rest.join('/')); break;
    case 'pcb': put('board', rest.join('/')); break;
    case 'firmware': put('fw', rest.join('/')); break;
    case 'notes': put('note', rest[0]); break;
    case 'taste':
      if (rest[0] === 'run') put('run', rest[1]); else put('palette', rest[0]);
      break;
    case 'commandcode':
      if (rest[0] === 'thread') put('thread', rest[1]); else put('chat', rest[0]);
      break;
    case 'files':
      if (rest[0] === 'storage') q.set('dir', '~storage');
      else if (rest[0] === 'deleted') q.set('dir', '~trash');
      else if (rest[0] === 'app') q.set('dir', 'v:' + (rest.slice(1).join('/') || 'projects'));
      else if (rest[0] === 'mine' && rest[1]) q.set('dir', rest[1]);
      break;
    case 'tools': put('tool', rest[0]); break;
    case 'settings': put('section', rest[0]); break;
    case 'mfr': parseParts(rest, q); break;
    case 'analyze': break;
  }
  return q;
}

function parseParts(r: string[], q: URLSearchParams) {
  const product = (at: number) => { if (r[at] === 'product' && r[at + 1] && r[at + 2]) { q.set('pm', r[at + 1]); q.set('p', r[at + 2]); } };
  if (!r.length) return;
  if (r[0] === 'run') { if (r[1]) q.set('run', r[1]); return; }
  if (r[0] === 'product') { product(0); return; }
  if (PARTS_SUBS.includes(r[0])) { q.set('sub', r[0]); product(1); return; }
  q.set('m', r[0]);
  if (r[1] === 'product') product(1);
  else if (r[1]) { q.set('p', r[1]); q.set('pm', r[0]); }
}

/** What is open, written as an address: the path, then what has no place in it. */
export function build(v: URLSearchParams): string {
  const q = new URLSearchParams(v);
  const room = roomOf(q.get('ws'));
  if (!room) return '/' + (q.toString() ? '?' + q : '');
  q.delete('ws');
  const take = (k: string) => { const x = q.get(k); q.delete(k); return x || null; };
  let path = '/' + ROOM_PATH[room];
  switch (room) {
    case 'cad': { const m = take('model'); if (m) path += '/' + segs(m); break; }
    case 'pcb': { const b = take('board'); if (b) path += '/' + segs(b); break; }
    case 'firmware': { const f = take('fw'); if (f) path += '/' + segs(f); break; }
    case 'notes': { const n = take('note'); if (n) path += '/' + seg(n); break; }
    case 'taste': {
      const r = take('run'), p = take('palette');
      if (r) { path += '/run/' + seg(r); if (p) q.set('palette', p); } else if (p) path += '/' + seg(p);
      break;
    }
    case 'commandcode': {
      // One of them is on screen: a direct conversation over a room's thread over an AI one.
      const dm = take('dm'), th = take('thread'), c = take('chat');
      if (dm) path = '/dm/' + seg(dm);
      else if (th) path += '/thread/' + seg(th);
      else if (c) path += '/' + seg(c);
      break;
    }
    case 'files': {
      const d = take('dir');
      if (d === '~storage') path += '/storage';
      else if (d === '~trash') path += '/deleted';
      else if (d?.startsWith('v:')) path += '/app/' + segs(d.slice(2));
      else if (d) path += '/mine/' + seg(d);
      break;
    }
    case 'tools': { const t = take('tool'); if (t) path += '/' + seg(t); break; }
    case 'settings': { const s = take('section'); if (s) path += '/' + seg(s); break; }
    case 'mfr': path += buildParts(q); break;
    case 'analyze': break;
  }
  const rest = q.toString();
  return path + (rest ? '?' + rest : '');
}

function buildParts(q: URLSearchParams): string {
  const run = q.get('run'), m = q.get('m'), sub = q.get('sub'), p = q.get('p'), pm = q.get('pm');
  const product = () => { q.delete('p'); q.delete('pm'); return `/product/${seg(pm!)}/${seg(p!)}`; };
  if (run) { q.delete('run'); q.delete('m'); return '/run/' + seg(run); }
  if (m) {
    q.delete('m');
    if (p && pm === m) { q.delete('p'); q.delete('pm'); return `/${seg(m)}/${seg(p)}`; }
    return '/' + seg(m) + (p && pm ? product() : '');
  }
  let out = '';
  if (sub && PARTS_SUBS.includes(sub)) { q.delete('sub'); out = '/' + sub; }
  return out + (p && pm ? product() : '');
}

/** The rooms that open something by themselves when nothing is named (the last model, the last
 *  note, the last conversation): their first choice fills the entry in rather than being a step. */
const FILLS_IN = new Set<RoomId>(['cad', 'pcb', 'firmware', 'notes', 'taste', 'commandcode', 'tools', 'settings']);

/** Whether going from `a` to `b` is a step in the browser's history: another room, or another
 *  place in it (PLACE_KEYS) - but not a room filling in its first choice where nothing was named. */
export function isStep(a: URLSearchParams, b: URLSearchParams): boolean {
  const ra = roomOf(a.get('ws')), rb = roomOf(b.get('ws'));
  if (!rb) return false;
  if (ra !== rb) return !!ra;
  const keys = PLACE_KEYS[rb], was = keys.map(k => a.get(k) ?? ''), now = keys.map(k => b.get(k) ?? '');
  if (was.join('|') === now.join('|')) return false;
  return !(FILLS_IN.has(rb) && was.every(x => !x));
}

/** Opening another room: every room's values go (a run of Parts is not one of Taste's), what
 *  is not a room's stays (?theme=), and the room is set. What it is to open is added after. */
export function enter(v: URLSearchParams, room: RoomId): URLSearchParams {
  const out = new URLSearchParams(v);
  if (roomOf(out.get('ws')) === room) return out;
  for (const keys of Object.values(ROOM_KEYS)) for (const k of keys) out.delete(k);
  out.set('ws', room);
  return out;
}

/** A shared link's own page, /s/<token> (backend/shares.py, share/share-page.ts). Not a room:
 *  the app is not started there at all (main.ts), so a visitor with the link, signed in or
 *  not, gets that one page. backend/app_links.py share() writes the same. */
const SHARE_PATH = /^\/s\/([A-Za-z0-9_-]{16,128})\/?$/;
export function shareToken(pathname: string): string | null {
  return SHARE_PATH.exec(pathname)?.[1] ?? null;
}
export function shareHref(token: string): string {
  return '/s/' + seg(token);
}
