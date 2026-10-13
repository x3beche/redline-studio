import { Component, Injectable, OnDestroy, inject, input, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { PartHeld, PartHit, PartPreview, Parts } from '../api';
import { Auth } from '../auth';
import { T, t } from '../i18n';
import { PartCard } from './part-card';
import { warmPart } from './part-assets';

/** An add being watched (backend main.py /api/parts-add). */
export interface PartAdd {
  id?: string; lcsc: string; state: 'running' | 'done' | 'error';
  steps: { step: string; text: string }[]; error?: string | null; already?: boolean;
  place?: { group: string; branch: string; by: string } | null;
}

/** THE PARTS DRAWER'S WORK, for a room that shows it: what the drawer
 *  holds, a search of LCSC, adding a part (watched step by step), and one
 *  part open in full - its card (part-card.ts), its datasheet, which
 *  drawer it is in. The board room's Parts tab and the Product Catalog's
 *  LCSC seller each provide their own (`providers: [PartDesk]`); the
 *  drawer itself is the server's, so both see the same parts. */
@Injectable()
export class PartDesk implements OnDestroy {
  readonly store = inject(Parts);
  private http = inject(HttpClient);
  private auth = inject(Auth);

  /** The drawer of parts, and what a search in LCSC turned up. */
  held = signal<PartHeld[]>([]);
  hits = signal<PartHit[]>([]);
  term = signal('');
  looking = signal(false);
  note = signal('');
  /** The part open in full, and the one being looked up. */
  seen = signal<PartPreview | null>(null);
  seeing = signal<string | null>(null);
  seenPins = signal<{ number: string; name: string }[] | null>(null);
  places = signal<{ group: string; branches: string[] }[]>([]);
  adding = signal<PartAdd | null>(null);
  /** A part just added: its row is shown and blinks. */
  pulse = signal<string | null>(null);
  /** Told whenever the drawer changed (added, moved, dropped). */
  changed = signal(0);

  canEdit = () => this.auth.can('edit');

  load() {
    this.store.held().subscribe({ next: rows => this.held.set(rows) });
  }
  heldRow(lcsc: string): PartHeld | undefined { return this.held().find(p => p.lcsc === lcsc); }

  isNumber(s: string): boolean { return /^\s*c\d{2,}\s*$/i.test(s); }

  /** Look in LCSC's catalogue. A part number finds itself; anything else
   *  is a search, and nothing is downloaded by looking. */
  look() {
    const q = this.term().trim();
    if (!q || this.looking()) return;
    this.looking.set(true);
    this.note.set('');
    this.store.search(q).subscribe({
      next: rows => {
        this.looking.set(false);
        this.hits.set(rows);
        if (!rows.length) this.note.set(t('nothing came back for that'));
      },
      error: e => {
        this.looking.set(false);
        this.note.set(String(e?.error?.detail ?? t('LCSC did not answer')));
      },
    });
  }

  /** A C-number is added; anything else is a search of LCSC. */
  addOrLook() {
    const q = this.term().trim();
    if (!q) { this.adding.set({ lcsc: '', state: 'error', steps: [{ step: 'error', text: t('type an LCSC number - C25744') }] }); return; }
    if (this.isNumber(q)) this.addPart(q.toUpperCase());
    else this.look();
  }

  /** Open one part in full: the facts at once, the drawings and the model
   *  as they arrive. Clicking through a list quickly starts several
   *  lookups; only the last one clicked may land. */
  inspect(lcsc: string) {
    if (this.seen()?.lcsc === lcsc) return;
    this.seeing.set(lcsc);
    this.seen.set(null);
    this.seenPins.set(null);
    // A part in the drawer is on the server's disk: its drawings, model and
    // footprint frame are asked for now, beside the facts, not after them.
    const kept = this.heldRow(lcsc);
    if (kept) warmPart(lcsc, kept.has_3d);
    if (!this.places().length) {
      this.http.get<{ group: string; branches: string[] }[]>('/api/parts-places')
        .subscribe({ next: p => this.places.set(p) });
    }
    this.http.get<{ number: string; name: string }[]>(`/api/parts/${encodeURIComponent(lcsc)}/pins`).subscribe({
      next: p => { if (this.seeing() === lcsc) this.seenPins.set(p); },
      error: () => { if (this.seeing() === lcsc) this.seenPins.set([]); },
    });
    this.store.preview(lcsc).subscribe({
      next: p => { if (this.seeing() === lcsc) this.seen.set(p); },
      error: e => {
        if (this.seeing() !== lcsc) return;
        this.seeing.set(null);
        this.note.set(String(e?.error?.detail ?? `${lcsc} could not be looked up`));
      },
    });
  }
  closePart() {
    this.seen.set(null);
    this.seeing.set(null);
  }
  isOpen() { return !!(this.seen() || this.seeing()); }

  // ---- the datasheet, on request (GET /api/parts/{C}/datasheet) ----

  datasheet = signal<{ lcsc: string; state: 'busy' | 'ready' | 'error'; text?: string } | null>(null);
  datasheetFor(lcsc: string) { const d = this.datasheet(); return d && d.lcsc === lcsc ? d : null; }
  datasheetUrl(lcsc: string): string { return `/api/parts/${encodeURIComponent(lcsc)}/datasheet`; }

  /** Fetched by the server the first time (two polite asks of LCSC), then
   *  opened in a tab from its kept copy. If the browser holds the tab back
   *  because the fetch took a while, the button has become a link. */
  openDatasheet(lcsc: string) {
    if (this.datasheetFor(lcsc)?.state === 'busy') return;
    this.datasheet.set({ lcsc, state: 'busy' });
    this.http.get(this.datasheetUrl(lcsc), { responseType: 'blob' }).subscribe({
      next: () => {
        this.datasheet.set({ lcsc, state: 'ready' });
        const w = window.open(this.datasheetUrl(lcsc), '_blank');
        if (w) w.opener = null;
      },
      error: async e => {
        let text = t('LCSC did not answer');
        try {
          const raw = e?.error instanceof Blob ? await e.error.text() : '';
          text = String(JSON.parse(raw)?.detail ?? text);
        } catch { /* not JSON: keep the plain line */ }
        // A 404 is LCSC having none: said in the page's language.
        if (e?.status === 404) text = t('LCSC has no datasheet for this part');
        this.datasheet.set({ lcsc, state: 'error', text });
      },
    });
  }

  // ---- adding a part, watched (POST /api/parts-add) ----

  private addTimer?: ReturnType<typeof setTimeout>;

  /** Keep one: its footprint, and its 3D model if it has one. That is
   *  what puts it within reach of a board. */
  addPart(lcsc: string) {
    if (this.adding()?.state === 'running') return;
    this.note.set('');
    this.adding.set({ lcsc, state: 'running', steps: [{ step: 'start', text: `${lcsc}: ${t('starting…')}` }] });
    this.http.post<PartAdd>('/api/parts-add', { lcsc }).subscribe({
      next: job => this.follow(job),
      error: e => this.adding.set({ lcsc, state: 'error',
        steps: [{ step: 'error', text: String(e?.error?.detail ?? t('the server did not answer')) }] }),
    });
  }

  private follow(job: PartAdd) {
    this.adding.set(job);
    clearTimeout(this.addTimer);
    if (job.state === 'running') {
      this.addTimer = setTimeout(() => this.http.get<PartAdd>(`/api/parts-add/${job.id}`).subscribe({
        next: j => this.follow(j),
        error: () => this.adding.set({ ...job, state: 'error',
          steps: [...job.steps, { step: 'error', text: t('lost track of the add - look in the drawer') }] }),
      }), 600);
      return;
    }
    if (job.state !== 'done') return;
    this.hits.update(rows => rows.map(r => r.lcsc === job.lcsc ? { ...r, have: true } : r));
    this.term.set('');
    this.store.held().subscribe({ next: rows => {
      this.held.set(rows);
      this.changed.update(n => n + 1);
      this.pulse.set(job.lcsc);
      setTimeout(() => this.pulse() === job.lcsc && this.pulse.set(null), 2500);
    } });
    this.seen.set(null);
    this.seeing.set(null);
    this.inspect(job.lcsc);
  }

  /** Which drawer: "group/branch", or null for where LCSC's category puts it. */
  placeIt(lcsc: string, value: string | null) {
    const [group, branch] = value ? [value.slice(0, value.indexOf('/')), value.slice(value.indexOf('/') + 1)] : [null, null];
    this.http.put(`/api/parts/${encodeURIComponent(lcsc)}/place`, { group, branch }).subscribe({
      next: () => { this.load(); this.changed.update(n => n + 1); },
      error: e => this.note.set(String(e?.error?.detail ?? t('could not move it'))),
    });
  }

  /** Out of this workspace's drawer (the cached files stay while another holds it). */
  drop(lcsc: string): Promise<boolean> {
    return new Promise(done => this.store.drop(lcsc).subscribe({
      next: () => { this.held.update(rows => rows.filter(p => p.lcsc !== lcsc)); this.changed.update(n => n + 1); done(true); },
      error: () => done(false),
    }));
  }

  ngOnDestroy() { clearTimeout(this.addTimer); }
}

/** One part in full, over the whole page: the part card (part-card.ts) in
 *  the Product Catalog's detail box. Esc or a click beside it closes it. */
@Component({
  selector: 'app-part-modal',
  imports: [T, PartCard],
  host: { '(document:keydown.escape)': 'desk.isOpen() && desk.closePart()' },
  styles: [`
    .pm-veil { position: fixed; inset: 0; z-index: 1100; display: flex; align-items: center; justify-content: center;
               padding: 24px; background: var(--scrim); }
    .pm-box { position: relative; width: min(1080px, 100%); max-height: calc(100vh - 48px); overflow: auto;
              box-sizing: border-box; background: var(--surface); border: 1px solid var(--line); border-radius: 6px;
              box-shadow: 0 12px 36px var(--shadow-hard); }
    .pm-wait { display: flex; align-items: center; gap: 8px; padding: 12px 16px; font-size: 11px; color: var(--ink-dim); }
    .pm-wait .mono { color: var(--ink); }
    .pm-x { margin-left: auto; }
    @media (max-width: 640px) { .pm-veil { padding: 8px; } .pm-box { max-height: calc(100vh - 16px); } }
  `],
  template: `
  @if (desk.isOpen()) {
    <div class="pm-veil tcv-m-veil" animate.leave="tcv-leave" (click)="desk.closePart()">
      <div class="pm-box tcv-m-box tcv-part-modal" role="dialog" aria-modal="true" (click)="$event.stopPropagation()"
           [attr.aria-label]="('Part' | t) + ' ' + (desk.seen()?.lcsc ?? desk.seeing())">
        @if (desk.seen(); as s) {
          <app-part-card [part]="s" [pins]="desk.seenPins()" [held]="desk.heldRow(s.lcsc)" [places]="desk.places()"
                         [adding]="desk.adding()" [datasheet]="desk.datasheetFor(s.lcsc)"
                         [canEdit]="desk.canEdit()" [canRun]="canRun()"
                         (closed)="desk.closePart()" (keep)="desk.addPart(s.lcsc)" (openDatasheet)="desk.openDatasheet(s.lcsc)"
                         (place)="desk.placeIt(s.lcsc, $event)" />
        } @else {
          <div class="pm-wait">
            <span class="mono">{{ desk.seeing() }}</span>
            <span>{{ 'looking it up…' | t }}</span>
            <button (click)="desk.closePart()" class="tcv-chip pm-x px-1.5 py-0" [title]="'close (Esc)' | t">&times;</button>
          </div>
        }
      </div>
    </div>
  }
  `,
})
export class PartModal {
  desk = inject(PartDesk);
  /** Whether a 3D body may be asked for (part-bodies.ts): the room says. */
  canRun = input(false);
}

/** An add, step by step, as the server goes (POST /api/parts-add). */
@Component({
  selector: 'app-part-adding',
  imports: [T],
  template: `
  @if (desk.adding(); as ad) {
    <div class="tcv-add-progress" [attr.data-state]="ad.state">
      @for (st of ad.steps; track $index; let last = $last) {
        <div class="tcv-add-step" [class.tcv-add-now]="last">
          <span class="tcv-add-mark">{{ last ? (ad.state === 'running' ? '…' : ad.state === 'error' ? '!' : '✓')
                                             : ad.state === 'error' && $index === ad.steps.length - 2 ? '–' : '✓' }}</span>
          <span>{{ st.text }}</span>
        </div>
      }
      @if (ad.state !== 'running') {
        <button class="tcv-add-close" (click)="desk.adding.set(null)" [title]="'dismiss' | t">&times;</button>
      }
    </div>
  }
  `,
})
export class PartAdding {
  desk = inject(PartDesk);
}
