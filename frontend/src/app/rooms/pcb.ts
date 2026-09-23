import {
  Component, ElementRef, OnDestroy, effect, inject, signal, viewChild,
} from '@angular/core';
import {
  Activity, BoardCompute, BoardEntry, BoardGraph, BoardLayout, Boards, Health,
  LogLine, SystemInfo,
} from '../api';
import { Selection } from '../selection';
import { Board3d } from './board3d';

/** What a component sits at on the ring, and what a net draws between. */
interface Placed {
  ref: string;
  x: number;
  y: number;
  label: string;
  sub: string;
  where: string | null;
}

/** The board room.
 *
 *  A model builds into geometry and you look at the solid. A board builds
 *  into a netlist and what there is to look at is the circuit: the parts
 *  and what is joined to what. atopile does not place copper - layout
 *  stays KiCad's - so this draws the thing that is actually parametric.
 *
 *  The ring is deliberate. A netlist has no positions in it, and inventing
 *  some with a physics run gives a different picture every time you open
 *  it; a ring is the same picture for the same circuit, and a net is a
 *  chord you can follow.
 */
@Component({
  selector: 'app-room-pcb',
  imports: [Board3d],
  template: `
<div class="tcv-room absolute inset-0 flex min-h-0 flex-col">

  @if (!here()) {
    <p class="p-3 text-[12px]" style="color: var(--ink-dim)">
      Pick a board in the catalog - a <b>.pcb</b> opens here.
    </p>
  } @else {

  <!-- Four panes, all of them at once.
       A board is not one picture with three ways of looking at it: the
       drawing, the circuit and the model are different questions about
       the same thing, and answering one usually means looking at
       another. The switch made that two clicks and a lost position.

       The log under this and the queue beside it are the room's as much
       as the 3D room's - it sits in the viewer's own grid, so both are
       where they always were. -->
  <div class="grid min-h-0 flex-1 gap-2 p-2"
       style="grid-template-columns: 11fr 6fr;
              grid-template-rows: 5fr 4fr 3fr">

    <!-- WHAT IT COST, AND WHAT THE MACHINE IS DOING
         The board's own figures. The catalog's foot and the revision
         cards say the same kind of thing about models; these are about
         this board, so they are counted here. -->
    <section class="tcv-pane" style="grid-column: 2; grid-row: 3">
      <header class="tcv-pane-head">
        <span class="tcv-label">machine</span>
        @if (cost(); as c) {
          <span class="mono ml-auto text-[10px]" style="color: var(--ink-dim)">
            {{ c.total.jobs }} jobs
          </span>
        }
      </header>
      <div class="min-h-0 flex-1 overflow-auto p-2 text-[11px]">
        @if (cost()?.jobs?.length) {
          <div class="mono">
            @for (j of cost()!.jobs.slice(0, 5); track j.at) {
              <div class="flex gap-2 leading-relaxed">
                <span class="w-11 shrink-0"
                      [style.color]="j.rc ? 'var(--danger)' : 'var(--ink)'">
                  {{ j.kind === 'board' ? 'build' : j.kind }}
                </span>
                <span class="shrink-0" style="color: var(--ink-dim)">{{ secs(j.wall_s) }}</span>
                <!-- atopile runs here and is measured here; KiCad runs in
                     a container whose time is nobody's child, so a
                     placement reports the clock and nothing else. -->
                <span class="ml-auto shrink-0 truncate" style="color: var(--ink-dim)">
                  {{ j.kind === 'layout' ? 'in a container' : cores(j.cpu_s) }}
                </span>
              </div>
            }
          </div>
        } @else {
          <div style="color: var(--ink-dim)">nothing built yet</div>
        }

        <!-- What is stored, which is the other half of what it cost. -->
        @if (artifacts().length) {
          <div class="mono mt-2 pt-2" style="border-top: 1px solid var(--line)">
            @for (a of artifacts(); track a.name) {
              <div class="flex justify-between leading-relaxed"
                   style="color: var(--ink-dim)">
                <span>{{ a.name }}</span>
                <span>{{ kb(a.bytes) }}</span>
              </div>
            }
          </div>
        }

        @if (sys()) {
          <div class="mt-2 pt-2" style="border-top: 1px solid var(--line)">
            @for (g of gauges(); track g.key) {
              <div class="mb-1.5">
                <div class="flex justify-between leading-tight">
                  <span class="truncate" [title]="g.tip">{{ g.key }}</span>
                  <span class="mono shrink-0" style="color: var(--ink-dim)">{{ g.read }}</span>
                </div>
                <div class="mt-0.5 h-[3px] overflow-hidden rounded"
                     style="background: var(--line)">
                  <div class="h-full rounded transition-[width] duration-500"
                       [style.width.%]="g.pct" style="background: var(--accent)"></div>
                </div>
              </div>
            }
          </div>
        }
      </div>
    </section>

    <!-- THE LOG
         Its own, not the 3D room's: the lines a board writes are about
         this board, and a build that happened while you were looking at
         something else is exactly what you want to read here. -->
    <section class="tcv-pane" style="grid-column: 1; grid-row: 3">
      <header class="tcv-pane-head">
        <span class="tcv-label">log</span>
        <span class="mono ml-auto text-[10px]" style="color: var(--ink-dim)">
          {{ log().length }} lines
        </span>
      </header>
      <div #logBox class="tcv-scroll mono min-h-0 flex-1 overflow-y-auto px-2 py-1 text-[11px]">
        @for (l of log(); track l._id) {
          <div class="flex gap-2 leading-snug">
            <span class="shrink-0" style="color: var(--line)">{{ l.at.slice(11, 19) }}</span>
            <span [style.color]="levelColor(l.level)">{{ l.text }}</span>
          </div>
        } @empty {
          <div style="color: var(--ink-dim)">no activity yet</div>
        }
      </div>
    </section>

    <!-- LAYOUT -->
    <section class="tcv-pane" style="grid-column: 1; grid-row: 1 / span 2">
      <!-- The two things you can do to a board live over the drawing they
           change, not in a bar of their own across the top. -->
      <header class="tcv-pane-head">
        <span class="tcv-label">layout</span>
        @if (hasLayout()) {
          <span class="mono text-[10px]" style="color: var(--ink-dim)">
            {{ here()?.layout?.placed }} placed
            @if (here()?.layout?.size_mm; as mm) { · {{ mm[0] }} × {{ mm[1] }} mm }
            · not routed
          </span>
        }
        <div class="ml-auto flex shrink-0 items-center gap-1">
          @if (note(); as n) {
            <span class="mono mr-1 max-w-[16rem] truncate text-[10px]"
                  style="color: var(--warn)" [title]="n">{{ n }}</span>
          }
          <button (click)="rebuild()" [disabled]="busy()"
                  class="tcv-btn tcv-btn-accent px-2 py-0.5">
            {{ busy() ? 'building…' : 'build' }}
          </button>
          <button (click)="relayout()" [disabled]="busy() || !here()?.ready"
                  class="tcv-btn px-2 py-0.5"
                  title="place it and draw it - KiCad, in a container">
            {{ laying() ? 'placing…' : 'lay out' }}
          </button>
        </div>
      </header>
      @if (hasLayout()) {
        <!-- The sheet is the drawing, not the pane: a board is wider than
             it is tall, and stretching the element to the pane put it in
             the middle of a white block four times its height. -->
        <div class="flex min-h-0 flex-1 items-center justify-center p-2">
          <div class="w-full rounded" style="background: var(--shot-bg);
                      padding: 10px; max-height: 100%"
               [style.aspect-ratio]="sheet()">
            <img [src]="layoutUrl()" alt="board layout"
                 class="h-full w-full" style="object-fit: contain">
          </div>
        </div>
        @if (trouble().length) {
          <div class="shrink-0 px-2 pb-1.5 text-[11px]" style="color: var(--warn)">
            @for (m of trouble(); track m) { <div class="truncate" [title]="m">{{ m }}</div> }
          </div>
        }
      } @else {
        <p class="p-2 text-[12px]" style="color: var(--ink-dim)">
          {{ here()?.ready
             ? 'Built, but not placed yet. lay out fetches each part from LCSC, places them and draws the board.'
             : 'Not built yet. Press build and atopile will say what it makes of it.' }}
        </p>
      }
    </section>

    <!-- CIRCUIT -->
    <section class="tcv-pane" style="grid-column: 2; grid-row: 1">
      <header class="tcv-pane-head">
        <span class="tcv-label">circuit</span>
        <!-- What the board is made of, where the list of it used to be:
             the ring says which parts, so the count belongs on it. -->
        @if (graph(); as g) {
          <span class="mono ml-auto text-[10px]" style="color: var(--ink-dim)">
            {{ g.counts.components }} parts · {{ g.counts.nets }} nets ·
            {{ g.counts.joins }} joins
          </span>
        }
      </header>
      <div class="min-h-0 flex-1 p-1">
        @if (graph()) {
          <svg [attr.viewBox]="'0 0 ' + SIZE + ' ' + SIZE"
               class="h-full w-full" preserveAspectRatio="xMidYMid meet">
            <!-- nets first: a chord between two parts, a star through the
                 middle when more than two sit on it -->
            @for (l of links(); track l.key) {
              <path [attr.d]="l.d" fill="none" stroke="var(--line)"
                    stroke-width="1.4" />
            }
            @for (l of netLabels(); track l.key) {
              <text [attr.x]="l.x" [attr.y]="l.y" text-anchor="middle"
                    font-size="9" fill="var(--ink-dim)">{{ l.name }}</text>
            }
            @for (p of placed(); track p.ref) {
              <g [attr.transform]="'translate(' + p.x + ',' + p.y + ')'">
                <rect x="-34" y="-15" width="68" height="30" rx="4"
                      fill="var(--surface-2)" stroke="var(--accent)"
                      stroke-width="1.2" />
                <text y="-2" text-anchor="middle" font-size="11"
                      fill="var(--ink)">{{ p.label }}</text>
                <text y="9" text-anchor="middle" font-size="8"
                      fill="var(--ink-dim)">{{ p.sub }}</text>
                <title>{{ p.where }}</title>
              </g>
            }
          </svg>
        } @else {
          <p class="p-2 text-[12px]" style="color: var(--ink-dim)">
            The circuit comes out of the build.
          </p>
        }
      </div>
    </section>

    <!-- THE BOARD, IN THREE DIMENSIONS -->
    <section class="tcv-pane" style="grid-column: 2; grid-row: 2">
      <header class="tcv-pane-head">
        <span class="tcv-label">3d</span>
        <span class="mono ml-auto text-[10px]" style="color: var(--ink-dim)">
          drag to turn it over
        </span>
      </header>
      @if (has3d()) {
        <!-- Fetched when the pane is on screen. three.js and a glTF
             loader are a third of a megabyte, and they are no use in any
             other room. -->
        <div class="min-h-0 flex-1 overflow-hidden"
             style="background: var(--surface-2)">
          @defer (on viewport) {
            <app-board-3d [src]="modelUrl()" />
          } @placeholder {
            <p class="p-3 text-[12px]" style="color: var(--ink-dim)">
              bringing the viewer in…
            </p>
          }
        </div>
      } @else {
        <p class="p-2 text-[12px]" style="color: var(--ink-dim)">
          No model yet. <b>lay out</b> makes one alongside the drawing.
        </p>
      }
    </section>

  </div>
  }
</div>`,
})
export class RoomPcb implements OnDestroy {
  private api = inject(Boards);
  private picked = inject(Selection);
  private health = inject(Health);
  private activity = inject(Activity);
  private logBox = viewChild<ElementRef<HTMLDivElement>>('logBox');

