import { AfterViewInit, Component, ElementRef, OnDestroy, input, output, signal, viewChild } from '@angular/core';
import {
  AmbientLight, Box3, BoxGeometry, BufferGeometry, CylinderGeometry, DirectionalLight, EdgesGeometry, ExtrudeGeometry,
  Group, HemisphereLight, LineBasicMaterial, LineSegments, Material, Mesh, MeshStandardMaterial, Object3D,
  PerspectiveCamera, Scene, Shape, Sphere, Vector3, WebGLRenderer,
} from 'three';
import { T } from '../i18n';
import { ModelSwitch, SWITCHES, SWITCH_INFO, SwitchMotion, SwitchViewer, reducedMotion } from './model-switch';

/** One switch every this often, A to B and back. */
const LOOP_MS = 2000;
/** How long the preview's "load" takes: the part of a real switch where the
 *  old model waits, dimmed, under the progress line. */
const LOAD_MS = 350;

/** The 3D room's look: its edge colour and part material (ocp.ts render()). */
const EDGE = 0x707070;                                                  // theme:pigment - the viewer's edgeColor
const ALU = 0xc9ced6, STEEL = 0x6b7380, BRASS = 0xd9a441, DARK = 0x3c4048;  // theme:pigment - parts, not chrome

/** A small stage that stands in for three-cad-viewer: a plain scene, a
 *  perspective camera with Z up, and the slice of the Viewer's API the
 *  transition calls - so SwitchMotion runs on it exactly as in the 3D room. */
class Stage implements SwitchViewer {
  readonly renderer = new WebGLRenderer({ antialias: true, alpha: true });
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(30, 1, 1, 5000);
  readonly nestedGroup: { groups: Record<string, Object3D> } = { groups: {} };
  private target = new Vector3();
  private model: Group | null = null;

  constructor() {
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.debug.checkShaderErrors = false;
    this.camera.up.set(0, 0, 1);
    this.scene.add(new HemisphereLight(0xffffff, 0x50555c, 1.5));   // theme:pigment - light, not chrome
    this.scene.add(new AmbientLight(0xffffff, 0.5));                // theme:pigment
    const sun = new DirectionalLight(0xffffff, 1.8);                // theme:pigment
    sun.position.set(0.6, 1, 1.4);
    this.camera.add(sun);
    this.scene.add(this.camera);
  }

  getCameraPosition() { return this.camera.position.toArray(); }
  getCameraTarget() { return this.target.toArray(); }
  getCameraZoom() { return this.camera.zoom; }
  setCameraTarget(t: number[]) { this.target.fromArray(t); }
  setCameraPosition(p: number[]) { this.camera.position.fromArray(p); this.update(); }
  setCameraZoom(z: number) { this.camera.zoom = z; this.camera.updateProjectionMatrix(); this.update(); }
  update() {
    this.camera.lookAt(this.target);
    this.renderer.render(this.scene, this.camera);
  }

  size(w: number, h: number) {
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.update();
  }

  /** The new model in place of the old, the camera fitted to it the way
   *  the viewer fits a model it renders: from `eye`, the whole of it in view. */
  show(model: Group, eye: Vector3) {
    if (this.model) this.scene.remove(this.model);
    this.model = model;
    this.scene.add(model);
    this.nestedGroup.groups = Object.fromEntries(model.children.map(g => [g.name, g]));
    const ball = new Box3().setFromObject(model).getBoundingSphere(new Sphere());
    const fov = this.camera.fov * Math.PI / 180;
    const dist = ball.radius / Math.sin(Math.min(fov, fov * this.camera.aspect) / 2) * 1.08;
    this.target.copy(ball.center);
    this.camera.position.copy(ball.center).addScaledVector(eye.clone().normalize(), dist);
    this.update();
  }

