import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { Auth } from '../auth';
import { Catalog, ComponentRow, ComponentUse, ComponentVersions, ModelLinks, PinnedBy } from '../api';

/** Where an import line goes in a model's source: after the last import
 *  at the top level, or after the docstring when there is none. Returns
 *  the new source and the (1-based) line it went in at, or null when the
 *  line is there already. */
export function insertImport(source: string, line: string): { source: string; at: number } | null {
  const lines = source.split('\n');
  if (lines.some(l => l.trim() === line.trim())) return null;
  let at = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^(import|from)\s+\S/.test(lines[i])) at = i;
  }
  if (at < 0) {
    // After a leading docstring, if the file opens with one.
    const first = lines.findIndex(l => l.trim() !== '');
    at = first - 1;
    const q = first >= 0 ? lines[first].trim().slice(0, 3) : '';
    if (q === '"""' || q === "'''") {
      const rest = lines[first].trim().slice(3);
      if (rest.includes(q)) at = first;
      else {
        const end = lines.findIndex((l, i) => i > first && l.includes(q));
        at = end >= 0 ? end : first;
      }
    }
  }
  lines.splice(at + 1, 0, line);
  return { source: lines.join('\n'), at: at + 2 };
}

/** The Insert picker: every .3d model and .pcb board a model can import,
 *  and the line that imports it. Picking one hands the line back; the
 *  room puts it in the source. Using a component is importing it - never
 *  copying its geometry or its numbers. */
@Component({
  selector: 'app-component-picker',
  template: `
<div class="tcv-card absolute left-1/2 z-40 w-96 -translate-x-1/2 overflow-hidden p-0"
     [style.top.px]="top()" style="box-shadow: 0 8px 24px var(--shadow-hard)">
  <div class="flex items-center gap-2 px-2 py-1.5" style="border-bottom: 1px solid var(--line)">
    <span class="tcv-label">Insert component</span>
    <input class="tcv-field min-w-0 flex-1 px-1.5 py-0.5 text-[12px]" placeholder="filter…"
           [value]="q()" (input)="q.set($any($event.target).value)" (keydown.escape)="closed.emit()">
    <button class="tcv-chip px-1.5 py-0" (click)="closed.emit()" title="close">×</button>
  </div>
  <div class="tcv-scroll max-h-80 overflow-y-auto py-1 text-[12px]">
    @for (r of shown(); track r.kind + r.id) {
      <button class="flex w-full items-baseline gap-1.5 px-2 py-1 text-left hover:bg-[var(--hover)]"
              [disabled]="!r.line" (click)="r.line && picked.emit(r)"
              [title]="r.line ? r.line + (r.used_by.length ? ' - used by ' + r.used_by.join(', ') : '')
                              : 'no importable name'">
        <span class="min-w-0 truncate">{{ r.title }}</span>
        <span class="tcv-ext shrink-0">{{ r.kind === 'board' ? '.pcb' : '.3d' }}</span>
        @if (r.kind === 'board' && !r.ready) {
          <span class="shrink-0 text-[10px]" style="color: var(--warn)" title="lay the board out first">no 3D yet</span>
        }
        <span class="ml-auto shrink-0 font-mono text-[10px]" style="color: var(--ink-dim)">
          {{ r.module }}@if (r.version) { · v{{ r.version }} }
        </span>
      </button>
    } @empty {
      <p class="px-2 py-1" style="color: var(--ink-dim)">{{ rows() ? 'nothing matches' : 'reading the catalog…' }}</p>
    }
  </div>
  <p class="px-2 py-1.5 text-[10px] leading-snug" style="color: var(--ink-dim); border-top: 1px solid var(--line)">
    Adds the import line. Read the component's names (B.part, B.HOLES, F.SIZE…) -
    never copy its geometry or numbers: it changes, and so does this model.
  </p>
</div>`,
})
export class ComponentPicker {
  private cat = inject(Catalog);
  /** The model it is for: not offered to itself. */
  model = input('');
  top = input(12);
  picked = output<ComponentRow>();
  closed = output<void>();
  rows = signal<ComponentRow[] | null>(null);
  q = signal('');
  shown = computed(() => {
    const q = this.q().toLowerCase().trim();
    return (this.rows() ?? []).filter(r => r.id !== this.model()
      && (!q || (r.title + ' ' + r.id + ' ' + (r.module ?? '')).toLowerCase().includes(q)));
  });

