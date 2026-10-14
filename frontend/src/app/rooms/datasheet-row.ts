import { HttpClient } from '@angular/common/http';
import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { LANG, T, t } from '../i18n';
import { FileModal } from './file-modal';

/** A Parts product's datasheet in the datasheet library (backend/datasheets.py),
 *  as one row of the product box: in it or not, its pages and when it was
 *  fetched, Open (the PDF, in a tab of its own) and Fetch. An LCSC part's
 *  datasheet comes from LCSC; any other product's is the PDF attached to it.
 *  What is in the library the Chat searches by question, with page numbers. */
export interface DsEntry {
  id: string; key: string; label: string; pages: number | null; indexed: number | null; bytes: number | null;
  lang: string | null; scanned: number; fetched_at: string | null; source: { kind: string; url: string };
}
interface DsState { entry: DsEntry | null; source: string | null }

/** The library's PDF of a datasheet, at a page. */
export function datasheetUrl(id: string, page?: number) {
  return `/api/datasheets/${encodeURIComponent(id)}/pdf${page ? '#page=' + page : ''}`;
}

@Component({
  selector: 'wb-ds-row',
  imports: [T],
  styles: [`
    :host { display: block; min-width: 0; }
    .dsr { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 14px; min-width: 0; padding: 6px 0;
      font-size: 12.5px; color: var(--ink); }
    .dsr-k { flex: none; font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; }
    .dsr-v { font-weight: 600; }
    .dsr-dim, .dsr-m { color: var(--ink-dim); font-weight: 400; }
    .dsr-m.mono { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 11.5px; }
    .dsr-acts { display: inline-flex; gap: 2px; margin-left: auto; }
    .dsr-btn { height: 24px; padding: 0 9px; border: 0; border-radius: 4px; background: none; font: inherit; font-size: 12px;
      color: var(--ink-dim); cursor: pointer; }
    .dsr-btn:hover:not(:disabled), .dsr-btn:focus-visible { background: var(--hover); color: var(--ink); outline: none; }
    .dsr-btn:disabled { cursor: default; opacity: .6; }
    .dsr-err { flex-basis: 100%; color: var(--danger); font-size: 12px; }
  `],
  template: `
<div class="dsr">
  <span class="dsr-k">{{ 'Datasheet' | t }}</span>
  @if (state(); as s) {
    @if (s.entry; as e) {
      <span class="dsr-v" [title]="'The Chat finds answers in it by question, with page numbers' | t">{{ 'In the library' | t }}</span>
      @if (e.pages) { <span class="dsr-m mono">{{ fmt('{n} pages', { n: e.pages }) }}</span> }
      @if (e.fetched_at) { <span class="dsr-m" [title]="e.fetched_at">{{ fmt('fetched {d}', { d: day(e.fetched_at) }) }}</span> }
      @if (e.lang === 'zh') { <span class="dsr-m">{{ 'in Chinese' | t }}</span> }
      @if (e.scanned) { <span class="dsr-m">{{ fmt('{n} scanned pages', { n: e.scanned }) }}</span> }
      <span class="dsr-acts">
        <a class="dsr-btn" [href]="url(e.id)" target="_blank" rel="noopener" role="button">{{ 'Open' | t }}</a>
        @if (canFetch()) {
          <button type="button" class="dsr-btn" (click)="fetch(true)" [disabled]="busy()"
                  [title]="'Read it again from its source' | t">{{ (busy() ? 'Fetching…' : 'Fetch again') | t }}</button>
        }
      </span>
    } @else if (s.source) {
      <span class="dsr-dim">{{ 'Not in the library yet' | t }}</span>
      @if (canFetch()) {
        <span class="dsr-acts">
          <button type="button" class="dsr-btn" (click)="fetch(false)" [disabled]="busy()"
                  [title]="'Put this datasheet in the library, to search it from the Chat' | t">{{ (busy() ? 'Fetching…' : 'Fetch') | t }}</button>
        </span>
      }
    } @else {
      <span class="dsr-dim">{{ 'Attach a PDF to this product to keep it as its datasheet' | t }}</span>
    }
    @if (err()) { <span class="dsr-err" role="alert">{{ err() }}</span> }
  } @else {
    <span class="dsr-dim">…</span>
  }
</div>`,
})
export class DatasheetRow {
  maker = input.required<string>();
  product = input.required<string>();
  /** May put one in the library (the person's right to ask the Chat). */
  canFetch = input(false);
  private http = inject(HttpClient);
  state = signal<DsState | null>(null);
  busy = signal(false);
  err = signal('');
  private path = computed(() => `/api/datasheets/product/${encodeURIComponent(this.maker())}/${encodeURIComponent(this.product())}`);
  private seq = 0;

