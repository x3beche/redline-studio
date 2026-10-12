import { Box3 } from 'three';

/** How one model gives way to the next in the 3D room, picked in Settings >
 *  Appearance and kept in this browser like the theme. A switch blocks the
 *  page while the new geometry is parsed and built; without a transition the
 *  old model sat there, then vanished and the new one popped in. */
export const SWITCHES = ['none', 'fade', 'fade-scale', 'glide', 'fade-glide', 'stagger'] as const;
export type ModelSwitch = (typeof SWITCHES)[number];
export const SWITCH_DEFAULT: ModelSwitch = 'fade-glide';
/** Name and a line on what it does, for the Settings card. */
export const SWITCH_INFO: Record<ModelSwitch, { name: string; about: string }> = {
  'none': { name: 'None', about: 'The new model replaces the old one at once.' },
  'fade': { name: 'Fade', about: 'The old model dims while the new one loads, then it fades in.' },
  'fade-scale': { name: 'Fade and scale', about: 'As Fade, and the new model grows into place.' },
  'glide': { name: 'Camera glide', about: 'The camera moves from the old view to the new one.' },
  'fade-glide': { name: 'Fade and glide', about: 'Fade, with the camera gliding to the new view.' },
  'stagger': { name: 'Parts in turn', about: 'The parts appear one after another; large models fade.' },
};
const KEY = 'redline.modelSwitch';

export function currentSwitch(): ModelSwitch {
  let s: string | null = null;
  try { s = localStorage.getItem(KEY); } catch { /* private window */ }
  return (SWITCHES as readonly string[]).includes(s ?? '') ? s as ModelSwitch : SWITCH_DEFAULT;
}

export function setSwitch(s: ModelSwitch): ModelSwitch {
  try {
    if (s === SWITCH_DEFAULT) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, s);
  } catch { /* private window: this page only */ }
  return s;
}

