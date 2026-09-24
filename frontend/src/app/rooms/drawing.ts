import {
  Component, ElementRef, OnDestroy, computed, effect, input, signal, viewChild,
} from '@angular/core';
import { BoardGeometry } from '../api';
import { capture } from './sketchpad';

type Geo = BoardGeometry;
/** What is under the mouse: one track, via or pad. */
export type Hit =
  | { kind: 'track'; net: string; item: Geo['tracks'][number] }
  | { kind: 'via'; net: string; item: Geo['vias'][number] }
  | { kind: 'pad'; net: string; item: Geo['pads'][number] };

/** A drawing you can move around in: a schematic, a board's copper.
 *
 *  KiCad's SVGs are drawn to scale - a 253 mm sheet, a 50 mm board - and
 *  at the size of a pane they are too small to read a pin name on. So
 *  this fits the drawing to the pane, and then the wheel zooms about the
 *  cursor, a drag moves it, and a double click fits it again.
 *
 *  Zooming sets the image's size rather than scaling it: an <img> scaled
 *  by a transform is a picture of the SVG blown up and goes soft, where
 *  one given a new size is drawn again at that size and stays sharp.
 */
@Component({
  selector: 'app-drawing',
  template: `
<div #box class="relative h-full w-full overflow-hidden rounded select-none"
     style="background: var(--pcb-bg); cursor: grab; touch-action: none"
     (wheel)="wheel($event)" (pointerdown)="down($event)"
     (pointermove)="move($event)" (pointerup)="up($event)"
     (pointercancel)="up($event)" (pointerleave)="hover.set(null)"
     (click)="pin()" (dblclick)="fit()">
  <img #img [src]="src()" alt="" draggable="false" (load)="loaded()"
       class="absolute max-w-none" style="left: 0; top: 0"
       [style.width.px]="w()" [style.height.px]="h()"
       [style.transform]="'translate(' + x() + 'px,' + y() + 'px)'">
  <!-- Inspect: with the board's geometry, what is under the mouse and
       the rest of its net are drawn over the picture, the way a PCB
       editor highlights a net. Nothing here takes the mouse: dragging
       still moves the drawing. -->
  @if (geometry(); as g) {
    @if (lit().length) {
      <svg class="pointer-events-none absolute" style="left: 0; top: 0; overflow: visible"
           [attr.width]="w()" [attr.height]="h()"
           [style.transform]="'translate(' + x() + 'px,' + y() + 'px)'"
           [attr.viewBox]="g.box.join(' ')" preserveAspectRatio="none">
        @if (pinned()) {
          <!-- A net held: the rest of the board goes dim under it, as in a
               PCB editor's net highlight. -->
          <rect [attr.x]="g.box[0]" [attr.y]="g.box[1]" [attr.width]="g.box[2]" [attr.height]="g.box[3]"
                class="tcv-inspect-dim" />
        }
        <g [attr.transform]="mirror() ? 'translate(' + (2 * g.box[0] + g.box[2]) + ' 0) scale(-1 1)' : null">
          @for (t of litTracks(); track $index) {
            <line [attr.x1]="t.x1" [attr.y1]="t.y1" [attr.x2]="t.x2" [attr.y2]="t.y2"
                  [attr.stroke-width]="t.w" class="tcv-inspect-copper" [class.tcv-inspect-held]="pinned()"
                  stroke-linecap="round" />
          }
          @for (p of litPads(); track $index) {
            <rect [attr.x]="p.x - p.w / 2" [attr.y]="p.y - p.h / 2" [attr.width]="p.w" [attr.height]="p.h"
                  [attr.rx]="p.shape === 'rect' ? 0 : p.shape === 'roundrect' ? Math.min(p.w, p.h) * 0.25 : Math.min(p.w, p.h) / 2"
                  [attr.transform]="'rotate(' + (-p.angle) + ' ' + p.x + ' ' + p.y + ')'"
                  class="tcv-inspect-copper" [class.tcv-inspect-held]="pinned()" />
          }
          @for (v of litVias(); track $index) {
            <circle [attr.cx]="v.x" [attr.cy]="v.y" [attr.r]="v.d / 2" class="tcv-inspect-copper"
                    [class.tcv-inspect-held]="pinned()" />
          }
          @if (hover(); as hv) {
            @switch (hv.kind) {
              @case ('track') {
                <line [attr.x1]="hv.item.x1" [attr.y1]="hv.item.y1" [attr.x2]="hv.item.x2" [attr.y2]="hv.item.y2"
                      [attr.stroke-width]="hv.item.w" class="tcv-inspect-hover" stroke-linecap="round" />
              }
              @case ('via') {
                <circle [attr.cx]="hv.item.x" [attr.cy]="hv.item.y" [attr.r]="hv.item.d / 2" class="tcv-inspect-hover" />
              }
              @case ('pad') {
                <rect [attr.x]="hv.item.x - hv.item.w / 2" [attr.y]="hv.item.y - hv.item.h / 2"
                      [attr.width]="hv.item.w" [attr.height]="hv.item.h"
                      [attr.transform]="'rotate(' + (-hv.item.angle) + ' ' + hv.item.x + ' ' + hv.item.y + ')'"
                      class="tcv-inspect-hover" />
              }
            }
          }
        </g>
      </svg>
    }
    @if (hover(); as hv) {
      <div class="tcv-inspect-tip mono" [style.left.px]="tipAt().x" [style.top.px]="tipAt().y">
        @for (line of describe(hv); track $index) {
          <div [class.tcv-inspect-head]="$first">{{ line }}</div>
        }
      </div>
    }
    @if (pinned(); as net) {
      <button class="tcv-chip absolute left-1.5 top-1.5 px-1.5 py-0" (click)="pinned.set(null); $event.stopPropagation()"
              (pointerdown)="$event.stopPropagation()" title="let the net go (Esc)">
        net {{ net }} · {{ netStats().tracks }} tracks · {{ netStats().mm }} mm · {{ netStats().pads }} pads ×
      </button>
    }
  }
  @if (!ready()) {
    <p class="absolute inset-x-0 top-2 text-center text-[11px]"
       style="color: var(--ink-dim)">drawing…</p>
  }
  <!-- Whatever the pane puts here - a view switch, a file to download -
       sits on the drawing it is about, not in a header it crowds. -->
  <div class="absolute bottom-1.5 left-1.5 flex gap-1" (pointerdown)="$event.stopPropagation()">
    <ng-content></ng-content>
  </div>
  @if (controls()) {
  <div class="absolute bottom-1.5 right-1.5 flex gap-1">
    <button (click)="step(1.25)" class="tcv-chip px-1.5 py-0" title="closer">+</button>
    <button (click)="step(0.8)" class="tcv-chip px-1.5 py-0" title="further">–</button>
    <button (click)="fit()" class="tcv-chip px-1.5 py-0"
            title="all of it (or double-click)">fit</button>
  </div>
  }
</div>`,
})
export class Drawing implements OnDestroy {
  src = input.required<string>();
  /** Its own zoom buttons - off where the room's toolbar has them. */
  controls = input(true);
  /** The board as data, to look into with the mouse; and whether the
   *  drawing is the board seen from below, mirrored left to right. */
  geometry = input<BoardGeometry | null>(null);
  mirror = input(false);
  /** Which copper can be picked: the side on show, or both. */
  side = input<'F' | 'B' | 'all'>('all');