  readonly SIZE = 520;
  boards = signal<BoardEntry[]>([]);
  here = signal<BoardEntry | null>(null);
  graph = signal<BoardGraph | null>(null);
  busy = signal(false);
  laying = signal(false);
  note = signal('');
  lastLayout = signal<BoardLayout | null>(null);
  cost = signal<BoardCompute | null>(null);
  sys = signal<SystemInfo | null>(null);
  log = signal<LogLine[]>([]);
  private timers: ReturnType<typeof setInterval>[] = [];

  constructor() {
    this.refresh();
    this.tick();
    // The room is only mounted while its tab is on, so this stops when
    // somebody leaves rather than polling behind another room.
    this.timers.push(setInterval(() => this.tick(), 3000));
    // Opened from the catalog: the tree is shared, so the room follows
    // what was clicked rather than keeping a list beside it.
    effect(() => {
      const want = this.picked.board();
      if (!want || this.here()?._id === want) return;
      const found = this.boards().find(b => b._id === want);
      if (found) this.open(found);
      else this.refresh();
    });
  }

  ngOnDestroy() {
    for (const id of this.timers) clearInterval(id);
  }

  /** The live half: what the machine is doing, and what has happened. */
  private tick() {
    this.health.system().subscribe({ next: s => this.sys.set(s) });
    this.activity.lines(60).subscribe({
      next: rows => {
        const last = this.log()[this.log().length - 1]?._id;
        this.log.set(rows);
        if (rows[rows.length - 1]?._id !== last) {
          setTimeout(() => this.scrollLog(), 30);
        }
      },
    });
  }

