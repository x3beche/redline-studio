import { Component, ElementRef, Injectable, OnDestroy, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { Toast, ToastTone } from '../toast';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { NgTemplateOutlet } from '@angular/common';
import { Selection } from '../selection';
import { Auth } from '../auth';
import { Prefs } from '../preferences';
import { LANG, T, t } from '../i18n';
import { money as shownMoney, moneyAlt, moneyIn, moneyTip } from '../money';
import { Confirm } from '../confirm';
import { CatalogStock, InventoryApi, Item, StockPanel, StockState, StockView, qty } from './stock';
import { PARTS_LABEL, STOCK_ASKED } from '../workspaces';
import { RouteOrder, routeLine } from '../route-order';
import { DmSendButton } from '../dm';
import { SelectOption, UiSelect, plainOptions } from '../ui-select';
import { Marquee } from '../marquee';
import { ContextMenu } from '../context-menu';
import { SelectionBar } from '../selection-bar';
import { CountUp } from '../count';
import { Skeleton } from '../skeleton';
import { EmptyState } from '../empty-state';
import { PartAdding, PartDesk, PartModal } from './part-desk';
import { Cabinet, CabinetItem, FootprintThumb } from './cabinet';
import { LINKED, LinkedCard, LinkedDesk, LinkedHead, LinkedItem, LinkedTable, isLinked, measuredBox, mismatchTip } from './linked';
import { ProductFilesPanel, ProductFilesState } from './product-files';

/** Parts ("Parçalar"; the page's name is PARTS_LABEL, workspaces.ts): the
 *  parts the workspace buys and keeps - the makers whose catalogs it keeps,
 *  read from their own websites (backend/manufacturers.py), the built-in
 *  sources (the LCSC drawer, McMaster-Carr, GrabCAD, My Items:
 *  backend/catalog_builtin.py) - and how many of each are on hand: the
 *  stock (stock.ts). Every row, card and bin says its count; a product's
 *  detail has its stock section; "Stock" lists every product on hand.
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
 *  or null for the Parts page's default order (Settings > Proxy & Data). */
export type RouteChoice = string[] | null;
export type MfrStatus = 'queued' | 'crawling' | 'asking' | 'merging' | 'done' | 'failed' | 'cancelled';
export type StepState = 'running' | 'done' | 'skipped' | 'failed' | 'cancelled' | 'pending';
/** A price as the catalog keeps it (backend/catalog_facts.py): `vat` excl when the page said "+ KDV",
 *  `gross` the same price with VAT when the page gave both, `at` when it was read (or typed). */
export interface Price extends ReadMeta { amount: number; currency: string; vat: 'incl' | 'excl' | null; text?: string; at?: string | null; gross?: number }
/** Why a value read may be wrong (backend/catalog_facts.py price_doubts, stock_doubts; manufacturers._hold): its kind `k`
 *  and what it saw - another price (`other`, `n` times it), where (`where`), a currency, the last reading (`was`)... */
export interface Doubt {
  k: string; other?: number; n?: number | null; text?: string; where?: string; cur?: string; was?: number | string | null; pct?: number;
  fixed?: number | string | null; fixed_qty?: number | null; qty?: number; stock?: string; said?: string; out?: string; in?: string;
  /** In a re-read's report: the price's doubt or the stock's. */
  on?: 'price' | 'stock';
}
/** What is kept beside a price (in it) and a stock (`stock_read`): where it was read - the structured data ('ld'), the
 *  microdata, the meta tags, the page's text, the model, a person - and the words around it; its doubts; and a
 *  correction by hand ("Wrong"): who, when, and what the page said then - kept while the page says the same. */
export interface ReadMeta {
  source?: 'ld' | 'micro' | 'meta' | 'text' | 'model' | 'hand'; snippet?: string; doubt?: Doubt[];
  manual?: boolean; by?: { id?: string; name?: string }; manual_at?: string;
  page_was?: { amount?: number | null; currency?: string; vat?: 'incl' | 'excl' | null; stock?: 'in' | 'out' | null; qty?: number | null };
}
type PriceSaid = { amount: number; currency: string; vat: 'incl' | 'excl' | null } | null;
type StockSaid = { stock: 'in' | 'out'; qty: number | null } | null;
/** A product "Re-read all products" has something to say of: its price and stock before and after, new doubts,
 *  corrections kept, or why its page was not read. */
export interface CheckRow {
  maker: { id: string; name: string }; id: string; name: string; url: string;
  price?: [PriceSaid, PriceSaid]; stock?: [StockSaid, StockSaid]; doubt?: Doubt[]; held?: ('price' | 'stock')[]; error?: string;
}
/** One run of "Re-read all products" (backend/manufacturers.py recheck): `dry` only compared, nothing saved. */
export interface CatalogCheck {
  id: string; status: 'running' | 'done' | 'failed' | 'cancelled'; dry: boolean; by: { name?: string };
  started_at: string; finished_at: string | null; done: number; total: number | null; current: string | null;
  counts: Partial<Record<'products' | 'pages' | 'read' | 'failed' | 'not_product' | 'price' | 'stock' | 'doubt' | 'held' | 'saved' | 'busy', number>>;
  rows: CheckRow[]; error?: string | null;
}
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
  /** Where the stock was read, its doubts, a correction by hand. */
  stock_read?: ReadMeta;
  /** The site it is sold on (its page's), and when: added to the catalog, last read from its page, the seller's own date. */
  seller?: { domain: string; host?: string; name?: string };
  added_at?: string; read_at?: string; updated?: string; history?: PriceRow[];
  /** Added by hand ('manual'), or changed by hand (`edited`): kept through a full exploration. */
  source?: 'manual'; edited?: boolean;
  /** An LCSC part of the parts drawer (the LCSC seller, backend/catalog_lcsc.py): what only a part has. */
  part?: PartFacts;
  /** A part or model saved from McMaster-Carr or GrabCAD (backend/linked.py, linked.ts). */
  linked?: LinkedItem;
}
export interface PartFacts {
  lcsc: string; value: string | null; mpn: string | null; maker: string | null; package: string | null;
  group: string | null; branch: string | null; has_3d: boolean; pins: number | null; jlc_class: string | null; min: number | null;
}
/** The LCSC seller's id: the parts drawer, not a manufacturer kept in the catalog. */
export const LCSC_MAKER = 'lcsc';
/** A product with its maker, as the catalog's grid lists them (GET /api/manufacturers/products). */
export interface GridItem extends Product { maker: { id: string; name: string; domain: string } }
export interface GridAnswer {
  items: GridItem[]; total: number; page: number; size: number; all: number;
  categories: [string, number][]; makers: { id: string; name: string; domain: string; count: number }[];
  sellers: [string, number][]; price: { min: number | null; max: number | null; currencies: string[] };
  /** How many of every product were read with a doubt on their price or stock ("Needs checking"). */
  doubtful?: number;
}
export interface GridQuery { q: string; cat: string; maker: string; seller: string; min: string; max: string; stock: string; sort: string; size: number; check: string; held: string }
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
  /** A built-in source (backend/catalog_builtin.py): every workspace has it, read by the system -
   *  nothing to explore, rename or delete; `view` says how its products show ('drawer': the parts drawer;
   *  'linked': McMaster-Carr or GrabCAD, found through a web search - linked.ts). */
  builtin?: boolean; view?: string;
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
  /** "Wrong": the right price or stock, kept by hand; the page is kept as a test case (`case`, on the server). */
  correct(id: string, pid: string, b: { what: 'price' | 'stock'; amount?: string; currency?: string; vat?: string; stock?: string; qty?: string }) {
    return this.http.post<{ product: Product; manufacturer: Maker; case: string | null }>(`/api/manufacturers/${id}/products/${pid}/correct`, b);
  }
  /** "Re-read all products": start one (`dry`: only compare), the latest with its report, stop one. */
  recheck(dry: boolean) { return this.http.post<{ check: CatalogCheck; started: boolean }>('/api/manufacturers/recheck', { dry }); }
  lastCheck() { return this.http.get<{ check: CatalogCheck | null }>('/api/manufacturers/recheck'); }
  cancelCheck(id: string) { return this.http.post<{ check: CatalogCheck }>(`/api/manufacturers/recheck/${id}/cancel`, {}); }
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

/** How a page shows its products: the drawer's cabinet, cards, or rows. */
type Layout = 'drawer' | 'grid' | 'table';

/** A value as a number to sort by: 4.7kΩ, 100nF, 2.2uH, 11.0592MHz. */
function magnitude(v: string | null | undefined): number {
  const m = /([\d.]+)\s*([pnuµμmkKMG]?)/.exec(v || '');
  if (!m) return Number.MAX_VALUE;
  const scale: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, 'μ': 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9 };
  return parseFloat(m[1]) * (scale[m[2]] ?? 1);
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
  drawer: 'M4 4h16v16H4z M4 12h16 M10 8h4 M10 16h4',
  cube: 'M12 3l8 4.5v9L12 21l-8-4.5v-9z M4 7.5l8 4.5 8-4.5 M12 12v9',
  maker: 'M3 20V10l5 3V10l5 3V6h3l1 4h1l1-6h2v16z',
};
const NO_PRODUCT: ProductFields = { name: '', category: '', sku: '', description: '', specs: '', url: '', image: '',
                                    price: '', currency: 'TRY', vat: '', stock: '', stock_qty: '' };
export const CURRENCIES = ['TRY', 'USD', 'EUR', 'GBP', 'CNY'];

