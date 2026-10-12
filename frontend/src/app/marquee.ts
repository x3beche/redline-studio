import { Directive, ElementRef, NgZone, OnDestroy, booleanAttribute, inject, input, output } from '@angular/core';

/** Selecting by drawing a rectangle, as in a file manager: put it on the
 *  element that holds the items, give each item `data-key`, and listen to
 *  `(wbMarquee)` for the keys the box touches while it is drawn. A drag that
 *  starts on an item (or a button, link or field) is that item's own; Ctrl,
 *  Cmd or Shift adds to `marqueeBase`, the selection when the drag began.
 *
 *    <div class="grid" wbMarquee [marqueeBase]="selected()" (wbMarquee)="selected.set($event)">
 *
 *  Rows that fill the list's width leave nowhere empty to start from: with
 *  `marqueeFromItems` a drag may start on an item too (not on its buttons),
 *  and a press there that does not move stays a click on it.
 *
 *  The box is the theme's --marquee colour, drawn in the holder (made
 *  position: relative), so it scrolls with it; it stays inside the holder's
 *  visible part, and near its top or bottom edge the list scrolls on. */
@Directive({ selector: '[wbMarquee]', host: { '(pointerdown)': 'down($event)' } })
export class Marquee implements OnDestroy {
  wbMarquee = output<Set<string>>();
  /** What was selected before: kept when a modifier is held. */
  marqueeBase = input<Set<string>>(new Set());
  /** Off: a drag here is left alone (text can be selected as usual). */
  marqueeOn = input<boolean>(true);
  /** Where a drag never starts, besides items and controls (a table's head, a form). */
  marqueeSkip = input<string>('');
  /** A drag may start on an item as well (rows as wide as the list). */
  marqueeFromItems = input(false, { transform: booleanAttribute });
  /** Fired once a drag has really drawn something (to skip the click that ends it). */
  marqueeDone = output<void>();

  private el = inject(ElementRef<HTMLElement>).nativeElement as HTMLElement;
  private zone = inject(NgZone);
  private box: HTMLDivElement | null = null;
  private off: (() => void) | null = null;

  down(e: PointerEvent) {
    if (e.button !== 0 || e.pointerType === 'touch' || !this.marqueeOn()) return;
    const target = e.target as HTMLElement;
    const controls = 'button, a, input, select, textarea, label, wb-select, [contenteditable="true"]';
    if (target.closest(this.marqueeFromItems() ? controls : '[data-key], ' + controls)) return;
    if (this.marqueeSkip() && target.closest(this.marqueeSkip())) return;
    const host = this.el;
    const r0 = host.getBoundingClientRect();
    if (e.clientX > r0.left + host.clientLeft + host.clientWidth) return;   // the scrollbar
    e.preventDefault();   // no text selection while drawing
    if (host.hasAttribute('tabindex')) host.focus({ preventScroll: true });
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    // In the holder's content, so a holder that scrolls keeps the box on what it covers.
    const sx = e.clientX - r0.left + host.scrollLeft, sy = e.clientY - r0.top + host.scrollTop;
    const add = e.ctrlKey || e.metaKey || e.shiftKey;
    const base = add ? new Set(this.marqueeBase()) : new Set<string>();
    // A press on an item may still be a click on it: nothing is dropped until the box is drawn.
    const onItem = !!target.closest('[data-key]');
    let moved = false, px = e.clientX, py = e.clientY;
    if (!add && !onItem) this.zone.run(() => this.wbMarquee.emit(new Set()));
    // What scrolls: the holder, or the pane it is in.
    const pane = host.scrollHeight > host.clientHeight ? host : scroller(host);

    const draw = () => {
      const r = host.getBoundingClientRect();
      const left = r.left + host.clientLeft, top = r.top + host.clientTop;
      const cx = Math.min(Math.max(px, left), left + host.clientWidth) - r.left + host.scrollLeft;
      const cy = Math.min(Math.max(py, top), top + host.clientHeight) - r.top + host.scrollTop;
      if (!moved && Math.abs(cx - sx) < 5 && Math.abs(cy - sy) < 5) return;
      moved = true;
      const x = Math.min(sx, cx), y = Math.min(sy, cy), w = Math.abs(cx - sx), h = Math.abs(cy - sy);
      if (!this.box) {
        this.box = document.createElement('div');
        this.box.className = 'wb-marquee';
        host.appendChild(this.box);
        host.style.userSelect = 'none';
      }
      Object.assign(this.box.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
      const sel = new Set(base);
      host.querySelectorAll<HTMLElement>('[data-key]').forEach(it => {
        const q = it.getBoundingClientRect();
        const ix = q.left - r.left + host.scrollLeft, iy = q.top - r.top + host.scrollTop;
        if (ix < x + w && ix + q.width > x && iy < y + h && iy + q.height > y) sel.add(it.dataset['key']!);
      });
      this.zone.run(() => this.wbMarquee.emit(sel));
    };
    const move = (m: PointerEvent) => { px = m.clientX; py = m.clientY; draw(); };
    const scrolled = () => { if (moved) draw(); };
    // Near the pane's top or bottom edge, it scrolls on by itself.
    const edge = setInterval(() => {
      if (!moved || !pane) return;
      const b = pane.getBoundingClientRect();
      const top = Math.max(b.top, 0), bottom = Math.min(b.bottom, innerHeight);
      const dy = py < top + 24 ? -14 : py > bottom - 24 ? 14 : 0;
      if (dy) pane.scrollBy(0, dy);
    }, 30);
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
      pane?.addEventListener('scroll', scrolled);
    });
    this.off = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      pane?.removeEventListener('scroll', scrolled);
      clearInterval(edge);
    };
  }

  private stop() {
    this.off?.();
    this.off = null;
    this.box?.remove();
    this.box = null;
    this.el.style.userSelect = '';
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