  private scrollLog() {
    const box = this.logBox()?.nativeElement;
    if (box) box.scrollTop = box.scrollHeight;
  }

  /** The three live readings, drawn the way the catalog's foot draws
   *  them. Its own copy: this one is beside a board, and the one down
   *  there is beside the models. */
  gauges(): { key: string; pct: number; read: string; tip: string }[] {
    const m = this.sys();
    if (!m) return [];
    const out = [
      { key: 'cpu', pct: m.cpu.load,
        read: `${m.cpu.load.toFixed(0)}% · ${m.cpu.cores}c/${m.cpu.threads}t`,
        tip: m.cpu.name },
      { key: 'ram', pct: 100 * m.ram.used_bytes / (m.ram.total_bytes || 1),
        read: `${this.gb(m.ram.used_bytes)} / ${this.gb(m.ram.total_bytes)}`,
        tip: 'memory in use' },
    ];
    if (m.gpu) {
      out.push({ key: 'gpu', pct: m.gpu.util,
                 read: `${m.gpu.util.toFixed(0)}% · ${m.gpu.temp_c.toFixed(0)}°`,
                 tip: m.gpu.name });
    }
    return out;
  }

  gb(bytes: number): string { return (bytes / 1e9).toFixed(1) + ' GB'; }

  levelColor(l: LogLine['level']): string {
    return l === 'error' ? 'var(--danger)'
      : l === 'warn' ? 'var(--warn)'
      : l === 'done' ? 'var(--ok)'
      : l === 'work' ? 'var(--accent)' : 'var(--ink-dim)';
  }

