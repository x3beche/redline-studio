import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { Catalog, ComponentRow, ModelLinks } from '../api';

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

/** The open model as a component: what it uses (and whether its last
 *  build had their latest), who uses it, and a rebuild a change elsewhere
 *  set off - or the error it ran into. */
@Component({
  selector: 'app-links-card',
  template: `
@if (data(); as d) {
  @if (d.uses.length || d.used_by.length || d.link || d.cycles.length) {
  <div class="tcv-card pointer-events-auto w-72 overflow-hidden p-0 text-[11px]"
       style="box-shadow: 0 6px 20px var(--shadow-soft)">
    <button class="flex w-full items-center gap-1.5 px-2 py-1 text-left"
            style="background: var(--surface); border-bottom: 1px solid var(--line)" (click)="open.set(!open())">
      <span style="color: var(--ink-dim)">{{ open() ? '▾' : '▸' }}</span>
      <span class="tcv-label">Links</span>
      <span class="font-mono text-[10px]" style="color: var(--ink-dim)">v{{ d.version }}</span>
      @if (updating()) {
        <span class="ml-auto truncate" style="color: var(--accent)">updating…</span>
      } @else if (broken()) {
        <span class="ml-auto truncate" style="color: var(--danger)">{{ d.link?.state === 'cycle' ? 'cycle' : 'broke' }}</span>
      } @else if (d.built.hash && !d.built.current) {
        <span class="ml-auto truncate" style="color: var(--warn)">out of date</span>
      }
    </button>
    @if (d.link; as l) {
      @if (l.state === 'queued' || l.state === 'building') {
        <p class="px-2 pt-1.5 leading-snug" style="color: var(--accent)">
          {{ l.state === 'building' ? 'Rebuilding' : 'Updating' }} because
          <b>{{ l.because?.title }}</b>@if (l.because?.version) { v{{ l.because?.version }} } changed
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
          Rebuilt on its own when {{ l.because?.title }}@if (l.because?.version) { v{{ l.because?.version }} } changed
        </p>
      }
    }
    @if (open()) {
      <div class="px-2 py-1.5">
        <div class="tcv-label mb-0.5">uses</div>
        @for (u of d.uses; track u.kind + u.id) {
          <div class="flex items-baseline gap-1">
            <span class="min-w-0 truncate" [title]="u.id">{{ u.title }}</span>
            <span class="tcv-ext shrink-0">{{ u.kind === 'board' ? '.pcb' : '.3d' }}</span>
            <span class="ml-auto shrink-0 font-mono text-[10px]"
                  [style.color]="u.built_against != null && u.built_against !== u.version ? 'var(--warn)' : 'var(--ink-dim)'"
                  [title]="u.built_against != null ? 'built against v' + u.built_against + ', latest v' + u.version : 'not built against it yet'">
              @if (u.pinned != null) { pinned v{{ u.pinned }} }
              @else if (u.built_against != null) { built against v{{ u.built_against }}@if (u.built_against !== u.version) { · now v{{ u.version }} } }
              @else { v{{ u.version }} }
            </span>
          </div>
        } @empty { <div style="color: var(--ink-dim)">nothing</div> }
        <div class="tcv-label mb-0.5 mt-1.5">used by</div>
        @for (u of d.used_by; track u.id) {
          <div class="truncate" [title]="u.id">{{ u.title }}</div>
        } @empty { <div style="color: var(--ink-dim)">nothing</div> }
        @if (d.dependents.length > d.used_by.length) {
          <div class="mt-0.5 text-[10px]" style="color: var(--ink-dim)">
            {{ d.dependents.length }} in all, through them
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
  id = input.required<string>();
  /** Changes when the model or its link state does: read again then. */
  stamp = input('');
  data = signal<ModelLinks | null>(null);
  open = signal(true);
  updating = computed(() => ['queued', 'building'].includes(this.data()?.link?.state ?? ''));
  lastLine(text: string | undefined): string {
    const lines = (text ?? '').trim().split('\n').filter(x => x.trim());
    return lines[lines.length - 1] ?? '';
  }
  broken = computed(() => ['failed', 'blocked', 'cycle'].includes(this.data()?.link?.state ?? ''));

  constructor() {
    effect(() => {
      const id = this.id();
      this.stamp();
      if (!id) { untracked(() => this.data.set(null)); return; }
      untracked(() => this.cat.links(id).subscribe({
        next: d => this.data.set(d), error: () => this.data.set(null),
      }));
    });
  }
}
