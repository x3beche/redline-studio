import { Component, ElementRef, Injectable, OnDestroy, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Selection } from '../selection';
import { Auth } from '../auth';
import { LANG, T, t } from '../i18n';
import { Confirm } from '../confirm';
import { DmSendButton } from '../dm';

/** Inventory ("Envanter"): what is on hand - each thing kept, how many, and
 *  where it is (backend/inventory.py).
 *
 *  The left column finds an item: words, a category, a place, only the low
 *  ones. The overview shows the figures, every item in a table that sorts
 *  by any column, and what changed last; it adds one item in a row, or
 *  several pasted as lines. An item's page has its fields to edit in place,
 *  the quantity's -/+ with the reason kept in its log, and its links to the
 *  Product Catalog product or the LCSC part it is.
 *
 *  The Chat adds and changes items too (backend/chat_tools/inventory_*.py),
 *  so the list is read again every few seconds while the tab is open.
 *
 *  Everything the page shows is in its address (?item=, ?iq=, ?icat=,
 *  ?iloc=, ?low=1), so a reload comes back to the same place.
 */
export interface CatalogLink {
  manufacturer: string; manufacturer_name?: string; product: string; product_name?: string; url?: string; sku?: string;
}
export interface LogLine {
  id: string; at: string; by: { id?: string; name?: string }; kind: 'added' | 'merged' | 'adjusted' | 'edited';
  delta?: number; after?: number; reason?: string; fields?: string[]; filled?: string[]; changes?: Record<string, [unknown, unknown]>;
}
export interface Item {
  id: string; name: string; quantity: number; unit: string; location: string; category: string; mpn: string; lcsc: string;
  manufacturer: string; board: string; min_stock: number | null; price: number | null; currency: string; notes: string;
  tags: string[]; catalog: CatalogLink | null; by: { id?: string; name?: string }; created_at: string;
  updated_by: { id?: string; name?: string }; updated_at: string; low: boolean; value: number | null;
  last: LogLine | null; log?: LogLine[];
}
export type NewItem = Partial<Omit<Item, 'id' | 'catalog'>> & { name: string; catalog?: { manufacturer: string; product: string } | null };
export interface CatalogStock { quantity: number; unit: string; items: string[]; low: boolean }
export interface FromCatalog { manufacturer: string; quantity: number; unit: string; location: string; note: string }
interface Added { item?: Item; merged?: boolean; error?: string; name?: string }
interface Maker { id: string; name: string; product_count: number; products?: { id: string; name: string; sku: string; url: string }[] }

/** The units offered (backend/inventory.py UNITS); any other short word is kept as written. */
export const UNITS = ['pcs', 'm', 'cm', 'mm', 'kg', 'g', 'l', 'ml', 'roll', 'reel', 'box', 'pack', 'set', 'pair', 'sheet', 'bag'];
export const CURRENCIES = ['TRY', 'USD', 'EUR', 'GBP', 'CNY'];
type FormKey = 'name' | 'quantity' | 'unit' | 'location' | 'category' | 'mpn' | 'lcsc' | 'min';
type SortKey = 'name' | 'quantity' | 'location' | 'category' | 'mpn' | 'min_stock' | 'price' | 'value' | 'updated_at';

@Injectable({ providedIn: 'root' })
export class InventoryApi {
  private http = inject(HttpClient);
  list() { return this.http.get<Item[]>('/api/inventory'); }
  get(id: string) { return this.http.get<Item>(`/api/inventory/${id}`); }
  create(b: NewItem & { reason?: string; merge?: boolean }) { return this.http.post<{ item: Item; merged: boolean }>('/api/inventory', b); }
  bulk(items: NewItem[], reason = '') { return this.http.post<{ results: Added[] }>('/api/inventory/bulk', { items, reason }); }
  patch(id: string, p: Record<string, unknown>) { return this.http.patch<Item>(`/api/inventory/${id}`, p); }
  adjust(id: string, delta: number, reason: string) { return this.http.post<Item>(`/api/inventory/${id}/adjust`, { delta, reason }); }
  remove(id: string) { return this.http.delete(`/api/inventory/${id}`); }
  removeMany(ids: string[]) { return this.http.post<{ deleted: string[] }>('/api/inventory/bulk-delete', { ids }); }
  exportFile(ids: string[] = []) { return this.http.get<unknown>(`/api/inventory/export?ids=${encodeURIComponent(ids.join(','))}`); }
  importFile(data: unknown) { return this.http.post<{ added: number; merged: number; skipped: { name: string; error: string }[] }>('/api/inventory/import', data); }
  /** What is on hand of each product of one catalog, in one read (backend/inventory.py stock_of). */
  stock(manufacturer: string) { return this.http.get<Record<string, CatalogStock>>(`/api/inventory/stock?manufacturer=${encodeURIComponent(manufacturer)}`); }
  /** A catalog product into stock: a linked item, or the one already linked topped up. */
  fromCatalog(b: FromCatalog & { product: string }) { return this.http.post<{ item: Item; merged: boolean }>('/api/inventory/from-catalog', b); }
  fromCatalogMany(b: FromCatalog & { products: string[] }) {
    return this.http.post<{ results: { product: string; item?: Item; merged?: boolean; error?: string }[] }>('/api/inventory/from-catalog/bulk', b);
  }
  makers() { return this.http.get<Maker[]>('/api/manufacturers'); }
  maker(id: string) { return this.http.get<Maker>(`/api/manufacturers/${id}`); }
}

