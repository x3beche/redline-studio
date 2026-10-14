import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, inject, output, signal } from '@angular/core';
import { Auth } from '../auth';
import { LANG, T, t } from '../i18n';

/** An item of the workspace's memory (backend/cc_memory.py). */
export interface MemoryItem {
  id: string; text: string; at: string; by: { id?: string; name?: string };
  edited_at?: string; edited_by?: { id?: string; name?: string };
}
interface Memory { items: MemoryItem[]; max_items: number; max_chars: number; max_total: number; used: number }

const HEADERS = { 'Content-Type': 'application/json', 'X-Redline-CSRF': '1' };
const CLOSE = 'M6 6l12 12 M18 6L6 18';
/** A pin: the Chat's "Workspace memory". */
export const MEMORY_ICO = 'M9 4h6l-1 5 3 3v2H7v-2l3-3z M12 14v6';

/** The workspace's memory: what every conversation here is told, pinned
 *  by the people (or by the model's memory_write). Who pinned each item
 *  and when; adding and rewording is the "edit" right, removing asks
 *  once more on the row. Opened from the conversation's menu. */
@Component({
  selector: 'rl-cc-memory',
  imports: [T],
  styles: [`
    .mv { position: fixed; inset: 0; z-index: 900; background: var(--overlay); }
    .mp { position: fixed; top: 0; right: 0; bottom: 0; z-index: 901; display: flex; flex-direction: column;
      width: min(640px, 100vw); background: var(--surface); border-left: 1px solid var(--line); box-shadow: var(--shadow-soft); }
    .mh { display: flex; align-items: baseline; gap: 12px; padding: 14px 18px 12px; border-bottom: 1px solid var(--line); }
    .mh h2 { margin: 0; font-size: 15px; font-weight: 600; color: var(--ink-bright); }
    .dim { font-size: 12px; color: var(--ink-dim); }
    .mono { font-family: 'IBM Plex Mono', ui-monospace, monospace; }
    .x { margin-left: auto; align-self: center; display: grid; place-items: center; width: 28px; height: 28px; padding: 0;
      color: var(--ink-dim); background: none; border: 0; border-radius: 5px; cursor: pointer; }
    .x:hover { color: var(--ink); background: var(--hover); }
    svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
    .mb { flex: 1; min-height: 0; overflow: auto; padding: 10px 18px 18px; }
    .about { margin: 0 0 10px; font-size: 12px; color: var(--ink-dim); }
    .add { display: flex; gap: 6px; margin-bottom: 6px; }
    input { flex: 1; min-width: 0; height: 30px; padding: 0 9px; font: inherit; font-size: 12.5px; color: var(--ink);
      background: var(--surface-2); border: 1px solid var(--line); border-radius: 5px; }
    input:focus { outline: none; border-color: var(--accent); }
    .btn { height: 30px; padding: 0 12px; font: inherit; font-size: 12px; color: var(--ink); background: var(--surface-2);
      border: 1px solid var(--line); border-radius: 5px; cursor: pointer; white-space: nowrap; }
    .btn:hover:not(:disabled) { background: var(--hover); }
    .btn:disabled { opacity: .5; cursor: default; }
    .err { margin: 4px 0 8px; font-size: 12px; color: var(--danger); }
    ul { list-style: none; margin: 8px 0 0; padding: 0; border-top: 1px solid var(--line); }
    li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 10px; align-items: center; padding: 8px 2px;
      border-bottom: 1px solid var(--line); }
    li:hover .acts { opacity: 1; }
    .txt { font-size: 13px; color: var(--ink); overflow-wrap: anywhere; }
    .meta { grid-column: 1; font-size: 11px; color: var(--ink-dim); }
    .acts { grid-column: 2; grid-row: 1 / span 2; display: flex; gap: 2px; opacity: .55; transition: opacity 120ms; }
    .tb { padding: 3px 7px; font: inherit; font-size: 11.5px; color: var(--ink-dim); background: none; border: 0; border-radius: 4px; cursor: pointer; }
    .tb:hover { color: var(--ink); background: var(--hover); }
    .tb.danger:hover, .tb.sure { color: var(--danger); }
    .edit { grid-column: 1 / -1; display: flex; gap: 6px; }
    .empty { margin: 24px 2px; font-size: 12.5px; color: var(--ink-dim); }
    @media (prefers-reduced-motion: reduce) { .acts { transition: none; } }
    @media (max-width: 760px) { .acts { opacity: 1; } }
  `],
  template: `
<div class="mv tcv-m-veil" animate.leave="tcv-leave" (click)="close.emit()"></div>
<aside class="mp tcv-m-panel-r" animate.leave="tcv-leave" role="dialog" aria-modal="true" [attr.aria-label]="'Workspace memory' | t"
       (keydown.escape)="close.emit()">
  <header class="mh">
    <h2>{{ 'Workspace memory' | t }}</h2>
    @if (mem(); as m) { <span class="dim mono">{{ m.items.length }}/{{ m.max_items }} · {{ m.used }}/{{ m.max_total }}</span> }
    <button class="x" (click)="close.emit()" [title]="'Close' | t"><svg viewBox="0 0 24 24"><path [attr.d]="CLOSE" /></svg></button>
  </header>
  <div class="mb">
    <p class="about">{{ 'What every conversation in this workspace is told: printer settings, preferred parts, projects, conventions. Never keys or passwords.' | t }}</p>
    @if (canEdit) {
      <form class="add" (submit)="$event.preventDefault(); add()">
        <input [value]="draft()" (input)="draft.set($any($event.target).value)" [maxLength]="mem()?.max_chars ?? 300"
               [placeholder]="'Something to remember, one fact' | t" [attr.aria-label]="'Something to remember, one fact' | t" />
        <button class="btn" type="submit" [disabled]="busy() || !draft().trim()">{{ 'Pin' | t }}</button>
      </form>
    }
    @if (err()) { <div class="err" role="alert">{{ err() }}</div> }
    @if (mem(); as m) {
      @if (m.items.length) {
        <ul>
          @for (it of m.items; track it.id) {
            <li>
              @if (editing() === it.id) {
                <form class="edit" (submit)="$event.preventDefault(); save(it)">
                  <input [value]="editText()" (input)="editText.set($any($event.target).value)" [maxLength]="m.max_chars"
                         (keydown.escape)="$event.stopPropagation(); editing.set(null)" [attr.aria-label]="'Edit' | t" />
                  <button class="btn" type="submit" [disabled]="busy() || !editText().trim()">{{ 'Save' | t }}</button>
                  <button class="btn" type="button" (click)="editing.set(null)">{{ 'Cancel' | t }}</button>
                </form>
              } @else {
                <span class="txt">{{ it.text }}</span>
                <span class="meta">{{ it.by.name || ('someone' | t) }} · {{ when(it.at) }}{{
                  it.edited_at ? ' · ' + ('edited by' | t) + ' ' + (it.edited_by?.name || ('someone' | t)) + ' ' + when(it.edited_at) : '' }}</span>
                @if (canEdit) {
                  <span class="acts">
                    <button class="tb" (click)="startEdit(it)">{{ 'Edit' | t }}</button>
                    <button class="tb danger" [class.sure]="sure() === it.id" (click)="remove(it)">
                      {{ (sure() === it.id ? 'Remove?' : 'Remove') | t }}</button>
                  </span>
                }
              }
            </li>
          }
        </ul>
      } @else {
        <p class="empty">{{ 'Nothing is pinned yet. Ask the Chat to remember something, or pin it here.' | t }}</p>
      }
    }
  </div>
</aside>`,
})
export class CcMemoryPanel {
  close = output<void>();
  private http = inject(HttpClient);
  readonly canEdit = inject(Auth).can('edit');
  readonly CLOSE = CLOSE;
  mem = signal<Memory | null>(null);
  draft = signal('');
  editing = signal<string | null>(null);
  editText = signal('');
  sure = signal<string | null>(null);
  busy = signal(false);
  err = signal('');

