import { t } from '../i18n';
import { stepValue } from './clip-wheel';
import {
  IDENTITY, Joint, M4, V3, apply, applyDir, cablePath, compose, decompose, invert, localFor, mul,
  samplePath, sweep, tube,
} from './motion-math';

/** Parts that move in the 3D room: what a model declares as MOTIONS
 *  (backend/motions.py; the build checks it and puts it in the viewer
 *  payload as `motions`).
 *
 *  - a spin turns all the time (rpm), with play/pause and a speed;
 *  - a range is set by hand (degrees): a slider, the mouse wheel over it
 *    (one notch 1 degree, Shift 10, like the Clip tab's sliders), and
 *    "auto", which sweeps it back and forth;
 *  - a flexible part (a cable) follows a range: away from its default it
 *    is drawn live as a tube along the centre line the model gives for
 *    that value, and the model's own part is hidden; at the default the
 *    model's own part is shown.
 *
 *  The motion is done here, on three-cad-viewer's own groups: each moved
 *  group's local matrix is set so its world matrix is the motion's
 *  transform times where it was at rest. Motions compose - a child's own
 *  rotation first, then the parent's that carries it (motion-math.ts) -
 *  so the rotor keeps spinning about its tilted axis while the tilt is
 *  dragged. Picking, measuring and clipping work on world matrices and
 *  follow; the tree's eye toggles work on the meshes inside the groups
 *  and are untouched. Explode starts from the rest pose (the motions
 *  stand aside while it is on). Visual only: nothing checks collisions.
 *
 *  Spins are not kept with a note and stop at their rest pose when a
 *  note's view goes in; the hand-set values are (NoteView.motions). */

export interface MotionSpec {
  name: string;
  kind: 'spin' | 'range' | 'flex';
  parts: string[];
  label?: string;
  axis?: V3;
  pivot?: V3;
  on?: string | null;
  rpm?: number;
  range?: [number, number];
  default?: number;
  follows?: string;
  radius?: number;
  path?: { values: number[]; points: number[][][] };
  from?: { at: V3; dir: V3 };
  to?: { at: V3; dir: V3 };
  length?: number;
}

interface Target {
  group: any;
  depth: number;
  motion: string;
  rest: { p: number[]; q: number[]; s: number[] };
  restWorld: M4;
}

interface Flex {
  spec: MotionSpec;
  group: any;
  mesh: any | null;
  drawnAt: number | null;
}

/** One notch of the wheel over a slider, in degrees; Shift ×10. */
export const WHEEL_DEG = 1;
const NOTCH_PX = 40;
/** A full sweep low -> high -> low, seconds. */
const SWEEP_S = 6;
/** Frames a second while something moves by itself: enough to read a
 *  turning fan, half the GPU of 60. */
const FPS = 30;
/** Above this the blades alias into a slow crawl at FPS frames a second. */
const SHOWN_RPM = 60;

