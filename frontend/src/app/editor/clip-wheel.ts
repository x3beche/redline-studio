import { t } from '../i18n';

/** The mouse wheel on the Clip tab's plane sliders, and the step it moves
 *  them by.
 *
 *  three-cad-viewer's sliders only follow a drag or typing. Over one of the
 *  three plane rows (the range or its number box) the wheel now moves that
 *  plane by one step: up is +, down is −, Shift ×10. The value goes in
 *  through the viewer's own number-box path - `.value` then a `change`
 *  event, which is Slider.inputChange: clamp, range thumb, refreshPlane
 *  (the viewer's state, so getClipSlider and a note's view read it back)
 *  and checkChanges. Through the number box rather than the range because
 *  a range snaps to its own `step` from `min`, and a 1 mm step would land
 *  on 0.97 mm.
 *
 *  The wheel follows the slider's thumb, not the world axis: up is the
 *  slider's open end, down cuts deeper. A reversed plane (clip-reverse.ts)
 *  keeps that meaning - only the end it cuts in from changes - so the
 *  wheel needs no special case for it.
 *
 *  The step is picked at the top of the tab and kept per browser. */

export const STEP_PRESETS = [0.1, 0.5, 1, 5, 10] as const;
export const STEP_DEFAULT = 1;
const KEY = 'redline.clipStep';
/** Shift turns the wheel into coarse moves. */
export const SHIFT_FACTOR = 10;
/** A notch of a mouse wheel is ~100 px; a touchpad sends a stream of
 *  small deltas, which are added up so a light swipe is not a dozen steps. */
const NOTCH_PX = 40;

/** Three decimals, as the viewer's number box shows them. */
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** The plane's value one step on, in `dir` (+1 / −1), inside [min, max]. */
export function stepValue(cur: number, dir: number, step: number, min: number, max: number): number {
  const from = Number.isFinite(cur) ? cur : 0;
  const lo = Math.min(min, max), hi = Math.max(min, max);
  return Math.min(Math.max(r3(from + Math.sign(dir) * step), lo), hi);
}

/** A typed step, or null when it is not one: positive, at most 1000,
 *  at least the viewer's 0.001 resolution. Accepts a decimal comma. */
export function parseStep(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw ?? '').trim().replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(Math.max(r3(n), 0.001), 1000);
}

/** How a step is written: no trailing zeros, no exponent. */
export function fmtStep(n: number): string {
  return String(r3(n));
}

export function loadStep(): number {
  try { return parseStep(localStorage.getItem(KEY)) ?? STEP_DEFAULT; } catch { return STEP_DEFAULT; }
}

function saveStep(n: number) {
  try { localStorage.setItem(KEY, String(n)); } catch { /* private window */ }
}

/** Which plane row (1..3) an element belongs to, if any. */
function planeOf(el: EventTarget | null): { range: HTMLInputElement; box: HTMLInputElement } | null {
  if (!(el instanceof HTMLInputElement)) return null;
  const m = /\btcv_(?:sld|inp)_value_plane([123])\b/.exec(el.className);
  if (!m) return null;
  const row = el.parentElement;
  const range = row?.querySelector(`.tcv_sld_value_plane${m[1]}`);
  const box = row?.querySelector(`.tcv_inp_value_plane${m[1]}`);
  return range instanceof HTMLInputElement && box instanceof HTMLInputElement ? { range, box } : null;
}

export class ClipWheel {
  step = loadStep();
  private el: HTMLElement | null = null;
  private acc = 0;

  constructor(private root: HTMLElement) {
    // One listener on the viewer's root, which outlives every model load;
    // not passive, or the panel scrolls (and the page zooms) under it.
    root.addEventListener('wheel', this.onWheel, { passive: false });
    this.ensure();
  }

