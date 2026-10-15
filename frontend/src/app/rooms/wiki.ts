import { Component, ElementRef, Injectable, OnDestroy, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { LANG, T, t } from '../i18n';
import { Auth } from '../auth';
import { Confirm } from '../confirm';
import { Toast } from '../toast';
import { UiSelect, SelectOption } from '../ui-select';
import { EmptyState } from '../empty-state';
import { Skeleton } from '../skeleton';
import { toHtml } from '../markdown';
import { highlightIn } from '../code-highlight';
import { navParams, navPopped, navSet, navTitle } from '../nav';
import { WikiMention, marked, mentionHref, pageHref, slug } from './wiki-text';

/** The Wiki: each project's short pages - what was decided and why, the
 *  dimensions and limits, where the parts come from, the open questions,
 *  the production notes (backend/wiki.py).
 *
 *  Reached from the top bar's More (a tab when switched on in Settings > Top bar), at /wiki,
 *  /wiki/<project>, /wiki/<project>/<page>. The list on the left is the
 *  project's pages, the project picked at its top; the page on the right
 *  reads as Markdown and is edited where it stands - a click on its text or
 *  Edit, Ctrl+S keeps it, Esc leaves it - with a preview of the same
 *  rendering. [[Page]] links another page, @model:id / @board:id /
 *  @part:C123 point at things (typing @ or [[ offers them), and both are
 *  drawn as links that open in the app. Every save is a version: History
 *  shows who, when, the change, and puts an old one back.
 *
 *  The rooms' agents get the project's pages with a note (revisions.py
 *  show), and the Chat reads and writes them (wiki_* tools). Taste is the
 *  person's style; the wiki is the project's facts. */

export interface WikiProject { id: string; pages: number; updated_at: string | null }
interface Who { id?: string; name?: string; type?: string }
export interface WikiRow {
  project: string; slug: string; title: string; version: number; pinned: boolean; chars: number;
  links: string[]; updated_at: string | null; updated_by: Who; summary: string;
}
export interface WikiPage extends WikiRow {
  text: string; mentions: WikiMention[]; created_at: string | null; created_by: Who;
  linked_from: { slug: string; title: string }[]; link_titles: Record<string, string | null>;
}
interface Hit { project: string; slug: string; title: string; snippet: string; line: number }
interface Ver { n: number; title: string; by: Who; at: string; summary: string; added: number; removed: number; chars: number; restored_from?: number }
interface Compare { from: number; to: number; version: { n: number; text: string; title: string }; rows: { op: string; text: string; a?: number; b?: number }[] }
interface PickRow { kind: string; id: string; label: string; sub?: string }

const LAST = 'redline.wiki.project';
const enc = encodeURIComponent;

@Injectable({ providedIn: 'root' })
export class WikiApi {
  private http = inject(HttpClient);
  projects() { return firstValueFrom(this.http.get<WikiProject[]>('/api/wiki/projects')); }
  pages(p: string) { return firstValueFrom(this.http.get<{ exists: boolean; pages: WikiRow[] }>(`/api/wiki/p/${enc(p)}`)); }
  page(p: string, s: string) { return firstValueFrom(this.http.get<WikiPage>(`/api/wiki/p/${enc(p)}/${enc(s)}`)); }
  save(p: string, s: string, body: { text: string; title: string; summary: string; base: number | null }) {
    return firstValueFrom(this.http.put<WikiPage & { changed: boolean }>(`/api/wiki/p/${enc(p)}/${enc(s)}`, body));
  }
  pin(p: string, s: string, pinned: boolean) { return firstValueFrom(this.http.patch<WikiPage>(`/api/wiki/p/${enc(p)}/${enc(s)}`, { pinned })); }
  remove(p: string, s: string) { return firstValueFrom(this.http.delete(`/api/wiki/p/${enc(p)}/${enc(s)}`)); }
  history(p: string, s: string) { return firstValueFrom(this.http.get<Ver[]>(`/api/wiki/p/${enc(p)}/${enc(s)}/history`)); }
  version(p: string, s: string, n: number) { return firstValueFrom(this.http.get<Compare>(`/api/wiki/p/${enc(p)}/${enc(s)}/versions/${n}`)); }
  restore(p: string, s: string, version: number) {
    return firstValueFrom(this.http.post<WikiPage>(`/api/wiki/p/${enc(p)}/${enc(s)}/restore`, { version }));
  }
  search(q: string, project: string) {
    return firstValueFrom(this.http.get<Hit[]>(`/api/wiki/search?q=${enc(q)}&project=${enc(project)}&limit=40`));
  }
  mentions(q: string) {
    return firstValueFrom(this.http.get<PickRow[]>(`/api/cc/mentions?q=${enc(q)}&limit=30`));
  }
}

/** Pages a new wiki often starts with: written by hand, one click from an empty project. */
const STARTERS: { name: string; tr: string; en: string; trText: string }[] = [
  { name: 'Decisions', tr: 'Kararlar',
    en: '| Date | Decision | Why |\n|---|---|---|\n| {date} |  |  |\n',
    trText: '| Tarih | Karar | Neden |\n|---|---|---|\n| {date} |  |  |\n' },
  { name: 'Dimensions and limits', tr: 'Ölçüler ve sınırlar',
    en: '| What | Value | Limit / tolerance | Source |\n|---|---|---|---|\n|  |  |  |  |\n',
    trText: '| Ne | Değer | Sınır / tolerans | Kaynak |\n|---|---|---|---|\n|  |  |  |  |\n' },
  { name: 'Sourcing', tr: 'Tedarik',
    en: '| Part | Where | Code | Price | Lead time |\n|---|---|---|---|---|\n|  |  |  |  |  |\n',
    trText: '| Parça | Nereden | Kod | Fiyat | Teslim |\n|---|---|---|---|---|\n|  |  |  |  |  |\n' },
  { name: 'Open questions', tr: 'Açık sorular',
    en: '- [ ] \n',
    trText: '- [ ] \n' },
  { name: 'Production notes', tr: 'Üretim notları',
    en: '## Printing\n\n## Assembly\n\n## Testing\n',
    trText: '## Baskı\n\n## Montaj\n\n## Test\n' },
];

function ago(iso: string | null | undefined): string {
  if (!iso) return '';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return t('now');
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d`;
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

const ICON = {
  search: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z M20 20l-4.8-4.8',
  plus: 'M12 5v14 M5 12h14',
  pin: 'M9 4h6l-1 6 3 3H7l3-3z M12 13v7',
  at: 'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0z M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1',
  doc: 'M6 3h9l4 4v14H6z M14 3v5h5',
};

@Component({
  selector: 'app-room-wiki',
  imports: [T, UiSelect, EmptyState, Skeleton],
  styleUrl: './wiki.css',
  host: { '(document:keydown)': 'key($event)' },
  template: `
<div class="tcv-room wk absolute inset-0">
  <!-- LEFT: the project, a search, its pages -->
  <aside class="wk-side">
    <div class="wk-proj">
      <wb-select size="sm" label="Project" placeholder="Choose a project" [options]="projectOpts()" [value]="project()"
                 [tip]="'The project whose wiki this is: a top folder of the tree' | t" (pick)="pickProject($event)" />
    </div>
    <div class="wk-find">
      <label class="tcv-cc-search">
        <svg class="tcv-cc-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.search" /></svg>
        <input #search type="search" [placeholder]="(all() ? 'Search every wiki' : 'Search this wiki') | t" [value]="q()"
               [attr.aria-label]="'Search the wiki' | t" (input)="q.set($any($event.target).value)"
               (keydown.escape)="q.set(''); $any($event.target).blur()">
      </label>
      @if (auth.can('edit')) {
        <button class="tcv-cc-newsm" (click)="newPage()" [disabled]="!project()" [title]="'A new page (N)' | t">
          <svg class="tcv-cc-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.plus" /></svg><span>{{ 'New' | t }}</span>
        </button>
      }
    </div>
    <div class="wk-list" role="list">
      @if (q().trim()) {
        @for (h of hits(); track h.project + '/' + h.slug) {
          <button class="wk-row wk-hit" role="listitem" [attr.data-on]="h.project === project() && h.slug === pageSlug() ? 1 : null"
                  (click)="open(h.project, h.slug)">
            <span class="wk-row-name">{{ h.title }}@if (all()) { <span class="wk-hit-proj"> · {{ h.project }}</span> }</span>
            <span class="wk-hit-snip">{{ h.snippet }}</span>
          </button>
        } @empty {
          <wb-empty compact icon="search" [text]="searching() ? 'Searching…' : 'Nothing matches.'" />
        }
      } @else {
        @for (g of groups(); track g.name) {
          @if (g.name) { <div class="wk-group">{{ g.name | t }}</div> }
          @for (r of g.rows; track r.slug) {
            <button class="wk-row" role="listitem" [attr.data-on]="r.slug === pageSlug() ? 1 : null"
                    [attr.aria-current]="r.slug === pageSlug() ? 'page' : null" [title]="r.summary || r.title"
                    (click)="open(project(), r.slug)">
              @if (r.pinned) { <svg class="wk-row-pin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path [attr.d]="I.pin" /></svg> }
              <span class="wk-row-name">{{ r.title }}</span>
              <span class="wk-row-when">{{ when(r.updated_at) }}</span>
            </button>
          }
        } @empty {
          @if (!listLoaded()) { <wb-skel kind="rows" [count]="6" [h]="26" /> }
        }
      }
    </div>
    <div class="wk-side-foot">
      <span>{{ pages().length }} {{ (pages().length === 1 ? 'page' : 'pages') | t }}</span>
      <span class="grow"></span>
      <button class="wk-tb" [attr.data-on]="all() ? 1 : null" (click)="all.set(!all())"
              [title]="'Search every project, not only this one' | t">{{ 'All projects' | t }}</button>
    </div>
  </aside>

  <!-- RIGHT: the page, read, edited where it stands, or its history -->
  <section class="wk-main">
    @if (mode() === 'edit') {
      <div class="wk-bar">
        <input class="wk-title-in" [value]="draftTitle()" (input)="draftTitle.set($any($event.target).value)"
               [attr.aria-label]="'Page name' | t" [placeholder]="'Page name' | t">
        <span class="wk-sep"></span>
        <button class="wk-tb" [attr.data-on]="!preview() ? 1 : null" (click)="preview.set(false); focusArea()">{{ 'Write' | t }}</button>
        <button class="wk-tb" [attr.data-on]="preview() ? 1 : null" (click)="preview.set(true)">{{ 'Preview' | t }}</button>
        <span class="wk-sep"></span>
        <input class="wk-sum-in" [value]="draftSummary()" (input)="draftSummary.set($any($event.target).value)"
               (keydown.enter)="save()" [placeholder]="'What changed, in a few words' | t" [attr.aria-label]="'What changed' | t">
        <button class="tcv-btn wk-btn" (click)="cancel()" title="Esc">{{ 'Cancel' | t }}</button>
        <button class="tcv-btn tcv-btn-accent wk-btn" (click)="save()" [disabled]="saving() || !draft().trim() || !draftTitle().trim()"
                title="Ctrl+S">{{ (saving() ? 'Saving…' : 'Save') | t }}</button>
      </div>
      <div class="wk-body">
        @if (preview()) {
          <div class="wk-read"><div #textEl class="wk-text md" [innerHTML]="draftHtml()"></div></div>
        } @else {
          <div class="wk-edit">
            <textarea #area class="wk-area" spellcheck="true" [value]="draft()" [placeholder]="'Write in Markdown…' | t"
                      (input)="typed($any($event.target))" (click)="typed($any($event.target))" (keydown)="areaKey($event)"></textarea>
            <div class="wk-hint">
              <kbd>[[</kbd> {{ 'a page' | t }} · <kbd>&#64;</kbd> {{ 'a model, board or part' | t }} · <kbd>Ctrl+S</kbd> {{ 'save' | t }} · <kbd>Esc</kbd> {{ 'cancel' | t }}
            </div>
            @if (pop(); as p) {
              <div class="tcv-cc-mpop wk-pop" animate.leave="tcv-leave" role="listbox" (mousedown)="$event.preventDefault()">
                <div class="tcv-cc-mhead">
                  <svg class="tcv-cc-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="p.kind === 'at' ? I.at : I.doc" /></svg>
                  <span>{{ p.q || ((p.kind === 'at' ? 'Mention a model, board or part' : 'Link a page') | t) }}</span>
                </div>
                <div class="tcv-cc-mlist">
                  @for (r of popRows(); track r.kind + r.id; let k = $index) {
                    <button role="option" [class.on]="k === popIdx()" [attr.aria-selected]="k === popIdx()"
                            (mouseenter)="popIdx.set(k)" (click)="pickPop(r)">
                      <span class="tcv-cc-modelname">{{ r.label }}</span>
                      <span class="tcv-cc-dim tcv-cc-msub">{{ r.sub }}</span>
                      <span class="tcv-cc-tag">{{ kindName(r.kind) | t }}</span>
                    </button>
                  } @empty {
                    <p class="tcv-cc-dim tcv-cc-pad">{{ (popBusy() ? 'Loading…' : 'Nothing matches.') | t }}</p>
                  }
                </div>
                <div class="tcv-cc-mfoot tcv-cc-dim"><kbd>↑↓</kbd> {{ 'choose' | t }} · <kbd>↵</kbd> {{ 'add' | t }} · <kbd>Esc</kbd> {{ 'close' | t }}</div>
              </div>
            }
          </div>
        }
      </div>
    } @else if (mode() === 'history' && page(); as pg) {
      <div class="wk-bar">
        <h2>{{ pg.title }}</h2>
        <span class="wk-meta">{{ 'History' | t }} · {{ hist().length }} {{ (hist().length === 1 ? 'version' : 'versions') | t }}</span>
        <span class="grow"></span>
        <button class="wk-tb" [attr.data-on]="!whole() ? 1 : null" (click)="whole.set(false)">{{ 'Differences' | t }}</button>
        <button class="wk-tb" [attr.data-on]="whole() ? 1 : null" (click)="whole.set(true)">{{ 'Whole text' | t }}</button>
        <span class="wk-sep"></span>
        @if (auth.can('edit') && cmp(); as c) {
          <button class="tcv-btn wk-btn" (click)="restore(c.to)" [disabled]="c.to === pg.version"
                  [title]="(c.to === pg.version ? 'This is the page as it is' : 'Put this version back, as a new one') | t">
            {{ 'Restore' | t }} v{{ c.to }}</button>
        }
        <button class="tcv-btn wk-btn" (click)="mode.set('read')">{{ 'Back to the page' | t }}</button>
      </div>
      <div class="wk-body">
        <div class="wk-hist">
          <div class="wk-vers" role="list">
            @for (v of hist(); track v.n) {
              <button class="wk-ver" role="listitem" [attr.data-on]="v.n === cmp()?.to ? 1 : null" (click)="showVersion(v.n)">
                <span class="wk-ver-head"><span class="wk-ver-n">v{{ v.n }}</span><span>{{ v.by.name || ('someone' | t) }}</span>
                  <span class="grow"></span><span class="wk-row-when">{{ when(v.at) }}</span></span>
                <span class="wk-ver-sum">@if (v.added) {<span class="wk-plus">+{{ v.added }}</span> }@if (v.removed) {<span class="wk-minus">−{{ v.removed }}</span> }{{ v.restored_from ? (('restored v{n}' | t).replace('{n}', '' + v.restored_from)) : v.summary }}</span>
              </button>
            } @empty { <wb-skel kind="rows" [count]="5" [h]="38" /> }
          </div>
          @if (cmp(); as c) {
            @if (whole()) {
              <div class="wk-text md wk-whole" [innerHTML]="render(c.version.text)"></div>
            } @else {
              <div class="wk-diff" [attr.aria-label]="'Differences' | t">
                @for (r of c.rows; track $index) {
                  <div class="wk-dl" [attr.data-op]="r.op"><i>{{ r.op === '-' ? r.a : r.b ?? '' }}</i><b>{{ r.op === '=' || r.op === '…' ? '' : r.op }}</b>{{ r.op === '…' ? '⋯' : r.text }}</div>
                } @empty { <div class="wk-none"><wb-empty compact text="No change in the text." /></div> }
              </div>
            }
          } @else { <div class="wk-diff"><wb-skel kind="text" [count]="8" /></div> }
        </div>
      </div>
    } @else if (page(); as pg) {
      <div class="wk-bar">
        <h2>{{ pg.title }}</h2>
        <span class="wk-meta">v{{ pg.version }} · <b>{{ pg.updated_by.name || ('someone' | t) }}</b> · {{ when(pg.updated_at) }}@if (pg.summary) { · {{ pg.summary }}}</span>
        <span class="grow"></span>
        @if (auth.can('edit')) {
          <button class="wk-tb" [attr.data-on]="pg.pinned ? 1 : null" (click)="pin(pg)"
                  [title]="(pg.pinned ? 'Unpin: no longer first for the agents' : 'Pin: first in the list and in what the agents read') | t">
            {{ (pg.pinned ? 'Pinned' : 'Pin') | t }}</button>
        }
        <button class="wk-tb" (click)="openHistory()">{{ 'History' | t }}</button>
        @if (auth.can('delete')) { <button class="wk-tb wk-danger" (click)="remove(pg)">{{ 'Delete' | t }}</button> }
        @if (auth.can('edit')) { <button class="tcv-btn wk-btn" (click)="edit()" [title]="'Edit where it stands (E)' | t">{{ 'Edit' | t }}</button> }
      </div>
      <div class="wk-body">
        <div class="wk-read">
          <div #textEl class="wk-text md" [attr.data-can]="auth.can('edit') ? 1 : null" [innerHTML]="html()" (click)="textClick($event)"></div>
          @if (pg.linked_from.length || pg.links.length || pg.mentions.length) {
            <aside class="wk-aside">
              @if (pg.linked_from.length) {
                <h4>{{ 'Linked from' | t }}</h4>
                <ul>@for (l of pg.linked_from; track l.slug) { <li><a [href]="href(l.slug)">{{ l.title }}</a></li> }</ul>
              }
              @if (pg.links.length) {
                <h4>{{ 'Links to' | t }}</h4>
                <ul>@for (l of pg.links; track l) { <li><a [href]="href(l)">{{ pg.link_titles[l] || l }}</a></li> }</ul>
              }
              @if (pg.mentions.length) {
                <h4>{{ 'Mentions' | t }}</h4>
                <ul>@for (m of pg.mentions; track m.kind + m.id) { <li><a [href]="mentionLink(m)" [title]="m.kind + ' ' + m.id">{{ kindName(m.kind) | t }} · {{ m.id }}</a></li> }</ul>
              }
            </aside>
          }
        </div>
      </div>
    } @else if (pageLoading() || !listLoaded()) {
      <div class="wk-bar"></div>
      <div class="wk-body"><div class="wk-text"><wb-skel kind="text" [count]="8" /></div></div>
    } @else {
      <div class="wk-bar"><h2>{{ project() || ('Wiki' | t) }}</h2></div>
      <div class="wk-body wk-none">
        @if (!projects().length) {
          <wb-empty icon="doc" heading="No projects yet" text="A wiki belongs to a project: make one with + New project in the 3D room." />
        } @else if (!pages().length) {
          <wb-empty icon="doc" heading="This project has no wiki yet"
                    text="Short pages of what was decided and why, the limits, the sourcing and the open questions. The agents read them before they work a note." />
          @if (auth.can('edit')) {
            <div class="wk-starts">
              @for (s of starters; track s.name) { <button class="tcv-btn" (click)="start(s)">{{ s.name | t }}</button> }
              <button class="tcv-btn" (click)="newPage()">{{ 'Another page…' | t }}</button>
            </div>
          }
        } @else {
          <wb-empty icon="doc" [text]="'Pick a page on the left.'" />
        }
      </div>
    }
  </section>
</div>`,
})
export class RoomWiki implements OnDestroy {
  private api = inject(WikiApi);
  auth = inject(Auth);
  readonly I = ICON;
  readonly starters = STARTERS;
  private textEl = viewChild<ElementRef<HTMLElement>>('textEl');
  private area = viewChild<ElementRef<HTMLTextAreaElement>>('area');
  private searchEl = viewChild<ElementRef<HTMLInputElement>>('search');

  projects = signal<WikiProject[]>([]);
  project = signal('');
  pages = signal<WikiRow[]>([]);
  listLoaded = signal(false);
  pageSlug = signal('');
  page = signal<WikiPage | null>(null);
  pageLoading = signal(false);
  mode = signal<'read' | 'edit' | 'history'>('read');

  // Editing: the text, the name, a few words for the history; a new page has no version yet.
  draft = signal('');
  draftTitle = signal('');
  draftSummary = signal('');
  private base: number | null = null;
  private isNew = false;
  private original = '';
  preview = signal(false);
  saving = signal(false);

  q = signal('');
  all = signal(false);
  hits = signal<Hit[]>([]);
  searching = signal(false);

  hist = signal<Ver[]>([]);
  cmp = signal<Compare | null>(null);
  whole = signal(false);

  pop = signal<{ kind: 'at' | 'page'; q: string; at: number } | null>(null);
  popRows = signal<PickRow[]>([]);
  popIdx = signal(0);
  popBusy = signal(false);
  private popSeq = 0;
  private searchTimer?: ReturnType<typeof setTimeout>;
  private popTimer?: ReturnType<typeof setTimeout>;

  projectOpts = computed<SelectOption[]>(() => this.projects().map(p => ({
    value: p.id, label: p.id, hint: p.pages ? p.pages : '' })));
  groups = computed(() => {
    const rows = this.pages();
    const pinned = rows.filter(r => r.pinned), rest = rows.filter(r => !r.pinned);
    return pinned.length ? [{ name: 'Pinned', rows: pinned }, { name: 'Pages', rows: rest }].filter(g => g.rows.length)
      : rest.length ? [{ name: '', rows: rest }] : [];
  });
  html = computed(() => { const p = this.page(); return p ? this.render(p.text) : ''; });
  draftHtml = computed(() => this.render(this.draft()));

  constructor() {
    void this.boot();
    // The page open, in the tab's title.
    effect(() => {
      const p = this.page(), pr = this.project();
      untracked(() => navTitle('wiki', p ? `${p.title} · ${pr}` : pr || null));
    });
    // Back and Forward inside the wiki: the address says which project and page.
    effect(() => {
      const pop = navPopped();
      if (!pop) return;
      untracked(() => {
        const v = pop.next;
        if (v.get('ws') !== 'wiki') return;
        this.follow(v.get('project') ?? '', v.get('page') ?? '');
      });
    });
    // A search, as it is typed: this project's pages, or every project's.
    effect(() => {
      const q = this.q().trim(), all = this.all(), p = this.project();
      clearTimeout(this.searchTimer);
      if (!q) { this.hits.set([]); return; }
      this.searching.set(true);
      this.searchTimer = setTimeout(() => untracked(() => this.api.search(q, all ? '' : p)
        .then(h => { if (this.q().trim() === q) this.hits.set(h); })
        .catch(() => this.hits.set([]))
        .finally(() => this.searching.set(false))), 180);
    });
    // Code in the page, coloured as in the Chat.
    effect(() => {
      this.html(); this.draftHtml(); this.mode(); this.preview();
      const el = this.textEl()?.nativeElement;
      if (el) setTimeout(() => highlightIn(el));
    });
  }

  ngOnDestroy() { clearTimeout(this.searchTimer); clearTimeout(this.popTimer); }

  // ---- where we are -------------------------------------------------------------------

  private async boot() {
    try { this.projects.set(await this.api.projects()); } catch { this.projects.set([]); }
    const v = navParams();
    let p = v.get('project') ?? '';
    if (!p) {
      let last = '';
      try { last = localStorage.getItem(LAST) ?? ''; } catch { /* private window */ }
      const list = this.projects();
      p = list.find(x => x.id === last)?.id ?? list.find(x => x.pages)?.id ?? list[0]?.id ?? '';
    }
    await this.follow(p, v.get('page') ?? '', true);
  }

  /** Show `project` / `page` (from the address, or a click): what is open follows; the address is
   *  written by `open`, not here. With `fill`, the first page is opened when none is named. */
  private async follow(project: string, page: string, fill = false) {
    if (this.mode() === 'edit' && !(await this.leaveEdit())) return;
    const newProject = project !== this.project();
    this.project.set(project);
    if (project) { try { localStorage.setItem(LAST, project); } catch { /* private window */ } }
    if (newProject || !this.listLoaded()) await this.loadPages();
    let s = page;
    if (!s && (fill || newProject)) s = this.pages()[0]?.slug ?? '';
    if (s !== page || fill) navSet('wiki', { project: project || null, page: s || null }, { replace: true });
    this.mode.set('read');
    await this.loadPage(s);
  }

  private async loadPages() {
    const p = this.project();
    this.listLoaded.set(false);
    try { this.pages.set(p ? (await this.api.pages(p)).pages : []); } catch { this.pages.set([]); }
    this.listLoaded.set(true);
  }

  private async loadPage(s: string) {
    this.pageSlug.set(s);
    if (!s || !this.project()) { this.page.set(null); return; }
    this.pageLoading.set(true);
    try {
      this.page.set(await this.api.page(this.project(), s));
    } catch (e) {
      this.page.set(null);
      if ((e as HttpErrorResponse).status !== 404) Toast.show(this.err(e), { tone: 'danger' });
    } finally {
      this.pageLoading.set(false);
    }
  }

  /** Open a page: a step in the browser's history of its own. */
  async open(project: string, s: string) {
    if (project === this.project() && s === this.pageSlug() && this.mode() !== 'edit') { this.mode.set('read'); return; }
    if (this.mode() === 'edit' && !(await this.leaveEdit())) return;
    navSet('wiki', { project, page: s || null });
    await this.follow(project, s);
  }

  async pickProject(p: string) {
    if (p === this.project()) return;
    if (this.mode() === 'edit' && !(await this.leaveEdit())) return;
    this.q.set('');
    navSet('wiki', { project: p, page: null });
    await this.follow(p, '');
  }

  // ---- reading --------------------------------------------------------------------------

  /** The Markdown as the Chat draws it (markdown.ts), with [[links]] and @mentions as links into the app. */
  render(text: string): string {
    const known = new Set(this.pages().map(p => p.slug));
    const m = marked(text ?? '', this.project(), s => known.has(s), x => x.kind === 'model' ? x.id.split('/').pop() ?? x.id : x.id);
    return m.unmark(toHtml(m.text));
  }

  href(s: string) { return pageHref(this.project(), s); }
  mentionLink(m: WikiMention) { return mentionHref(m); }
  kindName(k: string) {
    return ({ model: '3D model', board: 'Board', part: 'Part', firmware: 'Firmware', page: 'Page', new: 'New page' } as Record<string, string>)[k] ?? k;
  }
  when(iso: string | null | undefined) { return ago(iso); }

  /** A click on the text that is not a link, and not the end of a selection: edit it there. */
  textClick(e: MouseEvent) {
    if (!this.auth.can('edit') || (e.target as HTMLElement).closest('a')) return;
    if (window.getSelection()?.toString()) return;
    this.edit();
  }

  // ---- writing --------------------------------------------------------------------------

  edit() {
    const p = this.page();
    if (!p || !this.auth.can('edit')) return;
    this.isNew = false;
    this.base = p.version;
    this.original = p.text;
    this.draft.set(p.text);
    this.draftTitle.set(p.title);
    this.draftSummary.set('');
    this.preview.set(false);
    this.mode.set('edit');
    this.focusArea(true);
  }

  async newPage() {
    if (!this.project() || !this.auth.can('edit')) return;
    if (this.mode() === 'edit' && !(await this.leaveEdit())) return;
    const name = await Confirm.input({ title: t('A new page'), text: t('Its name, e.g. Decisions or Power budget.'),
                                       ok: t('Create'), placeholder: t('Page name') });
    if (!name) return;
    this.begin(name, '');
  }

  start(s: typeof STARTERS[number]) {
    const tr = LANG() === 'tr';
    this.begin(tr ? s.tr : s.name, (tr ? s.trText : s.en).replace('{date}', new Date().toISOString().slice(0, 10)));
  }

  /** A page not kept yet: the editor, with its name and maybe a start. A name that is a page opens it. */
  private begin(name: string, text: string) {
    const s = slug(name);
    if (!s) { Toast.show(t('Give the page a name with letters or digits in it.'), { tone: 'warn' }); return; }
    if (this.pages().some(p => p.slug === s)) { void this.open(this.project(), s); return; }
    this.isNew = true;
    this.base = null;
    this.original = '';
    this.page.set(null);
    this.pageSlug.set(s);
    this.draft.set(text);
    this.draftTitle.set(name.trim());
    this.draftSummary.set('');
    this.preview.set(false);
    this.mode.set('edit');
    this.focusArea(true);
  }

  focusArea(end = false) {
    setTimeout(() => {
      const el = this.area()?.nativeElement;
      if (!el) return;
      el.focus();
      if (end) el.setSelectionRange(el.value.length, el.value.length);
    });
  }

  private dirty() {
    return this.mode() === 'edit' && (this.draft() !== this.original || (!this.isNew && this.draftTitle() !== this.page()?.title));
  }

  /** Leaving the editor: what was typed is kept or let go, as the person says. */
  private async leaveEdit(): Promise<boolean> {
    if (this.dirty() && !(await Confirm.ask({ title: t('Leave without saving?'), text: t('What you changed on this page is not kept.'),
                                               ok: t('Leave'), danger: true }))) return false;
    this.closePop();
    this.mode.set('read');
    return true;
  }

  async cancel() {
    if (!(await this.leaveEdit())) return;
    if (this.isNew) { this.isNew = false; await this.loadPage(this.pages()[0]?.slug ?? ''); }
  }

  async save() {
    if (this.saving() || this.mode() !== 'edit') return;
    const title = this.draftTitle().trim(), text = this.draft();
    if (!title || !text.trim()) return;
    const s = this.isNew ? slug(title) : this.pageSlug();
    if (!s) { Toast.show(t('Give the page a name with letters or digits in it.'), { tone: 'warn' }); return; }
    this.saving.set(true);
    try {
      const got = await this.api.save(this.project(), s, { text, title, summary: this.draftSummary().trim(), base: this.base });
      const created = this.isNew;
      this.isNew = false;
      this.closePop();
      this.page.set(got);
      this.mode.set('read');
      await this.loadPages();
      if (created || s !== this.pageSlug()) navSet('wiki', { project: this.project(), page: s }, { replace: true });
      this.pageSlug.set(s);
      if (got.changed) Toast.show(t('Saved - version {n}').replace('{n}', String(got.version)), { tone: 'ok' });
    } catch (e) {
      if ((e as HttpErrorResponse).status === 409 && !this.isNew) {
        // Someone saved it meanwhile: say so, and offer to keep this text over theirs.
        const now = await this.api.page(this.project(), s).catch(() => null);
        if (now && await Confirm.ask({ title: t('This page changed while you edited it'),
                                       text: t('{who} saved version {n}. Save yours over it? Theirs stays in the history.')
                                         .replace('{who}', now.updated_by.name || t('someone')).replace('{n}', String(now.version)),
                                       ok: t('Save mine') })) {
          this.base = now.version;
          this.saving.set(false);
          await this.save();
          return;
        }
      } else {
        Toast.show(this.err(e), { tone: 'danger' });
      }
    } finally {
      this.saving.set(false);
    }
  }

  async pin(p: WikiPage) {
    try {
      this.page.set(await this.api.pin(p.project, p.slug, !p.pinned));
      await this.loadPages();
    } catch (e) { Toast.show(this.err(e), { tone: 'danger' }); }
  }

  async remove(p: WikiPage) {
    if (!(await Confirm.ask({ title: t('Delete "{x}"?').replace('{x}', p.title),
                              text: t('The page and its history go. The agents no longer read it.'),
                              ok: t('Delete'), danger: true }))) return;
    try {
      await this.api.remove(p.project, p.slug);
      await this.loadPages();
      const next = this.pages()[0]?.slug ?? '';
      navSet('wiki', { project: this.project(), page: next || null }, { replace: true });
      await this.loadPage(next);
      Toast.show(t('Deleted.'));
    } catch (e) { Toast.show(this.err(e), { tone: 'danger' }); }
  }

  // ---- history --------------------------------------------------------------------------

  async openHistory() {
    const p = this.page();
    if (!p) return;
    this.hist.set([]);
    this.cmp.set(null);
    this.whole.set(false);
    this.mode.set('history');
    try {
      const h = await this.api.history(p.project, p.slug);
      this.hist.set(h);
      if (h.length) await this.showVersion(h[0].n);
    } catch (e) { Toast.show(this.err(e), { tone: 'danger' }); }
  }

  async showVersion(n: number) {
    const p = this.page();
    if (!p) return;
    try { this.cmp.set(await this.api.version(p.project, p.slug, n)); } catch (e) { Toast.show(this.err(e), { tone: 'danger' }); }
  }

  async restore(n: number) {
    const p = this.page();
    if (!p || !(await Confirm.ask({ title: t('Put version {n} back?').replace('{n}', String(n)),
                                    text: t('It becomes a new version; nothing in the history is lost.'), ok: t('Restore') }))) return;
    try {
      this.page.set(await this.api.restore(p.project, p.slug, n));
      await this.loadPages();
      this.mode.set('read');
      Toast.show(t('Restored - version {n}').replace('{n}', String(this.page()?.version ?? '')), { tone: 'ok' });
    } catch (e) { Toast.show(this.err(e), { tone: 'danger' }); }
  }

  // ---- the picker for @mentions and [[pages]] -------------------------------------------

  /** After each keystroke: "@word" or "[[words" just before the caret opens the picker. */
  typed(el: HTMLTextAreaElement) {
    this.draft.set(el.value);
    const upto = el.value.slice(0, el.selectionStart ?? el.value.length);
    const at = /(^|\s)@([^\s@:]{0,40})$/.exec(upto);
    const pg = /\[\[([^\[\]\n|]{0,40})$/.exec(upto);
    if (pg) this.openPop('page', pg[1], upto.length - pg[1].length - 2);
    else if (at) this.openPop('at', at[2], upto.length - at[2].length - 1);
    else this.closePop();
  }

  private openPop(kind: 'at' | 'page', q: string, at: number) {
    const cur = this.pop();
    if (cur && cur.kind === kind && cur.q === q && cur.at === at) return;
    this.pop.set({ kind, q, at });
    this.popIdx.set(0);
    if (kind === 'page') {
      const w = q.trim().toLowerCase();
      const rows: PickRow[] = this.pages().filter(p => !w || p.title.toLowerCase().includes(w) || p.slug.includes(slug(w)))
        .slice(0, 20).map(p => ({ kind: 'page', id: p.slug, label: p.title, sub: p.slug }));
      if (w && slug(w) && !this.pages().some(p => p.slug === slug(w))) rows.push({ kind: 'new', id: slug(w), label: q.trim(), sub: '' });
      this.popRows.set(rows);
      return;
    }
    clearTimeout(this.popTimer);
    const seq = ++this.popSeq;
    this.popBusy.set(true);
    this.popTimer = setTimeout(() => this.api.mentions(q).then(rows => {
      if (seq !== this.popSeq) return;
      this.popRows.set(rows.filter(r => r.kind === 'model' || r.kind === 'board' || r.kind === 'part').slice(0, 20));
    }).catch(() => { if (seq === this.popSeq) this.popRows.set([]); })
      .finally(() => { if (seq === this.popSeq) this.popBusy.set(false); }), q ? 120 : 0);
  }

  closePop() { this.pop.set(null); this.popSeq++; }

  /** The word typed goes; the pick is written in its place. */
  pickPop(r: PickRow) {
    const p = this.pop(), el = this.area()?.nativeElement;
    if (!p || !el) return;
    const v = this.draft(), end = el.selectionStart ?? v.length;
    const put = p.kind === 'at' ? `@${r.kind}:${r.id} ` : `[[${r.label}]]`;
    const next = v.slice(0, p.at) + put + v.slice(end).replace(/^\]\]/, '');
    this.draft.set(next);
    el.value = next;
    const caret = p.at + put.length;
    this.closePop();
    setTimeout(() => { el.focus(); el.setSelectionRange(caret, caret); });
  }

  areaKey(e: KeyboardEvent) {
    if (this.pop() && !e.isComposing) {
      const n = this.popRows().length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (n) this.popIdx.update(i => (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && n) { e.preventDefault(); this.pickPop(this.popRows()[this.popIdx()]); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closePop(); return; }
    }
  }

  // ---- keys -------------------------------------------------------------------------------

  key(e: KeyboardEvent) {
    const editing = this.mode() === 'edit';
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's' && editing) {
      e.preventDefault();
      void this.save();
      return;
    }
    if (e.key === 'Escape' && editing && !this.pop() && !document.querySelector('.cf-scrim')) {
      e.preventDefault();
      void this.cancel();
      return;
    }
    const tgt = e.target as HTMLElement | null;
    const typing = !!tgt && (tgt.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName));
    if (typing || e.ctrlKey || e.metaKey || e.altKey || editing) return;
    if (e.key === 'e' && this.page() && this.mode() === 'read') { e.preventDefault(); this.edit(); }
    else if (e.key === 'n' && this.auth.can('edit')) { e.preventDefault(); void this.newPage(); }
    else if (e.key === '/') { e.preventDefault(); this.searchEl()?.nativeElement.focus(); }
  }

  private err(e: unknown): string {
    const x = e as HttpErrorResponse;
    const d = x?.error?.detail;
    return typeof d === 'string' ? d : x?.message || t('Something went wrong.');
  }
}
