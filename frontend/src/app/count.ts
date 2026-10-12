import { Directive, ElementRef, Input, NgZone, OnDestroy, inject } from '@angular/core';

/** A figure that counts to its new value: <b [wbCount]="fmt.bytes(x)"></b>.
 *
 *  It takes the text as the page formats it - "103.8 MB", "7.8M", "$1,204.50",
 *  "1.234,5 ₺", "92%" - and when it changes to one of the same shape (the
 *  same words and units around the same number of figures) each figure runs
 *  from the old value to the new in 250 ms, easing out, written with the new
 *  text's decimals and separators. Any other change (a unit that steps up
 *  from kB to MB, "–" to a figure) is shown at once, as is the first value
 *  and a change from zero, so a page opening does not count up from nothing.
 *  The frames run outside Angular and write the text directly; the last
 *  frame is the new text exactly. Nothing moves in a hidden tab or for
 *  someone who asked for less motion. */
@Directive({ selector: '[wbCount]' })
export class CountUp implements OnDestroy {
  private el = inject(ElementRef).nativeElement as HTMLElement;
  private zone = inject(NgZone);
  private shown: string | null = null;
  private raf = 0;

  @Input() set wbCount(v: string | number | null | undefined) {
    const next = v == null ? '' : String(v);
    const from = this.shown;
    if (next === from) return;
    cancelAnimationFrame(this.raf);
    const plan = from == null || !animate() ? null : tween(from, next);
    if (!plan) { this.write(next); return; }
    const t0 = performance.now();
    this.zone.runOutsideAngular(() => {
      const step = (now: number) => {
        const k = Math.min(1, (now - t0) / 250);
        this.write(k >= 1 ? next : plan(1 - Math.pow(1 - k, 3)));
        if (k < 1) this.raf = requestAnimationFrame(step);
      };
      this.raf = requestAnimationFrame(step);
    });
  }

  private write(s: string) { this.shown = s; this.el.textContent = s; }
  ngOnDestroy() { cancelAnimationFrame(this.raf); }
}

const reduce = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
function animate() { return typeof document !== 'undefined' && !document.hidden && !reduce?.matches; }

/** A figure: digits with "." or "," between groups of them. */
const NUM = /\d(?:[\d.,]*\d)?/g;
interface Num { v: number; dec: number; point: string; group: string }

function parse(s: string): Num {
  const dot = s.lastIndexOf('.'), comma = s.lastIndexOf(',');
  let point = '';
  if (dot >= 0 && comma >= 0) point = dot > comma ? '.' : ',';
  else if (dot >= 0 || comma >= 0) {
    const c = dot >= 0 ? '.' : ',', at = Math.max(dot, comma);
    // One separator before exactly three digits is a thousands one ("1,234"),
    // unless the figure is under one ("0.125").
    const once = s.indexOf(c) === at;
    if (once && (s.length - at - 1 !== 3 || /^0[.,]/.test(s))) point = c;
  }
  const group = point ? (s.includes(point === '.' ? ',' : '.') ? (point === '.' ? ',' : '.') : '') : (dot >= 0 ? '.' : comma >= 0 ? ',' : '');
  const [int, frac = ''] = point ? [s.slice(0, s.lastIndexOf(point)), s.slice(s.lastIndexOf(point) + 1)] : [s, ''];
  const digits = int.replace(/[.,]/g, '');
  return { v: parseFloat(digits + (frac ? '.' + frac : '')), dec: frac.length, point, group };
}

function show(v: number, m: Num): string {
  const [int, frac] = v.toFixed(m.dec).split('.');
  const grouped = m.group ? int.replace(/\B(?=(\d{3})+(?!\d))/g, m.group) : int;
  return frac ? grouped + (m.point || '.') + frac : grouped;
}

/** How to draw the text part way from a to b, or null when they differ in shape. */
function tween(a: string, b: string): ((k: number) => string) | null {
  const na = a.match(NUM) ?? [], nb = b.match(NUM) ?? [];
  if (!nb.length || na.length !== nb.length) return null;
  const sa = a.split(NUM), sb = b.split(NUM);
  if (sa.some((s, i) => s !== sb[i])) return null;
  const pa = na.map(parse), pb = nb.map(parse);
  if (pa.every(p => p.v === 0) || pa.some(p => !isFinite(p.v)) || pb.some(p => !isFinite(p.v))) return null;
  // "$1,204.50" to "$987.10": the frames between keep the thousands mark.
  const pm = pb.map((p, i) => p.group || pa[i].group === p.point ? p : { ...p, group: pa[i].group });
  return k => sb.map((s, i) => i < pm.length ? s + show(pa[i].v + (pm[i].v - pa[i].v) * k, pm[i]) : s).join('');
}