  /** The renderer and everything drawn, `also` the model not on show. */
  dispose(also: Object3D[]) {
    for (const o of also) this.scene.add(o);
    this.scene.traverse(o => {
      const m = o as Mesh;
      m.geometry?.dispose();
      (m.material as Material | undefined)?.dispose?.();
    });
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}

/** A part: its meshes with edges, as the viewer draws a shape. The
 *  transition's "parts in turn" finds it by setShapeVisible, as it finds
 *  the viewer's ObjectGroups. */
function part(name: string, colour: number, pieces: [BufferGeometry, number[], number[]?][]): Group {
  const g = new Group();
  g.name = name;
  const mat = new MeshStandardMaterial({ color: colour, metalness: 0.3, roughness: 0.65,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const line = new LineBasicMaterial({ color: EDGE });
  for (const [geo, at, turn] of pieces) {
    const m = new Mesh(geo, mat);
    m.add(new LineSegments(new EdgesGeometry(geo, 25), line));
    m.position.fromArray(at);
    if (turn) m.rotation.set(turn[0], turn[1], turn[2]);
    g.add(m);
  }
  (g as unknown as { setShapeVisible: (on: boolean) => void }).setShapeVisible = on => { g.visible = on; };
  return g;
}

/** A cylinder standing on Z (three's stand on Y). */
const upright = (r: number, h: number, sides = 32): BufferGeometry => new CylinderGeometry(r, r, h, sides).rotateX(Math.PI / 2);

/** An angle bracket: base, upright, two gussets, two bolts and a pin. */
function bracket(): Group {
  const m = new Group();
  const web = new Shape();
  web.moveTo(0, 0); web.lineTo(26, 0); web.lineTo(0, 30); web.closePath();
  const gusset = new ExtrudeGeometry(web, { depth: 4, bevelEnabled: false }).rotateX(Math.PI / 2);
  const bolt = (x: number, y: number): [BufferGeometry, number[]][] =>
    [[upright(3, 10), [x, y, 11]], [upright(5.5, 4, 6), [x, y, 8]]];
  m.add(
    part('Base', ALU, [[new BoxGeometry(80, 40, 6), [0, 0, 3]]]),
    part('Upright', ALU, [[new BoxGeometry(6, 40, 50), [-37, 0, 31]]]),
    part('Gusset 1', STEEL, [[gusset, [-34, -12, 6]]]),
    part('Gusset 2', STEEL, [[gusset.clone(), [-34, 16, 6]]]),
    part('Bolt 1', DARK, bolt(12, -10)),
    part('Bolt 2', DARK, bolt(28, 10)),
    part('Pin', BRASS, [[upright(4, 22), [-37, 0, 46], [0, Math.PI / 2, 0]]]),
  );
  return m;
}

/** A small motor on its flange: flange, four screws, can, cap, shaft, pulley. */
function motor(): Group {
  const m = new Group();
  const screws: [BufferGeometry, number[]][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]]
    .map(([x, y]) => [upright(2.6, 4, 6), [x * 19, y * 19, 8]]);
  m.add(
    part('Flange', STEEL, [[new BoxGeometry(50, 50, 6), [0, 0, 3]]]),
    part('Screws', DARK, screws),
    part('Can', ALU, [[upright(19, 38), [0, 0, 25]]]),
    part('Cap', DARK, [[upright(20, 5), [0, 0, 46.5]]]),
    part('Shaft', STEEL, [[upright(3, 18), [0, 0, 58]]]),
    part('Pulley', BRASS, [[upright(9, 7), [0, 0, 62]]]),
  );
  return m;
}

/** Settings > Appearance > Model switch: what a transition looks like, on a
 *  small stage switching between two models every two seconds. The motion
 *  is the 3D room's own (SwitchMotion, model-switch.ts), with its timings;
 *  only the "load" is made up. The GL context goes with the dialog. */
@Component({
  selector: 'app-switch-preview',
  imports: [T],
  host: {
    class: 'sp-veil tcv-m-veil', '(click)': 'closed.emit()',
    '(document:keydown.escape)': 'closed.emit()',
  },
  styles: [`
    :host { position: fixed; inset: 0; z-index: 1100; display: flex; align-items: center; justify-content: center;
            padding: 24px; background: var(--scrim); }
    .sp-box { width: min(880px, 100%); max-height: calc(100vh - 48px); overflow: auto; box-sizing: border-box;
              display: flex; flex-direction: column; gap: 10px; padding: 12px 14px 14px;
              background: var(--surface); border: 1px solid var(--line); border-radius: 6px;
              box-shadow: 0 12px 36px var(--shadow-hard); outline: none; }
    .sp-head { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
    .sp-head h3 { margin: 0; flex: none; font-size: 13px; font-weight: 600; color: var(--ink-bright); }
    .sp-head p { margin: 0; min-width: 0; font-size: 12px; color: var(--ink-dim); }
    .sp-head .sp-x { margin-left: auto; flex: none; }
    .sp-stage { position: relative; height: 380px; border-radius: 6px; overflow: hidden; border: 1px solid var(--line);
                background: linear-gradient(180deg, var(--view-top) 0%, var(--view-mid) 55%, var(--view-bottom) 100%); }
    .sp-stage canvas { display: block; }
    .sp-note { position: absolute; left: 8px; bottom: 6px; font-size: 11px; color: var(--ink-dim); pointer-events: none; }
    .sp-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .sp-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; }
    .sp-seg button { padding: 3px 9px; font-size: 11px; white-space: nowrap; color: var(--ink-dim); background: var(--surface-2);
                     border: 0; cursor: pointer; }
    .sp-seg button + button { border-left: 1px solid var(--line); }
    .sp-seg button:hover { color: var(--ink); background: var(--hover); }
    .sp-seg button.on { color: var(--ink-bright); background: var(--accent-deep); }
    .sp-foot .tcv-btn { display: inline-flex; align-items: center; gap: 5px; }
    .sp-foot svg { width: 12px; height: 12px; }
    .sp-gap { flex: 1; }
    @media (max-width: 640px) { :host { padding: 8px; } .sp-stage { height: 260px; } .sp-head { flex-wrap: wrap; } }
  `],
  template: `
    <div #box class="sp-box tcv-m-box" role="dialog" aria-modal="true" tabindex="-1"
         [attr.aria-label]="info[kind()].name | t" (click)="$event.stopPropagation()">
      <div class="sp-head">
        <h3>{{ info[kind()].name | t }}</h3>
        <p>{{ info[kind()].about | t }}</p>
        <button type="button" class="tcv-btn sp-x" (click)="closed.emit()" [attr.aria-label]="'Close' | t">&times;</button>
      </div>
      <div #stage class="sp-stage">
        @if (reduced) { <span class="sp-note">{{ 'Your system asks for reduced motion, so models switch at once.' | t }}</span> }
      </div>
      <div class="sp-foot">
        <div class="sp-seg" role="group">
          @for (s of switches; track s) {
            <button type="button" [class.on]="kind() === s" [attr.aria-pressed]="kind() === s" (click)="choose(s)">{{ info[s].name | t }}</button>
          }
        </div>
        <button type="button" class="tcv-btn" (click)="run()">
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>{{ 'Replay' | t }}</button>
        <span class="sp-gap"></span>
        <button type="button" class="tcv-btn" (click)="closed.emit()">{{ 'Close' | t }}</button>
        <button type="button" class="tcv-btn tcv-btn-accent" (click)="pick.emit(kind())">{{ 'Use this one' | t }}</button>
      </div>
    </div>
  `,
})
export class SwitchPreview implements AfterViewInit, OnDestroy {
  /** The transition to show first. */
  start = input<ModelSwitch>('fade-glide');
  /** "Use this one": the transition on show. */
  pick = output<ModelSwitch>();
  closed = output<void>();

  readonly switches = SWITCHES;
  readonly info = SWITCH_INFO;
  readonly reduced = reducedMotion();
  kind = signal<ModelSwitch>('fade-glide');

  private box = viewChild.required<ElementRef<HTMLElement>>('box');
  private host = viewChild.required<ElementRef<HTMLElement>>('stage');
  private stage: Stage | null = null;
  private motion = new SwitchMotion(() => this.host().nativeElement, () => this.stage?.renderer.domElement ?? null,
                                    () => this.stage);
  private ro?: ResizeObserver;
  private timer = 0;
  /** The two models and the angle each is seen from: the old one as if it
   *  had been turned a little, so a glide also turns. */
  private models: { group: Group; eye: Vector3 }[] = [];
  private on = 0;

  ngAfterViewInit() {
    this.kind.set(this.start());
    this.box().nativeElement.focus();
    const el = this.host().nativeElement;
    try { this.stage = new Stage(); } catch { return; }    // no WebGL: the stage stays empty
    el.prepend(this.stage.renderer.domElement);
    this.models = [{ group: bracket(), eye: new Vector3(1.1, -1.4, 0.9) },
                   { group: motor(), eye: new Vector3(-0.7, -1.3, 0.8) }];
    this.ro = new ResizeObserver(() => {
      if (el.clientWidth && el.clientHeight) this.stage?.size(el.clientWidth, el.clientHeight);
    });
    this.ro.observe(el);
    this.stage.size(el.clientWidth || 600, el.clientHeight || 300);
    this.run();
  }

  ngOnDestroy() {
    clearTimeout(this.timer);
    this.ro?.disconnect();
    this.motion.stop();
    this.stage?.dispose(this.models.map(m => m.group));
    this.stage = null;
  }

  choose(s: ModelSwitch) { this.kind.set(s); this.run(); }

  /** From the start: the bracket at rest, then the switches. */
  run() {
    if (!this.stage) return;
    clearTimeout(this.timer);
    this.motion.stop();
    this.on = 0;
    this.stage.show(this.models[0].group, this.models[0].eye);
    this.timer = setTimeout(() => this.next(), LOOP_MS / 2);
  }

  /** One switch, the way OcpViewer.load() makes it: begin, the load, the
   *  old frame frozen, the new scene, land, end. */
  private next() {
    const stage = this.stage;
    if (!stage) return;
    const to = this.models[1 - this.on];
    const token = this.motion.begin(false, this.kind());
    this.timer = setTimeout(() => {
      const from = this.motion.freeze(token, true);
      stage.show(to.group, to.eye);
      this.motion.land(token, from, false);
      this.motion.end(token);
      this.on = 1 - this.on;
      this.timer = setTimeout(() => this.next(), LOOP_MS - LOAD_MS);
    }, LOAD_MS);
  }
}
