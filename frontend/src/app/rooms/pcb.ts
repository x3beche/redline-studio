import { Component, inject, output, signal } from '@angular/core';
import { BoardEntry, BoardGraph, BoardLayout, Boards } from '../api';

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
  template: `
<div class="tcv-room absolute inset-0 flex">

  <!-- The boards. The catalog on the far left is the model catalog; this
       room has its own things to list. -->
  <div class="flex w-52 shrink-0 flex-col" style="border-right: 1px solid var(--line)">
    <div class="tcv-label px-2 py-1.5" style="border-bottom: 1px solid var(--line)">
      Boards
    </div>
    <div class="tcv-scroll min-h-0 flex-1 overflow-y-auto p-1.5">
      @for (b of boards(); track b._id) {
        <button (click)="open(b)" class="tcv-row w-full text-left"
                [attr.data-on]="here()?._id === b._id ? 1 : null">
          <span class="truncate">{{ b.title || b._id }}</span>
          @if (b.building) {
            <span class="ml-1 text-[10px]" style="color: var(--accent)">building</span>
          } @else if (!b.ready) {
            <span class="ml-1 text-[10px]" style="color: var(--ink-dim)">not built</span>
          } @else if (b.stale) {
            <span class="ml-1 text-[10px]" style="color: var(--warn)">stale</span>
          }
        </button>
      } @empty {
        <p class="px-1 text-[11px]" style="color: var(--ink-dim)">
          No boards yet.
        </p>
      }
    </div>
    <div class="px-2 py-2 text-[11px]" style="border-top: 1px solid var(--line); color: var(--ink-dim)">
      atopile builds the circuit, not the copper. Layout stays KiCad's.
    </div>
  </div>

  <!-- The circuit -->
  <div class="flex min-w-0 flex-1 flex-col">
    <div class="flex items-center gap-2 px-2 py-1.5"
         style="border-bottom: 1px solid var(--line)">
      <span class="brand-name">{{ here()?.title || here()?._id || 'PCB Design' }}</span>
      @if (graph(); as g) {
        <span class="mono text-[11px]" style="color: var(--ink-dim)">
          {{ g.counts.components }} parts · {{ g.counts.nets }} nets ·
          {{ g.counts.joins }} joins
        </span>
      }
      <!-- Two ways of looking at the same board: what it is joined to,
           and where it sits. -->
      <div class="ml-auto flex gap-1">
        <button (click)="view.set('layout')" class="tcv-chip"
                [attr.data-on]="view() === 'layout' ? 1 : null">layout</button>
        <button (click)="view.set('circuit')" class="tcv-chip"
                [attr.data-on]="view() === 'circuit' ? 1 : null">circuit</button>
      </div>
      <button (click)="rebuild()" [disabled]="busy()"
              class="tcv-btn tcv-btn-accent px-2 py-0.5">
        {{ busy() ? 'building…' : 'build' }}
      </button>
      <button (click)="relayout()" [disabled]="busy() || !here()?.ready"
              class="tcv-btn px-2 py-0.5"
              title="place it and draw it - KiCad, in a container">
        {{ laying() ? 'placing…' : 'lay out' }}
      </button>
      <button (click)="leave.emit()" class="tcv-chip">back to 3D</button>
    </div>

    @if (note(); as n) {
      <p class="px-2 py-1.5 text-[11px]" style="color: var(--warn)">{{ n }}</p>
    }

    <div class="min-h-0 flex-1 overflow-auto p-2">
      @if (view() === 'layout') {
        @if (hasLayout()) {
          <!-- The board as KiCad draws it: copper, silkscreen, mask and
               the outline. Placed in a grid and not routed - the source
               says what connects, not where it goes. -->
          <!-- A board is a few centimetres across and the SVG says so, so
               left at its own size it renders as a postage stamp in the
               middle of the pane. It is a drawing: let it fill the room
               it is in. -->
          <img [src]="layoutUrl()" alt="board layout"
               class="mx-auto block max-h-[58vh] w-full rounded"
               style="background: var(--shot-bg); object-fit: contain;
                      padding: 12px">
          <p class="mt-2 text-[11px]" style="color: var(--ink-dim)">
            {{ here()?.layout?.placed }} placed
            @if (here()?.layout?.size_mm; as mm) { · {{ mm[0] }} × {{ mm[1] }} mm }
            @if (lastLayout()?.parts_from_lcsc; as n) { · {{ n }} from LCSC }
            · not routed
          </p>
          @for (m of here()?.layout?.missing ?? []; track m) {
            <p class="text-[11px]" style="color: var(--warn)">
              no footprint for {{ m }}
            </p>
          }
          @for (t of lastLayout()?.part_trouble ?? []; track t) {
            <p class="text-[11px]" style="color: var(--warn)">{{ t }}</p>
          }
        } @else {
          <p class="p-2 text-[12px]" style="color: var(--ink-dim)">
            Built, but not placed yet. <b>lay out</b> fetches each part from
            LCSC, places them and draws the board.
          </p>
        }
      } @else if (graph(); as g) {
        <svg [attr.viewBox]="'0 0 ' + SIZE + ' ' + SIZE"
             class="mx-auto block h-full w-full" style="max-height: 62vh">
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

        <!-- the bill, as it came out of the build -->
        @if (g.bom.length) {
          <div class="mono mt-2 text-[11px]">
            <div class="tcv-label mb-1">Bill of materials</div>
            @for (row of g.bom; track row['designator']) {
              <div class="flex gap-2" style="color: var(--ink-dim)">
                <span class="w-10 shrink-0" style="color: var(--ink)">{{ row['designator'] }}</span>
                <span class="min-w-0 flex-1 truncate">{{ row['footprint'] }}</span>
                <span class="shrink-0">{{ row['lcsc'] }}</span>
              </div>
            }
          </div>
        }
      } @else if (here()) {
        <p class="p-2 text-[12px]" style="color: var(--ink-dim)">
          Not built yet. Press build and atopile will say what it makes of it.
        </p>
      } @else {
        <p class="p-2 text-[12px]" style="color: var(--ink-dim)">
          Pick a board.
        </p>
      }
    </div>
  </div>
</div>`,
})
export class RoomPcb {
  private api = inject(Boards);
  leave = output<void>();