  readonly Math = Math;
  hover = signal<Hit | null>(null);
  pinned = signal<string | null>(null);
  private mouse = signal({ x: 0, y: 0 });

  /** The net lit up: the one clicked, or else the one under the mouse. */
  private litNet = computed(() => this.pinned() ?? this.hover()?.net ?? null);
  litTracks = computed(() => this.onNet(this.geometry()?.tracks));
  litVias = computed(() => this.onNet(this.geometry()?.vias));
  litPads = computed(() => this.onNet(this.geometry()?.pads));
  lit = computed(() => this.litNet() ? [1] : []);
  netStats = computed(() => {
    const t = this.litTracks();
    const mm = t.reduce((sum, s) => sum + Math.hypot(s.x2 - s.x1, s.y2 - s.y1), 0);
    return { tracks: t.length, mm: mm.toFixed(1), pads: this.litPads().length };
  });
  tipAt = computed(() => {
    const b = this.box().nativeElement;
    const m = this.mouse();
    // Kept inside the box: flipped to the cursor's other side near an edge.
    const x = m.x + 14 + 260 > b.clientWidth ? m.x - 14 - 260 : m.x + 14;
    const y = m.y + 14 + 80 > b.clientHeight ? m.y - 14 - 80 : m.y + 14;
    return { x: Math.max(4, x), y: Math.max(4, y) };
  });

