import { Component, Injectable, computed, inject, input, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { Auth } from '../auth';
import { Confirm } from '../confirm';
import { LANG, T, t } from '../i18n';
import { Prefs } from '../preferences';
import { Toast } from '../toast';
import { Skeleton } from '../skeleton';
import { MeshThumbs } from './mesh-thumb';
import { StoredFile } from './files-model';
import { StockPanel, StockState, qty } from './stock';

/** McMaster-Carr and GrabCAD in Parts: search-and-link sources
 *  (backend/linked.py). Their parts and models are found through a web
 *  search of the site - the site itself is never read -, each links to its
 *  own page, where the person downloads its STEP, and the saved ones keep
 *  the CAD files dropped on them (in Files, for the CAD rooms).
 *
 *  LinkedDesk is the work, one per catalog page (`providers`): the search
 *  ("Find on McMaster-Carr" - the same as the Chat's mcmaster_find), saving,
 *  one saved item open in full and its files. LinkedHead is the top of the
 *  source's page, LinkedCard the item in full, LinkedTable the saved ones
 *  as rows; the catalog (manufacturers.ts) shows them as Drawer and Grid. */

export interface LinkedFile { file: string; name: string; kind: string; bytes: number; sha256: string; original?: string;
  by?: { name?: string }; at?: string; has_thumb?: string | null }
export interface LinkedItem {
  id: string; source: string; key: string; title: string; url: string; notes: string; tags: string[];
  quantity: number | null; specs: Record<string, string>; licence?: string; author?: string;
  cad: LinkedFile | null; files: LinkedFile[]; by?: { id?: string; name?: string }; created_at?: string; updated_at?: string;
  /** The McMaster API's own fetch of its STEP, when it was asked and could not. */
  fetch?: { error: string; at: string };
}
export interface LinkedHit { key: string; kind?: 'category'; filtered?: boolean; title: string; url: string; author?: string; specs: Record<string, string>;
  snippet: string; source: string; saved: boolean }
/** One web search of a source search, as the page follows it. */
export interface SearchStep { n: number; of: number; words: string; running: boolean; rows?: number; items?: number; ms?: number;
  error?: string | null; enough?: boolean }
export interface LinkedFound { ok: boolean; results: LinkedHit[]; queries: string[]; error: string | null; how: string; caution: string }
export interface McmApi { filled: boolean; connected: boolean; wired: boolean; auto_step: boolean }

/** What each source is called and how its key looks: the page's own words (the server's are in backend/linked.py). */
export const LINKED: Record<string, { name: string; noun: string; key: string; how: string; caution: string;
  find: string; line: string; paste: RegExp; site: string; accept: string; empty: string }> = {
  mcmaster: {
    name: 'McMaster-Carr', noun: 'part', key: 'Part number', how: 'CAD → 3-D STEP → Download', caution: '',
    find: 'Describe a part (M3x10 stainless socket head screw), or paste a part number or link',
    line: 'Open a part\'s page for its STEP - CAD → 3-D STEP → Download - and drop the file on the saved card.',
    paste: /^\s*(\d{3,5}[A-Za-z]{1,2}\d{1,4}|https?:\/\/(www\.)?mcmaster\.com\/\S*\d{3,5}[A-Za-z]{1,2}\d{1,4}\S*)\s*$/,
    site: 'mcmaster.com', accept: '.step,.stp,.zip',
    empty: 'Find a part above and save it; then drop the STEP you download from its page on the saved card.',
  },
  grabcad: {
    name: 'GrabCAD', noun: 'model', key: 'Model', how: 'Open → Download files (needs a free GrabCAD login) → pick the STEP',
    caution: 'Check the model\'s licence on its page before using it in a product.',
    find: 'Describe a model (NEMA 17 stepper motor), or paste a GrabCAD library link',
    line: 'Open a model\'s page - Download files (needs a free GrabCAD login) - pick the STEP and drop it on the saved model.',
    paste: /^\s*https?:\/\/(www\.)?grabcad\.com\/library\/[a-z0-9-]+\S*\s*$/i,
    site: 'grabcad.com', accept: '.step,.stp,.stl,.3mf,.obj,.zip',
    empty: 'Find a model above and save it; then drop the files you download from its page on it.',
  },
};
export const isLinked = (mid: string | null | undefined) => !!mid && mid in LINKED;

/** A size, as Files writes it. */
export function kb(n: number) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
function fmt(text: string, vars: Record<string, string | number>) {
  return t(text).replace(/\{(\w+)\}/g, (m, k) => k in vars ? String(vars[k]) : m);
}
function why(e: unknown, fallback: string): string {
  const d = (e as HttpErrorResponse)?.error?.detail;
  return typeof d === 'string' ? d : t(fallback);
}
function stamp(iso: string | null | undefined): string {
  if (!iso) return '–';
  return new Date(iso).toLocaleString(LANG() === 'tr' ? 'tr-TR' : [], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

@Injectable()
export class LinkedDesk {
  private http = inject(HttpClient);
  private auth = inject(Auth);
  private solids = inject(MeshThumbs);
  /** Bumped when a saved item changes: the catalog reads the source again. */
  readonly changed = signal(0);
  /** The source whose search is shown, and what it found. */
  src = signal<string>('mcmaster');
  term = signal('');
  found = signal<LinkedFound | null>(null);
  looking = signal(false);
  err = signal('');
  busy = signal<string | null>(null);
  /** One saved item, in full. */
  open = signal<LinkedItem | null>(null);
  dropping = signal(false);
  uploading = signal(false);
  mcm = signal<McmApi | null>(null);

  canEdit() { return this.auth.can('draw'); }
  meta(src: string) { return LINKED[src] ?? LINKED['mcmaster']; }
  private base(src: string) { return `/api/linked/${encodeURIComponent(src)}`; }

  /** Words search; a part number or the item's link is saved at once. */
  go() {
    const q = this.term().trim();
    if (!q) return;
    if (this.meta(this.src()).paste.test(q) && this.canEdit()) { this.save({ key: q }); return; }
    this.find(q);
  }
  /** The search as it goes: each web search as it starts and what it brought. */
  steps = signal<SearchStep[]>([]);
  /** When the search began, and a clock for its seconds (ms). */
  since = signal(0);
  now = signal(0);
  /** How long the last search took, in seconds. */
  took = signal<number | null>(null);
  private es: EventSource | null = null;
  private tick: ReturnType<typeof setInterval> | undefined;

  find(q: string) {
    const src = this.src();
    this.stop();
    this.looking.set(true); this.err.set(''); this.found.set(null); this.steps.set([]); this.took.set(null);
    const t0 = Date.now();
    this.since.set(t0); this.now.set(t0);
    this.tick = setInterval(() => this.now.set(Date.now()), 250);
    const es = new EventSource(`${this.base(src)}/search/stream?q=${encodeURIComponent(q)}&n=12`);
    this.es = es;
    es.onmessage = m => {
      if (this.src() !== src) { this.stop(); return; }
      const ev = JSON.parse(m.data);
      if (ev.type === 'search') {
        this.steps.update(l => [...l, { n: ev.n, of: ev.of, words: ev.words, running: true }]);
      } else if (ev.type === 'got') {
        this.steps.update(l => l.map(x => x.n === ev.n ? { ...x, running: false, rows: ev.rows, items: ev.items, ms: ev.ms,
                                                           error: ev.error ?? null, enough: !!ev.enough } : x));
      } else if (ev.type === 'done') {
        this.took.set((Date.now() - t0) / 1000);
        this.stop();
        if (ev.error && !(ev.results || []).length) { this.err.set(ev.error); this.found.set(null); }
        else this.found.set(ev as LinkedFound);
      }
    };
    es.onerror = () => {
      if (!this.looking()) return;
      this.stop();
      this.err.set(t('The search failed.'));
    };
  }
  /** Stop following the search (Cancel, another search, another page). */
  stop() {
    this.es?.close(); this.es = null;
    clearInterval(this.tick); this.tick = undefined;
    this.looking.set(false);
  }
  elapsed() { return Math.max(0, (this.now() - this.since()) / 1000); }
  async save(h: Partial<LinkedHit> & { key: string }) {
    const src = this.src();
    this.busy.set(h.key);
    try {
      const r = await firstValueFrom(this.http.post<{ part: LinkedItem; new: boolean }>(`${this.base(src)}/parts`, {
        key: h.kind === 'category' ? h.key : h.url && !this.meta(src).paste.test(h.key) ? h.url : h.key, ...(h.title ? { title: h.title } : {}),
        ...(h.specs && Object.keys(h.specs).length ? { specs: h.specs } : {}), ...(h.author ? { author: h.author } : {}) }));
      this.found.update(f => f && { ...f, results: f.results.map(x => x.key === r.part.key ? { ...x, saved: true } : x) });
      Toast.show(r.new ? fmt('{k} saved', { k: r.part.key }) : fmt('{k} was saved already', { k: r.part.key }), { tone: r.new ? 'ok' : 'info' });
      if (this.meta(src).paste.test(this.term())) this.term.set('');
      this.changed.update(n => n + 1);
    } catch (e) { Toast.show(why(e, 'Could not save it.'), { tone: 'danger' }); }
    this.busy.set(null);
  }

  /** An item in full, read again from the server. */
  show(src: string, item: LinkedItem) {
    this.open.set(item);
    this.want(item);
    if (src === 'mcmaster' && !this.mcm()) this.http.get<McmApi>('/api/mcmaster/settings').subscribe({ next: s => this.mcm.set(s), error: () => {} });
  }
  close() { this.open.set(null); this.dropping.set(false); }
  async patch(it: LinkedItem, body: Partial<Record<'title' | 'notes' | 'tags' | 'quantity' | 'licence' | 'author', unknown>>) {
    try {
      const r = await firstValueFrom(this.http.patch<LinkedItem>(`${this.base(it.source)}/parts/${encodeURIComponent(it.id || it.key)}`, body));
      if (this.open()?.id === r.id) this.open.set(r);
      this.changed.update(n => n + 1);
      return true;
    } catch (e) { Toast.show(why(e, 'Could not save it.'), { tone: 'danger' }); return false; }
  }
  async remove(src: string, keys: string[], ask = true): Promise<boolean> {
    if (!keys.length) return false;
    const m = this.meta(src);
    if (ask && !await Confirm.ask({ title: keys.length === 1 ? fmt('Remove {k} from {s}?', { k: keys[0], s: m.name }) : fmt('Remove {n} saved items from {s}?', { n: keys.length, s: m.name }),
                                    text: t('Their CAD files stay in Files.'), ok: t('Remove'), danger: true })) return false;
    let gone = 0;
    for (const k of keys) {
      try { await firstValueFrom(this.http.delete(`${this.base(src)}/parts/${encodeURIComponent(k)}`)); gone++; }
      catch (e) { Toast.show(why(e, 'Could not remove it.'), { tone: 'danger' }); }
    }
    if (gone && keys.includes(this.open()?.key ?? '')) this.close();
    this.changed.update(n => n + 1);
    return gone > 0;
  }
  /** Files dropped on an item: a STEP, a mesh, or the ZIP the site gave. */
  async upload(it: LinkedItem, list: FileList | File[] | null) {
    const fs = [...(list ?? [])];
    if (!fs.length) return;
    this.uploading.set(true);
    for (const f of fs) {
      const body = new FormData();
      body.append('upload', f, f.name);
      try {
        const r = await firstValueFrom(this.http.post<LinkedItem>(`${this.base(it.source)}/parts/${encodeURIComponent(it.id || it.key)}/files`, body));
        if (this.open()?.id === r.id) this.open.set(r);
        this.want(r);
        Toast.show(fmt('{f} kept with {k}', { f: f.name, k: it.key }), { tone: 'ok' });
      } catch (e) { Toast.show(why(e, 'Could not keep the file.'), { tone: 'danger' }); }
    }
    this.uploading.set(false);
    this.changed.update(n => n + 1);
  }
  /** "Download STEP" through the McMaster API: it says what it can. */
  apiStep(it: LinkedItem) {
    this.http.get(`/api/mcmaster/parts/${encodeURIComponent(it.key)}/cad`).subscribe({
      next: () => Toast.show(t('The API answered; fetching its STEP is not wired in yet.')),
      error: e => Toast.show(why(e, 'The McMaster-Carr API is not connected.'), { tone: 'info' }),
    });
  }
  /** Its CAD file's picture: drawn by the first page that shows it (mesh-thumb.ts), as Files does. */
  want(it: LinkedItem) {
    const c = it.cad;
    if (!c || c.has_thumb) return;
    this.solids.want({ id: c.file, name: c.name, bytes: c.bytes, preview: c.kind === 'step' ? 'step' : 'mesh' } as StoredFile, this.canEdit());
  }
  /** The picture of an item's CAD file, when there is one. */
  pic(it: LinkedItem | null | undefined): string | null {
    const c = it?.cad;
    if (!c) return null;
    return this.solids.drawn()[c.file] ?? (c.has_thumb ? `/api/files/${encodeURIComponent(c.file)}/thumb?v=${c.has_thumb}` : null);
  }
}

/** The tint a CAD file's grey picture gets (styles.css .tcv-fm-solid), as in Files. */
const TINT = `
<svg class="tcv-fm-defs" aria-hidden="true" focusable="false" style="position: absolute; width: 0; height: 0">
  <filter id="tcv-fm-tint" color-interpolation-filters="sRGB">
    <feFlood class="tcv-fm-tint" result="ink" />
    <feComposite in="ink" in2="SourceAlpha" operator="in" result="shape" />
    <feBlend in="shape" in2="SourceGraphic" mode="multiply" />
  </filter>
</svg>`;

/** The top of a search-and-link source's page: what it is, and the search front and centre. */
@Component({
  selector: 'wb-linked-head',
  imports: [T, Skeleton],
  styleUrls: ['../settings.css', './taste.css', './manufacturers.css', './linked.css'],
  template: TINT + `
<header class="tst-head ln-head">
  <div class="tst-title">
    <h2>{{ m().name }}</h2>
    <span class="st-sub"><a class="mf-link" [href]="url()" target="_blank" rel="noopener noreferrer">{{ m().site }} ↗</a>
      · {{ (src() === 'grabcad' ? 'models found through a web search of its library; GrabCAD itself is never read' : 'parts found through a web search; mcmaster.com itself is never read') | t }}</span>
  </div>
  <div class="tst-acts ln-counts">
    <span class="st-sub">{{ fmt('{n} saved', { n: count() }) }} · {{ fmt('{n} with a CAD file', { n: withCad() }) }}</span>
    @if (src() === 'mcmaster') { <button class="st-more" (click)="toSettings()" [title]="'McMaster-Carr API access: Settings > Proxy & Data' | t">{{ 'API access' | t }}</button> }
  </div>
</header>
<section class="st-card mf-pageadd ln-find" role="search">
  <!-- One slim row like the other forms of the catalog: what it does, the words, the button. -->
  <div class="mf-addrow mf-ctl">
    <span class="mf-label mf-rowlabel">{{ fmt('Find on {s}', { s: m().name }) }}</span>
    <input class="tst-in" [placeholder]="m().find | t" [value]="desk.term()" (input)="desk.term.set($any($event.target).value)"
           (keydown.enter)="desk.go()" (keydown.escape)="desk.term.set(''); desk.found.set(null)" [attr.aria-label]="fmt('Find on {s}', { s: m().name })">
    <span class="st-sub mf-pagenote" [title]="m().line | t">{{ m().how }}</span>
    <button class="tcv-btn tcv-btn-accent" (click)="desk.go()" [disabled]="desk.looking() || !desk.term().trim()">
      {{ desk.looking() ? ('Searching…' | t) : (pasted() ? ('Save' | t) : ('Find' | t)) }}</button>
  </div>
  @if (m().caution) { <p class="ln-how"><b class="ln-caution">{{ m().caution | t }}</b></p> }
  @if (desk.err(); as e) { <p class="st-err">{{ e }}</p> }
  @if (desk.looking() || (desk.steps().length && !desk.found())) {
    <div class="ln-prog" role="status" aria-live="polite">
      <div class="ln-prog-head">
        @if (desk.looking()) { <span class="ln-spin" aria-hidden="true"></span> }
        <b>{{ (desk.looking() ? 'Searching' : 'Stopped') | t }}</b>
        <span class="dim">{{ fmt('{s} through a web search of its library', { s: m().name }) }}</span>
        <span class="ln-prog-time mono">{{ desk.elapsed().toFixed(1) }} s</span>
        @if (desk.looking()) { <button class="st-more" (click)="desk.stop()">{{ 'Cancel' | t }}</button> }
      </div>
      <ol class="ln-steps">
        @for (st of desk.steps(); track st.n) {
          <li [attr.data-state]="st.running ? 'run' : st.error ? 'bad' : 'ok'">
            <i aria-hidden="true"></i>
            <span>{{ fmt('Web search {n} of up to {of}', { n: st.n, of: st.of }) }} <code>{{ st.words }}</code></span>
            <em class="mono">@if (st.running) { {{ 'searching…' | t }} } @else if (st.error) { {{ st.error }} }
              @else { {{ fmt('{r} results, {i} usable', { r: st.rows ?? 0, i: st.items ?? 0 }) }} · {{ ((st.ms ?? 0) / 1000).toFixed(1) }} s }</em>
          </li>
          @if (!st.running && !st.error && !st.enough && st.n < st.of && desk.looking()) {
            <li data-state="info"><i aria-hidden="true"></i><span>{{ 'Too few found - searching again in other words' | t }}</span></li>
          }
        } @empty {
          <li data-state="run"><i aria-hidden="true"></i><span>{{ 'Starting the search…' | t }}</span></li>
        }
      </ol>
      @if (desk.looking()) {
        <div class="ln-results ln-ghosts" aria-hidden="true">@for (g of [1, 2, 3]; track g) { <div class="ln-ghost"><wb-skel kind="text" [count]="3" /></div> }</div>
      }
    </div>
  }
  @if (desk.found(); as f) {
    <div class="ln-res-head"><span class="st-sub">{{ fmt('{n} found', { n: f.results.length }) }}@if (desk.took() !== null) { · {{ fmt('in {s} s', { s: desk.took()!.toFixed(1) }) }} }
      @if (f.queries.length) { <span class="dim" [title]="f.queries.join('\\n')"> · {{ fmt(f.queries.length === 1 ? 'one web search' : '{n} web searches', { n: f.queries.length }) }}</span> }</span>
      <button class="st-more" (click)="desk.found.set(null)">{{ 'Clear' | t }}</button></div>
    @if (f.results.length) {
      <div class="ln-results">
        @for (h of f.results; track h.key) {
          <article class="ln-hit" [attr.data-saved]="h.saved ? 1 : null">
            <div class="ln-hit-top">
              @if (h.kind === 'category') { <span class="st-tag">{{ 'Category' | t }}</span> } @else { <span class="ln-key mono">{{ h.key }}</span> }
              @if (h.saved) { <span class="st-tag" data-tone="ok">{{ 'saved' | t }}</span> }</div>
            <div class="ln-hit-title" [title]="h.title">{{ h.title }}</div>
            @if (h.author) { <div class="ln-hit-by dim">{{ fmt('by {a}', { a: h.author }) }}</div> }
            @if (specs(h).length) { <div class="ln-specs">@for (s of specs(h); track s[0]) { <span class="mf-spec"><em>{{ s[0] }}</em> {{ s[1] }}</span> }</div> }
            @if (h.kind === 'category') {
              <div class="ln-hint ln-hit-how">{{ (h.filtered ? 'Opens on the size asked for. Save it, download a row\\'s 3-D STEP and drop it on the saved card: it becomes that part.'
                                                              : 'Save it, pick the size on its page, download that row\\'s 3-D STEP and drop it on the saved card: it becomes that part.') | t }}</div>
            } @else {
              <div class="ln-hint ln-hit-how" [title]="m().how">{{ 'On its page:' | t }} {{ m().how }}</div>
            }
            <div class="ln-hit-foot">
              <a class="tcv-btn ln-open" [href]="h.url" target="_blank" rel="noopener noreferrer" [title]="h.url">{{ fmt('Open on {s}', { s: m().name }) }} ↗</a>
              @if (!h.saved && desk.canEdit()) { <button class="tcv-btn tcv-btn-accent" (click)="desk.save(h)" [disabled]="desk.busy() === h.key">{{ (desk.busy() === h.key ? 'saving…' : 'Save') | t }}</button> }
            </div>
          </article>
        }
      </div>
    } @else {
      <p class="ln-none">{{ 'Nothing came up. Try other words: the kind of thing first, then its size and material.' | t }}</p>
    }
  }
</section>`,
})
export class LinkedHead {
  readonly desk = inject(LinkedDesk);
  private prefs = inject(Prefs);
  readonly src = input.required<string>();
  readonly url = input<string>('');
  readonly items = input<{ linked?: LinkedItem }[]>([]);
  m = computed(() => this.desk.meta(this.src()));
  count = computed(() => this.items().length);
  withCad = computed(() => this.items().filter(p => p.linked?.cad).length);
  pasted = computed(() => this.m().paste.test(this.desk.term()));
  t = t;
  fmt = fmt;
  specs(h: LinkedHit) { return Object.entries(h.specs).slice(0, 6); }
  toSettings() { this.prefs.open.set('proxy'); }
}

/** A saved item in full: its page and the hint, its CAD files and a drop zone for more, what the person wrote of it. */
@Component({
  selector: 'wb-linked-card',
  imports: [T, StockPanel],
  styleUrls: ['../settings.css', './taste.css', './manufacturers.css', './linked.css'],
  template: `
@if (desk.open(); as it) {
  <div class="mf-modal tcv-m-veil" animate.leave="tcv-leave" (click)="desk.close()">
    <div class="mf-detail ln-card tcv-m-box" role="dialog" aria-modal="true" [attr.aria-label]="it.title || it.key" (click)="$event.stopPropagation()"
         (keydown.escape)="desk.close()">
      <button class="tcv-cc-ib mf-x" (click)="desk.close()" [title]="'Close' | t">
        <svg class="tcv-cc-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12 M18 6L6 18" /></svg></button>
      <div class="mf-dgal">
        <div class="ln-pic">@if (desk.pic(it); as src) { <img class="tcv-fm-solid" [src]="src" alt=""> }
          @else { <svg class="ln-cube" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z M4 7.5l8 4.5 8-4.5 M12 12v9" /></svg>
                  <span class="dim">{{ (it.cad ? 'drawing its picture…' : 'no CAD file yet') | t }}</span> }</div>
        @if (desk.canEdit()) {
          <label class="ln-drop" [attr.data-on]="desk.dropping() ? 1 : null" [attr.data-busy]="desk.uploading() ? 1 : null"
                 (dragover)="$event.preventDefault(); desk.dropping.set(true)" (dragleave)="desk.dropping.set(false)"
                 (drop)="$event.preventDefault(); desk.dropping.set(false); desk.upload(it, $any($event).dataTransfer?.files)">
            <input type="file" multiple [accept]="m().accept" hidden (change)="desk.upload(it, $any($event.target).files); $any($event.target).value = ''">
            <b>{{ (desk.uploading() ? 'Keeping it…' : (it.cad ? 'Drop another file here' : 'Drop the STEP here')) | t }}</b>
            <span>{{ (it.source === 'grabcad' ? 'STEP, STL, 3MF, OBJ or the ZIP GrabCAD gives - or click to choose' : 'the STEP from its page, or click to choose') | t }}</span>
          </label>
        }
        @if (it.files.length) {
          <table class="mf-dspecs ln-files"><tbody>
            @for (f of it.files; track f.file) {
              <tr [attr.data-main]="f.file === it.cad?.file ? 1 : null">
                <td class="mono give"><a class="mf-link" [href]="'/api/files/' + f.file" [title]="f.original || f.name">{{ f.name }}</a></td>
                <td class="dim">{{ f.kind.toUpperCase() }}</td><td class="r mono dim">{{ kb(f.bytes) }}</td></tr>
            }
          </tbody></table>
          <p class="ln-agent dim">{{ 'The CAD rooms use it as a model of its own:' | t }} <code>revisions.py linked to-model {{ it.source }}:{{ it.key }} --folder …</code></p>
        }
      </div>
      <div class="mf-dinfo">
        <span class="mf-dseller"><span>{{ m().name }}</span><span class="mono">{{ it.key.startsWith('cat:') ? ('Category' | t) : it.key }}</span>
          <button class="st-more" (click)="copy(it.key)">{{ 'Copy' | t }}</button></span>
        <textarea class="tst-name ln-title" rows="2" [value]="it.title" [placeholder]="m().key | t" [readonly]="!desk.canEdit()"
                  (change)="desk.patch(it, { title: $any($event.target).value })" (keydown.enter)="$event.preventDefault(); $any($event.target).blur()" [attr.aria-label]="'Name' | t"></textarea>
        <div class="ln-link">
          <a class="tcv-btn tcv-btn-accent" [href]="it.url" target="_blank" rel="noopener noreferrer">{{ fmt('Open on {s}', { s: m().name }) }} ↗</a>
          <span class="ln-hint">{{ m().how }}</span>
          @if (it.source === 'mcmaster') {
            @if (desk.mcm()?.filled) { <button class="tcv-btn" (click)="desk.apiStep(it)" [title]="'Through the McMaster-Carr API - not wired in yet' | t">{{ 'Download STEP (API)' | t }}</button> }
            @else { <span class="dim ln-apinote">{{ 'With McMaster-Carr API access (Settings > Proxy & Data) this will be one click; access is pending.' | t }}</span> }
          }
        </div>
        @if (m().caution) { <p class="ln-caution">{{ m().caution | t }}</p> }
        @if (it.fetch; as f) { <p class="st-hint" data-tone="warn">{{ fmt('Fetching its STEP through the API: {e}', { e: f.error }) }}</p> }
        <div class="ln-fields mf-ctl">
          <label><span class="mf-label">{{ 'Quantity' | t }}</span>
            <input class="tst-in" inputmode="numeric" [value]="it.quantity ?? ''" [readonly]="!desk.canEdit()" [placeholder]="'how many are needed' | t"
                   (change)="desk.patch(it, { quantity: $any($event.target).value })"></label>
          <label class="ln-wide"><span class="mf-label">{{ 'Tags' | t }}</span>
            <input class="tst-in" [value]="it.tags.join(', ')" [readonly]="!desk.canEdit()" [placeholder]="'fasteners, lamp' | t"
                   (change)="desk.patch(it, { tags: $any($event.target).value })"></label>
          @if (it.source === 'grabcad') {
            <label><span class="mf-label">{{ 'Uploaded by' | t }}</span>
              <input class="tst-in" [value]="it.author ?? ''" [readonly]="!desk.canEdit()" (change)="desk.patch(it, { author: $any($event.target).value })"></label>
            <label class="ln-wide"><span class="mf-label">{{ 'Licence' | t }}</span>
              <input class="tst-in" [value]="it.licence ?? ''" [readonly]="!desk.canEdit()" [placeholder]="'as its page says' | t"
                     (change)="desk.patch(it, { licence: $any($event.target).value })"></label>
          }
          <label class="ln-full"><span class="mf-label">{{ 'Notes' | t }}</span>
            <textarea class="tst-desc" rows="3" [value]="it.notes" [readonly]="!desk.canEdit()" [placeholder]="'what it is for, which design uses it' | t"
                      (change)="desk.patch(it, { notes: $any($event.target).value })"></textarea></label>
        </div>
        @if (specs(it).length) {
          <table class="mf-dspecs"><tbody>@for (s of specs(it); track s[0]) { <tr><th>{{ s[0] }}</th><td>{{ s[1] }}</td></tr> }</tbody></table>
        }
        <dl class="mf-dates">
          <div><dt>{{ 'Saved' | t }}</dt><dd>{{ stamp(it.created_at) }} · {{ it.by?.name || ('someone' | t) }}</dd></div>
          <div><dt>{{ 'CAD file' | t }}</dt><dd>{{ it.cad ? stamp(it.cad.at) + ' · ' + (it.cad.by?.name || '') : ('not yet' | t) }}</dd></div>
        </dl>
        @if (desk.canEdit()) {
          <div class="mf-dacts"><button class="tcv-btn tst-del" (click)="desk.remove(it.source, [it.key])">{{ 'Remove' | t }}</button></div>
        }
        <!-- how many are on hand (stock.ts): a saved part is a Parts product like any other -->
        <wb-stock-panel [maker]="it.source" [product]="it.key" />
      </div>
    </div>
  </div>
}`,
})
export class LinkedCard {
  readonly desk = inject(LinkedDesk);
  m = computed(() => this.desk.meta(this.desk.open()?.source ?? 'mcmaster'));
  t = t;
  fmt = fmt;
  kb = kb;
  stamp = stamp;
  specs(it: LinkedItem) { return Object.entries(it.specs ?? {}); }
  copy(k: string) {
    try { navigator.clipboard.writeText(k).then(() => Toast.show(fmt('{c} copied', { c: k })), () => {}); } catch { /* no clipboard */ }
  }
}

/** The saved items as rows: their picture, key, name, tags, how many, their CAD file. */
@Component({
  selector: 'wb-linked-table',
  imports: [T],
  styleUrls: ['../settings.css', './manufacturers.css', './linked.css', './stock.css'],
  template: `
<div class="st-table-wrap">
  <table class="st-table mf-gtable ln-table">
    <thead><tr><th class="mf-gthumb"></th><th>{{ m().key | t }}</th><th>{{ 'Name' | t }}</th>
      @if (src() === 'grabcad') { <th>{{ 'Uploaded by' | t }}</th><th>{{ 'Licence' | t }}</th> }
      <th>{{ 'Tags' | t }}</th><th class="r" [title]="'How many are needed' | t">{{ 'Needed' | t }}</th><th class="r">{{ 'On hand' | t }}</th><th>{{ 'CAD file' | t }}</th><th>{{ 'Saved' | t }}</th><th class="r"></th></tr></thead>
    <tbody>
      @for (it of items(); track it.id) {
        <tr class="mf-prow" (click)="desk.show(src(), it)">
          <td class="mf-gthumb"><span class="ln-thumb">@if (desk.pic(it); as s) { <img class="tcv-fm-solid" [src]="s" alt="" loading="lazy"> }
            @else { <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z M4 7.5l8 4.5 8-4.5 M12 12v9" /></svg> }</span></td>
          <td class="mono">{{ it.key }}</td>
          <td class="give" [title]="it.notes || it.title"><b>{{ it.title || '–' }}</b></td>
          @if (src() === 'grabcad') { <td class="dim">{{ it.author || '–' }}</td><td class="dim">{{ it.licence || '–' }}</td> }
          <td class="dim">{{ it.tags.join(', ') || '–' }}</td>
          <td class="r mono">{{ it.quantity ?? '–' }}</td>
          <td class="r">@if (stock.of(src(), it.key); as s) { <span class="mf-onhand" [attr.data-low]="s.low ? 1 : null" [attr.data-out]="s.quantity <= 0 ? 1 : null">{{ qty(s.quantity) }} {{ s.unit }}</span> } @else { <span class="dim">–</span> }</td>
          <td>@if (it.cad; as c) { <span class="st-tag" data-tone="ok" [title]="c.name">{{ c.kind.toUpperCase() }}</span>
                @if (it.files.length > 1) { <span class="dim"> +{{ it.files.length - 1 }}</span> } }
              @else { <span class="dim">{{ 'not yet' | t }}</span> }</td>
          <td class="dim">{{ it.by?.name || '' }}</td>
          <td class="r"><a class="st-more" [href]="it.url" target="_blank" rel="noopener noreferrer" (click)="$event.stopPropagation()">{{ 'Open' | t }} ↗</a></td>
        </tr>
      } @empty { <tr><td colspan="11" class="dim">{{ 'Nothing matches.' | t }}</td></tr> }
    </tbody>
  </table>
</div>`,
})
export class LinkedTable {
  readonly desk = inject(LinkedDesk);
  readonly stock = inject(StockState);
  qty = qty;
  readonly src = input.required<string>();
  readonly items = input<LinkedItem[]>([]);
  m = computed(() => this.desk.meta(this.src()));
}
