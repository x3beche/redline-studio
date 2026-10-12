import { Component, ElementRef, Injectable, OnDestroy, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { Toast, ToastTone } from '../toast';
import { NgTemplateOutlet } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Selection } from '../selection';
import { Auth } from '../auth';
import { LANG, T, t } from '../i18n';
import { Confirm } from '../confirm';
import { DmSendButton } from '../dm';
import { ContextMenu } from '../context-menu';
import { SelectionBar } from '../selection-bar';
import { SelectOption, UiSelect } from '../ui-select';
import { TimeChart, TimeData, fmt as chartFmt } from './charts';
import { CountUp } from '../count';
import { CURRENCY, convert, moneyIn, moneyTip } from '../money';
import { Skeleton } from '../skeleton';
import { EmptyState } from '../empty-state';

/** Inventory ("Envanter"): what is on hand - each thing kept, how many, and
 *  where it is (backend/inventory.py), shown the way the Product Catalog
 *  shows its products: a bar to search and filter, and cards - one section
 *  per type (filament, screws, electronic components, modules...).
 *
 *  Every item has a type (backend/inventory_types.py): set by hand, or
 *  worked out from its name, category and part number. A type's cards show
 *  what matters for it - a filament's colour, material and what is left of
 *  the spool; a screw's size and head; a component's value, package and
 *  LCSC number. The table keeps the same items row by row, grouped the
 *  same way, for those who would rather read a list.
 *
 *  An item opens in a panel over the page: its pictures (its catalog
 *  product's, or the LCSC part's), the quantity's -/+ with the reason kept
 *  in its log, its type, its links, a chart of how much was on hand over
 *  time and the log itself. A card's right-click menu opens, adjusts,
 *  edits or deletes it.
 *
 *  The Chat adds and changes items too (backend/chat_tools/inventory_*.py),
 *  so the list is read again every few seconds while the tab is open.
 *
 *  Everything the page shows is in its address (?q=, ?type=, ?iloc=, ?low=1,
 *  ?isort=, ?view=table, ?item=), so a reload comes back to the same place.
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
export interface Item {
  id: string; name: string; quantity: number; unit: string; location: string; category: string; mpn: string; lcsc: string;
  manufacturer: string; board: string; min_stock: number | null; price: number | null; currency: string; notes: string;
  tags: string[]; catalog: CatalogLink | null; by: { id?: string; name?: string }; created_at: string;
  updated_by: { id?: string; name?: string }; updated_at: string; low: boolean; value: number | null;
  last: LogLine | null; log?: LogLine[];
  type: string; subtype: string; type_auto: boolean; type_set: string; facts: Facts;
  images: string[]; photo: boolean; photo_known: boolean;
}
export type NewItem = Partial<Omit<Item, 'id' | 'catalog' | 'facts' | 'images'>> & { name: string; catalog?: { manufacturer: string; product: string } | null };
export interface CatalogStock { quantity: number; unit: string; items: string[]; low: boolean }
export interface FromCatalog { manufacturer: string; quantity: number; unit: string; location: string; note: string }
interface Added { item?: Item; merged?: boolean; error?: string; name?: string }
interface Maker { id: string; name: string; product_count: number; products?: { id: string; name: string; sku: string; url: string }[] }

/** The units offered (backend/inventory.py UNITS); any other short word is kept as written. */
export const UNITS = ['pcs', 'm', 'cm', 'mm', 'kg', 'g', 'l', 'ml', 'roll', 'reel', 'box', 'pack', 'set', 'pair', 'sheet', 'bag'];
export const CURRENCIES = ['TRY', 'USD', 'EUR', 'GBP', 'CNY'];

/** The types, in the order the page shows them (backend/inventory_types.py TYPES), each with its drawing. */
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
/** The colour words a filament's facts carry, said as a person would. */
const COLOURS: Record<string, string> = {
  black: 'Black', white: 'White', grey: 'Grey', silver: 'Silver', red: 'Red', orange: 'Orange', yellow: 'Yellow', gold: 'Gold',
  green: 'Green', blue: 'Blue', navy: 'Navy', turquoise: 'Turquoise', purple: 'Purple', pink: 'Pink', brown: 'Brown',
  beige: 'Beige', natural: 'Natural', wood: 'Wood',
};
/** How a type's card is drawn. */
type Family = 'filament' | 'fastener' | 'electronic' | 'plain';
function familyOf(type: string): Family {
  if (type === 'filament' || type === 'resin') return 'filament';
  if (type === 'screw' || type === 'nut' || type === 'washer' || type === 'insert' || type === 'fastener') return 'fastener';
  if (type === 'electronic') return 'electronic';
  return 'plain';
}

type FormKey = 'name' | 'quantity' | 'unit' | 'location' | 'category' | 'mpn' | 'lcsc' | 'min' | 'type';
type SortKey = 'name' | 'quantity' | 'location' | 'category' | 'type' | 'mpn' | 'min_stock' | 'price' | 'value' | 'updated_at';

const I = {
  close: 'M6 6l12 12 M18 6L6 18',
  grid: 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z',
  rows: 'M4 6h16 M4 12h16 M4 18h16',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  all: 'M4 5h16 M4 10h16 M4 15h16 M4 20h10',
  place: 'M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z M12 7.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5z',
};

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

/** One type's section: its items and what they add up to. */
interface Group { id: string; label: string; icon: string; items: Item[]; low: number; qtyLine: string; valueLine: string }