  /** Put the step control at the top of the Clip tab, once. Called again
   *  after every load, in case the viewer has redrawn its panel. */
  ensure() {
    const clip = this.root.querySelector('.tcv_cad_clip_container');
    if (!clip) return;
    if (this.el && this.el.parentElement === clip) return;
    this.el = this.build();
    clip.insertBefore(this.el, clip.firstChild);
    this.relabel();
  }

  /** The words, in the language on now. */
  relabel() {
    const el = this.el;
    if (!el) return;
    const tip = t('Mouse wheel over a clip slider moves the plane by this much. Shift: ×10.');
    el.title = tip;
    el.querySelector('.tcv-clipstep-label')!.textContent = t('Wheel step');
    el.querySelector('.tcv-clipstep-presets')!.setAttribute('aria-label', t('Wheel step'));
    el.querySelector('input')!.setAttribute('aria-label', t('Wheel step') + ' (mm)');
  }

  private build(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'tcv-clipstep';
    el.innerHTML =
      '<div class="tcv-clipstep-head">' +
        '<span class="tcv-clipstep-label"></span>' +
        '<span class="tcv-clipstep-field">' +
          '<input type="text" inputmode="decimal" autocomplete="off" spellcheck="false">' +
          '<span class="tcv-clipstep-unit">mm</span>' +
        '</span>' +
      '</div>' +
      '<div class="tcv-clipstep-presets" role="group">' +
        STEP_PRESETS.map(p => `<button type="button" data-step="${p}">${fmtStep(p)}</button>`).join('') +
      '</div>';
    const input = el.querySelector('input')!;
    el.querySelectorAll<HTMLButtonElement>('button[data-step]').forEach(b =>
      b.addEventListener('click', () => this.set(Number(b.dataset['step']))));
    const commit = () => {
      const n = parseStep(input.value);
      if (n != null) this.set(n); else this.paint();
    };
    input.addEventListener('change', commit);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { commit(); input.blur(); }
      else if (e.key === 'Escape') { this.paint(); input.blur(); }
    });
    this.paint(el);
    return el;
  }

  private set(n: number) {
    this.step = n;
    saveStep(n);
    this.paint();
  }

  /** The field and the lit preset follow the step. */
  private paint(el: HTMLElement | null = this.el) {
    if (!el) return;
    const input = el.querySelector('input')!;
    if (document.activeElement !== input || parseStep(input.value) !== this.step) input.value = fmtStep(this.step);
    el.querySelectorAll<HTMLButtonElement>('button[data-step]').forEach(b => {
      const on = Number(b.dataset['step']) === this.step;
      b.dataset['on'] = on ? '1' : '0';
      b.setAttribute('aria-pressed', String(on));
    });
  }

  private onWheel = (e: WheelEvent) => {
    // Ctrl/Cmd + wheel is the browser's zoom; it is left alone.
    if (e.ctrlKey || e.metaKey) return;
    const plane = planeOf(e.target);
    if (!plane) return;
    e.preventDefault();
    e.stopPropagation();
    // Shift + wheel arrives as a horizontal scroll in most browsers.
    const d = e.deltaY || (e.shiftKey ? e.deltaX : 0);
    if (!d) return;
    let dir: number;
    if (e.deltaMode !== WheelEvent.DOM_DELTA_PIXEL || Math.abs(d) >= NOTCH_PX) {
      this.acc = 0;
      dir = d < 0 ? 1 : -1;
    } else {
      if (Math.sign(d) !== Math.sign(this.acc)) this.acc = 0;
      this.acc += d;
      if (Math.abs(this.acc) < NOTCH_PX) return;
      dir = this.acc < 0 ? 1 : -1;
      this.acc = 0;
    }
    const { range, box } = plane;
    const step = this.step * (e.shiftKey ? SHIFT_FACTOR : 1);
    const cur = parseFloat(box.value);
    const next = stepValue(cur, dir, step, parseFloat(range.min), parseFloat(range.max));
    if (next === cur) return;
    box.value = String(next);
    box.dispatchEvent(new Event('change', { bubbles: true }));
  };
}
