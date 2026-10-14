/** A wiki page's text, read the way the server reads it (backend/wiki.py):
 *  a page's id from its name, the [[page]] links and the @kind:id mentions
 *  in it, and the Markdown ready for the page with those two drawn as links
 *  into the app. Pure functions only: tests/test_wiki.py runs this file in
 *  node next to the Python and checks the two agree. */

export interface WikiMention { kind: 'model' | 'board' | 'part' | 'firmware'; id: string }

const LINK = /\[\[([^\[\]\n|]{1,80})(?:\|([^\[\]\n]{1,80}))?\]\]/g;
const MENTION = /(?<![\p{L}\p{N}_@])@(model|board|part|firmware):([A-Za-z0-9_](?:[A-Za-z0-9_./-]*[A-Za-z0-9_])?)/gu;
// Code is code: a [[x]] or @model:x inside it is not a link.
const CODE = /```[\s\S]*?(?:```|$)|`[^`\n]+`/g;

/** A page's id from its name: lower case, words joined by '-' (wiki.py slug). */
export function slug(name: string): string {
  let s = String(name ?? '').replace(/İ/g, 'i').trim().toLowerCase();
  s = s.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^[-_]+|[-_]+$/g, '');
  return s.replace(/-{2,}/g, '-').slice(0, 60).replace(/^-+|-+$/g, '');
}

/** The pages a text links to and what it mentions, code left out. */
export function parse(text: string): { links: string[]; mentions: WikiMention[] } {
  const bare = String(text ?? '').replace(CODE, ' ');
  const links: string[] = [];
  for (const m of bare.matchAll(LINK)) {
    const s = slug(m[1]);
    if (s && !links.includes(s)) links.push(s);
  }
  const mentions: WikiMention[] = [];
  for (const m of bare.matchAll(MENTION)) {
    const one = { kind: m[1] as WikiMention['kind'], id: m[2] };
    if (!mentions.some(x => x.kind === one.kind && x.id === one.id)) mentions.push(one);
  }
  return { links, mentions };
}

/** Where a mention opens: the room it lives in (nav-url.ts addresses). An LCSC part opens in Parts. */
export function mentionHref(m: WikiMention): string {
  const segs = (id: string) => id.split('/').map(encodeURIComponent).join('/');
  switch (m.kind) {
    case 'model': return '/3d/' + segs(m.id);
    case 'board': return '/pcb/' + segs(m.id);
    case 'firmware': return '/firmware/' + segs(m.id);
    default: return '/parts/lcsc/' + encodeURIComponent(m.id);
  }
}

export function pageHref(project: string, page: string): string {
  return '/wiki/' + encodeURIComponent(project) + (page ? '/' + encodeURIComponent(page) : '');
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string) => s.replace(/[&<>"']/g, c => ESC[c]);

/** The text with its links and mentions swapped for marks the Markdown renderer leaves alone
 *  (\u0002n\u0002), and the HTML each mark becomes once the Markdown is HTML (`unmark`).
 *  `has(slug)` says whether a linked page is there yet: a link to none is drawn as one to make. */
export function marked(text: string, project: string, has: (slug: string) => boolean,
                       label: (m: WikiMention) => string = m => m.id): { text: string; unmark: (html: string) => string } {
  const out: string[] = [];
  const put = (html: string) => { out.push(html); return `\u0002${out.length - 1}\u0002`; };
  const swap = (s: string) => s
    .replace(LINK, (_, name: string, words?: string) => {
      const s2 = slug(name);
      if (!s2) return _;
      const there = has(s2);
      return put(`<a class="wk-link${there ? '' : ' wk-new'}" href="${esc(pageHref(project, s2))}"`
        + `${there ? '' : ' title="not written yet"'}>${esc((words ?? name).trim())}</a>`);
    })
    .replace(MENTION, (_, kind: WikiMention['kind'], id: string) =>
      put(`<a class="wk-at" href="${esc(mentionHref({ kind, id }))}" title="${esc(kind + ' ' + id)}">@${esc(label({ kind, id }))}</a>`));
  // Code stays as it was written.
  let last = 0, done = '';
  for (const m of String(text ?? '').matchAll(CODE)) {
    done += swap(text.slice(last, m.index)) + m[0];
    last = (m.index ?? 0) + m[0].length;
  }
  done += swap(String(text ?? '').slice(last));
  return { text: done, unmark: html => html.replace(/\u0002(\d+)\u0002/g, (_, i: string) => out[+i] ?? '') };
}
