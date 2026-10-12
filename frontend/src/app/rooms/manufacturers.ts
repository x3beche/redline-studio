import { Component, ElementRef, Injectable, OnDestroy, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { NgTemplateOutlet } from '@angular/common';
import { Selection } from '../selection';
import { Auth } from '../auth';
import { Prefs } from '../preferences';
import { LANG, T, t } from '../i18n';
import { Confirm } from '../confirm';
import { CatalogStock, InventoryApi, qty } from './inventory';
import { RouteOrder, routeLine } from '../route-order';
import { DmSendButton } from '../dm';

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
/** How a run goes out: an order of routes ('local', 'proxy', 'jina'; backend/netroutes.py),
 *  or null for the Product Catalog's default order (Settings > Proxy & Data). */
export type RouteChoice = string[] | null;
export type MfrStatus = 'queued' | 'crawling' | 'asking' | 'merging' | 'done' | 'failed' | 'cancelled';
export type StepState = 'running' | 'done' | 'skipped' | 'failed' | 'cancelled' | 'pending';
/** A price as the catalog keeps it (backend/catalog_facts.py): `vat` excl when the page said "+ KDV",
 *  `gross` the same price with VAT when the page gave both, `at` when it was read (or typed). */
export interface Price { amount: number; currency: string; vat: 'incl' | 'excl' | null; text?: string; at?: string | null; gross?: number }
/** One reading of a product's price and stock (the last 10 are kept): a new row when either changed. */
export interface PriceRow { at: string; amount?: number; currency?: string; vat?: 'incl' | 'excl' | null; stock?: 'in' | 'out'; qty?: number; seen?: string }
export interface Product {
  id: string; name: string; category: string; description: string; specs: Record<string, string>;
  sku: string; url: string; image: string;
  /** More pictures of it, the main one first. */
  images?: string[];
  price?: Price; list_price?: { amount: number; currency: string; text?: string };
  /** What the seller's site said of its stock, how many when it said, and its words ("Son 3 adet"). */
  stock?: 'in' | 'out'; stock_qty?: number; stock_text?: string;
  /** The site it is sold on (its page's), and when: added to the catalog, last read from its page, the seller's own date. */
  seller?: { domain: string; host?: string; name?: string };
  added_at?: string; read_at?: string; updated?: string; history?: PriceRow[];
  /** Added by hand ('manual'), or changed by hand (`edited`): kept through a full exploration. */
  source?: 'manual'; edited?: boolean;
}
/** A product with its maker, as the catalog's grid lists them (GET /api/manufacturers/products). */
export interface GridItem extends Product { maker: { id: string; name: string; domain: string } }
export interface GridAnswer {
  items: GridItem[]; total: number; page: number; size: number; all: number;
  categories: [string, number][]; makers: { id: string; name: string; domain: string; count: number }[];
  sellers: [string, number][]; price: { min: number | null; max: number | null; currencies: string[] };
}
export interface GridQuery { q: string; cat: string; maker: string; seller: string; min: string; max: string; stock: string; sort: string; size: number }
/** What the Add a product form sends: specs as "name: value" lines; the price as typed, its currency and VAT. */
export interface ProductFields {
  name: string; category: string; sku: string; description: string; specs: string; url: string; image: string;
  price: string; currency: string; vat: '' | 'incl' | 'excl'; stock: '' | 'in' | 'out'; stock_qty: string;
}
export type RunKind = 'site' | 'page';
export interface LastRun { id: string; status: MfrStatus; started_at: string; finished_at: string | null; error?: string | null; pages: number; products: number | null; kept_pages?: number; kind?: RunKind }
export interface Maker {
  id: string; name: string; name_auto?: boolean; url: string; domain: string; notes: string; summary: string;
  categories: string[]; docs: { url: string; label: string }[]; route: RouteChoice; product_count: number;
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
  duplicates?: number; categories?: number; added?: number; catalog?: number; only?: boolean;
}
export interface MfrPage {
  url: string; depth: number; status: number | null; via: 'direct' | 'proxy' | 'jina'; ms?: number; bytes: number; at: string;
  title?: string; chars?: number; links?: number; product?: boolean; error?: string; fallback?: boolean;
}
export interface MfrTotals {
  pages?: number; read?: number; docs?: number; chunks?: number; chars?: number; tokens_in?: number; tokens_out?: number;
  cost?: number | null; products?: number; duplicates?: number; delay?: number;
  requests_direct?: number; bytes_direct?: number; requests_proxy?: number; bytes_proxy?: number; refused?: number;
  proxy_since?: string; wire_up?: number; wire_down?: number; proxy_cost?: number;
  /** Pages read through Jina Reader (backend/jina.py), and since when a refusal sent the run there. */
  requests_jina?: number; bytes_jina?: number; tokens_jina?: number; failed_jina?: number; jina_since?: string;
}
/** One exploration (backend/manufacturers.py, `manufacturer_jobs`). */
export interface MfrJob {
  id: string; status: MfrStatus; manufacturer: { id: string; name: string; url: string; domain: string };
  by: { id?: string; name?: string }; started_at: string; finished_at: string | null; seconds: number | null; now: string;
  provider?: string; provider_name?: string; model?: string;
  /** The routes the run went by, and whether they were the default order then. */
  route: string[]; route_default?: boolean;
  limits?: { pages: number; depth: number; delay: number };
  steps: MfrStep[]; totals: MfrTotals; pages?: MfrPage[]; page_count: number; error?: string | null; products_found?: number | null;
  cancelled_by?: { name?: string };
  /** Pages it kept, so its model step can run again without the site; and the run whose pages it read. */
  kept_pages?: number; reused?: string | null;
  /** 'page': only the pages in `only` were read (and, with `follow`, the product pages they link to), added to the catalog. */
  kind?: RunKind; only?: string[]; follow?: boolean;
}
export interface ProxyState {
  configured: boolean; price_per_gb: number; country: string; metered: boolean;
  /** Whether Jina AI has its key (Settings > Proxy & Data). */
  jina?: boolean;
  /** The routes a run can take, the default order, and why a route cannot be used now. */
  routes: string[]; order: string[]; ready: Record<string, string | null>;
}
export const ACTIVE: MfrStatus[] = ['queued', 'crawling', 'asking', 'merging'];
export const isActive = (j: { status: MfrStatus } | null | undefined) => !!j && ACTIVE.includes(j.status);

@Injectable({ providedIn: 'root' })
export class MfrApi {
  private http = inject(HttpClient);
  changed = signal(0);
  list(q = '') { return this.http.get<Maker[]>(`/api/manufacturers?q=${encodeURIComponent(q)}`); }
  get(id: string) { return this.http.get<Maker>(`/api/manufacturers/${id}`); }
  create(b: { url: string; name?: string; notes?: string; route: string[] | 'default'; explore?: boolean; only?: boolean; follow?: boolean }) {
    return this.http.post<{ manufacturer: Maker; job: (MfrJob & { job_id: string }) | null }>('/api/manufacturers', b);
  }
  patch(id: string, p: Partial<Pick<Maker, 'name' | 'notes' | 'summary' | 'url'>> & { route?: string[] | 'default' }) {
    return this.http.patch<Maker>(`/api/manufacturers/${id}`, p);
  }
  remove(id: string) { return this.http.delete(`/api/manufacturers/${id}`); }
  explore(id: string, route: RouteChoice) { return this.http.post<MfrJob>(`/api/manufacturers/${id}/explore`, { route: route ?? 'default' }); }
  readAgain(id: string, run: string) { return this.http.post<MfrJob>(`/api/manufacturers/${id}/read-again`, { run }); }
  readPage(id: string, urls: string[], follow: boolean, route: RouteChoice) {
    return this.http.post<MfrJob>(`/api/manufacturers/${id}/read-page`, { urls, follow, route: route ?? 'default' });
  }
  addProduct(id: string, p: ProductFields) { return this.http.post<{ product: Product; manufacturer: Maker }>(`/api/manufacturers/${id}/products`, p); }
  editProduct(id: string, pid: string, p: ProductFields) {
    return this.http.patch<{ product: Product; manufacturer: Maker }>(`/api/manufacturers/${id}/products/${pid}`, p);
  }
  deleteProducts(id: string, ids: string[]) {
    return this.http.post<{ deleted: number; manufacturer: Maker }>(`/api/manufacturers/${id}/products/delete`, { ids });
  }
  deleteJob(id: string) { return this.http.delete(`/api/manufacturers/jobs/${id}`); }
  /** Every maker's products for the grid: filtered, sorted, the first `size`. */
  products(f: GridQuery) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v !== '' && v != null) q.set(k, String(v));
    return this.http.get<GridAnswer>(`/api/manufacturers/products?${q}`);
  }
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

/** Row actions, drawn as the Chat list's. */
const I = {
  open: 'M14 5h5v5 M19 5l-8 8 M17 14v5H5V7h5',
  edit: 'M4 20h4L19.5 8.5l-4-4L4 16z M13.5 6.5l4 4',
  trash: 'M4 7h16 M9.5 7V4h5v3 M6.5 7l.8 13h9.4l.8-13 M10 11v5.5 M14 11v5.5',
  stock: 'M3 8l9-5 9 5v12H3z M3 8h18 M12 11v6 M9 14h6',
  photo: 'M4 6h16v12H4z M4 15l4.5-4.5 3.5 3.5 2.5-2.5L20 17 M15.5 9.5h.01',
  close: 'M6 6l12 12 M18 6L6 18',
  grid: 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z',
  rows: 'M4 6h16 M4 12h16 M4 18h16',
};
const NO_PRODUCT: ProductFields = { name: '', category: '', sku: '', description: '', specs: '', url: '', image: '',
                                    price: '', currency: 'TRY', vat: '', stock: '', stock_qty: '' };
export const CURRENCIES = ['TRY', 'USD', 'EUR', 'GBP', 'CNY'];