@Component({
  selector: 'app-room-inventory',
  imports: [EmptyState, Skeleton, CountUp, T, DmSendButton, UiSelect, TimeChart, NgTemplateOutlet, SelectionBar],
  styleUrls: ['../settings.css', './taste.css', './manufacturers.css', './inventory.css'],
  host: { '(document:keydown)': 'key($event)' },
  template: `
<div class="tcv-room absolute inset-0 flex min-h-0 gap-1 p-1">
  <!-- LEFT: the types, and the places -->
  <aside class="tcv-notes-side inv-side">
    @if (can()) {
      <div class="inv-side-acts">
        <button class="tcv-btn" (click)="goAdd()">{{ 'Add an item' | t }}</button>
        <button class="tcv-btn" (click)="goPaste()">{{ 'Paste a list' | t }}</button>
        <button class="tcv-btn" (click)="importIn.click()" [title]="'Add the items of a file someone sent you' | t">{{ 'Import…' | t }}</button>
        <input #importIn type="file" accept=".json,application/json" hidden (change)="importFile($any($event.target))">
      </div>
    }
    <div class="tcv-notes-list inv-nav">
      <button class="tcv-notes-item inv-tnav" [attr.data-on]="!fType() ? 1 : null" (click)="fType.set('')">
        <span class="inv-tico"><svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.all" /></svg></span>
        <span class="inv-tname">{{ 'All items' | t }}</span>
        <span class="inv-tn">{{ baseShown().length }}</span>
      </button>
      @for (c of typeCounts(); track c.id) {
        <button class="tcv-notes-item inv-tnav" [attr.data-on]="fType() === c.id ? 1 : null" (click)="fType.set(fType() === c.id ? '' : c.id)">
          <span class="inv-tico"><svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="c.icon" /></svg></span>
          <span class="inv-tname">{{ c.label | t }}</span>
          @if (c.low) { <span class="inv-tlow" [title]="fmt('{n} low', { n: c.low })">{{ c.low }}</span> }
          <span class="inv-tn">{{ c.n }}</span>
        </button>
      }
      @if (placeCounts().length) {
        <span class="inv-navhead">{{ 'Places' | t }}</span>
        @for (p of placeCounts(); track p.name) {
          <button class="tcv-notes-item inv-tnav inv-pnav" [attr.data-on]="fLoc() === p.name ? 1 : null" (click)="fLoc.set(fLoc() === p.name ? '' : p.name)">
            <span class="inv-tico"><svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.place" /></svg></span>
            <span class="inv-tname">{{ p.name }}</span><span class="inv-tn">{{ p.n }}</span>
          </button>
        }
      }
      @if (loaded() && !all().length) { <wb-empty compact icon="cube" text="Nothing on hand yet." /> }
    </div>
  </aside>

  <section class="tcv-notes-main tst inv">

    <!-- ================= the overview ================= -->
    <header class="tst-head tsh-head mf-homehead">
      <div class="tst-title">
        <h2>{{ 'Inventory' | t }}</h2>
        <span class="st-sub">{{ 'What you have on hand, by type - how many and where. Chat adds and changes items too when you tell it.' | t }}</span>
      </div>
      <div class="tst-acts">
        @if (all().length) { <button class="tcv-btn" (click)="exportItems([])" [title]="'Save every item as a file' | t">{{ 'Export all' | t }}</button> }
        @if (can()) { <button class="tcv-btn tcv-btn-accent" (click)="adding() ? adding.set(false) : goAdd()">{{ (adding() ? 'Close' : 'Add an item') | t }}</button> }
      </div>
    </header>
    @if (!loaded()) { <wb-skel kind="tiles" [count]="5" [min]="160" /> } @else {
    <div class="st-tiles inv-tiles wb-in">
      <div class="st-tile" [attr.data-tone]="all().length ? null : 'dim'"><span>{{ 'Items' | t }}</span><b [wbCount]="all().length"></b>
        <small>{{ fmt('in {p} places', { p: locations().length }) }}</small></div>
      <div class="st-tile" [attr.data-tone]="allTypes().length ? null : 'dim'"><span>{{ 'Types' | t }}</span><b [wbCount]="allTypes().length"></b>
        <small [title]="typesLine()">{{ typesLine() || ('none yet' | t) }}</small></div>
      <button class="st-tile mf-tilebtn" [attr.data-tone]="stats().low ? 'warn' : 'dim'" (click)="fLow.set(!fLow())" [title]="'Only items at or below their minimum' | t">
        <span>{{ 'Low stock' | t }}</span><b [wbCount]="stats().low"></b>
        <small>{{ fmt('{o} out of stock · {n} with a minimum', { o: stats().out, n: stats().withMin }) }}</small></button>
      <div class="st-tile inv-value" [attr.data-tone]="stats().valueLine ? null : 'dim'"><span>{{ 'Value' | t }}</span><b [title]="stats().valueTip || stats().valueLine" [wbCount]="stats().valueLine || '–'"></b>
        <small>{{ fmt('{n} items priced', { n: stats().priced }) }}</small></div>
      <div class="st-tile" [attr.data-tone]="recent().length ? null : 'dim'"><span>{{ 'Last change' | t }}</span><b>{{ recent().length ? ago(recent()[0].updated_at) : '–' }}</b>
        <small [title]="recent().length ? recent()[0].name : ''">{{ recent().length ? recent()[0].name + ' · ' + (recent()[0].updated_by.name || '') : ('none yet' | t) }}</small></div>
    </div>
    }

    @if (can() && adding()) {
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
              <wb-select class="inv-a-type" label="Type" [options]="typeSetOpts()" [value]="form().type" (pick)="setF('type', $event)" />
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
      <!-- the bar: search, type, place, low, sort, layout -->
      <div class="mf-gbar mf-ctl inv-gbar wb-in">
        <input #search class="tst-in mf-gfind" type="search" [placeholder]="'Search: name, size, value, part number, place   /' | t" [value]="q()"
               (input)="q.set($any($event.target).value)" (keydown.escape)="q.set(''); $any($event.target).blur()" [attr.aria-label]="'Search the inventory' | t">
        <wb-select class="mf-gsel" label="Type" placeholder="All types" [options]="typeOpts()" [value]="fType()" (pick)="fType.set($event)" />
        <wb-select class="mf-gsel" label="Location" placeholder="All places" [options]="placeOpts()" [value]="fLoc()" (pick)="fLoc.set($event)" />
        <button type="button" class="mf-stocktog" role="switch" [attr.aria-checked]="fLow()" (click)="fLow.set(!fLow())">
          <span class="tcv-switch" [attr.data-on]="fLow() ? 1 : null" aria-hidden="true"></span>{{ 'Low stock' | t }}</button>
        <wb-select class="mf-gsel mf-gsort" label="Sort" placeholder="Sort" [options]="sortOpts()" [value]="sortOpt()" (pick)="pickSort($event)" />
        @if (filtering()) { <button class="tcv-btn" (click)="clearFilters()">{{ 'Clear' | t }}</button> }
        <span class="st-right st-sub mf-gcount">{{ filtering() ? fmt('{n} of {m}', { n: shown().length, m: all().length }) : fmt('{n} items', { n: all().length }) }}</span>
        <div class="st-seg mf-layout" role="radiogroup" [attr.aria-label]="'Layout' | t">
          <button [class.on]="layout() === 'grid'" (click)="layout.set('grid')" [title]="'Grid' | t"><svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.grid" /></svg>{{ 'Grid' | t }}</button>
          <button [class.on]="layout() === 'table'" (click)="layout.set('table')" [title]="'Table' | t"><svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.rows" /></svg>{{ 'Table' | t }}</button>
        </div>
      </div>

      @if (layout() === 'grid') {
        @for (g of groups(); track g.id) {
          <section class="inv-sec" [attr.data-type]="g.id" [attr.data-flat]="flat(g) ? 1 : null">
            <header class="inv-sechead">
              <span class="inv-secico"><svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="g.icon" /></svg></span>
              <h3>{{ g.label | t }}</h3>
              <span class="inv-secn">{{ fmt(g.items.length === 1 ? '{n} item' : '{n} items', { n: g.items.length }) }}</span>
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
                    <span class="dim">{{ fmt(g.items.length === 1 ? '{n} item' : '{n} items', { n: g.items.length }) }}@if (g.qtyLine) { · {{ g.qtyLine }} }</span>
                    @if (g.low) { <span class="st-tag" data-tone="warn">{{ fmt('{n} low', { n: g.low }) }}</span> }
                    <span class="inv-growv mono">{{ g.valueLine }}</span></span></td></tr>
                @for (i of g.items; track i.id) {
                  <tr (click)="openItem(i.id)" (contextmenu)="openMenu($event, i)" [attr.data-low]="i.low ? 1 : null" [attr.data-sel]="picked().has(i.id) ? 1 : null">
                    <td class="inv-ck" (click)="$event.stopPropagation()"><button class="inv-tick" role="checkbox" [attr.aria-checked]="picked().has(i.id)" (click)="pick(i.id, !picked().has(i.id))" [attr.aria-label]="'Select' | t">
                      <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.check" /></svg></button></td>
                    <td class="inv-thumbc">@if (pic(i); as src) { <img class="inv-thumb" [src]="src" loading="lazy" referrerpolicy="no-referrer" alt="" (error)="broke(src)"> }
                      @else if (i.facts.colour_hex) { <span class="inv-thumb inv-thumbsw" [style.background]="i.facts.colour_hex"></span> }
                      @else { <span class="inv-thumb inv-thumb0"><svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="icon(i.type)" /></svg></span> }</td>
                    <td class="inv-name"><b>{{ i.name }}</b>@if (i.catalog) { <span class="inv-mark" [title]="'Linked to the Product Catalog' | t">CAT</span> }</td>
                    <td class="inv-c-type"><span class="mf-chip inv-tchip"><svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="icon(i.type)" /></svg>{{ typeLine(i) }}</span></td>
                    <td class="r mono inv-q" [attr.data-low]="i.low ? 1 : null">{{ qty(i.quantity) }} <span class="dim">{{ i.unit }}</span></td>
                    <td class="give-s">{{ i.location || '–' }}</td>
                    <td class="dim">{{ i.category || '–' }}</td>
                    <td class="mono dim">@if (i.lcsc) { <a class="inv-lcsc" [href]="lcscUrl(i.lcsc)" target="_blank" rel="noopener noreferrer" (click)="$event.stopPropagation()">{{ i.lcsc }}</a> } {{ i.mpn || (i.lcsc ? '' : '–') }}</td>
                    <td class="r mono dim">{{ i.min_stock == null ? '–' : qty(i.min_stock) }}</td>
                    <td class="r mono" [title]="i.price == null ? '' : moneyTip(i.price, i.currency)">{{ i.price == null ? '–' : money(i.price, i.currency) }}</td>
                    <td class="r mono" [title]="i.value == null ? '' : moneyTip(i.value, i.currency)">{{ i.value == null ? '–' : money(i.value, i.currency) }}</td>
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
      <section class="st-card tsh-how">
        <div class="st-card-head"><h3>{{ 'How it works' | t }}</h3></div>
        <ol class="tsh-steps">
          <li><span class="tsh-n">1</span><div><b>{{ 'Add what you have' | t }}</b>
            <p>{{ 'One item at a time, or paste a list - name, quantity, unit, place - one a line. Its type is worked out from its name.' | t }}</p></div></li>
          <li><span class="tsh-n">2</span><div><b>{{ 'Or tell the Chat' | t }}</b>
            <p>{{ '"I got 200 M3x8 screws, they are on shelf A" - it adds them, or tops up the ones already kept.' | t }}</p></div></li>
          <li><span class="tsh-n">3</span><div><b>{{ 'Take what you use' | t }}</b>
            <p>{{ 'An item\\'s - and + keep the reason: "used 4 for the fan board". Set a minimum to see what runs low.' | t }}</p></div></li>
        </ol>
      </section>
    } @else { <wb-skel kind="cards" [count]="10" [min]="200" /> }

    <!-- the table's ticked rows, floating over the list -->
    <wb-selbar [count]="picked().size" (clear)="clearPicked()">
      <button class="tcv-btn" (click)="exportItems(selectedItems())">{{ 'Export' | t }}</button>
      @if (can()) { <button class="tcv-btn tst-del" (click)="removeSelected()">{{ 'Delete' | t }}</button> }
    </wb-selbar>
  </section>
  <!-- ================= one item, in full: over the whole page (see the catalog's) ================= -->
  @if (iid()) {
    <div class="mf-modal tcv-m-veil inv" animate.leave="tcv-leave" (click)="closeItem()">
      <div class="mf-detail tcv-m-box inv-detail" role="dialog" aria-modal="true" [attr.aria-label]="item()?.name || ''" (click)="$event.stopPropagation()">
        <button class="tcv-cc-ib mf-x" (click)="closeItem()" [title]="'Close' | t">
          <svg class="tcv-cc-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.close" /></svg></button>
        @if (item(); as it) {
          <div class="mf-dgal">
            <div class="mf-dimg">
              @if (bigImg(); as src) { <img [src]="src" referrerpolicy="no-referrer" alt="" (error)="broke(src)"> }
              @else if (it.facts.colour_hex) { <ng-container *ngTemplateOutlet="spoolT; context: { $implicit: it }" /> }
              @else { <svg class="mf-noimg inv-bigico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="icon(it.type)" /></svg> }
            </div>
            @if (gallery().length > 1) {
              <div class="mf-thumbs">@for (u of gallery(); track u) {
                <button [class.on]="u === bigImg()" (click)="shot.set(u)"><img [src]="u" loading="lazy" referrerpolicy="no-referrer" alt="" (error)="broke(u)"></button> }</div>
            }
            @if (factRows(it).length) {
              <span class="mf-label">{{ 'Properties' | t }}</span>
              <table class="mf-dspecs"><tbody>@for (r of factRows(it); track r[0]) {
                <tr><th>{{ r[0] | t }}</th><td>@if (r[0] === 'Colour' && it.facts.colour_hex) { <i class="inv-sw" [style.background]="it.facts.colour_hex"></i> }{{ r[1] }}</td></tr> }</tbody></table>
            }
          </div>
          <div class="mf-dinfo">
            <div class="inv-dtype">
              <span class="inv-dtico"><svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="icon(it.type)" /></svg></span>
              @if (can()) {
                <wb-select class="inv-dsel" label="Type" [options]="typeSetOpts(it)" [value]="it.type_set" (pick)="setType(it, $event)"
                           [title]="it.type_auto ? ('Worked out from its name, category and part number. Choose one to set it by hand.' | t) : ''" />
                @if (it.type === 'electronic') {
                  <wb-select class="inv-dsel" label="Component kind" [options]="subOpts()" [value]="it.subtype" (pick)="patch(it, { subtype: $event })" />
                }
              } @else { <span>{{ typeLine(it) }}</span> }
              @if (it.type_auto && !can()) { <span class="st-sub" [title]="'Worked out from its name, category and part number. Choose one to set it by hand.' | t">{{ 'worked out' | t }}</span> }
            </div>
            @if (editing() && can()) {
              <input class="tst-in inv-dname-in" [value]="it.name" (change)="save(it, 'name', $any($event.target).value)" (keydown.enter)="$any($event.target).blur()" [attr.aria-label]="'Name' | t">
            } @else { <h2 class="mf-dname">{{ it.name }}</h2> }
            <div class="mf-dmeta">
              @if (it.category) { <span class="mf-chip">{{ it.category }}</span> }
              @if (it.location) { <span class="mf-chip inv-loc">{{ it.location }}</span> }
              @if (it.lcsc) { <a class="mf-link mono" [href]="lcscUrl(it.lcsc)" target="_blank" rel="noopener noreferrer">{{ it.lcsc }}</a>
                <button class="st-more inv-go" (click)="toPart(it.lcsc)" [title]="'Open it in the PCB room\\'s parts' | t">{{ 'Parts drawer' | t }}</button> }
              @if (it.mpn) { <span class="mono">{{ it.mpn }}</span> }
              @if (it.manufacturer) { <span>{{ it.manufacturer }}</span> }
              @for (tg of it.tags; track tg) { <span class="st-tag">#{{ tg }}</span> }
            </div>

            <!-- the quantity, and changing it with a reason -->
            <div class="inv-qrow">
              <div class="inv-qbig" [attr.data-low]="it.low ? 1 : null" [attr.data-out]="it.quantity <= 0 ? 1 : null">
                <b>{{ qty(it.quantity) }}</b><span>{{ it.unit }}</span>
                @if (it.quantity <= 0) { <span class="st-tag" data-tone="danger">{{ 'out of stock' | t }}</span> }
                @else if (it.low) { <span class="st-tag" data-tone="warn">{{ fmt('low - minimum {n}', { n: qty(it.min_stock) }) }}</span> }
              </div>
              @if (it.facts.weight_g != null) {
                <div class="inv-dspool">
                  <span>{{ weight(it.facts.weight_g) }} · {{ spoolLine(it) }}</span>
                  <span class="inv-bar"><i [style.width.%]="it.facts.current_pct ?? 0"></i></span>
                </div>
              }
            </div>
            @if (can()) {
              <div class="inv-adjust">
                <button class="tcv-btn inv-pm" (click)="adjust(it, -1)" [disabled]="busy()" [title]="'Take this many' | t">−</button>
                <input #stepBox class="tst-in inv-step" [value]="step()" (input)="step.set($any($event.target).value)" inputmode="decimal"
                       [attr.aria-label]="'How many' | t" (keydown.enter)="adjust(it, 1)">
                <button class="tcv-btn inv-pm" (click)="adjust(it, 1)" [disabled]="busy()" [title]="'Add this many' | t">+</button>
                <input #reasonBox class="tst-in inv-reason" [placeholder]="'Why - e.g. used 4 for the fan board' | t" [value]="reason()"
                       (input)="reason.set($any($event.target).value)" (keydown.enter)="adjust(it, -1)" [attr.aria-label]="'Reason' | t">
              </div>
              <span class="st-sub inv-hint">{{ 'Enter in the reason takes; in the amount adds.' | t }}</span>
            }

            <dl class="mf-dates inv-dates">
              <div><dt>{{ 'Added' | t }}</dt><dd>{{ stamp(it.created_at) }}<span class="dim"> · {{ it.by.name || ('someone' | t) }}</span></dd></div>
              <div><dt>{{ 'Last change' | t }}</dt><dd>{{ stamp(it.updated_at) }}<span class="dim"> · {{ it.updated_by.name || ('someone' | t) }}</span></dd></div>
              <div><dt>{{ 'Minimum' | t }}</dt><dd>{{ it.min_stock == null ? ('none' | t) : qty(it.min_stock) + ' ' + it.unit }}</dd></div>
              <div><dt>{{ 'Value' | t }}</dt><dd>{{ it.value != null ? money(it.value, it.currency) + ' (' + money(it.price!, it.currency) + ' / ' + it.unit + ')' : '–' }}</dd></div>
            </dl>

            <div class="mf-dacts">
              @if (it.catalog?.url) { <a class="tcv-btn tcv-btn-accent" [href]="it.catalog!.url" target="_blank" rel="noopener noreferrer">{{ 'Open its page' | t }}</a> }
              <rl-dm-send-btn kind="inventory" [id]="it.id" [label]="it.name" cls="tcv-btn tcv-dm-sendbtn" />
              <button class="tcv-btn" (click)="exportItems([it])" [title]="'Save it as a file to send to someone' | t">{{ 'Export' | t }}</button>
              @if (can()) {
                <button class="tcv-btn" [class.on]="editing()" (click)="editing.set(!editing())">{{ (editing() ? 'Done' : 'Edit') | t }}</button>
                <button class="tcv-btn tst-del" (click)="remove(it)">{{ 'Delete' | t }}</button>
              }
            </div>

            @if (editing() && can()) {
              <!-- every field, in place -->
              <div class="inv-fields">
                <label><span>{{ 'Unit' | t }}</span>
                  <input class="tst-in" list="inv-units" [value]="it.unit" (change)="save(it, 'unit', $any($event.target).value)"></label>
                <label><span>{{ 'Location' | t }}</span>
                  <input class="tst-in" list="inv-locs" [value]="it.location" [placeholder]="'Shelf, bin, box' | t" (change)="save(it, 'location', $any($event.target).value)"></label>
                <label><span>{{ 'Category' | t }}</span>
                  <input class="tst-in" list="inv-cats" [value]="it.category" (change)="save(it, 'category', $any($event.target).value)"></label>
                <label><span>{{ 'Minimum' | t }}</span>
                  <input class="tst-in" inputmode="decimal" [value]="it.min_stock ?? ''" [placeholder]="'none' | t" (change)="saveNum(it, 'min_stock', $any($event.target).value)"></label>
                <label><span>{{ 'MPN' | t }}</span>
                  <input class="tst-in mono" [value]="it.mpn" (change)="save(it, 'mpn', $any($event.target).value)"></label>
                <label><span>{{ 'LCSC' | t }}</span>
                  <input class="tst-in mono" [value]="it.lcsc" placeholder="C25744" (change)="save(it, 'lcsc', $any($event.target).value)"></label>
                <label><span>{{ 'Manufacturer' | t }}</span>
                  <input class="tst-in" [value]="it.manufacturer" (change)="save(it, 'manufacturer', $any($event.target).value)"></label>
                <label><span>{{ 'For (board or model)' | t }}</span>
                  <input class="tst-in" [value]="it.board" (change)="save(it, 'board', $any($event.target).value)"></label>
                <label><span>{{ 'Unit price' | t }}</span>
                  <span class="inv-price">
                    <input class="tst-in" inputmode="decimal" [value]="it.price ?? ''" (change)="saveNum(it, 'price', $any($event.target).value)">
                    <input class="tst-in inv-cur" list="inv-curs" [value]="it.currency" placeholder="TRY" (change)="save(it, 'currency', $any($event.target).value)">
                  </span></label>
                <label><span>{{ 'Tags' | t }}</span>
                  <input class="tst-in" [value]="it.tags.join(', ')" [placeholder]="'comma separated' | t" (change)="save(it, 'tags', $any($event.target).value)"></label>
                <label class="inv-full"><span>{{ 'Notes' | t }}</span>
                  <textarea class="tst-in inv-notes" rows="2" [value]="it.notes" (change)="save(it, 'notes', $any($event.target).value)"></textarea></label>
              </div>
            } @else if (it.notes) { <p class="mf-ddesc">{{ it.notes }}</p> }

            <!-- what it is elsewhere in the app -->
            <div class="inv-links">
              <span class="mf-label">{{ 'Product Catalog' | t }}</span>
              @if (it.catalog; as c) {
                <span class="inv-link">
                  <button class="st-more inv-go" (click)="toCatalog(c)">{{ c.manufacturer_name || c.manufacturer }}{{ c.product_name ? ' / ' + c.product_name : '' }}</button>
                  @if (c.url) { <a class="mf-link" [href]="c.url" target="_blank" rel="noopener noreferrer">{{ 'Page' | t }}</a> }
                  @if (can()) { <button class="st-more inv-unlink" (click)="unlinkCatalog(it)" [title]="'Remove the link' | t">×</button> }</span>
              } @else if (can()) {
                <span class="inv-linker mf-ctl">
                  <wb-select class="inv-linksel" label="Manufacturer" placeholder="Link a catalog product…" [options]="makerOpts()" [value]="linkMaker()" (pick)="pickMaker($event)" />
                  @if (linkMaker()) {
                    <input class="tst-in" list="inv-products" [placeholder]="'Product name or code' | t" (change)="linkProduct(it, $any($event.target).value)">
                    <datalist id="inv-products">@for (p of linkProducts(); track p.id) { <option [value]="p.name + (p.sku ? ' · ' + p.sku : '')"></option> }</datalist>
                  }
                </span>
              } @else { <span class="st-sub">{{ 'Not linked to a catalog product.' | t }}</span> }
            </div>

            <!-- what happened to it -->
            @if (moves(); as m) {
              <span class="mf-label">{{ 'On hand over time' | t }}</span>
              <app-time-chart class="inv-chart" [data]="m" kind="area" [stacked]="false" [legend]="false" [height]="130" [f]="chartFmt.count" />
            }
            <span class="mf-label">{{ fmt('Change log - {n} entries, newest first', { n: it.log?.length ?? 0 }) }}</span>
            <div class="st-table-wrap inv-logwrap">
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
          </div>
        } @else if (itemError(); as e) {
          <div class="st-banner tst-banner inv-derr" role="alert"><span>{{ e }}</span><button class="tcv-btn" (click)="closeItem()">{{ 'Close' | t }}</button></div>
        } @else { <div class="inv-derr"><wb-skel kind="text" [count]="6" /></div> }
      </div>
    </div>
  }
</div>
<!-- ================= shared pieces ================= -->
<ng-template #cardT let-i>
  <button class="mf-card inv-card" [attr.data-fam]="family(i.type)" (click)="openItem(i.id)" (contextmenu)="openMenu($event, i)" [title]="i.name">
    <span class="mf-card-img inv-cimg">
      @if (pic(i); as src) { <img [src]="src" loading="lazy" decoding="async" referrerpolicy="no-referrer" alt="" (error)="broke(src)"> }
      @else if (i.facts.colour_hex) { <ng-container *ngTemplateOutlet="spoolT; context: { $implicit: i }" /> }
      @else { <svg class="mf-noimg inv-tph" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="icon(i.type)" /></svg> }
      @if (i.quantity <= 0) { <span class="mf-stock" data-s="out">{{ 'Out of stock' | t }}</span> }
      @else if (i.low) { <span class="mf-stock inv-lowflag">{{ 'Low' | t }}</span> }
      @if (i.type === 'electronic' && i.subtype) { <span class="inv-kind">{{ subLabel(i.subtype) | t }}</span> }
    </span>
    <span class="mf-card-body">
      <span class="mf-card-name">{{ i.name }}</span>
      @switch (family(i.type)) {
        @case ('filament') {
          <span class="inv-fil">@if (i.facts.colour_hex) { <i class="inv-sw" [style.background]="i.facts.colour_hex"></i> }<span>{{ filLine(i) }}</span></span>
          @if (i.facts.weight_g != null) {
            <span class="inv-big"><b>{{ weight(i.facts.weight_g) }}</b><small>{{ spoolLine(i) }}</small></span>
            <span class="inv-bar" [title]="fmt('{p}% of the spool in use', { p: round(i.facts.current_pct ?? 0) })"><i [style.width.%]="i.facts.current_pct ?? 0"></i></span>
          } @else { <span class="inv-big"><b>{{ qty(i.quantity) }}</b><small>{{ i.unit }}</small></span> }
        }
        @case ('fastener') {
          <span class="inv-big"><b class="mono">{{ i.facts.size || i.facts.thread || '–' }}</b><em>{{ qty(i.quantity) }} {{ i.unit }}</em></span>
          <span class="inv-sub">{{ fastLine(i) || (i.category || ('No size in its name' | t)) }}</span>
        }
        @case ('electronic') {
          <span class="inv-big"><b>{{ i.facts.value || (i.subtype ? (subLabel(i.subtype) | t) : (i.mpn || '–')) }}</b>@if (i.facts.package) { <small class="mono">{{ i.facts.package }}</small> }<em>{{ qty(i.quantity) }} {{ i.unit }}</em></span>
          <span class="inv-sub">@if (i.lcsc) { <a class="inv-lcsc mono" [href]="lcscUrl(i.lcsc)" target="_blank" rel="noopener noreferrer" (click)="$event.stopPropagation()">{{ i.lcsc }}</a> }<span>{{ i.facts.mpn || i.mpn || i.facts.lcsc_category || '' }}</span></span>
        }
        @default {
          <span class="inv-big"><b>{{ qty(i.quantity) }}</b><small>{{ i.unit }}</small>@if (i.value != null) { <em>{{ money(i.value, i.currency) }}</em> }</span>
          <span class="inv-sub">{{ i.category || i.manufacturer || i.catalog?.manufacturer_name || '' }}</span>
        }
      }
      <span class="mf-card-foot">@if (i.location) { <span class="mf-chip" [title]="i.location">{{ i.location }}</span> }<span class="mf-ago">{{ fmt('changed {w}', { w: ago(i.updated_at) }) }}</span></span>
    </span>
  </button>
</ng-template>
<!-- a spool in the filament's colour, for one without a picture -->
<ng-template #spoolT let-i>
  <svg class="inv-spool" viewBox="0 0 64 64" aria-hidden="true">
    <circle cx="32" cy="32" r="29" class="inv-spool-rim" />
    <circle cx="32" cy="32" r="25" [style.fill]="i.facts.colour_hex" class="inv-spool-fil" />
    <circle cx="32" cy="32" r="25" class="inv-spool-lines" />
    <circle cx="32" cy="32" r="10" class="inv-spool-hub" />
    <circle cx="32" cy="32" r="4" class="inv-spool-hole" />
  </svg>
</ng-template>
<datalist id="inv-units">@for (u of units(); track u) { <option [value]="u"></option> }</datalist>
<datalist id="inv-locs">@for (l of locations(); track l) { <option [value]="l"></option> }</datalist>
<datalist id="inv-cats">@for (c of categories(); track c) { <option [value]="c"></option> }</datalist>
<datalist id="inv-curs">@for (c of currencies; track c) { <option [value]="c"></option> }</datalist>`,
})
export class RoomInventory implements OnDestroy {
  private api = inject(InventoryApi);
  private sel = inject(Selection);
  private auth = inject(Auth);
  private search = viewChild<ElementRef<HTMLInputElement>>('search');
  private addName = viewChild<ElementRef<HTMLInputElement>>('addName');
  private pasteBox = viewChild<ElementRef<HTMLTextAreaElement>>('pasteBox');
  private reasonBox = viewChild<ElementRef<HTMLInputElement>>('reasonBox');
  private stepBox = viewChild<ElementRef<HTMLInputElement>>('stepBox');

