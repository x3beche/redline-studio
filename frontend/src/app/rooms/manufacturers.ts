import { Component, ElementRef, Injectable, OnDestroy, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Selection } from '../selection';
import { Auth } from '../auth';
import { Prefs } from '../preferences';
import { LANG, T, t } from '../i18n';

/** Manufacturers ("Üreticiler"): makers whose catalogs the workspace keeps,
 *  read from their own websites (backend/manufacturers.py).
 *
 *  A manufacturer is added by its site's address. Exploring it is a run in
 *  the server - the site crawled politely (robots.txt, the same domain, a
 *  page cap, a pause between requests), then its pages read by a model in
 *  chunks - followed here step by step, as a Taste extraction is. The
 *  catalog it leaves is searched here, by Chat's manufacturer_search tool,
 *  and goes along when the manufacturer is @-mentioned.
 *
 *  Everything this page shows is in its address: the manufacturer (?m=),
 *  the run (?run=), the product search (?q=, ?cat=) - so a reload comes back
 *  to the same place, and a run that was going is still going (it is the
 *  server's, not the page's).
 */
export type ProxyChoice = 'off' | 'fallback' | 'always';
export type MfrStatus = 'queued' | 'crawling' | 'asking' | 'merging' | 'done' | 'failed' | 'cancelled';
export type StepState = 'running' | 'done' | 'skipped' | 'failed' | 'cancelled' | 'pending';
export interface Product {
  id: string; name: string; category: string; description: string; specs: Record<string, string>;
  sku: string; url: string; image: string;
}
export interface LastRun { id: string; status: MfrStatus; started_at: string; finished_at: string | null; error?: string | null; pages: number; products: number | null }
export interface Maker {
  id: string; name: string; name_auto?: boolean; url: string; domain: string; notes: string; summary: string;
  categories: string[]; docs: { url: string; label: string }[]; proxy: ProxyChoice; product_count: number;
  products?: Product[]; by: { id?: string; name?: string }; created_at: string; updated_at: string;
  explored_at: string | null; last_run: LastRun | null;
}
export interface MfrStep {
  id: string; kind: 'robots' | 'sitemap' | 'crawl' | 'ask' | 'merge' | 'done'; state: StepState;
  started_at?: string; finished_at?: string; seconds?: number; reason?: string; note?: string;
  url?: string; found?: boolean | number; rules?: number; sitemaps?: number; delay?: number; via?: string;
  files?: number; urls?: number; pages?: number; read?: number; cap?: number; queued?: number; skipped_robots?: number; current?: string | null;
  n?: number; of?: number; provider_name?: string; model?: string; prompt_chars?: number; tokens_est?: number; timeout?: number;
  tokens_in?: number | null; tokens_out?: number | null; cost?: number | null; products?: number; rows?: number; invalid?: number;
  duplicates?: number; categories?: number;
}
export interface MfrPage {
  url: string; depth: number; status: number | null; via: 'direct' | 'proxy'; ms?: number; bytes: number; at: string;
  title?: string; chars?: number; links?: number; product?: boolean; error?: string; fallback?: boolean;
}
export interface MfrTotals {
  pages?: number; read?: number; docs?: number; chunks?: number; chars?: number; tokens_in?: number; tokens_out?: number;
  cost?: number | null; products?: number; duplicates?: number; delay?: number;
  requests_direct?: number; bytes_direct?: number; requests_proxy?: number; bytes_proxy?: number; refused?: number;
  proxy_since?: string; wire_up?: number; wire_down?: number; proxy_cost?: number;
}
/** One exploration (backend/manufacturers.py, `manufacturer_jobs`). */
export interface MfrJob {
  id: string; status: MfrStatus; manufacturer: { id: string; name: string; url: string; domain: string };
  by: { id?: string; name?: string }; started_at: string; finished_at: string | null; seconds: number | null; now: string;
  provider?: string; provider_name?: string; model?: string; proxy: ProxyChoice;
  limits?: { pages: number; depth: number; delay: number };
  steps: MfrStep[]; totals: MfrTotals; pages?: MfrPage[]; page_count: number; error?: string | null; products_found?: number | null;
  cancelled_by?: { name?: string };
}
export interface ProxyState {
  configured: boolean; enabled: boolean; mode: ProxyChoice; setting: string; default: ProxyChoice;
  price_per_gb: number; country: string; metered: boolean;
}
export const ACTIVE: MfrStatus[] = ['queued', 'crawling', 'asking', 'merging'];
export const isActive = (j: { status: MfrStatus } | null | undefined) => !!j && ACTIVE.includes(j.status);
export const PROXY_CHOICES: { id: ProxyChoice; label: string; about: string }[] = [
  { id: 'off', label: 'Off', about: 'every request goes out directly' },
  { id: 'fallback', label: 'When refused', about: 'directly first; through the proxy once the site refuses or rate-limits' },
  { id: 'always', label: 'Always', about: 'every request through the proxy' },
];

@Injectable({ providedIn: 'root' })
export class MfrApi {
  private http = inject(HttpClient);
  changed = signal(0);
  list(q = '') { return this.http.get<Maker[]>(`/api/manufacturers?q=${encodeURIComponent(q)}`); }
  get(id: string) { return this.http.get<Maker>(`/api/manufacturers/${id}`); }
  create(b: { url: string; name?: string; notes?: string; proxy: ProxyChoice; explore?: boolean }) {
    return this.http.post<{ manufacturer: Maker; job: (MfrJob & { job_id: string }) | null }>('/api/manufacturers', b);
  }
  patch(id: string, p: Partial<Pick<Maker, 'name' | 'notes' | 'summary' | 'url' | 'proxy'>>) {
    return this.http.patch<Maker>(`/api/manufacturers/${id}`, p);
  }
  remove(id: string) { return this.http.delete(`/api/manufacturers/${id}`); }
  explore(id: string, proxy: ProxyChoice) { return this.http.post<MfrJob>(`/api/manufacturers/${id}/explore`, { proxy }); }
  proxy() { return this.http.get<ProxyState>('/api/manufacturers/proxy'); }
  jobs(limit = 30) { return this.http.get<MfrJob[]>(`/api/manufacturers/jobs?limit=${limit}`); }
  job(id: string) { return this.http.get<MfrJob>(`/api/manufacturers/jobs/${id}`); }
  cancelJob(id: string) { return this.http.post<MfrJob>(`/api/manufacturers/jobs/${id}/cancel`, {}); }
  exportFile(id: string) { return this.http.get<unknown>(`/api/manufacturers/${id}/export`); }
  importFile(data: unknown) { return this.http.post<Maker>('/api/manufacturers/import', data); }
}

/** The workspace's explorations, for the whole page: the tab's "● N" while
 *  any runs (after a reload too: it is asked of the server), and the runs
 *  that finished while the tab was not open. */
@Injectable({ providedIn: 'root' })
export class MfrRuns {
  private api = inject(MfrApi);
  jobs = signal<MfrJob[]>([]);
  running = computed(() => this.jobs().filter(isActive).length);
  unseen = signal(0);
  here = false;
  private watching = false;
  private timer?: ReturnType<typeof setTimeout>;

  watch() { if (!this.watching) { this.watching = true; this.refresh(); } }

  refresh(): Promise<MfrJob[]> {
    return new Promise(done => this.api.jobs().subscribe({
      next: rows => { this.take(rows); done(rows); },
      error: () => { this.again(); done(this.jobs()); },
    }));
  }

