import { Component, Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { Auth } from '../auth';
import { Confirm } from '../confirm';
import { LANG, T, t } from '../i18n';
import { Toast } from '../toast';
import { EmptyState } from '../empty-state';
import { Skeleton } from '../skeleton';

/** Parts' Deleted (backend/parts_trash.py): a product deleted - by hand,
 *  by the Chat, by an agent, with its maker - is kept here with its stock
 *  lines and its files for `days` days, as one, and restored as one.
 *
 *  - `PartsTrash`: how many there are (the Parts page's "Deleted" tab), and
 *    the line a delete's question says - what goes with it;
 *  - `<wb-parts-trash>`: the list - what, from which maker, what went with
 *    it, who deleted it and when, days left, Restore and Delete for good. */

export interface TrashUnit {
  id: string; kind: 'product' | 'maker'; mid: string; source: string; name: string; maker_name: string;
  how: 'hand' | 'chat' | 'agent' | 'migrated'; note: string; products: number;
  product: { id: string; name: string; sku?: string } | null;
  stock: { id: string; name: string; quantity: number; unit: string; location: string; log: number }[];
  files: { file: string; name: string; role?: string }[]; nfiles: number;
  deleted_at: string; deleted_by: { id?: string; name?: string; type?: string };
  purge_at: string; days_left: number | null; may: boolean;
}
interface GoesWith { products: number; stock: number; files: number; days: number; lines: string[] }

function fmt(text: string, vars: Record<string, string | number>) {
  return t(text).replace(/\{(\w+)\}/g, (m, k) => k in vars ? String(vars[k]) : m);
}
function why(e: unknown, fallback: string): string {
  const d = (e as HttpErrorResponse)?.error?.detail;
  return typeof d === 'string' ? d : t(fallback);
}
function count(n: number, one: string, many: string) { return fmt(n === 1 ? one : many, { n }); }
/** "a, b and c" in the page's language. */
function and(bits: string[]) {
  return bits.length < 2 ? bits.join('') : bits.slice(0, -1).join(', ') + ' ' + t('and') + ' ' + bits[bits.length - 1];
}

@Injectable({ providedIn: 'root' })
export class PartsTrash {
  private http = inject(HttpClient);
  units = signal<TrashUnit[] | null>(null);
  days = signal(30);
  err = signal('');

  load() {
    this.http.get<{ days: number; units: TrashUnit[] }>('/api/manufacturers/trash').subscribe({
      next: r => { this.units.set(r.units); this.days.set(r.days); this.err.set(''); },
      error: e => this.err.set(why(e, 'Could not read Parts\' Deleted.')),
    });
  }

  /** What a delete takes with it, for its question: "2 stock lines and 3 files
   *  go with it to Parts' Deleted for 30 days." `pids` null: the whole maker. */
  async goesWith(mid: string, pids: string[] | null): Promise<string> {
    const q = `maker=${encodeURIComponent(mid)}` + (pids ? `&products=${pids.map(encodeURIComponent).join(',')}` : '');
    let r: GoesWith;
    try { r = await firstValueFrom(this.http.get<GoesWith>(`/api/manufacturers/trash/goes-with?${q}`)); }
    catch { return fmt('It goes to Parts\' Deleted, where it can be restored for {d} days.', { d: this.days() }); }
    const bits = [
      ...(pids ? [] : [count(r.products, '{n} product', '{n} products')]),
      ...(r.stock ? [count(r.stock, '{n} stock line', '{n} stock lines')] : []),
      ...(r.files ? [count(r.files, '{n} file', '{n} files')] : []),
    ];
    const first = !bits.length
      ? fmt(pids && pids.length > 1 ? 'They go to Parts\' Deleted for {d} days, where they can be restored.' : 'It goes to Parts\' Deleted for {d} days, where it can be restored.', { d: r.days })
      : fmt('{what} go to Parts\' Deleted with it for {d} days, and come back with it when it is restored.', { what: and(bits), d: r.days });
    const lines = r.lines.length ? '\n' + t('On hand:') + ' ' + r.lines.slice(0, 3).join(', ') + (r.lines.length > 3 ? ' …' : '') : '';
    return first + lines;
  }
}

@Component({
  selector: 'wb-parts-trash',
  imports: [T, EmptyState, Skeleton],
  styleUrls: ['../settings.css', './manufacturers.css', './parts-trash.css'],
  template: `
@if (trash.units(); as l) {
  <div class="ptr-bar">
    <span class="st-sub">{{ fmt('{n} deleted', { n: l.length }) }} · {{ fmt('kept {d} days with their stock and files, then deleted for good', { d: trash.days() }) }}</span>
    <span class="ptr-gap"></span>
    @if (can() && mine(l).length) {
      <button type="button" class="tcv-btn" (click)="restore(mine(l))" [disabled]="busy()">{{ 'Restore all' | t }}</button>
      <button type="button" class="tcv-btn ptr-danger" (click)="purge(mine(l))" [disabled]="busy()">{{ 'Empty Deleted' | t }}</button>
    }
    <button type="button" class="tcv-btn" (click)="trash.load()" [title]="'read it again' | t" [attr.aria-label]="'read it again' | t">↻</button>
  </div>
  @if (l.length) {
    <div class="st-table-wrap">
      <table class="st-table ptr">
        <thead><tr><th>{{ 'Deleted item' | t }}</th><th>{{ 'Went with it' | t }}</th><th>{{ 'Deleted by' | t }}</th>
          <th class="r">{{ 'When' | t }}</th><th class="r">{{ 'Days left' | t }}</th><th></th></tr></thead>
        <tbody>
          @for (u of l; track u.id) {
            <tr>
              <td class="give">
                <span class="ptr-name"><b [title]="u.name">{{ u.name }}</b>
                  <span class="st-tag" [attr.data-tone]="u.kind === 'maker' ? 'accent' : null">{{ (u.kind === 'maker' ? 'Maker' : 'Product') | t }}</span></span>
                <span class="ptr-sub" [title]="u.note">{{ sub(u) }}</span>
              </td>
              <td class="ptr-with">
                @if (u.stock.length) {
                  <span [title]="stockTip(u)">{{ count(u.stock.length, '{n} stock line', '{n} stock lines') }}: {{ stockTip(u) }}</span>
                }
                @if (u.nfiles) { <span class="dim" [title]="filesTip(u)">{{ count(u.nfiles, '{n} file', '{n} files') }}: {{ filesTip(u) }}</span> }
                @if (!u.stock.length && !u.nfiles) { <span class="ptr-none">{{ 'Nothing else' | t }}</span> }
              </td>
              <td>{{ u.deleted_by.name || ('someone' | t) }}<span class="ptr-sub">{{ how(u) | t }}</span></td>
              <td class="r mono" [title]="long(u.deleted_at)">{{ when(u.deleted_at) }}</td>
              <td class="r mono" [attr.data-soon]="(u.days_left ?? 99) <= 3 ? 1 : null">{{ u.days_left ?? '–' }}</td>
              <td class="r ptr-acts">
                @if (can() && u.may) {
                  <button type="button" class="tcv-btn" (click)="restore([u])" [disabled]="busy()">{{ 'Restore' | t }}</button>
                  <button type="button" class="tcv-btn ptr-for-good" (click)="purge([u])" [disabled]="busy()">{{ 'Delete for good' | t }}</button>
                }
              </td>
            </tr>
          }
        </tbody>
      </table>
    </div>
  } @else {
    <wb-empty icon="table" [text]="fmt('Nothing deleted. A product deleted from Parts comes here with its stock lines and files, and can be restored for {d} days.', { d: trash.days() })" />
  }
} @else if (trash.err()) { <p class="st-err">{{ trash.err() }}</p> } @else { <wb-skel kind="rows" [count]="6" [h]="44" /> }`,
})
export class PartsTrashView {
  trash = inject(PartsTrash);
  private http = inject(HttpClient);
  private auth = inject(Auth);
  busy = signal(false);
  fmt = fmt;
  count = count;

  constructor() { this.trash.load(); }
  can() { return this.auth.can('draw'); }
  mine(l: TrashUnit[]) { return l.filter(u => u.may); }
  sub(u: TrashUnit) {
    const from = u.kind === 'maker' ? count(u.products, '{n} product', '{n} products')
      : [u.maker_name, u.product?.sku].filter(x => !!x).join(' · ');
    return u.note ? from + ' · ' + t(u.note) : from;
  }
  how(u: TrashUnit) {
    return { hand: 'on the Parts page', chat: 'by the Chat', agent: 'by an agent', migrated: 'moved here from before' }[u.how] ?? '';
  }
  stockTip(u: TrashUnit) {
    return u.stock.map(s => `${s.name} (${s.quantity} ${s.unit}${s.location ? ', ' + s.location : ''})`).join(', ');
  }
  filesTip(u: TrashUnit) { return u.files.map(f => f.name).join(', '); }
  when(iso: string) {
    return new Date(iso).toLocaleDateString(LANG() === 'tr' ? 'tr-TR' : [], { day: 'numeric', month: 'short', year: 'numeric' });
  }
  long(iso: string) { return new Date(iso).toLocaleString(LANG() === 'tr' ? 'tr-TR' : []); }

  async restore(us: TrashUnit[]) {
    this.busy.set(true);
    try {
      const r = await firstValueFrom(this.http.post<{ restored: { name: string; to: string[] }[]; refused: { name: string; why: string }[] }>(
        '/api/manufacturers/trash/restore', { ids: us.map(u => u.id) }));
      if (r.restored.length) {
        const moved = r.restored.filter(x => x.to.some(k => k.startsWith('own:')));
        Toast.show(fmt(r.restored.length === 1 ? '{p} is back, with its stock and files' : '{n} are back, with their stock and files',
                       { p: r.restored[0].name, n: r.restored.length })
                   + (moved.length ? ' - ' + t('its maker is gone, so it is in My Items now') : ''), { tone: 'ok' });
      }
      for (const x of r.refused) Toast.show(`${x.name}: ${x.why}`, { tone: 'warn' });
    } catch (e) { Toast.show(why(e, 'Could not restore it.'), { tone: 'danger' }); }
    this.busy.set(false);
    this.trash.load();
  }

  async purge(us: TrashUnit[]) {
    const one = us.length === 1;
    if (!await Confirm.ask({
      title: one ? fmt('Delete {p} for good?', { p: us[0].name }) : fmt('Delete {n} for good?', { n: us.length }),
      text: t('Its stock lines and their logs go for good. Files put in Files for it go to Files\' Deleted files, unless another product uses them; files of your own stay in Files.'),
      ok: t('Delete for good'), danger: true })) return;
    this.busy.set(true);
    try {
      await firstValueFrom(this.http.post('/api/manufacturers/trash/purge', { ids: us.map(u => u.id) }));
    } catch (e) { Toast.show(why(e, 'Could not delete it.'), { tone: 'danger' }); }
    this.busy.set(false);
    this.trash.load();
  }
}
