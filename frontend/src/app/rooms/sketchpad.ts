import {
  Component, ElementRef, OnDestroy, effect, input, output, signal, viewChild,
} from '@angular/core';
import type { Tool } from '../editor/editor';
import { FIRST_PEN, Mark, PENS, TOOLS, paint } from './sketch';

/** Which pen is in hand. Held by the room, so the tools in its toolbar
 *  and the pad over its view are talking about the same one. */
export class PenState {
  tool = signal<Tool>('pen');
  color = signal(FIRST_PEN);
  width = signal(4);
  fontSize = signal(18);
}

/** The drawing tools, as the 3D room docks them in its toolbar: the seven
 *  tools, the four inks, a width, undo and clear. */
@Component({
  selector: 'app-draw-tools',
  host: { class: 'tcv-draw' },
  template: `
@for (t of tools; track t.id) {
  <button (click)="pen().tool.set(t.id)" [title]="t.label"
          class="tcv-btn tcv-draw-btn"
          [style.background]="pen().tool() === t.id ? 'var(--accent)' : null"
          [style.color]="pen().tool() === t.id ? 'var(--ink-bright)' : null">{{ t.glyph }}</button>
}
<span class="tcv-draw-sep"></span>
@for (c of PENS; track c) {
  <button (click)="pen().color.set(c)" [style.background]="c" class="tcv-draw-swatch"
          [style.outline]="pen().color() === c ? '2px solid var(--ink)' : 'none'"
          [style.outline-offset]="'1px'"></button>
}
@if (pen().tool() === 'text') {
  <input type="range" min="10" max="48" [value]="pen().fontSize()"
         (input)="pen().fontSize.set($any($event.target).valueAsNumber)"
         class="tcv-draw-range" style="accent-color: var(--accent)" title="Text size">
  <span class="tcv-label tcv-draw-num">{{ pen().fontSize() }}</span>
} @else {
  <input type="range" min="1" max="16" [value]="pen().width()"
         (input)="pen().width.set($any($event.target).valueAsNumber)"
         class="tcv-draw-range" style="accent-color: var(--accent)" title="Stroke width">
  <span class="tcv-label tcv-draw-num">{{ pen().width() }}</span>
}
<span class="tcv-draw-sep"></span>
<button (click)="undo.emit()" class="tcv-btn tcv-draw-text">Undo</button>
<button (click)="clear.emit()" class="tcv-btn tcv-draw-text">Clear</button>`,
})
export class DrawTools {
  pen = input.required<PenState>();
  undo = output<void>();
  clear = output<void>();
  readonly tools = TOOLS;
  readonly PENS = PENS;
}

/** A frozen picture of the view, and the marks drawn over it.
 *
 *  The picture is taken by the room when it freezes - whatever it was
 *  showing, at the size it was showing it - so the marks land on exactly
 *  what was on screen and the note carries that, not a re-render of it.
 */
@Component({
  selector: 'app-sketchpad',
  host: { class: 'absolute inset-0 block' },
  template: `
<div #box class="relative h-full w-full overflow-hidden rounded" style="background: var(--pcb-bg)">
  <img [src]="shot()" alt="the view, frozen" draggable="false"
       class="absolute inset-0 block h-full w-full">
  <canvas #overlay class="absolute inset-0 h-full w-full cursor-crosshair"
          (pointerdown)="down($event)" (pointermove)="move($event)"
          (pointerup)="up()" (pointerleave)="up()"></canvas>
  @if (typing(); as tp) {
    <input #caret class="absolute rounded px-1 py-0.5 text-sm outline-none"
           [style.left.px]="tp.left" [style.top.px]="tp.top - 12"
           [style.color]="pen().color()" [style.font-size.px]="pen().fontSize()"
           style="background: var(--draw-label); border: 1px dashed currentColor;
                  min-width: 120px; transform: translateY(-2px)"
           placeholder="label…"
           (keydown.enter)="commitText($any($event.target).value)"
           (keydown.escape)="typing.set(null)"
           (blur)="commitText($any($event.target).value)">
  }
</div>`,
})
export class Sketchpad implements OnDestroy {
  /** The picture, as a data URL, at the canvas's pixel size. */
  shot = input.required<string>();
  pen = input.required<PenState>();
  /** How many marks there are, whenever that changes. */
  marked = output<number>();

  private box = viewChild.required<ElementRef<HTMLDivElement>>('box');
  private overlay = viewChild.required<ElementRef<HTMLCanvasElement>>('overlay');
  private caret = viewChild<ElementRef<HTMLInputElement>>('caret');

  typing = signal<{ left: number; top: number } | null>(null);
  private typeAt: [number, number] = [0, 0];
  private marks: Mark[] = [];
  private active: Mark | null = null;
  private drawing = false;
  private ro?: ResizeObserver;

  constructor() {
    effect(() => {
      this.shot();
      setTimeout(() => this.size());
    });
  }