  refresh() {
    this.api.list().subscribe({
      next: rows => {
        this.boards.set(rows);
        const want = this.picked.board() ?? this.here()?._id;
        const keep = want ? rows.find(b => b._id === want) : null;
        this.open(keep ?? rows.find(b => b.ready) ?? rows[0] ?? null);
      },
      error: () => this.note.set('could not read the boards'),
    });
  }

  open(b: BoardEntry | null) {
    this.here.set(b);
    this.graph.set(null);
    this.cost.set(null);
    if (!b) return;
    this.api.compute(b._id).subscribe({ next: c => this.cost.set(c) });
    if (!b.ready) return;
    // The artifact is immutable and served that way, so the build time is
    // what tells the browser to fetch a new one.
    this.api.graph(b._id, b.artifacts?.['graph']?.at).subscribe({
      next: g => this.graph.set(g),
      error: () => this.note.set('the build output could not be read'),
    });
  }

  /** Everything the placement could not do, in one list. */
  trouble(): string[] {
    return [
      ...(this.here()?.layout?.missing ?? []).map(m => `no footprint for ${m}`),
      ...(this.lastLayout()?.part_trouble ?? []),
    ];
  }

  /** What is stored for this board, which is the other half of what it
   *  cost: a netlist is kilobytes, a model with parts on it is not. */
  artifacts(): { name: string; bytes: number }[] {
    const a = this.here()?.artifacts ?? {};
    const named: Record<string, string> = {
      graph: 'netlist', footprints: 'footprints',
      layout: 'drawing', model3d: 'model',
    };
    return Object.entries(named)
      .filter(([key]) => a[key])
      .map(([key, name]) => ({ name, bytes: a[key].bytes ?? 0 }));
  }

  /** The drawing's own shape, so the sheet is the board and not a white
   *  block around it. The exporter writes the board area as the page. */
  sheet(): string {
    const mm = this.here()?.layout?.size_mm;
    return mm && mm[1] ? `${mm[0]} / ${mm[1]}` : '3 / 2';
  }

  kb(bytes: number): string {
    return bytes >= 1e6 ? (bytes / 1e6).toFixed(1) + ' MB'
                        : Math.round(bytes / 1000) + ' kB';
  }

  secs(s?: number): string {
    if (!s) return '–';
    return s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
                   : `${s.toFixed(1)} s`;
  }

  cores(s?: number): string { return s ? `${s.toFixed(1)} core-s` : '–'; }

  hasLayout(): boolean {
    return !!this.here()?.layout?.at;
  }

