import { Component, ElementRef, ViewEncapsulation, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { T, t } from '../i18n';
import { Toast } from '../toast';

/** A product as a bulk edit names it. */
export interface BulkProduct { manufacturer: string; product: string }
interface BulkAnswer { changed: unknown[]; unchanged: number; skipped: { why: string }[]; undo: string | null }
interface UndoAnswer { restored: unknown[]; conflict: { why: string }[] }

type Vat = '' | 'incl' | 'excl' | 'none';

function fmt(text: string, vars: Record<string, string | number>) {
  return t(text).replace(/\{(\w+)\}/g, (m, k) => k in vars ? String(vars[k]) : m);
}

/** The selection bar's Edit: the selected products - one category, the
 *  currency and VAT of their price - or stock lines - one place, one
 *  minimum - changed alike in one call (backend/manufacturers.py and
 *  backend/inventory.py `bulk_edit`), with an Undo in the toast that puts
 *  back what is still as the edit left it (backend/bulk_undo.py).
 *
 *    <wb-selbar [count]="n">
 *      <wb-bulk-edit mode="products" [products]="sel()" [categories]="cats()" (done)="reload()" />
 *      ...
 *    </wb-selbar>
 *
 *  Closed, it is one "Edit…" button. Open, its fields take the bar's line
 *  and the bar's other buttons step aside (the rule below), so the bar stays
 *  one row; Escape or Cancel closes it. A field left empty stays as it is. */
@Component({
  selector: 'wb-bulk-edit',
  imports: [T],
  encapsulation: ViewEncapsulation.None,
  host: { class: 'wb-bulk', '[attr.data-open]': 'open() ? 1 : null', '(keydown.escape)': 'close()' },
  template: `
@if (!open()) {
  <button type="button" class="tcv-btn" (click)="start()"
          [title]="(mode() === 'stock' ? 'Give the selected lines one place or minimum' : 'Give the selected products one category, currency or VAT') | t">{{ 'Edit…' | t }}</button>
} @else {
  @if (mode() === 'products') {
    <input #first class="wb-bulk-in wb-bulk-wide" list="wb-bulk-cats" [placeholder]="'Category' | t" [value]="cat()"
           (input)="cat.set(val($event))" (keydown.enter)="apply()" [attr.aria-label]="'Category' | t" [title]="'Empty fields stay as they are' | t">
    <datalist id="wb-bulk-cats">@for (c of categories(); track c) { <option [value]="c"></option> }</datalist>
    <input class="wb-bulk-in wb-bulk-cur" list="wb-bulk-curs" [placeholder]="'Currency' | t" [value]="cur()"
           (input)="cur.set(val($event).toUpperCase())" (keydown.enter)="apply()" [attr.aria-label]="'Currency' | t" [title]="'Only products with a price' | t">
    <datalist id="wb-bulk-curs">@for (c of currencies; track c) { <option [value]="c"></option> }</datalist>
    <span class="wb-bulk-seg" role="radiogroup" [attr.aria-label]="'VAT' | t" [title]="'Only products with a price' | t">
      <span class="wb-bulk-lab">{{ 'VAT' | t }}</span>
      @for (v of vats; track v.v) {
        <button type="button" role="radio" [attr.data-on]="vat() === v.v ? 1 : null" [attr.aria-checked]="vat() === v.v" (click)="vat.set(v.v)">{{ v.l | t }}</button>
      }
    </span>
  } @else {
    <input #first class="wb-bulk-in wb-bulk-wide" list="wb-bulk-places" [placeholder]="'Location' | t" [value]="loc()"
           (input)="loc.set(val($event))" (keydown.enter)="apply()" [attr.aria-label]="'Location' | t" [title]="'Empty fields stay as they are' | t">
    <datalist id="wb-bulk-places">@for (p of places(); track p) { <option [value]="p"></option> }</datalist>
    <input class="wb-bulk-in wb-bulk-min" inputmode="decimal" [placeholder]="'Min' | t" [value]="min()"
           (input)="min.set(val($event))" (keydown.enter)="apply()" [attr.aria-label]="'Minimum' | t">
  }
  <button type="button" class="tcv-btn tcv-btn-accent" (click)="apply()" [disabled]="busy() || !ready()">{{ 'Apply' | t }}</button>
  <button type="button" class="tcv-btn" (click)="close()">{{ 'Cancel' | t }}</button>
}`,
  styles: [`
.wb-bulk { display: contents; }
/* open: the bar's other buttons step aside, Clear stays */
.wb-selbar-bar:has(> .wb-bulk[data-open]) > .tcv-btn:not(.wb-selbar-clear) { display: none; }
.wb-bulk-in { box-sizing: border-box; height: 24px; min-width: 0; padding: 2px 8px; font: inherit; font-size: 12px; color: var(--ink);
  background: var(--surface-2); border: 1px solid var(--line); border-radius: 5px; outline: none; }
.wb-bulk-in:focus { border-color: var(--accent); }
.wb-bulk-wide { width: 200px; }
.wb-bulk-cur { width: 84px; }
.wb-bulk-min { width: 64px; }
.wb-bulk-seg { display: inline-flex; align-items: center; height: 24px; border: 1px solid var(--line); border-radius: 5px; overflow: hidden; }
.wb-bulk-lab { padding: 0 8px; color: var(--ink-dim); border-right: 1px solid var(--line); }
.wb-bulk-seg button { height: 100%; padding: 0 8px; font: inherit; font-size: 12px; color: var(--ink-dim); background: none; border: 0; cursor: pointer; }
.wb-bulk-seg button + button { border-left: 1px solid var(--line); }
.wb-bulk-seg button:hover { color: var(--ink); }
.wb-bulk-seg button[data-on] { color: var(--ink-bright); font-weight: 600; }
`],
})
export class BulkEdit {
  private http = inject(HttpClient);
  private first = viewChild<ElementRef<HTMLInputElement>>('first');
  /** What is edited: catalog products or stock lines. */
  mode = input<'products' | 'stock'>('products');
  /** The selected products (mode products). */
  products = input<BulkProduct[]>([]);
  /** The selected stock lines' ids (mode stock). */
  ids = input<string[]>([]);
  /** Suggestions: the categories there are, the places lines lie. */
  categories = input<string[]>([]);
  places = input<string[]>([]);
  /** Something was changed or put back: the list reads again. */
  done = output<void>();

  readonly currencies = ['TRY', 'USD', 'EUR', 'GBP', 'CNY'];
  readonly vats: { v: Vat; l: string }[] = [{ v: '', l: 'as is' }, { v: 'incl', l: 'incl.' }, { v: 'excl', l: 'excl.' }, { v: 'none', l: 'none' }];
  open = signal(false);
  busy = signal(false);
  cat = signal(''); cur = signal(''); vat = signal<Vat>('');
  loc = signal(''); min = signal('');
  ready = computed(() => this.mode() === 'stock'
    ? !!(this.loc().trim() || this.min().trim())
    : !!(this.cat().trim() || this.cur().trim() || this.vat()));

  val(e: Event) { return (e.target as HTMLInputElement).value; }
  start() {
    this.cat.set(''); this.cur.set(''); this.vat.set(''); this.loc.set(''); this.min.set('');
    this.open.set(true);
    setTimeout(() => this.first()?.nativeElement.focus());
  }
  close() { this.open.set(false); }

  private base() { return this.mode() === 'stock' ? '/api/inventory' : '/api/manufacturers/products'; }

  apply() {
    if (this.busy() || !this.ready()) return;
    const set: Record<string, string> = {};
    if (this.mode() === 'stock') {
      if (this.loc().trim()) set['location'] = this.loc().trim();
      if (this.min().trim()) set['min_stock'] = this.min().trim();
    } else {
      if (this.cat().trim()) set['category'] = this.cat().trim();
      if (this.cur().trim()) set['currency'] = this.cur().trim();
      if (this.vat()) set['vat'] = this.vat() === 'none' ? '' : this.vat();
    }
    const body = this.mode() === 'stock' ? { ids: this.ids(), set } : { items: this.products(), set };
    this.busy.set(true);
    this.http.post<BulkAnswer>(`${this.base()}/bulk-edit`, body).subscribe({
      next: r => {
        this.busy.set(false);
        this.open.set(false);
        const n = r.changed.length, skip = r.skipped.length;
        const text = (n ? fmt('{n} changed', { n }) : t('Nothing to change'))
          + (skip ? ' · ' + fmt('{n} skipped', { n: skip }) : '');
        const uid = r.undo;
        Toast.show(text, uid ? { action: { label: t('Undo'), run: () => this.undo(uid) } } : { tone: skip && !n ? 'warn' : 'info' });
        if (n) this.done.emit();
      },
      error: (e: HttpErrorResponse) => { this.busy.set(false); Toast.show(this.why(e) || t('Could not save it.'), { tone: 'danger' }); },
    });
  }

  private undo(uid: string) {
    this.http.post<UndoAnswer>(`${this.base()}/bulk-undo`, { undo: uid }).subscribe({
      next: r => {
        const n = r.restored.length, c = r.conflict.length;
        Toast.show(fmt('{n} put back', { n }) + (c ? ' · ' + fmt('{n} changed since - left as they are', { n: c }) : ''),
                   { tone: c ? 'warn' : 'info' });
        this.done.emit();
      },
      error: (e: HttpErrorResponse) => Toast.show(this.why(e) || t('Could not undo it.'), { tone: 'danger' }),
    });
  }

  private why(e: HttpErrorResponse): string { const d = e?.error?.detail; return typeof d === 'string' ? d : ''; }
}