  readonly SIZE = 520;
  boards = signal<BoardEntry[]>([]);
  here = signal<BoardEntry | null>(null);
  graph = signal<BoardGraph | null>(null);
  busy = signal(false);
  laying = signal(false);
  note = signal('');
  view = signal<'layout' | 'circuit'>('layout');
  lastLayout = signal<BoardLayout | null>(null);

  constructor() {
    this.refresh();
  }

  refresh() {
    this.api.list().subscribe({
      next: rows => {
        this.boards.set(rows);
        const keep = this.here() && rows.find(b => b._id === this.here()!._id);
        this.open(keep ?? rows.find(b => b.ready) ?? rows[0] ?? null);
      },
      error: () => this.note.set('could not read the boards'),
    });
  }

  open(b: BoardEntry | null) {
    this.here.set(b);
    this.graph.set(null);
    if (!b?.ready) return;
    // The artifact is immutable and served that way, so the build time is
    // what tells the browser to fetch a new one.
    this.api.graph(b._id, b.artifacts?.['graph']?.at).subscribe({
      next: g => this.graph.set(g),
      error: () => this.note.set('the build output could not be read'),
    });
  }

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

  relayout() {
    const b = this.here();
    if (!b || this.laying()) return;
    this.laying.set(true);
    this.note.set('');
    this.api.layout(b._id).subscribe({
      next: r => {
        this.laying.set(false);
        this.lastLayout.set(r);
        this.view.set('layout');
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