@Component({
  selector: 'app-room-mfr',
  imports: [T, NgTemplateOutlet, RouteOrder, DmSendButton],
  styleUrls: ['../settings.css', './taste.css', './manufacturers.css'],
  host: { '(document:keydown)': 'key($event)', '(document:click)': 'menu.set(null)', '(document:scroll)': 'menu.set(null)', '(window:resize)': 'menu.set(null)' },
  template: `
<!-- How the next run goes out: the default order, or one of its own (the route order below) -->
<ng-template #fetchSeg let-maker="maker">
  <div class="st-seg" role="radiogroup" [attr.aria-label]="'Fetching' | t">
    <button [class.on]="choice() === null" (click)="useDefault(maker)" [title]="line(proxy()?.order)">{{ 'Default order' | t }}</button>
    <button [class.on]="choice() !== null" (click)="ownOrder(maker)" [title]="'Its own order of routes' | t">{{ 'Own order' | t }}</button>
  </div>
</ng-template>
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
            <h2>{{ fmt(j.kind === 'page' ? 'Reading a page of {m}' : 'Exploring {m}', { m: j.manufacturer.name }) }}</h2>
            @if (j.kind === 'page') {
              <span class="st-sub">@for (u of j.only ?? []; track u) { <a class="mf-link" [href]="u" target="_blank" rel="noopener noreferrer">{{ u }}</a> · }
                {{ (j.follow ? 'only the given pages and the product pages they link to' : 'only the given pages') | t }}; {{ 'robots.txt obeyed' | t }}</span>
            } @else {
              <span class="st-sub"><a class="mf-link" [href]="j.manufacturer.url" target="_blank" rel="noopener noreferrer">{{ j.manufacturer.url }}</a>
                · {{ fmt('at most {p} pages, {d} links deep, {s} s between requests; robots.txt obeyed', { p: j.limits?.pages ?? 0, d: j.limits?.depth ?? 0, s: j.totals.delay ?? j.limits?.delay ?? 0 }) }}</span>
            }
          </div>
          <div class="tst-acts">
            @if (running()) {
              <button class="tcv-btn tst-del" (click)="cancelRun()" [disabled]="cancelling() || !can()">{{ (cancelling() ? 'Cancelling…' : 'Cancel the run') | t }}</button>
            } @else if (can()) {
              <button class="tcv-btn tcv-btn-accent" (click)="runAgain(j)" [disabled]="starting()">{{ 'Run again' | t }}</button>
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
          <div class="st-tile" [attr.data-tone]="j.route.join() === 'local' ? 'dim' : null"><span>{{ 'Fetching' | t }}</span>
            <b [title]="(j.route_default ? 'Default order' : 'Own order') | t">{{ line(j.route) }}</b>
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
                      <td><span class="st-tag" [attr.data-tone]="p.via === 'proxy' || p.via === 'jina' ? 'accent' : null">{{ (p.via === 'proxy' ? 'proxy' : p.via === 'jina' ? 'Jina' : 'direct') | t }}</span></td>
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
            <ng-container *ngTemplateOutlet="fetchSeg; context: { maker: m }" />
            @if (runOf(m); as r) { @if (isActiveS(r.status)) {
              <button class="tcv-btn tcv-btn-accent" (click)="showRun(r.id)">{{ 'Watch the run' | t }}</button>
            } @else {
              @if (r.kept_pages) {
                <button class="tcv-btn" (click)="readAgain(m.id, r.id)" [disabled]="starting()"
                        [title]="fmt('The model reads the {n} pages of the last run again - the site is not fetched', { n: r.kept_pages })">
                  {{ 'Read the pages again' | t }}</button>
              }
              <button class="tcv-btn tcv-btn-accent" (click)="exploreAgain(m.id, choice())" [disabled]="starting()">{{ 'Explore again' | t }}</button>
            } } @else {
              <button class="tcv-btn tcv-btn-accent" (click)="exploreAgain(m.id, choice())" [disabled]="starting()">{{ 'Explore' | t }}</button>
            }
            <button class="tcv-btn" (click)="exportMaker(m)" [title]="'Save it as a file to send to someone' | t">{{ 'Export' | t }}</button>
            <button class="tcv-btn tst-del" (click)="remove(m)">{{ 'Delete' | t }}</button>
          }
        </div>
      </header>
      @if (can()) {
        @if (choice() !== null) {
          <div class="mf-route"><span class="st-sub">{{ 'Own order' | t }}</span>
            <app-route-order [routes]="proxy()?.routes ?? []" [order]="choice() ?? []" [ready]="proxy()?.ready ?? {}"
                             (changed)="setMakerRoute(m, $event)" /></div>
        }
        <p class="st-hint mf-proxyhint">{{ fetchAbout() }} <button class="st-more" (click)="toProxy()">{{ 'Settings > Proxy & Data' | t }}</button></p>
      }

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

      @if (can()) {
        <section class="st-card mf-pageadd">
          <div class="mf-addrow mf-ctl">
            <span class="mf-label mf-rowlabel" [title]="pageHint | t">{{ 'Add from a page' | t }}</span>
            <input class="tst-in" [placeholder]="'https://… a product page, or a list of products' | t" [value]="pageUrl()"
                   (input)="pageUrl.set($any($event.target).value)" (keydown.enter)="readPage(m)" [attr.aria-label]="'Page address' | t" [title]="pageHint | t">
            <span class="st-sub mf-pagenote">{{ 'only that page; what is in the catalog stays' | t }}</span>
            <label class="mf-check" [title]="'Same site, one link deep, at most 30 pages' | t"><input type="checkbox" [checked]="pageFollow()"
                   (change)="pageFollow.set($any($event.target).checked)"> {{ 'also the product pages it links to' | t }}</label>
            <button class="tcv-btn tcv-btn-accent" (click)="readPage(m)" [disabled]="!pageUrl().trim() || starting() || (runOf(m) && isActiveS(runOf(m)!.status))">{{ 'Read it' | t }}</button>
          </div>
        </section>
      }

      <section class="st-card mf-catalog">
        <div class="st-card-head mf-cathead"><h3>{{ 'Catalog' | t }}</h3>
          <input class="tst-in mf-find" [placeholder]="'Find a product: name, code, size, material' | t" [value]="pq()"
                 (input)="pq.set($any($event.target).value)" (keydown.escape)="pq.set('')">
          <select class="tst-sel" [value]="cat()" (change)="cat.set($any($event.target).value)" [attr.aria-label]="'Category' | t">
            <option value="">{{ 'All categories' | t }}</option>
            @for (c of productCats(); track c) { <option [value]="c" [selected]="c === cat()">{{ c }}</option> }
          </select>
          @if (picked_().size) {
            <span class="mf-selbar">{{ fmt('{n} selected', { n: picked_().size }) }}
              @if (can()) { <button class="tcv-btn" (click)="openStock('*')">{{ 'Add selected to stock' | t }}</button> }
              <button class="tcv-btn tst-del" (click)="deleteProducts(m, pickedIds())">{{ 'Delete' | t }}</button>
              <button class="tcv-btn" (click)="pickAll(false)">{{ 'Clear' | t }}</button></span>
          }
          <span class="st-right st-sub">{{ fmt('{n} of {m}', { n: found().length, m: m.products?.length ?? 0 }) }}</span>
          <ng-container *ngTemplateOutlet="layoutT" />
          @if (can()) { <button class="tcv-btn" (click)="openProduct(null)" [disabled]="editing() === ''">{{ 'Add a product' | t }}</button> }</div>
        @if (editing() !== null) {
          <div class="mf-pform mf-ctl">
            <input class="tst-in mf-pf-name" [placeholder]="'Name' | t" [value]="pf().name" (input)="pfSet('name', $event)" (keydown.enter)="saveProduct(m)" [attr.aria-label]="'Name' | t">
            <input class="tst-in" [placeholder]="'Code / SKU' | t" [value]="pf().sku" (input)="pfSet('sku', $event)" (keydown.enter)="saveProduct(m)" [attr.aria-label]="'Code' | t">
            <input class="tst-in" [placeholder]="'Category' | t" [value]="pf().category" (input)="pfSet('category', $event)" (keydown.enter)="saveProduct(m)" list="mf-cats" [attr.aria-label]="'Category' | t">
            <input class="tst-in" [placeholder]="'Page address (optional)' | t" [value]="pf().url" (input)="pfSet('url', $event)" (keydown.enter)="saveProduct(m)" [attr.aria-label]="'Page address' | t">
            <input class="tst-in" [placeholder]="'Image address (optional)' | t" [value]="pf().image" (input)="pfSet('image', $event)" (keydown.enter)="saveProduct(m)" [attr.aria-label]="'Image address' | t">
            <input class="tst-in mf-pf-desc" [placeholder]="'Description (optional)' | t" [value]="pf().description" (input)="pfSet('description', $event)" (keydown.enter)="saveProduct(m)" [attr.aria-label]="'Description' | t">
            <textarea class="tst-in mf-pf-specs" rows="3" [placeholder]="'Specs, one per line - Length: 20 mm' | t" [value]="pf().specs" (input)="pfSet('specs', $event)" [attr.aria-label]="'Specs' | t"></textarea>
            <div class="mf-pf-price">
              <input class="tst-in mf-pf-amount" inputmode="decimal" [placeholder]="'Price, e.g. 362,60' | t" [value]="pf().price" (input)="pfSet('price', $event)" (keydown.enter)="saveProduct(m)" [attr.aria-label]="'Price' | t">
              <select class="tst-sel" [value]="pf().currency" (change)="pfSet('currency', $event)" [attr.aria-label]="'Currency' | t">
                @for (c of currencies; track c) { <option [value]="c" [selected]="c === pf().currency">{{ c }}</option> }</select>
              <select class="tst-sel" [value]="pf().vat" (change)="pfSet('vat', $event)" [attr.aria-label]="'VAT' | t">
                <option value="" [selected]="!pf().vat">{{ 'VAT not said' | t }}</option>
                <option value="excl" [selected]="pf().vat === 'excl'">{{ '+VAT (excluded)' | t }}</option>
                <option value="incl" [selected]="pf().vat === 'incl'">{{ 'VAT included' | t }}</option></select>
              <select class="tst-sel" [value]="pf().stock" (change)="pfSet('stock', $event)" [attr.aria-label]="'Stock on the site' | t">
                <option value="" [selected]="!pf().stock">{{ 'Stock not said' | t }}</option>
                <option value="in" [selected]="pf().stock === 'in'">{{ 'In stock' | t }}</option>
                <option value="out" [selected]="pf().stock === 'out'">{{ 'Out of stock' | t }}</option></select>
              <input class="tst-in mf-pf-qty" inputmode="numeric" [placeholder]="'Qty' | t" [value]="pf().stock_qty" (input)="pfSet('stock_qty', $event)" [attr.aria-label]="'How many the seller has' | t" [title]="'How many the seller has' | t">
            </div>
            <div class="mf-pf-acts">
              <button class="tcv-btn tcv-btn-accent" (click)="saveProduct(m)" [disabled]="!pf().name.trim() || saving()">{{ (editing() ? 'Save' : 'Add') | t }}</button>
              <button class="tcv-btn" (click)="editing.set(null)">{{ 'Cancel' | t }}</button>
            </div>
            <datalist id="mf-cats">@for (c of productCats(); track c) { <option [value]="c"></option> }</datalist>
          </div>
        }
        @if (stockFor() === '*') {
          <div class="mf-stockform mf-ctl">
            <span class="mf-stocklabel">{{ fmt('Add {n} products to stock', { n: picked_().size }) }}</span>
            <ng-container *ngTemplateOutlet="stockFields" />
            <button class="tcv-btn tcv-btn-accent" (click)="addToStock(m.id, pickedIds())" [disabled]="saving()">{{ 'Add to stock' | t }}</button>
            <button class="tcv-btn" (click)="stockFor.set(null)">{{ 'Cancel' | t }}</button>
          </div>
        }
        @if (m.products?.length && layout() === 'grid') {
          <div class="mf-grid">
            @for (p of found().slice(0, shownRows()); track p.id) { <ng-container *ngTemplateOutlet="cardT; context: { $implicit: asItem(p, m) }" /> }
            @empty { <p class="st-hint mf-pad">{{ 'Nothing matches.' | t }}</p> }
          </div>
          @if (found().length > shownRows()) {
            <button class="st-more mf-morerows" (click)="rows.set(rows() + 200)">{{ fmt('Show {n} more', { n: found().length - shownRows() }) }}</button>
          }
        } @else if (m.products?.length) {
          <div class="st-table-wrap">
            <table class="st-table mf-table">
              <thead><tr>@if (can()) { <th class="mf-selcol"><input type="checkbox" [checked]="allPicked()" (change)="pickAll($any($event.target).checked)" [attr.aria-label]="'Select all' | t"></th> }
                <th class="mf-pname">{{ 'Product' | t }}</th><th class="mf-pcode">{{ 'Code' | t }}</th><th class="mf-pprice r">{{ 'Price' | t }}</th><th class="mf-pcat">{{ 'Category' | t }}</th><th class="mf-specs">{{ 'Specs' | t }}</th><th class="mf-desc">{{ 'Description' | t }}</th><th class="mf-actcell"></th></tr></thead>
              <tbody>
                @for (p of found().slice(0, shownRows()); track p.id) {
                  <tr class="mf-prow" [attr.data-sel]="picked_().has(p.id) ? 1 : null">
                    @if (can()) { <td class="mf-selcol"><input type="checkbox" [checked]="picked_().has(p.id)" (change)="pick(p.id, $any($event.target).checked)" [attr.aria-label]="p.name"></td> }
                    <td class="mf-pname" [title]="p.name"><button class="mf-namebtn" (click)="openDetail(asItem(p, m))">{{ p.name }}</button>@if (stock()[p.id]; as s) { <button class="st-tag mf-instock" [attr.data-tone]="s.low ? 'warn' : 'ok'" (click)="toStock(s)" [title]="'Open it in the Inventory' | t">{{ fmt('in stock: {n}', { n: qty(s.quantity) + ' ' + s.unit }) }}</button> }@if (p.source === 'manual') { <span class="st-tag mf-hand">{{ 'by hand' | t }}</span> } @else if (p.edited) { <span class="st-tag mf-hand">{{ 'edited' | t }}</span> }</td>
                    <td class="mono mf-pcode" [title]="p.sku">{{ p.sku || '–' }}</td>
                    <td class="r mf-pprice" [title]="p.price?.text || ''">@if (p.price) { <b>{{ money2(p.price.amount, p.price.currency) }}</b>@if (p.price.vat === 'excl') { <small class="dim"> {{ '+VAT' | t }}</small> } } @else { <span class="dim">–</span> }
                      @if (p.stock) { <br><span class="mf-sdot" [attr.data-s]="p.stock">{{ stockName(p) }}</span> }</td>
                    <td class="dim mf-pcat" [title]="p.category">{{ p.category || '–' }}</td>
                    <td class="mf-specs" [title]="specLine(p)">@for (s of specs(p); track s[0]) { <span class="mf-spec"><em>{{ s[0] }}</em> {{ s[1] }}</span> }@if (!specs(p).length) { <span class="dim">–</span> }</td>
                    <td class="mf-desc dim" [title]="p.description">{{ p.description || '–' }}</td>
                    <td class="r mf-actcell">@if (p.url) { <a class="st-more mf-open" [href]="p.url" target="_blank" rel="noopener noreferrer">{{ 'Page' | t }}</a> }
                      @if (p.image) { <a class="st-more mf-open" [href]="p.image" target="_blank" rel="noopener noreferrer">{{ 'Image' | t }}</a> }
                      @if (can()) {
                        <div class="tcv-cc-itemacts mf-rowacts">
                          <button class="tcv-cc-ib" (click)="openStock(p.id)" [title]="'Add to stock' | t">
                            <svg class="tcv-cc-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.stock" /></svg></button>
                          <button class="tcv-cc-ib" (click)="openProduct(p)" [title]="'Edit the product' | t">
                            <svg class="tcv-cc-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.edit" /></svg></button>
                          <button class="tcv-cc-ib tcv-cc-danger" (click)="deleteProducts(m, [p.id])" [title]="'Delete the product' | t">
                            <svg class="tcv-cc-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.trash" /></svg></button>
                        </div>
                      }</td>
                  </tr>
                  @if (stockFor() === p.id) {
                    <tr class="mf-stockrow"><td [attr.colspan]="can() ? 8 : 7">
                      <div class="mf-stockform mf-ctl">
                        <span class="mf-stocklabel">{{ stock()[p.id] ? fmt('Top up {name} in stock', { name: p.name }) : fmt('Add {name} to stock', { name: p.name }) }}</span>
                        <ng-container *ngTemplateOutlet="stockFields" />
                        <button class="tcv-btn tcv-btn-accent" (click)="addToStock(m.id, [p.id])" [disabled]="saving()">{{ (stock()[p.id] ? 'Top up' : 'Add to stock') | t }}</button>
                        <button class="tcv-btn" (click)="stockFor.set(null)">{{ 'Cancel' | t }}</button>
                      </div>
                    </td></tr>
                  }
                } @empty { <tr><td [attr.colspan]="can() ? 8 : 7" class="dim">{{ 'Nothing matches.' | t }}</td></tr> }
              </tbody>
            </table>
          </div>
          @if (found().length > shownRows()) {
            <button class="st-more mf-morerows" (click)="rows.set(rows() + 200)">{{ fmt('Show {n} more', { n: found().length - shownRows() }) }}</button>
          }
        } @else {
          <p class="st-hint mf-pad">{{ (runOf(m) && isActiveS(runOf(m)!.status) ? 'The site is being explored; the catalog fills in when the run is done.' : 'No products yet: explore the site, read one page, or add a product by hand.') | t }}</p>
        }
      </section>

    } @else {
      <!-- ================= the overview: every product as a grid, or the sites and adding one ================= -->
      <header class="tst-head tsh-head mf-homehead">
        <div class="tst-title">
          <h2>{{ 'Product Catalog' | t }}</h2>
          <span class="st-sub">{{ fmt('{n} products from {m} sites. Chat looks here when you need a part.', { n: num(totalProducts()), m: all().length }) }}</span>
        </div>
        <div class="tst-acts">
          <div class="st-seg" role="tablist" [attr.aria-label]="'Product Catalog' | t">
            <button [class.on]="sub() === 'products'" (click)="sub.set('products')">{{ 'All products' | t }}</button>
            <button [class.on]="sub() === 'sites'" (click)="sub.set('sites')">{{ fmt('Sites ({n})', { n: all().length }) }}</button>
          </div>
          @if (can()) { <button class="tcv-btn" (click)="goAdd()">{{ 'Add a site or a page' | t }}</button> }
        </div>
      </header>
      @if (sub() === 'products') {
        <div class="mf-gbar mf-ctl">
          <input #gridSearch class="tst-in mf-gfind" type="search" [placeholder]="'Search every product: name, code, size, material, seller' | t" [value]="pq()"
                 (input)="pq.set($any($event.target).value); gpages.set(1)" (keydown.escape)="pq.set('')" [attr.aria-label]="'Search products' | t">
          <select class="tst-sel" [value]="cat()" (change)="cat.set($any($event.target).value); gpages.set(1)" [attr.aria-label]="'Category' | t">
            <option value="">{{ 'All categories' | t }}</option>
            @for (c of grid()?.categories ?? []; track c[0]) { <option [value]="c[0]" [selected]="c[0] === cat()">{{ c[0] }} ({{ c[1] }})</option> }
          </select>
          <select class="tst-sel" [value]="gmaker()" (change)="gmaker.set($any($event.target).value); gpages.set(1)" [attr.aria-label]="'Maker' | t">
            <option value="">{{ 'All makers' | t }}</option>
            @for (k of grid()?.makers ?? []; track k.id) { <option [value]="k.id" [selected]="k.id === gmaker()">{{ k.name }} ({{ k.count }})</option> }
          </select>
          <select class="tst-sel" [value]="gseller()" (change)="gseller.set($any($event.target).value); gpages.set(1)" [attr.aria-label]="'Seller' | t">
            <option value="">{{ 'All sellers' | t }}</option>
            @for (k of grid()?.sellers ?? []; track k[0]) { <option [value]="k[0]" [selected]="k[0] === gseller()">{{ k[0] }} ({{ k[1] }})</option> }
          </select>
          <span class="mf-range">
            <input class="tst-in" inputmode="decimal" [placeholder]="'Min price' | t" [value]="gmin()" (change)="gmin.set($any($event.target).value.trim()); gpages.set(1)" [attr.aria-label]="'Min price' | t">
            <span class="dim">–</span>
            <input class="tst-in" inputmode="decimal" [placeholder]="'Max price' | t" [value]="gmax()" (change)="gmax.set($any($event.target).value.trim()); gpages.set(1)" [attr.aria-label]="'Max price' | t">
          </span>
          <label class="mf-check"><input type="checkbox" [checked]="gstock()" (change)="gstock.set($any($event.target).checked); gpages.set(1)"> {{ 'In stock' | t }}</label>
          <select class="tst-sel" [value]="gsort()" (change)="gsort.set($any($event.target).value)" [attr.aria-label]="'Sort' | t">
            @for (o of sorts; track o.id) { <option [value]="o.id" [selected]="o.id === gsort()">{{ o.label | t }}</option> }
          </select>
          @if (filtered()) { <button class="tcv-btn" (click)="clearFilters()">{{ 'Clear' | t }}</button> }
          <span class="st-right st-sub mf-gcount">{{ grid() ? fmt('{n} of {m}', { n: num(grid()!.total), m: num(grid()!.all) }) : '' }}</span>
          <ng-container *ngTemplateOutlet="layoutT" />
        </div>
        @if (grid(); as g) {
          @if (layout() === 'grid') {
            <div class="mf-grid">
              @for (p of g.items; track p.maker.id + p.id) { <ng-container *ngTemplateOutlet="cardT; context: { $implicit: p }" /> }
            </div>
          } @else {
            <div class="st-table-wrap mf-gtable-wrap">
              <table class="st-table mf-gtable">
                <thead><tr><th class="mf-gthumb"></th><th>{{ 'Product' | t }}</th><th>{{ 'Seller' | t }}</th><th class="r">{{ 'Price' | t }}</th>
                  <th>{{ 'Stock' | t }}</th><th>{{ 'Category' | t }}</th><th>{{ 'Code' | t }}</th><th class="r">{{ 'Read' | t }}</th></tr></thead>
                <tbody>
                  @for (p of g.items; track p.maker.id + p.id) {
                    <tr class="mf-prow" (click)="openDetail(p)" (contextmenu)="openMenu($event, p)">
                      <td class="mf-gthumb">@if (img(p); as src) { <img [src]="src" loading="lazy" referrerpolicy="no-referrer" alt="" (error)="broke(src)"> } @else { <span class="mf-thumb0"></span> }</td>
                      <td class="give"><b>{{ p.name }}</b></td>
                      <td class="dim">{{ sellerName(p) }}</td>
                      <td class="r">@if (p.price) { <b>{{ money2(p.price.amount, p.price.currency) }}</b>@if (p.price.vat === 'excl') { <small class="dim"> {{ '+VAT' | t }}</small> } } @else { <span class="dim">–</span> }</td>
                      <td>@if (p.stock) { <span class="mf-sdot" [attr.data-s]="p.stock">{{ stockName(p) }}</span> } @else { <span class="dim">–</span> }</td>
                      <td class="dim">{{ p.category || '–' }}</td>
                      <td class="mono dim">{{ p.sku || '–' }}</td>
                      <td class="r dim">{{ ago(p.read_at || p.price?.at || p.added_at) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
          @if (!g.items.length) {
            <p class="st-hint mf-gempty">{{ (g.all ? 'No product matches - try fewer words or clear the filters.' : 'No products yet: add a site, or read a product page into the catalog.') | t }}
              @if (!g.all && can()) { <button class="st-more" (click)="goAdd()">{{ 'Add a site or a page' | t }}</button> }</p>
          }
          @if (g.total > g.items.length) {
            <button class="st-more mf-morerows" (click)="gpages.set(gpages() + 1)">{{ fmt('Show {n} more', { n: g.total - g.items.length }) }}</button>
          }
        } @else { <p class="st-hint">{{ 'Loading…' | t }}</p> }
      } @else {
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
        <button class="st-tile mf-tilebtn" [attr.data-tone]="proxy()?.configured ? (proxy()?.order?.includes('proxy') ? 'ok' : null) : 'dim'" (click)="toProxy()"><span>{{ 'Default order' | t }}</span>
          <b>{{ line(proxy()?.order) }}</b><small>{{ proxyStateLine() | t }}</small></button>
        <button class="st-tile mf-tilebtn" [attr.data-tone]="proxy()?.jina ? 'ok' : 'dim'" (click)="toProxy()"><span>Jina AI</span>
          <b>{{ (proxy()?.jina ? 'Ready' : 'Not set up') | t }}</b><small>{{ (proxy()?.jina ? 'reads pages a plain fetch cannot' : 'no API key - Settings > Proxy & Data') | t }}</small></button>
      </div>

      @if (can()) {
        <section class="st-card mf-add" id="mf-add">
          <div class="st-card-head"><h3>{{ 'Add a manufacturer' | t }}</h3>
            <span class="st-sub">{{ (addOnly() ? 'only the page you give is read, and the products on it go into its catalog' : 'its site is explored at once: the pages, then the products in them') | t }}</span>
            <div class="st-seg st-right" role="radiogroup" [attr.aria-label]="'What is read' | t">
              <button [class.on]="!addOnly()" (click)="addOnly.set(false)" [title]="'The site is crawled: robots.txt, the sitemap, the product pages' | t">{{ 'Whole site' | t }}</button>
              <button [class.on]="addOnly()" (click)="addOnly.set(true)" [title]="'Only the address given is read - a product, or a list of them' | t">{{ 'Only this page' | t }}</button>
            </div></div>
          <div class="st-card-body">
            <div class="mf-addrow mf-ctl">
              <input #addUrlBox class="tst-in" [placeholder]="(addOnly() ? 'https://www.example.com/products/hinges' : 'https://www.example.com') | t" [value]="addUrl()" (input)="addUrl.set($any($event.target).value)"
                     (keydown.enter)="add()" [attr.aria-label]="(addOnly() ? 'Page address' : 'Site address') | t">
              <input class="tst-in" [placeholder]="'Name (optional)' | t" [value]="addName()" (input)="addName.set($any($event.target).value)"
                     (keydown.enter)="add()" [attr.aria-label]="'Name' | t">
              <input class="tst-in" [placeholder]="'Notes for Chat (optional)' | t" [value]="addNotes()" (input)="addNotes.set($any($event.target).value)"
                     (keydown.enter)="add()" [attr.aria-label]="'Notes' | t">
              <ng-container *ngTemplateOutlet="fetchSeg; context: { maker: null }" />
              @if (addOnly()) {
                <label class="mf-check" [title]="'Same site, one link deep, at most 30 pages' | t"><input type="checkbox" [checked]="addFollow()"
                       (change)="addFollow.set($any($event.target).checked)"> {{ 'also the product pages it links to' | t }}</label>
              }
              <button class="tcv-btn tcv-btn-accent" (click)="add()" [disabled]="!addUrl().trim() || starting()">{{ (starting() ? 'Starting…' : addOnly() ? 'Add and read the page' : 'Add and explore') | t }}</button>
            </div>
            @if (choice() !== null) {
              <div class="mf-route"><span class="st-sub">{{ 'Own order' | t }}</span>
                <app-route-order [routes]="proxy()?.routes ?? []" [order]="choice() ?? []" [ready]="proxy()?.ready ?? {}"
                                 (changed)="choice.set($event)" /></div>
            }
            <p class="st-hint mf-addhint">{{ fetchAbout() }}
              @if (addOnly()) { {{ pageHint | t }} }
              @else { {{ fmt('At most {p} pages of the same site, {s} s apart, robots.txt obeyed; then the model reads them.', { p: limits.pages, s: limits.delay }) }} }
              <button class="st-more" (click)="toProxy()">{{ 'Settings > Proxy & Data' | t }}</button></p>
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
                    <td class="dim">{{ m.route ? line(m.route) : ('Default order' | t) }}</td>
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
              <thead><tr><th>{{ 'Manufacturer' | t }}</th><th>{{ 'Kind' | t }}</th><th>{{ 'Started' | t }}</th><th>{{ 'Status' | t }}</th><th>{{ 'Fetching' | t }}</th>
                <th class="r">{{ 'Pages' | t }}</th><th class="r">{{ 'Products' | t }}</th><th class="r">{{ 'Took' | t }}</th><th></th></tr></thead>
              <tbody>
                @for (r of runs.jobs().slice(0, 10); track r.id) {
                  <tr class="mf-prow" (click)="showRun(r.id)">
                    <td class="give">{{ r.manufacturer.name }} <span class="dim">{{ r.manufacturer.domain }}</span></td>
                    <td><span class="st-tag" [attr.data-tone]="r.kind === 'page' ? 'accent' : null" [title]="(r.only ?? []).join('\n')">{{ (r.kind === 'page' ? 'Page' : 'Site') | t }}</span></td>
                    <td>{{ when(r.started_at) }} <span class="dim">· {{ r.by.name || ('someone' | t) }}</span></td>
                    <td><span class="st-tag" [attr.data-tone]="statusTone(r.status)">{{ statusName(r.status) | t }}</span></td>
                    <td class="dim">{{ line(r.route) }}</td>
                    <td class="r mono">{{ r.page_count }}</td>
                    <td class="r mono">{{ r.products_found ?? '–' }}</td>
                    <td class="r mono">{{ dur(r.seconds) }}</td>
                    <td class="r mf-actcell"><button class="st-more" (click)="showRun(r.id); $event.stopPropagation()">{{ 'Open' | t }}</button>
                      @if (mayDeleteRun(r)) {
                        <div class="tcv-cc-itemacts mf-rowacts">
                          <button class="tcv-cc-ib" (click)="showRun(r.id); $event.stopPropagation()" [title]="'Open' | t">
                            <svg class="tcv-cc-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.open" /></svg></button>
                          <button class="tcv-cc-ib tcv-cc-danger" (click)="deleteRun(r); $event.stopPropagation()" [title]="'Delete the run and the pages it kept' | t">
                            <svg class="tcv-cc-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.trash" /></svg></button>
                        </div>
                      }</td>
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
    }
    <!-- ================= one product, in full ================= -->
    @if (detail(); as d) {
      <div class="mf-modal" (click)="closeDetail()">
        <div class="mf-detail" role="dialog" aria-modal="true" [attr.aria-label]="d.name" (click)="$event.stopPropagation()">
          <button class="tcv-cc-ib mf-x" (click)="closeDetail()" [title]="'Close' | t">
            <svg class="tcv-cc-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.close" /></svg></button>
          <div class="mf-dgal">
            <div class="mf-dimg">@if (bigImg(); as src) { <img [src]="src" referrerpolicy="no-referrer" alt="" (error)="broke(src)"> }
              @else { <svg class="mf-noimg" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.photo" /></svg> }</div>
            @if (gallery().length > 1) {
              <div class="mf-thumbs">@for (u of gallery(); track u) {
                <button [class.on]="u === bigImg()" (click)="shot.set(u)"><img [src]="u" loading="lazy" referrerpolicy="no-referrer" alt="" (error)="broke(u)"></button> }</div>
            }
          </div>
          <div class="mf-dinfo">
            <span class="mf-dseller"><img class="mf-fav" [src]="fav(d)" alt="" referrerpolicy="no-referrer" (error)="$any($event.target).style.visibility = 'hidden'">
              <span>{{ sellerName(d) }}</span>
              @if (d.maker.name && d.maker.domain !== d.seller?.domain) { <span class="dim">· {{ d.maker.name }}</span> }
              <button class="st-more" (click)="closeDetail(); openMaker(d.maker.id)">{{ 'Open the maker' | t }}</button></span>
            <h2 class="mf-dname">{{ d.name }}</h2>
            <div class="mf-dmeta">
              @if (d.sku) { <span class="mono">{{ fmt('Code {c}', { c: d.sku }) }}</span> }
              @if (d.category) { <span class="mf-chip">{{ d.category }}</span> }
              @if (d.source === 'manual') { <span class="st-tag">{{ 'by hand' | t }}</span> } @else if (d.edited) { <span class="st-tag">{{ 'edited' | t }}</span> }
              @if (dStock()[d.id]; as s) { <button class="st-tag mf-instock" [attr.data-tone]="s.low ? 'warn' : 'ok'" (click)="toStock(s)">{{ fmt('in stock: {n}', { n: qty(s.quantity) + ' ' + s.unit }) }}</button> }
            </div>
            <div class="mf-dprice">
              @if (d.price) {
                <b>{{ money2(d.price.amount, d.price.currency) }}</b>
                @if (d.price.vat === 'excl') { <span class="mf-vat">{{ '+VAT' | t }}</span> } @else if (d.price.vat === 'incl') { <span class="mf-vat">{{ 'VAT included' | t }}</span> }
                @if (d.list_price && d.list_price.amount > d.price.amount) { <s>{{ money2(d.list_price.amount, d.list_price.currency || d.price.currency) }}</s> }
                @if (d.price.gross) { <small class="dim">{{ fmt('{p} with VAT', { p: money2(d.price.gross, d.price.currency) }) }}</small> }
              } @else { <span class="dim">{{ 'No price on its page' | t }}</span> }
            </div>
            <div class="mf-dstock">
              @if (d.stock) { <span class="mf-stock mf-stock-inline" [attr.data-s]="d.stock">{{ stockName(d) }}</span>
                @if (d.stock_text) { <span class="dim">"{{ d.stock_text }}"</span> } }
              @else { <span class="dim">{{ 'The page did not say whether it is in stock.' | t }}</span> }
              @if (d.price?.at || d.read_at) { <span class="dim">· {{ fmt('read {w}', { w: ago(d.read_at || d.price?.at) }) }}</span> }
            </div>
            <dl class="mf-dates">
              <div><dt>{{ 'Added to the catalog' | t }}</dt><dd>{{ stamp(d.added_at) }}</dd></div>
              <div><dt>{{ 'Price read' | t }}</dt><dd>{{ stamp(d.price?.at) }}</dd></div>
              <div><dt>{{ 'Page read' | t }}</dt><dd>{{ stamp(d.read_at) }}</dd></div>
              <div><dt>{{ "Seller's update" | t }}</dt><dd>{{ d.updated ? stamp(d.updated) : ('not given' | t) }}</dd></div>
            </dl>
            <div class="mf-dacts">
              @if (d.url) { <a class="tcv-btn tcv-btn-accent" [href]="d.url" target="_blank" rel="noopener noreferrer">{{ 'Open its page' | t }}</a> }
              <!-- To a person in Chat, as a card that opens it (dm.ts). -->
              <rl-dm-send-btn kind="product" [id]="d.maker.id + ':' + d.id" [label]="d.name" cls="tcv-btn tcv-dm-sendbtn" />
              @if (can()) {
                <button class="tcv-btn" (click)="openStock(d.id)">{{ (dStock()[d.id] ? 'Top up' : 'Add to stock') | t }}</button>
                <button class="tcv-btn" (click)="editFromDetail(d)">{{ 'Edit' | t }}</button>
                <button class="tcv-btn tst-del" (click)="deleteFromDetail(d)">{{ 'Delete' | t }}</button>
              }
            </div>
            @if (stockFor() === d.id) {
              <div class="mf-stockform mf-ctl mf-dstockform">
                <ng-container *ngTemplateOutlet="stockFields" />
                <button class="tcv-btn tcv-btn-accent" (click)="addToStock(d.maker.id, [d.id])" [disabled]="saving()">{{ (dStock()[d.id] ? 'Top up' : 'Add to stock') | t }}</button>
                <button class="tcv-btn" (click)="stockFor.set(null)">{{ 'Cancel' | t }}</button>
              </div>
            }
            @if (d.description) { <p class="mf-ddesc">{{ d.description }}</p> }
            @if (specList(d).length) {
              <table class="mf-dspecs"><tbody>@for (s of specList(d); track s[0]) { <tr><th>{{ s[0] }}</th><td>{{ s[1] }}</td></tr> }</tbody></table>
            }
            @if (d.history?.length) {
              <span class="mf-label">{{ 'Price and stock, as read' | t }}</span>
              <table class="st-table mf-dhist">
                <thead><tr><th>{{ 'Date' | t }}</th><th class="r">{{ 'Price' | t }}</th><th>{{ 'Stock' | t }}</th><th class="r">{{ 'Change' | t }}</th></tr></thead>
                <tbody>@for (h of histRows(d); track h.at) {
                  <tr><td>{{ stamp(h.at) }}@if (h.seen) { <span class="dim"> – {{ stamp(h.seen) }}</span> }</td>
                    <td class="r">{{ h.amount != null ? money2(h.amount, h.currency || '') : '–' }}@if (h.vat === 'excl') { <small class="dim"> {{ '+VAT' | t }}</small> }</td>
                    <td>{{ h.stock ? (h.stock === 'in' ? (h.qty != null ? fmt('{n} left', { n: h.qty }) : t('In stock')) : t('Out of stock')) : '–' }}</td>
                    <td class="r mono" [attr.data-up]="h.change > 0 ? 1 : null" [attr.data-down]="h.change < 0 ? 1 : null">{{ h.change ? (h.change > 0 ? '+' : '') + h.change.toFixed(1) + '%' : '' }}</td></tr>
                }</tbody>
              </table>
            }
          </div>
        </div>
      </div>
    }
  </section>
</div>
<!-- A product's right-click menu, on the grid's cards and the table's rows -->
@if (menu(); as mn) {
  <div class="tcv-fm-menu mf-menu" role="menu" [style.left.px]="mn.x" [style.top.px]="mn.y" (click)="$event.stopPropagation()" (contextmenu)="$event.preventDefault()">
    <button class="tcv-fm-menu-item" role="menuitem" (click)="menu.set(null); openDetail(mn.p)"><span>{{ 'Open' | t }}</span></button>
    @if (mn.p.url) { <a class="tcv-fm-menu-item" role="menuitem" [href]="mn.p.url" target="_blank" rel="noopener noreferrer" (click)="menu.set(null)"><span>{{ 'Open its page' | t }}</span><kbd>↗</kbd></a> }
    @if (can()) {
      <button class="tcv-fm-menu-item" role="menuitem" (click)="menu.set(null); editFromDetail(mn.p)"><span>{{ 'Edit' | t }}</span></button>
      <div class="tcv-fm-menu-sep"></div>
      <button class="tcv-fm-menu-item" role="menuitem" data-danger (click)="menu.set(null); deleteFromDetail(mn.p)"><span>{{ 'Delete' | t }}</span><kbd>Del</kbd></button>
    }
  </div>
}
<!-- ================= shared pieces ================= -->
<ng-template #cardT let-p>
  <button class="mf-card" (click)="openDetail(p)" (contextmenu)="openMenu($event, p)" [title]="p.name">
    <span class="mf-card-img">
      @if (img(p); as src) { <img [src]="src" loading="lazy" decoding="async" referrerpolicy="no-referrer" alt="" (error)="broke(src)"> }
      @else { <svg class="mf-noimg" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.photo" /></svg> }
      @if (p.stock) { <span class="mf-stock" [attr.data-s]="p.stock">{{ stockName(p) }}</span> }
    </span>
    <span class="mf-card-body">
      <span class="mf-card-name">{{ p.name }}</span>
      @if (p.price) {
        <span class="mf-card-price"><b>{{ money2(p.price.amount, p.price.currency) }}</b>@if (p.price.vat === 'excl') { <small>{{ '+VAT' | t }}</small> }
          @if (p.list_price && p.list_price.amount > p.price.amount) { <s>{{ money2(p.list_price.amount, p.list_price.currency || p.price.currency) }}</s> }</span>
      } @else { <span class="mf-card-price mf-noprice">{{ 'No price' | t }}</span> }
      <span class="mf-card-seller"><img class="mf-fav" [src]="fav(p)" alt="" loading="lazy" referrerpolicy="no-referrer" (error)="$any($event.target).style.visibility = 'hidden'"><span>{{ sellerName(p) }}</span></span>
      <span class="mf-card-foot">@if (p.category) { <span class="mf-chip" [title]="p.category">{{ p.category }}</span> }<span class="mf-ago">{{ readAgo(p) }}</span></span>
    </span>
  </button>
</ng-template>
<ng-template #layoutT>
  <div class="st-seg mf-layout" role="radiogroup" [attr.aria-label]="'Layout' | t">
    <button [class.on]="layout() === 'grid'" (click)="layout.set('grid')" [title]="'Grid' | t"><svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.grid" /></svg>{{ 'Grid' | t }}</button>
    <button [class.on]="layout() === 'table'" (click)="layout.set('table')" [title]="'Table' | t"><svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.rows" /></svg>{{ 'Table' | t }}</button>
  </div>
</ng-template>
<ng-template #stockFields>
          <input class="tst-in mf-sf-qty" inputmode="decimal" [placeholder]="'Qty' | t" [value]="sf().quantity" (input)="sfSet('quantity', $event)" (keydown.enter)="stockEnter()" [attr.aria-label]="'Quantity' | t">
          <input class="tst-in mf-sf-unit" list="inv-units-mf" [value]="sf().unit" (input)="sfSet('unit', $event)" (keydown.enter)="stockEnter()" [attr.aria-label]="'Unit' | t">
          <input class="tst-in mf-sf-loc" [placeholder]="'Location' | t" [value]="sf().location" (input)="sfSet('location', $event)" (keydown.enter)="stockEnter()" [attr.aria-label]="'Location' | t">
          <input class="tst-in mf-sf-note" [placeholder]="'Note for the log (optional)' | t" [value]="sf().note" (input)="sfSet('note', $event)" (keydown.enter)="stockEnter()" [attr.aria-label]="'Note' | t">
          <datalist id="inv-units-mf">@for (u of units; track u) { <option [value]="u"></option> }</datalist>
        </ng-template>
`,
})
export class RoomMfr implements OnDestroy {
  private api = inject(MfrApi);
  readonly runs = inject(MfrRuns);
  private picked = inject(Selection);
  private auth = inject(Auth);
  private prefs = inject(Prefs);
  private search = viewChild.required<ElementRef<HTMLInputElement>>('search');
  private gridSearch = viewChild<ElementRef<HTMLInputElement>>('gridSearch');
  private addUrlBox = viewChild<ElementRef<HTMLInputElement>>('addUrlBox');

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
  /** The overview: every product (the grid, the default), or the sites and adding one. */
  sub = signal<'products' | 'sites'>(this.url.get('sub') === 'sites' ? 'sites' : 'products');
  /** Cards or rows - the overview's and a maker's catalog alike. */
  layout = signal<'grid' | 'table'>(this.url.get('view') === 'table' ? 'table' : 'grid');
  gmaker = signal(this.url.get('maker') ?? '');
  gseller = signal(this.url.get('seller') ?? '');
  gmin = signal(this.url.get('min') ?? '');
  gmax = signal(this.url.get('max') ?? '');
  gstock = signal(this.url.get('stock') === 'in');
  gsort = signal(this.url.get('sort') ?? 'new');
  gpages = signal(1);
  grid = signal<GridAnswer | null>(null);
  private gtimer?: ReturnType<typeof setTimeout>;
  private gseq = 0;
  readonly sorts = [{ id: 'new', label: 'Newest' }, { id: 'price_asc', label: 'Price: low to high' },
                    { id: 'price_desc', label: 'Price: high to low' }, { id: 'name', label: 'Name' }, { id: 'match', label: 'Best match' }];
  readonly currencies = CURRENCIES;
  filtered = computed(() => !!(this.pq() || this.cat() || this.gmaker() || this.gseller() || this.gmin() || this.gmax() || this.gstock()));
  /** The product open in full (?p=, its maker ?pm=), the picture shown big, what the Inventory holds of its maker's. */
  detail = signal<GridItem | null>(null);
  shot = signal<string | null>(null);
  dStock = signal<Record<string, CatalogStock>>({});
  /** Pictures that did not load: the placeholder instead. */
  broken = signal<Set<string>>(new Set());

