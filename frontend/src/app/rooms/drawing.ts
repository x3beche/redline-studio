import {
  Component, ElementRef, OnDestroy, effect, input, signal, viewChild,
} from '@angular/core';
import { capture } from './sketchpad';

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
     (pointercancel)="up($event)" (dblclick)="fit()">
  <img #img [src]="src()" alt="" draggable="false" (load)="loaded()"
       class="absolute max-w-none" style="left: 0; top: 0"
       [style.width.px]="w()" [style.height.px]="h()"
       [style.transform]="'translate(' + x() + 'px,' + y() + 'px)'">
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

  private box = viewChild.required<ElementRef<HTMLDivElement>>('box');
  private img = viewChild.required<ElementRef<HTMLImageElement>>('img');

  ready = signal(false);
  w = signal(0);
  h = signal(0);
  x = signal(0);
  y = signal(0);

  private natural = { w: 1, h: 1 };
  private drag: { id: number; x: number; y: number } | null = null;
  private ro?: ResizeObserver;
  private fitted = true;

  constructor() {
    // A new drawing - another board, a fresh route - starts fitted again.
    effect(() => { this.src(); this.ready.set(false); this.fitted = true; });
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

  ngOnDestroy() { this.ro?.disconnect(); }

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
    this.drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY };
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
  }

  move(ev: PointerEvent) {
    if (!this.drag || ev.pointerId !== this.drag.id) return;
    this.x.update(v => v + ev.clientX - this.drag!.x);
    this.y.update(v => v + ev.clientY - this.drag!.y);
    this.drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY };
    this.fitted = false;
  }

  up(ev: PointerEvent) {
    if (this.drag?.id === ev.pointerId) this.drag = null;
  }
}
