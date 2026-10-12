import { Directive, ElementRef, NgZone, OnDestroy, inject, input, output } from '@angular/core';

/** Selecting by drawing a rectangle, as in a file manager: put it on the
 *  element that holds the items, give each item `data-key`, and listen to
 *  `(wbMarquee)` for the keys the box touches while it is drawn. A drag that
 *  starts on an item (or a button, link or field) is that item's own; Ctrl,
 *  Cmd or Shift adds to `marqueeBase`, the selection when the drag began.
 *
 *    <div class="grid" wbMarquee [marqueeBase]="selected()" (wbMarquee)="selected.set($event)">
 *
 *  The box is the Files tab's: the theme's --marquee colour, drawn in the
 *  holder (made position: relative), so it scrolls with it. */
@Directive({ selector: '[wbMarquee]', host: { '(pointerdown)': 'down($event)' } })
export class Marquee implements OnDestroy {
  wbMarquee = output<Set<string>>();
  /** What was selected before: kept when a modifier is held. */
  marqueeBase = input<Set<string>>(new Set());
  /** Off: a drag here is left alone (text can be selected as usual). */
  marqueeOn = input<boolean>(true);
  /** Fired once a drag has really drawn something (to skip the click that ends it). */
  marqueeDone = output<void>();

  private el = inject(ElementRef<HTMLElement>).nativeElement as HTMLElement;
  private zone = inject(NgZone);
  private box: HTMLDivElement | null = null;
  private off: (() => void) | null = null;

  down(e: PointerEvent) {
    if (e.button !== 0 || e.pointerType === 'touch' || !this.marqueeOn()) return;
    if ((e.target as HTMLElement).closest('[data-key], button, a, input, select, textarea, label, wb-select')) return;
    e.preventDefault();
    const host = this.el;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    const r0 = host.getBoundingClientRect();
    // In the holder's content, so a holder that scrolls keeps the box on what it covers.
    const sx = e.clientX - r0.left + host.scrollLeft, sy = e.clientY - r0.top + host.scrollTop;
    const add = e.ctrlKey || e.metaKey || e.shiftKey;
    const base = add ? new Set(this.marqueeBase()) : new Set<string>();
    let moved = false;
    if (!add) this.zone.run(() => this.wbMarquee.emit(new Set()));

    const move = (m: PointerEvent) => {
      const r = host.getBoundingClientRect();
      const cx = m.clientX - r.left + host.scrollLeft, cy = m.clientY - r.top + host.scrollTop;
      if (!moved && Math.abs(cx - sx) < 5 && Math.abs(cy - sy) < 5) return;
      moved = true;
      const x = Math.min(sx, cx), y = Math.min(sy, cy), w = Math.abs(cx - sx), h = Math.abs(cy - sy);
      if (!this.box) {
        this.box = document.createElement('div');
        this.box.className = 'wb-marquee';
        host.appendChild(this.box);
      }
      Object.assign(this.box.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
      const sel = new Set(base);
      host.querySelectorAll<HTMLElement>('[data-key]').forEach(it => {
        const q = it.getBoundingClientRect();
        const ix = q.left - r.left + host.scrollLeft, iy = q.top - r.top + host.scrollTop;
        if (ix < x + w && ix + q.width > x && iy < y + h && iy + q.height > y) sel.add(it.dataset['key']!);
      });
      this.zone.run(() => this.wbMarquee.emit(sel));
      // Near the window's top or bottom edge, the page scrolls on.
      const edge = m.clientY < 40 ? -16 : m.clientY > innerHeight - 40 ? 16 : 0;
      if (edge) (host.scrollHeight > host.clientHeight ? host : scroller(host))?.scrollBy(0, edge);
    };
    const up = () => {
      this.stop();
      if (moved) {
        this.zone.run(() => this.marqueeDone.emit());
        // The click that ends a drag is not a click on what is under it.
        const eat = (c: MouseEvent) => { c.stopPropagation(); c.preventDefault(); };
        document.addEventListener('click', eat, { capture: true, once: true });
        setTimeout(() => document.removeEventListener('click', eat, { capture: true }), 0);
      }
    };
    this.zone.runOutsideAngular(() => {
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up, { once: true });
    });
    this.off = () => document.removeEventListener('pointermove', move);
  }

  private stop() {
    this.off?.();
    this.off = null;
    this.box?.remove();
    this.box = null;
  }

  ngOnDestroy() { this.stop(); }
}

function scroller(el: HTMLElement | null): HTMLElement | null {
  for (let e = el?.parentElement ?? null; e; e = e.parentElement) {
    const o = getComputedStyle(e).overflowY;
    if ((o === 'auto' || o === 'scroll') && e.scrollHeight > e.clientHeight) return e;
  }
  return null;
}
