/** Working now: every build, rebuild, board job and note being worked on,
 *  under the catalog - and what finished in the last few minutes, so a
 *  build that ends does not just vanish (backend/worknow.py). */
import { HttpClient } from '@angular/common/http';
import { Component, OnDestroy, computed, inject, output, signal } from '@angular/core';

interface WorkItem {
  kind: 'model' | 'board' | 'note';
  id: string;
  title: string;
  state: 'building' | 'queued' | 'running';
  secs: number | null;
  expected_secs: number | null;
  why: string | null;
  job?: string;
  room?: string;
  percent?: number | null;
  by?: string | null;
}
interface WorkRecent { kind: string; id: string; ok: boolean; secs: number | null; ago: number | null }
interface WorkNow { items: WorkItem[]; recent: WorkRecent[] }

@Component({
  selector: 'app-work-now',
  template: `
<div class="px-3 py-2" style="border-top: 1px solid var(--line)">
  <button class="tcv-work-head" (click)="toggle()" [attr.aria-expanded]="open()">
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" [style.transform]="open() ? 'rotate(90deg)' : null">
      <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
    <span class="tcv-label">Working now</span>
    @if (busy()) {
      <span class="tcv-work-dot"></span>
      <span class="text-[10px]" style="color: var(--accent)">{{ data()?.items?.length }}</span>
    } @else {
      <span class="text-[10px]" style="color: var(--ink-dim)">idle</span>
    }
  </button>
  @if (open()) {
    <ul class="tcv-scroll mt-1 max-h-[45vh] overflow-y-auto">
      @for (w of data()?.items ?? []; track w.kind + w.id) {
        <li class="tcv-work-row" [class.tcv-work-click]="w.kind !== 'board'" (click)="pick(w)"
            [title]="w.why ? 'rebuilding because ' + w.why : w.id">
          <span class="flex items-center gap-1.5">
            <span class="tcv-work-state" [attr.data-state]="w.state"></span>
            <span class="min-w-0 flex-1 truncate text-[11px]" style="color: var(--ink)">{{ w.title }}</span>
            <span class="mono shrink-0 text-[10px]" style="color: var(--ink-dim)">
              @if (w.secs != null) { {{ clock(w.secs) }}@if (w.expected_secs) { / ~{{ clock(w.expected_secs) }} } }
              @else { waiting }
            </span>
          </span>
          <span class="block truncate pl-3 text-[10px]" style="color: var(--ink-dim)">
            {{ label(w) }}@if (w.why) { · {{ w.why }} }
          </span>
          @if (bar(w); as p) {
            <span class="tcv-work-bar"><span [style.width.%]="p"></span></span>
          }
        </li>
      } @empty {
        <li class="text-[11px]" style="color: var(--ink-dim)">nothing is building</li>
      }
      @if (data()?.recent?.length) {
        <li class="tcv-label mt-1.5 text-[9px]">finished lately</li>
        @for (r of data()!.recent; track $index) {
          <li class="flex items-center gap-1.5 py-0.5 text-[10px]" [title]="r.id">
            <span [style.color]="r.ok ? 'var(--ok)' : 'var(--danger)'">{{ r.ok ? '✓' : '✗' }}</span>
            <span class="min-w-0 flex-1 truncate" style="color: var(--ink-dim)">{{ short(r.id) }}</span>
            <span class="mono shrink-0" style="color: var(--ink-dim)">{{ r.secs != null ? clock(r.secs) : '' }} · {{ ago(r.ago) }}</span>
          </li>
        }
      }
    </ul>
  }
</div>`,
})
export class WorkNowPanel implements OnDestroy {
  private http = inject(HttpClient);
  /** A model in the list was clicked: open it. */
  openModel = output<string>();
  data = signal<WorkNow | null>(null);
  open = signal(WorkNowPanel.recall());
  busy = computed(() => !!this.data()?.items?.length);
  private timer = setInterval(() => this.read(), 3000);

  constructor() { this.read(); }
  ngOnDestroy() { clearInterval(this.timer); }

  private read() {
    this.http.get<WorkNow>('/api/work/now').subscribe({ next: d => this.data.set(d), error: () => {} });
  }

  private static recall(): boolean {
    try { return localStorage.getItem('redline.work.panel') !== 'folded'; } catch { return true; }
  }
  toggle() {
    this.open.update(v => !v);
    try { localStorage.setItem('redline.work.panel', this.open() ? 'open' : 'folded'); } catch { /* private window */ }
  }

  pick(w: WorkItem) { if (w.kind === 'model') this.openModel.emit(w.id); }

  label(w: WorkItem): string {
    if (w.kind === 'board') return `board ${w.job ?? 'job'}`;
    if (w.kind === 'note') return `note in ${w.room ?? '?'}${w.by ? ' · ' + w.by : ''}`;
    return w.state === 'queued' ? 'rebuild queued' : 'building';
  }

  bar(w: WorkItem): number | null {
    if (w.kind === 'note') return w.percent ?? null;
    if (w.state !== 'building' || w.secs == null || !w.expected_secs) return null;
    return Math.min(95, Math.round(w.secs / w.expected_secs * 100));
  }

  clock(s: number): string {
    const m = Math.floor(s / 60), r = Math.round(s % 60);
    return m ? `${m}m ${String(r).padStart(2, '0')}s` : `${r}s`;
  }
  ago(s: number | null): string {
    if (s == null) return '';
    return s < 60 ? 'just now' : `${Math.round(s / 60)} min ago`;
  }
  short(id: string): string { return id.split('/').pop() ?? id; }
}
