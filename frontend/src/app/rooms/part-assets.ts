/** What the part card shows, kept in memory for the last few parts.
 *
 *  The server keeps every part on disk after the first look, so a second
 *  open costs only the round trips - but those were made one after another
 *  (the facts, then the drawings and the model once the card was drawn,
 *  then the footprint's frame for the 3D). Here they start together, as
 *  soon as a part is asked for, and a part opened again is read from
 *  memory. A failed fetch is forgotten, so the next open asks again. */

const KEEP = 16;

class Lru<V> {
  private map = new Map<string, V>();
  get(k: string): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) { this.map.delete(k); this.map.set(k, v); }
    return v;
  }
  set(k: string, v: V) {
    this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > KEEP * 4) this.map.delete(this.map.keys().next().value!);
  }
  drop(k: string) { this.map.delete(k); }
}

const bytes = new Lru<Promise<ArrayBuffer>>();
const json = new Lru<Promise<unknown>>();
const images = new Lru<HTMLImageElement>();

function kept<T>(cache: Lru<Promise<T>>, url: string, get: (r: Response) => Promise<T>): Promise<T> {
  const had = cache.get(url);
  if (had) return had;
  const p = fetch(url, { credentials: 'same-origin' }).then(r => {
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return get(r);
  });
  p.catch(() => cache.drop(url));
  cache.set(url, p);
  return p;
}

/** A GLB or any other binary, once. */
export function fetchBytes(url: string): Promise<ArrayBuffer> {
  return kept(bytes, url, r => r.arrayBuffer());
}

/** JSON that does not change under the same URL (a body's payload, the
 *  footprint's frame), once. */
export function fetchJson<T>(url: string): Promise<T> {
  return kept(json as Lru<Promise<T>>, url, r => r.json() as Promise<T>);
}

/** An image asked for now, so the card's <img> finds it in the cache. */
export function warmImage(url: string) {
  if (images.get(url)) return;
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  images.set(url, img);
}

export const partFile = (lcsc: string, name: string) => `/api/parts/${encodeURIComponent(lcsc)}/${name}`;
export const specUrl = (lcsc: string) => `/api/parts/${encodeURIComponent(lcsc)}/body-spec`;

/** Everything the card will ask for a part already in the drawer, at once.
 *  Only for kept parts: one never seen would send the server to LCSC. */
export function warmPart(lcsc: string, has3d: boolean) {
  warmImage(partFile(lcsc, 'footprint.svg'));
  warmImage(partFile(lcsc, 'symbol.svg'));
  if (has3d) void fetchBytes(partFile(lcsc, 'model.glb')).catch(() => {});
  void fetchJson(specUrl(lcsc)).catch(() => {});
}