  can = computed(() => this.auth.can('draw'));
  readonly currencies = CURRENCIES;
  readonly I = I;
  readonly chartFmt = chartFmt;
  readonly columns: { key: SortKey; label: string; r?: boolean }[] = [
    { key: 'name', label: 'Name' }, { key: 'type', label: 'Type' }, { key: 'quantity', label: 'Quantity', r: true },
    { key: 'location', label: 'Location' }, { key: 'category', label: 'Category' }, { key: 'mpn', label: 'Part number' },
    { key: 'min_stock', label: 'Min', r: true }, { key: 'price', label: 'Unit price', r: true }, { key: 'value', label: 'Value', r: true },
    { key: 'updated_at', label: 'Changed', r: true },
  ];

  /** Where the page is, from the address and kept in it (?iq= and ?icat= are older links' words). */
  private url = new URLSearchParams(location.search);
  iid = signal<string | null>(this.url.get('item'));
  q = signal(this.url.get('q') ?? this.url.get('iq') ?? '');
  fType = signal(TYPE.has(this.url.get('type') ?? '') ? this.url.get('type')! : '');
  fLoc = signal(this.url.get('iloc') ?? '');
  fLow = signal(this.url.get('low') === '1');
  layout = signal<'grid' | 'table'>(this.url.get('view') === 'table' ? 'table' : 'grid');
  pasting = signal(this.url.get('paste') === '1');
  adding = signal(this.url.get('paste') === '1' || this.url.get('add') === '1');
  sortKey = signal<SortKey>((['name', 'quantity', 'value', 'updated_at'].includes(this.url.get('isort') ?? '') ? this.url.get('isort') : 'name') as SortKey);
  sortDir = signal<'asc' | 'desc'>(this.url.get('isort') === 'quantity' || this.url.get('isort') === 'value' || this.url.get('isort') === 'updated_at' ? 'desc' : 'asc');

