import { Component, OnDestroy, effect, inject, input, output, signal, untracked } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { DecimalPipe } from '@angular/common';
import { Auth } from '../auth';

/** Releases: a project packed as it stands, under a tag, to make
 *  (backend/release.py). The list of what was released - each one kept
 *  exactly as it was, to download again - and a form for the next one.
 *  A release is made in the background; while one is, its log shows here.
 */
interface Release {
  id: string; project: string; tag: string; notes: string; status: 'building' | 'ready' | 'failed';
  by: { name?: string }; created_at: string; done_at?: string; took_s?: number; bytes?: number;
  files?: { path: string; bytes: number }[]; problems?: string[]; log?: string[];
  summary?: { boards: { id: string; bom?: { parts: number; total_usd: number; unpriced: string[] } }[]; models: number };
}

@Component({
  selector: 'app-releases',
  imports: [DecimalPipe],
  template: `
<div class="tcv-tokens-back" (click)="closed.emit()">
  <div class="tcv-tokens tcv-rel" (click)="$event.stopPropagation()" role="dialog" aria-label="Releases">
    <h2>Releases of {{ project() }}</h2>
    <p>Everything {{ project() }} is right now, in one zip, to send to a fab or a workshop: each board's Gerbers,
      drill files, BOM with LCSC prices and pick-and-place file, schematic and assembly PDFs and STEP; each model's
      STEP, STL and a dimensioned technical drawing; and every source as it was. Kept under its tag, never
      overwritten, to download exactly as it was.</p>
    @if (auth.can('run')) {
      <form class="tcv-rel-new" (submit)="$event.preventDefault(); make()">
        <input class="tcv-rel-tag" placeholder="v1.0" [value]="tag()" (input)="tag.set($any($event.target).value)"
               maxlength="32" aria-label="Tag">
        <input class="tcv-rel-notes" placeholder="What changed in this one (optional)" [value]="notes()"
               (input)="notes.set($any($event.target).value)" maxlength="4000" aria-label="Notes">
        <button class="tcv-btn tcv-btn-accent" type="submit" [disabled]="!tag().trim() || busy()">Release</button>
      </form>
    } @else {
      <p class="tcv-menu-blurb">{{ auth.why('run') }}</p>
    }
    @if (error(); as e) { <p class="tcv-signin-error" role="alert">{{ e }}</p> }
    @for (r of list(); track r.id) {
      <div class="tcv-rel-row" [attr.data-status]="r.status">
        <div class="tcv-rel-main">
          <span class="tcv-menu-name">{{ r.tag }}
            <span class="tcv-role">{{ r.status === 'building' ? 'packing…' : r.status === 'failed' ? 'failed' : (r.bytes ?? 0) / 1048576 | number: '1.1-1' }}{{ r.status === 'ready' ? ' MB' : '' }}</span>
          </span>
          <span class="tcv-menu-blurb">{{ r.by.name || 'someone' }} · {{ when(r.created_at) }}
            @if (r.took_s) { · packed in {{ r.took_s }} s }
            @if (r.files?.length) { · {{ r.files!.length }} files }</span>
          @if (r.notes) { <span class="tcv-rel-notes-text">{{ r.notes }}</span> }
          @for (b of r.summary?.boards ?? []; track b.id) {
            @if (b.bom) {
              <span class="tcv-menu-blurb">{{ b.id }}: {{ b.bom.parts }} parts · \${{ b.bom.total_usd | number: '1.2-2' }} a board
                @if (b.bom.unpriced.length) { ({{ b.bom.unpriced.length }} not priced) }</span>
            }
          }
          @if (r.problems?.length) {
            <details class="tcv-rel-problems"><summary>{{ r.problems!.length }} not made</summary>
              @for (p of r.problems!; track $index) { <div>{{ p }}</div> }</details>
          }
          @if (r.status !== 'ready' && r.log?.length) {
            <pre class="tcv-rel-log">{{ r.log!.slice(-8).join('\\n') }}</pre>
          }
        </div>
        <div class="tcv-rel-actions">
          @if (r.status === 'ready') {
            <a class="tcv-btn tcv-btn-accent" [href]="'/api/releases/' + r.id + '/download'" download>Download</a>
          }
          @if (auth.can('delete')) { <button class="tcv-btn" (click)="remove(r)">Delete</button> }
        </div>
      </div>
    } @empty { <p>No releases of {{ project() }} yet.</p> }
    <div class="tcv-tokens-end"><button class="tcv-btn" (click)="closed.emit()">Close</button></div>
  </div>
</div>`,
})
export class Releases implements OnDestroy {
  private http = inject(HttpClient);
  auth = inject(Auth);
  project = input.required<string>();
  closed = output<void>();
  list = signal<Release[]>([]);
  tag = signal('');
  notes = signal('');
  busy = signal(false);
  error = signal('');
  private poll?: ReturnType<typeof setInterval>;

  constructor() {
    effect(() => { this.project(); untracked(() => this.load()); });
  }

  load() {
    this.http.get<Release[]>(`/api/releases?project=${encodeURIComponent(this.project())}`).subscribe({
      next: l => {
        this.list.set(l);
        if (!this.tag()) this.tag.set(nextTag(l.map(r => r.tag)));
        // Follow one being packed; stop when none is.
        const building = l.some(r => r.status === 'building');
        if (building && !this.poll) {
          this.poll = setInterval(() => this.refreshBuilding(), 3000);
        } else if (!building && this.poll) {
          clearInterval(this.poll); this.poll = undefined;
        }
      },
      error: (e: HttpErrorResponse) => this.error.set(typeof e.error?.detail === 'string' ? e.error.detail : 'could not read the releases'),
    });
  }

  private refreshBuilding() {
    for (const r of this.list().filter(x => x.status === 'building')) {
      this.http.get<Release>(`/api/releases/${r.id}`).subscribe(d => {
        this.list.set(this.list().map(x => x.id === d.id ? d : x));
        if (d.status !== 'building') this.load();
      });
    }
  }

  make() {
    this.busy.set(true);
    this.error.set('');
    this.http.post<Release>('/api/releases', { project: this.project(), tag: this.tag().trim(), notes: this.notes() })
      .subscribe({
        next: () => { this.busy.set(false); this.tag.set(''); this.notes.set(''); this.load(); },
        error: (e: HttpErrorResponse) => {
          this.busy.set(false);
          this.error.set(typeof e.error?.detail === 'string' ? e.error.detail : 'the release could not be started');
        },
      });
  }

  remove(r: Release) {
    if (!confirm(`Delete ${r.project} ${r.tag}? The zip goes with it.`)) return;
    this.http.delete(`/api/releases/${r.id}`).subscribe({ next: () => this.load() });
  }

  when(iso: string) {
    return new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  ngOnDestroy() { clearInterval(this.poll); }
}

/** The tag after the last: v1.2 -> v1.3; the first is v1.0. */
export function nextTag(tags: string[]): string {
  const nums = tags.map(t => /^v?(\d+)\.(\d+)$/.exec(t)).filter(Boolean) as RegExpExecArray[];
  if (!nums.length) return 'v1.0';
  const [maj, min] = nums.map(m => [+m[1], +m[2]]).sort((a, b) => b[0] - a[0] || b[1] - a[1])[0];
  return `v${maj}.${min + 1}`;
}