@Component({
  selector: 'app-room-mfr',
  imports: [EmptyState, Skeleton, CountUp, T, NgTemplateOutlet, RouteOrder, DmSendButton, UiSelect, Marquee, SelectionBar,
            PartModal, PartAdding, Cabinet, FootprintThumb, LinkedHead, LinkedCard, LinkedTable, StockPanel, StockView, ProductFilesPanel],
  providers: [PartDesk, LinkedDesk],
  styleUrls: ['../settings.css', './taste.css', './manufacturers.css', './stock.css'],
  host: { '(document:keydown)': 'key($event)' },
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
            <span class="tcv-notes-item-when">{{ fmt('{n} makers · {m} products', { n: own().length, m: totalProducts() }) }}</span>
          </span>
        </button>
      }
      <!-- The built-in sources (backend/catalog_builtin.py) on top, the workspace's own sites below;
           a row is its name, domain and count - a run going shows only as a dot -->
      @for (grp of sideGroups(); track grp.name) {
        <span class="mf-side-group">{{ grp.name | t }}</span>
        @for (m of grp.makers; track m.id) {
          <button class="tcv-notes-item" [attr.data-on]="m.id === mid() && view() !== 'home' ? 1 : null" (click)="openMaker(m.id)">
            <span class="tcv-notes-item-top">
              <span class="tcv-notes-item-title">{{ m.name }}@if (runOf(m); as r) { @if (isActiveS(r.status)) {
                <i class="mf-pulse mf-side-dot" [title]="statusName(r.status) | t"></i> } }</span>
              <span class="tcv-notes-item-when">{{ m.product_count }} {{ (m.view === 'drawer' || m.id === 'mcmaster' ? (m.product_count === 1 ? 'part' : 'parts') : m.id === 'grabcad' ? (m.product_count === 1 ? 'model' : 'models') : m.product_count === 1 ? 'product' : 'products') | t }}</span>
            </span>
            <span class="tcv-notes-item-meta mf-side-meta"><span class="mf-dom">{{ m.domain }}</span></span>
          </button>
        }
      }
      @if (!shown().length) {
        @if (listed()) { <wb-empty compact [icon]="listQ() ? 'search' : 'list'" [text]="listQ() ? 'Nothing matches.' : 'No manufacturers yet.'" /> }
        @else { <wb-skel kind="rows" [count]="5" [h]="52" /> }
      }
    </div>
  </aside>

  <section class="tcv-notes-main tst mf" wbMarquee [marqueeOn]="layout() !== 'table' && (view() === 'maker' || (view() === 'home' && sub() === 'products'))"
           [marqueeBase]="gsel()" (wbMarquee)="gsel.set($event)">

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
            <b [wbCount]="j.totals.products ?? (j.products_found ?? '–')"></b><small>{{ j.totals.duplicates ? fmt('{n} duplicates merged', { n: j.totals.duplicates }) : (j.totals.chunks ? fmt('{n} chunks for the model', { n: j.totals.chunks }) : t('after the pages are read')) }}</small></div>
          <div class="st-tile tsx-model"><span>{{ 'Model' | t }}</span><b [title]="j.model || ''">{{ j.model || '–' }}</b><small>{{ j.provider_name || j.provider || '' }}</small></div>
          <div class="st-tile" [attr.data-tone]="j.totals.tokens_in == null ? 'dim' : null"><span>{{ 'Tokens in / out' | t }}</span>
            <b [wbCount]="j.totals.tokens_in == null ? '–' : num(j.totals.tokens_in) + ' / ' + num(j.totals.tokens_out ?? 0)"></b>
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
      } @else { <div class="wb-sk-stack"><wb-skel kind="tiles" [count]="8" [min]="110" /><wb-skel kind="rows" [count]="10" /></div> }

    } @else if (view() === 'maker' && maker(); as m) {
      <!-- ================= one manufacturer ================= -->
      @if (m.view === 'drawer') {
        <!-- LCSC: the parts drawer as a seller (backend/catalog_lcsc.py) - its own head, then the catalog below as any maker's -->
        <ng-container *ngTemplateOutlet="lcscHead; context: { $implicit: m }" />
      } @else if (m.view === 'linked') {
        <!-- McMaster-Carr, GrabCAD: the search front and centre (linked.ts), the saved ones below as any maker's catalog -->
        <wb-linked-head [src]="m.id" [url]="m.url" [items]="m.products ?? []" />
      } @else if (m.view === 'own') {
        <!-- My Items (backend/catalog_own.py): things no site sells, typed in by hand - a head of a line, the catalog below -->
        <header class="tst-head">
          <div class="tst-title">
            <h2>{{ m.name | t }}</h2>
            <span class="st-sub">{{ m.summary | t }} · {{ fmt('{n} products · {s} in stock', { n: m.product_count, s: heldCount(m.id) }) }}</span>
          </div>
        </header>
      } @else {
      <header class="tst-head">
        <div class="tst-title">
          <input class="tst-name" [value]="m.name" [readonly]="!can() || m.builtin" (change)="rename(m, $any($event.target).value)"
                 (keydown.enter)="$any($event.target).blur()" [attr.aria-label]="'Name' | t">
          <span class="st-sub"><a class="mf-link" [href]="m.url" target="_blank" rel="noopener noreferrer">{{ m.url }}</a>
            · {{ fmt('added by {p} {w}', { p: m.by.name || t('someone'), w: when(m.created_at) }) }}</span>
        </div>
        <div class="tst-acts">
          @if (can() && !m.builtin) {
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
      @if (can() && !m.builtin) {
        @if (choice() !== null) {
          <div class="mf-route"><span class="st-sub">{{ 'Own order' | t }}</span>
            <app-route-order [routes]="proxy()?.routes ?? []" [order]="choice() ?? []" [ready]="proxy()?.ready ?? {}"
                             (changed)="setMakerRoute(m, $event)" /></div>
        }
        <p class="st-hint mf-proxyhint">{{ fetchAbout() }} <button class="st-more" (click)="toProxy()">{{ 'Settings > Proxy & Data' | t }}</button></p>
      }

      <div class="st-tiles mf-mtiles">
        <div class="st-tile" [attr.data-tone]="m.product_count ? null : 'dim'"><span>{{ 'Products' | t }}</span><b [wbCount]="m.product_count"></b>
          <small>{{ fmt('{n} with specs · {c} with a code', { n: makerStats().specs, c: makerStats().sku }) }}</small></div>
        <div class="st-tile" [attr.data-tone]="m.categories.length ? null : 'dim'"><span>{{ 'Categories' | t }}</span><b [wbCount]="m.categories.length"></b>
          <small [title]="m.categories.join(', ')">{{ m.categories.slice(0, 3).join(', ') || '–' }}</small></div>
        <div class="st-tile" [attr.data-tone]="m.explored_at ? null : 'dim'"><span>{{ 'Explored' | t }}</span><b>{{ when(m.explored_at) }}</b>
          <small>{{ m.domain }}</small></div>
        @if (runOf(m); as r) {
          <button class="st-tile mf-tilebtn" [attr.data-tone]="statusTone(r.status)" (click)="showRun(r.id)"><span>{{ 'Last run' | t }}</span>
            <b>{{ statusName(r.status) | t }}</b><small [title]="r.error || ''">{{ r.error || fmt('{n} pages · {w}', { n: r.pages, w: when(r.started_at) }) }}</small></button>
        } @else {
          <div class="st-tile" data-tone="dim"><span>{{ 'Last run' | t }}</span><b>–</b><small>{{ 'never explored' | t }}</small></div>
        }
        <div class="st-tile" [attr.data-tone]="m.docs.length ? null : 'dim'"><span>{{ 'Documents' | t }}</span><b [wbCount]="m.docs.length"></b>
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
          <textarea class="tst-desc mf-notes" rows="2" [value]="m.notes" [readonly]="!can() || m.builtin"
                    [placeholder]="can() ? ('e.g. use them for injection mold parts; ask for the 2024 price list' | t) : ''"
                    (change)="saveNotes(m, $any($event.target).value)"></textarea>
          @if (m.docs.length) {
            <span class="mf-label">{{ 'Documents on the site' | t }}</span>
            <div class="mf-docs">@for (d of m.docs.slice(0, 12); track d.url) { <a class="mf-link" [href]="d.url" target="_blank" rel="noopener noreferrer" [title]="d.url">{{ d.label || path(d.url) }}</a> }</div>
          }
        </div>
      </div>

      @if (can() && !m.builtin) {
        <section class="st-card mf-pageadd">
          <div class="mf-addrow mf-ctl">
            <span class="mf-label mf-rowlabel" [title]="pageHint | t">{{ 'Add from a page' | t }}</span>
            <input class="tst-in" [placeholder]="'https://… a product page, or a list of products' | t" [value]="pageUrl()"
                   (input)="pageUrl.set($any($event.target).value)" (keydown.enter)="readPage(m)" [attr.aria-label]="'Page address' | t" [title]="pageHint | t">
            <span class="st-sub mf-pagenote">{{ 'only that page; what is in the catalog stays' | t }}</span>
            <button type="button" class="mf-check" role="switch" [attr.aria-checked]="pageFollow()" [title]="'Same site, one link deep, at most 30 pages' | t"
                    (click)="pageFollow.set(!pageFollow())"><span class="tcv-switch" [attr.data-on]="pageFollow() ? 1 : null" aria-hidden="true"></span>{{ 'also the product pages it links to' | t }}</button>
            <button class="tcv-btn tcv-btn-accent" (click)="readPage(m)" [disabled]="!pageUrl().trim() || starting() || (runOf(m) && isActiveS(runOf(m)!.status))">{{ 'Read it' | t }}</button>
          </div>
        </section>
      }

      }

      <section class="st-card mf-catalog">
        <div class="st-card-head mf-cathead"><h3>{{ 'Catalog' | t }}</h3>
          <input class="tst-in mf-find" [placeholder]="'Find a product: name, code, size, material' | t" [value]="pq()"
                 (input)="pq.set($any($event.target).value)" (keydown.escape)="pq.set('')">
          <wb-select class="mf-csel" label="Category" [options]="productCatOpts()" [value]="cat()" (pick)="cat.set($event)" />
          <span class="st-right st-sub">{{ fmt('{n} of {m}', { n: found().length, m: m.products?.length ?? 0 }) }}</span>
          <ng-container *ngTemplateOutlet="layoutT" />
          @if (can() && (!m.builtin || m.view === 'own')) { <button class="tcv-btn" (click)="openProduct(null)" [disabled]="editing() === ''">{{ 'Add a product' | t }}</button> }</div>
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
              <wb-select label="Currency" [options]="curOpts" [value]="pf().currency" (pick)="pfPick('currency', $event)" />
              <wb-select label="VAT" [options]="vatOpts()" [value]="pf().vat" (pick)="pfPick('vat', $event)" />
              <wb-select label="Stock on the site" [options]="pfStockOpts()" [value]="pf().stock" (pick)="pfPick('stock', $event)" />
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
        @if (cabinetOn() && m.products?.length) {
          <!-- The drawer's look (cabinet.ts): an LCSC part's groups and branches, a site's categories;
               the catalog's search and category narrow it, a box drawn or Ctrl-clicks select -->
          <div class="mf-cabinet">
            <wb-cabinet [items]="makerItems()" [order]="m.view === 'drawer' ? partOrder : []" [storeKey]="'m:' + m.id"
                        [label]="m.view === 'drawer' ? 'in the drawer' : m.view === 'linked' ? 'saved' : 'products'" [selected]="gsel()"
                        [seen]="desk.seen() ? LCSC_MAKER + ':' + desk.seen()!.lcsc : null" [pulse]="desk.pulse() ? LCSC_MAKER + ':' + desk.pulse() : null"
                        (open)="cabOpen($event)" (pick)="togglePick($event)" (menu)="cabMenu($event)" (remove)="cabRemove($event)" />
            @if (!makerItems().length) { <wb-empty compact icon="search" text="Nothing matches." /> }
          </div>
        } @else if (m.products?.length && layout() === 'grid') {
          <div class="mf-grid" [attr.data-cols]="cols() || null" [style.--cols]="cols() || null"
              >
            @for (p of found().slice(0, shownRows()); track p.id) { <ng-container *ngTemplateOutlet="cardT; context: { $implicit: asItem(p, m) }" /> }
            @empty { <wb-empty compact icon="search" text="Nothing matches." /> }
          </div>
          @if (found().length > shownRows()) {
            <button class="st-more mf-morerows" (click)="rows.set(rows() + 200)">{{ fmt('Show {n} more', { n: found().length - shownRows() }) }}</button>
          }
        } @else if (m.products?.length && m.view === 'drawer') {
          <ng-container *ngTemplateOutlet="partsTable; context: { $implicit: m }" />
        } @else if (m.products?.length && m.view === 'linked') {
          <wb-linked-table [src]="m.id" [items]="linkedFound()" />
        } @else if (m.products?.length) {
          <div class="st-table-wrap">
            <table class="st-table mf-table">
              <thead><tr>@if (can()) { <th class="mf-selcol"><input type="checkbox" class="tcv-check" [checked]="allPicked()" (change)="pickAll($any($event.target).checked)" [attr.aria-label]="'Select all' | t"></th> }
                <th class="mf-pname">{{ 'Product' | t }}</th><th class="mf-ponhand r">{{ 'On hand' | t }}</th><th class="mf-pcode">{{ 'Code' | t }}</th><th class="mf-pprice r">{{ 'Price' | t }}</th><th class="mf-pcat">{{ 'Category' | t }}</th><th class="mf-specs">{{ 'Specs' | t }}</th><th class="mf-desc">{{ 'Description' | t }}</th><th class="mf-actcell"></th></tr></thead>
              <tbody>
                @for (p of found().slice(0, shownRows()); track p.id) {
                  <tr class="mf-prow" [attr.data-sel]="picked_().has(p.id) ? 1 : null">
                    @if (can()) { <td class="mf-selcol"><input type="checkbox" class="tcv-check" [checked]="picked_().has(p.id)" (change)="pick(p.id, $any($event.target).checked)" [attr.aria-label]="p.name"></td> }
                    <td class="mf-pname" [title]="p.name"><button class="mf-namebtn" (click)="openDetail(asItem(p, m))">{{ p.name }}</button><ng-container *ngTemplateOutlet="filesT; context: { $implicit: p, mid: m.id }" />@if (p.source === 'manual') { <span class="st-tag mf-hand">{{ 'by hand' | t }}</span> } @else if (p.edited) { <span class="st-tag mf-hand">{{ 'edited' | t }}</span> }</td>
                    <td class="r mf-ponhand">@if (onHand(m.id, p.id); as s) { <button class="mf-onhand mf-onhand-btn" [attr.data-low]="s.low ? 1 : null" [attr.data-out]="s.quantity <= 0 ? 1 : null" (click)="openDetail(asItem(p, m))" [title]="'On hand - open it for its stock' | t">{{ qty(s.quantity) }} {{ s.unit }}</button> } @else { <span class="dim">–</span> }</td>
                    <td class="mono mf-pcode" [title]="p.sku">{{ p.sku || '–' }}</td>
                    <td class="r mf-pprice" [title]="p.price ? (moneyTip(p.price.amount, p.price.currency) || p.price.text || '') : ''">@if (p.price) { <b>{{ moneyIn(p.price.amount, p.price.currency) }}</b>@if (p.price.vat === 'excl') { <small class="dim"> {{ '+VAT' | t }}</small> } } @else { <span class="dim">–</span> }
                      @if (p.stock) { <br><span class="mf-sdot" [attr.data-s]="p.stock">{{ stockName(p) }}</span> }<ng-container *ngTemplateOutlet="doubtT; context: { $implicit: p }" /></td>
                    <td class="dim mf-pcat" [title]="p.category">{{ p.category || '–' }}</td>
                    <td class="mf-specs" [title]="specLine(p)">@for (s of specs(p); track s[0]) { <span class="mf-spec"><em>{{ s[0] }}</em> {{ s[1] }}</span> }@if (!specs(p).length) { <span class="dim">–</span> }</td>
                    <td class="mf-desc dim" [title]="p.description">{{ p.description || '–' }}</td>
                    <td class="r mf-actcell">@if (p.url) { <a class="st-more mf-open" [href]="p.url" target="_blank" rel="noopener noreferrer">{{ 'Page' | t }}</a> }
                      @if (p.image) { <a class="st-more mf-open" [href]="p.image" target="_blank" rel="noopener noreferrer">{{ 'Image' | t }}</a> }
                      @if (can()) {
                        <div class="tcv-cc-itemacts mf-rowacts">
                          <button class="tcv-cc-ib" (click)="openDetail(asItem(p, m))" [title]="'Stock: count it, take some, see its log' | t">
                            <svg class="tcv-cc-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.stock" /></svg></button>
                          <button class="tcv-cc-ib" (click)="openProduct(p)" [title]="'Edit the product' | t">
                            <svg class="tcv-cc-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.edit" /></svg></button>
                          <button class="tcv-cc-ib tcv-cc-danger" (click)="deleteProducts(m, [p.id])" [title]="'Delete the product' | t">
                            <svg class="tcv-cc-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.trash" /></svg></button>
                        </div>
                      }</td>
                  </tr>
                } @empty { <tr><td [attr.colspan]="can() ? 9 : 8" class="dim">{{ 'Nothing matches.' | t }}</td></tr> }
              </tbody>
            </table>
          </div>
          @if (found().length > shownRows()) {
            <button class="st-more mf-morerows" (click)="rows.set(rows() + 200)">{{ fmt('Show {n} more', { n: found().length - shownRows() }) }}</button>
          }
        } @else {
          <wb-empty icon="table" [text]="m.view === 'own' ? 'Nothing here yet: add a thing no site sells - filament, your own screws, a cable you made - with Add a product, or from Stock.' : m.view === 'linked' ? linkedEmpty(m.id) : m.view === 'drawer' ? 'The drawer is empty: add a part by its LCSC number above.' : runOf(m) && isActiveS(runOf(m)!.status) ? 'The site is being explored; the catalog fills in when the run is done.' : 'No products yet: explore the site, read one page, or add a product by hand.'" />
        }
      </section>

    } @else {
      <!-- ================= the overview: every product as a grid, or the sites and adding one ================= -->
      <header class="tst-head tsh-head mf-homehead">
        <div class="tst-title">
          <h2>{{ PARTS_LABEL | t }}</h2>
          <span class="st-sub">{{ fmt('{n} products from {m} sites · {s} products in stock. Chat looks here when you need a part.', { n: num(totalProducts()), m: own().length, s: heldTotal() }) }}</span>
        </div>
        <div class="tst-acts">
          <div class="st-seg" role="tablist" [attr.aria-label]="PARTS_LABEL | t">
            <button [class.on]="sub() === 'products'" (click)="sub.set('products')">{{ 'All products' | t }}</button>
            <button [class.on]="sub() === 'stock'" (click)="sub.set('stock')" [title]="'Every product on hand, from every source, in one list' | t">{{ fmt('Stock ({n})', { n: heldTotal() }) }}</button>
            <button [class.on]="sub() === 'sites'" (click)="sub.set('sites')">{{ fmt('Sites ({n})', { n: own().length }) }}</button>
          </div>
          @if (can()) {
            <button class="tcv-btn" (click)="openCheck()" [title]="'Read every saved product page again and see what changed' | t">{{ 'Re-read all products' | t }}</button>
            <button class="tcv-btn" (click)="goAdd()">{{ 'Add a site or a page' | t }}</button>
          }
        </div>
      </header>
      @if (sub() === 'products') {
        <div class="mf-gbar mf-ctl">
          <input #gridSearch class="tst-in mf-gfind" type="search" [placeholder]="'Search every product: name, code, size, material, seller' | t" [value]="pq()"
                 (input)="pq.set($any($event.target).value); gpages.set(1)" (keydown.escape)="pq.set('')" [attr.aria-label]="'Search products' | t">
          <wb-select class="mf-gsel" label="Category" [options]="catOpts()" [value]="cat()" (pick)="cat.set($event); gpages.set(1)" />
          <wb-select class="mf-gsel" label="Maker" [options]="makerOpts()" [value]="gmaker()" (pick)="gmaker.set($event); gpages.set(1)" />
          <wb-select class="mf-gsel" label="Seller" [options]="sellerOpts()" [value]="gseller()" (pick)="gseller.set($event); gpages.set(1)" />
          <span class="mf-range">
            <input class="tst-in" inputmode="decimal" [placeholder]="'Min price' | t" [value]="gmin()" (change)="gmin.set($any($event.target).value.trim()); gpages.set(1)" [attr.aria-label]="'Min price' | t">
            <span class="dim">–</span>
            <input class="tst-in" inputmode="decimal" [placeholder]="'Max price' | t" [value]="gmax()" (change)="gmax.set($any($event.target).value.trim()); gpages.set(1)" [attr.aria-label]="'Max price' | t">
          </span>
          <wb-select class="mf-gsel mf-gheld" label="On hand" [options]="heldOpts()" [value]="gheld()" (pick)="gheld.set($any($event)); gpages.set(1)"
                     [title]="'In stock: what is on hand here, from every source; Low stock: at or below its minimum' | t" />
          <button type="button" class="mf-stocktog" role="switch" [attr.aria-checked]="gstock()" (click)="gstock.set(!gstock()); gpages.set(1)"
                  [title]="'Only what its seller\\'s page says is in stock' | t">
            <span class="tcv-switch" [attr.data-on]="gstock() ? 1 : null" aria-hidden="true"></span>{{ 'Seller has it' | t }}</button>
          @if (grid()?.doubtful || gcheck()) {
            <button type="button" class="mf-stocktog" role="switch" [attr.aria-checked]="gcheck()" (click)="gcheck.set(!gcheck()); gpages.set(1)"
                    [title]="'Products whose price or stock was read with a doubt on it' | t">
              <span class="tcv-switch" [attr.data-on]="gcheck() ? 1 : null" aria-hidden="true"></span>{{ fmt('Needs checking ({n})', { n: grid()?.doubtful ?? 0 }) }}</button>
          }
          <wb-select class="mf-gsel mf-gsort" label="Sort" [options]="sortOpts()" [value]="gsort()" (pick)="gsort.set($event)" />
          @if (filtered()) { <button class="tcv-btn" (click)="clearFilters()">{{ 'Clear' | t }}</button> }
          <span class="st-right st-sub mf-gcount">{{ grid() ? fmt('{n} of {m}', { n: num(grid()!.total), m: num(grid()!.all) }) : '' }}</span>
          <ng-container *ngTemplateOutlet="layoutT" />
        </div>
        @if (grid(); as g) {
          @if (layout() === 'drawer') {
            <div class="mf-cabinet mf-cabinet-home">
              <wb-cabinet [items]="homeItems()" storeKey="home" label="products" [selected]="gsel()"
                          (open)="cabOpen($event)" (pick)="togglePick($event)" (menu)="cabMenu($event)" />
            </div>
          } @else if (layout() === 'grid') {
            <div class="mf-grid" [attr.data-cols]="cols() || null" [style.--cols]="cols() || null"
                >
              @for (p of g.items; track p.maker.id + p.id) { <ng-container *ngTemplateOutlet="cardT; context: { $implicit: p }" /> }
            </div>
          } @else {
            <div class="st-table-wrap mf-gtable-wrap">
              <table class="st-table mf-gtable">
                <thead><tr><th class="mf-gthumb"></th><th>{{ 'Product' | t }}</th><th class="r">{{ 'On hand' | t }}</th><th>{{ 'Seller' | t }}</th><th class="r">{{ 'Price' | t }}</th>
                  <th>{{ 'At the seller' | t }}</th><th>{{ 'Category' | t }}</th><th>{{ 'Code' | t }}</th><th class="r">{{ 'Read' | t }}</th></tr></thead>
                <tbody>
                  @for (p of g.items; track p.maker.id + p.id) {
                    <tr class="mf-prow" (click)="openDetail(p)" (contextmenu)="openMenu($event, p)">
                      <td class="mf-gthumb">@if (img(p); as src) { <img [src]="src" loading="lazy" referrerpolicy="no-referrer" alt="" (error)="broke(src)"> } @else { <span class="mf-thumb0"></span> }</td>
                      <td class="give"><b>{{ p.name }}</b><ng-container *ngTemplateOutlet="filesT; context: { $implicit: p, mid: p.maker.id }" /></td>
                      <td class="r"><ng-container *ngTemplateOutlet="onHandT; context: { $implicit: p }" /></td>
                      <td class="dim">{{ sellerName(p) }}</td>
                      <td class="r" [title]="p.price ? moneyTip(p.price.amount, p.price.currency) : ''"><ng-container *ngTemplateOutlet="doubtT; context: { $implicit: p }" />@if (p.price) { <b>{{ moneyIn(p.price.amount, p.price.currency) }}</b>@if (p.price.vat === 'excl') { <small class="dim"> {{ '+VAT' | t }}</small> } } @else { <span class="dim">–</span> }</td>
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
            <wb-empty [icon]="g.all ? 'search' : 'table'" [text]="gheld() && !filteredButHeld() ? (gheld() === 'low' ? 'Nothing is low: every product on hand is above its minimum.' : 'Nothing is in stock yet: open a product and count it in its Stock section.') : g.all ? 'No product matches - try fewer words or clear the filters.' : 'No products yet: add a site, or read a product page into the catalog.'">
              @if (!g.all && can()) { <button class="tcv-btn" (click)="goAdd()">{{ 'Add a site or a page' | t }}</button> }</wb-empty>
          }
          @if (g.total > g.items.length) {
            <button class="st-more mf-morerows" (click)="gpages.set(gpages() + 1)">{{ fmt('Show {n} more', { n: g.total - g.items.length }) }}</button>
          }
        } @else if (layout() === 'grid') { <wb-skel kind="cards" [count]="15" [min]="220" /> } @else { <wb-skel kind="rows" [count]="12" [h]="44" /> }
      } @else if (sub() === 'stock') {
        <!-- every product on hand, from every source, in one list (stock.ts); a line opens its product -->
        <wb-stock-view (open)="openLine($event)" />
      } @else {
      <div class="st-tiles mf-htiles">
        <div class="st-tile" [attr.data-tone]="own().length ? null : 'dim'"><span>{{ 'Manufacturers' | t }}</span><b [wbCount]="own().length"></b>
          <small>{{ fmt('{n} explored', { n: exploredCount() }) }}</small></div>
        <div class="st-tile" [attr.data-tone]="totalProducts() ? null : 'dim'"><span>{{ 'Products' | t }}</span><b [wbCount]="num(totalProducts())"></b>
          <small>{{ fmt('in {n} categories', { n: totalCats() }) }}</small></div>
        <div class="st-tile" [attr.data-tone]="runs.running() ? 'accent' : 'dim'"><span>{{ 'Running' | t }}</span><b [wbCount]="runs.running()"></b>
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
                <button type="button" class="mf-check" role="switch" [attr.aria-checked]="addFollow()" [title]="'Same site, one link deep, at most 30 pages' | t"
                        (click)="addFollow.set(!addFollow())"><span class="tcv-switch" [attr.data-on]="addFollow() ? 1 : null" aria-hidden="true"></span>{{ 'also the product pages it links to' | t }}</button>
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

      @if (own().length) {
        <section class="st-card">
          <div class="st-card-head"><h3>{{ 'Manufacturers' | t }}</h3>
            <span class="st-sub">{{ 'open one for its catalog, its notes and its runs' | t }}</span></div>
          <div class="st-table-wrap">
            <table class="st-table mf-mtable">
              <thead><tr><th>{{ 'Manufacturer' | t }}</th><th>{{ 'Site' | t }}</th><th class="r">{{ 'Products' | t }}</th><th>{{ 'Categories' | t }}</th>
                <th>{{ 'Notes' | t }}</th><th>{{ 'Last run' | t }}</th><th>{{ 'Fetching' | t }}</th><th class="r">{{ 'Explored' | t }}</th></tr></thead>
              <tbody>
                @for (m of own(); track m.id) {
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

      @if (!own().length) {
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
    <!-- the selection, floating over the grid: the grid's (a box drawn, Ctrl/Shift-clicks) or the maker table's ticks -->
    <wb-selbar [count]="layout() !== 'table' ? gsel().size : 0" (clear)="clearSel()">
      <button class="tcv-btn" (click)="selectAllShown()">{{ 'Select all' | t }}</button>
      @if (gselParts().length) {
        <!-- LCSC parts: as a list to send or order from, and their numbers -->
        <button class="tcv-btn" (click)="exportParts(gselParts())" [title]="'Save the selected parts as a CSV file' | t">{{ 'Export CSV' | t }}</button>
        <button class="tcv-btn" (click)="copyNumbers(gselParts())">{{ 'Copy LCSC numbers' | t }}</button>
      }
      @if (can()) { <button class="tcv-btn tst-del" (click)="deleteSelected()" [disabled]="saving()">{{ (gselParts().length === gsel().size ? 'Remove from the drawer' : 'Delete') | t }}</button> }
    </wb-selbar>
    @if (view() === 'maker' && maker(); as m) {
      <wb-selbar [count]="layout() === 'table' ? picked_().size : 0" (clear)="pickAll(false)">
        @if (m.view === 'drawer') {
          <button class="tcv-btn" (click)="exportParts(pickedIds())" [title]="'Save the selected parts as a CSV file' | t">{{ 'Export CSV' | t }}</button>
          <button class="tcv-btn" (click)="copyNumbers(pickedIds())">{{ 'Copy LCSC numbers' | t }}</button>
          @if (desk.canEdit()) { <button class="tcv-btn tst-del" (click)="dropParts(pickedIds())">{{ 'Remove from the drawer' | t }}</button> }
        } @else {
          @if (can()) { <button class="tcv-btn" (click)="openStock('*')">{{ 'Add selected to stock' | t }}</button> }
          <button class="tcv-btn tst-del" (click)="deleteProducts(m, pickedIds())">{{ 'Delete' | t }}</button>
        }
      </wb-selbar>
    }
  </section>
  <!-- an LCSC part, in full: the drawer's part card (part-card.ts) in the detail box (part-desk.ts) -->
  <app-part-modal [canRun]="canRun()" />
  <!-- a McMaster-Carr part or a GrabCAD model, in full: its page, its CAD files, the drop zone (linked.ts) -->
  <wb-linked-card />
  <!-- ================= one product, in full: over the whole page, so outside the
     section (its container-type would hold a fixed box to the middle column) ================= -->
  @if (detail(); as d) {
    <div class="mf-modal tcv-m-veil" animate.leave="tcv-leave" (click)="closeDetail()">
      <div class="mf-pd tcv-m-box" role="dialog" aria-modal="true" [attr.aria-label]="d.name" (click)="$event.stopPropagation()"
           (keydown.escape)="src() ? src.set(false) : closeDetail()">
        <!-- the LCSC part card's head (part-card.ts): what it is in one line, its buttons, its figures -->
        <header class="mf-pd-head">
          <div class="mf-pd-top">
            <div class="mf-pd-id">
              <div class="mf-pd-title"><b class="mf-pd-name" [title]="d.name">{{ d.name }}</b>
                @if (pfiles.model(d.maker.id, d.id); as h) { <i class="pdw-badge pdw-badge-3d mf-pd-3d" [title]="pfiles.tip(h)">3D</i> }</div>
              <div class="mf-pd-line">
                <span class="mf-pd-seller"><img class="mf-fav" [src]="fav(d)" alt="" referrerpolicy="no-referrer" (error)="$any($event.target).style.visibility = 'hidden'">{{ sellerName(d) }}</span>
                @if (d.maker.name && d.maker.domain !== d.seller?.domain) { <i class="mf-pd-sep"></i><span>{{ d.maker.name }}</span> }
                @if (d.sku) { <i class="mf-pd-sep"></i><span class="mono mf-pd-copy" [title]="'Copy' | t" (click)="copyText(d.sku)">{{ d.sku }}</span> }
                @if (d.category) { <i class="mf-pd-sep"></i><span>{{ d.category }}</span> }
                @if (d.source === 'manual') { <i class="mf-pd-sep"></i><span>{{ 'by hand' | t }}</span> } @else if (d.edited) { <i class="mf-pd-sep"></i><span>{{ 'edited' | t }}</span> }
                <i class="mf-pd-sep"></i><span [title]="datesTip(d)">{{ fmt('page read {r}', { r: ago(d.read_at) }) }}</span>
                <button class="mf-pd-link" (click)="src.set(!src())" [attr.aria-expanded]="src()">{{ 'where it was read' | t }}@if (doubts(d).length) { <span class="mf-doubt">{{ 'check' | t }}</span> }</button>
              </div>
              <!-- the figures that matter, as the LCSC card says its own: label and value, side by side -->
              <dl class="mf-pd-figs">
                <div><dt>{{ 'Price' | t }}</dt><dd [title]="d.price ? moneyTip(d.price.amount, d.price.currency) : ''">
                  @if (d.price) { <b class="mf-pd-price">{{ moneyIn(d.price.amount, d.price.currency) }}</b>
                    @if (d.list_price && d.list_price.amount > d.price.amount) { <s>{{ moneyIn(d.list_price.amount, d.list_price.currency || d.price.currency) }}</s> }
                    <small>{{ (d.price.vat === 'excl' ? '+VAT' : d.price.vat === 'incl' ? 'VAT included' : '') | t }}@if (d.price.manual) { {{ 'corrected' | t }} }</small>
                  } @else { <span class="dim">{{ 'no price on its page' | t }}</span> }</dd></div>
                <div><dt>{{ 'At the seller' | t }}</dt><dd [attr.data-s]="d.stock">
                  @if (d.stock) { <b>{{ d.stock === 'in' ? (d.stock_qty != null ? fmt('{n} left', { n: d.stock_qty }) : ('in stock' | t)) : ('out of stock' | t) }}</b> }
                  @else { <span class="dim">{{ 'not said' | t }}</span> }</dd></div>
                <div><dt>{{ 'On hand' | t }}</dt><dd [attr.data-low]="onHand(d.maker.id, d.id)?.low ? 1 : null">
                  @if (onHand(d.maker.id, d.id); as s) { <b>{{ qty(s.quantity) }} {{ s.unit }}</b> } @else { <span class="dim">{{ 'not counted yet' | t }}</span> }</dd></div>
                <div><dt>{{ 'Size' | t }}</dt><dd>
                  @if (pfiles.model(d.maker.id, d.id); as h) { <b class="mono" [title]="pfiles.tip(h)">{{ h.box?.length === 3 ? boxOf(h.box!) : ('measuring…' | t) }}</b> }
                  @else { <span class="dim">{{ 'no 3D model yet' | t }}</span> }</dd></div>
              </dl>
            </div>
            <!-- actions: links and tools as one quiet joined group, deleting apart and quiet, closing at the end -->
            <div class="mf-pd-acts">
              <div class="mf-pd-tools" role="toolbar" [attr.aria-label]="'Product' | t">
                @if (d.url) { <a class="mf-pd-tool" [href]="d.url" target="_blank" rel="noopener noreferrer" [title]="d.url">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.open" /></svg>{{ 'Its page' | t }}</a> }
                <button class="mf-pd-tool" (click)="closeDetail(); openMaker(d.maker.id)" [title]="'Open the maker' | t">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.maker" /></svg>{{ d.maker.name || ('Maker' | t) }}</button>
                <!-- To a person in Chat, as a card that opens it (dm.ts). -->
                <span class="mf-pd-tool mf-pd-send"><rl-dm-send-btn kind="product" [id]="d.maker.id + ':' + d.id" [label]="d.name" cls="tcv-dm-sendbtn" /></span>
                @if (can()) { <button class="mf-pd-tool" (click)="editFromDetail(d)">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.edit" /></svg>{{ 'Edit' | t }}</button> }
              </div>
              @if (can()) { <button class="mf-pd-icon mf-pd-del" (click)="deleteFromDetail(d)" [title]="'Delete the product' | t" [attr.aria-label]="'Delete the product' | t">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.trash" /></svg></button> }
              <button class="mf-pd-icon" (click)="closeDetail()" [title]="'close (Esc)' | t" [attr.aria-label]="'close (Esc)' | t">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.close" /></svg></button>
            </div>
          </div>
          <!-- where the price and the stock were read from, their doubts, and "this is wrong": asked for, never in the way -->
          @if (src()) {
            <div class="mf-pd-src tcv-pop-in" role="dialog" [attr.aria-label]="'where it was read' | t">
              <div class="mf-pd-srcrow"><span class="mf-pd-k">{{ 'Price' | t }}</span><span class="mf-pd-v">{{ srcTip('price', d.price) || ('not read from its page' | t) }}</span>
                @if (can() && !d.part && (d.price || d.stock)) { <button class="mf-pd-link" (click)="openFix('price', d)" [attr.aria-expanded]="fix()?.what === 'price'">{{ 'The price is wrong' | t }}</button> }</div>
              <div class="mf-pd-srcrow"><span class="mf-pd-k">{{ 'Stock' | t }}</span><span class="mf-pd-v">{{ srcTip('stock', d.stock_read) || ('not read from its page' | t) }}</span>
                @if (can() && !d.part && (d.price || d.stock)) { <button class="mf-pd-link" (click)="openFix('stock', d)" [attr.aria-expanded]="fix()?.what === 'stock'">{{ 'The stock is wrong' | t }}</button> }</div>
              <div class="mf-pd-srcrow mf-pd-dim">{{ datesTip(d).split('\n').join(' · ') }}</div>
              <ng-container *ngTemplateOutlet="readT; context: { $implicit: d, what: 'price', meta: d.price }" />
              <ng-container *ngTemplateOutlet="readT; context: { $implicit: d, what: 'stock', meta: d.stock_read }" />
            </div>
          }
        </header>
        <!-- the body: three columns down to the box's foot, sections under plain headers, the parts that can grow filling it -->
        <div class="mf-pd-body">
          <div class="mf-pd-col">
            <section class="mf-pd-sec mf-pd-grow">
              <div class="mf-pd-sh"><h3>{{ 'Pictures' | t }}</h3>@if (gallery().length > 1) { <span class="st-sub">{{ gallery().length }}</span> }</div>
              <div class="mf-pd-img" [attr.data-solid]="bigImg()?.includes('/thumb?v=') ? 1 : null">@if (bigImg(); as src) { <img [class.tcv-fm-solid]="src.includes('/thumb?v=')" [src]="src" referrerpolicy="no-referrer" alt="" (error)="broke(src)"> }
                @else { <svg class="mf-noimg" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.photo" /></svg> }</div>
              @if (gallery().length > 1) {
                <div class="mf-thumbs mf-pd-thumbs">@for (u of gallery(); track u) {
                  <button [class.on]="u === bigImg()" (click)="shot.set(u)"><img [src]="u" loading="lazy" referrerpolicy="no-referrer" alt="" (error)="broke(u)"></button> }</div>
              }
            </section>
            <section class="mf-pd-sec">
              <div class="mf-pd-sh"><h3>{{ 'Price and stock, as read' | t }}</h3><span class="st-sub">{{ d.history?.length || '' }}</span></div>
              @if (d.history?.length) {
                @if (spark(d); as sp) {
                  <div class="mf-pd-spark"><svg viewBox="0 0 200 44" preserveAspectRatio="none" aria-hidden="true"><path [attr.d]="sp.line" /></svg>
                    <span class="mono">{{ moneyIn(sp.max, sp.cur) }}</span><span class="mono">{{ moneyIn(sp.min, sp.cur) }}</span></div>
                }
                <table class="mf-pd-hist">
                  <tbody>@for (h of histRows(d).slice(0, 6); track h.at) {
                    <tr><td class="dim">{{ ago(h.at) }}</td>
                      <td class="r mono" [title]="h.amount != null ? moneyTip(h.amount, h.currency || d.price?.currency) : ''">{{ h.amount != null ? moneyIn(h.amount, h.currency || d.price?.currency) : '–' }}</td>
                      <td class="dim">{{ h.stock ? (h.stock === 'in' ? (h.qty != null ? fmt('{n} left', { n: h.qty }) : t('In stock')) : t('Out of stock')) : '–' }}</td>
                      <td class="r mono" [attr.data-up]="h.change > 0 ? 1 : null" [attr.data-down]="h.change < 0 ? 1 : null">{{ h.change ? (h.change > 0 ? '+' : '') + h.change.toFixed(1) + '%' : '' }}</td></tr>
                  }</tbody>
                </table>
              } @else { <p class="mf-pd-none">{{ 'Read once a price or a stock is on its page.' | t }}</p> }
            </section>
          </div>
          <div class="mf-pd-col">
            <section class="mf-pd-sec">
              <div class="mf-pd-sh"><h3>{{ 'Specs' | t }}</h3>@if (specList(d).length) { <span class="st-sub">{{ specList(d).length }}</span> }</div>
              @if (d.description) { <p class="mf-pd-desc">{{ d.description }}</p> }
              @if (specList(d).length) {
                <dl class="mf-pd-specs">@for (s of specList(d); track s[0]) { <div><dt [title]="s[0]">{{ s[0] }}</dt><dd [title]="s[1]">{{ s[1] }}</dd></div> }</dl>
              } @else { <p class="mf-pd-none">{{ 'Its page gave no specs.' | t }}</p> }
            </section>
            <!-- its 3D model (measured), datasheets, drawings, pictures (product-files.ts) -->
            <wb-product-files class="mf-pd-sec mf-pd-grow" [maker]="d.maker.id" [product]="d.id" [compact]="true" />
          </div>
          <div class="mf-pd-col">
            <section class="mf-pd-sec mf-pd-grow">
              <div class="mf-pd-sh"><h3>{{ 'Stock' | t }}</h3></div>
              <!-- how many are on hand, where, the log (stock.ts) -->
              <wb-stock-panel class="mf-pd-fill" [maker]="d.maker.id" [product]="d.id" [compact]="true" />
            </section>
          </div>
        </div>
      </div>
    </div>
  }
  <!-- ================= "Re-read all products": every saved page read again, and what changed ================= -->
  @if (checkOpen()) {
    <div class="mf-modal tcv-m-veil" animate.leave="tcv-leave" (click)="checkOpen.set(false)">
      <div class="mf-chk tcv-m-box" role="dialog" aria-modal="true" [attr.aria-label]="'Re-read all products' | t" (click)="$event.stopPropagation()">
        <button class="tcv-cc-ib mf-x" (click)="checkOpen.set(false)" [title]="'Close' | t">
          <svg class="tcv-cc-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.close" /></svg></button>
        <div class="mf-chk-head">
          <h2 class="mf-dname">{{ 'Re-read all products' | t }}</h2>
          <span class="st-sub">{{ 'Every saved product page is read again with the current reader - no model, one page at a time, by each site\\'s routes and under its robots.txt. New prices and stocks are saved; the ones you corrected stay while the page says the same.' | t }}</span>
        </div>
        @if (check(); as c) {
          @if (c.dry && c.status !== 'running') { <div class="st-banner mf-chk-banner">{{ 'Only compared: nothing was saved.' | t }}</div> }
          @if (c.error) { <div class="st-banner tsx-banner" role="alert">{{ c.error }}</div> }
          <div class="st-tiles mf-chk-tiles">
            <div class="st-tile" [attr.data-tone]="c.status === 'running' ? 'accent' : c.status === 'done' ? 'ok' : 'warn'"><span>{{ 'Status' | t }}</span>
              <b>{{ checkStatus(c) | t }}</b><small>{{ fmt('since {w}', { w: when(c.started_at) }) }}{{ c.by.name ? ' · ' + c.by.name : '' }}</small></div>
            <div class="st-tile"><span>{{ 'Pages read' | t }}</span><b>{{ c.counts.read ?? 0 }} / {{ c.counts.pages ?? c.total ?? '–' }}</b>
              <small>{{ fmt('{n} products', { n: c.counts.products ?? 0 }) }}</small></div>
            <div class="st-tile" [attr.data-tone]="c.counts.price ? 'accent' : 'dim'"><span>{{ 'Price changed' | t }}</span><b [wbCount]="c.counts.price ?? 0"></b>
              <small>{{ (c.dry ? 'not saved' : c.counts.saved ? fmt('{n} updated', { n: c.counts.saved }) : 'nothing to save') | t }}</small></div>
            <div class="st-tile" [attr.data-tone]="c.counts.stock ? 'accent' : 'dim'"><span>{{ 'Stock changed' | t }}</span><b [wbCount]="c.counts.stock ?? 0"></b><small>&nbsp;</small></div>
            <div class="st-tile" [attr.data-tone]="c.counts.doubt ? 'warn' : 'dim'"><span>{{ 'Newly doubtful' | t }}</span><b [wbCount]="c.counts.doubt ?? 0"></b>
              <small>{{ 'shown with the check mark' | t }}</small></div>
            <div class="st-tile" [attr.data-tone]="c.counts.held ? null : 'dim'"><span>{{ 'Corrections kept' | t }}</span><b [wbCount]="c.counts.held ?? 0"></b>
              <small>{{ 'the page still says the same' | t }}</small></div>
            <div class="st-tile" [attr.data-tone]="(c.counts.failed ?? 0) + (c.counts.not_product ?? 0) ? 'warn' : 'dim'"><span>{{ 'Not read' | t }}</span>
              <b [wbCount]="(c.counts.failed ?? 0) + (c.counts.not_product ?? 0)"></b><small>{{ fmt('{n} no longer this product\\'s page', { n: c.counts.not_product ?? 0 }) }}</small></div>
          </div>
          @if (c.status === 'running') {
            <div class="mf-progress"><div class="st-meter"><i [style.width.%]="pct(c.done, c.total ?? 1)"></i></div>
              <span class="st-sub">{{ fmt('{n} of {m} pages', { n: c.done, m: c.total ?? '…' }) }}@if (c.current) { · {{ path(c.current) }} }</span></div>
          }
          @if (c.rows.length) {
            <div class="st-table-wrap mf-chk-wrap">
              <table class="st-table mf-chk-table">
                <thead><tr><th>{{ 'Product' | t }}</th><th>{{ 'Seller' | t }}</th><th class="r">{{ 'Price' | t }}</th><th>{{ 'Stock' | t }}</th><th>{{ 'What was found' | t }}</th></tr></thead>
                <tbody>
                  @for (r of c.rows; track r.maker.id + r.id) {
                    <tr>
                      <td class="give"><button class="mf-namebtn" (click)="openRow(r)" [title]="r.url">{{ r.name }}</button></td>
                      <td class="dim">{{ r.maker.name }}</td>
                      <td class="r mono">@if (r.price) { <span class="dim">{{ priceSaid(r.price[0]) }}</span> → <b>{{ priceSaid(r.price[1]) }}</b> }</td>
                      <td>@if (r.stock) { <span class="dim">{{ stockSaid(r.stock[0]) }}</span> → {{ stockSaid(r.stock[1]) }} }</td>
                      <td><div class="mf-chk-notes">
                        @if (r.error) { <span class="mf-err">{{ r.error }}</span> }
                        @for (x of r.doubt ?? []; track $index) { <span class="mf-doubt-line">{{ doubtLine(x) }}</span> }
                        @if (r.held?.length) { <span class="dim">{{ (r.held!.length === 2 ? 'your corrections of the price and the stock kept' : r.held![0] === 'price' ? 'your correction of the price kept' : 'your correction of the stock kept') | t }}</span> }
                      </div></td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          } @else if (c.status !== 'running') { <p class="st-hint">{{ 'Every page read says what the catalog says.' | t }}</p> }
        } @else if (checkLoading()) { <wb-skel kind="tiles" [count]="7" [min]="110" /> }
        @else { <p class="st-hint">{{ 'Not run yet in this workspace.' | t }}</p> }
        <div class="mf-chk-acts">
          @if (check()?.status === 'running') {
            <button class="tcv-btn tst-del" (click)="cancelCheck()">{{ 'Stop' | t }}</button>
          } @else {
            <button class="tcv-btn tcv-btn-accent" (click)="startCheck(false)" [disabled]="starting()">{{ 'Re-read and update' | t }}</button>
            <button class="tcv-btn" (click)="startCheck(true)" [disabled]="starting()" [title]="'Read every page and show what would change, without saving anything' | t">{{ 'Only compare' | t }}</button>
          }
          <button class="tcv-btn" (click)="checkOpen.set(false)">{{ 'Close' | t }}</button>
        </div>
      </div>
    </div>
  }
</div>
<!-- ================= shared pieces ================= -->
<!-- Where a price or a stock was read (the words around it, or who corrected it), why it may be wrong, and "Wrong" -->
<ng-template #readT let-d let-what="what" let-meta="meta">
  @if (meta || (what === 'price' ? d.price : d.stock)) {
    @if (meta?.doubt?.length) {
      <ul class="mf-doubts">@for (x of meta.doubt; track $index) { <li>{{ doubtLine(x, d.price?.currency) }}</li> }</ul>
    }
    @if (fix()?.what === what) {
      <div class="mf-fix mf-ctl">
        @if (what === 'price') {
          <input class="tst-in mf-pf-amount" inputmode="decimal" [placeholder]="'The right price, e.g. 2.539,81' | t" [value]="fix()!.amount"
                 (input)="fixSet('amount', $event)" (keydown.enter)="saveFix(d)" (keydown.escape)="fix.set(null)" [attr.aria-label]="'Price' | t">
          <wb-select label="Currency" [options]="curOpts" [value]="fix()!.currency" (pick)="fixPick('currency', $event)" />
          <wb-select label="VAT" [options]="vatOpts()" [value]="fix()!.vat" (pick)="fixPick('vat', $event)" />
        } @else {
          <wb-select label="Stock on the site" [options]="fixStockOpts()" [value]="fix()!.stock" (pick)="fixPick('stock', $event)" />
          @if (fix()!.stock === 'in') {
            <input class="tst-in mf-pf-qty" inputmode="numeric" [placeholder]="'Qty' | t" [value]="fix()!.qty" (input)="fixSet('qty', $event)"
                   (keydown.enter)="saveFix(d)" [attr.aria-label]="'How many the seller has' | t" [title]="'How many the seller has (optional)' | t">
          }
        }
        <button class="tcv-btn tcv-btn-accent" (click)="saveFix(d)" [disabled]="saving() || (what === 'price' && !fix()!.amount.trim())">{{ 'Save' | t }}</button>
        <button class="tcv-btn" (click)="fix.set(null)">{{ 'Cancel' | t }}</button>
        <span class="st-sub mf-fixnote">{{ 'Kept through the next reads while the page says the same; the page is kept as a test case.' | t }}</span>
      </div>
    }
  }
</ng-template>
<ng-template #cardT let-p>
  <button class="mf-card" [class.mf-card-lcsc]="!!p.part" [attr.data-key]="keyOf(p)" [attr.data-on]="gsel().has(keyOf(p)) ? 1 : null" [attr.aria-pressed]="gsel().has(keyOf(p))"
          (click)="cardClick($event, p)" (contextmenu)="openMenu($event, p)" [title]="p.name">
    <span class="mf-card-img">
      @if (p.part) { <wb-fp [lcsc]="p.id" /> }
      @else if (img(p); as src) { <img [class.tcv-fm-solid]="!!p.linked || src.includes('/thumb?v=')" [src]="src" loading="lazy" decoding="async" referrerpolicy="no-referrer" alt="" (error)="broke(src)"> }
      @else { <svg class="mf-noimg" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="p.linked ? I.cube : I.photo" /></svg> }
      @if (p.stock) { <span class="mf-stock" [attr.data-s]="p.stock">{{ stockName(p) }}</span> }
      @if (!p.part && !p.linked) { <ng-container *ngTemplateOutlet="filesT; context: { $implicit: p, mid: p.maker.id, onimg: true }" /> }
    </span>
    <span class="mf-card-body">
      <span class="mf-card-name">{{ p.name }}</span>
      @if (p.part; as pt) {
        <span class="mf-card-part mono" [title]="pt.package || ''">@if (pt.package) { <span>{{ pkg(pt.package) }}</span> }<span>{{ pt.lcsc }}</span>
          @if (pt.pins) { <span>{{ fmt(pt.pins === 1 ? '{n} pin' : '{n} pins', { n: pt.pins }) }}</span> }
          <i class="pdw-badge" [class.pdw-badge-3d]="pt.has_3d" [title]="(pt.has_3d ? 'came with a 3D model' : 'footprint only - it will not stand on the board') | t">{{ pt.has_3d ? '3D' : '2D' }}</i></span>
      }
      @if (p.price) {
        <span class="mf-card-price" [title]="moneyTip(p.price.amount, p.price.currency)"><b>{{ moneyIn(p.price.amount, p.price.currency) }}</b>@if (p.price.vat === 'excl') { <small>{{ '+VAT' | t }}</small> }
          @if (p.list_price && p.list_price.amount > p.price.amount) { <s>{{ moneyIn(p.list_price.amount, p.list_price.currency || p.price.currency) }}</s> }<ng-container *ngTemplateOutlet="doubtT; context: { $implicit: p }" /></span>
      } @else if (p.linked; as l) { <span class="mf-card-price mono">{{ l.key }}@if (l.cad) {
          <!-- a measured STEP says its box in place of its kind (linked_measure.py), a figure its words say otherwise marked -->
          @if (box(l); as b) { <small [title]="('Measured from the STEP' | t) + ' (' + l.cad.kind.toUpperCase() + ')'">· {{ b }}</small>
            @if (l.measured?.mismatch?.length) { <span class="st-tag" data-tone="warn" [title]="mismatchTip(l.measured)">≠</span> } }
          @else { <small> · {{ l.cad.kind.toUpperCase() }}</small> } }</span>
      } @else { <span class="mf-card-price mf-noprice">{{ 'No price' | t }}<ng-container *ngTemplateOutlet="doubtT; context: { $implicit: p }" /></span> }
      <span class="mf-card-seller"><img class="mf-fav" [src]="fav(p)" alt="" loading="lazy" referrerpolicy="no-referrer" (error)="$any($event.target).style.visibility = 'hidden'"><span>{{ sellerName(p) }}</span></span>
      <span class="mf-card-foot"><ng-container *ngTemplateOutlet="onHandT; context: { $implicit: p }" />@if (p.category) { <span class="mf-chip" [title]="p.category">{{ p.category }}</span> }<span class="mf-ago">{{ readAgo(p) }}</span></span>
    </span>
  </button>
</ng-template>
<!-- how many are on hand of a product (stock.ts): green, amber when low, red when none is left -->
<ng-template #onHandT let-p>
  @if (onHand(p.maker.id, p.id); as s) { <span class="mf-onhand" [attr.data-low]="s.low ? 1 : null" [attr.data-out]="s.quantity <= 0 ? 1 : null"
        [title]="(s.low ? 'On hand - at or below its minimum' : 'On hand') | t">{{ qty(s.quantity) }} {{ s.unit }}</span> }
</ng-template>
<!-- "3D": a model attached to the product (product-files.ts), its kind, box and file count in the tooltip -->
<ng-template #filesT let-p let-mid="mid" let-onimg="onimg">
  @if (pfiles.model(mid, p.id); as h) { <span class="mf-3d" [class.mf-3d-img]="onimg" [title]="pfiles.tip(h)">3D</span> }
</ng-template>
<!-- the amber mark of a price or stock read with a doubt on it: the reasons in its tooltip, in full in the product -->
<ng-template #doubtT let-p>
  @if (doubts(p).length) { <span class="mf-doubt" [title]="doubtTip(p)">{{ 'check' | t }}</span> }
</ng-template>
<ng-template #layoutT>
  @if (layout() === 'grid') {
    <div class="st-seg mf-cols" role="group" [attr.aria-label]="'Cards per row' | t">
      <button type="button" (click)="setCols(-1)" [disabled]="cols() === 2" [title]="'Bigger cards' | t" aria-label="−">−</button>
      <button type="button" class="mf-cols-n" (click)="setCols(0)" [title]="'Cards per row - click for automatic' | t">{{ cols() ? fmt('{n} per row', { n: cols() }) : ('Auto' | t) }}</button>
      <button type="button" (click)="setCols(1)" [disabled]="cols() === 10" [title]="'Smaller cards' | t" aria-label="+">+</button>
    </div>
  }
  <div class="st-seg mf-layout" role="radiogroup" [attr.aria-label]="'Layout' | t">
    <button [class.on]="layout() === 'drawer'" (click)="setLayout('drawer')" [title]="'The drawer: groups that open to trays of bins' | t"><svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.drawer" /></svg>{{ 'Drawer' | t }}</button>
    <button [class.on]="layout() === 'grid'" (click)="setLayout('grid')" [title]="'Grid' | t"><svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.grid" /></svg>{{ 'Grid' | t }}</button>
    <button [class.on]="layout() === 'table'" (click)="setLayout('table')" [title]="'Table' | t"><svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.rows" /></svg>{{ 'Table' | t }}</button>
  </div>
</ng-template>
<!-- LCSC, the parts drawer as a seller: what it holds, then adding from LCSC (a number is added, words search) -->
<ng-template #lcscHead let-m>
  <header class="tst-head">
    <div class="tst-title">
      <h2>LCSC</h2>
      <span class="st-sub"><a class="mf-link" [href]="m.url" target="_blank" rel="noopener noreferrer">lcsc.com</a>
        · {{ 'the parts drawer: parts kept for boards, with their footprint, symbol and 3D model on the server' | t }}</span>
    </div>
    <div class="tst-acts">
      <button class="tcv-btn" (click)="toBoards()" [title]="'The board room\\'s Parts tab finds the same parts' | t">{{ 'Open the board room' | t }}</button>
    </div>
  </header>
  <div class="st-tiles mf-mtiles">
    <div class="st-tile" [attr.data-tone]="m.product_count ? null : 'dim'"><span>{{ 'Parts' | t }}</span><b [wbCount]="m.product_count"></b>
      <small>{{ fmt('{n} with a 3D model', { n: partStats().with3d }) }}</small></div>
    <div class="st-tile" [attr.data-tone]="m.categories.length ? null : 'dim'"><span>{{ 'Categories' | t }}</span><b [wbCount]="m.categories.length"></b>
      <small [title]="m.categories.join(', ')">{{ m.categories.slice(0, 3).join(', ') || '–' }}</small></div>
    <div class="st-tile" [attr.data-tone]="partStats().out ? 'warn' : null"><span>{{ 'In stock at LCSC' | t }}</span><b>{{ partStats().inStock }} / {{ m.product_count }}</b>
      <small>{{ fmt('{n} out of stock', { n: partStats().out }) }}</small></div>
    <div class="st-tile" [attr.data-tone]="partStats().basic ? 'ok' : 'dim'"><span>{{ 'JLCPCB Basic' | t }}</span><b [wbCount]="partStats().basic"></b>
      <small>{{ 'no loading fee' | t }}</small></div>
    <div class="st-tile" [attr.data-tone]="partStats().last ? null : 'dim'"><span>{{ 'Last added' | t }}</span><b>{{ when(partStats().last?.added_at) }}</b>
      <small [title]="partStats().last?.name || ''">{{ partStats().last?.name || '–' }}</small></div>
  </div>
  <section class="st-card mf-pageadd mf-lcscadd">
    <div class="mf-addrow mf-ctl">
      <span class="mf-label mf-rowlabel">{{ 'Add from LCSC' | t }}</span>
      <input class="tst-in" [placeholder]="'An LCSC number (C25744) to add, or words to search LCSC' | t" [value]="desk.term()"
             (input)="desk.term.set($any($event.target).value)" (keydown.enter)="desk.addOrLook()"
             (keydown.escape)="desk.term.set(''); desk.hits.set([])" [attr.aria-label]="'Search LCSC' | t">
      <span class="st-sub mf-pagenote">{{ 'a search downloads nothing; Add keeps its footprint and 3D model' | t }}</span>
      <button class="tcv-btn tcv-btn-accent" (click)="desk.addOrLook()" [disabled]="desk.looking() || desk.adding()?.state === 'running' || !desk.term().trim()">
        {{ desk.looking() ? '…' : ((desk.isNumber(desk.term()) ? 'Add' : 'Search LCSC') | t) }}</button>
    </div>
    <app-part-adding class="mf-adding" />
    @if (desk.note(); as n) { <p class="st-hint">{{ n }}</p> }
    @if (desk.hits().length) {
      <div class="st-table-wrap mf-hits">
        <table class="st-table mf-gtable">
          <thead><tr><th>LCSC</th><th>{{ 'Part number' | t }}</th><th>{{ 'Package' | t }}</th><th>{{ 'Manufacturer' | t }}</th>
            <th class="r">{{ 'Stock' | t }}</th><th class="r">{{ 'Price' | t }}</th>
            <th class="r"><button class="st-more" (click)="desk.hits.set([])">{{ 'Clear' | t }}</button></th></tr></thead>
          <tbody>
            @for (h of desk.hits(); track h.lcsc) {
              <tr (click)="desk.inspect(h.lcsc)">
                <td class="mono">{{ h.lcsc }}</td><td class="give"><b>{{ h.mpn }}</b></td><td class="mono dim">{{ h.package }}</td>
                <td class="dim">{{ h.maker }}</td><td class="r mono">{{ h.stock ?? '–' }}</td>
                <td class="r" [title]="h.price != null ? moneyTip(h.price, 'USD') : ''">{{ h.price != null ? moneyIn(h.price, 'USD') : '–' }}</td>
                <td class="r">@if (h.have) { <span class="st-tag" data-tone="ok" [title]="'already in the drawer' | t">{{ 'kept' | t }}</span> }
                  @else if (desk.canEdit()) { <button class="tcv-btn" (click)="$event.stopPropagation(); desk.addPart(h.lcsc)" [disabled]="desk.adding()?.state === 'running'"
                                                      [title]="'fetch its footprint and 3D model' | t">{{ (desk.adding()?.lcsc === h.lcsc && desk.adding()?.state === 'running' ? 'adding…' : 'Add') | t }}</button> }</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
  </section>
</ng-template>
<!-- The drawer's parts as rows: what a part has that a product does not -->
<ng-template #partsTable let-m>
  <div class="st-table-wrap">
    <table class="st-table mf-gtable mf-partstable">
      <thead><tr><th class="mf-selcol"><input type="checkbox" class="tcv-check" [checked]="allPicked()" (change)="pickAll($any($event.target).checked)" [attr.aria-label]="'Select all' | t"></th>
        <th class="mf-gthumb"></th><th>{{ 'Value' | t }}</th><th>{{ 'Part number' | t }}</th><th>{{ 'Package' | t }}</th><th>LCSC</th><th class="r">{{ 'Pins' | t }}</th>
        <th class="r">{{ 'On hand' | t }}</th><th class="r">{{ 'Price' | t }}</th><th class="r">{{ 'At LCSC' | t }}</th><th>{{ 'Category' | t }}</th><th>3D</th></tr></thead>
      <tbody>
        @for (p of found().slice(0, shownRows()); track p.id) {
          <tr class="mf-prow" [attr.data-sel]="picked_().has(p.id) ? 1 : null" [class.mf-pulse-row]="desk.pulse() === p.id"
              (click)="openDetail(asItem(p, m))" (contextmenu)="openMenu($event, asItem(p, m))">
            <td class="mf-selcol" (click)="$event.stopPropagation()"><input type="checkbox" class="tcv-check" [checked]="picked_().has(p.id)" (change)="pick(p.id, $any($event.target).checked)" [attr.aria-label]="p.name"></td>
            <td class="mf-gthumb"><span class="mf-fpthumb"><wb-fp [lcsc]="p.id" /></span></td>
            <td><b>{{ p.part?.value || '–' }}</b></td>
            <td class="give" [title]="p.description">{{ p.part?.mpn || p.name }} <span class="dim">{{ p.part?.maker }}</span></td>
            <td class="mono dim" [title]="p.part?.package || ''">{{ pkg(p.part?.package) || '–' }}</td>
            <td class="mono"><button class="mf-namebtn mono" (click)="$event.stopPropagation(); copyNumbers([p.id])" [title]="'Copy the LCSC number' | t">{{ p.id }}</button></td>
            <td class="r mono">{{ p.part?.pins ?? '–' }}</td>
            <td class="r">@if (onHand(m.id, p.id); as s) { <span class="mf-onhand" [attr.data-low]="s.low ? 1 : null" [attr.data-out]="s.quantity <= 0 ? 1 : null">{{ qty(s.quantity) }} {{ s.unit }}</span> } @else { <span class="dim">–</span> }</td>
            <td class="r" [title]="p.price ? moneyTip(p.price.amount, p.price.currency) : ''">@if (p.price) { <b>{{ moneyIn(p.price.amount, p.price.currency) }}</b> } @else { <span class="dim">–</span> }</td>
            <td class="r">@if (p.stock) { <span class="mf-sdot" [attr.data-s]="p.stock">{{ p.stock_qty != null ? num(p.stock_qty) : stockName(p) }}</span> } @else { <span class="dim">–</span> }</td>
            <td class="dim mf-pt-cat" [title]="p.part?.group + ' › ' + p.category">{{ p.category }}</td>
            <td><i class="pdw-badge" [class.pdw-badge-3d]="p.part?.has_3d">{{ p.part?.has_3d ? '3D' : '2D' }}</i></td>
          </tr>
        } @empty { <tr><td colspan="12" class="dim">{{ 'Nothing matches.' | t }}</td></tr> }
      </tbody>
    </table>
  </div>
  @if (found().length > shownRows()) {
    <button class="st-more mf-morerows" (click)="rows.set(rows() + 200)">{{ fmt('Show {n} more', { n: found().length - shownRows() }) }}</button>
  }
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
  /** The parts drawer's work for the LCSC seller: adding, one part open in full (part-desk.ts). */
  readonly desk = inject(PartDesk);
  /** McMaster-Carr's and GrabCAD's: the search, saving, one saved item in full (linked.ts). */
  readonly linked = inject(LinkedDesk);
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
  /** The overview: every product (the grid, the default), every product on hand (an old link to the stock's
   *  own tab opens here too), or the sites and adding one. */
  sub = signal<'products' | 'stock' | 'sites'>(STOCK_ASKED || this.url.get('sub') === 'stock' ? 'stock' : this.url.get('sub') === 'sites' ? 'sites' : 'products');
  readonly PARTS_LABEL = PARTS_LABEL;
  /** Cards or rows - the overview's and a maker's catalog alike. */
  layout = signal<Layout>(this.url.get('view') === 'table' ? 'table' : this.url.get('view') === 'drawer' ? 'drawer' : 'grid');
  gmaker = signal(this.url.get('maker') ?? '');
  gseller = signal(this.url.get('seller') ?? '');
  gmin = signal(this.url.get('min') ?? '');
  gmax = signal(this.url.get('max') ?? '');
  gstock = signal(this.url.get('stock') === 'in');
  /** On hand here (stock.ts): '1' what is in stock, 'low' what is at or below its minimum - from every source. */
  gheld = signal<'' | '1' | 'low'>(this.url.get('held') === 'low' ? 'low' : this.url.get('held') === '1' ? '1' : '');
  /** Only the products read with a doubt on their price or stock ("Needs checking"). */
  gcheck = signal(this.url.get('check') === '1');
  gsort = signal(this.url.get('sort') ?? 'new');
  gpages = signal(1);
  grid = signal<GridAnswer | null>(null);
  private gtimer?: ReturnType<typeof setTimeout>;
  private gseq = 0;
  readonly sorts = [{ id: 'new', label: 'Newest' }, { id: 'price_asc', label: 'Price: low to high' },
                    { id: 'price_desc', label: 'Price: high to low' }, { id: 'name', label: 'Name' }, { id: 'match', label: 'Best match' }];
  readonly currencies = CURRENCIES;
  /** The grid bar's drop-downs (ui-select.ts): every choice with its count. */
  catOpts = computed<SelectOption[]>(() => [{ value: '', label: t('All categories') },
    ...(this.grid()?.categories ?? []).map(c => ({ value: c[0], label: c[0], hint: c[1] }))]);
  makerOpts = computed<SelectOption[]>(() => [{ value: '', label: t('All makers') },
    ...(this.grid()?.makers ?? []).map(k => ({ value: k.id, label: k.name, hint: k.count }))]);
  sellerOpts = computed<SelectOption[]>(() => [{ value: '', label: t('All sellers') },
    ...(this.grid()?.sellers ?? []).map(k => ({ value: k[0], label: k[0], hint: k[1] }))]);
  sortOpts = computed<SelectOption[]>(() => this.sorts.map(o => ({ value: o.id, label: t(o.label) })));
  /** On hand here: every product, what is in stock, what is low (stock.ts). */
  heldOpts = computed<SelectOption[]>(() => [{ value: '', label: t('All products') }, { value: '1', label: t('In stock'), hint: this.heldTotal() },
    { value: 'low', label: t('Low stock'), hint: this.heldLow() }]);
  /** A maker's catalog: its categories; the product form: currency, VAT, stock. */
  productCatOpts = computed<SelectOption[]>(() => [{ value: '', label: t('All categories') }, ...plainOptions(this.productCats())]);
  readonly curOpts = plainOptions(CURRENCIES);
  vatOpts = computed<SelectOption[]>(() => [{ value: '', label: t('VAT not said') }, { value: 'excl', label: t('+VAT (excluded)') },
    { value: 'incl', label: t('VAT included') }]);
  pfStockOpts = computed<SelectOption[]>(() => [{ value: '', label: t('Stock not said') }, { value: 'in', label: t('In stock') },
    { value: 'out', label: t('Out of stock') }]);
  filtered = computed(() => !!(this.pq() || this.cat() || this.gmaker() || this.gseller() || this.gmin() || this.gmax() || this.gstock() || this.gcheck() || this.gheld()));
  filteredButHeld = computed(() => !!(this.pq() || this.cat() || this.gmaker() || this.gseller() || this.gmin() || this.gmax() || this.gstock() || this.gcheck()));
  /** The product open in full (?p=, its maker ?pm=), and the picture shown big. */
  detail = signal<GridItem | null>(null);
  shot = signal<string | null>(null);
  /** Pictures that did not load: the placeholder instead. */
  broken = signal<Set<string>>(new Set());

  all = signal<Maker[]>([]);
  /** The first list of makers has come (or failed): till then a placeholder, not "No manufacturers yet". */
  listed = signal(false);
  maker = signal<Maker | null>(null);
  proxy = signal<ProxyState | null>(null);
  /** How the next run goes out: null for the default order, else its own. */
  choice = signal<RouteChoice>(null);

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
  /** What is on hand of every product (stock.ts, one read for the page), and the "Add to stock"
   *  form for the selected products of a catalog ('*'); one product's is its stock section. */
  private inv = inject(InventoryApi);
  readonly held = inject(StockState);
  /** Which products hold files - a "3D" badge, a picture of their own (product-files.ts). */
  readonly pfiles = inject(ProductFilesState);
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
    if (pid && pm === LCSC_MAKER) this.openPart(pid);
    else if (pid && pm) this.api.get(pm).subscribe({ next: m => { const p = (m.products ?? []).find(x => x.id === pid); if (p) this.openDetail(this.asItem(p, m)); }, error: () => {} });
    // An old link to a stock line (?ws=inventory&item=): its product, open.
    const old = this.url.get('item');
    if (old && STOCK_ASKED) { this.openItem(old); }
    this.held.load();
    this.pfiles.load();
    // The overview's grid: read again when what it shows changes (a breath after typing).
    effect(() => {
      if (this.view() !== 'home' || this.sub() !== 'products') return;
      this.held.changed();
      const f: GridQuery = { q: this.pq().trim(), cat: this.cat(), maker: this.gmaker(), seller: this.gseller(), min: this.gmin(),
                             max: this.gmax(), stock: this.gstock() ? 'in' : '', sort: this.gsort(), size: 60 * this.gpages(), check: this.gcheck() ? '1' : '',
                             held: this.gheld() };
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
      set('sub', home && this.sub() !== 'products' ? this.sub() : null);
      set('held', grid ? this.gheld() : null);
      set('maker', grid ? this.gmaker() : null);
      set('seller', grid ? this.gseller() : null);
      set('min', grid ? this.gmin() : null);
      set('max', grid ? this.gmax() : null);
      set('stock', grid && this.gstock() ? 'in' : null);
      set('check', grid && this.gcheck() ? '1' : null);
      set('sort', grid && this.gsort() !== 'new' ? this.gsort() : null);
      set('view', v !== 'run' && this.layout() !== 'grid' ? this.layout() : null);
      const part = this.desk.seen()?.lcsc ?? this.desk.seeing();
      set('p', d ? d.id : part);
      set('pm', d ? d.maker.id : part ? LCSC_MAKER : null);
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
      if (!w || !['mfr', 'mfr-add', 'mfr-product', 'mfr-part', 'mfr-open', 'mfr-stock', 'mfr-stock-add', 'mfr-stock-item'].includes(w.what)) return;
      untracked(() => {
        this.picked.want.set(null);
        // A product by "maker:product" (a card sent in Chat): open, wherever it is kept.
        if (w.what === 'mfr-open' && w.arg) { const i = w.arg.indexOf(':'); this.openRef(w.arg.slice(0, i), w.arg.slice(i + 1)); return; }
        // Every product on hand; adding an own item; a stock line (an old card sent in Chat): its product.
        if (w.what === 'mfr-stock' || w.what === 'mfr-stock-add') { this.goHome(); this.sub.set('stock');
          if (w.what === 'mfr-stock-add') setTimeout(() => document.querySelector<HTMLInputElement>('.inv-a-name')?.focus(), 120); return; }
        if (w.what === 'mfr-stock-item' && w.arg) { this.openItem(w.arg); return; }
        // An LCSC part (the board room, the palette, Chat): the drawer, the part open in full.
        if (w.what === 'mfr-part') {
          if (this.view() !== 'maker' || this.mid() !== LCSC_MAKER) this.openMaker(LCSC_MAKER);
          if (w.arg) this.openPart(w.arg);
          return;
        }
        // A product by its maker and name: its maker open, searched for its name.
        if (w.what === 'mfr-product' && w.arg) {
          const [mid, name] = w.arg.split('\n');
          this.openMaker(mid, true);
          this.pq.set(name ?? '');
        } else if (w.what === 'mfr' && w.arg) this.openMaker(w.arg); else this.goAdd();
      });
    });
    // A part added, moved or dropped: the LCSC seller reads again.
    effect(() => { if (this.desk.changed()) untracked(() => this.read()); });
    // McMaster-Carr, GrabCAD: a saved item changed; the page of one is its search's, and draws its CAD files' pictures.
    effect(() => { if (this.linked.changed()) untracked(() => this.read()); });
    effect(() => {
      const m = this.view() === 'maker' ? this.maker() : null;
      if (m?.view !== 'linked') return;
      untracked(() => {
        if (this.linked.src() !== m.id) { this.linked.src.set(m.id); this.linked.found.set(null); this.linked.term.set(''); this.linked.err.set(''); }
        for (const p of m.products ?? []) if (p.linked) this.linked.want(p.linked);
        const o = this.linked.open();
        if (o) { const now = (m.products ?? []).find(p => p.linked?.id === o.id)?.linked; if (now) this.linked.open.set(now); }
      });
    });
    // Stock changed here (a product's stock section, the stock view): what the page shows of it reads again.
    effect(() => { if (this.held.changed()) untracked(() => { const m = this.maker(); if (m && this.view() === 'maker') this.api.get(m.id).subscribe({ next: x => this.maker.set(x), error: () => {} }); }); });
    // A run the overview counts that ends: the list reads again (its catalog changed).
    effect(() => { this.runs.running(); untracked(() => this.read()); });
  }

  private read() {
    this.api.list('').subscribe({ next: ms => { this.all.set(ms); this.listed.set(true); }, error: () => this.listed.set(true) });
    if (this.view() === 'home' && this.sub() === 'products') this.loadGrid();
    const m = this.maker();
    if (m && this.view() === 'maker') this.api.get(m.id).subscribe({ next: x => this.maker.set(x), error: () => {} });
    this.held.load();
    this.pfiles.load();
  }

  // ---- what is on hand (stock.ts)

  /** What is on hand of a product, or null when none is counted. */
  onHand(mid: string, pid: string): CatalogStock | null { return this.held.of(mid, pid); }
  /** How many products of a maker, of every maker, are counted in stock. */
  heldCount(mid: string) { return Object.keys(this.held.held()[mid] ?? {}).length; }
  heldTotal = computed(() => Object.values(this.held.held()).reduce((n, m) => n + Object.values(m).filter(s => s.quantity > 0).length, 0));
  heldLow = computed(() => Object.values(this.held.held()).reduce((n, m) => n + Object.values(m).filter(s => s.low).length, 0));
  /** A product by its maker and its id, open in full - the drawer's part card, a saved McMaster or GrabCAD item's, a product's. */
  openRef(mid: string, pid: string) {
    if (mid === LCSC_MAKER) { this.openPart(pid); return; }
    this.api.get(mid).subscribe({
      next: m => {
        const p = (m.products ?? []).find(x => String(x.id) === pid);
        if (!p) { this.say(t('That product is not in Parts any more.'), 'danger'); return; }
        if (p.linked) this.linked.show(mid, p.linked); else this.openDetail(this.asItem(p, m));
      },
      error: () => this.say(t('That product is not in Parts any more.'), 'danger'),
    });
  }
  /** A stock line: its product. */
  openLine(i: Item) {
    if (i.catalog?.product) this.openRef(i.catalog.manufacturer, i.catalog.product);
    else this.say(t('That product is not in Parts any more.'), 'danger');
  }
  /** A stock line by its id (an old link or card): its product. */
  private openItem(id: string) {
    this.sub.set('stock');
    this.inv.get(id).subscribe({ next: i => this.openLine(i), error: () => this.say(t('That stock line is gone.'), 'danger') });
  }

  // ---- the selected products of a catalog into stock

  openStock(id: string) {
    this.stockFor.set(this.stockFor() === id ? null : id);
    this.sf.update(f => ({ ...f, quantity: '1', note: '' }));
  }
  sfSet(k: 'quantity' | 'unit' | 'location' | 'note', e: Event) {
    const v = (e.target as HTMLInputElement).value;
    this.sf.update(f => ({ ...f, [k]: v }));
  }
  stockEnter() {
    const f = this.stockFor();
    if (f && this.mid()) this.addToStock(this.mid()!, f === '*' ? this.pickedIds() : [f]);
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
      this.held.touch();
      this.say(this.fmt('{a} added to stock, {m} topped up', { a: added, m: merged }) + (bad.length ? ' · ' + bad.join('; ') : ''));
    };
    if (ids.length === 1) {
      this.inv.fromCatalog({ ...body, product: ids[0] }).subscribe({
        next: r => done(r.merged ? 0 : 1, r.merged ? 1 : 0, []),
        error: (e: HttpErrorResponse) => { this.saving.set(false); this.say(why(e, 'Could not add it.'), 'danger'); },
      });
    } else {
      this.inv.fromCatalogMany({ ...body, products: ids }).subscribe({
        next: r => { this.picked_.set(new Set()); done(r.results.filter(x => x.item && !x.merged).length, r.results.filter(x => x.merged).length,
                                                     r.results.filter(x => x.error).map(x => x.error!)); },
        error: (e: HttpErrorResponse) => { this.saving.set(false); this.say(why(e, 'Could not add them.'), 'danger'); },
      });
    }
  }

  shown = computed(() => {
    const w = fold(this.listQ()).split(/\s+/).filter(Boolean);
    if (!w.length) return this.all();
    return this.all().filter(m => { const h = fold(`${m.name} ${m.domain} ${m.notes} ${m.summary} ${m.categories.join(' ')}`); return w.every(x => h.includes(x)); });
  });
  /** The workspace's own sites: what the overview counts (built-in sources are not its sites). */
  own = computed(() => this.all().filter(m => !m.builtin));
  /** The list on the left: the built-in sources, then the workspace's own sites. */
  sideGroups = computed(() => {
    const ms = this.shown(), built = ms.filter(m => m.builtin), mine = ms.filter(m => !m.builtin);
    return [...(built.length ? [{ name: 'Built-in', makers: built }] : []), ...(mine.length ? [{ name: 'Your sites', makers: mine }] : [])];
  });
  totalProducts = computed(() => this.own().reduce((n, m) => n + m.product_count, 0));
  totalCats = computed(() => new Set(this.own().flatMap(m => m.categories)).size);
  exploredCount = computed(() => this.own().filter(m => m.explored_at).length);
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
    if (id === LCSC_MAKER) this.desk.load();
    if (!keepSearch && id !== this.mid()) { this.pq.set(''); this.cat.set(''); }
    if (id !== this.mid()) { this.picked_.set(new Set()); this.editing.set(null); this.pageUrl.set(''); }
    this.mid.set(id);
    this.view.set('maker');
    this.rows.set(200);
    if (this.maker()?.id !== id) this.maker.set(this.all().find(m => m.id === id) ?? null);
    this.api.get(id).subscribe({
      next: m => { if (this.mid() === id) this.maker.set(m); },
      error: (e: HttpErrorResponse) => { this.say(why(e, 'Could not open it.'), 'danger'); this.goHome(); },
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
            stock: this.gstock() ? 'in' : '', sort: this.gsort(), size: 60 * this.gpages(), check: this.gcheck() ? '1' : '', held: this.gheld() };
    const n = ++this.gseq;
    this.api.products(f).subscribe({ next: g => { if (n === this.gseq) this.grid.set(g); }, error: () => { if (n === this.gseq && !this.grid()) this.grid.set(null); } });
  }
  clearFilters() {
    this.pq.set(''); this.cat.set(''); this.gmaker.set(''); this.gseller.set(''); this.gmin.set(''); this.gmax.set('');
    this.gstock.set(false); this.gcheck.set(false); this.gheld.set(''); this.gpages.set(1);
  }
  asItem(p: Product, m: Pick<Maker, 'id' | 'name' | 'domain'>): GridItem {
    return { ...p, maker: { id: m.id, name: m.name, domain: m.domain } };
  }
  openDetail(p: GridItem) {
    // An LCSC part opens as the drawer's part card: pins, footprint, symbol, 3D bodies, costs.
    if (p.maker.id === LCSC_MAKER) { this.openPart(p.id); return; }
    // A McMaster-Carr part or a GrabCAD model: its page, its CAD files, what was written of it.
    if (p.linked) { this.linked.show(p.maker.id, p.linked); return; }
    this.detail.set(p);
    this.shot.set(null);
  }
  closeDetail() { this.detail.set(null); this.fix.set(null); this.src.set(false); if (this.stockFor() && this.stockFor() !== '*') this.stockFor.set(null); }

  // ---- what a price or a stock was read from, its doubts, "Wrong", and "Re-read all products"

  /** A product's doubts, its price's first. */
  doubts(p: Product): Doubt[] { return [...(p.price?.doubt ?? []), ...(p.stock_read?.doubt ?? [])]; }
  doubtTip(p: Product) { return t('Needs checking') + ':\n' + this.doubts(p).map(x => '- ' + this.doubtLine(x, p.price?.currency)).join('\n'); }
  srcName(s?: string) {
    return ({ ld: 'structured data', micro: 'microdata', meta: 'meta tags', text: 'page text', model: 'read by the model', hand: 'typed by hand' } as Record<string, string>)[s ?? ''] ?? 'page text';
  }
  private m(v: number | string | null | undefined, cur?: string) { return typeof v === 'number' ? moneyIn(v, cur || 'TRY') : String(v ?? '–'); }
  private sw(s: string | number | null | undefined) { return s === 'in' ? t('in stock') : s === 'out' ? t('out of stock') : '–'; }
  /** One doubt in words (backend/catalog_facts.py price_doubts, stock_doubts; manufacturers._hold). */
  doubtLine(x: Doubt, cur?: string): string {
    switch (x.k) {
      case 'instalment': return x.n ? this.fmt('about 1/{n} of {p}, also on the page - an instalment?', { n: x.n, p: this.m(x.other, cur) })
                                    : this.fmt('far below {p}, also on the page', { p: this.m(x.other, cur) });
      case 'lower': return this.fmt('far below {p}, also on the page', { p: this.m(x.other, cur) });
      case 'mismatch': return this.fmt('the {w} says {p}', { w: t(this.srcName(x.where)), p: this.m(x.other, cur) });
      case 'no_currency': return t('the page gives no currency');
      case 'currency_guessed': return this.fmt('no currency given: taken as {c} from the page\'s words', { c: x.cur ?? '' });
      case 'odd_currency': return this.fmt('an unusual currency: {c}', { c: x.cur ?? '' });
      case 'jump': return this.fmt((x.pct ?? 0) > 0 ? 'up {n}% since the last reading ({p})' : 'down {n}% since the last reading ({p})',
                                   { n: Math.abs(x.pct ?? 0), p: this.m(x.was, cur) });
      case 'changed_since_fix': return typeof x.fixed === 'number'
        ? this.fmt('the page changed since your correction (you said {p})', { p: this.m(x.fixed, cur) })
        : this.fmt('the page changed since your correction (you said {p})', { p: this.sw(x.fixed) + (x.fixed_qty != null ? ` (${x.fixed_qty})` : '') });
      case 'both_words': return this.fmt('the page says both "{a}" and "{b}"', { a: x.out ?? '', b: x.in ?? '' });
      case 'qty_conflict': return x.stock === 'out' ? this.fmt('out of stock, yet {n} left', { n: x.qty ?? 0 }) : t('in stock, yet none left');
      case 'stock_mismatch': return this.fmt('the structured data says {s}, the page text "{w}"', { s: this.sw(x.said), w: x.text ?? '' });
    }
    return x.k;
  }
  pageWas(what: string, meta: ReadMeta): string {
    const w = meta.page_was;
    if (!w) return '';
    if (what === 'price') return w.amount != null ? this.m(w.amount, w.currency) : t('no price');
    return w.stock ? this.sw(w.stock) + (w.qty != null ? ` (${w.qty})` : '') : t('nothing of its stock');
  }
  priceSaid(v: PriceSaid) { return v ? this.m(v.amount, v.currency) + (v.vat === 'excl' ? ' ' + t('+VAT') : '') : '–'; }
  stockSaid(v: StockSaid) { return v ? this.sw(v.stock) + (v.qty != null ? ` (${v.qty})` : '') : '–'; }

  /** "Wrong" open under the price or the stock: the right value as typed. */
  fix = signal<{ what: 'price' | 'stock'; amount: string; currency: string; vat: string; stock: string; qty: string } | null>(null);
  fixStockOpts = computed<SelectOption[]>(() => [{ value: 'in', label: t('In stock') }, { value: 'out', label: t('Out of stock') }]);
  openFix(what: 'price' | 'stock', d: GridItem) {
    if (this.fix()?.what === what) { this.fix.set(null); return; }
    this.fix.set({ what, amount: '', currency: d.price?.currency || 'TRY', vat: d.price?.vat ?? '', stock: d.stock === 'in' ? 'out' : 'in', qty: '' });
  }
  fixSet(k: 'amount' | 'qty', e: Event) { const v = (e.target as HTMLInputElement).value; this.fix.update(f => f && ({ ...f, [k]: v })); }
  fixPick(k: 'currency' | 'vat' | 'stock', v: string) { this.fix.update(f => f && ({ ...f, [k]: v })); }
  saveFix(d: GridItem) {
    const f = this.fix();
    if (!f || this.saving()) return;
    const body = f.what === 'price' ? { what: f.what, amount: f.amount.trim(), currency: f.currency, vat: f.vat }
                                    : { what: f.what, stock: f.stock, qty: f.stock === 'in' ? f.qty.trim() : '' };
    this.saving.set(true);
    this.api.correct(d.maker.id, d.id, body).subscribe({
      next: r => {
        this.saving.set(false);
        this.fix.set(null);
        if (this.detail()?.id === d.id) this.detail.set({ ...this.asItem(r.product, r.manufacturer), seller: d.seller });
        this.replace(r.manufacturer);
        this.read();
        this.say(r.case ? this.fmt('Saved. The page is kept as a test case: {f}', { f: r.case }) : t('Saved.'));
      },
      error: (e: HttpErrorResponse) => { this.saving.set(false); this.say(why(e, 'Could not save it.'), 'danger'); },
    });
  }

  /** "Re-read all products": the latest run and its report, read again every second and a half while it runs. */
  checkOpen = signal(false);
  check = signal<CatalogCheck | null>(null);
  checkLoading = signal(false);
  private checkTimer?: ReturnType<typeof setTimeout>;
  openCheck() { this.checkOpen.set(true); this.checkLoading.set(true); this.pollCheck(); }
  private pollCheck() {
    clearTimeout(this.checkTimer);
    this.api.lastCheck().subscribe({
      next: r => {
        const was = this.check()?.status;
        this.check.set(r.check); this.checkLoading.set(false);
        if (r.check?.status === 'running' && this.checkOpen()) this.checkTimer = setTimeout(() => this.pollCheck(), 1500);
        else if (was === 'running' && r.check && !r.check.dry) this.read();
      },
      error: () => this.checkLoading.set(false),
    });
  }
  checkStatus(c: CatalogCheck) {
    return c.status === 'running' ? (c.dry ? 'Comparing' : 'Reading') : c.status === 'done' ? (c.dry ? 'Compared' : 'Done')
         : c.status === 'cancelled' ? 'Stopped' : 'Failed';
  }
  startCheck(dry: boolean) {
    this.starting.set(true);
    this.api.recheck(dry).subscribe({
      next: r => { this.starting.set(false); this.check.set(r.check); this.pollCheck(); },
      error: (e: HttpErrorResponse) => { this.starting.set(false); this.say(why(e, 'Could not start it.'), 'danger'); },
    });
  }
  cancelCheck() {
    const c = this.check();
    if (c) this.api.cancelCheck(c.id).subscribe({ next: r => this.check.set(r.check), error: this.failed('Could not stop it.') });
  }
  /** A product of the report, open in full. */
  openRow(r: CheckRow) {
    this.api.get(r.maker.id).subscribe({
      next: m => { const p = (m.products ?? []).find(x => x.id === r.id); if (p) { this.checkOpen.set(false); this.openDetail(this.asItem(p, m)); } },
      error: this.failed('Could not open it.'),
    });
  }
  editFromDetail(d: GridItem) {
    this.closeDetail();
    this.openMaker(d.maker.id);
    this.openProduct(d);
  }
  /** Products picked on the grid - by drawing a box over them (marquee.ts) or
   *  Ctrl/Shift-clicking - as "makerId:productId". */
  gsel = signal<Set<string>>(new Set());
  clearSel() { this.gsel.set(new Set()); }
  keyOf(p: GridItem) { return p.maker.id + ':' + p.id; }
  cardClick(e: MouseEvent, p: GridItem) {
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      const k = this.keyOf(p);
      this.gsel.update(s => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
      return;
    }
    this.openDetail(p);
  }
  selectAllShown() {
    if (this.layout() === 'drawer') { this.gsel.set(new Set((this.view() === 'maker' ? this.makerItems() : this.homeItems()).map(i => i.key))); return; }
    const keys = [...document.querySelectorAll<HTMLElement>('.mf-grid [data-key]')].map(el => el.dataset['key']!);
    this.gsel.set(new Set(keys));
  }
  deleteSelected() {
    if (this.gselParts().length === this.gsel().size) { this.dropParts(this.gselParts()); return; }
    const by = new Map<string, string[]>();
    for (const k of this.gsel()) { const i = k.indexOf(':'); by.set(k.slice(0, i), [...(by.get(k.slice(0, i)) ?? []), k.slice(i + 1)]); }
    const n = this.gsel().size;
    this.sure(n === 1 ? t('Delete this product?') : this.fmt('Delete {n} products?', { n }), '').then(async ok => {
      if (!ok) return;
      this.saving.set(true);
      try {
        for (const [mid, ids] of by) {
          if (isLinked(mid)) { await this.linked.remove(mid, ids, false); continue; }
          const r = await new Promise<{ manufacturer: Maker }>((res, rej) => this.api.deleteProducts(mid, ids).subscribe({ next: res, error: rej }));
          this.replace(r.manufacturer);
        }
        this.gsel.set(new Set());
      } catch (e) { this.failed('Could not delete it.')(e as HttpErrorResponse); }
      this.saving.set(false);
      this.read();
    });
  }
  /** Cards per row on the grid, 0 = as many as fit - kept in this browser. */
  cols = signal<number>((() => { try { return Number(localStorage.getItem('redline.catalog.cols')) || 0; } catch { return 0; } })());
  setCols(d: number) {
    const now = this.cols() || Math.max(2, Math.round((document.querySelector('.mf-grid')?.clientWidth ?? 1100) / 240));
    const v = d === 0 ? 0 : Math.max(2, Math.min(10, now + d));
    this.cols.set(v);
    try { localStorage.setItem('redline.catalog.cols', String(v)); } catch { /* private window */ }
  }
  /** A product's right-click menu, on the grid's cards and the table's rows. */
  openMenu(e: MouseEvent, p: GridItem) {
    if (p.part) { this.partMenu(e, p); return; }
    if (p.linked) { this.linkedMenu(e, p); return; }
    const can = this.can();
    ContextMenu.open(e, [
      { label: 'Open', icon: 'right', kbd: 'Enter', run: () => this.openDetail(p) },
      !!p.url && { label: 'Open its page', icon: 'open', kbd: '↗', run: () => window.open(p.url!, '_blank', 'noopener,noreferrer') },
      can && { label: 'Edit', icon: 'edit', run: () => this.editFromDetail(p) },
      { sep: true },
      can && { label: 'Delete', icon: 'trash', kbd: 'Del', danger: true, run: () => this.deleteFromDetail(p) },
    ]);
  }
  deleteFromDetail(d: GridItem) {
    this.sure(t('Delete this product?'), d.name + (this.pfiles.of(d.maker.id, d.id)?.files ? ' - ' + t('its attached files stay in Files') : '')).then(ok => ok && this.api.deleteProducts(d.maker.id, [d.id]).subscribe({
      next: r => { this.closeDetail(); this.replace(r.manufacturer); this.read(); },
      error: this.failed('Could not delete it.'),
    }));
  }
  /** Its pictures, the main one first; those that did not load left out. */
  pics(p: Product): string[] {
    if (p.linked) { const s = this.linked.pic(p.linked); return s ? [s] : []; }
    const b = this.broken();
    // A picture attached and made the product's own comes first (product-files.ts).
    const mid = (p as GridItem).maker?.id;
    const got = [...new Set([this.pfiles.picture(mid, p.id), p.image, ...(p.images ?? [])].filter(u => !!u && !b.has(u!)))] as string[];
    // None of its own: its attached 3D model's picture.
    const solid = got.length ? null : this.pfiles.solid(mid, p.id);
    return solid && !b.has(solid) ? [solid] : got;
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
  /** The detail's "where it was read": the price's and the stock's evidence, open on asking. */
  src = signal(false);
  /** Where a price or a stock was read from - or who corrected it. */
  srcTip(what: 'price' | 'stock', meta?: ReadMeta | null): string {
    if (!meta) return '';
    if (meta.manual) {
      const was = this.pageWas(what, meta);
      return this.fmt('corrected by {p} {w}', { p: meta.by?.name || t('someone'), w: this.ago(meta.manual_at) })
        + (was ? ' · ' + this.fmt('the page said {v}', { v: was }) : '');
    }
    if (meta.snippet) return t('read from') + ' "' + meta.snippet + '" (' + t(this.srcName(meta.source)) + ')';
    return meta.source ? t(this.srcName(meta.source)) : '';
  }
  /** Every date of a product in one tooltip. */
  datesTip(d: Product): string {
    return [[t('Added to the catalog'), this.stamp(d.added_at)], [t('Price read'), this.stamp(d.price?.at)], [t('Page read'), this.stamp(d.read_at)],
            [t("Seller's update"), d.updated ? this.stamp(d.updated) : t('not given')]].map(([a, b]) => a + ': ' + b).join('\n');
  }
  /** "40 × 40 × 12.13 mm". */
  boxOf(b: number[]): string { return b.map(x => String(Math.round(x * 100) / 100)).join(' × ') + ' mm'; }
  /** The price readings as a line, oldest left: its path, its area and its range. */
  spark(p: Product): { line: string; area: string; min: number; max: number; cur: string } | null {
    const cur = p.price?.currency;
    const h = (p.history ?? []).filter(x => x.amount != null && (!cur || !x.currency || x.currency === cur));
    if (h.length < 2) return null;
    const v = h.map(x => x.amount as number), min = Math.min(...v), max = Math.max(...v), span = max - min || 1;
    const pts = v.map((y, i) => [i / (v.length - 1) * 200, 40 - (y - min) / span * 36]);
    const line = pts.map(([x, y], i) => (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1)).join(' ');
    return { line, area: line + ' L200 44 L0 44 Z', min, max, cur: cur || h[0].currency || 'TRY' };
  }
  copyText(v: string) {
    try { navigator.clipboard.writeText(v).then(() => Toast.show(this.fmt('{c} copied', { c: v })), () => {}); } catch { /* no clipboard */ }
  }
  /** The readings newest first, each with how much the price moved from the one before. */
  histRows(p: Product) {
    const h = p.history ?? [];
    return h.map((x, i) => {
      const prev = h[i - 1];
      const change = prev?.amount && x.amount != null && prev.currency === x.currency ? (x.amount - prev.amount) / prev.amount * 100 : 0;
      return { ...x, change: Math.abs(change) < 0.05 ? 0 : change };
    }).reverse();
  }
  /** A product's price in its own currency, the display currency beside it (money.ts). */
  readonly moneyIn = moneyIn;
  readonly moneyAlt = moneyAlt;
  readonly moneyTip = moneyTip;
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
      error: (e: HttpErrorResponse) => { this.starting.set(false); this.say(why(e, 'The exploration could not start.'), 'danger'); },
    });
  }

  /** The model step again on a run's kept pages - after a model failed, or with another model set. */
  readAgain(id: string, run: string) {
    if (this.starting()) return;
    this.starting.set(true);
    this.api.readAgain(id, run).subscribe({
      next: j => { this.starting.set(false); this.runs.put(j); this.showRun(j.id); },
      error: (e: HttpErrorResponse) => { this.starting.set(false); this.say(why(e, 'The pages could not be read again.'), 'danger'); },
    });
  }

  /** Only the page given, read into the catalog (added to it). */
  readPage(m: Maker) {
    const url = this.pageUrl().trim();
    if (!url || this.starting()) return;
    this.starting.set(true);
    this.api.readPage(m.id, [url], this.pageFollow(), this.choice()).subscribe({
      next: j => { this.starting.set(false); this.pageUrl.set(''); this.runs.put(j); this.showRun(j.id); },
      error: (e: HttpErrorResponse) => { this.starting.set(false); this.say(why(e, 'The page could not be read.'), 'danger'); },
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
      error: (e: HttpErrorResponse) => { this.starting.set(false); this.say(why(e, 'The page could not be read.'), 'danger'); },
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
  pfSet(k: keyof ProductFields, e: Event) { this.pfPick(k, (e.target as HTMLInputElement).value); }
  pfPick(k: keyof ProductFields, v: string) { this.pf.update(f => ({ ...f, [k]: v })); }
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
      error: (e: HttpErrorResponse) => { this.saving.set(false); this.say(why(e, 'Could not save it.'), 'danger'); },
    });
  }
  deleteProducts(m: Maker, ids: string[]) {
    if (m.view === 'drawer') { this.dropParts(ids); return; }
    if (m.view === 'linked') { this.linked.remove(m.id, ids); return; }
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
      error: (e: HttpErrorResponse) => { this.cancelling.set(false); this.say(why(e, 'Could not cancel it.'), 'danger'); },
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

  // ---- LCSC: the parts drawer as a seller (backend/catalog_lcsc.py; the work is part-desk.ts)

  // ---- the drawer's look for every page: Drawer | Grid | Table (cabinet.ts)

  readonly LCSC_MAKER = LCSC_MAKER;
  readonly partOrder = ['ICs', 'Passives', 'Discretes', 'Electromechanical', 'Frequency', 'Displays', 'Other'];
  /** The view a page was left in, kept in this browser per page (the overview, each maker);
   *  the LCSC seller opens as the drawer. */
  private pageKey = computed(() => this.view() === 'maker' ? 'm:' + (this.mid() ?? '') : 'home');
  private layoutFor = effect(() => {
    const k = this.pageKey();
    if (this.view() === 'run') return;
    untracked(() => {
      let v: string | null = null;
      try { v = localStorage.getItem('redline.catalog.layout.' + k); } catch { /* private window */ }
      if (v === 'grid' || v === 'table' || v === 'drawer') this.layout.set(v);
      else if (k === 'm:' + LCSC_MAKER) this.layout.set('drawer');
    });
  });
  setLayout(v: Layout) {
    this.layout.set(v);
    try { localStorage.setItem('redline.catalog.layout.' + this.pageKey(), v); } catch { /* private window */ }
  }
  cabinetOn = computed(() => this.layout() === 'drawer' && this.view() === 'maker');
  /** The open maker's products (what its search and category leave) as bins. */
  makerItems = computed<CabinetItem[]>(() => {
    const m = this.maker();
    return m ? this.found().map(p => p.part ? this.partBin(p, m) : p.linked ? this.linkedBin(p, m) : this.productBin(this.asItem(p, m), false)) : [];
  });
  /** The overview's products as bins, a page of them as the grid has. */
  homeItems = computed<CabinetItem[]>(() => (this.grid()?.items ?? []).map(p => this.productBin(p, true)));
  private binItems = computed(() => {
    const m = this.maker(), out = new Map<string, GridItem>();
    for (const p of this.grid()?.items ?? []) out.set(this.keyOf(p), p);
    if (m) for (const p of m.products ?? []) out.set(m.id + ':' + p.id, this.asItem(p, m));
    return out;
  });
  /** A product: its category's parent as the drawer and the child as the label in it
   *  ("3D YAZICI PARÇALARI > Bilyalı Mil ve Somunlar"), its photos, price and stock. */
  private productBin(p: GridItem, home: boolean): CabinetItem {
    const [group, ...rest] = (p.category || t('Uncategorised')).split(/\s*[>›»|/]\s*/).filter(Boolean);
    return { key: this.keyOf(p), group: group ?? t('Uncategorised'), sub: rest.join(' › ') || null, title: p.name,
             line: home ? this.sellerName(p) : p.sku || null, meta: home && p.sku ? p.sku : null,
             note: [p.price ? moneyIn(p.price.amount, p.price.currency) + (p.price.vat === 'excl' ? ' ' + t('+VAT') : '') : '', this.onHandLine(p.maker.id, p.id)].filter(Boolean).join(' · ') || null,
             stock: p.stock ?? null, thumb: { srcs: this.pics(p) }, tip: p.name };
  }
  /** An LCSC part: the drawer's group and branch, its footprint, value, part number, package, LCSC number, pins. */
  private partBin(p: Product, m: Maker): CabinetItem {
    const pt = p.part!, wired = pt.group === 'ICs' || pt.group === 'Displays' || pt.branch === 'Connectors';
    const title = (pt.value || pt.mpn || p.name).replace(/(\d)u(?=[FHΩ])/g, '$1µ');
    return { key: m.id + ':' + p.id, group: pt.group || 'Other', sub: pt.branch || null, rank: magnitude(pt.value), title,
             line: pt.value ? pt.mpn : pt.maker, line2: pt.value ? pt.maker : null, meta: this.pkg(pt.package) || null, copy: p.id,
             badge: { text: pt.has_3d ? '3D' : '2D', on: pt.has_3d, tip: pt.has_3d ? 'came with a 3D model' : 'footprint only - it will not stand on the board' },
             note: [this.onHandLine(m.id, p.id), p.price ? moneyIn(p.price.amount, p.price.currency) : '', p.stock === 'out' ? t('Out of stock')
               : p.stock_qty != null ? this.fmt('{n} at LCSC', { n: this.num(p.stock_qty) }) : ''].filter(Boolean).join(' · ') || null,
             stock: p.stock ?? null, thumb: { lcsc: p.id }, pins: wired ? p.id : null, removable: this.desk.canEdit(),
             tip: [p.part?.mpn, p.part?.maker, p.category].filter(Boolean).join(' · ') };
  }
  /** "12 pcs on hand" for a bin's line, or ''. */
  private onHandLine(mid: string, pid: string) {
    const s = this.onHand(mid, pid);
    return s ? this.fmt('{n} on hand', { n: qty(s.quantity) + ' ' + s.unit }) + (s.low ? ' - ' + t('low') : '') : '';
  }
  /** A McMaster-Carr part or a GrabCAD model: its tag as the drawer, its CAD file's picture, its key, how many. */
  private linkedBin(p: Product, m: Maker): CabinetItem {
    const l = p.linked!, src = this.linked.pic(l);
    return { key: m.id + ':' + p.id, group: l.tags[0] || t('Saved'), sub: l.tags[1] || null, title: p.name, line: l.author || null,
             copy: l.key,
             badge: { text: l.cad ? l.cad.kind.toUpperCase() : t('no CAD'), on: !!l.cad, tip: l.cad ? l.cad.name : 'no CAD file yet: download it from its page' },
             note: [this.onHandLine(m.id, p.id), l.quantity != null ? this.fmt('{n} needed', { n: l.quantity }) : '',
                    measuredBox(l.measured) + (l.measured?.mismatch?.length ? ' ≠' : '')].filter(Boolean).join(' · ') || null,
             thumb: src ? { srcs: [src], solid: true } : null, tip: [l.key, p.name].join(' · ') };
  }
  /** The open source's saved items, as its search and category leave them, for the table. */
  linkedFound = computed(() => this.found().map(p => p.linked).filter((l): l is LinkedItem => !!l));
  linkedEmpty(mid: string) { return LINKED[mid]?.empty ?? ''; }
  /** A saved item's box as its STEP measured it, and where its words say otherwise (linked_measure.py). */
  box(l: LinkedItem) { return measuredBox(l.measured, true); }
  mismatchTip = mismatchTip;
  /** A saved McMaster-Carr part's or GrabCAD model's right-click menu. */
  private linkedMenu(e: MouseEvent, p: GridItem) {
    const l = p.linked!, name = LINKED[p.maker.id]?.name ?? p.maker.name;
    ContextMenu.open(e, [
      { label: 'Open', icon: 'right', kbd: 'Enter', run: () => this.openDetail(p) },
      { label: this.fmt('Open on {s}', { s: name }), icon: 'open', kbd: '↗', run: () => window.open(l.url, '_blank', 'noopener,noreferrer') },
      { label: 'Copy', icon: 'doc', run: () => this.copyNumbers([l.key]) },
      { sep: true },
      this.linked.canEdit() && { label: 'Remove', icon: 'trash', kbd: 'Del', danger: true, run: () => this.linked.remove(p.maker.id, [l.key]) },
    ]);
  }
  cabOpen(key: string) { const p = this.binItems().get(key); if (p) this.openDetail(p); }
  togglePick(key: string) { this.gsel.update(s => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; }); }
  cabMenu(e: { event: MouseEvent; key: string }) {
    const p = this.binItems().get(e.key);
    if (p) this.openMenu(e.event, p); else e.event.preventDefault();
  }
  cabRemove(key: string) { this.dropParts([key.slice(key.indexOf(':') + 1)]); }
  canRun = () => this.auth.can('run');
  /** One part in full: the drawer's part card, over the page. */
  openPart(lcsc: string) {
    if (!this.desk.held().length) this.desk.load();
    this.desk.inspect(lcsc);
  }
  /** The LCSC seller's figures: with a 3D model, in stock, JLCPCB Basic, the last one added. */
  partStats = computed(() => {
    const ps = this.maker()?.view === 'drawer' ? this.maker()!.products ?? [] : [];
    const last = ps.reduce<Product | null>((a, p) => !a || (p.added_at ?? '') > (a.added_at ?? '') ? p : a, null);
    return { with3d: ps.filter(p => p.part?.has_3d).length, inStock: ps.filter(p => p.stock === 'in').length,
             out: ps.filter(p => p.stock === 'out').length, basic: ps.filter(p => /^basic/i.test(p.part?.jlc_class ?? '')).length, last };
  });
  /** The LCSC numbers among the grid's selection. */
  gselParts = computed(() => [...this.gsel()].filter(k => k.startsWith(LCSC_MAKER + ':')).map(k => k.slice(LCSC_MAKER.length + 1)));
  /** The package out of EasyEDA's footprint name: 0603, SOT-23-6, LQFN-56. */
  pkg(name: string | null | undefined): string {
    const k = (name || '').split('_')[0];
    return /^[RCL]\d{4}$/.test(k) ? k.slice(1) : k;
  }
  private lcscParts(ids: string[]): Product[] {
    const all = new Map<string, Product>();
    for (const p of this.maker()?.view === 'drawer' ? this.maker()!.products ?? [] : []) all.set(p.id, p);
    for (const p of this.grid()?.items ?? []) if (p.maker.id === LCSC_MAKER) all.set(p.id, p);
    return ids.map(i => all.get(i)).filter((p): p is Product => !!p);
  }
  /** Out of the drawer - asked first, saying which boards use them (part-desk.ts). */
  dropParts(ids: string[]) {
    if (!ids.length) return;
    this.desk.sureToDrop(ids).then(async ok => {
      if (!ok) return;
      this.saving.set(true);
      let gone = 0;
      for (const c of ids) if (await this.desk.drop(c)) gone++;
      this.saving.set(false);
      this.gsel.set(new Set()); this.picked_.set(new Set());
      if (gone < ids.length) this.say(this.fmt('{n} could not be removed', { n: ids.length - gone }), 'danger');
      if (this.view() === 'maker' && this.mid() === LCSC_MAKER) this.openMaker(LCSC_MAKER, true);
    });
  }
  /** The parts as a CSV: to order from, or to send someone. */
  exportParts(ids: string[]) {
    const rows = this.lcscParts(ids);
    const cell = (v: unknown) => { const x = v == null ? '' : String(v); return /[",\n]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x; };
    const head = ['LCSC', 'MPN', 'Value', 'Package', 'Manufacturer', 'Category', 'Pins', 'Price (USD)', 'LCSC stock', 'JLCPCB', '3D model'];
    const body = rows.map(p => [p.id, p.part?.mpn, p.part?.value, p.part?.package, p.part?.maker, p.category, p.part?.pins,
                                p.price?.amount, p.stock_qty, p.part?.jlc_class, p.part?.has_3d ? 'yes' : 'no'].map(cell).join(','));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([[head.join(','), ...body].join('\n') + '\n'], { type: 'text/csv' }));
    a.download = `lcsc-parts-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  copyNumbers(ids: string[]) {
    const text = ids.join(ids.length > 1 ? '\n' : '');
    const done = () => this.say(ids.length === 1 ? this.fmt('{c} copied', { c: ids[0] }) : this.fmt('{n} LCSC numbers copied', { n: ids.length }));
    try { navigator.clipboard.writeText(text).then(done, () => {}); } catch { /* no clipboard */ }
  }
  /** An LCSC part's right-click menu. */
  private partMenu(e: MouseEvent, p: GridItem) {
    ContextMenu.open(e, [
      { label: 'Open', icon: 'right', kbd: 'Enter', run: () => this.openPart(p.id) },
      !!p.url && { label: 'Open on LCSC', icon: 'open', kbd: '↗', run: () => window.open(p.url!, '_blank', 'noopener,noreferrer') },
      { label: 'Datasheet', icon: 'pdf', run: () => this.desk.openDatasheet(p.id) },
      { label: 'Copy the LCSC number', icon: 'doc', run: () => this.copyNumbers([p.id]) },
      { sep: true },
      this.desk.canEdit() && { label: 'Remove from the drawer', icon: 'trash', kbd: 'Del', danger: true, run: () => this.dropParts([p.id]) },
    ]);
  }
  /** The board room, where kept parts go onto boards. */
  toBoards() { this.picked.room.set('pcb'); }
  pct(n: number, of: number) { return of ? Math.min(100, Math.round(n / of * 100)) : 0; }
  num(n: number) { return Math.round(n).toLocaleString(LANG() === 'tr' ? 'tr-TR' : 'en-US'); }
  kb(n: number) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  /** A run's cost (dollars) in the display currency (money.ts). */
  money(v: number | null | undefined) { return shownMoney(v); }
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
  /** A word in passing: the app's toast (toast.ts). */
  private say(msg: string, tone: ToastTone = 'info') { Toast.show(msg, { tone }); }
  private failed = (fallback: string) => (e: HttpErrorResponse) => this.say(why(e, fallback));

  key(e: KeyboardEvent) {
    if (this.desk.isOpen() || this.linked.open()) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName);
    if (e.key === 'Escape' && this.gsel().size && !this.detail()) { this.gsel.set(new Set()); return; }
    if (e.key === 'Delete' && this.gsel().size && !ContextMenu.isOpen() && this.can() && !/^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName)) { this.deleteSelected(); return; }
    if (e.key === 'Escape' && this.detail() && !typing) { this.closeDetail(); return; }
    if (e.key === 'Escape' && this.checkOpen() && !typing) { this.checkOpen.set(false); return; }
    if (e.key === '/' && !typing) { e.preventDefault(); (this.gridSearch() ?? this.search()).nativeElement.focus(); }
  }

  ngOnDestroy() {
    clearInterval(this.poll); this.stopFollowing(); clearTimeout(this.checkTimer);
    this.runs.here = false;
    this.picked.mfr.set(null);
  }
}