  put(j: MfrJob) {
    const { pages: _, ...light } = j;
    const have = this.jobs();
    this.take(have.some(x => x.id === j.id) ? have.map(x => x.id === j.id ? light : x) : [light, ...have]);
  }

  seen() { this.unseen.set(0); }

  private take(rows: MfrJob[]) {
    const before = new Map(this.jobs().map(j => [j.id, j.status]));
    const ended = rows.filter(j => !isActive(j) && before.has(j.id) && ACTIVE.includes(before.get(j.id)!)).length;
    if (ended && !this.here) this.unseen.update(n => n + ended);
    this.jobs.set(rows);
    this.again();
  }

  private again() {
    clearTimeout(this.timer);
    if (this.jobs().some(isActive)) this.timer = setTimeout(() => this.refresh(), 5000);
  }
}

function when(iso: string | null | undefined): string {
  if (!iso) return '–';
  const d = new Date(iso), now = new Date(), loc = LANG() === 'tr' ? 'tr-TR' : [];
  const days = Math.floor((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86400000);
  if (days === 0) return d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
  if (days < 7) return d.toLocaleDateString(loc, { weekday: 'short' });
  return d.toLocaleDateString(loc, { day: 'numeric', month: 'short' });
}

function why(e: HttpErrorResponse, fallback: string): string {
  return typeof e.error?.detail === 'string' ? e.error.detail : t(fallback);
}

/** The words of a search, folded as the server folds them (accents and
 *  Turkish letters away). */
function fold(s: string): string {
  return (s || '').replace(/[ıİ]/g, 'i').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

@Component({
  selector: 'app-room-mfr',
  imports: [T],
  styleUrls: ['../settings.css', './taste.css', './manufacturers.css'],
  host: { '(document:keydown)': 'key($event)' },
  template: `
<div class="tcv-room absolute inset-0 flex min-h-0 gap-1 p-1">
  <!-- LEFT: the manufacturers -->
  <aside class="tcv-notes-side">
    <div class="tcv-notes-find">
      <input #search class="tcv-notes-search" [placeholder]="'Search manufacturers   /' | t" [value]="listQ()"
             (input)="listQ.set($any($event.target).value)" (keydown.escape)="listQ.set(''); $any($event.target).blur()">
    </div>
    @if (can()) {
      <div class="mf-side-acts">
        <button class="tcv-btn" (click)="goAdd()">{{ 'Add a manufacturer' | t }}</button>
        <button class="tcv-btn" (click)="importIn.click()" [title]="'Make a manufacturer from a file someone sent you' | t">{{ 'Import…' | t }}</button>
        <input #importIn type="file" accept=".json,application/json" hidden (change)="importMaker($any($event.target))">
      </div>
    }
    <div class="tcv-notes-list">
      @if (!listQ()) {
        <button class="tcv-notes-item tsh-ov" [attr.data-on]="view() === 'home' ? 1 : null" (click)="goHome()">
          <span class="tcv-notes-item-top">
            <span class="tcv-notes-item-title">{{ 'Overview' | t }}</span>
            <span class="tcv-notes-item-when">{{ fmt('{n} makers · {m} products', { n: all().length, m: totalProducts() }) }}</span>
          </span>
        </button>
      }
      @for (m of shown(); track m.id) {
        <button class="tcv-notes-item" [attr.data-on]="m.id === mid() && view() !== 'home' ? 1 : null" (click)="openMaker(m.id)">
          <span class="tcv-notes-item-top">
            <span class="tcv-notes-item-title">{{ m.name }}</span>
            <span class="tcv-notes-item-when">{{ m.product_count }} {{ (m.product_count === 1 ? 'product' : 'products') | t }}</span>
          </span>
          <span class="tcv-notes-item-meta mf-side-meta">
            <span class="mf-dom">{{ m.domain }}</span>
            @if (runOf(m); as r) {
              <span class="st-tag" [attr.data-tone]="statusTone(r.status)">@if (isActiveS(r.status)) { <i class="mf-pulse"></i> }{{ statusName(r.status) | t }}</span>
            } @else { <span class="st-tag">{{ 'not explored' | t }}</span> }
          </span>
        </button>
      } @empty {
        <p class="tcv-notes-empty">{{ (listQ() ? 'Nothing matches.' : 'No manufacturers yet.') | t }}</p>
      }
    </div>
  </aside>

  <section class="tcv-notes-main tst mf">
    @if (flash(); as f) { <p class="tcv-note-flash">{{ f }}</p> }

    @if (view() === 'run') {
      <!-- ================= the run dashboard ================= -->
      @if (job(); as j) {
        <header class="tst-head">
          <div class="tst-title">
            <h2>{{ fmt('Exploring {m}', { m: j.manufacturer.name }) }}</h2>
            <span class="st-sub"><a class="mf-link" [href]="j.manufacturer.url" target="_blank" rel="noopener noreferrer">{{ j.manufacturer.url }}</a>
              · {{ fmt('at most {p} pages, {d} links deep, {s} s between requests; robots.txt obeyed', { p: j.limits?.pages ?? 0, d: j.limits?.depth ?? 0, s: j.totals.delay ?? j.limits?.delay ?? 0 }) }}</span>
          </div>
          <div class="tst-acts">
            @if (running()) {
              <button class="tcv-btn tst-del" (click)="cancelRun()" [disabled]="cancelling() || !can()">{{ (cancelling() ? 'Cancelling…' : 'Cancel the run') | t }}</button>
            } @else if (can()) {
              <button class="tcv-btn tcv-btn-accent" (click)="exploreAgain(j.manufacturer.id, j.proxy)" [disabled]="starting()">{{ 'Run again' | t }}</button>
            }
            <button class="tcv-btn" (click)="openMaker(j.manufacturer.id)">{{ 'Open the catalog' | t }}</button>
          </div>
        </header>
        @if (j.status === 'failed') {
          <div class="st-banner tst-banner tsx-banner" role="alert"><span class="tsx-banner-text"><b>{{ 'The exploration failed' | t }}:</b> {{ j.error }}</span></div>
        }
        <div class="st-tiles mf-rtiles">
          <div class="st-tile" [attr.data-tone]="statusTone(j.status)"><span>{{ 'Status' | t }}</span><b>{{ statusName(j.status) | t }}</b>
            <small>{{ fmt('since {w}', { w: when(j.started_at) }) }}{{ j.by.name ? ' · ' + j.by.name : '' }}</small></div>
          <div class="st-tile"><span>{{ 'Elapsed' | t }}</span><b>{{ dur(elapsed()) }}</b><small>{{ nowLine() }}</small></div>
          <div class="st-tile"><span>{{ 'Pages read' | t }}</span><b>{{ crawlStep()?.read ?? 0 }} / {{ crawlStep()?.cap ?? j.limits?.pages ?? '–' }}</b>
            <small>{{ fmt('{n} asked · {q} waiting', { n: crawlStep()?.pages ?? 0, q: crawlStep()?.queued ?? 0 }) }}</small></div>
          <div class="st-tile" [attr.data-tone]="j.status === 'done' ? 'ok' : 'dim'"><span>{{ 'Products' | t }}</span>
            <b>{{ j.totals.products ?? (j.products_found ?? '–') }}</b><small>{{ j.totals.duplicates ? fmt('{n} duplicates merged', { n: j.totals.duplicates }) : (j.totals.chunks ? fmt('{n} chunks for the model', { n: j.totals.chunks }) : t('after the pages are read')) }}</small></div>
          <div class="st-tile tsx-model"><span>{{ 'Model' | t }}</span><b [title]="j.model || ''">{{ j.model || '–' }}</b><small>{{ j.provider_name || j.provider || '' }}</small></div>
          <div class="st-tile" [attr.data-tone]="j.totals.tokens_in == null ? 'dim' : null"><span>{{ 'Tokens in / out' | t }}</span>
            <b>{{ j.totals.tokens_in == null ? '–' : num(j.totals.tokens_in) + ' / ' + num(j.totals.tokens_out ?? 0) }}</b>
            <small>{{ money(j.totals.cost) }} {{ (j.totals.cost != null ? 'this run' : '') | t }}</small></div>
          <div class="st-tile" [attr.data-tone]="j.proxy === 'off' ? 'dim' : null"><span>{{ 'Fetching' | t }}</span>
            <b>{{ proxyLabel(j.proxy) | t }}</b>
            <small [title]="trafficTip()">{{ trafficLine() }}</small></div>
        </div>
        <div class="mf-rgrid">
          <section class="st-card tsx-steps">
            <div class="st-card-head"><h3>{{ 'Steps' | t }}</h3>
              <span class="st-sub">{{ fmt('{n} of {m} done', { n: doneSteps(), m: timeline().length }) }}</span>
              @if (running()) { <span class="st-right st-sub">{{ fmt('every {s} s while it runs', { s: '1.5' }) }}</span> }</div>
            <ol class="tsx-line">
              @for (r of timeline(); track r.id) {
                <li class="tsx-step" [attr.data-state]="r.state">
                  <i class="tsx-mark" aria-hidden="true"></i>
                  <span class="tsx-kind">{{ r.kind | t }}</span>
                  <span class="tsx-main"><b>{{ r.title }}</b>@if (r.detail) { <small [title]="r.detail">{{ r.detail }}</small> }@if (r.reason) { <em>{{ r.reason }}</em> }</span>
                  <span class="tsx-fig">{{ r.fig }}</span>
                  <span class="tsx-state">{{ stateName(r.state) | t }}</span>
                  <span class="tsx-time">{{ r.time }}</span>
                </li>
              }
            </ol>
            @if (crawlStep(); as c) {
              <div class="mf-progress"><div class="st-meter" [attr.data-tone]="running() || j.status === 'done' ? null : 'warn'"><i [style.width.%]="pct(c.pages ?? 0, c.cap ?? 1)"></i></div>
                <span class="st-sub">{{ fmt('{n} of at most {m} pages', { n: c.pages ?? 0, m: c.cap ?? 0 }) }}@if (c.current && running()) { · {{ path(c.current) }} }</span></div>
            }
          </section>
          <section class="st-card mf-pages">
            <div class="st-card-head"><h3>{{ 'Pages' | t }}</h3>
              <span class="st-sub">{{ fmt('{n} read · {p} product pages · {e} not read', { n: pageStats().ok, p: pageStats().product, e: pageStats().bad }) }}</span></div>
            <div class="st-table-wrap mf-pages-wrap">
              <table class="st-table mf-ptable">
                <thead><tr><th></th><th>{{ 'Page' | t }}</th><th>{{ 'Title' | t }}</th><th class="r">{{ 'Size' | t }}</th><th>{{ 'Via' | t }}</th><th class="r">{{ 'Time' | t }}</th></tr></thead>
                <tbody>
                  @for (p of pagesNewest(); track p.at + p.url) {
                    <tr [attr.data-bad]="p.error ? 1 : null">
                      <td class="mf-pmark"><i [attr.data-k]="p.error ? 'bad' : p.product ? 'prod' : 'page'"></i></td>
                      <td class="give"><a class="mf-link" [href]="p.url" target="_blank" rel="noopener noreferrer" [title]="p.url">{{ path(p.url) }}</a></td>
                      <td class="give-s" [title]="p.error || p.title || ''">@if (p.error) { <span class="mf-err">{{ p.error }}</span> } @else { {{ p.title }} }</td>
                      <td class="r mono">{{ p.bytes ? kb(p.bytes) : '–' }}</td>
                      <td><span class="st-tag" [attr.data-tone]="p.via === 'proxy' ? 'accent' : null">{{ (p.via === 'proxy' ? 'proxy' : 'direct') | t }}</span></td>
                      <td class="r mono">{{ p.ms != null ? p.ms + ' ms' : '' }}</td>
                    </tr>
                  } @empty { <tr><td colspan="6" class="dim">{{ 'No page read yet.' | t }}</td></tr> }
                </tbody>
              </table>
            </div>
          </section>
        </div>
      } @else if (runError(); as e) {
        <div class="st-banner tst-banner tsx-banner" role="alert"><span class="tsx-banner-text">{{ e }}</span>
          <button class="tcv-btn" (click)="goHome()">{{ 'Overview' | t }}</button></div>
      } @else { <p class="st-hint">{{ 'Loading…' | t }}</p> }

    } @else if (view() === 'maker' && maker(); as m) {
      <!-- ================= one manufacturer ================= -->
      <header class="tst-head">
        <div class="tst-title">
          <input class="tst-name" [value]="m.name" [readonly]="!can()" (change)="rename(m, $any($event.target).value)"
                 (keydown.enter)="$any($event.target).blur()" [attr.aria-label]="'Name' | t">
          <span class="st-sub"><a class="mf-link" [href]="m.url" target="_blank" rel="noopener noreferrer">{{ m.url }}</a>
            · {{ fmt('added by {p} {w}', { p: m.by.name || t('someone'), w: when(m.created_at) }) }}</span>
        </div>
        <div class="tst-acts">
          @if (can()) {
            <span class="st-sub">{{ 'Fetching' | t }}</span>
            <div class="st-seg" role="radiogroup" [attr.aria-label]="'Fetching' | t">
              @for (c of choices; track c.id) {
                <button [class.on]="choice() === c.id" (click)="choice.set(c.id)" [disabled]="c.id !== 'off' && !proxy()?.configured"
                        [title]="c.about | t">{{ c.label | t }}</button>
              }
            </div>
            @if (runOf(m); as r) { @if (isActiveS(r.status)) {
              <button class="tcv-btn tcv-btn-accent" (click)="showRun(r.id)">{{ 'Watch the run' | t }}</button>
            } @else {
              <button class="tcv-btn tcv-btn-accent" (click)="exploreAgain(m.id, choice())" [disabled]="starting()">{{ 'Explore again' | t }}</button>
            } } @else {
              <button class="tcv-btn tcv-btn-accent" (click)="exploreAgain(m.id, choice())" [disabled]="starting()">{{ 'Explore' | t }}</button>
            }
            <button class="tcv-btn" (click)="exportMaker(m)" [title]="'Save it as a file to send to someone' | t">{{ 'Export' | t }}</button>
            <button class="tcv-btn tst-del" (click)="remove(m)">{{ 'Delete' | t }}</button>
          }
        </div>
      </header>
      @if (can() && !proxy()?.configured) { <p class="st-hint mf-proxyhint">{{ 'The proxy is not set up, so a run goes out directly.' | t }}
        <button class="st-more" (click)="toProxy()">{{ 'Settings > Proxy' | t }}</button></p> }

      <div class="st-tiles mf-mtiles">
        <div class="st-tile" [attr.data-tone]="m.product_count ? null : 'dim'"><span>{{ 'Products' | t }}</span><b>{{ m.product_count }}</b>
          <small>{{ fmt('{n} with specs · {c} with a code', { n: makerStats().specs, c: makerStats().sku }) }}</small></div>
        <div class="st-tile" [attr.data-tone]="m.categories.length ? null : 'dim'"><span>{{ 'Categories' | t }}</span><b>{{ m.categories.length }}</b>
          <small [title]="m.categories.join(', ')">{{ m.categories.slice(0, 3).join(', ') || '–' }}</small></div>
        <div class="st-tile" [attr.data-tone]="m.explored_at ? null : 'dim'"><span>{{ 'Explored' | t }}</span><b>{{ when(m.explored_at) }}</b>
          <small>{{ m.domain }}</small></div>
        @if (runOf(m); as r) {
          <button class="st-tile mf-tilebtn" [attr.data-tone]="statusTone(r.status)" (click)="showRun(r.id)"><span>{{ 'Last run' | t }}</span>
            <b>{{ statusName(r.status) | t }}</b><small [title]="r.error || ''">{{ r.error || fmt('{n} pages · {w}', { n: r.pages, w: when(r.started_at) }) }}</small></button>
        } @else {
          <div class="st-tile" data-tone="dim"><span>{{ 'Last run' | t }}</span><b>–</b><small>{{ 'never explored' | t }}</small></div>
        }
        <div class="st-tile" [attr.data-tone]="m.docs.length ? null : 'dim'"><span>{{ 'Documents' | t }}</span><b>{{ m.docs.length }}</b>
          <small>{{ 'catalogs and drawings linked' | t }}</small></div>
      </div>

      <div class="mf-about">
        <div class="mf-about-col">
          <span class="mf-label">{{ 'What they make' | t }}</span>
          <p class="mf-summary">{{ m.summary || (m.explored_at ? t('The site did not say.') : t('Explore the site to read what they make.')) }}</p>
          @if (m.categories.length) {
            <div class="mf-cats">
              @for (c of m.categories; track c) {
                <button class="mf-cat" [attr.data-on]="cat() === c ? 1 : null" (click)="cat.set(cat() === c ? '' : c)">{{ c }} <b>{{ catCount(c) }}</b></button>
              }
            </div>
          }
        </div>
        <div class="mf-about-col">
          <span class="mf-label">{{ 'Your notes' | t }} <small>{{ 'Chat reads them: when to use this maker, for what' | t }}</small></span>
          <textarea class="tst-desc mf-notes" rows="2" [value]="m.notes" [readonly]="!can()"
                    [placeholder]="can() ? ('e.g. use them for injection mold parts; ask for the 2024 price list' | t) : ''"
                    (change)="saveNotes(m, $any($event.target).value)"></textarea>
          @if (m.docs.length) {
            <span class="mf-label">{{ 'Documents on the site' | t }}</span>
            <div class="mf-docs">@for (d of m.docs.slice(0, 12); track d.url) { <a class="mf-link" [href]="d.url" target="_blank" rel="noopener noreferrer" [title]="d.url">{{ d.label || path(d.url) }}</a> }</div>
          }
        </div>
      </div>

      <section class="st-card mf-catalog">
        <div class="st-card-head mf-cathead"><h3>{{ 'Catalog' | t }}</h3>
          <input class="tst-in mf-find" [placeholder]="'Find a product: name, code, size, material' | t" [value]="pq()"
                 (input)="pq.set($any($event.target).value)" (keydown.escape)="pq.set('')">
          <select class="tst-sel" [value]="cat()" (change)="cat.set($any($event.target).value)" [attr.aria-label]="'Category' | t">
            <option value="">{{ 'All categories' | t }}</option>
            @for (c of productCats(); track c) { <option [value]="c" [selected]="c === cat()">{{ c }}</option> }
          </select>
          <span class="st-right st-sub">{{ fmt('{n} of {m}', { n: found().length, m: m.products?.length ?? 0 }) }}</span></div>
        @if (m.products?.length) {
          <div class="st-table-wrap">
            <table class="st-table mf-table">
              <thead><tr><th>{{ 'Product' | t }}</th><th>{{ 'Code' | t }}</th><th>{{ 'Category' | t }}</th><th>{{ 'Specs' | t }}</th><th>{{ 'Description' | t }}</th><th></th></tr></thead>
              <tbody>
                @for (p of found().slice(0, shownRows()); track p.id) {
                  <tr>
                    <td class="mf-pname" [title]="p.name">{{ p.name }}</td>
                    <td class="mono">{{ p.sku || '–' }}</td>
                    <td class="dim" [title]="p.category">{{ p.category || '–' }}</td>
                    <td class="mf-specs" [title]="specLine(p)">@for (s of specs(p); track s[0]) { <span class="mf-spec"><em>{{ s[0] }}</em> {{ s[1] }}</span> }@if (!specs(p).length) { <span class="dim">–</span> }</td>
                    <td class="mf-desc dim" [title]="p.description">{{ p.description || '–' }}</td>
                    <td class="r">@if (p.url) { <a class="st-more mf-open" [href]="p.url" target="_blank" rel="noopener noreferrer">{{ 'Page' | t }}</a> }
                      @if (p.image) { <a class="st-more mf-open" [href]="p.image" target="_blank" rel="noopener noreferrer">{{ 'Image' | t }}</a> }</td>
                  </tr>
                } @empty { <tr><td colspan="6" class="dim">{{ 'Nothing matches.' | t }}</td></tr> }
              </tbody>
            </table>
          </div>
          @if (found().length > shownRows()) {
            <button class="st-more mf-morerows" (click)="rows.set(rows() + 200)">{{ fmt('Show {n} more', { n: found().length - shownRows() }) }}</button>
          }
        } @else {
          <p class="st-hint mf-pad">{{ (runOf(m) && isActiveS(runOf(m)!.status) ? 'The site is being explored; the catalog fills in when the run is done.' : 'No products yet: explore the site to read its catalog.') | t }}</p>
        }
      </section>

    } @else {
      <!-- ================= the overview, and adding one ================= -->
      <header class="tst-head tsh-head">
        <div class="tst-title">
          <h2>{{ 'Manufacturers' | t }}</h2>
          <span class="st-sub">{{ 'Makers whose catalogs you keep, read from their own sites. Chat looks here when you need a part from a maker.' | t }}</span>
        </div>
      </header>
      <div class="st-tiles mf-htiles">
        <div class="st-tile" [attr.data-tone]="all().length ? null : 'dim'"><span>{{ 'Manufacturers' | t }}</span><b>{{ all().length }}</b>
          <small>{{ fmt('{n} explored', { n: exploredCount() }) }}</small></div>
        <div class="st-tile" [attr.data-tone]="totalProducts() ? null : 'dim'"><span>{{ 'Products' | t }}</span><b>{{ num(totalProducts()) }}</b>
          <small>{{ fmt('in {n} categories', { n: totalCats() }) }}</small></div>
        <div class="st-tile" [attr.data-tone]="runs.running() ? 'accent' : 'dim'"><span>{{ 'Running' | t }}</span><b>{{ runs.running() }}</b>
          <small>{{ fmt('{n} runs kept', { n: runs.jobs().length }) }}</small></div>
        <div class="st-tile" [attr.data-tone]="lastJob() ? statusTone(lastJob()!.status) : 'dim'"><span>{{ 'Last exploration' | t }}</span>
          <b>{{ lastJob() ? when(lastJob()!.started_at) : '–' }}</b>
          <small>{{ lastJob() ? (statusName(lastJob()!.status) | t) + ' · ' + lastJob()!.manufacturer.name : ('none yet' | t) }}</small></div>
        <button class="st-tile mf-tilebtn" [attr.data-tone]="proxy()?.configured ? (proxy()?.enabled ? 'ok' : null) : 'dim'" (click)="toProxy()"><span>{{ 'Proxy' | t }}</span>
          <b>{{ proxyStateLine() | t }}</b><small>{{ (proxy()?.configured ? 'Settings > Proxy' : 'not set up - Settings > Proxy') | t }}</small></button>
      </div>

      @if (can()) {
        <section class="st-card mf-add" id="mf-add">
          <div class="st-card-head"><h3>{{ 'Add a manufacturer' | t }}</h3>
            <span class="st-sub">{{ 'its site is explored at once: the pages, then the products in them' | t }}</span></div>
          <div class="st-card-body">
            <div class="mf-addrow">
              <input #addUrlBox class="tst-in" [placeholder]="'https://www.example.com' | t" [value]="addUrl()" (input)="addUrl.set($any($event.target).value)"
                     (keydown.enter)="add()" [attr.aria-label]="'Site address' | t">
              <input class="tst-in" [placeholder]="'Name (optional)' | t" [value]="addName()" (input)="addName.set($any($event.target).value)"
                     (keydown.enter)="add()" [attr.aria-label]="'Name' | t">
              <input class="tst-in" [placeholder]="'Notes for Chat (optional)' | t" [value]="addNotes()" (input)="addNotes.set($any($event.target).value)"
                     (keydown.enter)="add()" [attr.aria-label]="'Notes' | t">
              <div class="st-seg" role="radiogroup" [attr.aria-label]="'Fetching' | t">
                @for (c of choices; track c.id) {
                  <button [class.on]="choice() === c.id" (click)="choice.set(c.id)" [disabled]="c.id !== 'off' && !proxy()?.configured" [title]="c.about | t">{{ c.label | t }}</button>
                }
              </div>
              <button class="tcv-btn tcv-btn-accent" (click)="add()" [disabled]="!addUrl().trim() || starting()">{{ (starting() ? 'Starting…' : 'Add and explore') | t }}</button>
            </div>
            <p class="st-hint mf-addhint">{{ choiceAbout() | t }}.
              @if (!proxy()?.configured) { {{ 'The proxy is not set up, so a run goes out directly.' | t }} <button class="st-more" (click)="toProxy()">{{ 'Settings > Proxy' | t }}</button> }
              @else if (!proxy()?.enabled) { {{ 'The proxy is set up but off for the part lookups; a run can still use it.' | t }} }
              {{ fmt('At most {p} pages of the same site, {s} s apart, robots.txt obeyed; then the model reads them.', { p: limits.pages, s: limits.delay }) }}</p>
            @if (addError(); as e) { <p class="st-hint mf-err">{{ e }}</p> }
          </div>
        </section>
      }

      @if (all().length) {
        <section class="st-card">
          <div class="st-card-head"><h3>{{ 'Manufacturers' | t }}</h3>
            <span class="st-sub">{{ 'open one for its catalog, its notes and its runs' | t }}</span></div>
          <div class="st-table-wrap">
            <table class="st-table mf-mtable">
              <thead><tr><th>{{ 'Manufacturer' | t }}</th><th>{{ 'Site' | t }}</th><th class="r">{{ 'Products' | t }}</th><th>{{ 'Categories' | t }}</th>
                <th>{{ 'Notes' | t }}</th><th>{{ 'Last run' | t }}</th><th>{{ 'Fetching' | t }}</th><th class="r">{{ 'Explored' | t }}</th></tr></thead>
              <tbody>
                @for (m of all(); track m.id) {
                  <tr (click)="openMaker(m.id)">
                    <td><b class="tsh-pname">{{ m.name }}</b></td>
                    <td class="dim">{{ m.domain }}</td>
                    <td class="r mono">{{ m.product_count }}</td>
                    <td class="give-s" [title]="m.categories.join(', ')">{{ m.categories.slice(0, 4).join(', ') || '–' }}</td>
                    <td class="give dim" [title]="m.notes">{{ m.notes || '–' }}</td>
                    <td>@if (runOf(m); as r) { <span class="st-tag" [attr.data-tone]="statusTone(r.status)">{{ statusName(r.status) | t }}</span> } @else { <span class="dim">{{ 'never' | t }}</span> }</td>
                    <td class="dim">{{ proxyLabel(m.proxy) | t }}</td>
                    <td class="r">{{ when(m.explored_at) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      }

      @if (runs.jobs().length) {
        <section class="st-card">
          <div class="st-card-head"><h3>{{ 'Recent explorations' | t }}</h3>
            <span class="st-sub">{{ 'open one to see its steps and pages' | t }}</span></div>
          <div class="st-table-wrap">
            <table class="st-table tsx-table">
              <thead><tr><th>{{ 'Manufacturer' | t }}</th><th>{{ 'Started' | t }}</th><th>{{ 'Status' | t }}</th><th>{{ 'Fetching' | t }}</th>
                <th class="r">{{ 'Pages' | t }}</th><th class="r">{{ 'Products' | t }}</th><th class="r">{{ 'Took' | t }}</th><th></th></tr></thead>
              <tbody>
                @for (r of runs.jobs().slice(0, 10); track r.id) {
                  <tr (click)="showRun(r.id)">
                    <td class="give">{{ r.manufacturer.name }} <span class="dim">{{ r.manufacturer.domain }}</span></td>
                    <td>{{ when(r.started_at) }} <span class="dim">· {{ r.by.name || ('someone' | t) }}</span></td>
                    <td><span class="st-tag" [attr.data-tone]="statusTone(r.status)">{{ statusName(r.status) | t }}</span></td>
                    <td class="dim">{{ proxyLabel(r.proxy) | t }}</td>
                    <td class="r mono">{{ r.page_count }}</td>
                    <td class="r mono">{{ r.products_found ?? '–' }}</td>
                    <td class="r mono">{{ dur(r.seconds) }}</td>
                    <td class="r"><button class="st-more" (click)="showRun(r.id); $event.stopPropagation()">{{ 'Open' | t }}</button></td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      }

      @if (!all().length) {
        <section class="st-card tsh-how">
          <div class="st-card-head"><h3>{{ 'How it works' | t }}</h3></div>
          <ol class="tsh-steps">
            <li><span class="tsh-n">1</span><div><b>{{ 'Add a maker by its site' | t }}</b>
              <p>{{ 'Its pages are read politely: the same site only, robots.txt obeyed, product pages first.' | t }}</p></div></li>
            <li><span class="tsh-n">2</span><div><b>{{ 'Watch the run' | t }}</b>
              <p>{{ 'Every page and every question to the model shows as it happens; it goes on if you leave or reload.' | t }}</p></div></li>
            <li><span class="tsh-n">3</span><div><b>{{ 'Ask Chat for a part' | t }}</b>
              <p>{{ 'Chat searches the saved catalogs, or @-mention a maker: "I need a 20 mm hinge - look at this one".' | t }}</p></div></li>
          </ol>
        </section>
      }
    }
  </section>
</div>`,
})
export class RoomMfr implements OnDestroy {
  private api = inject(MfrApi);
  readonly runs = inject(MfrRuns);
  private picked = inject(Selection);
  private auth = inject(Auth);
  private prefs = inject(Prefs);
  private search = viewChild.required<ElementRef<HTMLInputElement>>('search');
  private addUrlBox = viewChild<ElementRef<HTMLInputElement>>('addUrlBox');

  readonly choices = PROXY_CHOICES;
  readonly limits = { pages: 100, delay: 0.75 };
  can = computed(() => this.auth.can('draw'));

  /** Where the page is: the overview, a manufacturer, or a run - and the
   *  product search - all from the address and kept in it. */
  private url = new URLSearchParams(location.search);
  view = signal<'home' | 'maker' | 'run'>(this.url.get('run') ? 'run' : this.url.get('m') ? 'maker' : 'home');
  mid = signal<string | null>(this.url.get('m'));
  rid = signal<string | null>(this.url.get('run'));
  pq = signal(this.url.get('q') ?? '');
  cat = signal(this.url.get('cat') ?? '');
  listQ = signal('');

  all = signal<Maker[]>([]);
  maker = signal<Maker | null>(null);
  proxy = signal<ProxyState | null>(null);
  choice = signal<ProxyChoice>('off');
  private chosen = false;
  flash = signal<string | null>(null);

  addUrl = signal('');
  addName = signal('');
  addNotes = signal('');
  addError = signal<string | null>(null);
  starting = signal(false);
  cancelling = signal(false);
  rows = signal(200);

  job = signal<MfrJob | null>(null);
  runError = signal<string | null>(null);
  private tick = signal(Date.now());
  private offset = 0;
  private jobTimer?: ReturnType<typeof setTimeout>;
  private ticker?: ReturnType<typeof setInterval>;
  private poll = setInterval(() => this.read(), 20_000);

  constructor() {
    this.runs.here = true;
    this.runs.seen();
    this.runs.watch();
    this.runs.refresh();
    this.api.proxy().subscribe({ next: p => { this.proxy.set(p); if (!this.chosen) this.choice.set(p.default); }, error: () => {} });
    this.read();
    if (this.view() === 'run' && this.rid()) this.showRun(this.rid()!);
    else if (this.view() === 'maker' && this.mid()) this.openMaker(this.mid()!, true);
    // The address follows the page, so F5 comes back here.
    effect(() => {
      const v = this.view(), m = this.mid(), r = this.rid(), q = this.pq(), c = this.cat();
      const url = new URL(location.href);
      const set = (k: string, val: string | null) => val ? url.searchParams.set(k, val) : url.searchParams.delete(k);
      set('m', v === 'maker' ? m : null);
      set('run', v === 'run' ? r : null);
      set('q', v === 'maker' ? q : null);
      set('cat', v === 'maker' ? c : null);
      if (url.href !== location.href) history.replaceState(null, '', url);
    });
    // A manufacturer's own fetching choice, once it is open.
    effect(() => { const m = this.maker(); if (m && this.view() === 'maker') untracked(() => { this.choice.set(m.proxy); this.chosen = true; }); });
    // For the command palette's "Ask Chat about this manufacturer".
    effect(() => {
      const m = this.view() === 'maker' ? this.maker() : null;
      untracked(() => this.picked.mfr.set(m ? { id: m.id, label: m.name } : null));
    });
    // Asked from the command palette: one manufacturer, or the Add form.
    effect(() => {
      const w = this.picked.want();
      if (!w || (w.what !== 'mfr' && w.what !== 'mfr-add')) return;
      untracked(() => {
        this.picked.want.set(null);
        if (w.what === 'mfr' && w.arg) this.openMaker(w.arg); else this.goAdd();
      });
    });
    // A run the overview counts that ends: the list reads again (its catalog changed).
    effect(() => { this.runs.running(); untracked(() => this.read()); });
  }

  private read() {
    this.api.list('').subscribe({ next: ms => this.all.set(ms), error: () => {} });
    const m = this.maker();
    if (m && this.view() === 'maker') this.api.get(m.id).subscribe({ next: x => this.maker.set(x), error: () => {} });
  }

  shown = computed(() => {
    const w = fold(this.listQ()).split(/\s+/).filter(Boolean);
    if (!w.length) return this.all();
    return this.all().filter(m => { const h = fold(`${m.name} ${m.domain} ${m.notes} ${m.summary} ${m.categories.join(' ')}`); return w.every(x => h.includes(x)); });
  });
  totalProducts = computed(() => this.all().reduce((n, m) => n + m.product_count, 0));
  totalCats = computed(() => new Set(this.all().flatMap(m => m.categories)).size);
  exploredCount = computed(() => this.all().filter(m => m.explored_at).length);
  lastJob = computed(() => this.runs.jobs()[0] ?? null);
  /** A manufacturer's latest run: the live list first (it is the freshest). */
  runOf(m: Maker): { id: string; status: MfrStatus; started_at: string; error?: string | null; pages: number } | null {
    const live = this.runs.jobs().find(j => j.manufacturer.id === m.id);
    if (live) return { id: live.id, status: live.status, started_at: live.started_at, error: live.error, pages: live.page_count };
    return m.last_run;
  }
  isActiveS(s: MfrStatus) { return ACTIVE.includes(s); }

  // ---- one manufacturer

  makerStats = computed(() => {
    const ps = this.maker()?.products ?? [];
    return { specs: ps.filter(p => Object.keys(p.specs ?? {}).length).length, sku: ps.filter(p => p.sku).length };
  });
  productCats = computed(() => [...new Set((this.maker()?.products ?? []).map(p => p.category).filter(Boolean))].sort());
  catCount(c: string) { return (this.maker()?.products ?? []).filter(p => p.category === c).length; }
  found = computed(() => {
    const ps = this.maker()?.products ?? [];
    const words = fold(this.pq()).split(/\s+/).filter(Boolean), c = this.cat();
    return ps.filter(p => {
      if (c && p.category !== c) return false;
      if (!words.length) return true;
      const h = fold(`${p.name} ${p.sku} ${p.category} ${p.description} ${Object.entries(p.specs ?? {}).map(([k, v]) => k + ' ' + v).join(' ')}`);
      return words.every(w => h.includes(w));
    });
  });
  shownRows = computed(() => this.rows());
  specs(p: Product) { return Object.entries(p.specs ?? {}).slice(0, 5); }
  specLine(p: Product) { return Object.entries(p.specs ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n'); }

  openMaker(id: string, keepSearch = false) {
    this.stopFollowing();
    if (!keepSearch && id !== this.mid()) { this.pq.set(''); this.cat.set(''); }
    this.mid.set(id);
    this.view.set('maker');
    this.rows.set(200);
    if (this.maker()?.id !== id) this.maker.set(this.all().find(m => m.id === id) ?? null);
    this.api.get(id).subscribe({
      next: m => { if (this.mid() === id) this.maker.set(m); },
      error: (e: HttpErrorResponse) => { this.say(why(e, 'Could not open it.')); this.goHome(); },
    });
  }
  goHome() { this.stopFollowing(); this.view.set('home'); this.maker.set(null); this.mid.set(null); }
  goAdd() {
    this.goHome();
    setTimeout(() => this.addUrlBox()?.nativeElement.focus(), 50);
  }

  rename(m: Maker, name: string) {
    name = name.trim();
    if (!name || name === m.name) return;
    this.api.patch(m.id, { name }).subscribe({ next: r => this.replace(r), error: this.failed('Could not rename it.') });
  }
  saveNotes(m: Maker, notes: string) {
    if (notes.trim() === m.notes) return;
    this.api.patch(m.id, { notes: notes.trim() }).subscribe({ next: r => { this.replace(r); this.say(t('Notes saved.')); }, error: this.failed('Could not save it.') });
  }
  remove(m: Maker) {
    if (!confirm(t('Delete this manufacturer and its catalog?') + `\n\n${m.name}`)) return;
    this.api.remove(m.id).subscribe({ next: () => { this.goHome(); this.read(); this.runs.refresh(); }, error: this.failed('Could not delete it.') });
  }
  private replace(m: Maker) {
    this.all.update(l => l.map(x => x.id === m.id ? { ...m, products: undefined } : x));
    if (this.maker()?.id === m.id) this.maker.set({ ...this.maker()!, ...m, products: m.products ?? this.maker()!.products });
  }

  exportMaker(m: Maker) {
    this.api.exportFile(m.id).subscribe({
      next: data => {
        const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = `${(m.name || 'manufacturer').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'manufacturer'}.manufacturer.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      },
      error: this.failed('Could not export it.'),
    });
  }
  importMaker(input: HTMLInputElement) {
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    f.text().then(text => {
      let data: unknown;
      try { data = JSON.parse(text); } catch { this.say(t('That file is not a manufacturer.')); return; }
      this.api.importFile(data).subscribe({
        next: m => { this.read(); this.openMaker(m.id); this.say(this.fmt('{p} imported: {n} products', { p: m.name, n: m.product_count })); },
        error: this.failed('Could not import it.'),
      });
    });
  }

  // ---- adding and exploring

  add() {
    const url = this.addUrl().trim();
    if (!url || this.starting()) return;
    this.starting.set(true);
    this.addError.set(null);
    this.api.create({ url, name: this.addName().trim(), notes: this.addNotes().trim(), proxy: this.choice() }).subscribe({
      next: r => {
        this.starting.set(false);
        this.addUrl.set(''); this.addName.set(''); this.addNotes.set('');
        this.all.update(l => [...l.filter(x => x.id !== r.manufacturer.id), { ...r.manufacturer, products: undefined }]);
        if (r.job) { this.runs.put(r.job); this.showRun(r.job.job_id ?? r.job.id); } else this.openMaker(r.manufacturer.id);
      },
      error: (e: HttpErrorResponse) => { this.starting.set(false); this.addError.set(why(e, 'Could not add it.')); },
    });
  }

  exploreAgain(id: string, proxy: ProxyChoice) {
    if (this.starting()) return;
    this.starting.set(true);
    this.api.explore(id, proxy).subscribe({
      next: j => { this.starting.set(false); this.runs.put(j); this.showRun(j.id); },
      error: (e: HttpErrorResponse) => { this.starting.set(false); this.say(why(e, 'The exploration could not start.')); },
    });
  }

  cancelRun() {
    const j = this.job();
    if (!j || this.cancelling()) return;
    this.cancelling.set(true);
    this.api.cancelJob(j.id).subscribe({
      next: r => { this.cancelling.set(false); this.take(r); this.runs.put(r); },
      error: (e: HttpErrorResponse) => { this.cancelling.set(false); this.say(why(e, 'Could not cancel it.')); },
    });
  }

  // ---- a run, followed while it goes

  showRun(id: string) {
    this.stopFollowing();
    this.view.set('run');
    this.rid.set(id);
    this.runError.set(null);
    if (this.job()?.id !== id) this.job.set(null);
    this.api.job(id).subscribe({
      next: j => this.take(j),
      error: (e: HttpErrorResponse) => { this.job.set(null); this.runError.set(why(e, 'Could not open that run.')); },
    });
  }

  private take(j: MfrJob) {
    this.offset = Date.parse(j.now) - Date.now();
    this.job.set(j);
    this.mid.set(j.manufacturer.id);
    this.follow();
  }

  private follow() {
    clearTimeout(this.jobTimer);
    clearInterval(this.ticker);
    const j = this.job();
    if (!isActive(j) || this.view() !== 'run') return;
    this.ticker = setInterval(() => this.tick.set(Date.now()), 500);
    this.jobTimer = setTimeout(() => this.api.job(j!.id).subscribe({
      next: r => {
        if (this.job()?.id !== r.id || this.view() !== 'run') return;
        const was = this.job()!.status;
        this.take(r);
        if (r.status !== was) { this.runs.put(r); if (!isActive(r)) this.read(); }
      },
      error: () => this.follow(),
    }), 1500);
  }
  private stopFollowing() { clearTimeout(this.jobTimer); clearInterval(this.ticker); }

  running = computed(() => isActive(this.job()));
  crawlStep = computed(() => this.job()?.steps.find(s => s.id === 'crawl') ?? null);
  elapsed = computed(() => {
    const j = this.job();
    if (!j) return null;
    if (!isActive(j)) return j.seconds;
    this.tick();
    return Math.max(0, (Date.now() + this.offset - Date.parse(j.started_at)) / 1000);
  });
  pagesNewest = computed(() => [...(this.job()?.pages ?? [])].reverse());
  pageStats = computed(() => {
    const ps = this.job()?.pages ?? [];
    return { ok: ps.filter(p => !p.error).length, product: ps.filter(p => p.product && !p.error).length, bad: ps.filter(p => p.error).length };
  });
  nowLine = computed(() => {
    const j = this.job();
    if (!j) return '';
    if (j.finished_at) return this.fmt('finished {w}', { w: when(j.finished_at) });
    const cur = [...j.steps].reverse().find(s => s.state === 'running');
    if (!cur) return t('waiting to start');
    if (cur.kind === 'crawl') return this.fmt('reading {p}', { p: cur.current ? this.path(cur.current) : '' });
    if (cur.kind === 'ask') return this.fmt('waiting for {m}', { m: cur.model ?? '' });
    if (cur.kind === 'robots') return t('reading robots.txt');
    if (cur.kind === 'sitemap') return t('reading the sitemap');
    return t('merging the products');
  });
  trafficLine = computed(() => {
    const tt = this.job()?.totals ?? {};
    const parts = [this.fmt('{n} direct', { n: tt.requests_direct ?? 0 })];
    if (this.job()?.proxy !== 'off') parts.push(this.fmt('{n} via proxy', { n: tt.requests_proxy ?? 0 }));
    if (tt.wire_up != null || tt.wire_down != null) parts.push(this.kb((tt.wire_up ?? 0) + (tt.wire_down ?? 0)) + (tt.proxy_cost != null ? ' · ' + this.money(tt.proxy_cost) : ''));
    else if (tt.bytes_proxy) parts.push(this.kb(tt.bytes_proxy));
    return parts.join(' · ');
  });
  trafficTip = computed(() => {
    const tt = this.job()?.totals ?? {};
    return [this.fmt('{n} requests directly, {b}', { n: tt.requests_direct ?? 0, b: this.kb(tt.bytes_direct ?? 0) }),
            this.fmt('{n} requests through the proxy, {b}', { n: tt.requests_proxy ?? 0, b: this.kb(tt.bytes_proxy ?? 0) }),
            tt.wire_up != null ? this.fmt('on the wire to the proxy: {u} up, {d} down', { u: this.kb(tt.wire_up), d: this.kb(tt.wire_down ?? 0) }) : '',
            tt.proxy_since ? this.fmt('through the proxy since {w}, after a refusal', { w: when(tt.proxy_since) }) : ''].filter(Boolean).join('\n');
  });
  doneSteps = computed(() => this.timeline().filter(r => r.state === 'done').length);

  /** The run line by line: robots.txt, the sitemap, the pages, each
   *  question to the model, the merge - and, while it goes, what is to come. */
  timeline = computed(() => {
    const j = this.job();
    if (!j) return [];
    this.tick();
    const rows: { id: string; state: StepState; kind: string; title: string; detail: string; reason?: string; fig: string; time: string }[] = [];
    const live = (s: MfrStep) => s.state === 'running' && s.started_at
      ? this.dur(Math.max(0, (Date.now() + this.offset - Date.parse(s.started_at)) / 1000)) : this.dur(s.seconds ?? null);
    for (const s of j.steps) {
      if (s.kind === 'robots') {
        rows.push({ id: s.id, state: s.state, kind: 'Robots', title: t('robots.txt'), reason: s.reason,
          detail: [s.found ? this.fmt('{n} lines, {m} sitemaps', { n: s.rules ?? 0, m: s.sitemaps ?? 0 }) : '', s.note ? t(s.note) : '',
                   s.delay != null ? this.fmt('{s} s between requests', { s: s.delay }) : ''].filter(Boolean).join(' · '),
          fig: s.via === 'proxy' ? t('proxy') : '', time: live(s) });
      } else if (s.kind === 'sitemap') {
        rows.push({ id: s.id, state: s.state, kind: 'Sitemap', title: t('Sitemap'), reason: s.reason,
          detail: this.fmt('{n} files, {m} addresses', { n: s.files ?? 0, m: s.urls ?? 0 }), fig: '', time: live(s) });
      } else if (s.kind === 'crawl') {
        rows.push({ id: s.id, state: s.state, kind: 'Pages', title: this.fmt('{n} pages read', { n: s.read ?? 0 }), reason: s.reason,
          detail: [this.fmt('{n} asked of {m}', { n: s.pages ?? 0, m: s.cap ?? 0 }), s.skipped_robots ? this.fmt('{n} left out by robots.txt', { n: s.skipped_robots }) : '',
                   s.note ?? ''].filter(Boolean).join(' · '),
          fig: s.state === 'running' && s.current ? this.path(s.current) : '', time: live(s) });
      } else if (s.kind === 'ask') {
        const bits = [this.fmt('{p} pages, ~{k} tokens sent', { p: s.pages ?? 0, k: this.num(s.tokens_est ?? 0) })];
        if (s.tokens_in != null) bits.push(this.fmt('{i} in / {o} out counted', { i: this.num(s.tokens_in), o: this.num(s.tokens_out ?? 0) }));
        if (s.products != null) bits.push(this.fmt('{n} products', { n: s.products }));
        rows.push({ id: s.id, state: s.state, kind: 'Model', title: this.fmt('Chunk {n} of {m} · {model}', { n: s.n ?? 0, m: s.of ?? 0, model: s.model ?? '' }),
          detail: bits.join(' · '), reason: s.reason, fig: s.cost != null ? this.money(s.cost) : '', time: live(s) });
      } else if (s.kind === 'merge') {
        rows.push({ id: s.id, state: s.state, kind: 'Catalog', title: t('Merging the products'), reason: s.reason,
          detail: this.fmt('{n} found, {d} duplicates', { n: Number(s.found ?? 0), d: s.duplicates ?? 0 }),
          fig: s.products != null ? this.fmt('{n} kept', { n: s.products }) : '', time: live(s) });
      } else if (s.kind === 'done') {
        rows.push({ id: s.id, state: 'done', kind: 'Result', title: this.fmt('{n} products in the catalog', { n: s.products ?? 0 }),
          detail: this.fmt('{n} categories', { n: s.categories ?? 0 }), fig: '', time: '' });
      }
    }
    if (isActive(j)) {
      const has = (k: string) => j.steps.some(s => s.kind === k);
      const pend = (id: string, kind: string, title: string) => rows.push({ id, state: 'pending', kind, title, detail: '', fig: '', time: '' });
      if (!has('robots')) pend('p-robots', 'Robots', t('robots.txt'));
      if (!has('sitemap')) pend('p-sitemap', 'Sitemap', t('Sitemap'));
      if (!has('crawl')) pend('p-crawl', 'Pages', t('Reading the pages'));
      if (!has('ask')) pend('p-ask', 'Model', this.fmt('Asking {p} · {m}', { p: j.provider_name ?? '', m: j.model ?? '' }));
      if (!has('merge')) pend('p-merge', 'Catalog', t('Merging the products'));
      pend('p-done', 'Result', t('The catalog'));
    }
    return rows;
  });

  // ---- words and figures

  statusName(s: MfrStatus) {
    return ({ queued: 'Queued', crawling: 'Crawling', asking: 'Asking', merging: 'Merging', done: 'Done', failed: 'Failed',
              cancelled: 'Cancelled' } as Record<MfrStatus, string>)[s] ?? s;
  }
  statusTone(s: MfrStatus) { return s === 'done' ? 'ok' : s === 'failed' ? 'danger' : s === 'cancelled' ? 'warn' : 'accent'; }
  stateName(s: StepState) {
    return ({ running: 'running', done: 'done', skipped: 'skipped', failed: 'failed', cancelled: 'cancelled', pending: 'to come' } as Record<StepState, string>)[s] ?? s;
  }
  proxyLabel(p: ProxyChoice) { return PROXY_CHOICES.find(c => c.id === p)?.label ?? 'Off'; }
  choiceAbout = computed(() => { const c = PROXY_CHOICES.find(x => x.id === this.choice()); return c ? `${c.label}: ${c.about}` : ''; });
  proxyStateLine = computed(() => {
    const p = this.proxy();
    if (!p) return '–';
    if (!p.configured) return 'Not set up';
    if (!p.enabled) return 'Set up, off';
    return p.mode === 'always' ? 'On: always' : 'On: when refused';
  });
  toProxy() { this.prefs.open.set('proxy'); }
  pct(n: number, of: number) { return of ? Math.min(100, Math.round(n / of * 100)) : 0; }
  num(n: number) { return Math.round(n).toLocaleString(LANG() === 'tr' ? 'tr-TR' : 'en-US'); }
  kb(n: number) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  money(v: number | null | undefined) { return v == null ? '–' : '$' + (v < 1 ? v.toFixed(4) : v.toFixed(2)); }
  dur(s: number | null | undefined) {
    if (s == null) return '–';
    if (s < 10) return this.fmt('{s} s', { s: s.toFixed(1) });
    if (s < 60) return this.fmt('{s} s', { s: Math.floor(s) });
    return this.fmt('{m} min {s} s', { m: Math.floor(s / 60), s: String(Math.floor(s % 60)).padStart(2, '0') });
  }
  path(u: string) {
    try { const x = new URL(u); return decodeURIComponent(x.pathname + x.search) || '/'; } catch { return u; }
  }
  when = when;
  t = t;
  fmt(text: string, vars: Record<string, string | number>) {
    return t(text).replace(/\{(\w+)\}/g, (m, k) => k in vars ? String(vars[k]) : m);
  }
  private say(msg: string) { this.flash.set(msg); setTimeout(() => this.flash.set(null), 4000); }
  private failed = (fallback: string) => (e: HttpErrorResponse) => this.say(why(e, fallback));

  key(e: KeyboardEvent) {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName);
    if (e.key === '/' && !typing) { e.preventDefault(); this.search().nativeElement.focus(); }
  }

  ngOnDestroy() {
    clearInterval(this.poll); this.stopFollowing();
    this.runs.here = false;
    this.picked.mfr.set(null);
  }
}
