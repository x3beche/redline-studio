import { t } from '../i18n';

/** A reverse switch beside each of the Clip tab's three planes.
 *
 *  three-cad-viewer's planes face one way each - N=(-1,0,0), (0,-1,0),
 *  (0,0,-1) - so every slider cuts in from one end of the model only.
 *  Reversing a plane negates its normal through the viewer's own
 *  setClipNormal (which also relabels the row's N=(...) and keeps caps,
 *  intersection and the plane helpers on the same planes), so the other
 *  half is kept and the cut comes in from the opposite end.
 *
 *  The slider value is kept, not the cut's world position. The viewer's
 *  plane is n . p = n . centre - slider, so with the same slider the cut
 *  mirrors about the model's centre: a plane left fully open stays fully
 *  open, one 20 mm into the model from the right is 20 mm into it from the
 *  left. Keeping the world position instead would turn an open plane into
 *  one that hides the whole model. And the slider means the same in both
 *  orientations - its top end is open, lower is deeper - so the wheel
 *  (clip-wheel.ts) needs nothing: up opens, down cuts in, either way.
 *
 *  Nothing is kept here. The switch reads the viewer's normal every time
 *  it paints, so a note's view put back by applyView (which sets each
 *  plane's stored normal) lights the switch, and a model load - which
 *  resets the planes - puts it out. */

/** The viewer's planes as they come: the side a plane is not reversed on. */
export const DEFAULT_NORMALS: readonly (readonly [number, number, number])[] =
  [[-1, 0, 0], [0, -1, 0], [0, 0, -1]];

/** The same plane facing the other way. `|| 0` keeps -0 out of the label. */
export function flipped(n: readonly number[]): [number, number, number] {
  return [-n[0] || 0, -n[1] || 0, -n[2] || 0];
}

/** Whether plane `i`'s normal faces away from the viewer's default for it
 *  (a normal set from the camera counts by which half it points into). */
export function isReversed(i: number, n: readonly number[] | null | undefined): boolean {
  const d = DEFAULT_NORMALS[i];
  if (!d || !n) return false;
  return d[0] * n[0] + d[1] * n[1] + d[2] * n[2] < -1e-9;
}

/** The two arrows, drawn in the text colour so the theme decides it. */
const GLYPH =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" ' +
  'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M2.5 5.5h10M10 3l2.5 2.5L10 8"/><path d="M13.5 10.5h-10M6 8l-2.5 2.5L6 13"/></svg>';

export class ClipReverse {
  private btns: (HTMLButtonElement | null)[] = [null, null, null];

  constructor(private root: HTMLElement, private viewer: () => any) {
    // Whoever changes a normal - this switch, applyView, the viewer's own
    // "plane to view direction" button - the switch follows it.
    const st = this.viewer()?.state;
    for (let i = 0; i < 3; i++) st?.subscribe?.(`clipNormal${i}`, () => this.paint());
    this.ensure();
  }

  /** Put a switch on each plane row, once. Called again after every load,
   *  in case the viewer has redrawn its panel, and repaints either way. */
  ensure() {
    for (let i = 0; i < 3; i++) {
      const lbl = this.root.querySelector(`.tcv_lbl_norm_plane${i + 1}`);
      const row = lbl?.parentElement;
      if (!lbl || !row) continue;
      if (this.btns[i]?.parentElement === row) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tcv-clipflip';
      b.dataset['plane'] = String(i + 1);
      b.innerHTML = GLYPH;
      b.addEventListener('click', () => this.toggle(i));
      row.classList.add('tcv-clipflip-row');
      row.appendChild(b);
      this.btns[i] = b;
    }
    this.relabel();
    this.paint();
  }

  /** The words, in the language on now. */
  relabel() {
    const tip = t('Reverse - cut from the other side');
    for (const b of this.btns) {
      if (!b) continue;
      b.title = tip;
      b.setAttribute('aria-label', tip);
    }
  }

  /** Turn plane `i` round, keeping its slider value (see the top). */
  toggle(i: number) {
    const v = this.viewer();
    if (!v?.getClipNormal || !v?.setClipNormal) return;
    const n = v.getClipNormal(i) as number[];
    const slider = Number(v.getClipSlider(i));
    v.setClipNormal(i, flipped(n), Number.isFinite(slider) ? slider : null);
    this.paint();
  }

  /** Each switch is lit while its plane faces away from the default. */
  paint() {
    const v = this.viewer();
    this.btns.forEach((b, i) => {
      if (!b) return;
      let on = false;
      try { on = isReversed(i, v?.getClipNormal?.(i)); } catch { /* not rendered yet */ }
      b.dataset['on'] = on ? '1' : '0';
      b.setAttribute('aria-pressed', String(on));
    });
  }
}
