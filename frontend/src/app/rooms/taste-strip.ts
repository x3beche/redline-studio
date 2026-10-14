import { Component, ElementRef, OnDestroy, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Auth } from '../auth';
import { TREE_MOVED } from '../api';
import { Selection } from '../selection';
import { T, t } from '../i18n';
import { Toast } from '../toast';
import { Palette, TasteApi } from './taste';

/** Which Taste palettes apply to the model, board or firmware on show, in
 *  one line where the room shows the project itself (the 3D room's Model
 *  tab, the board's Health, the firmware's Status): a chip each, the
 *  folder it comes through when it is not attached to this project itself
 *  ("via pyro/"), and "Attach…" to attach one here or take one off.
 *
 *  Worked out by the server from where the project is now (GET
 *  /api/taste/attached, backend/taste.py attached_to), so it is asked
 *  again when another project is opened, when a palette is attached or
 *  taken off anywhere (TasteApi.changed) and when a model or a board is
 *  moved to another folder (TREE_MOVED). A chip opens the palette in the
 *  Taste room. */
type Applying = Palette & { via?: string | null };

const KIND_TIP: Record<string, string> = {
  model: 'Attached to this model', board: 'Attached to this board', firmware: 'Attached to this firmware',
};

@Component({
  selector: 'wb-taste-strip',
  imports: [T],
  styles: [`
    :host { display: block; }
    .tss { position: relative; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; min-width: 0; font-size: 11px; }
    .tss-label { font: 600 10px 'IBM Plex Mono', ui-monospace, monospace; letter-spacing: .06em; text-transform: uppercase;
                 color: var(--ink-dim); margin-right: 2px; }
    .tss-chip { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; min-width: 0; height: 20px; padding: 0 7px;
                font: inherit; color: var(--ink); background: var(--surface-2); border: 1px solid var(--line);
                border-radius: 10px; cursor: pointer; }
    .tss-chip:hover { border-color: var(--accent-deep); background: var(--hover); }
    .tss-chip:focus-visible, .tss-add:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .tss-chip > b { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tss-chip > i { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); flex: none; }
    .tss-chip[data-via] > i { background: transparent; border: 1px solid var(--accent); box-sizing: border-box; }
    .tss-n { font: 10px 'IBM Plex Mono', ui-monospace, monospace; color: var(--ink-dim); }
    .tss-via { color: var(--ink-dim); white-space: nowrap; }
    .tss-none { color: var(--ink-dim); }
    .tss-add { height: 20px; padding: 0 7px; font: inherit; color: var(--ink-dim); background: none;
               border: 1px dashed var(--line); border-radius: 10px; cursor: pointer; }
    .tss-add:hover, .tss-add[aria-expanded="true"] { color: var(--ink); border-color: var(--accent-deep); }

    /* "Attach…": every palette, a line each - on here, through a folder, or not */
    .tss-pop { position: absolute; z-index: 30; top: calc(100% + 4px); left: 0; right: 0; max-height: 280px; overflow-y: auto;
               padding: 4px; background: var(--surface); border: 1px solid var(--line); border-radius: 6px;
               box-shadow: 0 8px 24px var(--shadow-hard); }
    .tss-opt { display: grid; grid-template-columns: 14px minmax(0, 1fr) auto; align-items: center; gap: 8px; width: 100%;
               padding: 5px 7px; font: inherit; font-size: 12px; color: var(--ink); text-align: left; background: none;
               border: 0; border-radius: 4px; cursor: pointer; }
    .tss-opt:hover:not(:disabled), .tss-opt:focus-visible { background: var(--hover); outline: none; }
    .tss-opt:disabled { cursor: default; color: var(--ink-dim); }
    .tss-opt > span:nth-child(2) { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tss-opt > small { font-size: 11px; color: var(--ink-dim); white-space: nowrap; }
    .tss-box { width: 12px; height: 12px; box-sizing: border-box; border: 1px solid var(--line); border-radius: 3px; }
    .tss-box[data-on] { background: var(--accent); border-color: var(--accent); }
    .tss-box[data-via] { border-style: dashed; border-color: var(--accent); }
    .tss-go { border-top: 1px solid var(--line); margin-top: 4px; padding-top: 4px; }
    .tss-empty { padding: 6px 7px; font-size: 11px; color: var(--ink-dim); }
  `],
  template: `
@if (ref()) {
  <div class="tss" role="group" [attr.aria-label]="'Taste palettes that apply here' | t">
    <span class="tss-label">{{ 'Taste' | t }}</span>
    @for (p of rows(); track p.id) {
      <button type="button" class="tss-chip" [attr.data-via]="p.via ? 1 : null" (click)="open(p)" [title]="tip(p)">
        <i aria-hidden="true"></i><b>{{ p.name }}</b><span class="tss-n">{{ p.items.length }}</span>
        @if (p.via) { <span class="tss-via">{{ viaWord(p.via) }}</span> }
      </button>
    } @empty {
      @if (loaded()) { <span class="tss-none">{{ 'No palette applies' | t }}</span> }
    }
    @if (canAttach()) {
      <button type="button" class="tss-add" (click)="toggle()" aria-haspopup="true" [attr.aria-expanded]="picking()"
              [title]="'Attach a palette to this project, or take one off' | t">{{ 'Attach…' | t }}</button>
    }
    @if (picking()) {
      <div class="tss-pop tcv-pop-in" animate.leave="tcv-leave" role="group" [attr.aria-label]="'Attach…' | t">
        @for (o of options(); track o.p.id) {
          <button type="button" class="tss-opt" [disabled]="!!o.via" (click)="set(o.p, !o.on)"
                  [attr.aria-pressed]="o.via ? null : o.on">
            <i class="tss-box" [attr.data-on]="o.on ? 1 : null" [attr.data-via]="o.via ? 1 : null" aria-hidden="true"></i>
            <span>{{ o.p.name }}</span>
            <small>{{ o.via ? viaWord(o.via) : o.p.items.length + ' ' + ('items' | t) }}</small>
          </button>
        } @empty {
          <div class="tss-empty">{{ (all() ? 'No palettes yet.' : 'Loading…') | t }}</div>
        }
        <button type="button" class="tss-opt tss-go" (click)="toggle(); picked.room.set('taste')">
          <span></span><span>{{ 'Open Taste' | t }}</span><small></small></button>
      </div>
    }
  </div>
}
`,
})
export class TasteStrip implements OnDestroy {
  private http = inject(HttpClient);
  private api = inject(TasteApi);
  private auth = inject(Auth);
  picked = inject(Selection);
  private host = inject(ElementRef<HTMLElement>);
  kind = input.required<'model' | 'board' | 'firmware'>();
  /** The project's id; nothing is shown without one. */
  ref = input<string | null | undefined>(null);
  /** The folder the room knows it is in, when it knows: a change reads again. */
  folder = input<string | null | undefined>(null);

