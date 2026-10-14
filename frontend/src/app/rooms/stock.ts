import { Component, ElementRef, Injectable, OnDestroy, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { Toast, ToastTone } from '../toast';
import { NgTemplateOutlet } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Auth } from '../auth';
import { LANG, T, t } from '../i18n';
import { Confirm } from '../confirm';
import { ContextMenu } from '../context-menu';
import { SelectionBar } from '../selection-bar';
import { Marquee } from '../marquee';
import { SelectOption, UiSelect } from '../ui-select';
import { CountUp } from '../count';
import { CURRENCY, convert, moneyIn, moneyTip } from '../money';
import { Skeleton } from '../skeleton';
import { EmptyState } from '../empty-state';
import { StockChart } from './product-charts';

/** Stock on the Parts page: how many of each product are on hand, and where
 *  (backend/inventory.py). What a thing is - its name, maker, code, price,
 *  pictures, datasheet, 3D - is its Parts product's; a stock line counts it:
 *  a quantity in a unit, a place, a minimum below which it is low, notes and
 *  a log of every change with who and why. Every line points at a product
 *  (`catalog`); a thing no site sells is a product of My Items.
 *
 *  Three pieces, all shown inside the Parts page (manufacturers.ts):
 *  - `StockState`: what is on hand of every product, read once and shared,
 *    so every row, card and bin of the page says its count;
 *  - `<wb-stock-panel>`: a product's stock in its detail - each line with
 *    -/+ and the reason, its unit, place, minimum and notes, its log - or
 *    "Add to stock" when there is none;
 *  - `<wb-stock-view>`: every product on hand, across the sources, in one
 *    dense list grouped by type - search, type, place, low, import and
 *    export, adding to My Items - where a line opens its product.
 *
 *  The Chat counts and changes stock too (backend/chat_tools/inventory_*.py),
 *  so the view reads again every few seconds while it is open.
 */
export interface CatalogLink {
  manufacturer: string; manufacturer_name?: string; product: string; product_name?: string; url?: string; sku?: string;
}
export interface LogLine {
  id: string; at: string; by: { id?: string; name?: string }; kind: 'added' | 'merged' | 'adjusted' | 'edited';
  delta?: number; after?: number; reason?: string; fields?: string[]; filled?: string[]; changes?: Record<string, [unknown, unknown]>;
}
/** What an item's words say that its type's card shows (backend/inventory_types.py facts). */
export interface Facts {
  material?: string; diameter?: number; finish?: string; colour?: string; colour_hex?: string; spool_g?: number; spool_stated?: boolean;
  weight_g?: number; spools?: number; full_spools?: number; current_g?: number; current_pct?: number; volume_ml?: number;
  thread?: string; length?: number | string; width?: number; size?: string; standard?: string; head?: string; drive?: string; form?: string;
  package?: string; value?: string; mpn?: string; lcsc_category?: string; gauge?: string; section?: string;
}
/** The Parts product a line counts, as it is now. */
export interface ProductBrief { name?: string; maker?: string; sku?: string; category?: string; url?: string; builtin?: boolean;
  price?: { amount: number; currency: string; vat?: string | null } }
export interface Item {
  id: string; name: string; quantity: number; unit: string; location: string; category: string; mpn: string; lcsc: string;
  manufacturer: string; board: string; min_stock: number | null; price: number | null; currency: string; notes: string;
  tags: string[]; catalog: CatalogLink | null; by: { id?: string; name?: string }; created_at: string;
  updated_by: { id?: string; name?: string }; updated_at: string; low: boolean; value: number | null;
  last: LogLine | null; log?: LogLine[];
  type: string; subtype: string; type_auto: boolean; type_set: string; facts: Facts;
  images: string[]; photo: boolean; photo_known: boolean; product: ProductBrief | null;
}
export type NewItem = Partial<Omit<Item, 'id' | 'catalog' | 'facts' | 'images' | 'product'>> & { name: string; catalog?: { manufacturer: string; product: string } | null };
export interface CatalogStock { quantity: number; unit: string; items: string[]; low: boolean }
export interface FromCatalog { manufacturer: string; quantity: number; unit: string; location: string; note: string }
interface Added { item?: Item; merged?: boolean; error?: string; name?: string }

/** The units offered (backend/inventory.py UNITS); any other short word is kept as written. */
export const UNITS = ['pcs', 'm', 'cm', 'mm', 'kg', 'g', 'l', 'ml', 'roll', 'reel', 'box', 'pack', 'set', 'pair', 'sheet', 'bag'];