  all = signal<Item[]>([]);
  loaded = signal(false);
  item = signal<Item | null>(null);
  itemError = signal<string | null>(null);
  editing = signal(false);
  busy = signal(false);
  addError = signal<string | null>(null);
  step = signal('1');
  reason = signal('');
  pasted = signal('');
  pasteReason = signal('');
  picked = signal<Set<string>>(new Set());
  makers = signal<Maker[]>([]);
  linkMaker = signal('');
  linkProducts = signal<{ id: string; name: string; sku: string; url: string }[]>([]);
  broken = signal<Set<string>>(new Set());
  shot = signal<string | null>(null);
  /** The add row's fields. */
  form = signal({ name: '', quantity: '', unit: '', location: '', category: '', mpn: '', lcsc: '', min: '', type: '' });
  setF(k: FormKey, v: string) { this.form.update(f => ({ ...f, [k]: v })); }
  private poll = setInterval(() => { if (!document.hidden) this.read(); }, 15_000);

  constructor() {
    this.read();
    if (this.iid()) this.openItem(this.iid()!);
    // The address follows the page, so F5 comes back here.
    effect(() => {
      const i = this.iid(), q = this.q(), ty = this.fType(), l = this.fLoc(), low = this.fLow(), p = this.pasting() && this.adding();
      const s = this.sortKey(), v = this.layout();
      const url = new URL(location.href);
      const set = (k: string, val: string | null) => val ? url.searchParams.set(k, val) : url.searchParams.delete(k);
      set('item', i); set('q', q); set('type', ty); set('iloc', l); set('low', low ? '1' : null); set('paste', p ? '1' : null);
      set('isort', s !== 'name' && ['quantity', 'value', 'updated_at'].includes(s) ? s : null); set('view', v === 'table' ? 'table' : null);
      for (const old of ['iq', 'icat', 'add']) url.searchParams.delete(old);
      if (url.href !== location.href) history.replaceState(null, '', url);
    });
    // Asked from the command palette or a card in the Chat: the add row, the paste box, or an item.
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

  // ---- the list, its filters and its sections

  /** Matching the words, the place and "low" - not the type, so each type can say how many it would show. */
  baseShown = computed(() => {
    const w = fold(this.q()).split(/\s+/).filter(Boolean), l = this.fLoc(), low = this.fLow();
    return this.all().filter(i => {
      if (low && !i.low) return false;
      if (l && i.location !== l) return false;
      if (!w.length) return true;
      const f = i.facts || {};
      const h = fold([i.name, i.mpn, i.lcsc, i.manufacturer, i.category, i.location, i.board, i.notes, i.tags.join(' '),
        i.catalog?.manufacturer_name ?? '', i.catalog?.product_name ?? '', i.type, t(TYPE.get(i.type)?.label ?? ''),
        i.subtype, t(SUBTYPE.get(i.subtype) ?? ''), f.size ?? '', f.value ?? '', f.package ?? '', f.material ?? '', f.colour ?? '',
        f.colour ? t(COLOURS[f.colour] ?? '') : '', f.standard ?? '', f.head ?? ''].join(' '));
      return w.every(x => h.includes(x));
    });
  });
  shown = computed(() => { const ty = this.fType(); return ty ? this.baseShown().filter(i => i.type === ty) : this.baseShown(); });
  filtering = computed(() => !!(this.q().trim() || this.fType() || this.fLoc() || this.fLow()));
  categories = computed(() => [...new Set(this.all().map(i => i.category).filter(Boolean))].sort((a, b) => a.localeCompare(b)));
  locations = computed(() => [...new Set(this.all().map(i => i.location).filter(Boolean))].sort((a, b) => a.localeCompare(b)));
  units = computed(() => [...new Set([...UNITS, ...this.all().map(i => i.unit)])]);
  allTypes = computed(() => TYPES.filter(x => this.all().some(i => i.type === x.id)));
  typesLine = computed(() => this.allTypes().map(x => t(x.label)).join(', '));
  clearFilters() { this.q.set(''); this.fType.set(''); this.fLoc.set(''); this.fLow.set(false); }

  typeCounts = computed(() => {
    const base = this.baseShown();
    return TYPES.map(x => {
      const items = base.filter(i => i.type === x.id);
      return { ...x, n: items.length, low: items.filter(i => i.low).length };
    }).filter(x => x.n || this.fType() === x.id);
  });
  placeCounts = computed(() => {
    const m = new Map<string, number>();
    for (const i of this.all()) if (i.location) m.set(i.location, (m.get(i.location) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, n]) => ({ name, n }));
  });
  typeOpts = computed<SelectOption[]>(() => [{ value: '', label: t('All types'), hint: this.baseShown().length },
    ...this.typeCounts().map(c => ({ value: c.id, label: t(c.label), hint: c.n }))]);
  placeOpts = computed<SelectOption[]>(() => [{ value: '', label: t('All places') },
    ...this.placeCounts().map(p => ({ value: p.name, label: p.name, hint: p.n }))]);
  sortOpts = computed<SelectOption[]>(() => [
    { value: 'name', label: t('Name, A to Z') }, { value: 'quantity', label: t('Most on hand') },
    { value: 'value', label: t('Highest value') }, { value: 'updated_at', label: t('Recently changed') }]);
  sortOpt = computed(() => {
    const k = this.sortKey(), d = this.sortDir();
    return (k === 'name' && d === 'asc') || (k !== 'name' && ['quantity', 'value', 'updated_at'].includes(k) && d === 'desc') ? k : '';
  });
  pickSort(k: string) { this.sortKey.set(k as SortKey); this.sortDir.set(k === 'name' ? 'asc' : 'desc'); }
  /** The types a person can set: "worked out" first. */
  typeSetOpts(it?: Item): SelectOption[] {
    const auto = it?.type_auto ? ` (${t(TYPE.get(it.type)?.label ?? '')})` : '';
    return [{ value: '', label: t('Worked out') + auto }, ...TYPES.map(x => ({ value: x.id, label: t(x.label) }))];
  }
  subOpts = computed<SelectOption[]>(() => [{ value: '', label: t('Worked out') }, ...SUBTYPES.map(x => ({ value: x.id, label: t(x.label) }))]);
  makerOpts = computed<SelectOption[]>(() => this.makers().map(m => ({ value: m.id, label: m.name, hint: m.product_count })));