  ngOnDestroy() { this.ro?.disconnect(); }

  private ratio() { return Math.min(devicePixelRatio, 2); }

  /** The canvas matches its box at the screen's density, the way the 3D
   *  room's overlay matches its viewer; a resize carries the marks with it. */
  private size() {
    const b = this.box().nativeElement;
    const c = this.overlay().nativeElement;
    if (!this.ro) {
      this.ro = new ResizeObserver(() => this.size());
      this.ro.observe(b);
    }
    const w = Math.round(b.clientWidth * this.ratio());
    const h = Math.round(b.clientHeight * this.ratio());
    if (!w || !h || (c.width === w && c.height === h)) return;
    if (c.width && c.height && this.marks.length) {
      const sx = w / c.width, sy = h / c.height;
      for (const m of this.marks) {
        if (m.kind === 'pen') m.pts = m.pts.map(p => [p[0] * sx, p[1] * sy]);
        else if (m.kind === 'text') m.at = [m.at[0] * sx, m.at[1] * sy];
        else { m.a = [m.a[0] * sx, m.a[1] * sy]; m.b = [m.b[0] * sx, m.b[1] * sy]; }
      }
    }
    c.width = w;
    c.height = h;
    this.repaint();
  }

  private pos(ev: PointerEvent): [number, number] {
    const c = this.overlay().nativeElement;
    const r = c.getBoundingClientRect();
    return [(ev.clientX - r.left) * c.width / r.width,
            (ev.clientY - r.top) * c.height / r.height];
  }

  down(ev: PointerEvent) {
    const at = this.pos(ev);
    const t = this.pen().tool();
    if (t === 'text') {
      const r = this.overlay().nativeElement.getBoundingClientRect();
      this.typeAt = at;
      this.typing.set({ left: ev.clientX - r.left, top: ev.clientY - r.top });
      setTimeout(() => this.caret()?.nativeElement.focus());
      return;
    }
    this.drawing = true;
    (ev.target as HTMLElement).setPointerCapture(ev.pointerId);
    const color = this.pen().color(), width = this.pen().width();
    this.active = t === 'pen'
      ? { kind: 'pen', color, width, pts: [at] }
      : { kind: t, color, width, a: at, b: at };
    this.marks.push(this.active);
    this.repaint();
  }

  move(ev: PointerEvent) {
    if (!this.drawing || !this.active) return;
    const at = this.pos(ev);
    if (this.active.kind === 'pen') this.active.pts.push(at);
    else if (this.active.kind !== 'text') this.active.b = at;
    this.repaint();
  }

  up() {
    if (!this.drawing) return;
    if (this.active && this.active.kind !== 'pen' && this.active.kind !== 'text') {
      const [ax, ay] = this.active.a, [bx, by] = this.active.b;
      if (Math.hypot(bx - ax, by - ay) < 3) this.marks.pop();
    }
    this.drawing = false;
    this.active = null;
    this.repaint();
  }

  commitText(value: string) {
    if (!this.typing()) return;
    const text = value.trim();
    this.typing.set(null);
    if (!text) return;
    this.marks.push({ kind: 'text', color: this.pen().color(),
                      size: this.pen().fontSize() * this.ratio(), at: this.typeAt, text });
    this.repaint();
  }

  undo() { this.marks.pop(); this.repaint(); }
  clear() { this.marks = []; this.repaint(); }

  private repaint() {
    const ctx = this.overlay().nativeElement.getContext('2d');
    if (ctx) paint(ctx, this.marks, this.ratio());
    this.marked.emit(this.marks.length);
  }

  /** The picture with the marks on it, as one PNG at the canvas's size. */
  merged(): Promise<string> {
    return new Promise((resolve, reject) => {
      const overlay = this.overlay().nativeElement;
      const out = document.createElement('canvas');
      out.width = overlay.width;
      out.height = overlay.height;
      const img = new Image();
      img.onload = () => {
        const ctx = out.getContext('2d')!;
        ctx.drawImage(img, 0, 0, out.width, out.height);
        ctx.drawImage(overlay, 0, 0);
        resolve(out.toDataURL('image/png'));
      };
      img.onerror = () => reject(new Error('the frozen picture would not load'));
      img.src = this.shot();
    });
  }
}

/** Lay pictures one over another onto a canvas the size of `box`, on the
 *  given background: how a room turns what it is showing into a shot. */
export function capture(box: HTMLElement, background: string,
                        layers: { src: CanvasImageSource; x: number; y: number;
                                  w: number; h: number }[]): string {
  const k = Math.min(devicePixelRatio, 2);
  const out = document.createElement('canvas');
  out.width = Math.round(box.clientWidth * k);
  out.height = Math.round(box.clientHeight * k);
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, out.width, out.height);
  for (const l of layers) ctx.drawImage(l.src, l.x * k, l.y * k, l.w * k, l.h * k);
  return out.toDataURL('image/png');
}