  all = signal<Maker[]>([]);
  maker = signal<Maker | null>(null);
  proxy = signal<ProxyState | null>(null);
  /** How the next run goes out: null for the default order, else its own. */
  choice = signal<RouteChoice>(null);
  flash = signal<string | null>(null);

  addUrl = signal('');
  addName = signal('');
  addNotes = signal('');
  addError = signal<string | null>(null);
  /** "Only this page": the address is one page to read, not a site to explore. */
  addOnly = signal(false);
  addFollow = signal(false);
  pageUrl = signal('');
  pageFollow = signal(false);
  /** The product form: null closed, '' adding, a product's id editing it. */
  editing = signal<string | null>(null);
  pf = signal<ProductFields>({ ...NO_PRODUCT });
  saving = signal(false);
  picked_ = signal<Set<string>>(new Set());
  readonly I = I;
  /** What the Inventory holds of each product of the open catalog (one read), and the
   *  "Add to stock" form: open for one product (its id) or for the selected ones ('*'). */
  private inv = inject(InventoryApi);
  stock = signal<Record<string, CatalogStock>>({});
  stockFor = signal<string | null>(null);
  sf = signal({ quantity: '1', unit: 'pcs', location: '', note: '' });
  readonly units = ['pcs', 'm', 'cm', 'mm', 'kg', 'g', 'l', 'ml', 'roll', 'reel', 'box', 'pack', 'set', 'pair', 'sheet', 'bag'];
  qty = qty;
  readonly pageHint = "Only that page is read (robots.txt obeyed) - the maker's site or a distributor's. A list or category page adds every product on it; what is in the catalog stays.";
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
    this.api.proxy().subscribe({ next: p => this.proxy.set(p), error: () => {} });
    this.read();
    if (this.view() === 'run' && this.rid()) this.showRun(this.rid()!);
    else if (this.view() === 'maker' && this.mid()) this.openMaker(this.mid()!, true);
    // A product that was open in full, after F5.
    const pid = this.url.get('p'), pm = this.url.get('pm');
    if (pid && pm) this.api.get(pm).subscribe({ next: m => { const p = (m.products ?? []).find(x => x.id === pid); if (p) this.openDetail(this.asItem(p, m)); }, error: () => {} });
    // The overview's grid: read again when what it shows changes (a breath after typing).
    effect(() => {
      if (this.view() !== 'home' || this.sub() !== 'products') return;
      const f: GridQuery = { q: this.pq().trim(), cat: this.cat(), maker: this.gmaker(), seller: this.gseller(), min: this.gmin(),
                             max: this.gmax(), stock: this.gstock() ? 'in' : '', sort: this.gsort(), size: 60 * this.gpages() };
      untracked(() => { clearTimeout(this.gtimer); this.gtimer = setTimeout(() => this.loadGrid(f), this.grid() ? 180 : 0); });
    });
    // The address follows the page, so F5 comes back here.
    effect(() => {
      const v = this.view(), m = this.mid(), r = this.rid(), q = this.pq(), c = this.cat();
      const home = v === 'home', grid = home && this.sub() === 'products', d = this.detail();
      const url = new URL(location.href);
      const set = (k: string, val: string | null) => val ? url.searchParams.set(k, val) : url.searchParams.delete(k);
      set('m', v === 'maker' ? m : null);
      set('run', v === 'run' ? r : null);
      set('q', v === 'maker' || grid ? q : null);
      set('cat', v === 'maker' || grid ? c : null);
      set('sub', home && this.sub() === 'sites' ? 'sites' : null);
      set('maker', grid ? this.gmaker() : null);
      set('seller', grid ? this.gseller() : null);
      set('min', grid ? this.gmin() : null);
      set('max', grid ? this.gmax() : null);
      set('stock', grid && this.gstock() ? 'in' : null);
      set('sort', grid && this.gsort() !== 'new' ? this.gsort() : null);
      set('view', v !== 'run' && this.layout() === 'table' ? 'table' : null);
      set('p', d ? d.id : null);
      set('pm', d ? d.maker.id : null);
      if (url.href !== location.href) history.replaceState(null, '', url);
    });
    // A manufacturer's own fetching choice, once it is open.
    effect(() => { const m = this.maker(); if (m && this.view() === 'maker') untracked(() => this.choice.set(m.route ?? null)); });
    // For the command palette's "Ask Chat about this manufacturer".
    effect(() => {
      const m = this.view() === 'maker' ? this.maker() : null;
      untracked(() => this.picked.mfr.set(m ? { id: m.id, label: m.name } : null));
    });
    // Asked from the command palette: one manufacturer, or the Add form.
    effect(() => {
      const w = this.picked.want();
      if (!w || (w.what !== 'mfr' && w.what !== 'mfr-add' && w.what !== 'mfr-product')) return;
      untracked(() => {
        this.picked.want.set(null);
        // A product, from the Inventory: its maker open, searched for its name.
        if (w.what === 'mfr-product' && w.arg) {
          const [mid, name] = w.arg.split('\n');
          this.openMaker(mid, true);
          this.pq.set(name ?? '');
        } else if (w.what === 'mfr' && w.arg) this.openMaker(w.arg); else this.goAdd();
      });
    });
    // A run the overview counts that ends: the list reads again (its catalog changed).
    effect(() => { this.runs.running(); untracked(() => this.read()); });
  }

  private read() {
    this.api.list('').subscribe({ next: ms => this.all.set(ms), error: () => {} });
    if (this.view() === 'home' && this.sub() === 'products') this.loadGrid();
    const m = this.maker();
    if (m && this.view() === 'maker') { this.api.get(m.id).subscribe({ next: x => this.maker.set(x), error: () => {} }); this.readStock(m.id); }
  }
  private readStock(id: string) {
    this.inv.stock(id).subscribe({ next: st => { if (this.mid() === id) this.stock.set(st); }, error: () => {} });
  }

  // ---- taking products into the Inventory

  openStock(id: string) {
    this.stockFor.set(this.stockFor() === id ? null : id);
    this.sf.update(f => ({ ...f, quantity: '1', note: '' }));
  }
  sfSet(k: 'quantity' | 'unit' | 'location' | 'note', e: Event) {
    const v = (e.target as HTMLInputElement).value;
    this.sf.update(f => ({ ...f, [k]: v }));
  }
  stockEnter() {
    const f = this.stockFor(), d = this.detail();
    if (!f) return;
    if (d && f === d.id) this.addToStock(d.maker.id, [f]);
    else if (this.mid()) this.addToStock(this.mid()!, f === '*' ? this.pickedIds() : [f]);
  }
  addToStock(mid: string, ids: string[]) {
    const f = this.sf(), q = Number(f.quantity.trim().replace(',', '.'));
    if (!ids.length || this.saving()) return;
    if (!f.quantity.trim() || !Number.isFinite(q) || q < 0) { this.say(t('The quantity is not a number.')); return; }
    const body = { manufacturer: mid, quantity: q, unit: f.unit.trim() || 'pcs', location: f.location.trim(), note: f.note.trim() };
    this.saving.set(true);
    const done = (added: number, merged: number, bad: string[]) => {
      this.saving.set(false);
      this.stockFor.set(null);
      this.readStock(mid);
      if (this.detail()?.maker.id === mid) this.inv.stock(mid).subscribe({ next: st => this.dStock.set(st), error: () => {} });
      this.say(ids.length === 1 && !bad.length
        ? (merged ? t('Topped up in the Inventory: an item there is already that product.') : t('Added to the Inventory.'))
        : this.fmt('{a} added to stock, {m} topped up', { a: added, m: merged }) + (bad.length ? ' · ' + bad.join('; ') : ''));
    };
    if (ids.length === 1) {
      this.inv.fromCatalog({ ...body, product: ids[0] }).subscribe({
        next: r => done(r.merged ? 0 : 1, r.merged ? 1 : 0, []),
        error: (e: HttpErrorResponse) => { this.saving.set(false); this.say(why(e, 'Could not add it.')); },
      });
    } else {
      this.inv.fromCatalogMany({ ...body, products: ids }).subscribe({
        next: r => { this.picked_.set(new Set()); done(r.results.filter(x => x.item && !x.merged).length, r.results.filter(x => x.merged).length,
                                                     r.results.filter(x => x.error).map(x => x.error!)); },
        error: (e: HttpErrorResponse) => { this.saving.set(false); this.say(why(e, 'Could not add them.')); },
      });
    }
  }
  /** The stock chip: the item in the Inventory (the first, when several are linked). */
  toStock(s: CatalogStock) {
    this.picked.room.set('inventory');
    setTimeout(() => this.picked.ask('inventory', s.items[0]), 50);
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
  runOf(m: Maker): { id: string; status: MfrStatus; started_at: string; error?: string | null; pages: number; kept_pages?: number; kind?: RunKind } | null {
    const live = this.runs.jobs().find(j => j.manufacturer.id === m.id);
    if (live) return { id: live.id, status: live.status, started_at: live.started_at, error: live.error, pages: live.page_count,
                       kept_pages: live.kept_pages, kind: live.kind };
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
    if (id !== this.mid()) { this.picked_.set(new Set()); this.editing.set(null); this.pageUrl.set(''); }
    this.mid.set(id);
    this.view.set('maker');
    this.rows.set(200);
    if (this.maker()?.id !== id) this.maker.set(this.all().find(m => m.id === id) ?? null);
    if (id !== this.maker()?.id || !Object.keys(this.stock()).length) this.stock.set({});
    this.readStock(id);
    this.api.get(id).subscribe({
      next: m => { if (this.mid() === id) this.maker.set(m); },
      error: (e: HttpErrorResponse) => { this.say(why(e, 'Could not open it.')); this.goHome(); },
    });
  }
  goHome() {
    this.stopFollowing();
    if (this.view() !== 'home') { this.pq.set(''); this.cat.set(''); }
    this.view.set('home'); this.maker.set(null); this.mid.set(null);
  }
  goAdd() {
    this.goHome();
    this.sub.set('sites');
    setTimeout(() => this.addUrlBox()?.nativeElement.focus(), 50);
  }

  // ---- the grid of every product, and one product in full

  loadGrid(f?: GridQuery) {
    f ??= { q: this.pq().trim(), cat: this.cat(), maker: this.gmaker(), seller: this.gseller(), min: this.gmin(), max: this.gmax(),
            stock: this.gstock() ? 'in' : '', sort: this.gsort(), size: 60 * this.gpages() };
    const n = ++this.gseq;
    this.api.products(f).subscribe({ next: g => { if (n === this.gseq) this.grid.set(g); }, error: () => { if (n === this.gseq && !this.grid()) this.grid.set(null); } });
  }
  clearFilters() {
    this.pq.set(''); this.cat.set(''); this.gmaker.set(''); this.gseller.set(''); this.gmin.set(''); this.gmax.set('');
    this.gstock.set(false); this.gpages.set(1);
  }
  asItem(p: Product, m: Pick<Maker, 'id' | 'name' | 'domain'>): GridItem {
    return { ...p, maker: { id: m.id, name: m.name, domain: m.domain } };
  }
  openDetail(p: GridItem) {
    this.detail.set(p);
    this.shot.set(null);
    this.stockFor.set(null);
    this.dStock.set({});
    this.inv.stock(p.maker.id).subscribe({ next: st => { if (this.detail()?.maker.id === p.maker.id) this.dStock.set(st); }, error: () => {} });
  }
  closeDetail() { this.detail.set(null); if (this.stockFor() && this.stockFor() !== '*') this.stockFor.set(null); }
  editFromDetail(d: GridItem) {
    this.closeDetail();
    this.openMaker(d.maker.id);
    this.openProduct(d);
  }
  /** The right-click menu: where, and on which product. */
  menu = signal<{ x: number; y: number; p: GridItem } | null>(null);
  openMenu(e: MouseEvent, p: GridItem) {
    e.preventDefault();
    const w = 220, h = this.can() ? 150 : 80;
    this.menu.set({ x: Math.min(e.clientX, innerWidth - w - 8), y: Math.min(e.clientY, innerHeight - h - 8), p });
  }
  deleteFromDetail(d: GridItem) {
    this.sure(t('Delete this product?'), d.name).then(ok => ok && this.api.deleteProducts(d.maker.id, [d.id]).subscribe({
      next: r => { this.closeDetail(); this.replace(r.manufacturer); this.read(); },
      error: this.failed('Could not delete it.'),
    }));
  }
  /** Its pictures, the main one first; those that did not load left out. */
  pics(p: Product): string[] {
    const b = this.broken();
    return [...new Set([p.image, ...(p.images ?? [])].filter(u => !!u && !b.has(u)))];
  }
  img(p: Product): string | null { return this.pics(p)[0] ?? null; }
  gallery = computed(() => { const d = this.detail(); return d ? this.pics(d).slice(0, 12) : []; });
  bigImg = computed(() => { const s = this.shot(), g = this.gallery(); return s && g.includes(s) ? s : g[0] ?? null; });
  broke(src: string) { if (!this.broken().has(src)) this.broken.update(s => new Set(s).add(src)); }
  /** The seller's site: its own little icon (loaded from it, like the pictures). */
  fav(p: GridItem): string {
    const h = p.seller?.host || p.seller?.domain || p.maker?.domain;
    return h ? `https://${h.startsWith('www.') || h.split('.').length > 2 ? h : 'www.' + h}/favicon.ico` : '';
  }
  sellerName(p: GridItem) { return p.seller?.name || p.seller?.domain || p.maker?.domain || p.maker?.name || ''; }
  stockName(p: { stock?: 'in' | 'out'; stock_qty?: number }) {
    if (p.stock === 'out') return t('Out of stock');
    return p.stock_qty != null ? this.fmt('{n} left', { n: p.stock_qty }) : t('In stock');
  }
  readAgo(p: Product) {
    const r = p.read_at || p.price?.at;
    return r ? this.fmt('read {w}', { w: this.ago(r) }) : p.added_at ? this.fmt('added {w}', { w: this.ago(p.added_at) }) : '';
  }
  specList(p: Product) { return Object.entries(p.specs ?? {}); }
  /** The readings newest first, each with how much the price moved from the one before. */
  histRows(p: Product) {
    const h = p.history ?? [];
    return h.map((x, i) => {
      const prev = h[i - 1];
      const change = prev?.amount && x.amount != null && prev.currency === x.currency ? (x.amount - prev.amount) / prev.amount * 100 : 0;
      return { ...x, change: Math.abs(change) < 0.05 ? 0 : change };
    }).reverse();
  }
  money2(v: number, cur: string) {
    const loc = LANG() === 'tr' ? 'tr-TR' : 'en-US';
    try {
      if (cur) return new Intl.NumberFormat(loc, { style: 'currency', currency: cur, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
    } catch { /* not a currency the browser knows */ }
    return new Intl.NumberFormat(loc, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v) + (cur ? ' ' + cur : '');
  }
  /** How long ago: "just now", "5 min ago", "2 h ago", "3 d ago", else the date. */
  ago(iso: string | null | undefined): string {
    if (!iso) return '–';
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) return iso;
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return t('just now');
    if (s < 3600) return this.fmt('{n} min ago', { n: Math.floor(s / 60) });
    if (s < 86400) return this.fmt('{n} h ago', { n: Math.floor(s / 3600) });
    if (s < 30 * 86400) return this.fmt('{n} d ago', { n: Math.floor(s / 86400) });
    return when(iso);
  }
  /** A date in full: 12 Oct 2026 14:05 - or as the seller wrote it. */
  stamp(iso: string | null | undefined): string {
    if (!iso) return '–';
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) return iso;
    const loc = LANG() === 'tr' ? 'tr-TR' : 'en-GB';
    return new Date(ms).toLocaleString(loc, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' · ' + this.ago(iso);
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
    this.sure(t('Delete this manufacturer, its catalog and its runs?'), m.name).then(ok => ok && this.api.remove(m.id).subscribe({ next: () => { this.goHome(); this.read(); this.runs.refresh(); }, error: this.failed('Could not delete it.') }));
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
    this.api.create({ url, name: this.addName().trim(), notes: this.addNotes().trim(), route: this.choice() ?? 'default',
                      only: this.addOnly(), follow: this.addOnly() && this.addFollow() }).subscribe({
      next: r => {
        this.starting.set(false);
        this.addUrl.set(''); this.addName.set(''); this.addNotes.set('');
        this.all.update(l => [...l.filter(x => x.id !== r.manufacturer.id), { ...r.manufacturer, products: undefined }]);
        if (r.job) { this.runs.put(r.job); this.showRun(r.job.job_id ?? r.job.id); } else this.openMaker(r.manufacturer.id);
      },
      error: (e: HttpErrorResponse) => { this.starting.set(false); this.addError.set(why(e, 'Could not add it.')); },
    });
  }

  exploreAgain(id: string, route: RouteChoice) {
    if (this.starting()) return;
    this.starting.set(true);
    this.api.explore(id, route).subscribe({
      next: j => { this.starting.set(false); this.runs.put(j); this.showRun(j.id); },
      error: (e: HttpErrorResponse) => { this.starting.set(false); this.say(why(e, 'The exploration could not start.')); },
    });
  }

  /** The model step again on a run's kept pages - after a model failed, or with another model set. */
  readAgain(id: string, run: string) {
    if (this.starting()) return;
    this.starting.set(true);
    this.api.readAgain(id, run).subscribe({
      next: j => { this.starting.set(false); this.runs.put(j); this.showRun(j.id); },
      error: (e: HttpErrorResponse) => { this.starting.set(false); this.say(why(e, 'The pages could not be read again.')); },
    });
  }

  /** Only the page given, read into the catalog (added to it). */
  readPage(m: Maker) {
    const url = this.pageUrl().trim();
    if (!url || this.starting()) return;
    this.starting.set(true);
    this.api.readPage(m.id, [url], this.pageFollow(), this.choice()).subscribe({
      next: j => { this.starting.set(false); this.pageUrl.set(''); this.runs.put(j); this.showRun(j.id); },
      error: (e: HttpErrorResponse) => { this.starting.set(false); this.say(why(e, 'The page could not be read.')); },
    });
  }

  /** The same run again: the site, or the same pages. */
  runAgain(j: MfrJob) {
    const route = j.route_default ? null : j.route;
    if (j.kind !== 'page' || !j.only?.length) { this.exploreAgain(j.manufacturer.id, route); return; }
    if (this.starting()) return;
    this.starting.set(true);
    this.api.readPage(j.manufacturer.id, j.only, !!j.follow, route).subscribe({
      next: r => { this.starting.set(false); this.runs.put(r); this.showRun(r.id); },
      error: (e: HttpErrorResponse) => { this.starting.set(false); this.say(why(e, 'The page could not be read.')); },
    });
  }

  /** A finished run, with the pages it kept: its own, or anyone's with the right to delete. */
  mayDeleteRun(r: MfrJob) {
    return this.can() && !isActive(r) && (this.auth.can('delete') || r.by.id === this.auth.state()?.user?.id);
  }
  deleteRun(r: MfrJob) {
    this.sure(t('Delete this run and the pages it kept?'), `${r.manufacturer.name} · ${when(r.started_at)}`).then(ok => ok && this.api.deleteJob(r.id).subscribe({
      next: () => { this.runs.refresh(); this.read(); },
      error: this.failed('Could not delete it.'),
    }));
  }

  // ---- products by hand

  openProduct(p: Product | null) {
    this.editing.set(p ? p.id : '');
    this.pf.set(p ? { name: p.name, category: p.category, sku: p.sku, description: p.description, url: p.url, image: p.image,
                      specs: Object.entries(p.specs ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n'),
                      price: p.price ? String(Math.round(p.price.amount * 100) / 100) : '', currency: p.price?.currency || 'TRY', vat: p.price?.vat ?? '',
                      stock: p.stock ?? '', stock_qty: p.stock_qty != null ? String(p.stock_qty) : '' } : { ...NO_PRODUCT });
  }
  pfSet(k: keyof ProductFields, e: Event) {
    const v = (e.target as HTMLInputElement).value;
    this.pf.update(f => ({ ...f, [k]: v }));
  }
  saveProduct(m: Maker) {
    const f = this.pf(), id = this.editing();
    if (id === null || !f.name.trim() || this.saving()) return;
    this.saving.set(true);
    const call = id ? this.api.editProduct(m.id, id, f) : this.api.addProduct(m.id, f);
    call.subscribe({
      next: r => {
        this.saving.set(false);
        this.replace(r.manufacturer);
        this.say(this.fmt(id ? '{p} saved' : '{p} added to the catalog', { p: r.product.name }));
        this.editing.set(null);
      },
      error: (e: HttpErrorResponse) => { this.saving.set(false); this.say(why(e, 'Could not save it.')); },
    });
  }
  deleteProducts(m: Maker, ids: string[]) {
    if (!ids.length) return;
    const one = ids.length === 1 ? (m.products ?? []).find(p => p.id === ids[0]) : null;
    this.sure(one ? t('Delete this product?') : this.fmt('Delete {n} products?', { n: ids.length }), one?.name ?? '').then(ok => ok && this.api.deleteProducts(m.id, ids).subscribe({
      next: r => {
        this.replace(r.manufacturer);
        this.picked_.update(s => new Set([...s].filter(x => !ids.includes(x))));
        if (this.editing() && ids.includes(this.editing()!)) this.editing.set(null);
      },
      error: this.failed('Could not delete it.'),
    }));
  }
  pick(id: string, on: boolean) { this.picked_.update(s => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; }); }
  allPicked = computed(() => { const f = this.found(), s = this.picked_(); return f.length > 0 && f.every(p => s.has(p.id)); });
  pickedIds() { return [...this.picked_()]; }
  pickAll(on: boolean) { this.picked_.set(on ? new Set(this.found().map(p => p.id)) : new Set()); }

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
    if (this.job()?.route?.includes('proxy')) parts.push(this.fmt('{n} via proxy', { n: tt.requests_proxy ?? 0 }));
    if (tt.wire_up != null || tt.wire_down != null) parts.push(this.kb((tt.wire_up ?? 0) + (tt.wire_down ?? 0)) + (tt.proxy_cost != null ? ' · ' + this.money(tt.proxy_cost) : ''));
    else if (tt.bytes_proxy) parts.push(this.kb(tt.bytes_proxy));
    if (tt.requests_jina) parts.push(this.fmt('{n} via Jina', { n: tt.requests_jina }));
    return parts.join(' · ');
  });
  trafficTip = computed(() => {
    const tt = this.job()?.totals ?? {};
    return [this.fmt('{n} requests directly, {b}', { n: tt.requests_direct ?? 0, b: this.kb(tt.bytes_direct ?? 0) }),
            this.fmt('{n} requests through the proxy, {b}', { n: tt.requests_proxy ?? 0, b: this.kb(tt.bytes_proxy ?? 0) }),
            tt.wire_up != null ? this.fmt('on the wire to the proxy: {u} up, {d} down', { u: this.kb(tt.wire_up), d: this.kb(tt.wire_down ?? 0) }) : '',
            tt.proxy_since ? this.fmt('through the proxy since {w}, after a refusal', { w: when(tt.proxy_since) }) : '',
            tt.requests_jina ? this.fmt('{n} pages through Jina Reader, {b}, {k} tokens', { n: tt.requests_jina, b: this.kb(tt.bytes_jina ?? 0), k: tt.tokens_jina ?? 0 }) : '',
            tt.jina_since ? this.fmt('through Jina since {w}, after a refusal', { w: when(tt.jina_since) }) : ''].filter(Boolean).join('\n');
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
          detail: s.note ? t(s.note) : this.fmt('{n} files, {m} addresses', { n: s.files ?? 0, m: s.urls ?? 0 }), fig: '', time: live(s) });
      } else if (s.kind === 'crawl') {
        rows.push({ id: s.id, state: s.state, kind: 'Pages', title: this.fmt('{n} pages read', { n: s.read ?? 0 }), reason: s.reason,
          detail: [this.fmt('{n} asked of {m}', { n: s.pages ?? 0, m: s.cap ?? 0 }), s.skipped_robots ? this.fmt('{n} left out by robots.txt', { n: s.skipped_robots }) : '',
                   s.note ? t(s.note) : ''].filter(Boolean).join(' · '),
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
        rows.push(s.catalog != null
          ? { id: s.id, state: 'done', kind: 'Result', title: this.fmt('{n} new products added', { n: s.added ?? 0 }),
              detail: this.fmt('{n} read from the page · {c} in the catalog now', { n: s.products ?? 0, c: s.catalog }), fig: '', time: '' }
          : { id: s.id, state: 'done', kind: 'Result', title: this.fmt('{n} products in the catalog', { n: s.products ?? 0 }),
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
  /** An order of routes as a line: "Local > Proxy". */
  line(order: readonly string[] | null | undefined) { return routeLine(order, t); }
  /** What the next run will do, in a sentence. */
  fetchAbout = computed(() => {
    const c = this.choice(), p = this.proxy();
    const order = c ?? p?.order ?? [];
    const head = c ? this.fmt('Own order: {o}.', { o: this.line(c) }) : this.fmt('Default order: {o}.', { o: this.line(p?.order) });
    const skipped = order.filter(r => p?.ready?.[r]);
    return head + ' ' + t('Each page tries the first route; when the site refuses, cannot be reached or (for a later Jina) sends a page empty without its script, the next.')
      + (skipped.length ? ' ' + this.fmt('Not set up, so passed over: {r}.', { r: this.line(skipped) }) : '');
  });
  proxyStateLine = computed(() => {
    const p = this.proxy();
    if (!p) return '–';
    return p.configured ? 'Proxy set up' : 'Proxy not set up';
  });
  /** A maker's own order (or the default again), kept at once. */
  setMakerRoute(m: Maker, route: RouteChoice) {
    this.choice.set(route);
    this.api.patch(m.id, { route: route ?? 'default' }).subscribe({ next: r => this.replace(r), error: this.failed('Could not save it.') });
  }
  /** Own order, starting from the default one. */
  ownOrder(m: Maker | null) {
    if (this.choice() !== null) return;
    const start = [...(this.proxy()?.order ?? ['local'])];
    if (m) this.setMakerRoute(m, start); else this.choice.set(start);
  }
  useDefault(m: Maker | null) {
    if (this.choice() === null) return;
    if (m) this.setMakerRoute(m, null); else this.choice.set(null);
  }
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
  /** Asked before anything is deleted: the question, and what it is about. */
  private async sure(question: string, what: string): Promise<boolean> {
    return Confirm.ask({ title: question, text: what || undefined, ok: t('Delete'), danger: true });
  }
  private say(msg: string) { this.flash.set(msg); setTimeout(() => this.flash.set(null), 4000); }
  private failed = (fallback: string) => (e: HttpErrorResponse) => this.say(why(e, fallback));

  key(e: KeyboardEvent) {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName);
    if (e.key === 'Escape' && this.menu()) { this.menu.set(null); return; }
    if (e.key === 'Delete' && this.menu() && this.can()) { const p = this.menu()!.p; this.menu.set(null); this.deleteFromDetail(p); return; }
    if (e.key === 'Escape' && this.detail() && !typing) { this.closeDetail(); return; }
    if (e.key === '/' && !typing) { e.preventDefault(); (this.gridSearch() ?? this.search()).nativeElement.focus(); }
  }

  ngOnDestroy() {
    clearInterval(this.poll); this.stopFollowing();
    this.runs.here = false;
    this.picked.mfr.set(null);
  }
}