  constructor() {
    this.cat.components().subscribe({ next: r => this.rows.set(r), error: () => this.rows.set([]) });
  }
}

/** A pin, drawn: a pushpin in the ink it is put in. */
@Component({
  selector: 'app-pin-icon',
  host: { class: 'tcv-pin-ico', 'aria-hidden': 'true' },
  template: `<svg viewBox="0 0 16 16" width="100%" height="100%" fill="none" stroke="currentColor"
     stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M5.5 2h5M6.5 2v4.2L4.5 9h7l-2-2.8V2M8 9v5"/></svg>`,
})
export class PinIcon {}

/** The models that use a component at a fixed version (the reverse of a
 *  pin), and one button that moves every one that is behind to the
 *  latest. Shown on a model's Links card and on a board's 3D card. */
@Component({
  selector: 'app-pinned-by',
  imports: [PinIcon],
  template: `
@if (rows().length) {
  <div class="flex items-center gap-1">
    <span class="tcv-label">pinned by</span>
    @if (behind().length) {
      <button class="tcv-btn tcv-btn-accent ml-auto px-1.5 py-0 text-[10px]" [disabled]="busy()"
              (click)="updateAll()" [title]="'pin ' + behind().length + ' to v' + latest() + ' and rebuild them'">
        {{ busy() ? 'updating…' : 'Update ' + (behind().length > 1 ? 'all ' + behind().length : '') + ' to v' + latest() }}
      </button>
    }
  </div>
  @for (p of rows(); track p.id) {
    <div class="flex items-baseline gap-1">
      <app-pin-icon [style.color]="p.behind ? 'var(--warn)' : 'var(--ink-dim)'" />
      <span class="min-w-0 truncate" [title]="p.id">{{ p.title }}</span>
      <span class="ml-auto shrink-0 font-mono text-[10px]" [style.color]="p.behind ? 'var(--warn)' : 'var(--ink-dim)'">
        v{{ p.version }}@if (p.behind) { · latest v{{ p.latest }} }
      </span>
    </div>
  }
  @if (said(); as t) { <div class="text-[10px]" style="color: var(--ink-dim)">{{ t }}</div> }
}`,
})
export class PinnedByList {
  private cat = inject(Catalog);
  kind = input.required<'model' | 'board'>();
  id = input.required<string>();
  rows = input<PinnedBy[]>([]);
  changed = output<void>();
  busy = signal(false);
  said = signal('');
  behind = computed(() => this.rows().filter(p => p.behind));
  latest = computed(() => this.rows()[0]?.latest ?? null);

  updateAll() {
    this.busy.set(true);
    this.cat.updatePins(this.kind(), this.id()).subscribe({
      next: r => {
        this.busy.set(false);
        this.said.set(`${r.updated.length} moved to v${this.latest()} - rebuilding`);
        this.changed.emit();
      },
      error: e => { this.busy.set(false); this.said.set(e.error?.detail ?? 'not updated'); },
    });
  }
}

/** The open model as a component: what it uses (and whether its last
 *  build had their latest), which version of each - the latest, or one
 *  pinned (Fusion's "break link") - who uses it and who pins it, and a
 *  rebuild a change elsewhere set off - or the error it ran into. */