  stats = computed(() => {
    const rows = this.all();
    return {
      low: rows.filter(i => i.low).length, out: rows.filter(i => i.quantity <= 0).length,
      withMin: rows.filter(i => i.min_stock != null).length, priced: rows.filter(i => i.price != null).length,
      valueLine: this.valueLine(rows), valueTip: this.valueTip(rows),
    };
  });
  recent = computed(() => [...this.all()].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')));

  sorted = computed(() => {
    const k = this.sortKey(), d = this.sortDir() === 'asc' ? 1 : -1;
    const val = (i: Item): unknown => k === 'type' ? this.typeLine(i) : i[k];
    return [...this.shown()].sort((a, b) => {
      const x = val(a), y = val(b);
      if (x == null || x === '') return y == null || y === '' ? 0 : 1;           // the empty ones last, either way
      if (y == null || y === '') return -1;
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * d;
    });
  });
  /** One section per type, in the types' order. */
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
  clearPicked() { this.picked.set(new Set()); }
  pickAll(on: boolean) { this.picked.set(on ? new Set(this.shown().map(i => i.id)) : new Set()); }
  allPicked = computed(() => this.shown().length > 0 && this.shown().every(i => this.picked().has(i.id)));
  selectedItems = computed(() => this.all().filter(i => this.picked().has(i.id)));

  /** What a section's items add up to: a filament's weight, else each unit's total. */
  private qtyLine(items: Item[]): string {
    const grams = items.reduce((a, i) => a + (i.facts?.weight_g ?? 0), 0);
    const rest = items.filter(i => i.facts?.weight_g == null);
    const units = new Map<string, number>();
    for (const i of rest) units.set(i.unit, (units.get(i.unit) ?? 0) + i.quantity);
    const parts = [...units.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([u, n]) => `${qty(n)} ${u}`);
    return [grams ? this.weight(grams) : '', ...parts].filter(Boolean).join(' · ');
  }
  private valueLine(items: Item[]): string {
    const value = new Map<string, number>();
    for (const i of items) if (i.value != null) value.set(i.currency || '?', (value.get(i.currency || '?') ?? 0) + i.value);
    return [...value.entries()].map(([c, v]) => this.money(v, c)).join(' · ');
  }
  /** The stock's worth in the display currency, when some of it is priced in another: "≈ ₺12.345,00". */
  private valueTip(items: Item[]): string {
    const d = CURRENCY();
    let sum = 0, other = false;
    for (const i of items) {
      if (i.value == null) continue;
      const v = i.currency ? convert(i.value, i.currency, d) : null;
      if (v == null) return '';
      sum += v; other ||= i.currency !== d;
    }
    return other ? `≈ ${moneyIn(sum, d)}` : '';
  }

  // ---- what a card shows

  family(type: string): Family { return familyOf(type); }
  /** A section with no picture to show - not one picture, nor a spool to draw - gets lower cards. */
  flat(g: Group): boolean { return !g.items.some(i => this.pic(i) || i.facts?.colour_hex); }
  icon(type: string): string { return (TYPE.get(type) ?? TYPE.get('other')!).icon; }
  subLabel(s: string): string { return SUBTYPE.get(s) ?? s; }
  typeLine(i: Item): string {
    const ty = t(TYPE.get(i.type)?.label ?? i.type);
    return i.type === 'electronic' && i.subtype ? `${ty} · ${t(this.subLabel(i.subtype))}` : ty;
  }
  /** Its picture: its catalog product's, else the LCSC part's photo when it is on disk - never a broken one. */
  pic(i: Item): string | null {
    const b = this.broken();
    const own = (i.images ?? []).find(u => !b.has(u));
    if (own) return own;
    const photo = i.photo && i.lcsc ? `/api/parts/${i.lcsc}/photo.jpg` : null;
    return photo && !b.has(photo) ? photo : null;
  }
  broke(src: string) { if (!this.broken().has(src)) this.broken.update(s => new Set(s).add(src)); }
  gallery = computed(() => {
    const it = this.item(), b = this.broken();
    if (!it) return [];
    const urls = [...(it.images ?? [])];
    if (it.lcsc && (it.photo || it.photo_known)) urls.push(`/api/parts/${it.lcsc}/photo.jpg`);
    return urls.filter(u => !b.has(u)).slice(0, 12);
  });
  bigImg = computed(() => { const s = this.shot(), g = this.gallery(); return s && g.includes(s) ? s : g[0] ?? null; });
  lcscUrl(c: string) { return `https://www.lcsc.com/product-detail/${c}.html`; }
  colourName(c?: string) { return c ? t(COLOURS[c] ?? c) : ''; }
  filLine(i: Item): string {
    const f = i.facts;
    return [f.material, f.finish, f.diameter ? `${f.diameter} mm` : '', this.colourName(f.colour)].filter(Boolean).join(' · ')
      || i.category || t(TYPE.get(i.type)?.label ?? '');
  }
  fastLine(i: Item): string {
    const f = i.facts;
    return [f.head, f.drive, f.form, f.standard, f.material].filter(Boolean).map(x => t(x!)).join(' · ');
  }
  /** 650 g, 2 kg, 1.25 kg. */
  weight(g: number): string { return g >= 1000 ? `${qty(Math.round(g / 10) / 100)} kg` : `${qty(Math.round(g))} g`; }
  round(v: number) { return Math.round(v); }
  /** How the weight sits on spools: "2 spools of 1 kg", "65% of a 1 kg spool", "1 full + 25%". */
  spoolLine(i: Item): string {
    const f = i.facts, size = this.weight(f.spool_g ?? 1000), full = f.full_spools ?? 0, pct = Math.round(f.current_pct ?? 0);
    if ((f.weight_g ?? 0) <= 0) return this.fmt('empty {s} spool', { s: size });
    if (pct >= 100) return this.fmt(full + 1 === 1 ? '1 spool of {s}' : '{n} spools of {s}', { n: full + 1, s: size });
    if (!full) return this.fmt('{p}% of a {s} spool', { p: pct, s: size });
    return this.fmt('{n} full + {p}% of {s}', { n: full, p: pct, s: size });
  }
  /** The properties table of one item: its type's facts, by name. */
  factRows(it: Item): [string, string][] {
    const f = it.facts, rows: [string, string | number | undefined][] = [
      ['Material', f.material], ['Finish', f.finish], ['Diameter', f.diameter ? `${f.diameter} mm` : undefined],
      ['Colour', f.colour ? this.colourName(f.colour) : undefined], ['Spool', f.spool_g && f.spool_stated ? this.weight(f.spool_g) : undefined],
      ['Volume', f.volume_ml ? `${qty(f.volume_ml)} ml` : undefined],
      ['Size', f.size], ['Head', f.head ? t(f.head) : undefined], ['Drive', f.drive ? t(f.drive) : undefined],
      ['Form', f.form ? t(f.form) : undefined], ['Standard', f.standard],
      ['Value', f.value], ['Package', f.package], ['Maker part', f.mpn], ['LCSC category', f.lcsc_category],
      ['Gauge', f.gauge], ['Section', f.section], ['Length', typeof f.length === 'string' ? f.length : undefined],
    ];
    if (familyOf(it.type) === 'fastener' && f.material) rows.splice(0, 1, ['Material', t(f.material)]);
    return rows.filter((r): r is [string, string] => r[1] != null && r[1] !== '').map(r => [r[0], String(r[1])]);
  }

  /** How much was on hand over time, from the log: the level after the last change in each bucket. */
  moves = computed<TimeData | null>(() => {
    const log = [...(this.item()?.log ?? [])].reverse().filter(l => l.after != null);
    if (!log.length) return null;
    const now = Date.now() / 1000, first = Date.parse(log[0].at) / 1000;
    const span = Math.max(now - first, 3600);
    let step = span <= 2 * 86400 ? 3600 : 86400;
    if (span / step > 120) step = Math.ceil(span / 120 / 86400) * 86400;
    const t0 = Math.floor(first / step) * step, n = Math.max(2, Math.floor((now - t0) / step) + 1);
    const values: number[] = [];
    let k = 0, level = 0;
    for (let b = 0; b < n; b++) {
      const end = t0 + (b + 1) * step;
      while (k < log.length && Date.parse(log[k].at) / 1000 < end) level = log[k++].after!;
      values.push(level);
    }
    return { t0, step, n, series: [{ name: t('On hand'), values }] };
  });

  // ---- going places

  openItem(id: string, then: 'adjust' | 'edit' | null = null) {
    this.iid.set(id);
    this.itemError.set(null);
    this.shot.set(null);
    this.editing.set(then === 'edit');
    if (this.item()?.id !== id) this.item.set(this.all().find(i => i.id === id) ?? null);
    this.linkMaker.set('');
    this.api.get(id).subscribe({
      next: x => {
        if (this.iid() !== id) return;
        this.item.set(x);
        if (then === 'adjust') setTimeout(() => { const s = this.stepBox()?.nativeElement; s?.focus(); s?.select(); }, 30);
      },
      error: (e: HttpErrorResponse) => { if (this.iid() === id) { this.item.set(null); this.itemError.set(why(e, 'Could not open it.')); } },
    });
    if (this.can() && !this.makers().length) this.api.makers().subscribe({ next: m => this.makers.set(m), error: () => {} });
  }
  closeItem() { this.iid.set(null); this.item.set(null); this.itemError.set(null); this.editing.set(false); }
  goAdd() { this.closeItem(); this.adding.set(true); this.pasting.set(false); setTimeout(() => this.addName()?.nativeElement.focus(), 50); }
  goPaste() { this.closeItem(); this.adding.set(true); this.pasting.set(true); setTimeout(() => this.pasteBox()?.nativeElement.focus(), 50); }
  /** The product in the Product Catalog: its manufacturer open, searched for its name (?ws=catalog&m=&q=). */
  toCatalog(c: CatalogLink) {
    this.leaveAddress();
    this.left = true;
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
  /** An item's right-click menu, on the cards and the table's rows. */
  openMenu(e: MouseEvent, i: Item) {
    const can = this.can(), url = i.catalog?.url;
    ContextMenu.open(e, [
      { label: 'Open', icon: 'right', kbd: 'Enter', run: () => this.openItem(i.id) },
      !!url && { label: 'Open its page', icon: 'open', kbd: '↗', run: () => window.open(url!, '_blank', 'noopener,noreferrer') },
      can && { label: 'Adjust the quantity', icon: 'list', run: () => this.openItem(i.id, 'adjust') },
      can && { label: 'Edit', icon: 'edit', run: () => this.openItem(i.id, 'edit') },
      { sep: true },
      can && { label: 'Delete', icon: 'trash', kbd: 'Del', danger: true, run: () => this.remove(i) },
    ]);
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
                      mpn: f.mpn.trim(), lcsc: f.lcsc.trim(), min_stock: min, type: f.type }).subscribe({
      next: r => {
        this.busy.set(false);
        this.form.set({ name: '', quantity: '', unit: '', location: f.location, category: f.category, mpn: '', lcsc: '', min: '', type: f.type });
        this.say(r.merged ? this.fmt('Topped up {name}: now {q}', { name: r.item.name, q: `${qty(r.item.quantity)} ${r.item.unit}` })
                          : this.fmt('Added {name} to {type}', { name: r.item.name, type: t(TYPE.get(r.item.type)?.label ?? '') }));
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
      error: (e: HttpErrorResponse) => { this.busy.set(false); this.say(why(e, 'Could not add them.'), 'danger'); },
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
  setType(it: Item, v: string) {
    this.patch(it, v === 'electronic' || !v ? { type: v } : { type: v, subtype: '' });
  }
  patch(it: Item, p: Record<string, unknown>) {
    this.api.patch(it.id, p).subscribe({
      next: x => { this.item.set(x); this.replace(x); },
      error: (e: HttpErrorResponse) => { this.say(why(e, 'Could not save it.'), 'danger'); this.item.set({ ...it }); },
    });
  }
  adjust(it: Item, sign: 1 | -1) {
    const n = num(this.step());
    if (n == null || n <= 0) { this.say(t('Say how many, more than zero.')); return; }
    this.busy.set(true);
    this.api.adjust(it.id, sign * n, this.reason().trim()).subscribe({
      next: x => { this.busy.set(false); this.item.set(x); this.replace(x); this.reason.set(''); this.reasonBox()?.nativeElement.blur(); },
      error: (e: HttpErrorResponse) => { this.busy.set(false); this.say(why(e, 'Could not change it.'), 'danger'); },
    });
  }
  private replace(x: Item) {
    const { log: _, ...light } = x;
    this.all.update(l => l.map(i => i.id === x.id ? light : i));
  }
  async remove(it: Item) {
    if (!await sure(t('Delete this item and its log?'), it.name)) return;
    this.api.remove(it.id).subscribe({
      next: () => { this.all.update(l => l.filter(i => i.id !== it.id)); if (this.iid() === it.id) this.closeItem(); this.say(this.fmt('Deleted {name}', { name: it.name })); },
      error: (e: HttpErrorResponse) => this.say(why(e, 'Could not delete it.'), 'danger'),
    });
  }
  async removeSelected() {
    const items = this.selectedItems();
    if (!items.length || !await sure(this.fmt('Delete {n} items and their logs?', { n: items.length }), items.map(i => i.name).slice(0, 12).join(', '))) return;
    this.api.removeMany(items.map(i => i.id)).subscribe({
      next: r => { this.picked.set(new Set()); this.all.update(l => l.filter(i => !r.deleted.includes(i.id))); this.say(this.fmt('Deleted {n} items', { n: r.deleted.length })); },
      error: (e: HttpErrorResponse) => this.say(why(e, 'Could not delete them.'), 'danger'),
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
      error: (e: HttpErrorResponse) => this.say(why(e, 'Could not export it.'), 'danger'),
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
        error: (e: HttpErrorResponse) => this.say(why(e, 'Could not import it.'), 'danger'),
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
  /** A stock item's price or worth, in its own currency (money.ts). */
  money(v: number, cur: string) { return moneyIn(v, cur); }
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
  /** A date in full: 12 Oct 2026 14:05 · 2 h ago. */
  stamp(iso: string | null | undefined): string {
    if (!iso) return '–';
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) return iso;
    const loc = LANG() === 'tr' ? 'tr-TR' : 'en-GB';
    return new Date(ms).toLocaleString(loc, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' · ' + this.ago(iso);
  }
  qty = qty;
  when = when;
  t = t;
  fmt(text: string, vars: Record<string, string | number>) {
    return t(text).replace(/\{(\w+)\}/g, (m, k) => k in vars ? String(vars[k]) : m);
  }
  /** A word in passing: the app's toast (toast.ts). */
  private say(msg: string, tone: ToastTone = 'info') { Toast.show(msg, { tone }); }

  key(e: KeyboardEvent) {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName);
    if (e.key === 'Escape') {
      if (this.iid() && !document.querySelector('.wb-sel-pop')) { this.closeItem(); return; }
    }
    if (e.key === '/' && !typing && !this.iid()) { e.preventDefault(); this.search()?.nativeElement.focus(); }
  }

  /** The address words that are this tab's, taken off when it is left - the Product Catalog reads ?q= and ?view= too. */
  private leaveAddress() {
    const url = new URL(location.href);
    for (const k of ['item', 'q', 'type', 'iloc', 'low', 'isort', 'view', 'paste']) url.searchParams.delete(k);
    history.replaceState(null, '', url);
  }

  private left = false;

  ngOnDestroy() {
    clearInterval(this.poll);
    // Left for another tab: this one's words go with it (the catalog's own, set on the way out, stay).
    if (!this.left) this.leaveAddress();
  }
}