export const reducedMotion = () => {
  try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

/** The fades: how long, and how far the old model dims while it waits. */
const FADE_MS = 180;
const DIM = .45;
const GLIDE_MS = 300;
/** Parts in turn: the last part is in by this, and above this many parts
 *  the steps would be too short to see - those models fade instead. */
const STAGGER_MS = 400;
const STAGGER_MAX = 40;

const fades = (k: ModelSwitch) => k === 'fade' || k === 'fade-scale' || k === 'fade-glide' || k === 'stagger';
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

type Cam = { position: number[]; target: number[]; zoom: number };

/** The transition itself, around OcpViewer.load(): begin() when a switch
 *  is asked for, freeze() just before the old scene is cleared, land() once
 *  the new one is rendered, end() whatever happened. Only opacity and
 *  transform on the page; the camera moves through the viewer's own API. */
export class SwitchMotion {
  private kind: ModelSwitch = 'none';
  private token = 0;
  private bar: HTMLElement | null = null;
  private still: HTMLCanvasElement | null = null;
  private raf = 0;
  private glideTo: Cam | null = null;
  private hidden: { visible: boolean }[] = [];
  private stopGlide = () => {};

  constructor(private view: () => HTMLElement | null, private canvas: () => HTMLCanvasElement | null,
              private viewer: () => any) {}

  /** Where the camera is going while it glides: whoever reads the camera
   *  mid-glide (the remembered view) wants where it ends, not a frame of
   *  the way there. */
  get destination(): Cam | null { return this.glideTo; }

  /** A switch is asked for: the progress line, and the old model dims.
   *  `off` for the headless render's shot, which wants no motion. */
  begin(off = false): number {
    this.finish();
    this.kind = off || reducedMotion() ? 'none' : currentSwitch();
    const view = this.view();
    if (view && !off) {
      if (!this.bar?.isConnected) {
        this.bar = document.createElement('div');
        this.bar.className = 'tcv-switch-bar';
        this.bar.setAttribute('role', 'progressbar');
        this.bar.setAttribute('aria-label', 'Loading model');
        view.appendChild(this.bar);
      }
      this.bar.hidden = false;
    }
    const c = this.canvas();
    if (c && fades(this.kind)) {
      c.style.transition = `opacity ${FADE_MS}ms var(--tcv-ease)`;
      c.style.opacity = String(DIM);
    }
    return ++this.token;
  }

  /** The old scene's last frame, laid over the view as it looks now (dimmed),
   *  so the screen holds still while the new geometry is built under it.
   *  The drawing buffer is only readable in the task that painted it, so
   *  the viewer paints once more first. Returns the old camera. */
  freeze(token: number, rendered: boolean): Cam | null {
    if (token !== this.token || !rendered) return null;
    const v = this.viewer(), c = this.canvas(), view = this.view();
    let cam: Cam | null = null;
    try { cam = { position: [...v.getCameraPosition()], target: [...v.getCameraTarget()], zoom: v.getCameraZoom() }; }
    catch { /* not rendered yet */ }
    if (!fades(this.kind) || !c || !view || !c.width || !c.height) return cam;
    try {
      v.update(true, false);
      const shot = document.createElement('canvas');
      shot.width = c.width;
      shot.height = c.height;
      shot.getContext('2d')?.drawImage(c, 0, 0);
      const r = c.getBoundingClientRect(), o = view.getBoundingClientRect();
      shot.className = 'tcv-switch-still';
      Object.assign(shot.style, {
        left: `${r.left - o.left}px`, top: `${r.top - o.top}px`,
        width: `${r.width}px`, height: `${r.height}px`,
        opacity: getComputedStyle(c).opacity,
      });
      view.appendChild(shot);
      this.still = shot;
    } catch { /* no picture: the switch just has no still */ }
    return cam;
  }

  /** The new scene is in: the new model fades, grows, glides or comes in
   *  part by part. `from` is the old camera; none (or the same model again)
   *  is no glide. */
  land(token: number, from: Cam | null, sameModel: boolean) {
    if (token !== this.token) return;
    const c = this.canvas();
    let kind = this.kind;
    if (kind === 'stagger' && !this.stagger()) kind = 'fade';
    if (c) {
      c.style.transition = 'none';
      if (kind === 'fade' || kind === 'fade-scale' || kind === 'fade-glide') {
        c.style.opacity = '0';
        if (kind === 'fade-scale') c.style.transform = 'scale(.98)';
        void c.offsetWidth;            // the start state lands before the transition
        c.style.transition = `opacity ${FADE_MS}ms var(--tcv-ease), transform ${FADE_MS}ms var(--tcv-ease)`;
      }
      c.style.opacity = '';
      c.style.transform = '';
    }
    const still = this.still;
    this.still = null;
    if (still) {
      still.style.transition = `opacity ${FADE_MS}ms var(--tcv-ease)`;
      requestAnimationFrame(() => { still.style.opacity = '0'; });
      setTimeout(() => still.remove(), FADE_MS + 80);
    }
    if ((kind === 'glide' || kind === 'fade-glide') && from && !sameModel) this.glide(from);
  }

  /** The load is over, landed or not: the line goes, and a dim that never
   *  landed (a failed or superseded load) comes back up. */
  end(token: number) {
    if (token !== this.token) return;
    if (this.bar) this.bar.hidden = true;
    const c = this.canvas();
    if (c && c.style.opacity) { c.style.opacity = ''; }
    if (this.still) { this.still.remove(); this.still = null; }
  }

  /** Stop a glide where it is (the camera is being set from outside, or the
   *  user took hold of it). */
  halt() { this.stopGlide(); }

  /** Anything still moving, to its end at once: a new switch starts clean. */
  private finish() {
    cancelAnimationFrame(this.raf);
    const v = this.viewer();
    if (this.glideTo) { try { this.put(v, this.glideTo); } catch { /* scene gone */ } }
    this.stopGlide();
    if (this.hidden.length) {
      for (const g of this.hidden) g.visible = true;
      this.hidden = [];
      try { v?.update(true, false); } catch { /* scene gone */ }
    }
    this.still?.remove();
    this.still = null;
  }

  private put(v: any, s: Cam) {
    v.setCameraTarget(s.target, false);
    v.setCameraPosition(s.position, false, false);
    if (Math.abs(v.getCameraZoom() - s.zoom) > 1e-6) v.setCameraZoom(s.zoom, false);
  }

  /** From the old view to the one the viewer fitted to the new model:
   *  the target slides, the direction turns and the distance changes. */
  private glide(from: Cam) {
    const v = this.viewer();
    let to: Cam;
    try { to = { position: [...v.getCameraPosition()], target: [...v.getCameraTarget()], zoom: v.getCameraZoom() }; }
    catch { return; }
    const off = (s: Cam) => s.position.map((p, i) => p - s.target[i]);
    const a = off(from), b = off(to);
    const la = Math.hypot(...a) || 1, lb = Math.hypot(...b) || 1;
    const lerp = (x: number, y: number, t: number) => x + (y - x) * t;
    this.glideTo = to;
    const step = (t: number) => {
      const e = easeOut(t);
      const tgt = from.target.map((x, i) => lerp(x, to.target[i], e));
      const dir = a.map((x, i) => lerp(x / la, b[i] / lb, e));
      const ld = Math.hypot(...dir) || 1, dist = lerp(la, lb, e);
      this.put(v, { target: tgt, position: tgt.map((x, i) => x + dir[i] / ld * dist), zoom: lerp(from.zoom, to.zoom, e) });
    };
    step(0);
    const c = this.canvas();
    const grab = () => this.stopGlide();
    this.stopGlide = () => {
      cancelAnimationFrame(this.raf);
      this.glideTo = null;
      c?.removeEventListener('pointerdown', grab);
      c?.removeEventListener('wheel', grab);
      this.stopGlide = () => {};
    };
    c?.addEventListener('pointerdown', grab, { once: true });
    c?.addEventListener('wheel', grab, { once: true, passive: true });
    const t0 = performance.now();
    const tick = (now: number) => {
      // A frame's time can be from just before the glide began.
      const t = Math.min(Math.max((now - t0) / GLIDE_MS, 0), 1);
      try { step(t); } catch { this.stopGlide(); return; }
      if (t < 1) this.raf = requestAnimationFrame(tick);
      else this.stopGlide();
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** The new model's parts, bottom up, one after another; false (and
   *  nothing hidden) for a model with too few or too many to stage. */
  private stagger(): boolean {
    const v = this.viewer();
    let groups: any[];
    try {
      groups = Object.values(v.nestedGroup.groups ?? {})
        .filter((g: any) => typeof g?.setShapeVisible === 'function' && g.visible);
    } catch { return false; }
    if (groups.length < 2 || groups.length > STAGGER_MAX) return false;
    const low = new Map<any, number>();
    for (const g of groups) {
      const z = new Box3().setFromObject(g).min.z;
      low.set(g, Number.isFinite(z) ? z : 0);
    }
    groups.sort((x, y) => low.get(x)! - low.get(y)!);
    for (const g of groups) g.visible = false;
    this.hidden = groups;
    v.update(true, false);
    const gap = Math.min(60, STAGGER_MS / groups.length);
    const t0 = performance.now();
    const tick = (now: number) => {
      const due = Math.floor((now - t0) / gap) + 1;
      let shown = false;
      while (this.hidden.length && groups.length - this.hidden.length < due) {
        this.hidden.shift()!.visible = true;
        shown = true;
      }
      try { if (shown) v.update(true, false); } catch { this.hidden = []; return; }
      if (this.hidden.length) this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
    return true;
  }
}