@Component({
  selector: 'app-links-card',
  imports: [PinIcon, PinnedByList],
  template: `
@if (data(); as d) {
  @if (d.uses.length || d.used_by.length || d.link || d.cycles.length || d.pinned_by?.length) {
  <div class="tcv-card pointer-events-auto max-w-[calc(100vw-2rem)] overflow-hidden p-0 text-[11px]"
       style="box-shadow: 0 6px 20px var(--shadow-soft)" [style.width]="open() ? '22rem' : null">
    <!-- The same head as the PCB room's 3D component card: fold, name, version, state. -->
    <div class="flex items-center gap-2 px-2 py-1" [style.border-bottom]="open() ? '1px solid var(--line)' : null">
      <button class="tcv-pcb-fold" (click)="toggleCard()" [attr.aria-expanded]="open()"
              [title]="open() ? 'Fold the links card' : 'Show the links card'">
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" [style.transform]="open() ? 'rotate(90deg)' : null">
          <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6"
                stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span class="tcv-label">Links</span>
      </button>
      <span class="font-mono text-[10px]" style="color: var(--ink-dim)">v{{ d.version }}</span>
      @if (pinCount(); as n) {
        <span class="flex items-center gap-0.5 text-[10px]" style="color: var(--ink-dim)"
              [title]="n + ' component' + (n > 1 ? 's' : '') + ' used at a fixed version'">
          <app-pin-icon />{{ n }}</span>
      }
      @if (updating()) {
        <span class="ml-auto truncate" style="color: var(--accent)">updating…</span>
      } @else if (broken()) {
        <span class="ml-auto truncate" style="color: var(--danger)">{{ d.link?.state === 'cycle' ? 'cycle' : 'broke' }}</span>
      } @else if (d.built.hash && !d.built.current) {
        <span class="ml-auto truncate" style="color: var(--warn)">out of date</span>
      }
    </div>
    @if (d.link; as l) {
      @if (l.state === 'queued' || l.state === 'building') {
        <p class="px-2 pt-1.5 leading-snug" style="color: var(--accent)">
          {{ l.state === 'building' ? 'Rebuilding' : 'Updating' }} because
          <b>{{ l.because?.title }}</b>@if (l.because?.version) { v{{ l.because?.version }} }
          {{ l.because?.pin === 'pinned' ? 'was pinned' : l.because?.pin === 'follow' ? 'follows its latest again' : 'changed' }}
        </p>
      } @else if (l.state === 'failed' || l.state === 'blocked' || l.state === 'cycle') {
        <p class="px-2 pt-1.5 leading-snug" style="color: var(--danger)">
          @if (l.state === 'cycle') { Not built: } @else { Broke when <b>{{ l.because?.title }}</b>
            @if (l.because?.version) { v{{ l.because?.version }} } changed: }
        </p>
        <!-- The last line is the error; the lines above it are where. -->
        <p class="mx-2 mt-1 break-words font-mono text-[10px]" style="color: var(--ink)">{{ lastLine(l.error) }}</p>
        @if (open() && (l.error ?? '').includes('\n')) {
          <pre class="mx-2 mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded p-1 font-mono text-[10px]"
               style="background: var(--surface-2); color: var(--ink-dim)">{{ l.error }}</pre>
        }
      } @else if (l.state === 'done' && open()) {
        <p class="px-2 pt-1.5 leading-snug" style="color: var(--ink-dim)">
          Rebuilt on its own when {{ l.because?.title }}@if (l.because?.version) { v{{ l.because?.version }} }
          {{ l.because?.pin === 'pinned' ? 'was pinned' : l.because?.pin === 'follow' ? 'was followed again' : 'changed' }}
        </p>
      }
    }
    @if (open()) {
      <div class="px-2 py-1.5">
        <div class="tcv-label mb-0.5">uses</div>
        @for (u of d.uses; track u.kind + u.id) {
          <div class="flex items-center gap-1 py-px">
            <span class="min-w-0 truncate" [title]="u.id">{{ u.title }}</span>
            <span class="tcv-ext shrink-0">{{ u.kind === 'board' ? '.pcb' : '.3d' }}</span>
            <!-- The version it is used at: a menu - follow the latest, or pin one. -->
            <button class="tcv-chip ml-auto flex shrink-0 items-center gap-1 px-1.5 py-0 font-mono text-[10px]"
                    [class.tcv-chip-accent]="u.pinned != null" [disabled]="!canEdit() || busy()"
                    [attr.aria-expanded]="menu() === key(u)" (click)="toggle(u)"
                    [title]="u.pinned != null ? 'pinned: later versions of ' + u.title + ' do not reach this model'
                                              : 'follows the latest ' + u.title + ' - pick a version to pin it'">
              @if (u.pinned != null) {
                <app-pin-icon />
                <span>v{{ u.pinned }}</span>
                @if (u.version != null && u.pinned < u.version) { <span style="color: var(--ink-dim)">· latest v{{ u.version }}</span> }
              } @else {
                <span [style.color]="u.built_against != null && u.built_against !== u.version ? 'var(--warn)' : null">
                  latest v{{ u.version }}@if (u.built_against != null && u.built_against !== u.version) { · built v{{ u.built_against }} }
                </span>
              }
              <span style="color: var(--ink-dim)">▾</span>
            </button>
          </div>
          @if (u.pinned != null && u.version != null && u.pinned < u.version && menu() !== key(u)) {
            <div class="mb-0.5 flex items-center gap-1 pl-2 text-[10px]" style="color: var(--ink-dim)">
              <span>pinned to v{{ u.pinned }} · latest v{{ u.version }}</span>
              <button class="tcv-btn ml-auto px-1.5 py-0 text-[10px]" [disabled]="!canEdit() || busy()"
                      (click)="toLatest(u)" [title]="'pin ' + u.title + ' at v' + u.version + ' and rebuild'">Update to latest</button>
            </div>
          }
          @if (menu() === key(u)) {
            <div class="tcv-scroll mb-1 max-h-56 overflow-y-auto rounded py-0.5" role="menu"
                 style="background: var(--surface-2); border: 1px solid var(--line)">
              <button class="tcv-pin-opt" role="menuitemradio" [attr.aria-checked]="u.pinned == null"
                      [attr.data-on]="u.pinned == null ? 1 : null" (click)="choose(u, null)">
                <span class="tcv-pin-mark">{{ u.pinned == null ? '●' : '' }}</span>
                <span class="min-w-0 flex-1">
                  <b>Follow latest</b><span class="font-mono"> · v{{ u.version }}</span>
                  <span class="block" style="color: var(--ink-dim)">every new version rebuilds this model</span>
                </span>
              </button>
              @if (versions(); as vs) {
                @for (v of vs.versions; track v.version) {
                  <button class="tcv-pin-opt" role="menuitemradio" [attr.aria-checked]="u.pinned === v.version"
                          [attr.data-on]="u.pinned === v.version ? 1 : null" (click)="choose(u, v.version)">
                    <span class="tcv-pin-mark">@if (u.pinned === v.version) { <app-pin-icon /> }</span>
                    <span class="min-w-0 flex-1">
                      <span class="font-mono">Pin v{{ v.version }}</span>
                      @if (v.version === vs.latest) { <span style="color: var(--ink-dim)"> (latest)</span> }
                      <span class="float-right font-mono" style="color: var(--ink-dim)">{{ when(v.at) }}</span>
                      <span class="block truncate" style="color: var(--ink-dim)" [title]="v.changes.join('; ')">{{ v.changes.join('; ') }}</span>
                    </span>
                  </button>
                } @empty {
                  <p class="px-2 py-1" style="color: var(--ink-dim)">no kept versions to pin yet - the next change keeps one</p>
                }
              } @else {
                <p class="px-2 py-1" style="color: var(--ink-dim)">reading its versions…</p>
              }
            </div>
          }
        } @empty { <div style="color: var(--ink-dim)">nothing</div> }
        @if (said(); as t) { <div class="text-[10px]" style="color: var(--danger)">{{ t }}</div> }
        <div class="tcv-label mb-0.5 mt-1.5">used by</div>
        @for (u of d.used_by; track u.id) {
          <div class="truncate" [title]="u.id">{{ u.title }}</div>
        } @empty { <div style="color: var(--ink-dim)">nothing</div> }
        @if (d.dependents.length > d.used_by.length) {
          <div class="mt-0.5 text-[10px]" style="color: var(--ink-dim)">
            {{ d.dependents.length }} in all, through them
          </div>
        }
        @if (d.pinned_by?.length) {
          <div class="mt-1.5">
            <app-pinned-by kind="model" [id]="d.id" [rows]="d.pinned_by!" (changed)="reload()" />
          </div>
        }
        @if (d.copied.length) {
          <div class="tcv-label mb-0.5 mt-1.5" style="color: var(--warn)">copied numbers</div>
          @for (c of d.copied; track c.line + '' + c.value) {
            <div class="truncate font-mono text-[10px]" [title]="c.text">
              line {{ c.line }}: {{ c.value }} is {{ c.names.join(' / ') }}
            </div>
          }
        }
      </div>
    }
  </div>
  }
}`,
})
export class LinksCard {
  private cat = inject(Catalog);
  private auth = inject(Auth);
  id = input.required<string>();
  /** Changes when the model or its link state does: read again then. */
  stamp = input('');
  /** A pin moved: the catalog's badges are worth reading again. */
  pinned = output<void>();
  data = signal<ModelLinks | null>(null);
  /** Open or folded, remembered in this browser. */
  open = signal(LinksCard.recallOpen());
  private static recallOpen(): boolean {
    try { return localStorage.getItem('redline.links.card') !== 'folded'; } catch { return true; }
  }
  toggleCard() {
    this.open.update(v => !v);
    try { localStorage.setItem('redline.links.card', this.open() ? 'open' : 'folded'); } catch { /* private window */ }
  }
  /** The use whose version menu is open, as kind:id. */
  menu = signal<string | null>(null);
  versions = signal<ComponentVersions | null>(null);
  busy = signal(false);
  said = signal('');
  canEdit = () => this.auth.can('edit');
  updating = computed(() => ['queued', 'building'].includes(this.data()?.link?.state ?? ''));
  pinCount = computed(() => Object.keys(this.data()?.pins ?? {}).length);
  lastLine(text: string | undefined): string {
    const lines = (text ?? '').trim().split('\n').filter(x => x.trim());
    return lines[lines.length - 1] ?? '';
  }
  broken = computed(() => ['failed', 'blocked', 'cycle'].includes(this.data()?.link?.state ?? ''));