  constructor() {
    this.http.get<Memory>('/api/cc/memory').subscribe({ next: m => this.mem.set(m), error: e => this.fail(e) });
  }

  when(iso: string) {
    return iso ? new Date(iso).toLocaleDateString(LANG() === 'tr' ? 'tr-TR' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  }

  private fail(e: HttpErrorResponse) {
    this.busy.set(false);
    this.err.set(typeof e.error?.detail === 'string' ? e.error.detail : t('The memory could not be saved.'));
  }

  private send(req: ReturnType<HttpClient['get']>, then?: () => void) {
    this.busy.set(true);
    this.err.set('');
    (req as ReturnType<HttpClient['get']>).subscribe({
      next: m => { this.mem.set(m as Memory); this.busy.set(false); then?.(); },
      error: e => this.fail(e),
    });
  }

  add() {
    const text = this.draft().trim();
    if (text) this.send(this.http.post('/api/cc/memory', { text }, { headers: HEADERS }), () => this.draft.set(''));
  }

  startEdit(it: MemoryItem) { this.sure.set(null); this.editText.set(it.text); this.editing.set(it.id); }

  save(it: MemoryItem) {
    const text = this.editText().trim();
    if (text) this.send(this.http.patch(`/api/cc/memory/${it.id}`, { text }, { headers: HEADERS }), () => this.editing.set(null));
  }

  /** The first press asks ("Remove?"), the second removes. */
  remove(it: MemoryItem) {
    if (this.sure() !== it.id) { this.sure.set(it.id); return; }
    this.sure.set(null);
    this.send(this.http.delete(`/api/cc/memory/${it.id}`, { headers: HEADERS }));
  }
}
