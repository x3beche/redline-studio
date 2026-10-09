import { Component, effect, inject, input, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { T, t } from '../i18n';

/** A reference whose part has more than one 3D body (backend/bodies.py board_listing). */
interface BodyRef {
  ref: string; part: string;
  options: { slug: string; name: string; model?: string }[];
  default: string; chosen: string | null; wears: string; wears_name: string;
  applied: string | null; left_out?: string;
}
interface BoardBodiesData {
  board: string; built: boolean; refs: BodyRef[]; not_drawn_yet: string[];
  refresh?: { state: string; error?: string } | null; left_out: Record<string, string>;
}

/** Board health's "3D bodies on this board": a selector per reference
 *  whose part has more than one body - LCSC's, or one drawn in the 3D
 *  room. The choice is this board's; its 3D is redrawn without routing. */
@Component({
  selector: 'app-board-bodies',
  imports: [T],
  styles: [`
    :host { display: contents; }
    .bb-sec { font-size: 10.5px; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-dim);
              margin: 4px 2px -2px; }
    .bb { display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--line);
          border-radius: 6px; font-size: 11px; }
    .bb-row { display: grid; grid-template-columns: auto auto minmax(0, 1fr); gap: 2px 8px; align-items: center;
              padding: 5px 9px; }
    .bb-row + .bb-row { border-top: 1px dashed var(--line); }
    .bb-ref { padding: 0 5px; font: 10.5px/16px 'IBM Plex Mono', ui-monospace, monospace; color: var(--ink);
              background: var(--surface-2); border-radius: 3px; }
    .bb-part { font: 10.5px 'IBM Plex Mono', ui-monospace, monospace; color: var(--ink-dim); }
    .bb-sub { grid-column: 2 / -1; color: var(--ink-dim); }
    .bb-warn { grid-column: 2 / -1; color: var(--warn); }
    .bb-err { padding: 5px 9px; color: var(--danger); }
  `],
  template: `
  @if (data(); as d) {
    @if (d.refs.length) {
      <div class="bb-sec">{{ '3D bodies on this board' | t }}</div>
      <div class="bb">
        @for (r of d.refs; track r.ref) {
          <div class="bb-row">
            <span class="bb-ref">{{ r.ref }}</span>
            <span class="bb-part">{{ r.part }}</span>
            <select class="tcv-field px-1 py-0.5 text-[11px]" [disabled]="!canEdit() || busy()"
                    (change)="choose(r, $any($event.target).value)"
                    [title]="'Which of its part\\'s 3D bodies this part wears on this board' | t">
              <option value="default" [selected]="!r.chosen">{{ 'default' | t }} ({{ nameOf(r, r.default) }})</option>
              @for (o of r.options; track o.slug) {
                <option [value]="o.slug" [selected]="r.chosen === o.slug">{{ o.name }}</option>
              }
            </select>
            @if (r.applied !== null && r.applied !== r.wears) {
              <span class="bb-sub">{{ 'The 3D still shows' | t }} {{ nameOf(r, r.applied) }} - {{ 'redrawing' | t }}</span>
            }
            @if (r.left_out) { <span class="bb-warn">{{ r.left_out }}</span> }
          </div>
        }
        @if (d.refresh?.state === 'failed') { <div class="bb-err">{{ '3D not redrawn' | t }}: {{ d.refresh?.error }}</div> }
      </div>
    }
  }
  @if (error()) { <div class="bb-err">{{ error() }}</div> }
  `,
})
export class BoardBodies {
  private http = inject(HttpClient);
  board = input<string | null>(null);
  canEdit = input(false);
  data = signal<BoardBodiesData | null>(null);
  busy = signal(false);
  error = signal('');
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    effect(() => { const b = this.board(); this.data.set(null); if (b) this.load(b); });
  }

  nameOf(r: BodyRef, slug: string | null) { return r.options.find(o => o.slug === slug)?.name ?? slug ?? ''; }

  load(b = this.board()) {
    if (!b) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.http.get<BoardBodiesData>(`/api/boards/${encodeURIComponent(b)}/bodies`).subscribe({
      next: d => {
        if (d.board !== this.board()) return;
        this.data.set(d);
        // While the 3D is being redrawn, look again now and then.
        if (['queued', 'drawing'].includes(d.refresh?.state ?? '')) this.timer = setTimeout(() => this.load(), 5000);
      },
      error: () => this.data.set(null),
    });
  }

  choose(r: BodyRef, variant: string) {
    const b = this.board();
    if (!b) return;
    this.busy.set(true);
    this.http.put(`/api/boards/${encodeURIComponent(b)}/bodies/${encodeURIComponent(r.ref)}`, { variant }).subscribe({
      next: () => { this.busy.set(false); this.error.set(''); this.load(); },
      error: e => { this.busy.set(false); this.error.set(e?.error?.detail ?? t('refused')); this.load(); },
    });
  }
}