  /** The build time stamps the URL: the file is served immutable, so
   *  without it the browser keeps showing the board from last time. */
  layoutUrl(): string {
    const b = this.here();
    return `/api/boards/${b?._id}/layout.svg?v=`
      + encodeURIComponent(b?.layout?.at ?? '');
  }

  has3d(): boolean {
    return !!this.here()?.artifacts?.['model3d'];
  }

  modelUrl(): string {
    const b = this.here();
    return `/api/boards/${b?._id}/board.glb?v=`
      + encodeURIComponent(b?.artifacts?.['model3d']?.at ?? '');
  }

  relayout() {
    const b = this.here();
    if (!b || this.laying()) return;
    this.laying.set(true);
    this.note.set('');
    this.api.layout(b._id).subscribe({
      next: r => {
        this.laying.set(false);
        this.lastLayout.set(r);
        this.refresh();
      },
      error: e => {
        this.laying.set(false);
        this.note.set(String(e?.error?.detail ?? e?.message ?? e).slice(0, 400));
      },
    });
  }

  rebuild() {
    const b = this.here();
    if (!b || this.busy()) return;
    this.busy.set(true);
    this.note.set('');
    this.api.build(b._id).subscribe({
      next: () => { this.busy.set(false); this.refresh(); },
      error: e => {
        this.busy.set(false);
        // atopile's own words: it is better at saying what is wrong with a
        // circuit than anything this could paraphrase.
        this.note.set(String(e?.error?.detail ?? e?.message ?? e).slice(0, 400));
      },
    });
  }

  /** Components on a ring, in the order the netlist lists them. */
  placed(): Placed[] {
    const g = this.graph();
    if (!g) return [];
    const n = g.components.length || 1;
    const r = n <= 2 ? 110 : Math.min(190, 60 + n * 14);
    const mid = this.SIZE / 2;
    return g.components.map((c, i) => {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      return {
        ref: c.ref,
        x: Math.round(mid + Math.cos(a) * r),
        y: Math.round(mid + Math.sin(a) * r),
        label: c.ref,
        sub: (c.footprint ?? '').replace(/^lib:/, '') || (c.part ?? ''),
        where: [c.where, c.part, c.value].filter(Boolean).join(' · '),
      };
    });
  }

  private at(ref: string | null): Placed | undefined {
    return this.placed().find(p => p.ref === ref);
  }

  /** A net with two pins is a chord; with more, a star through its middle,
   *  which is what a shared rail actually is. */
  links(): { key: string; d: string }[] {
    const g = this.graph();
    if (!g) return [];
    const out: { key: string; d: string }[] = [];
    const mid = this.SIZE / 2;
    for (const net of g.nets) {
      const ends = net.nodes.map(nd => this.at(nd.ref)).filter(Boolean) as Placed[];
      if (ends.length === 2) {
        const [a, b] = ends;
        // bowed towards the middle, so two nets between the same pair do
        // not lie on top of each other
        const cx = (a.x + b.x) / 2 * 0.75 + mid * 0.25;
        const cy = (a.y + b.y) / 2 * 0.75 + mid * 0.25;
        out.push({ key: net.code + '-' + net.name,
                   d: `M${a.x},${a.y} Q${cx},${cy} ${b.x},${b.y}` });
      } else if (ends.length > 2) {
        const hx = ends.reduce((s, p) => s + p.x, 0) / ends.length;
        const hy = ends.reduce((s, p) => s + p.y, 0) / ends.length;
        ends.forEach((p, i) => out.push({
          key: net.code + '-' + net.name + '-' + i,
          d: `M${p.x},${p.y} L${Math.round(hx)},${Math.round(hy)}`,
        }));
      }
    }
    return out;
  }

  netLabels(): { key: string; name: string; x: number; y: number }[] {
    const g = this.graph();
    if (!g) return [];
    return g.nets.map(net => {
      const ends = net.nodes.map(nd => this.at(nd.ref)).filter(Boolean) as Placed[];
      if (!ends.length) return null;
      const x = ends.reduce((s, p) => s + p.x, 0) / ends.length;
      const y = ends.reduce((s, p) => s + p.y, 0) / ends.length;
      return { key: net.code + '-' + net.name, name: net.name ?? '',
               x: Math.round(x), y: Math.round(y) - 4 };
    }).filter(Boolean) as { key: string; name: string; x: number; y: number }[];
  }
}