/** The types, in the order the view shows them (backend/inventory_types.py TYPES), each with its drawing. */
export const TYPES: { id: string; label: string; icon: string }[] = [
  { id: 'filament', label: 'Filament', icon: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z M12 3v6 M20.5 9.5l-5.6 1.7' },
  { id: 'resin', label: 'Resin', icon: 'M9.5 3h5 M10 3v4.5L6 12v9h12v-9l-4-4.5V3 M6 15h12' },
  { id: 'screw', label: 'Screws & bolts', icon: 'M7 3h10v4H7z M10 7v12l2 2 2-2V7 M10 10l4 1.4 M10 13.3l4 1.4 M10 16.6l4 1.4' },
  { id: 'nut', label: 'Nuts', icon: 'M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z' },
  { id: 'washer', label: 'Washers', icon: 'M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16z M12 9.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5z' },
  { id: 'insert', label: 'Inserts', icon: 'M7 5h10v14H7z M7 9l10 2 M7 13l10 2 M10 5v14 M14 5v14' },
  { id: 'fastener', label: 'Other fasteners', icon: 'M9 3h6l2 3v12l-2 3H9l-2-3V6z M12 7v10' },
  { id: 'electronic', label: 'Electronic components', icon: 'M7 7h10v10H7z M10 3v4 M14 3v4 M10 17v4 M14 17v4 M3 10h4 M3 14h4 M17 10h4 M17 14h4' },
  { id: 'module', label: 'Modules & boards', icon: 'M3 6h18v12H3z M6.5 9.5h4v4h-4z M14 10h4 M14 13h4 M6 18v2.5 M10 18v2.5 M14 18v2.5 M18 18v2.5' },
  { id: 'cable', label: 'Cables & wire', icon: 'M3 17c4 0 4-10 9-10s5 10 9 10 M2 17h2 M20 17h2' },
  { id: 'mechanical', label: 'Mechanical parts', icon: 'M12 8.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7z M12 2.5v3 M12 18.5v3 M2.5 12h3 M18.5 12h3 M5.3 5.3l2.1 2.1 M16.6 16.6l2.1 2.1 M5.3 18.7l2.1-2.1 M16.6 7.4l2.1-2.1' },
  { id: 'tool', label: 'Tools', icon: 'M14.5 3.5a5 5 0 0 0-4.6 6.9L3.5 16.8l3.7 3.7 6.4-6.4a5 5 0 0 0 6.9-4.6l-3 3-3.2-.8-.8-3.2z' },
  { id: 'consumable', label: 'Consumables', icon: 'M12 3c3 4.2 6 7.6 6 11a6 6 0 0 1-12 0c0-3.4 3-6.8 6-11z' },
  { id: 'other', label: 'Other', icon: 'M3 7.5l9-4.5 9 4.5v9l-9 4.5-9-4.5z M3 7.5l9 4.5 9-4.5 M12 12v9' },
];
const TYPE = new Map(TYPES.map(x => [x.id, x]));
/** An electronic component's kinds (backend/inventory_types.py SUBTYPES). */
export const SUBTYPES: { id: string; label: string }[] = [
  { id: 'resistor', label: 'Resistor' }, { id: 'capacitor', label: 'Capacitor' }, { id: 'inductor', label: 'Inductor' },
  { id: 'led', label: 'LED' }, { id: 'diode', label: 'Diode' }, { id: 'transistor', label: 'Transistor' }, { id: 'ic', label: 'IC' },
  { id: 'crystal', label: 'Crystal' }, { id: 'connector', label: 'Connector' }, { id: 'switch', label: 'Switch' },
  { id: 'relay', label: 'Relay' }, { id: 'fuse', label: 'Fuse' }, { id: 'sensor', label: 'Sensor' }, { id: 'display', label: 'Display' },
  { id: 'motor', label: 'Motor / fan' },
];
const SUBTYPE = new Map(SUBTYPES.map(x => [x.id, x.label]));
const COLOURS: Record<string, string> = {
  black: 'Black', white: 'White', grey: 'Grey', silver: 'Silver', red: 'Red', orange: 'Orange', yellow: 'Yellow', gold: 'Gold',
  green: 'Green', blue: 'Blue', navy: 'Navy', turquoise: 'Turquoise', purple: 'Purple', pink: 'Pink', brown: 'Brown',
  beige: 'Beige', natural: 'Natural', wood: 'Wood',
};

type SortKey = 'name' | 'quantity' | 'location' | 'type' | 'maker' | 'code' | 'min_stock' | 'value' | 'updated_at';

const I = {
  grid: 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z',
  rows: 'M4 6h16 M4 12h16 M4 18h16',
  check: 'M5 12.5l4.5 4.5L19 7.5',
};

@Injectable({ providedIn: 'root' })
export class InventoryApi {
  private http = inject(HttpClient);
  list() { return this.http.get<Item[]>('/api/inventory'); }
  get(id: string) { return this.http.get<Item>(`/api/inventory/${id}`); }
  /** One product's lines, each with its log (backend/inventory.py api_of_product). */
  ofProduct(mid: string, pid: string) { return this.http.get<Item[]>(`/api/inventory/product/${encodeURIComponent(mid)}/${encodeURIComponent(pid)}`); }
  create(b: NewItem & { reason?: string; merge?: boolean }) { return this.http.post<{ item: Item; merged: boolean }>('/api/inventory', b); }
  bulk(items: NewItem[], reason = '') { return this.http.post<{ results: Added[] }>('/api/inventory/bulk', { items, reason }); }
  patch(id: string, p: Record<string, unknown>) { return this.http.patch<Item>(`/api/inventory/${id}`, p); }
  adjust(id: string, delta: number, reason: string) { return this.http.post<Item>(`/api/inventory/${id}/adjust`, { delta, reason }); }
  remove(id: string) { return this.http.delete(`/api/inventory/${id}`); }
  removeMany(ids: string[]) { return this.http.post<{ deleted: string[] }>('/api/inventory/bulk-delete', { ids }); }
  exportFile(ids: string[] = []) { return this.http.get<unknown>(`/api/inventory/export?ids=${encodeURIComponent(ids.join(','))}`); }
  importFile(data: unknown) { return this.http.post<{ added: number; merged: number; skipped: { name: string; error: string }[] }>('/api/inventory/import', data); }
  /** What is on hand of every product, by maker and product, in one read (backend/inventory.py stock_of). */
  stockAll() { return this.http.get<Record<string, Record<string, CatalogStock>>>('/api/inventory/stock'); }
  /** A catalog product into stock: a line for it, or the one already counting it topped up. */
  fromCatalog(b: FromCatalog & { product: string }) { return this.http.post<{ item: Item; merged: boolean }>('/api/inventory/from-catalog', b); }
  fromCatalogMany(b: FromCatalog & { products: string[] }) {
    return this.http.post<{ results: { product: string; item?: Item; merged?: boolean; error?: string }[] }>('/api/inventory/from-catalog/bulk', b);
  }
}

/** What is on hand of every product, for the whole Parts page: read once, again after any change here. */
@Injectable({ providedIn: 'root' })
export class StockState {
  private api = inject(InventoryApi);
  held = signal<Record<string, Record<string, CatalogStock>>>({});
  /** Bumped on every change made on the page: the lists that show stock read again. */
  changed = signal(0);
  load() { this.api.stockAll().subscribe({ next: h => this.held.set(h), error: () => {} }); }
  of(mid: string, pid: string): CatalogStock | null { return this.held()[mid]?.[pid] ?? null; }
  touch() { this.load(); this.changed.update(n => n + 1); }
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

function fmt(text: string, vars: Record<string, string | number>) {
  return t(text).replace(/\{(\w+)\}/g, (m, k) => k in vars ? String(vars[k]) : m);
}

function say(msg: string, tone: ToastTone = 'info') { Toast.show(msg, { tone }); }

/** How long ago: "just now", "5 min ago", "2 h ago", "3 d ago", else the date. */
function ago(iso: string | null | undefined): string {
  if (!iso) return '–';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return t('just now');
  if (s < 3600) return fmt('{n} min ago', { n: Math.floor(s / 60) });
  if (s < 86400) return fmt('{n} h ago', { n: Math.floor(s / 3600) });
  if (s < 30 * 86400) return fmt('{n} d ago', { n: Math.floor(s / 86400) });
  return when(iso);
}

function kindName(k: string) {
  return ({ added: 'Added', merged: 'Topped up', adjusted: 'Quantity changed', edited: 'Edited' } as Record<string, string>)[k] ?? k;
}
function changeLine(l: LogLine): string {
  if (l.kind === 'edited' && l.changes) {
    return Object.entries(l.changes).map(([k, [a, b]]) => `${k}: ${a === '' || a == null ? '–' : a} → ${b === '' || b == null ? '–' : b}`).join(' · ');
  }
  if (l.kind === 'merged' && l.filled?.length) return fmt('filled in {f}', { f: l.filled.join(', ') });
  return '';
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
  const qu = /^(\d+(?:[.,]\d+)?)\s*([^\d\s].*)$/.exec(q);
  if (qu && !unit) { q = qu[1]; unit = qu[2]; }
  const n = q ? num(q) : 1;
  const out = { name, quantity: n ?? 0, unit: unit || 'pcs', location };
  if (!name) return { ...out, error: 'no name' };
  if (n == null || n < 0) return { ...out, error: 'the quantity is not a number' };
  return out;
}

// ======================================================================= a product's stock

/** The stock section of a product's detail: its lines - the quantity, -/+
 *  with the reason, the unit, place, minimum and notes in place, the log -
 *  or, with none, adding it to stock. */
@Component({
  selector: 'wb-stock-panel',
  imports: [T, StockChart],
  host: { style: 'display: block' },
  styleUrls: ['../settings.css', './taste.css', './manufacturers.css', './stock.css'],
  template: `
<section class="inv inv-panel" [attr.aria-label]="'Stock' | t" [attr.data-compact]="compact() ? 1 : null">
  <div class="inv-phead">
    <span class="mf-label">{{ 'Stock' | t }}</span>
    @if (lines().length > 1) { <span class="st-sub">{{ fmt('{n} lines - in different units or places', { n: lines().length }) }}</span> }
    @if (!loaded()) { <span class="st-sub">…</span> }
    @if (can() && lines().length && !adding()) { <button class="st-more inv-pmore" (click)="adding.set(true)">{{ 'Another line' | t }}</button> }
  </div>
  @for (it of lines(); track it.id) {
    <div class="inv-line">
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
            <input class="tst-in inv-reason" [placeholder]="'Why - e.g. used 4 for the fan board' | t" [value]="reason()"
                   (input)="reason.set($any($event.target).value)" (keydown.enter)="adjust(it, -1)" [attr.aria-label]="'Reason' | t"
                   [title]="'Enter in the reason takes; in the amount adds.' | t">
          </div>
        }
      </div>
      <div class="inv-pfields">
        <label><span>{{ 'Unit' | t }}</span><input class="tst-in" list="wb-stock-units" [value]="it.unit" [readonly]="!can()" (change)="save(it, 'unit', $any($event.target).value)"></label>
        <label><span>{{ 'Location' | t }}</span><input class="tst-in" [value]="it.location" [readonly]="!can()" [placeholder]="'Shelf, bin, box' | t" (change)="save(it, 'location', $any($event.target).value)"></label>
        <label><span>{{ 'Minimum' | t }}</span><input class="tst-in" inputmode="decimal" [value]="it.min_stock ?? ''" [readonly]="!can()" [placeholder]="'none' | t" (change)="saveMin(it, $any($event.target).value)"></label>
        <label class="inv-pnotes"><span>{{ 'Notes' | t }}</span><input class="tst-in" [value]="it.notes" [readonly]="!can()" (change)="save(it, 'notes', $any($event.target).value)"></label>
        @if (can()) { <button class="tcv-cc-ib tcv-cc-danger inv-pdel" (click)="remove(it)" [title]="'Stop counting it: the line and its log go, the product stays' | t">
          <svg class="tcv-cc-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16 M9.5 7V4h5v3 M6.5 7l.8 13h9.4l.8-13 M10 11v5.5 M14 11v5.5" /></svg></button> }
      </div>
      <!-- in the product's detail: how many were on hand over time, what the log says plainly (product-charts.ts) -->
      @if (charts()) { <wb-stock-chart class="inv-chart" [log]="it.log ?? []" [quantity]="it.quantity" [min]="it.min_stock" [unit]="it.unit" /> }
      <div class="st-table-wrap inv-logwrap">
        <table class="st-table inv-log">
          <thead><tr><th>{{ 'When' | t }}</th><th>{{ 'What' | t }}</th><th class="r">{{ 'Change' | t }}</th><th class="r">{{ 'After' | t }}</th>
            <th>{{ 'Reason' | t }}</th><th>{{ 'By' | t }}</th></tr></thead>
          <tbody>
            @for (l of (all() ? it.log : (it.log ?? []).slice(0, 6)) ?? []; track l.id) {
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
      @if (!all() && (it.log?.length ?? 0) > 6) { <button class="st-more" (click)="all.set(true)">{{ fmt('The whole log ({n})', { n: it.log!.length }) }}</button> }
    </div>
  }
  @if (loaded() && (!lines().length || adding())) {
    @if (!lines().length) { <p class="st-sub inv-pnone">{{ (can() ? 'Not in stock. Count it here: how many, in what, where.' : 'Not in stock.') | t }}</p> }
    @if (can()) {
      <div class="inv-addrow mf-ctl">
        <input class="tst-in inv-a-qty" inputmode="decimal" [placeholder]="'Qty' | t" [value]="nf().quantity" (input)="nfSet('quantity', $event)" (keydown.enter)="addLine()" [attr.aria-label]="'Quantity' | t">
        <input class="tst-in inv-a-unit" list="wb-stock-units" [value]="nf().unit" (input)="nfSet('unit', $event)" (keydown.enter)="addLine()" [attr.aria-label]="'Unit' | t">
        <input class="tst-in" [placeholder]="'Location' | t" [value]="nf().location" (input)="nfSet('location', $event)" (keydown.enter)="addLine()" [attr.aria-label]="'Location' | t">
        <input class="tst-in" [placeholder]="'Note for the log (optional)' | t" [value]="nf().note" (input)="nfSet('note', $event)" (keydown.enter)="addLine()" [attr.aria-label]="'Note' | t">
        <button class="tcv-btn tcv-btn-accent" (click)="addLine()" [disabled]="busy()">{{ 'Add to stock' | t }}</button>
        @if (lines().length) { <button class="tcv-btn" (click)="adding.set(false)">{{ 'Cancel' | t }}</button> }
      </div>
    }
  }
  <datalist id="wb-stock-units">@for (u of units; track u) { <option [value]="u"></option> }</datalist>
</section>`,
})
export class StockPanel {
  private api = inject(InventoryApi);
  private state = inject(StockState);
  private auth = inject(Auth);
  /** The product: its maker's (or source's) id and its own. */
  readonly maker = input.required<string>();
  readonly product = input.required<string>();
  /** In a narrow column (the product's detail): the fields in two rows, the log without who. */
  readonly compact = input(false);
  /** Its chart over the log: the count over time, used and added, how long it lasts. */
  readonly charts = input(false);
  can = computed(() => this.auth.can('draw'));
  lines = signal<Item[]>([]);
  loaded = signal(false);
  busy = signal(false);
  adding = signal(false);
  all = signal(false);
  step = signal('1');
  reason = signal('');
  nf = signal({ quantity: '1', unit: 'pcs', location: '', note: '' });
  readonly units = UNITS;
  qty = qty; when = when; kindName = kindName; changeLine = changeLine; fmt = fmt;

  constructor() {
    effect(() => { const m = this.maker(), p = this.product(); this.state.changed(); untracked(() => this.read(m, p)); });
  }
  private read(m: string, p: string) {
    this.api.ofProduct(m, p).subscribe({
      next: rows => { if (m === this.maker() && p === this.product()) { this.lines.set(rows); this.loaded.set(true); } },
      error: () => this.loaded.set(true),
    });
  }
  private done(x: Item) { this.lines.update(l => l.map(i => i.id === x.id ? x : i)); this.state.load(); }
  nfSet(k: 'quantity' | 'unit' | 'location' | 'note', e: Event) { const v = (e.target as HTMLInputElement).value; this.nf.update(f => ({ ...f, [k]: v })); }
  adjust(it: Item, sign: 1 | -1) {
    const n = num(this.step());
    if (n == null || n <= 0) { say(t('Say how many, more than zero.')); return; }
    this.busy.set(true);
    this.api.adjust(it.id, sign * n, this.reason().trim()).subscribe({
      next: x => { this.busy.set(false); this.reason.set(''); this.done(x); },
      error: (e: HttpErrorResponse) => { this.busy.set(false); say(why(e, 'Could not change it.'), 'danger'); },
    });
  }
  save(it: Item, field: 'unit' | 'location' | 'notes', value: string) {
    const v = value.trim();
    if (v === (it[field] ?? '')) return;
    this.api.patch(it.id, { [field]: v }).subscribe({ next: x => this.done(x), error: (e: HttpErrorResponse) => say(why(e, 'Could not save it.'), 'danger') });
  }
  saveMin(it: Item, value: string) {
    const v = value.trim() ? num(value) : null;
    if (value.trim() && v == null) { say(t('That is not a number.')); return; }
    if (v === it.min_stock) return;
    this.api.patch(it.id, { min_stock: v }).subscribe({ next: x => this.done(x), error: (e: HttpErrorResponse) => say(why(e, 'Could not save it.'), 'danger') });
  }
  addLine() {
    const f = this.nf(), q = num(f.quantity);
    if (q == null || q < 0) { say(t('The quantity is not a number.')); return; }
    this.busy.set(true);
    // Another line of a product already counted is one in another unit or place: never merged into the first.
    const call = this.lines().length
      ? this.api.create({ name: '', quantity: q, unit: f.unit.trim() || 'pcs', location: f.location.trim(), reason: f.note.trim(),
                          merge: false, catalog: { manufacturer: this.maker(), product: this.product() } })
      : this.api.fromCatalog({ manufacturer: this.maker(), product: this.product(), quantity: q, unit: f.unit.trim() || 'pcs',
                               location: f.location.trim(), note: f.note.trim() });
    call.subscribe({
      next: () => { this.busy.set(false); this.adding.set(false); this.nf.set({ quantity: '1', unit: 'pcs', location: '', note: '' }); this.state.touch(); },
      error: (e: HttpErrorResponse) => { this.busy.set(false); say(why(e, 'Could not add it.'), 'danger'); },
    });
  }
  async remove(it: Item) {
    if (!await Confirm.ask({ title: t('Stop counting it in stock?'), text: t('The line and its log go; the product stays in Parts.'), ok: t('Delete'), danger: true })) return;
    this.api.remove(it.id).subscribe({ next: () => this.state.touch(), error: (e: HttpErrorResponse) => say(why(e, 'Could not delete it.'), 'danger') });
  }
}

// ======================================================================= every product on hand

/** One type's section: its lines and what they add up to. */
interface Group { id: string; label: string; icon: string; items: Item[]; low: number; qtyLine: string; valueLine: string }

@Component({
  selector: 'wb-stock-view',
  imports: [EmptyState, Skeleton, CountUp, T, UiSelect, NgTemplateOutlet, SelectionBar, Marquee],
  styleUrls: ['../settings.css', './taste.css', './manufacturers.css', './stock.css'],
  host: { '(document:keydown)': 'key($event)' },
  template: `
<div class="inv inv-view" wbMarquee [marqueeOn]="all().length > 0" [marqueeFromItems]="layout() === 'table'"
     marqueeSkip="thead, .mf-gbar, .inv-addbar" [marqueeBase]="picked()" (wbMarquee)="picked.set($event)">
  @if (!loaded()) { <wb-skel kind="tiles" [count]="5" [min]="160" /> } @else {
  <div class="st-tiles inv-tiles">
    <div class="st-tile" [attr.data-tone]="all().length ? null : 'dim'"><span>{{ 'Products in stock' | t }}</span><b [wbCount]="products()"></b>
      <small>{{ fmt('{n} lines in {p} places', { n: all().length, p: locations().length }) }}</small></div>
    <div class="st-tile" [attr.data-tone]="allTypes().length ? null : 'dim'"><span>{{ 'Types' | t }}</span><b [wbCount]="allTypes().length"></b>
      <small [title]="typesLine()">{{ typesLine() || ('none yet' | t) }}</small></div>
    <button class="st-tile mf-tilebtn" [attr.data-tone]="stats().low ? 'warn' : 'dim'" (click)="fLow.set(!fLow())" [title]="'Only lines at or below their minimum' | t">
      <span>{{ 'Low stock' | t }}</span><b [wbCount]="stats().low"></b>
      <small>{{ fmt('{o} out of stock · {n} with a minimum', { o: stats().out, n: stats().withMin }) }}</small></button>
    <div class="st-tile inv-value" [attr.data-tone]="stats().valueLine ? null : 'dim'"><span>{{ 'Value' | t }}</span><b [title]="stats().valueTip || stats().valueLine" [wbCount]="stats().valueLine || '–'"></b>
      <small>{{ fmt('{n} priced in Parts', { n: stats().priced }) }}</small></div>
    <div class="st-tile" [attr.data-tone]="recent().length ? null : 'dim'"><span>{{ 'Last change' | t }}</span><b>{{ recent().length ? ago(recent()[0].updated_at) : '–' }}</b>
      <small [title]="recent().length ? recent()[0].name : ''">{{ recent().length ? recent()[0].name + ' · ' + (recent()[0].updated_by.name || '') : ('none yet' | t) }}</small></div>
  </div>
  }

  @if (can()) {
    <!-- a thing no site sells: a My Items product and its stock line in one go (one, or a pasted list) -->
    <div class="inv-addbar mf-ctl">
      @if (!pasting()) {
        <span class="mf-label mf-rowlabel" [title]="'Made a product of My Items, or counted under the one of that name already there' | t">{{ 'Add to My Items' | t }}</span>
        <input #addName class="tst-in inv-a-name" [placeholder]="'Name - e.g. PETG black 1 kg' | t" [value]="form().name" (input)="setF('name', $any($event.target).value)" (keydown.enter)="add()" [attr.aria-label]="'Name' | t">
        <input class="tst-in inv-a-qty" inputmode="decimal" [placeholder]="'Qty' | t" [value]="form().quantity" (input)="setF('quantity', $any($event.target).value)" (keydown.enter)="add()" [attr.aria-label]="'Quantity' | t">
        <input class="tst-in inv-a-unit" list="inv-units" [placeholder]="'pcs'" [value]="form().unit" (input)="setF('unit', $any($event.target).value)" (keydown.enter)="add()" [attr.aria-label]="'Unit' | t">
        <input class="tst-in" list="inv-locs" [placeholder]="'Location' | t" [value]="form().location" (input)="setF('location', $any($event.target).value)" (keydown.enter)="add()" [attr.aria-label]="'Location' | t">
        <input class="tst-in" [placeholder]="'Category' | t" [value]="form().category" (input)="setF('category', $any($event.target).value)" (keydown.enter)="add()" [attr.aria-label]="'Category' | t">
        <input class="tst-in inv-a-min" inputmode="decimal" [placeholder]="'Min' | t" [value]="form().min" (input)="setF('min', $any($event.target).value)" (keydown.enter)="add()" [attr.aria-label]="'Minimum' | t">
        <button class="tcv-btn tcv-btn-accent" (click)="add()" [disabled]="busy()">{{ 'Add' | t }}</button>
      } @else {
        <textarea #pasteBox class="tst-in inv-pastebox" rows="4" [value]="pasted()" (input)="pasted.set($any($event.target).value)"
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
      }
      <button class="tcv-btn" (click)="pasting.set(!pasting())">{{ (pasting() ? 'One item' : 'Paste a list') | t }}</button>
      <button class="tcv-btn" (click)="importIn.click()" [title]="'Add the lines of a stock file someone sent you' | t">{{ 'Import…' | t }}</button>
      <input #importIn type="file" accept=".json,application/json" hidden (change)="importFile($any($event.target))">
      @if (all().length) { <button class="tcv-btn" (click)="exportItems([])" [title]="'Save every stock line as a file' | t">{{ 'Export' | t }}</button> }
    </div>
    @if (addError(); as e) { <p class="st-hint mf-err">{{ e }}</p> }
  }

  @if (all().length) {
    <div class="mf-gbar mf-ctl inv-gbar">
      <input #search class="tst-in mf-gfind" type="search" [placeholder]="'Search stock: name, maker, size, value, part number, place' | t" [value]="q()"
             (input)="q.set($any($event.target).value)" (keydown.escape)="q.set(''); $any($event.target).blur()" [attr.aria-label]="'Search stock' | t">
      <wb-select class="mf-gsel" label="Type" placeholder="All types" [options]="typeOpts()" [value]="fType()" (pick)="fType.set($event)" />
      <wb-select class="mf-gsel" label="Location" placeholder="All places" [options]="placeOpts()" [value]="fLoc()" (pick)="fLoc.set($event)" />
      <wb-select class="mf-gsel" label="Maker" placeholder="All makers" [options]="makerOpts()" [value]="fMaker()" (pick)="fMaker.set($event)" />
      <button type="button" class="mf-stocktog" role="switch" [attr.aria-checked]="fLow()" (click)="fLow.set(!fLow())">
        <span class="tcv-switch" [attr.data-on]="fLow() ? 1 : null" aria-hidden="true"></span>{{ 'Low stock' | t }}</button>
      @if (filtering()) { <button class="tcv-btn" (click)="clearFilters()">{{ 'Clear' | t }}</button> }
      <span class="st-right st-sub mf-gcount">{{ filtering() ? fmt('{n} of {m}', { n: shown().length, m: all().length }) : fmt('{n} lines', { n: all().length }) }}</span>
      <div class="st-seg mf-layout" role="radiogroup" [attr.aria-label]="'Layout' | t">
        <button [class.on]="layout() === 'table'" (click)="layout.set('table')" [title]="'Table' | t"><svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.rows" /></svg>{{ 'Table' | t }}</button>
        <button [class.on]="layout() === 'grid'" (click)="layout.set('grid')" [title]="'Grid' | t"><svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.grid" /></svg>{{ 'Grid' | t }}</button>
      </div>
    </div>

    @if (layout() === 'grid') {
      @for (g of groups(); track g.id) {
        <section class="inv-sec" [attr.data-type]="g.id" [attr.data-flat]="flat(g) ? 1 : null">
          <header class="inv-sechead">
            <span class="inv-secico"><svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="g.icon" /></svg></span>
            <h3>{{ g.label | t }}</h3>
            <span class="inv-secn">{{ fmt(g.items.length === 1 ? '{n} line' : '{n} lines', { n: g.items.length }) }}</span>
            @if (g.qtyLine) { <span class="inv-secq">{{ g.qtyLine }}</span> }
            @if (g.low) { <span class="st-tag" data-tone="warn">{{ fmt('{n} low', { n: g.low }) }}</span> }
            <span class="inv-secv">{{ g.valueLine }}</span>
          </header>
          <div class="mf-grid inv-grid">
            @for (i of g.items; track i.id) { <ng-container *ngTemplateOutlet="cardT; context: { $implicit: i }" /> }
          </div>
        </section>
      }
    } @else {
      <div class="st-table-wrap inv-twrap">
        <table class="st-table inv-table">
          <thead><tr>
            <th class="inv-ck"><button class="inv-tick" role="checkbox" [attr.aria-checked]="allPicked()" (click)="pickAll(!allPicked())" [attr.aria-label]="'Select all' | t">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.check" /></svg></button></th>
            <th class="inv-thumbc"></th>
            @for (c of columns; track c.key) {
              <th [class.r]="c.r" [class]="'inv-sort inv-c-' + c.key" [attr.data-on]="sortKey() === c.key ? sortDir() : null" (click)="sortBy(c.key)">{{ c.label | t }}</th>
            }
          </tr></thead>
          <tbody>
            @for (g of groups(); track g.id) {
              <tr class="inv-grow"><td [attr.colspan]="columns.length + 2">
                <span class="inv-growin"><svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="g.icon" /></svg><b>{{ g.label | t }}</b>
                  <span class="dim">{{ fmt(g.items.length === 1 ? '{n} line' : '{n} lines', { n: g.items.length }) }}@if (g.qtyLine) { · {{ g.qtyLine }} }</span>
                  @if (g.low) { <span class="st-tag" data-tone="warn">{{ fmt('{n} low', { n: g.low }) }}</span> }
                  <span class="inv-growv mono">{{ g.valueLine }}</span></span></td></tr>
              @for (i of g.items; track i.id) {
                <tr [attr.data-key]="i.id" (click)="itemClick($event, i)" (contextmenu)="openMenu($event, i)" [attr.data-low]="i.low ? 1 : null" [attr.data-sel]="picked().has(i.id) ? 1 : null">
                  <td class="inv-ck" (click)="$event.stopPropagation()"><button class="inv-tick" role="checkbox" [attr.aria-checked]="picked().has(i.id)" (click)="pick(i.id, !picked().has(i.id))" [attr.aria-label]="'Select' | t">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.check" /></svg></button></td>
                  <td class="inv-thumbc">@if (pic(i); as src) { <img class="inv-thumb" [src]="src" loading="lazy" referrerpolicy="no-referrer" alt="" (error)="broke(src)"> }
                    @else if (i.facts.colour_hex) { <span class="inv-thumb inv-thumbsw" [style.background]="i.facts.colour_hex"></span> }
                    @else { <span class="inv-thumb inv-thumb0"><svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="icon(i.type)" /></svg></span> }</td>
                  <td class="inv-name">@if (!i.product) { <span class="inv-mark inv-mark-first" data-tone="warn" [title]="'Its product is not in Parts any more' | t">{{ 'no product' | t }}</span> }<b>{{ i.name }}</b></td>
                  <td class="inv-c-type"><span class="mf-chip inv-tchip"><svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="icon(i.type)" /></svg>{{ typeLine(i) }}</span></td>
                  <td class="dim inv-c-maker">{{ makerOf(i) }}</td>
                  <td class="r mono inv-q" [attr.data-low]="i.low ? 1 : null">{{ qty(i.quantity) }} <span class="dim">{{ i.unit }}</span></td>
                  <td class="give-s">{{ i.location || '–' }}</td>
                  <td class="mono dim">{{ i.product?.sku || i.mpn || i.lcsc || '–' }}</td>
                  <td class="r mono dim">{{ i.min_stock == null ? '–' : qty(i.min_stock) }}</td>
                  <td class="r mono" [title]="valueTipOf(i)">{{ valueOf(i) }}</td>
                  <td class="r dim nowrap">{{ ago(i.updated_at) }}</td>
                </tr>
              }
            }
          </tbody>
        </table>
      </div>
    }
    @if (!shown().length) {
      <wb-empty icon="search" text="Nothing matches - try fewer words or clear the filters.">
        <button class="tcv-btn" (click)="clearFilters()">{{ 'Clear' | t }}</button></wb-empty>
    }
  } @else if (loaded()) {
    <wb-empty icon="cube" text="Nothing in stock yet. Open a product and count it in its Stock section, add to My Items above, or tell the Chat what you have." />
  }

  <wb-selbar [count]="picked().size" (clear)="picked.set(none())">
    <button class="tcv-btn" (click)="exportItems(selectedItems())">{{ 'Export' | t }}</button>
    @if (can()) { <button class="tcv-btn tst-del" (click)="removeSelected()">{{ 'Delete' | t }}</button> }
  </wb-selbar>
</div>
<ng-template #cardT let-i>
  <button class="mf-card inv-card" [attr.data-key]="i.id" [attr.data-on]="picked().has(i.id) ? 1 : null"
          [attr.aria-pressed]="picked().has(i.id)" (click)="itemClick($event, i)" (contextmenu)="openMenu($event, i)" [title]="i.name">
    <span class="mf-card-img inv-cimg">
      @if (pic(i); as src) { <img [src]="src" loading="lazy" decoding="async" referrerpolicy="no-referrer" alt="" (error)="broke(src)"> }
      @else if (i.facts.colour_hex) { <svg class="inv-spool" viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="32" cy="32" r="29" class="inv-spool-rim" /><circle cx="32" cy="32" r="25" [style.fill]="i.facts.colour_hex" class="inv-spool-fil" />
        <circle cx="32" cy="32" r="25" class="inv-spool-lines" /><circle cx="32" cy="32" r="10" class="inv-spool-hub" /><circle cx="32" cy="32" r="4" class="inv-spool-hole" /></svg> }
      @else { <svg class="mf-noimg inv-tph" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="icon(i.type)" /></svg> }
      @if (i.quantity <= 0) { <span class="mf-stock" data-s="out">{{ 'Out of stock' | t }}</span> }
      @else if (i.low) { <span class="mf-stock inv-lowflag">{{ 'Low' | t }}</span> }
    </span>
    <span class="mf-card-body">
      <span class="mf-card-name">{{ i.name }}</span>
      <span class="inv-big"><b>{{ qty(i.quantity) }}</b><small>{{ i.unit }}</small><em>{{ valueOf(i) }}</em></span>
      <span class="inv-sub">{{ makerOf(i) }}</span>
      <span class="mf-card-foot">@if (i.location) { <span class="mf-chip" [title]="i.location">{{ i.location }}</span> }<span class="mf-ago">{{ fmt('changed {w}', { w: ago(i.updated_at) }) }}</span></span>
    </span>
  </button>
</ng-template>
<datalist id="inv-units">@for (u of units(); track u) { <option [value]="u"></option> }</datalist>
<datalist id="inv-locs">@for (l of locations(); track l) { <option [value]="l"></option> }</datalist>`,
})
export class StockView implements OnDestroy {
  private api = inject(InventoryApi);
  private state = inject(StockState);
  private auth = inject(Auth);
  private search = viewChild<ElementRef<HTMLInputElement>>('search');
  private addName = viewChild<ElementRef<HTMLInputElement>>('addName');
  /** A line clicked: its product opens (manufacturers.ts). */
  readonly open = output<Item>();
  /** Words of a search given by the page (the Parts search box). */
  readonly words = input('');

  can = computed(() => this.auth.can('draw'));
  readonly I = I;
  readonly columns: { key: SortKey; label: string; r?: boolean }[] = [
    { key: 'name', label: 'Product' }, { key: 'type', label: 'Type' }, { key: 'maker', label: 'Maker' },
    { key: 'quantity', label: 'On hand', r: true }, { key: 'location', label: 'Location' }, { key: 'code', label: 'Code' },
    { key: 'min_stock', label: 'Min', r: true }, { key: 'value', label: 'Value', r: true }, { key: 'updated_at', label: 'Changed', r: true },
  ];

  /** The view's filters, kept in the address with the page's (?sub=stock&type=&iloc=&low=1&smaker=). */
  private url = new URLSearchParams(location.search);
  q = signal(this.url.get('sq') ?? '');
  fType = signal(TYPE.has(this.url.get('type') ?? '') ? this.url.get('type')! : '');
  fLoc = signal(this.url.get('iloc') ?? '');
  fMaker = signal(this.url.get('smaker') ?? '');
  fLow = signal(this.url.get('low') === '1');
  layout = signal<'grid' | 'table'>(this.url.get('sview') === 'grid' ? 'grid' : 'table');
  sortKey = signal<SortKey>('name');
  sortDir = signal<'asc' | 'desc'>('asc');

  all = signal<Item[]>([]);
  loaded = signal(false);
  busy = signal(false);
  addError = signal<string | null>(null);
  pasting = signal(false);
  pasted = signal('');
  pasteReason = signal('');
  picked = signal<Set<string>>(new Set());
  broken = signal<Set<string>>(new Set());
  form = signal({ name: '', quantity: '', unit: '', location: '', category: '', min: '' });
  setF(k: 'name' | 'quantity' | 'unit' | 'location' | 'category' | 'min', v: string) { this.form.update(f => ({ ...f, [k]: v })); }
  private poll = setInterval(() => { if (!document.hidden) this.read(); }, 15_000);
  none = () => new Set<string>();

  constructor() {
    effect(() => { this.state.changed(); untracked(() => this.read()); });
    effect(() => { const w = this.words(); if (w) untracked(() => this.q.set(w)); });
    effect(() => {
      const q = this.q(), ty = this.fType(), l = this.fLoc(), low = this.fLow(), mk = this.fMaker(), v = this.layout();
      const url = new URL(location.href);
      const set = (k: string, val: string | null) => val ? url.searchParams.set(k, val) : url.searchParams.delete(k);
      set('sq', q); set('type', ty); set('iloc', l); set('low', low ? '1' : null); set('smaker', mk); set('sview', v === 'grid' ? 'grid' : null);
      if (url.href !== location.href) history.replaceState(null, '', url);
    });
  }

  read() {
    this.api.list().subscribe({ next: rows => { this.all.set(rows); this.loaded.set(true); }, error: () => this.loaded.set(true) });
  }

  // ---- the list, its filters and its sections

  baseShown = computed(() => {
    const w = fold(this.q()).split(/\s+/).filter(Boolean), l = this.fLoc(), low = this.fLow(), mk = this.fMaker();
    return this.all().filter(i => {
      if (low && !i.low) return false;
      if (l && i.location !== l) return false;
      if (mk && i.catalog?.manufacturer !== mk) return false;
      if (!w.length) return true;
      const f = i.facts || {};
      const h = fold([i.name, i.mpn, i.lcsc, i.manufacturer, i.category, i.location, i.board, i.notes, i.tags.join(' '),
        i.product?.maker ?? '', i.product?.sku ?? '', i.product?.category ?? '', i.catalog?.manufacturer_name ?? '',
        i.type, t(TYPE.get(i.type)?.label ?? ''), i.subtype, t(SUBTYPE.get(i.subtype) ?? ''), f.size ?? '', f.value ?? '',
        f.package ?? '', f.material ?? '', f.colour ?? '', f.colour ? t(COLOURS[f.colour] ?? '') : '', f.standard ?? '', f.head ?? ''].join(' '));
      return w.every(x => h.includes(x));
    });
  });
  shown = computed(() => { const ty = this.fType(); return ty ? this.baseShown().filter(i => i.type === ty) : this.baseShown(); });
  filtering = computed(() => !!(this.q().trim() || this.fType() || this.fLoc() || this.fLow() || this.fMaker()));
  locations = computed(() => [...new Set(this.all().map(i => i.location).filter(Boolean))].sort((a, b) => a.localeCompare(b)));
  units = computed(() => [...new Set([...UNITS, ...this.all().map(i => i.unit)])]);
  allTypes = computed(() => TYPES.filter(x => this.all().some(i => i.type === x.id)));
  typesLine = computed(() => this.allTypes().map(x => t(x.label)).join(', '));
  products = computed(() => new Set(this.all().map(i => `${i.catalog?.manufacturer}:${i.catalog?.product}`)).size);
  clearFilters() { this.q.set(''); this.fType.set(''); this.fLoc.set(''); this.fLow.set(false); this.fMaker.set(''); }

  typeOpts = computed<SelectOption[]>(() => {
    const base = this.baseShown();
    return [{ value: '', label: t('All types'), hint: base.length },
      ...TYPES.map(x => ({ value: x.id, label: t(x.label), hint: base.filter(i => i.type === x.id).length })).filter(o => o.hint || o.value === this.fType())];
  });
  placeOpts = computed<SelectOption[]>(() => {
    const m = new Map<string, number>();
    for (const i of this.all()) if (i.location) m.set(i.location, (m.get(i.location) ?? 0) + 1);
    return [{ value: '', label: t('All places') }, ...[...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, n]) => ({ value: name, label: name, hint: n }))];
  });
  makerOpts = computed<SelectOption[]>(() => {
    const m = new Map<string, [string, number]>();
    for (const i of this.all()) { const id = i.catalog?.manufacturer; if (id) m.set(id, [this.makerOf(i), (m.get(id)?.[1] ?? 0) + 1]); }
    return [{ value: '', label: t('All makers') }, ...[...m.entries()].sort((a, b) => a[1][0].localeCompare(b[1][0])).map(([id, [name, n]]) => ({ value: id, label: name, hint: n }))];
  });

  stats = computed(() => {
    const rows = this.all();
    return { low: rows.filter(i => i.low).length, out: rows.filter(i => i.quantity <= 0).length,
             withMin: rows.filter(i => i.min_stock != null).length, priced: rows.filter(i => this.price(i)).length,
             valueLine: this.valueLine(rows), valueTip: this.valueTip(rows) };
  });
  recent = computed(() => [...this.all()].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')));

  sorted = computed(() => {
    const k = this.sortKey(), d = this.sortDir() === 'asc' ? 1 : -1;
    const val = (i: Item): unknown => k === 'type' ? this.typeLine(i) : k === 'maker' ? this.makerOf(i) : k === 'value' ? this.worth(i)?.v
      : k === 'code' ? (i.product?.sku || i.mpn || i.lcsc) : i[k];
    return [...this.shown()].sort((a, b) => {
      const x = val(a), y = val(b);
      if (x == null || x === '') return y == null || y === '' ? 0 : 1;
      if (y == null || y === '') return -1;
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * d;
    });
  });
  groups = computed<Group[]>(() => {
    const by = new Map<string, Item[]>();
    for (const i of this.sorted()) { const k = TYPE.has(i.type) ? i.type : 'other'; by.set(k, [...(by.get(k) ?? []), i]); }
    return TYPES.filter(x => by.has(x.id)).map(x => {
      const items = by.get(x.id)!;
      return { id: x.id, label: x.label, icon: x.icon, items, low: items.filter(i => i.low).length,
               qtyLine: this.qtyLine(items), valueLine: this.valueLine(items) };
    });
  });
  sortBy(k: SortKey) {
    if (this.sortKey() === k) this.sortDir.set(this.sortDir() === 'asc' ? 'desc' : 'asc');
    else { this.sortKey.set(k); this.sortDir.set(k === 'updated_at' || k === 'value' || k === 'quantity' ? 'desc' : 'asc'); }
  }
  pick(id: string, on: boolean) { const s = new Set(this.picked()); if (on) s.add(id); else s.delete(id); this.picked.set(s); }
  itemClick(e: MouseEvent, i: Item) {
    if (e.ctrlKey || e.metaKey || e.shiftKey) { this.pick(i.id, !this.picked().has(i.id)); return; }
    this.open.emit(i);
  }
  pickAll(on: boolean) { this.picked.set(on ? new Set(this.shown().map(i => i.id)) : new Set()); }
  allPicked = computed(() => this.shown().length > 0 && this.shown().every(i => this.picked().has(i.id)));
  selectedItems = computed(() => this.all().filter(i => this.picked().has(i.id)));

  /** A line's price: its product's, as Parts keeps it (else the one the line kept from before). */
  private price(i: Item): { amount: number; currency: string } | null {
    const p = i.product?.price;
    if (p?.amount != null) return { amount: p.amount, currency: p.currency || '' };
    return i.price != null ? { amount: i.price, currency: i.currency || '' } : null;
  }
  private worth(i: Item): { v: number; c: string } | null { const p = this.price(i); return p ? { v: p.amount * (i.quantity || 0), c: p.currency } : null; }
  valueOf(i: Item) { const w = this.worth(i); return w ? moneyIn(w.v, w.c) : '–'; }
  valueTipOf(i: Item) { const w = this.worth(i); return w ? moneyTip(w.v, w.c) : ''; }
  private qtyLine(items: Item[]): string {
    const grams = items.reduce((a, i) => a + (i.facts?.weight_g ?? 0), 0);
    const units = new Map<string, number>();
    for (const i of items.filter(x => x.facts?.weight_g == null)) units.set(i.unit, (units.get(i.unit) ?? 0) + i.quantity);
    const parts = [...units.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([u, n]) => `${qty(n)} ${u}`);
    return [grams ? this.weight(grams) : '', ...parts].filter(Boolean).join(' · ');
  }
  private valueLine(items: Item[]): string {
    const value = new Map<string, number>();
    for (const i of items) { const w = this.worth(i); if (w) value.set(w.c || '?', (value.get(w.c || '?') ?? 0) + w.v); }
    return [...value.entries()].map(([c, v]) => moneyIn(v, c)).join(' · ');
  }
  private valueTip(items: Item[]): string {
    const d = CURRENCY();
    let sum = 0, other = false;
    for (const i of items) {
      const w = this.worth(i);
      if (!w) continue;
      const v = w.c ? convert(w.v, w.c, d) : null;
      if (v == null) return '';
      sum += v; other ||= w.c !== d;
    }
    return other ? `≈ ${moneyIn(sum, d)}` : '';
  }

  // ---- what a row shows

  flat(g: Group): boolean { return !g.items.some(i => this.pic(i) || i.facts?.colour_hex); }
  icon(type: string): string { return (TYPE.get(type) ?? TYPE.get('other')!).icon; }
  typeLine(i: Item): string {
    const ty = t(TYPE.get(i.type)?.label ?? i.type);
    return i.type === 'electronic' && i.subtype ? `${ty} · ${t(SUBTYPE.get(i.subtype) ?? i.subtype)}` : ty;
  }
  makerOf(i: Item): string { return i.product?.maker || i.catalog?.manufacturer_name || i.manufacturer || ''; }
  pic(i: Item): string | null {
    const b = this.broken();
    const own = (i.images ?? []).find(u => !b.has(u));
    if (own) return own;
    const photo = i.photo && i.lcsc ? `/api/parts/${i.lcsc}/photo.jpg` : null;
    return photo && !b.has(photo) ? photo : null;
  }
  broke(src: string) { if (!this.broken().has(src)) this.broken.update(s => new Set(s).add(src)); }
  weight(g: number): string { return g >= 1000 ? `${qty(Math.round(g / 10) / 100)} kg` : `${qty(Math.round(g))} g`; }
  openMenu(e: MouseEvent, i: Item) {
    const url = i.product?.url;
    ContextMenu.open(e, [
      { label: 'Open', icon: 'right', kbd: 'Enter', run: () => this.open.emit(i) },
      !!url && { label: 'Open its page', icon: 'open', kbd: '↗', run: () => window.open(url!, '_blank', 'noopener,noreferrer') },
      { label: 'Export', icon: 'doc', run: () => this.exportItems([i]) },
      { sep: true },
      this.can() && { label: 'Delete', icon: 'trash', kbd: 'Del', danger: true, run: () => this.removeMany([i]) },
    ]);
  }

  // ---- adding an own item

  add() {
    const f = this.form();
    if (!f.name.trim()) { this.addError.set(t('An item needs a name.')); this.addName()?.nativeElement.focus(); return; }
    const q = f.quantity.trim() ? num(f.quantity) : 1;
    if (q == null || q < 0) { this.addError.set(t('The quantity is not a number.')); return; }
    const min = f.min.trim() ? num(f.min) : null;
    if (f.min.trim() && min == null) { this.addError.set(t('The minimum is not a number.')); return; }
    this.busy.set(true);
    this.addError.set(null);
    this.api.create({ name: f.name.trim(), quantity: q, unit: f.unit.trim() || 'pcs', location: f.location.trim(),
                      category: f.category.trim(), min_stock: min }).subscribe({
      next: r => {
        this.busy.set(false);
        this.form.set({ name: '', quantity: '', unit: '', location: f.location, category: f.category, min: '' });
        say(r.merged ? fmt('Topped up {name}: now {q}', { name: r.item.name, q: `${qty(r.item.quantity)} ${r.item.unit}` })
                     : fmt('Added {name} to My Items and stock', { name: r.item.name }));
        this.state.touch();
        setTimeout(() => this.addName()?.nativeElement.focus(), 0);
      },
      error: (e: HttpErrorResponse) => { this.busy.set(false); this.addError.set(why(e, 'Could not add it.')); },
    });
  }
  parsed = computed(() => this.pasted().split(/\r?\n/).map(parseLine).filter((x): x is NonNullable<typeof x> => !!x));
  goodParsed = computed(() => this.parsed().filter(p => !p.error));
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
        say(fmt('{a} added, {m} topped up', { a: added, m: merged }) + (bad.length ? ' · ' + fmt('{n} not added: {why}', { n: bad.length, why: bad.map(b => `${b.name || '?'}: ${b.error}`).join('; ') }) : ''));
        if (!bad.length) { this.pasted.set(''); this.pasteReason.set(''); }
        this.state.touch();
      },
      error: (e: HttpErrorResponse) => { this.busy.set(false); say(why(e, 'Could not add them.'), 'danger'); },
    });
  }

  // ---- removing, files

  private async removeMany(items: Item[]) {
    if (!items.length || !await Confirm.ask({ title: items.length === 1 ? t('Stop counting it in stock?') : fmt('Stop counting {n} products in stock?', { n: items.length }),
                                             text: t('The lines and their logs go; the products stay in Parts.'), ok: t('Delete'), danger: true })) return;
    this.api.removeMany(items.map(i => i.id)).subscribe({
      next: r => { this.picked.set(new Set()); this.all.update(l => l.filter(i => !r.deleted.includes(i.id))); this.state.touch(); },
      error: (e: HttpErrorResponse) => say(why(e, 'Could not delete them.'), 'danger'),
    });
  }
  removeSelected() { this.removeMany(this.selectedItems()); }
  exportItems(items: Item[]) {
    this.api.exportFile(items.map(i => i.id)).subscribe({
      next: data => {
        const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url;
        const one = items.length === 1 ? items[0].name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() : '';
        a.download = `${one || 'stock'}.inventory.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      },
      error: (e: HttpErrorResponse) => say(why(e, 'Could not export it.'), 'danger'),
    });
  }
  importFile(inp: HTMLInputElement) {
    const f = inp.files?.[0];
    inp.value = '';
    if (!f) return;
    f.text().then(text => {
      let data: unknown;
      try { data = JSON.parse(text); } catch { say(t('That file is not a stock file.')); return; }
      this.api.importFile(data).subscribe({
        next: r => { this.state.touch(); say(fmt('Imported: {a} added, {m} topped up', { a: r.added, m: r.merged }) + (r.skipped.length ? ' · ' + fmt('{n} not added', { n: r.skipped.length }) : '')); },
        error: (e: HttpErrorResponse) => say(why(e, 'Could not import it.'), 'danger'),
      });
    });
  }

  qty = qty;
  ago = ago;
  t = t;
  fmt = fmt;

  key(e: KeyboardEvent) {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName);
    if (e.key === 'Escape' && this.picked().size && !typing && !ContextMenu.isOpen() && !document.querySelector('.mf-modal')) { this.picked.set(new Set()); return; }
    if (e.key === '/' && !typing && !document.querySelector('.mf-modal')) { e.preventDefault(); e.stopPropagation(); this.search()?.nativeElement.focus(); }
  }

  ngOnDestroy() {
    clearInterval(this.poll);
    const url = new URL(location.href);
    for (const k of ['sq', 'type', 'iloc', 'low', 'smaker', 'sview']) url.searchParams.delete(k);
    history.replaceState(null, '', url);
  }
}