  constructor() {
    effect(() => {
      const p = this.path();
      untracked(() => this.load(p));
    });
  }

  private load(p: string) {
    const n = ++this.seq;
    this.state.set(null);
    this.err.set('');
    this.http.get<DsState>(p).subscribe({
      next: s => { if (n === this.seq) this.state.set(s); },
      error: () => { if (n === this.seq) this.state.set({ entry: null, source: null }); },
    });
  }

  fetch(refresh: boolean) {
    const p = this.path();
    this.busy.set(true);
    this.err.set('');
    this.http.post<{ entry: DsEntry }>(p, {}, { params: refresh ? { refresh: 'true' } : {} }).subscribe({
      next: r => { this.busy.set(false); this.state.update(s => ({ source: s?.source ?? null, entry: r.entry })); },
      error: e => { this.busy.set(false); this.err.set(e?.error?.detail || t('Could not fetch the datasheet')); },
    });
  }

  url(id: string) { return datasheetUrl(id); }
  day(iso: string) {
    return new Date(iso).toLocaleDateString(LANG() === 'tr' ? 'tr-TR' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  fmt(text: string, vars: Record<string, string | number>) {
    return t(text).replace(/\{(\w+)\}/g, (m, k) => k in vars ? String(vars[k]) : m);
  }
}


/** The datasheet pages a Chat step found or read (chat_tools datasheet_search, datasheet_read,
 *  datasheet_get: vars ref0..ref5 = "<library id>:<page>:<label>"), as one row of links under the
 *  step; each opens the library's PDF at that page in the viewer over the Chat (file-modal.ts). */
export interface DsRef { id: string; page: number; label: string }

export function dsRefs(vars: Record<string, unknown> | null | undefined): DsRef[] {
  const out: DsRef[] = [];
  for (let i = 0; i < 6; i++) {
    const m = /^([^:]+):(\d+):(.*)$/.exec(String(vars?.['ref' + i] ?? ''));
    if (m) out.push({ id: m[1], page: +m[2], label: m[3] });
  }
  return out;
}

@Component({
  selector: 'wb-ds-refs',
  imports: [T],
  styles: [`
    :host { display: block; min-width: 0; }
    .dsx { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 4px; margin: 2px 0 6px 22px; font-size: 12px; }
    .dsx-k { color: var(--ink-dim); margin-right: 4px; }
    .dsx-a { display: inline-flex; align-items: baseline; gap: 5px; height: 22px; padding: 0 7px; border: 0; border-radius: 4px;
      background: none; font: inherit; color: var(--ink-dim); cursor: pointer; }
    .dsx-a b { color: var(--ink); font-weight: 600; font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 11.5px; }
    .dsx-a:hover, .dsx-a:focus-visible { background: var(--hover); color: var(--ink); outline: none; }
  `],
  template: `
@if (refs().length) {
  <div class="dsx">
    <span class="dsx-k">{{ 'Datasheet' | t }}@if (!showLabel()) { · {{ refs()[0].label }}}</span>
    @for (r of refs(); track r.id + ':' + r.page) {
      <button type="button" class="dsx-a" (click)="open(r)" [title]="fmt('Open the datasheet at page {n}', { n: r.page })">
        @if (showLabel()) { <span>{{ r.label }}</span> }<b>{{ fmt('p. {n}', { n: r.page }) }}</b></button>
    }
  </div>
}`,
})
export class DatasheetRefs {
  vars = input<Record<string, unknown> | null | undefined>(null);
  refs = computed(() => dsRefs(this.vars()));
  /** The part's name on each link only when the pages are of more than one part. */
  showLabel = computed(() => new Set(this.refs().map(r => r.id)).size > 1);
  open(r: DsRef) {
    FileModal.open({ id: '', src: datasheetUrl(r.id), name: `${r.label} · ${t('Datasheet')}`, page: r.page });
  }
  fmt(text: string, vars: Record<string, string | number>) {
    return t(text).replace(/\{(\w+)\}/g, (m, k) => k in vars ? String(vars[k]) : m);
  }
}