  key(u: ComponentUse) { return `${u.kind}:${u.id}`; }
  when(at: string | null): string { return (at ?? '').slice(0, 16).replace('T', ' '); }

  constructor() {
    effect(() => {
      const id = this.id();
      this.stamp();
      if (!id) { untracked(() => this.data.set(null)); return; }
      untracked(() => this.reload());
    });
  }

  reload() {
    const id = this.id();
    this.cat.links(id).subscribe({
      next: d => { if (this.id() === id) this.data.set(d); },
      error: () => this.data.set(null),
    });
  }

  toggle(u: ComponentUse) {
    const k = this.key(u);
    if (this.menu() === k) { this.menu.set(null); return; }
    this.menu.set(k);
    this.versions.set(null);
    this.cat.componentVersions(u.kind, u.id).subscribe({
      next: v => { if (this.menu() === k) this.versions.set(v); },
      error: () => this.versions.set({ kind: u.kind, id: u.id, latest: u.version ?? null, versions: [], pinned_by: [] }),
    });
  }

  /** Follow the latest (null) or pin a kept version; the server rebuilds. */
  choose(u: ComponentUse, version: number | null) {
    this.menu.set(null);
    if ((u.pinned ?? null) === version) return;
    this.pin(u, version);
  }

  /** Pinned and behind: pinned again at the latest. If the latest is not
   *  kept (a model saved before versions were), it is followed instead. */
  toLatest(u: ComponentUse) {
    this.pin(u, u.version ?? null, true);
  }

  private pin(u: ComponentUse, version: number | null, orFollow = false) {
    this.busy.set(true);
    this.said.set('');
    this.cat.pin(this.id(), this.key(u), version).subscribe({
      next: () => { this.busy.set(false); this.reload(); this.pinned.emit(); },
      error: e => {
        if (orFollow && e.status === 404 && version != null) { this.pin(u, null); return; }
        this.busy.set(false);
        this.said.set(e.error?.detail ?? 'not pinned');
      },
    });
  }
}
