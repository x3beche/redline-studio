/** A fingerprint of a stored view, the same in the page and in
 *  tools/render.py (view_hash): keys sorted, numbers to four decimals,
 *  FNV-1a over the UTF-8. The render compares it with its own to know the
 *  page applied this note's view and not some other. */
export function viewHash(view: unknown): string {
  const canon = (x: unknown): string => {
    if (x === null || x === undefined) return 'null';
    if (typeof x === 'boolean') return x ? 'true' : 'false';
    if (typeof x === 'number') {
      if (!Number.isFinite(x)) return 'null';
      const t = x.toFixed(4);
      return t === '-0.0000' ? '0.0000' : t;
    }
    if (typeof x === 'string') return JSON.stringify(x);
    if (Array.isArray(x)) return '[' + x.map(canon).join(',') + ']';
    const o = x as Record<string, unknown>;
    return '{' + Object.keys(o).filter(k => o[k] !== undefined).sort()
      .map(k => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}';
  };
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(canon(view))) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