  private box = viewChild.required<ElementRef<HTMLDivElement>>('box');
  /** The drawing's box, for a room laying several shots into one. */
  host(): ElementRef<HTMLElement> { return this.box(); }
  private img = viewChild.required<ElementRef<HTMLImageElement>>('img');

  ready = signal(false);
  w = signal(0);
  h = signal(0);
  x = signal(0);
  y = signal(0);

  private natural = { w: 1, h: 1 };
  private moved = false;
  private drag: { id: number; x: number; y: number } | null = null;
  private ro?: ResizeObserver;
  private fitted = true;

  constructor() {
    // A new drawing - another board, a fresh route - starts fitted again.
    effect(() => { this.src(); this.ready.set(false); this.fitted = true; });
    effect(() => { this.geometry(); this.hover.set(null); this.pinned.set(null); });
    addEventListener('keydown', this.onKey);
  }

  loaded() {
    const im = this.img().nativeElement;
    this.natural = { w: im.naturalWidth || 1, h: im.naturalHeight || 1 };
    this.ready.set(true);
    this.fit();
    if (!this.ro) {
      // Fitted, it stays fitted when the pane changes size; moved by hand,
      // it stays where it was put.
      this.ro = new ResizeObserver(() => { if (this.fitted) this.fit(); });
      this.ro.observe(this.box().nativeElement);
    }
  }

  ngOnDestroy() {
    this.ro?.disconnect();
    removeEventListener('keydown', this.onKey);
  }

  private onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') this.pinned.set(null); };

  fit() {
    const b = this.box().nativeElement;
    const s = Math.min(b.clientWidth / this.natural.w, b.clientHeight / this.natural.h) * 0.96;
    this.w.set(this.natural.w * s);
    this.h.set(this.natural.h * s);
    this.x.set((b.clientWidth - this.w()) / 2);
    this.y.set((b.clientHeight - this.h()) / 2);
    this.fitted = true;
  }

  /** Zoom by `k` about a point in the box - the cursor, or the middle. */
  zoom(k: number, cx?: number, cy?: number) {
    const b = this.box().nativeElement;
    cx ??= b.clientWidth / 2;
    cy ??= b.clientHeight / 2;
    const fitW = this.natural.w * Math.min(b.clientWidth / this.natural.w,
                                           b.clientHeight / this.natural.h);
    // No smaller than a third of fitted, no bigger than twenty times it:
    // past that there is nothing more to see and a lot to get lost in.
    const w = Math.min(Math.max(this.w() * k, fitW / 3), fitW * 20);
    const real = w / this.w();
    this.x.set(cx - (cx - this.x()) * real);
    this.y.set(cy - (cy - this.y()) * real);
    this.w.set(w);
    this.h.set(this.h() * real);
    this.fitted = false;
  }

  step(k: number) { this.zoom(k); }

  /** What is on screen, as a picture the size of the box: the drawing
   *  where it has been moved to, at the zoom it is at. */
  snapshot(): string {
    const b = this.box().nativeElement;
    return capture(b, getComputedStyle(b).backgroundColor, [
      { src: this.img().nativeElement, x: this.x(), y: this.y(), w: this.w(), h: this.h() },
    ]);
  }

  wheel(ev: WheelEvent) {
    ev.preventDefault();
    const r = this.box().nativeElement.getBoundingClientRect();
    this.zoom(Math.exp(-ev.deltaY * 0.0015), ev.clientX - r.left, ev.clientY - r.top);
  }