const reducedMotion = () => {
  try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

export class Motions {
  specs: MotionSpec[] = [];
  /** Hand-set values of the range motions, degrees. */
  values: Record<string, number> = {};
  /** Spins: the angle they have turned (deg), whether they turn, how fast (rpm). */
  phase: Record<string, number> = {};
  playing: Record<string, boolean> = {};
  rpm: Record<string, number> = {};
  /** Range motions sweeping by themselves. */
  auto: Record<string, boolean> = {};

  private viewer: any = null;
  private targets: Target[] = [];
  private flexes: Flex[] = [];
  private frame: M4 = [...IDENTITY];
  private raf = 0;
  private last = 0;
  private sweepT: Record<string, number> = {};
  /** Explode is on, or the view is frozen: nothing moves. */
  private suspended = false;
  private held = false;
  private panel: HTMLElement | null = null;
  private acc = 0;
  /** No spin starts by itself (tools/render.py's shot, reduced motion). */
  still = false;

  constructor(private root: HTMLElement) {
    root.addEventListener('wheel', this.onWheel, { passive: false });
  }

  get any(): boolean { return this.specs.length > 0; }

  // ---------------------------------------------------------------- set up

  /** A freshly rendered model: its motions at their rest pose. */
  setup(viewer: any, specs: MotionSpec[] | null | undefined) {
    this.clear();
    this.viewer = viewer;
    this.specs = Array.isArray(specs) ? specs.filter(s => s && s.name && s.kind) : [];
    if (!this.specs.length) return;
    let groups: Record<string, any>;
    try { groups = viewer.nestedGroup.groups; } catch { this.specs = []; return; }
    const paths = Object.keys(groups);
    const top = paths.length ? groups['/' + paths[0].split('/')[1]] : null;
    const host = top?.parent;
    host?.updateWorldMatrix?.(true, true);
    top?.updateWorldMatrix?.(true, true);
    this.frame = host?.matrixWorld ? [...host.matrixWorld.elements] : [...IDENTITY];

    const byName = new Map(this.specs.map(s => [s.name, s]));
    // Which motion moves a group listed by two: the one that rides on the other.
    const chain = (n: string): string[] => {
      const out: string[] = [];
      for (let at: string | null | undefined = n; at && out.length < 32; at = byName.get(at)?.on) out.push(at);
      return out;
    };
    const owner = new Map<string, string>();
    for (const s of this.specs) {
      if (s.kind === 'flex') continue;
      for (const p of s.parts) {
        if (!groups[p]) { console.warn(`motion ${s.name}: no group ${p}`); continue; }
        const was = owner.get(p);
        if (!was || chain(s.name).includes(was)) owner.set(p, s.name);
      }
    }
    for (const [p, m] of owner) {
      const g = groups[p];
      this.targets.push({
        group: g, depth: p.split('/').length, motion: m,
        rest: { p: g.position.toArray(), q: g.quaternion.toArray(), s: g.scale.toArray() },
        restWorld: [...g.matrixWorld.elements],
      });
    }
    this.targets.sort((a, b) => a.depth - b.depth);
    for (const s of this.specs) {
      if (s.kind === 'range') {
        this.values[s.name] = s.default ?? 0;
        this.auto[s.name] = false;
      } else if (s.kind === 'spin') {
        this.phase[s.name] = 0;
        this.rpm[s.name] = Math.min(Math.abs(s.rpm ?? SHOWN_RPM), SHOWN_RPM) * Math.sign(s.rpm ?? 1);
        this.playing[s.name] = !this.still && !reducedMotion();
      } else if (s.kind === 'flex' && groups[s.parts[0]]) {
        this.flexes.push({ spec: s, group: groups[s.parts[0]], mesh: null, drawnAt: null });
      }
    }
    this.wrapViewer(viewer);
    this.buildPanel();
    this.apply();
    this.kick();
  }

  /** The model is going: put every group back, take the tubes out. */
  clear() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.restore();
    for (const f of this.flexes) this.dropTube(f);
    this.targets = [];
    this.flexes = [];
    this.specs = [];
    this.values = {}; this.phase = {}; this.playing = {}; this.rpm = {}; this.auto = {};
    this.sweepT = {};
    this.panel?.remove();
    this.panel = null;
  }

  /** The explode switch and the render hook, once per viewer. */
  private wrapViewer(v: any) {
    if (v.__redlineMotions) return;
    v.__redlineMotions = true;
    const setExplode = v.setExplode.bind(v);
    v.setExplode = (flag: boolean, notify = true) => {
      // Explode measures every part where it is: from the rest pose, or
      // the parts would fly out along tilted directions and come back
      // somewhere else.
      if (flag) this.suspend(true);
      setExplode(flag, notify);
      if (!flag) this.suspend(false);
    };
    // Every repaint (an eye toggled in the tree, a material change) brings
    // the cable's tube in line with the part it stands in for.
    const update = v.update;
    v.update = (marker: boolean, notify?: boolean) => {
      try {
        this.syncTubes();
        // Explode switched off some other way (a measuring tool taking over).
        if (this.suspended && v.state?.get?.('animationMode') !== 'explode') {
          setTimeout(() => {
            if (this.suspended && v.state?.get?.('animationMode') !== 'explode') this.suspend(false);
          }, 150);
        }
      } catch { /* never in the way of a repaint */ }
      return update(marker, notify);
    };
  }

  // ---------------------------------------------------------------- the pose

  private joints(): Record<string, Joint> {
    const out: Record<string, Joint> = {};
    for (const s of this.specs) {
      if (s.kind === 'flex' || !s.axis || !s.pivot) continue;
      out[s.name] = { axis: s.axis, pivot: s.pivot, on: s.on ?? null };
    }
    return out;
  }

  /** How far each rigid motion is from its rest pose, degrees. */
  private angles(): Record<string, number> {
    const a: Record<string, number> = {};
    for (const s of this.specs) {
      if (s.kind === 'range') a[s.name] = (this.values[s.name] ?? 0) - (s.default ?? 0);
      else if (s.kind === 'spin') a[s.name] = this.phase[s.name] ?? 0;
    }
    return a;
  }

  /** Every moved group where the motions put it, the tubes redrawn, one repaint. */
  apply(render = true) {
    if (!this.viewer || !this.specs.length) return;
    if (this.suspended) return;
    const T = compose(this.joints(), this.angles());
    for (const tg of this.targets) {
      const m = T[tg.motion] ?? IDENTITY;
      const parent = tg.group.parent;
      parent?.updateWorldMatrix?.(true, false);
      const pw: M4 = parent ? [...parent.matrixWorld.elements] : [...IDENTITY];
      const d = decompose(localFor(m, this.frame, tg.restWorld, pw));
      tg.group.position.set(...d.position);
      tg.group.quaternion.set(...d.quaternion);
      tg.group.scale.set(...d.scale);
      tg.group.updateMatrixWorld(true);
    }
    for (const f of this.flexes) this.drawTube(f, T);
    if (render) this.repaint();
  }

  /** Back to how the model was loaded: the groups' own transforms, the
   *  model's cable shown. */
  private restore() {
    for (const tg of this.targets) {
      tg.group.position.fromArray(tg.rest.p);
      tg.group.quaternion.fromArray(tg.rest.q);
      tg.group.scale.fromArray(tg.rest.s);
      tg.group.updateMatrixWorld(true);
    }
    for (const f of this.flexes) {
      f.group.visible = true;
      if (f.mesh) f.mesh.visible = false;
    }
  }

  private repaint() {
    const v = this.viewer;
    if (!v) return;
    // While three-cad-viewer runs its own loop (an animation) it paints.
    if (v.hasAnimationLoop) return;
    try { v.update(false, false); } catch { /* not rendered yet */ }
  }

  suspend(on: boolean) {
    if (on === this.suspended) return;
    if (on) {
      this.restore();
      this.suspended = true;
    } else {
      this.suspended = false;
      this.apply();
    }
    this.paint();
    this.kick();
  }

  /** Frozen for drawing: the spin and the sweep stop where they are. */
  hold(on: boolean) {
    this.held = on;
    this.kick();
  }

  // ---------------------------------------------------------------- flexible parts

  private centreLine(s: MotionSpec, T: Record<string, M4>): V3[] {
    const v = this.values[s.follows!] ?? 0;
    if (s.path) return samplePath(s.path.values, s.path.points, v);
    if (s.from && s.to && s.length) {
      const m = T[s.follows!] ?? IDENTITY;
      return cablePath(apply(m, s.from.at), applyDir(m, s.from.dir), s.to.at, s.to.dir, s.length);
    }
    return [];
  }

  private drawTube(f: Flex, T: Record<string, M4>) {
    const s = f.spec, follows = this.specs.find(x => x.name === s.follows);
    const v = this.values[s.follows!] ?? 0;
    const atRest = !follows || Math.abs(v - (follows.default ?? 0)) < 1e-6;
    if (atRest) {
      f.group.visible = true;
      if (f.mesh) f.mesh.visible = false;
      return;
    }
    if (f.drawnAt !== v || !f.mesh) {
      const parent = f.group.parent;
      const front = f.group.front;
      if (!parent || !front) return;
      parent.updateWorldMatrix?.(true, false);
      const toLocal = mul(invert([...parent.matrixWorld.elements]), this.frame);
      const line = this.centreLine(s, T).map(p => apply(toLocal, p));
      const g = tube(line, s.radius ?? 1, 14);
      const geo = new front.geometry.constructor();
      const Attr = front.geometry.getAttribute('position')?.constructor;
      if (!Attr || front.geometry.getAttribute('position')?.isInterleavedBufferAttribute) return;
      geo.setAttribute('position', new Attr(new Float32Array(g.position), 3));
      geo.setAttribute('normal', new Attr(new Float32Array(g.normal), 3));
      // Whatever else the viewer's shader reads per vertex (its face ids
      // for highlighting), of the same type, zero: the tube is not picked.
      const count = g.position.length / 3;
      for (const [k, a] of Object.entries(front.geometry.attributes as Record<string, any>)) {
        if (k === 'position' || k === 'normal' || a.isInterleavedBufferAttribute) continue;
        geo.setAttribute(k, new a.constructor(new a.array.constructor(count * a.itemSize), a.itemSize));
      }
      geo.setIndex(g.index);
      geo.computeBoundingSphere();
      if (!f.mesh) {
        f.mesh = new front.constructor(geo, front.material);
        f.mesh.name = `${f.group.name ?? ''} (live)`;
        // Not a part: clicks and measurements go through it to what is there.
        f.mesh.raycast = () => {};
        f.mesh.renderOrder = front.renderOrder;
        parent.add(f.mesh);
      } else {
        f.mesh.geometry.dispose();
        f.mesh.geometry = geo;
      }
      f.drawnAt = v;
    }
    f.group.visible = false;
    f.mesh.visible = !!f.group.front?.visible;
    f.mesh.material = f.group.front?.material ?? f.mesh.material;
  }

  private syncTubes() {
    for (const f of this.flexes) {
      if (f.mesh && !f.group.visible) {
        f.mesh.visible = !!f.group.front?.visible;
        f.mesh.material = f.group.front?.material ?? f.mesh.material;
      }
    }
  }

  private dropTube(f: Flex) {
    if (!f.mesh) return;
    f.mesh.parent?.remove(f.mesh);
    f.mesh.geometry?.dispose?.();
    f.mesh = null;
    f.drawnAt = null;
  }

  // ---------------------------------------------------------------- what moves by itself

  private moving(): boolean {
    if (this.suspended || this.held) return false;
    return this.specs.some(s => (s.kind === 'spin' && this.playing[s.name])
                             || (s.kind === 'range' && this.auto[s.name]));
  }

  /** Start the frame loop when something turns by itself, stop it when not. */
  private kick() {
    if (!this.moving()) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      return;
    }
    if (this.raf) return;
    this.last = performance.now();
    const tick = (now: number) => {
      this.raf = 0;
      if (!this.moving()) return;
      const dt = (now - this.last) / 1000;
      // The 3D room is off screen: nothing to paint, nothing to spend.
      const shown = this.root.isConnected && this.root.getClientRects().length > 0;
      if (dt >= 1 / FPS - 0.004 && shown) {
        this.last = now;
        this.step(Math.min(dt, 0.25));
        this.apply();
        this.paintValues();
      } else if (!shown) {
        this.last = now;
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private step(dt: number) {
    for (const s of this.specs) {
      if (s.kind === 'spin' && this.playing[s.name]) {
        this.phase[s.name] = ((this.phase[s.name] ?? 0) + (this.rpm[s.name] ?? 0) * 6 * dt) % 360;
      } else if (s.kind === 'range' && this.auto[s.name] && s.range) {
        this.sweepT[s.name] = (this.sweepT[s.name] ?? 0) + dt;
        this.values[s.name] = Math.round(sweep(s.range[0], s.range[1], this.sweepT[s.name], SWEEP_S) * 100) / 100;
      }
    }
  }

  // ---------------------------------------------------------------- outside callers

  /** A range motion, set by hand (clamped). */
  set(name: string, value: number) {
    const s = this.specs.find(x => x.name === name && x.kind === 'range');
    if (!s || !Number.isFinite(value)) return;
    const [lo, hi] = s.range ?? [value, value];
    this.values[name] = Math.min(Math.max(value, lo), hi);
    this.apply();
    this.paintValues();
  }

  /** The hand-set values, for a note (NoteView.motions); null when the
   *  model has no range motion. */
  captured(): Record<string, number> | null {
    const out: Record<string, number> = {};
    for (const s of this.specs) if (s.kind === 'range') out[s.name] = Math.round((this.values[s.name] ?? 0) * 1e4) / 1e4;
    return Object.keys(out).length ? out : null;
  }

  /** A note's values back (a missing one at its default); spins and
   *  sweeps stop, the spins at their rest pose - a note shows a still. */
  restoreValues(vals: Record<string, number> | null | undefined) {
    for (const s of this.specs) {
      if (s.kind === 'range') {
        const v = vals?.[s.name];
        const [lo, hi] = s.range ?? [0, 0];
        this.values[s.name] = typeof v === 'number' && Number.isFinite(v)
          ? Math.min(Math.max(v, lo), hi) : s.default ?? 0;
        this.auto[s.name] = false;
      } else if (s.kind === 'spin') {
        this.playing[s.name] = false;
        this.phase[s.name] = 0;
      }
    }
    this.apply();
    this.paint();
    this.kick();
  }

  /** What the scene shows now, for tools/render.py. */
  readback(): { motions: Record<string, number>; spin_rest: boolean } {
    const motions: Record<string, number> = {};
    for (const s of this.specs) if (s.kind === 'range') motions[s.name] = this.values[s.name] ?? 0;
    const spin_rest = this.specs.every(s => s.kind !== 'spin'
      || (!this.playing[s.name] && Math.abs(this.phase[s.name] ?? 0) < 1e-9));
    return { motions, spin_rest };
  }

  /** Every spin to `on`; used by the page's tests too. */
  play(name: string, on: boolean) {
    if (!this.specs.some(s => s.name === name && s.kind === 'spin')) return;
    this.playing[name] = on;
    this.paint();
    this.kick();
  }

  // ---------------------------------------------------------------- the panel

  private label(s: MotionSpec): string { return s.label || s.name; }

  private buildPanel() {
    const view = this.root.querySelector('.tcv_cad_view');
    const rows = this.specs.filter(s => s.kind !== 'flex');
    if (!view || !rows.length) return;
    const el = document.createElement('div');
    el.className = 'tcv-motion';
    el.setAttribute('role', 'group');
    el.innerHTML = '<div class="tcv-motion-head"><span class="tcv-motion-title"></span>' +
      '<button type="button" class="tcv-motion-fold" aria-expanded="true">−</button></div>' +
      '<div class="tcv-motion-body"></div>';
    const body = el.querySelector('.tcv-motion-body')!;
    for (const s of rows) {
      const row = document.createElement('div');
      row.className = 'tcv-motion-row';
      row.dataset['motion'] = s.name;
      row.dataset['kind'] = s.kind;
      const name = document.createElement('span');
      name.className = 'tcv-motion-name';
      name.textContent = this.label(s);
      if (s.kind === 'spin') {
        const play = document.createElement('button');
        play.type = 'button';
        play.className = 'tcv-motion-play';
        play.addEventListener('click', () => this.play(s.name, !this.playing[s.name]));
        const speed = document.createElement('input');
        speed.type = 'range';
        speed.className = 'tcv-motion-speed';
        speed.min = '1';
        speed.max = String(Math.max(1, Math.round(Math.abs(s.rpm ?? SHOWN_RPM))));
        speed.step = '1';
        speed.value = String(Math.round(Math.abs(this.rpm[s.name])));
        speed.addEventListener('input', () => {
          this.rpm[s.name] = Number(speed.value) * Math.sign(s.rpm ?? 1);
          this.paintValues();
        });
        const val = document.createElement('span');
        val.className = 'tcv-motion-val';
        row.append(play, name, speed, val);
      } else {
        const range = document.createElement('input');
        range.type = 'range';
        range.className = 'tcv-motion-range';
        range.min = String(s.range![0]);
        range.max = String(s.range![1]);
        range.step = '0.5';
        range.value = String(this.values[s.name]);
        range.addEventListener('input', () => {
          this.auto[s.name] = false;
          this.set(s.name, Number(range.value));
          this.paint();
          this.kick();
        });
        const val = document.createElement('span');
        val.className = 'tcv-motion-val';
        const autoBtn = document.createElement('button');
        autoBtn.type = 'button';
        autoBtn.className = 'tcv-motion-auto';
        autoBtn.addEventListener('click', () => {
          this.auto[s.name] = !this.auto[s.name];
          if (this.auto[s.name] && s.range) {
            // Start the sweep from where the slider is, not from the low end.
            const [lo, hi] = s.range, f = (this.values[s.name] - lo) / (hi - lo || 1);
            this.sweepT[s.name] = (Math.acos(Math.min(Math.max(1 - 2 * f, -1), 1)) / Math.PI) * SWEEP_S / 2;
          }
          this.paint();
          this.kick();
        });
        const reset = document.createElement('button');
        reset.type = 'button';
        reset.className = 'tcv-motion-reset';
        reset.textContent = '⟲';
        reset.addEventListener('click', () => {
          this.auto[s.name] = false;
          this.set(s.name, s.default ?? 0);
          this.paint();
          this.kick();
        });
        row.append(name, range, val, autoBtn, reset);
      }
      body.appendChild(row);
    }
    if (this.flexes.length) {
      const note = document.createElement('div');
      note.className = 'tcv-motion-note';
      body.appendChild(note);
    }
    const fold = el.querySelector<HTMLButtonElement>('.tcv-motion-fold')!;
    fold.addEventListener('click', () => {
      const shut = el.dataset['shut'] !== '1';
      el.dataset['shut'] = shut ? '1' : '0';
      fold.textContent = shut ? '+' : '−';
      fold.setAttribute('aria-expanded', String(!shut));
    });
    view.appendChild(el);
    this.panel = el;
    this.relabel();
  }

  /** The words, in the language on now. */
  relabel() {
    const el = this.panel;
    if (!el) return;
    el.setAttribute('aria-label', t('Motion'));
    el.querySelector('.tcv-motion-title')!.textContent = t('Motion');
    el.title = t('Moving parts are shown only: nothing checks that they do not collide.');
    el.querySelector('.tcv-motion-fold')!.setAttribute('title', t('Fold'));
    el.querySelectorAll<HTMLElement>('.tcv-motion-row').forEach(row => {
      const s = this.specs.find(x => x.name === row.dataset['motion']);
      if (!s) return;
      if (s.kind === 'spin') {
        row.querySelector('.tcv-motion-speed')!.setAttribute('aria-label', `${this.label(s)} - ${t('speed')} (rpm)`);
        row.title = t('Spins all the time; the speed is for watching it, the model says') + ` ${Math.abs(s.rpm ?? 0)} rpm.`;
      } else {
        row.querySelector('.tcv-motion-range')!.setAttribute('aria-label', `${this.label(s)} (°)`);
        row.querySelector('.tcv-motion-auto')!.textContent = t('auto');
        row.querySelector('.tcv-motion-auto')!.setAttribute('title', t('Sweep back and forth by itself'));
        row.querySelector('.tcv-motion-reset')!.setAttribute('title', t('Back to the pose the model is built in') + ` (${s.default ?? 0}°)`);
        row.title = t('Set by hand. Mouse wheel over the slider: 1°, Shift: 10°.');
      }
    });
    const note = el.querySelector('.tcv-motion-note');
    if (note) {
      const names = this.flexes.map(f => this.label(f.spec)).join(', ');
      note.textContent = t('Bends with the motion, drawn live:') + ' ' + names;
      (note as HTMLElement).title = t('A visual guess of the flexible part between its two ends. The model as built (the default pose) is the one to check clearances and print from.');
    }
    this.paint();
  }

  /** Buttons and sliders follow the state. */
  private paint() {
    const el = this.panel;
    if (!el) return;
    el.dataset['off'] = this.suspended ? '1' : '0';
    el.querySelectorAll<HTMLElement>('.tcv-motion-row').forEach(row => {
      const n = row.dataset['motion']!;
      const play = row.querySelector<HTMLButtonElement>('.tcv-motion-play');
      if (play) {
        const on = !!this.playing[n];
        play.textContent = on ? '❚❚' : '▶';
        play.setAttribute('aria-pressed', String(on));
        play.setAttribute('aria-label', on ? t('Pause') : t('Play'));
        play.title = on ? t('Pause') : t('Play');
      }
      const auto = row.querySelector<HTMLButtonElement>('.tcv-motion-auto');
      if (auto) {
        auto.dataset['on'] = this.auto[n] ? '1' : '0';
        auto.setAttribute('aria-pressed', String(!!this.auto[n]));
      }
      row.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')
        .forEach(c => { c.disabled = this.suspended; });
    });
    this.paintValues();
  }

  private paintValues() {
    const el = this.panel;
    if (!el) return;
    el.querySelectorAll<HTMLElement>('.tcv-motion-row').forEach(row => {
      const n = row.dataset['motion']!;
      const val = row.querySelector('.tcv-motion-val')!;
      if (row.dataset['kind'] === 'spin') {
        val.textContent = `${Math.round(Math.abs(this.rpm[n] ?? 0))} rpm`;
      } else {
        const v = this.values[n] ?? 0;
        val.textContent = `${v.toFixed(1)}°`;
        const range = row.querySelector<HTMLInputElement>('.tcv-motion-range')!;
        if (document.activeElement !== range || this.auto[n]) range.value = String(v);
      }
    });
  }

  private onWheel = (e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey) return;
    const range = e.target instanceof HTMLInputElement && e.target.classList.contains('tcv-motion-range')
      ? e.target : null;
    if (!range || range.disabled) return;
    e.preventDefault();
    e.stopPropagation();
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
    const name = (range.closest('.tcv-motion-row') as HTMLElement | null)?.dataset['motion'];
    if (!name) return;
    const cur = this.values[name] ?? 0;
    const next = stepValue(cur, dir, WHEEL_DEG * (e.shiftKey ? 10 : 1), Number(range.min), Number(range.max));
    if (next === cur) return;
    this.auto[name] = false;
    this.set(name, next);
    this.paint();
    this.kick();
  };
}