/** The words of a search, folded as the server folds them (accents and Turkish letters away). */
function fold(s: string): string {
  return (s || '').replace(/[ıİ]/g, 'i').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

/** 4, 2.5 - a quantity without a needless .0. */
export function qty(v: number | null | undefined): string {
  if (v == null) return '–';
  return Number.isInteger(v) ? v.toLocaleString(LANG() === 'tr' ? 'tr-TR' : 'en-US')
    : v.toLocaleString(LANG() === 'tr' ? 'tr-TR' : 'en-US', { maximumFractionDigits: 3 });
}

function when(iso: string | null | undefined): string {
  if (!iso) return '–';
  const d = new Date(iso), now = new Date(), loc = LANG() === 'tr' ? 'tr-TR' : [];
  const days = Math.floor((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86400000);
  if (days === 0) return d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
  if (days < 7) return d.toLocaleDateString(loc, { weekday: 'short' }) + ' ' + d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString(loc, { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

function why(e: HttpErrorResponse, fallback: string): string {
  const d = e.error?.detail;
  if (typeof d === 'string') return d;
  if (Array.isArray(d) && d[0]?.msg) return String(d[0].msg);
  return t(fallback);
}

/** A number as a person types it: "2,5" is 2.5. */
function num(s: string): number | null {
  const v = Number(String(s ?? '').trim().replace(',', '.'));
  return String(s ?? '').trim() && Number.isFinite(v) ? v : null;
}

/** Asking before something is lost, in the app's own question box. */
function sure(title: string, text = ''): Promise<boolean> {
  return Confirm.ask({ title, text: text || undefined, ok: t('Delete'), danger: true });
}

/** One pasted line read: "name, qty, unit, location" (tabs from a sheet
 *  work too), or "10 M3 nuts" / "M3 nut x10" with no commas. */
export function parseLine(line: string): { name: string; quantity: number; unit: string; location: string; error?: string } | null {
  const raw = line.trim();
  if (!raw || raw.startsWith('#')) return null;
  const cells = (raw.includes('\t') ? raw.split('\t') : raw.split(/[;,]/)).map(c => c.trim());
  let [name = '', q = '', unit = '', location = ''] = cells;
  if (cells.length > 4) location = cells.slice(3).join(', ');
  if (cells.length === 1) {
    const lead = /^(\d+(?:[.,]\d+)?)\s*(?:x|×)?\s+(.+)$/i.exec(name);
    const tail = /^(.+?)\s+(?:x|×)\s*(\d+(?:[.,]\d+)?)$/i.exec(name);
    if (lead) { q = lead[1]; name = lead[2]; } else if (tail) { name = tail[1]; q = tail[2]; }
  }
  // "2 m" or "2m" in the quantity's cell: the unit with it.
  const qu = /^(\d+(?:[.,]\d+)?)\s*([^\d\s].*)$/.exec(q);
  if (qu && !unit) { q = qu[1]; unit = qu[2]; }
  const n = q ? num(q) : 1;
  const out = { name, quantity: n ?? 0, unit: unit || 'pcs', location };
  if (!name) return { ...out, error: 'no name' };
  if (n == null || n < 0) return { ...out, error: 'the quantity is not a number' };
  return out;
}

@Component({
  selector: 'app-room-inventory',
  imports: [T, DmSendButton],
  styleUrls: ['../settings.css', './taste.css', './manufacturers.css', './inventory.css'],
  host: { '(document:keydown)': 'key($event)' },
  template: `
<div class="tcv-room absolute inset-0 flex min-h-0 gap-1 p-1">
  <!-- LEFT: finding an item -->
  <aside class="tcv-notes-side">
    <div class="tcv-notes-find">
      <input #search class="tcv-notes-search" [placeholder]="'Search the inventory   /' | t" [value]="listQ()"
             (input)="listQ.set($any($event.target).value)" (keydown.escape)="listQ.set(''); $any($event.target).blur()">
    </div>
    <div class="inv-filters">
      <select class="tst-sel" [value]="fCat()" (change)="fCat.set($any($event.target).value)" [attr.aria-label]="'Category' | t">
        <option value="">{{ 'All categories' | t }}</option>
        @for (c of categories(); track c) { <option [value]="c" [selected]="c === fCat()">{{ c }}</option> }
      </select>
      <select class="tst-sel" [value]="fLoc()" (change)="fLoc.set($any($event.target).value)" [attr.aria-label]="'Location' | t">
        <option value="">{{ 'All places' | t }}</option>
        @for (l of locations(); track l) { <option [value]="l" [selected]="l === fLoc()">{{ l }}</option> }
      </select>
      <button class="tcv-btn inv-lowbtn" [attr.data-on]="fLow() ? 1 : null" (click)="fLow.set(!fLow())"
              [title]="'Only items at or below their minimum' | t">{{ 'Low' | t }} <b>{{ stats().low }}</b></button>
    </div>
    @if (can()) {
      <div class="inv-side-acts">
        <button class="tcv-btn" (click)="goAdd()">{{ 'Add an item' | t }}</button>
        <button class="tcv-btn" (click)="goPaste()">{{ 'Paste a list' | t }}</button>
        <button class="tcv-btn" (click)="importIn.click()" [title]="'Add the items of a file someone sent you' | t">{{ 'Import…' | t }}</button>
        <input #importIn type="file" accept=".json,application/json" hidden (change)="importFile($any($event.target))">
      </div>
    }
    <div class="tcv-notes-list">
      @if (!filtering()) {
        <button class="tcv-notes-item tsh-ov" [attr.data-on]="!iid() ? 1 : null" (click)="goHome()">
          <span class="tcv-notes-item-top">
            <span class="tcv-notes-item-title">{{ 'Overview' | t }}</span>
            <span class="tcv-notes-item-when">{{ fmt('{n} items · {l} low', { n: all().length, l: stats().low }) }}</span>
          </span>
        </button>
      }
      @for (i of shown(); track i.id) {
        <button class="tcv-notes-item" [attr.data-on]="i.id === iid() ? 1 : null" (click)="openItem(i.id)">
          <span class="tcv-notes-item-top">
            <span class="tcv-notes-item-title">{{ i.name }}</span>
            <span class="inv-side-qty" [attr.data-low]="i.low ? 1 : null">{{ qty(i.quantity) }} {{ i.unit }}</span>
          </span>
          <span class="tcv-notes-item-meta inv-side-meta">
            <span class="inv-side-loc">{{ i.location || ('no place' | t) }}</span>
            @if (i.quantity <= 0) { <span class="st-tag" data-tone="danger">{{ 'out of stock' | t }}</span> }
            @else if (i.low) { <span class="st-tag" data-tone="warn">{{ 'low' | t }}</span> }
          </span>
        </button>
      } @empty {
        <p class="tcv-notes-empty">{{ (filtering() ? 'Nothing matches.' : 'Nothing on hand yet.') | t }}</p>
      }
    </div>
    @if (filtering()) {
      <div class="inv-side-foot"><span>{{ fmt('{n} of {m}', { n: shown().length, m: all().length }) }}</span>
        <button class="st-more" (click)="clearFilters()">{{ 'Clear' | t }}</button></div>
    }
  </aside>

  <section class="tcv-notes-main tst inv">
    @if (flash(); as f) { <p class="tcv-note-flash">{{ f }}</p> }

    @if (iid()) {
      @if (item(); as it) {
      <!-- ================= one item ================= -->
      <header class="tst-head">
        <div class="tst-title">
          <input class="tst-name" [value]="it.name" [readonly]="!can()" (change)="save(it, 'name', $any($event.target).value)"
                 (keydown.enter)="$any($event.target).blur()" [attr.aria-label]="'Name' | t">
          <span class="st-sub">{{ fmt('added by {p} {w}', { p: it.by.name || t('someone'), w: when(it.created_at) }) }}
            · {{ fmt('changed by {p} {w}', { p: it.updated_by.name || t('someone'), w: when(it.updated_at) }) }}</span>
        </div>
        <div class="tst-acts">
          <button class="tcv-btn" (click)="exportItems([it])" [title]="'Save it as a file to send to someone' | t">{{ 'Export' | t }}</button>
          <rl-dm-send-btn kind="inventory" [id]="it.id" [label]="it.name" cls="tcv-btn tcv-dm-sendbtn" />
          @if (can()) { <button class="tcv-btn tst-del" (click)="remove(it)">{{ 'Delete' | t }}</button> }
          <button class="tcv-btn" (click)="goHome()">{{ 'Overview' | t }}</button>
        </div>
      </header>

      <!-- the quantity, and changing it with a reason -->
      <div class="inv-qrow">
        <div class="inv-qbig" [attr.data-low]="it.low ? 1 : null" [attr.data-out]="it.quantity <= 0 ? 1 : null">
          <b>{{ qty(it.quantity) }}</b><span>{{ it.unit }}</span>
          @if (it.quantity <= 0) { <span class="st-tag" data-tone="danger">{{ 'out of stock' | t }}</span> }
          @else if (it.low) { <span class="st-tag" data-tone="warn">{{ fmt('low - minimum {n}', { n: qty(it.min_stock) }) }}</span> }
        </div>
        @if (can()) {
          <div class="inv-adjust">
            <button class="tcv-btn inv-pm" (click)="adjust(it, -1)" [disabled]="busy()" [title]="'Take this many' | t">−</button>
            <input class="tst-in inv-step" [value]="step()" (input)="step.set($any($event.target).value)" inputmode="decimal"
                   [attr.aria-label]="'How many' | t" (keydown.enter)="adjust(it, 1)">
            <button class="tcv-btn inv-pm" (click)="adjust(it, 1)" [disabled]="busy()" [title]="'Add this many' | t">+</button>
            <input #reasonBox class="tst-in inv-reason" [placeholder]="'Why - e.g. used 4 for the fan board' | t" [value]="reason()"
                   (input)="reason.set($any($event.target).value)" (keydown.enter)="adjust(it, -1)" [attr.aria-label]="'Reason' | t">
            <span class="st-sub inv-hint">{{ 'Enter in the reason takes; in the amount adds.' | t }}</span>
          </div>
        }
      </div>

      <!-- every field, in place -->
      <div class="inv-fields">
        <label><span>{{ 'Unit' | t }}</span>
          <input class="tst-in" list="inv-units" [value]="it.unit" [readonly]="!can()" (change)="save(it, 'unit', $any($event.target).value)"></label>
        <label><span>{{ 'Location' | t }}</span>
          <input class="tst-in" list="inv-locs" [value]="it.location" [readonly]="!can()" [placeholder]="can() ? ('Shelf, bin, box' | t) : ''"
                 (change)="save(it, 'location', $any($event.target).value)"></label>
        <label><span>{{ 'Category' | t }}</span>
          <input class="tst-in" list="inv-cats" [value]="it.category" [readonly]="!can()" (change)="save(it, 'category', $any($event.target).value)"></label>
        <label><span>{{ 'Minimum' | t }}</span>
          <input class="tst-in" inputmode="decimal" [value]="it.min_stock ?? ''" [readonly]="!can()" [placeholder]="can() ? ('none' | t) : ''"
                 (change)="saveNum(it, 'min_stock', $any($event.target).value)"></label>
        <label><span>{{ 'MPN' | t }}</span>
          <input class="tst-in mono" [value]="it.mpn" [readonly]="!can()" (change)="save(it, 'mpn', $any($event.target).value)"></label>
        <label><span>{{ 'LCSC' | t }}</span>
          <input class="tst-in mono" [value]="it.lcsc" [readonly]="!can()" placeholder="C25744" (change)="save(it, 'lcsc', $any($event.target).value)"></label>
        <label><span>{{ 'Manufacturer' | t }}</span>
          <input class="tst-in" [value]="it.manufacturer" [readonly]="!can()" (change)="save(it, 'manufacturer', $any($event.target).value)"></label>
        <label><span>{{ 'For (board or model)' | t }}</span>
          <input class="tst-in" [value]="it.board" [readonly]="!can()" (change)="save(it, 'board', $any($event.target).value)"></label>
        <label><span>{{ 'Unit price' | t }}</span>
          <span class="inv-price">
            <input class="tst-in" inputmode="decimal" [value]="it.price ?? ''" [readonly]="!can()" (change)="saveNum(it, 'price', $any($event.target).value)">
            <input class="tst-in inv-cur" list="inv-curs" [value]="it.currency" [readonly]="!can()" placeholder="TRY" (change)="save(it, 'currency', $any($event.target).value)">
          </span></label>
        <label><span>{{ 'Value' | t }}</span><b class="inv-val">{{ it.value != null ? money(it.value, it.currency) : '–' }}</b></label>
        <label class="inv-wide"><span>{{ 'Tags' | t }}</span>
          <input class="tst-in" [value]="it.tags.join(', ')" [readonly]="!can()" [placeholder]="can() ? ('comma separated' | t) : ''"
                 (change)="save(it, 'tags', $any($event.target).value)"></label>
        <label class="inv-full"><span>{{ 'Notes' | t }}</span>
          <textarea class="tst-in inv-notes" rows="2" [value]="it.notes" [readonly]="!can()" (change)="save(it, 'notes', $any($event.target).value)"></textarea></label>
      </div>

      <!-- what it is elsewhere in the app -->
      <div class="inv-links">
        <span class="mf-label">{{ 'Links' | t }}</span>
        @if (it.catalog; as c) {
          <span class="inv-link"><em>{{ 'Product Catalog' | t }}</em>
            <button class="st-more inv-go" (click)="toCatalog(c)">{{ c.manufacturer_name || c.manufacturer }}{{ c.product_name ? ' / ' + c.product_name : '' }}</button>
            @if (c.url) { <a class="mf-link" [href]="c.url" target="_blank" rel="noopener noreferrer">{{ 'Page' | t }}</a> }
            @if (can()) { <button class="st-more inv-unlink" (click)="unlinkCatalog(it)" [title]="'Remove the link' | t">×</button> }</span>
        }
        @if (it.lcsc) {
          <span class="inv-link"><em>LCSC</em>
            <button class="st-more inv-go" (click)="toPart(it.lcsc)" [title]="'Open it in the PCB room\\'s parts' | t">{{ it.lcsc }}</button>
            <a class="mf-link" [href]="'https://www.lcsc.com/product-detail/' + it.lcsc + '.html'" target="_blank" rel="noopener noreferrer">lcsc.com</a></span>
        }
        @if (!it.catalog && !it.lcsc) { <span class="st-sub">{{ 'Not linked to a catalog product or an LCSC part.' | t }}</span> }
        @if (can() && !it.catalog) {
          <span class="inv-linker">
            <select class="tst-sel" [value]="linkMaker()" (change)="pickMaker($any($event.target).value)" [attr.aria-label]="'Manufacturer' | t">
              <option value="">{{ 'Link a catalog product…' | t }}</option>
              @for (m of makers(); track m.id) { <option [value]="m.id">{{ m.name }} ({{ m.product_count }})</option> }
            </select>
            @if (linkMaker()) {
              <input class="tst-in" list="inv-products" [placeholder]="'Product name or code' | t" (change)="linkProduct(it, $any($event.target).value)">
              <datalist id="inv-products">@for (p of linkProducts(); track p.id) { <option [value]="p.name + (p.sku ? ' · ' + p.sku : '')"></option> }</datalist>
            }
          </span>
        }
      </div>

      <!-- what happened to it -->
      <section class="st-card">
        <div class="st-card-head"><h3>{{ 'Change log' | t }}</h3>
          <span class="st-sub">{{ fmt('{n} entries, newest first', { n: it.log?.length ?? 0 }) }}</span></div>
        <div class="st-table-wrap">
          <table class="st-table inv-log">
            <thead><tr><th>{{ 'When' | t }}</th><th>{{ 'What' | t }}</th><th class="r">{{ 'Change' | t }}</th><th class="r">{{ 'After' | t }}</th>
              <th>{{ 'Reason' | t }}</th><th>{{ 'By' | t }}</th></tr></thead>
            <tbody>
              @for (l of it.log ?? []; track l.id) {
                <tr>
                  <td class="dim nowrap">{{ when(l.at) }}</td>
                  <td>{{ kindName(l.kind) | t }}@if (l.fields?.length) { <span class="dim"> · {{ l.fields!.join(', ') }}</span> }</td>
                  <td class="r mono" [attr.data-sign]="l.delta == null ? null : l.delta < 0 ? '-' : '+'">{{ l.delta == null ? '' : (l.delta > 0 ? '+' : '') + qty(l.delta) }}</td>
                  <td class="r mono">{{ l.after == null ? '' : qty(l.after) }}</td>
                  <td class="give">{{ l.reason || changeLine(l) }}</td>
                  <td class="dim">{{ l.by.name || ('someone' | t) }}</td>
                </tr>
              } @empty { <tr><td colspan="6" class="dim">{{ 'Nothing yet.' | t }}</td></tr> }
            </tbody>
          </table>
        </div>
      </section>
      } @else if (itemError(); as e) {
        <div class="st-banner tst-banner" role="alert"><span>{{ e }}</span><button class="tcv-btn" (click)="goHome()">{{ 'Overview' | t }}</button></div>
      } @else { <p class="st-hint">{{ 'Loading…' | t }}</p> }

    } @else {
      <!-- ================= the overview ================= -->
      <header class="tst-head tsh-head">
        <div class="tst-title">
          <h2>{{ 'Inventory' | t }}</h2>
          <span class="st-sub">{{ 'What you have on hand, how many and where. Chat adds and changes items too when you tell it.' | t }}</span>
        </div>
        <div class="tst-acts">
          @if (all().length) { <button class="tcv-btn" (click)="exportItems([])" [title]="'Save every item as a file' | t">{{ 'Export all' | t }}</button> }
        </div>
      </header>
      <div class="st-tiles inv-tiles">
        <div class="st-tile" [attr.data-tone]="all().length ? null : 'dim'"><span>{{ 'Items' | t }}</span><b>{{ all().length }}</b>
          <small>{{ fmt('in {n} categories, {p} places', { n: categories().length, p: locations().length }) }}</small></div>
        <div class="st-tile" [attr.data-tone]="stats().low ? 'warn' : 'dim'"><span>{{ 'Low stock' | t }}</span><b>{{ stats().low }}</b>
          <small>{{ fmt('{n} with a minimum set', { n: stats().withMin }) }}</small></div>
        <div class="st-tile" [attr.data-tone]="stats().out ? 'danger' : 'dim'"><span>{{ 'Out of stock' | t }}</span><b>{{ stats().out }}</b>
          <small>{{ 'none left' | t }}</small></div>
        <div class="st-tile inv-units"><span>{{ 'On hand' | t }}</span><b [title]="stats().unitsLine">{{ stats().unitsLine || '–' }}</b>
          <small>{{ fmt('{n} kinds of unit', { n: stats().unitKinds }) }}</small></div>
        <div class="st-tile inv-value" [attr.data-tone]="stats().valueLine ? null : 'dim'"><span>{{ 'Value' | t }}</span><b [title]="stats().valueLine">{{ stats().valueLine || '–' }}</b>
          <small>{{ fmt('{n} items priced', { n: stats().priced }) }}</small></div>
        <div class="st-tile" [attr.data-tone]="recent().length ? null : 'dim'"><span>{{ 'Last change' | t }}</span><b>{{ recent().length ? when(recent()[0].updated_at) : '–' }}</b>
          <small>{{ recent().length ? recent()[0].name + ' · ' + (recent()[0].updated_by.name || '') : ('none yet' | t) }}</small></div>
      </div>

      @if (can()) {
        <section class="st-card" id="inv-add">
          <div class="st-card-head"><h3>{{ 'Add an item' | t }}</h3>
            <span class="st-sub">{{ 'the same name or part number already kept is topped up, not doubled' | t }}</span>
            <span class="st-right"><button class="st-more" (click)="pasting.set(!pasting())">{{ (pasting() ? 'One item' : 'Paste a list') | t }}</button></span></div>
          <div class="st-card-body">
            @if (!pasting()) {
              <div class="inv-addrow">
                <input #addName class="tst-in inv-a-name" [placeholder]="'Name' | t" [value]="form().name" (input)="setF('name', $any($event.target).value)" (keydown.enter)="add()" [attr.aria-label]="'Name' | t">
                <input class="tst-in inv-a-qty" inputmode="decimal" [placeholder]="'Qty' | t" [value]="form().quantity" (input)="setF('quantity', $any($event.target).value)" (keydown.enter)="add()" [attr.aria-label]="'Quantity' | t">
                <input class="tst-in inv-a-unit" list="inv-units" [placeholder]="'pcs'" [value]="form().unit" (input)="setF('unit', $any($event.target).value)" (keydown.enter)="add()" [attr.aria-label]="'Unit' | t">
                <input class="tst-in" list="inv-locs" [placeholder]="'Location' | t" [value]="form().location" (input)="setF('location', $any($event.target).value)" (keydown.enter)="add()" [attr.aria-label]="'Location' | t">
                <input class="tst-in" list="inv-cats" [placeholder]="'Category' | t" [value]="form().category" (input)="setF('category', $any($event.target).value)" (keydown.enter)="add()" [attr.aria-label]="'Category' | t">
                <input class="tst-in mono" [placeholder]="'MPN' | t" [value]="form().mpn" (input)="setF('mpn', $any($event.target).value)" (keydown.enter)="add()" [attr.aria-label]="'MPN' | t">
                <input class="tst-in mono inv-a-lcsc" placeholder="LCSC C…" [value]="form().lcsc" (input)="setF('lcsc', $any($event.target).value)" (keydown.enter)="add()" [attr.aria-label]="'LCSC' | t">
                <input class="tst-in inv-a-min" inputmode="decimal" [placeholder]="'Min' | t" [value]="form().min" (input)="setF('min', $any($event.target).value)" (keydown.enter)="add()" [attr.aria-label]="'Minimum' | t">
                <button class="tcv-btn tcv-btn-accent" (click)="add()" [disabled]="busy()">{{ 'Add' | t }}</button>
              </div>
              @if (addError(); as e) { <p class="st-hint mf-err">{{ e }}</p> }
            } @else {
              <div class="inv-paste">
                <textarea #pasteBox class="tst-in inv-pastebox" rows="5" [value]="pasted()" (input)="pasted.set($any($event.target).value)"
                          [placeholder]="'One item a line: name, quantity, unit, location\\nM3x8 screw, 200, pcs, Shelf A / bin 3\\nHeat shrink 3 mm, 2, m, Drawer 2\\n10 IRL540N' | t"></textarea>
                <div class="inv-pastepre">
                  @if (parsed().length) {
                    <div class="st-table-wrap inv-prewrap">
                      <table class="st-table">
                        <thead><tr><th>{{ 'Name' | t }}</th><th class="r">{{ 'Qty' | t }}</th><th>{{ 'Unit' | t }}</th><th>{{ 'Location' | t }}</th><th></th></tr></thead>
                        <tbody>
                          @for (p of parsed(); track $index) {
                            <tr [attr.data-bad]="p.error ? 1 : null">
                              <td class="give">{{ p.name || '–' }}</td><td class="r mono">{{ qty(p.quantity) }}</td><td>{{ p.unit }}</td>
                              <td class="dim">{{ p.location || '–' }}</td>
                              <td class="r">@if (p.error) { <span class="mf-err">{{ p.error | t }}</span> } @else if (existing(p); as e) { <span class="st-tag" data-tone="accent" [title]="fmt('{n} on hand now', { n: qty(e.quantity) + ' ' + e.unit })">{{ 'tops up' | t }}</span> } @else { <span class="st-tag" data-tone="ok">{{ 'new' | t }}</span> }</td>
                            </tr>
                          }
                        </tbody>
                      </table>
                    </div>
                  } @else { <p class="st-hint">{{ 'The lines are read here before anything is added.' | t }}</p> }
                  <div class="inv-pasteacts">
                    <input class="tst-in" [placeholder]="'Reason for the log (optional)' | t" [value]="pasteReason()" (input)="pasteReason.set($any($event.target).value)">
                    <button class="tcv-btn tcv-btn-accent" (click)="addPasted()" [disabled]="busy() || !goodParsed().length">{{ fmt('Add {n} items', { n: goodParsed().length }) }}</button>
                  </div>
                </div>
              </div>
            }
          </div>
        </section>
      }

      @if (all().length) {
        <section class="st-card">
          <div class="st-card-head"><h3>{{ 'All items' | t }}</h3>
            <span class="st-sub">{{ filtering() ? fmt('{n} of {m} - filtered on the left', { n: shown().length, m: all().length }) : fmt('{n} items', { n: all().length }) }}</span>
            <span class="st-right">
              @if (picked().size) {
                <span class="st-sub">{{ fmt('{n} selected', { n: picked().size }) }}</span>
                <button class="tcv-btn" (click)="exportItems(selectedItems())">{{ 'Export' | t }}</button>
                @if (can()) { <button class="tcv-btn tst-del" (click)="removeSelected()">{{ 'Delete' | t }}</button> }
                <button class="st-more" (click)="clearPicked()">{{ 'Clear' | t }}</button>
              }
            </span></div>
          <div class="st-table-wrap">
            <table class="st-table inv-table">
              <thead><tr>
                <th class="inv-ck"><input type="checkbox" [checked]="allPicked()" (change)="pickAll($any($event.target).checked)" [attr.aria-label]="'Select all' | t"></th>
                @for (c of columns; track c.key) {
                  <th [class.r]="c.r" class="inv-sort" [attr.data-on]="sortKey() === c.key ? sortDir() : null" (click)="sortBy(c.key)">{{ c.label | t }}</th>
                }
              </tr></thead>
              <tbody>
                @for (i of sorted(); track i.id) {
                  <tr (click)="openItem(i.id)" [attr.data-low]="i.low ? 1 : null">
                    <td class="inv-ck" (click)="$event.stopPropagation()"><input type="checkbox" [checked]="picked().has(i.id)" (change)="pick(i.id, $any($event.target).checked)"></td>
                    <td class="inv-name"><b>{{ i.name }}</b>@if (i.catalog) { <span class="inv-mark" [title]="'Linked to the Product Catalog' | t">CAT</span> }@if (i.lcsc) { <span class="inv-mark mono">{{ i.lcsc }}</span> }</td>
                    <td class="r mono inv-q" [attr.data-low]="i.low ? 1 : null">{{ qty(i.quantity) }} <span class="dim">{{ i.unit }}</span></td>
                    <td class="give-s">{{ i.location || '–' }}</td>
                    <td class="dim">{{ i.category || '–' }}</td>
                    <td class="mono dim">{{ i.mpn || '–' }}</td>
                    <td class="r mono dim">{{ i.min_stock == null ? '–' : qty(i.min_stock) }}</td>
                    <td class="r mono">{{ i.price == null ? '–' : money(i.price, i.currency) }}</td>
                    <td class="r mono">{{ i.value == null ? '–' : money(i.value, i.currency) }}</td>
                    <td class="r dim nowrap">{{ when(i.updated_at) }}</td>
                  </tr>
                } @empty { <tr><td colspan="10" class="dim">{{ 'Nothing matches.' | t }}</td></tr> }
              </tbody>
            </table>
          </div>
        </section>

        <section class="st-card">
          <div class="st-card-head"><h3>{{ 'Recently changed' | t }}</h3>
            <span class="st-sub">{{ 'the last thing that happened to each' | t }}</span></div>
          <div class="st-table-wrap">
            <table class="st-table inv-recent">
              <tbody>
                @for (i of recent().slice(0, 8); track i.id) {
                  <tr (click)="openItem(i.id)">
                    <td class="dim nowrap">{{ when(i.updated_at) }}</td>
                    <td><b class="tsh-pname">{{ i.name }}</b></td>
                    <td>{{ (i.last ? kindName(i.last.kind) : '') | t }}</td>
                    <td class="r mono" [attr.data-sign]="i.last?.delta == null ? null : i.last!.delta! < 0 ? '-' : '+'">{{ i.last?.delta == null ? '' : (i.last!.delta! > 0 ? '+' : '') + qty(i.last!.delta!) }}</td>
                    <td class="r mono">{{ qty(i.quantity) }} <span class="dim">{{ i.unit }}</span></td>
                    <td class="give">{{ i.last?.reason || (i.last ? changeLine(i.last) : '') }}</td>
                    <td class="dim">{{ i.updated_by.name || '' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      } @else if (loaded()) {
        <section class="st-card tsh-how">
          <div class="st-card-head"><h3>{{ 'How it works' | t }}</h3></div>
          <ol class="tsh-steps">
            <li><span class="tsh-n">1</span><div><b>{{ 'Add what you have' | t }}</b>
              <p>{{ 'One item in the row above, or paste a list - name, quantity, unit, place - one a line.' | t }}</p></div></li>
            <li><span class="tsh-n">2</span><div><b>{{ 'Or tell the Chat' | t }}</b>
              <p>{{ '"I got 200 M3x8 screws, they are on shelf A" - it adds them, or tops up the ones already kept.' | t }}</p></div></li>
            <li><span class="tsh-n">3</span><div><b>{{ 'Take what you use' | t }}</b>
              <p>{{ 'An item\\'s - and + keep the reason: "used 4 for the fan board". Set a minimum to see what runs low.' | t }}</p></div></li>
          </ol>
        </section>
      }
    }
  </section>
</div>
<datalist id="inv-units">@for (u of units(); track u) { <option [value]="u"></option> }</datalist>
<datalist id="inv-locs">@for (l of locations(); track l) { <option [value]="l"></option> }</datalist>
<datalist id="inv-cats">@for (c of categories(); track c) { <option [value]="c"></option> }</datalist>
<datalist id="inv-curs">@for (c of currencies; track c) { <option [value]="c"></option> }</datalist>`,
})
export class RoomInventory implements OnDestroy {
  private api = inject(InventoryApi);
  private sel = inject(Selection);
  private auth = inject(Auth);
  private search = viewChild.required<ElementRef<HTMLInputElement>>('search');
  private addName = viewChild<ElementRef<HTMLInputElement>>('addName');
  private pasteBox = viewChild<ElementRef<HTMLTextAreaElement>>('pasteBox');
  private reasonBox = viewChild<ElementRef<HTMLInputElement>>('reasonBox');

  can = computed(() => this.auth.can('draw'));
  readonly currencies = CURRENCIES;
  readonly columns: { key: SortKey; label: string; r?: boolean }[] = [
    { key: 'name', label: 'Name' }, { key: 'quantity', label: 'Quantity', r: true }, { key: 'location', label: 'Location' },
    { key: 'category', label: 'Category' }, { key: 'mpn', label: 'MPN' }, { key: 'min_stock', label: 'Min', r: true },
    { key: 'price', label: 'Unit price', r: true }, { key: 'value', label: 'Value', r: true }, { key: 'updated_at', label: 'Changed', r: true },
  ];

  /** Where the page is, from the address and kept in it. */
  private url = new URLSearchParams(location.search);
  iid = signal<string | null>(this.url.get('item'));
  listQ = signal(this.url.get('iq') ?? '');
  fCat = signal(this.url.get('icat') ?? '');
  fLoc = signal(this.url.get('iloc') ?? '');
  fLow = signal(this.url.get('low') === '1');
  pasting = signal(this.url.get('paste') === '1');

  all = signal<Item[]>([]);
  loaded = signal(false);
  item = signal<Item | null>(null);
  itemError = signal<string | null>(null);
  flash = signal<string | null>(null);
  busy = signal(false);
  addError = signal<string | null>(null);
  step = signal('1');
  reason = signal('');
  pasted = signal('');
  pasteReason = signal('');
  sortKey = signal<SortKey>('name');
  sortDir = signal<'asc' | 'desc'>('asc');
  picked = signal<Set<string>>(new Set());
  makers = signal<Maker[]>([]);
  linkMaker = signal('');
  linkProducts = signal<{ id: string; name: string; sku: string; url: string }[]>([]);
  /** The add row's fields. */
  form = signal({ name: '', quantity: '', unit: '', location: '', category: '', mpn: '', lcsc: '', min: '' });
  setF(k: FormKey, v: string) { this.form.update(f => ({ ...f, [k]: v })); }
  private poll = setInterval(() => { if (!document.hidden) this.read(); }, 15_000);

  constructor() {
    this.read();
    if (this.iid()) this.openItem(this.iid()!);
    // The address follows the page, so F5 comes back here.
    effect(() => {
      const i = this.iid(), q = this.listQ(), c = this.fCat(), l = this.fLoc(), low = this.fLow(), p = this.pasting();
      const url = new URL(location.href);
      const set = (k: string, v: string | null) => v ? url.searchParams.set(k, v) : url.searchParams.delete(k);
      set('item', i); set('iq', q); set('icat', c); set('iloc', l); set('low', low ? '1' : null); set('paste', !i && p ? '1' : null);
      if (url.href !== location.href) history.replaceState(null, '', url);
    });
    // Asked from the command palette: the add row, or the paste box.
    effect(() => {
      const w = this.sel.want();
      if (!w || (w.what !== 'inventory-add' && w.what !== 'inventory-paste' && w.what !== 'inventory')) return;
      untracked(() => {
        this.sel.want.set(null);
        if (w.what === 'inventory' && w.arg) this.openItem(w.arg);
        else if (w.what === 'inventory-paste') this.goPaste(); else this.goAdd();
      });
    });
  }

  private read() {
    this.api.list().subscribe({
      next: rows => {
        this.all.set(rows);
        this.loaded.set(true);
        const it = this.item();
        // An item changed elsewhere (the Chat, another tab): read it again.
        if (it) { const fresh = rows.find(r => r.id === it.id); if (fresh && fresh.updated_at !== it.updated_at) this.reload(it.id); }
      },
      error: () => this.loaded.set(true),
    });
  }
  private reload(id: string) {
    this.api.get(id).subscribe({ next: x => { if (this.iid() === id) this.item.set(x); }, error: () => {} });
  }

  // ---- the list and its filters

  filtering = computed(() => !!(this.listQ().trim() || this.fCat() || this.fLoc() || this.fLow()));
  shown = computed(() => {
    const w = fold(this.listQ()).split(/\s+/).filter(Boolean), c = this.fCat(), l = this.fLoc(), low = this.fLow();
    return this.all().filter(i => {
      if (low && !i.low) return false;
      if (c && i.category !== c) return false;
      if (l && i.location !== l) return false;
      if (!w.length) return true;
      const h = fold([i.name, i.mpn, i.lcsc, i.manufacturer, i.category, i.location, i.board, i.notes, i.tags.join(' '),
        i.catalog?.manufacturer_name ?? '', i.catalog?.product_name ?? ''].join(' '));
      return w.every(x => h.includes(x));
    });
  });
  categories = computed(() => [...new Set(this.all().map(i => i.category).filter(Boolean))].sort((a, b) => a.localeCompare(b)));
  locations = computed(() => [...new Set(this.all().map(i => i.location).filter(Boolean))].sort((a, b) => a.localeCompare(b)));
  units = computed(() => [...new Set([...UNITS, ...this.all().map(i => i.unit)])]);
  clearFilters() { this.listQ.set(''); this.fCat.set(''); this.fLoc.set(''); this.fLow.set(false); }

  stats = computed(() => {
    const rows = this.all();
    const units = new Map<string, number>(), value = new Map<string, number>();
    for (const i of rows) {
      units.set(i.unit, (units.get(i.unit) ?? 0) + i.quantity);
      if (i.value != null) value.set(i.currency || '?', (value.get(i.currency || '?') ?? 0) + i.value);
    }
    const top = [...units.entries()].sort((a, b) => b[1] - a[1]);
    return {
      low: rows.filter(i => i.low).length, out: rows.filter(i => i.quantity <= 0).length,
      withMin: rows.filter(i => i.min_stock != null).length, priced: rows.filter(i => i.price != null).length,
      unitKinds: units.size,
      unitsLine: top.slice(0, 3).map(([u, n]) => `${qty(n)} ${u}`).join(' · '),
      valueLine: [...value.entries()].map(([c, v]) => this.money(v, c)).join(' · '),
    };
  });
  recent = computed(() => [...this.all()].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')));

  sorted = computed(() => {
    const k = this.sortKey(), d = this.sortDir() === 'asc' ? 1 : -1;
    return [...this.shown()].sort((a, b) => {
      const x = a[k], y = b[k];
      if (x == null || x === '') return y == null || y === '' ? 0 : 1;           // the empty ones last, either way
      if (y == null || y === '') return -1;
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * d;
    });
  });
  sortBy(k: SortKey) {
    if (this.sortKey() === k) this.sortDir.set(this.sortDir() === 'asc' ? 'desc' : 'asc');
    else { this.sortKey.set(k); this.sortDir.set(k === 'updated_at' || k === 'value' ? 'desc' : 'asc'); }
  }
  pick(id: string, on: boolean) { const s = new Set(this.picked()); if (on) s.add(id); else s.delete(id); this.picked.set(s); }
  clearPicked() { this.picked.set(new Set()); }
  pickAll(on: boolean) { this.picked.set(on ? new Set(this.shown().map(i => i.id)) : new Set()); }
  allPicked = computed(() => this.shown().length > 0 && this.shown().every(i => this.picked().has(i.id)));
  selectedItems = computed(() => this.all().filter(i => this.picked().has(i.id)));

  // ---- going places

  openItem(id: string) {
    this.iid.set(id);
    this.itemError.set(null);
    if (this.item()?.id !== id) this.item.set(null);
    this.linkMaker.set('');
    this.api.get(id).subscribe({
      next: x => { if (this.iid() === id) this.item.set(x); },
      error: (e: HttpErrorResponse) => { if (this.iid() === id) this.itemError.set(why(e, 'Could not open it.')); },
    });
    if (this.can() && !this.makers().length) this.api.makers().subscribe({ next: m => this.makers.set(m), error: () => {} });
  }
  goHome() { this.iid.set(null); this.item.set(null); this.itemError.set(null); }
  goAdd() { this.goHome(); this.pasting.set(false); setTimeout(() => this.addName()?.nativeElement.focus(), 50); }
  goPaste() { this.goHome(); this.pasting.set(true); setTimeout(() => this.pasteBox()?.nativeElement.focus(), 50); }
  /** The product in the Product Catalog: its manufacturer open, searched for its name (?ws=catalog&m=&q=). */
  toCatalog(c: CatalogLink) {
    const url = new URL(location.href);
    url.searchParams.set('m', c.manufacturer);
    if (c.product_name) url.searchParams.set('q', c.product_name); else url.searchParams.delete('q');
    history.replaceState(null, '', url);
    this.sel.room.set('mfr');
    setTimeout(() => this.sel.ask('mfr-product', `${c.manufacturer}\n${c.product_name ?? ''}`), 50);
  }
  toPart(code: string) {
    this.sel.room.set('pcb');
    setTimeout(() => this.sel.ask('part', code), 50);
  }

  // ---- adding

  add() {
    const f = this.form();
    if (!f.name.trim()) { this.addError.set(t('An item needs a name.')); this.addName()?.nativeElement.focus(); return; }
    const q = f.quantity.trim() ? num(f.quantity) : 1;
    if (q == null || q < 0) { this.addError.set(t('The quantity is not a number.')); return; }
    const min = f.min.trim() ? num(f.min) : null;
    if (f.min.trim() && min == null) { this.addError.set(t('The minimum is not a number.')); return; }
    this.busy.set(true);
    this.addError.set(null);
    this.api.create({ name: f.name.trim(), quantity: q, unit: f.unit.trim() || 'pcs', location: f.location.trim(), category: f.category.trim(),
                      mpn: f.mpn.trim(), lcsc: f.lcsc.trim(), min_stock: min }).subscribe({
      next: r => {
        this.busy.set(false);
        this.form.set({ name: '', quantity: '', unit: '', location: f.location, category: f.category, mpn: '', lcsc: '', min: '' });
        this.say(r.merged ? this.fmt('Topped up {name}: now {q}', { name: r.item.name, q: `${qty(r.item.quantity)} ${r.item.unit}` })
                          : this.fmt('Added {name}', { name: r.item.name }));
        this.read();
        setTimeout(() => this.addName()?.nativeElement.focus(), 0);
      },
      error: (e: HttpErrorResponse) => { this.busy.set(false); this.addError.set(why(e, 'Could not add it.')); },
    });
  }

  parsed = computed(() => this.pasted().split(/\r?\n/).map(parseLine).filter((x): x is NonNullable<typeof x> => !!x));
  goodParsed = computed(() => this.parsed().filter(p => !p.error));
  /** The item already kept that a pasted line would top up (the server decides; this is its rule by name and unit). */
  existing(p: { name: string; unit: string }): Item | null {
    const u = (x: string) => (x || 'pcs').toLowerCase();
    return this.all().find(i => fold(i.name) === fold(p.name) && u(i.unit) === u(p.unit)) ?? null;
  }
  addPasted() {
    const items = this.goodParsed();
    if (!items.length) return;
    this.busy.set(true);
    this.api.bulk(items, this.pasteReason().trim()).subscribe({
      next: r => {
        this.busy.set(false);
        const added = r.results.filter(x => x.item && !x.merged).length, merged = r.results.filter(x => x.merged).length;
        const bad = r.results.filter(x => x.error);
        this.say(this.fmt('{a} added, {m} topped up', { a: added, m: merged }) + (bad.length ? ' · ' + this.fmt('{n} not added: {why}', { n: bad.length, why: bad.map(b => `${b.name || '?'}: ${b.error}`).join('; ') }) : ''));
        if (!bad.length) { this.pasted.set(''); this.pasteReason.set(''); }
        this.read();
      },
      error: (e: HttpErrorResponse) => { this.busy.set(false); this.say(why(e, 'Could not add them.')); },
    });
  }

  // ---- one item

  save(it: Item, field: string, value: string) {
    let v: unknown = value.trim();
    if (field === 'tags') v = value.split(/[,]+/).map(x => x.trim()).filter(Boolean);
    if (field === 'name' && !v) { this.say(t('An item needs a name.')); this.item.set({ ...it }); return; }
    const before = field === 'tags' ? it.tags.join(', ') : (it as unknown as Record<string, unknown>)[field];
    if ((field === 'tags' ? (v as string[]).join(', ') : v) === before) return;
    this.patch(it, { [field]: v });
  }
  saveNum(it: Item, field: 'min_stock' | 'price', value: string) {
    const v = value.trim() ? num(value) : null;
    if (value.trim() && v == null) { this.say(t('That is not a number.')); this.item.set({ ...it }); return; }
    if (v === it[field]) return;
    this.patch(it, { [field]: v });
  }
  private patch(it: Item, p: Record<string, unknown>) {
    this.api.patch(it.id, p).subscribe({
      next: x => { this.item.set(x); this.replace(x); },
      error: (e: HttpErrorResponse) => { this.say(why(e, 'Could not save it.')); this.item.set({ ...it }); },
    });
  }
  adjust(it: Item, sign: 1 | -1) {
    const n = num(this.step());
    if (n == null || n <= 0) { this.say(t('Say how many, more than zero.')); return; }
    this.busy.set(true);
    this.api.adjust(it.id, sign * n, this.reason().trim()).subscribe({
      next: x => { this.busy.set(false); this.item.set(x); this.replace(x); this.reason.set(''); this.reasonBox()?.nativeElement.blur(); },
      error: (e: HttpErrorResponse) => { this.busy.set(false); this.say(why(e, 'Could not change it.')); },
    });
  }
  private replace(x: Item) {
    const { log: _, ...light } = x;
    this.all.update(l => l.map(i => i.id === x.id ? light : i));
  }
  async remove(it: Item) {
    if (!await sure(t('Delete this item and its log?'), it.name)) return;
    this.api.remove(it.id).subscribe({
      next: () => { this.all.update(l => l.filter(i => i.id !== it.id)); this.goHome(); this.say(this.fmt('Deleted {name}', { name: it.name })); },
      error: (e: HttpErrorResponse) => this.say(why(e, 'Could not delete it.')),
    });
  }
  async removeSelected() {
    const items = this.selectedItems();
    if (!items.length || !await sure(this.fmt('Delete {n} items and their logs?', { n: items.length }), items.map(i => i.name).slice(0, 12).join(', '))) return;
    this.api.removeMany(items.map(i => i.id)).subscribe({
      next: r => { this.picked.set(new Set()); this.all.update(l => l.filter(i => !r.deleted.includes(i.id))); this.say(this.fmt('Deleted {n} items', { n: r.deleted.length })); },
      error: (e: HttpErrorResponse) => this.say(why(e, 'Could not delete them.')),
    });
  }

  pickMaker(id: string) {
    this.linkMaker.set(id);
    this.linkProducts.set([]);
    if (id) this.api.maker(id).subscribe({ next: m => { if (this.linkMaker() === id) this.linkProducts.set(m.products ?? []); }, error: () => {} });
  }
  linkProduct(it: Item, text: string) {
    const name = text.split(' · ')[0].trim();
    const p = this.linkProducts().find(x => x.name === name || x.sku === text.trim()) ?? this.linkProducts().find(x => fold(x.name) === fold(name));
    if (!p) { this.say(t('No such product in that catalog.')); return; }
    this.patch(it, { catalog: { manufacturer: this.linkMaker(), product: p.id } });
    this.linkMaker.set('');
  }
  unlinkCatalog(it: Item) { this.patch(it, { catalog: null }); }

  // ---- files

  exportItems(items: Item[]) {
    this.api.exportFile(items.map(i => i.id)).subscribe({
      next: data => {
        const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url;
        const one = items.length === 1 ? items[0].name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() : '';
        a.download = `${one || 'inventory'}.inventory.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      },
      error: (e: HttpErrorResponse) => this.say(why(e, 'Could not export it.')),
    });
  }
  importFile(input: HTMLInputElement) {
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    f.text().then(text => {
      let data: unknown;
      try { data = JSON.parse(text); } catch { this.say(t('That file is not an inventory.')); return; }
      this.api.importFile(data).subscribe({
        next: r => { this.read(); this.say(this.fmt('Imported: {a} added, {m} topped up', { a: r.added, m: r.merged }) + (r.skipped.length ? ' · ' + this.fmt('{n} not added', { n: r.skipped.length }) : '')); },
        error: (e: HttpErrorResponse) => this.say(why(e, 'Could not import it.')),
      });
    });
  }

  // ---- words

  kindName(k: string) {
    return ({ added: 'Added', merged: 'Topped up', adjusted: 'Quantity changed', edited: 'Edited' } as Record<string, string>)[k] ?? k;
  }
  changeLine(l: LogLine): string {
    if (l.kind === 'edited' && l.changes) {
      return Object.entries(l.changes).map(([k, [a, b]]) => `${k}: ${a === '' || a == null ? '–' : a} → ${b === '' || b == null ? '–' : b}`).join(' · ');
    }
    if (l.kind === 'merged' && l.filled?.length) return this.fmt('filled in {f}', { f: l.filled.join(', ') });
    return '';
  }
  money(v: number, cur: string) {
    const loc = LANG() === 'tr' ? 'tr-TR' : 'en-US';
    if (/^[A-Z]{3}$/.test(cur)) {
      try { return v.toLocaleString(loc, { style: 'currency', currency: cur, maximumFractionDigits: v < 1 ? 4 : 2 }); } catch { /* an unknown code */ }
    }
    return `${v.toLocaleString(loc, { maximumFractionDigits: 2 })}${cur && cur !== '?' ? ' ' + cur : ''}`;
  }
  qty = qty;
  when = when;
  t = t;
  fmt(text: string, vars: Record<string, string | number>) {
    return t(text).replace(/\{(\w+)\}/g, (m, k) => k in vars ? String(vars[k]) : m);
  }
  private say(msg: string) { this.flash.set(msg); setTimeout(() => this.flash.set(null), 5000); }

  key(e: KeyboardEvent) {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName);
    if (e.key === '/' && !typing) { e.preventDefault(); this.search().nativeElement.focus(); }
  }

  ngOnDestroy() { clearInterval(this.poll); }
}