  rows = signal<Applying[]>([]);
  /** Every palette of the workspace, for "Attach…" to open at once. */
  all = signal<Palette[] | null>(null);
  /** "Attach…" open. */
  picking = signal(false);
  /** Each palette as the list shows it: attached here (on), through a folder (via), or not. */
  options = computed(() => {
    const ref = this.ref(), kind = this.kind(), here = new Map(this.rows().map(p => [p.id, p]));
    return (this.all() ?? []).map(p => ({
      p, on: p.attached.some(a => a.kind === kind && a.id === ref),
      via: here.get(p.id)?.via && !p.attached.some(a => a.kind === kind && a.id === ref) ? here.get(p.id)!.via! : null,
    }));
  });
  /** A press outside the list, or Escape, closes it. */
  private away = (e: Event) => {
    if (e instanceof KeyboardEvent ? e.key === 'Escape' : !this.host.nativeElement.contains(e.target as Node)) { this.picking.set(false); this.listen(false); }
  };
  loaded = signal(false);
  canAttach = computed(() => this.auth.can('draw'));
  private asked = 0;

  constructor() {
    effect(() => {
      const kind = this.kind(), ref = this.ref();
      this.folder(); this.api.changed(); TREE_MOVED();
      untracked(() => this.read(kind, ref ?? null));
    });
  }

  ngOnDestroy() { this.asked++; this.listen(false); }

  toggle() {
    const on = !this.picking();
    this.picking.set(on);
    this.listen(on);
  }

  private listen(on: boolean) {
    const f = (on ? document.addEventListener : document.removeEventListener).bind(document);
    f('pointerdown', this.away, true);
    f('keydown', this.away, true);
  }

  private read(kind: string, ref: string | null) {
    const n = ++this.asked;
    if (!ref) { this.rows.set([]); return; }
    const q = `kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(ref)}`;
    this.http.get<{ palettes: Applying[] }>(`/api/taste/attached?${q}`).subscribe({
      next: r => { if (n === this.asked) { this.rows.set(r.palettes ?? []); this.loaded.set(true); } },
      error: () => { if (n === this.asked) { this.rows.set([]); this.loaded.set(true); } },
    });
    if (this.canAttach()) this.api.list('').subscribe({ next: ps => { if (n === this.asked) this.all.set(ps); }, error: () => {} });
  }

  tip(p: Applying): string {
    const what = p.via ? t('Attached to the folder {f}: everything in it gets it').replace('{f}', p.via + '/')
      : t(KIND_TIP[this.kind()]);
    return `${what} · ${p.items.length} ${t('items')} - ${t('open it in Taste')}`;
  }

  /** "via pyro/": the folder it comes through. */
  viaWord(folder: string) { return t('via {f}').replace('{f}', folder + '/'); }

  /** The palette, in the Taste room. */
  open(p: Applying) {
    this.picked.room.set('taste');
    setTimeout(() => this.picked.ask('taste', p.id), 50);
  }

  set(p: Palette, on: boolean) {
    const ref = this.ref(), kind = this.kind();
    if (!ref) return;
    const rest = p.attached.filter(a => !(a.kind === kind && a.id === ref)).map(a => ({ kind: a.kind, id: a.id, specifics: a.specifics }));
    this.api.attach(p.id, on ? [...rest, { kind, id: ref }] : rest).subscribe({
      next: () => Toast.show((on ? t('Attached "{x}"') : t('Took off "{x}"')).replace('{x}', p.name)),
      error: (err: HttpErrorResponse) => Toast.show(typeof err.error?.detail === 'string' ? err.error.detail : t('Could not attach it.'),
                                                     { tone: 'danger' }),
    });
  }
}