  down(ev: PointerEvent) {
    if ((ev.target as HTMLElement).closest('button')) return;
    this.moved = false;
    this.drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY };
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
  }

  move(ev: PointerEvent) {
    if (!this.drag || ev.pointerId !== this.drag.id) { this.look(ev); return; }
    this.moved = true;
    this.x.update(v => v + ev.clientX - this.drag!.x);
    this.y.update(v => v + ev.clientY - this.drag!.y);
    this.drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY };
    this.fitted = false;
  }

  up(ev: PointerEvent) {
    if (this.drag?.id === ev.pointerId) this.drag = null;
  }

  // ---- inspect ----

  private onNet<T extends { net: string }>(rows: T[] | undefined): T[] {
    const net = this.litNet();
    return net && rows ? rows.filter(r => r.net === net) : [];
  }

  private sideOk(layerOrSide: string): boolean {
    const want = this.side();
    if (want === 'all') return true;
    return layerOrSide.startsWith(want) || layerOrSide === 'FB';
  }

  /** The point under the mouse, in the board's millimetres. */
  private toBoard(ev: PointerEvent): [number, number] | null {
    const g = this.geometry();
    if (!g || !this.w()) return null;
    const r = this.box().nativeElement.getBoundingClientRect();
    const fx = (ev.clientX - r.left - this.x()) / this.w();
    const fy = (ev.clientY - r.top - this.y()) / this.h();
    const [bx, by, bw, bh] = g.box;
    return [bx + (this.mirror() ? 1 - fx : fx) * bw, by + fy * bh];
  }

  /** What is under the mouse: a pad first, then a via, then a track -
   *  the order a PCB editor picks in. A few screen pixels of slack, so a
   *  thin track can be found without a steady hand. */
  private look(ev: PointerEvent) {
    const g = this.geometry();
    const at = this.toBoard(ev);
    const r = this.box().nativeElement.getBoundingClientRect();
    this.mouse.set({ x: ev.clientX - r.left, y: ev.clientY - r.top });
    if (!g || !at) { this.hover.set(null); return; }
    const [mx, my] = at;
    const slack = 3 * g.box[2] / this.w();
    for (const p of g.pads) {
      if (!this.sideOk(p.side)) continue;
      const a = p.angle * Math.PI / 180;
      const dx = mx - p.x, dy = my - p.y;
      const lx = dx * Math.cos(a) - dy * Math.sin(a);
      const ly = dx * Math.sin(a) + dy * Math.cos(a);
      if (Math.abs(lx) <= p.w / 2 + slack / 2 && Math.abs(ly) <= p.h / 2 + slack / 2) {
        this.hover.set({ kind: 'pad', net: p.net, item: p }); return;
      }
    }
    for (const v of g.vias) {
      if (Math.hypot(mx - v.x, my - v.y) <= v.d / 2 + slack / 2) {
        this.hover.set({ kind: 'via', net: v.net, item: v }); return;
      }
    }
    let best: Hit | null = null, bestD = Infinity;
    for (const t of g.tracks) {
      if (!this.sideOk(t.layer)) continue;
      const d = segDist(mx, my, t.x1, t.y1, t.x2, t.y2) - t.w / 2;
      if (d <= slack && d < bestD) { bestD = d; best = { kind: 'track', net: t.net, item: t }; }
    }
    this.hover.set(best);
  }

  /** A click holds the net lit; a click on nothing, or Esc, lets it go.
   *  A drag is not a click. */
  pin() {
    if (this.moved || !this.geometry()) return;
    this.pinned.set(this.hover()?.net || null);
  }

  describe(h: Hit): string[] {
    const net = h.net || '(no net)';
    if (h.kind === 'track') {
      const t = h.item;
      const len = Math.hypot(t.x2 - t.x1, t.y2 - t.y1);
      return [`track · ${net}`, `${t.w} mm wide · ${len.toFixed(2)} mm long`, t.layer];
    }
    if (h.kind === 'via') {
      return [`via · ${net}`, `${h.item.d} mm pad · ${h.item.drill} mm drill`];
    }
    const p = h.item;
    return [`${p.ref} pad ${p.num}${p.pin ? ' (' + p.pin + ')' : ''}`, `net ${net}`,
            `${p.w} × ${p.h} mm ${p.shape}${p.drill ? ' · ' + p.drill + ' mm hole' : ''}`,
            p.side === 'FB' ? 'through hole' : p.side === 'B' ? 'B.Cu' : 'F.Cu'];
  }
}

/** Distance from a point to a segment. */
function segDist(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len)) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
