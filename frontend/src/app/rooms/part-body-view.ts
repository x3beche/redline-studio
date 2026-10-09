import { AfterViewInit, Component, ElementRef, OnDestroy, effect, input, signal, untracked, viewChild } from '@angular/core';
import {
  AmbientLight, Box3, BufferAttribute, BufferGeometry, Color, DirectionalLight, DoubleSide, Group, HemisphereLight,
  LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D,
  PerspectiveCamera, Quaternion, Scene, Shape, ShapeGeometry, Path, Vector2, Vector3, WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { T } from '../i18n';
import { fetchBytes, fetchJson } from './part-assets';

/** One WebGL context for every part card opened: making one costs more
 *  than the part it shows, and a browser keeps only a handful alive. The
 *  card that is open borrows its canvas and gives it back on closing. */
let shared: WebGLRenderer | null = null;
function sharedRenderer(): WebGLRenderer {
  if (!shared) {
    shared = new WebGLRenderer({ antialias: true, alpha: true });
    shared.setPixelRatio(Math.min(devicePixelRatio, 2));
    // Asking the driver for a shader's log waits for it to compile: a
    // stall on every new material, for a check only a developer reads.
    shared.debug.checkShaderErrors = false;
  }
  return shared;
}

/** What the part card's 3D shows: LCSC's GLB (`/api/parts/{C}/model.glb`)
 *  or a drawn body's build, the 3D room's viewer payload
 *  (`/api/models/{id}/viewer.json`). */
export interface BodySource { kind: 'glb' | 'tcv'; url: string }

/** The footprint, in the component frame (`/api/parts/{C}/body-spec`). */
export interface BodySpec {
  pads?: { x: number; y: number; w: number; h: number; rot?: number; shape?: string; drill?: number | null }[];
  lcsc_box?: { x: number[]; y: number[]; z: number[]; size: number[] } | null;
  outline?: Record<string, { x: number[]; y: number[] }>;
}

/** One body of a part, turned in the hand, in the component frame: mm, Z up,
 *  z = 0 the board's top surface. A drawn body is built in that frame and
 *  shown as it is. LCSC's GLB comes Y up in EasyEDA's own origin; turned Z
 *  up, it is moved onto LCSC's seated box (the body spec's `lcsc_box`) when
 *  the sizes agree - so switching bodies keeps them on the same pads. A
 *  faint piece of board with the pads on it marks z = 0.
 *
 *  Drawn only when something changed, as the Files viewer is (mesh-view.ts). */
@Component({
  selector: 'app-part-body-view',
  imports: [T],
  styles: [`
    :host { display: block; position: relative; height: 100%; min-height: 0; }
    .pbv-host { position: absolute; inset: 0; }
    .pbv-host canvas { display: block; }
    .pbv-note { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
                gap: 6px; font-size: 11px; color: var(--ink-dim); pointer-events: none; }
    .pbv-note[data-err] { color: var(--danger); }
    .pbv-spin { width: 10px; height: 10px; border-radius: 50%; border: 1.5px solid var(--line);
                border-top-color: var(--accent); animation: pbv-turn .8s linear infinite; }
    @keyframes pbv-turn { to { transform: rotate(360deg); } }
    .pbv-tag { position: absolute; left: 8px; top: 6px; font: 10px 'IBM Plex Mono', ui-monospace, monospace;
               color: var(--ink-dim); pointer-events: none; }
    .pbv-fit { position: absolute; right: 6px; bottom: 6px; display: inline-flex; border: 1px solid var(--line);
               border-radius: 4px; overflow: hidden; }
    .pbv-fit button { padding: 1px 7px; font-size: 10.5px; color: var(--ink-dim); background: var(--surface);
                      border: 0; cursor: pointer; }
    .pbv-fit button + button { border-left: 1px solid var(--line); }
    .pbv-fit button:hover { color: var(--ink); background: var(--hover); }
  `],
  template: `
    <div #host class="pbv-host"></div>
    @if (note()) {
      <div class="pbv-note" [attr.data-err]="failed() ? 1 : null">
        @if (!failed()) { <span class="pbv-spin"></span> }{{ note() | t }}
      </div>
    } @else {
      <span class="pbv-tag">{{ size() }}@if (seated()) { · z = 0 {{ 'board top' | t }} }</span>
      <div class="pbv-fit" role="group" [attr.aria-label]="'View' | t">
        <button (click)="view('iso')" [title]="'Fit to the window' | t">{{ 'Iso' | t }}</button>
        <button (click)="view('top')">{{ 'Top' | t }}</button>
        <button (click)="view('front')">{{ 'Front' | t }}</button>
      </div>
    }
  `,
})
export class PartBodyView implements AfterViewInit, OnDestroy {
  src = input<BodySource | null>(null);
  spec = input<BodySpec | null>(null);

  private host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  note = signal('Loading the model…');
  failed = signal(false);
  size = signal('');
  /** Whether what is shown stands in the component frame, on the pads. */
  seated = signal(false);

  private renderer?: WebGLRenderer;
  private camera = new PerspectiveCamera(35, 1, 0.1, 1e5);
  private scene = new Scene();
  private body = new Group();
  private board = new Group();
  private controls?: OrbitControls;
  private ro?: ResizeObserver;
  private frame = 0;
  private asked = 0;
  private eye = new Vector3(1, -1.25, 0.9).normalize();
  private dead = false;

  /** What is loaded, kept to be seated again when the footprint's frame
   *  arrives after the model. */
  private shown: { src: BodySource; object: Object3D } | null = null;

  constructor() {
    effect(() => {
      const s = this.src();
      untracked(() => { if (this.renderer) void this.load(s); });
    });
    effect(() => {
      this.spec();
      untracked(() => { if (this.shown) this.place(); });
    });
  }

  ngAfterViewInit() {
    const el = this.host().nativeElement;
    try {
      this.renderer = sharedRenderer();
    } catch {
      this.fail('3D is not available in this browser');
      return;
    }
    el.appendChild(this.renderer.domElement);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.15;
    this.controls.addEventListener('change', () => this.draw());
    this.scene.add(new HemisphereLight(0xffffff, 0x50555c, 1.6));   // theme:pigment - light, not chrome
    this.scene.add(new AmbientLight(0xffffff, 0.45));                // theme:pigment
    const sun = new DirectionalLight(0xffffff, 1.9);                 // theme:pigment
    sun.position.set(0.6, 1, 1.4);
    this.camera.add(sun);
    this.scene.add(this.camera, this.board, this.body);
    this.ro = new ResizeObserver(() => { this.resize(); this.frameIt(); });
    this.ro.observe(el);
    this.resize();
    void this.load(this.src());
  }

  ngOnDestroy() {
    this.dead = true;
    cancelAnimationFrame(this.frame);
    this.ro?.disconnect();
    this.clear(this.body);
    this.clear(this.board);
    this.controls?.dispose();
    this.renderer?.domElement.remove();       // the shared renderer lives on
  }

  /** Iso over a corner, straight down, or from the front edge. */
  view(side: 'iso' | 'top' | 'front') {
    this.eye = side === 'top' ? new Vector3(0, -1e-4, 1)
      : side === 'front' ? new Vector3(0, -1, 0.18).normalize() : new Vector3(1, -1.25, 0.9).normalize();
    this.frameIt();
  }

  private fail(text: string) { this.failed.set(true); this.note.set(text); }

  private probe(name: string, fallback: string): Color {
    const v = getComputedStyle(this.host().nativeElement).getPropertyValue(name).trim();
    try { return new Color(v || fallback); } catch { return new Color(fallback); }
  }

  private resize() {
    const el = this.host().nativeElement;
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;                         // not laid out yet: the observer comes back
    // Setting a canvas's size reallocates it even when nothing changed.
    const now = this.renderer?.getSize(new Vector2());
    if (this.renderer && (now!.x !== w || now!.y !== h)) this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.draw();
  }

  private draw() {
    if (this.frame || this.dead || !this.renderer) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const moving = this.controls?.update() ?? false;
      this.renderer?.render(this.scene, this.camera);
      if (moving) this.draw();
    });
  }

  private clear(g: Group) {
    for (const o of [...g.children]) {
      g.remove(o);
      o.traverse(n => {
        const m = n as Mesh;
        // Geometry only: a disposed material takes its compiled shader with
        // it, and the next part would compile the same one again.
        m.geometry?.dispose?.();
      });
    }
  }

  private async load(src: BodySource | null) {
    const mine = ++this.asked;
    this.shown = null;
    this.clear(this.body);
    this.clear(this.board);
    this.size.set('');
    this.seated.set(false);
    this.failed.set(false);
    delete this.host().nativeElement.dataset['shown'];
    if (!src) { this.fail('No 3D model. It will not be standing on the board.'); this.draw(); return; }
    this.note.set('Loading the model…');
    this.draw();
    let object: Object3D;
    try {
      if (src.kind === 'glb') {
        // Parsed from a copy: the kept bytes are handed to the next open too.
        const gltf = await new GLTFLoader().parseAsync((await fetchBytes(src.url)).slice(0), '');
        object = gltf.scene;
        object.rotation.x = Math.PI / 2;                // glTF Y up -> CAD Z up
      } else {
        object = this.tcv(await fetchJson(src.url));     // drawn in the component frame
      }
    } catch {
      if (mine === this.asked && !this.dead) { this.fail('the model could not be read'); this.draw(); }
      return;
    }
    if (mine !== this.asked || this.dead) return;
    this.body.add(object);
    this.shown = { src, object };
    this.place();
    this.note.set('');
    this.host().nativeElement.dataset['shown'] = src.url;
  }

  /** Into the component frame (LCSC's, when its box is known), the board
   *  under it, the camera on it. */
  private place() {
    const s = this.shown;
    if (!s) return;
    let seated = s.src.kind === 'tcv';
    if (s.src.kind === 'glb') {
      s.object.position.set(0, 0, 0);
      s.object.updateMatrixWorld(true);
      seated = this.seat(s.object);
    }
    this.clear(this.board);
    const box = new Box3().setFromObject(this.body);
    if (box.isEmpty()) { this.fail('the model is empty'); this.draw(); return; }
    const size = box.getSize(new Vector3());
    this.size.set(`${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} mm`);
    this.seated.set(seated);
    if (seated) this.drawBoard(box);
    this.frameIt();
  }

  /** LCSC's GLB onto LCSC's seated box, when the two are the same size. */
  private seat(object: Object3D): boolean {
    const want = this.spec()?.lcsc_box;
    if (!want) return false;
    const got = new Box3().setFromObject(object);
    const gs = got.getSize(new Vector3());
    const ws = new Vector3(want.size[0], want.size[1], want.size[2]);
    const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.15, 0.03 * Math.max(a, b));
    if (!(close(gs.x, ws.x) && close(gs.y, ws.y) && close(gs.z, ws.z))) return false;
    object.position.set(want.x[0] - got.min.x, want.y[0] - got.min.y, want.z[0] - got.min.z);
    object.updateMatrixWorld(true);
    return true;
  }

  /** A square of board under the body, the pads on it, at z = 0. */
  private drawBoard(body: Box3) {
    const pads = this.spec()?.pads ?? [];
    const area = new Box3(new Vector3(body.min.x, body.min.y, 0), new Vector3(body.max.x, body.max.y, 0));
    for (const p of pads) {
      area.expandByPoint(new Vector3(p.x - p.w / 2, -p.y - p.h / 2, 0));
      area.expandByPoint(new Vector3(p.x + p.w / 2, -p.y + p.h / 2, 0));
    }
    const span = area.getSize(new Vector3());
    const margin = Math.max(1.5, 0.15 * Math.max(span.x, span.y));
    const w = span.x + 2 * margin, h = span.y + 2 * margin;
    const c = area.getCenter(new Vector3());
    const slab = new Shape();
    slab.moveTo(c.x - w / 2, c.y - h / 2); slab.lineTo(c.x + w / 2, c.y - h / 2);
    slab.lineTo(c.x + w / 2, c.y + h / 2); slab.lineTo(c.x - w / 2, c.y + h / 2); slab.closePath();
    const plane = new Mesh(new ShapeGeometry(slab), new MeshBasicMaterial({
      color: this.probe('--pcb-bg', 'black'), transparent: true, opacity: 0.4, side: DoubleSide, depthWrite: false,
    }));
    plane.renderOrder = -1;
    this.board.add(plane);
    // A millimetre grid on it, faint.
    const pts: number[] = [];
    for (let x = Math.ceil(c.x - w / 2); x <= c.x + w / 2; x++) pts.push(x, c.y - h / 2, 0.001, x, c.y + h / 2, 0.001);
    for (let y = Math.ceil(c.y - h / 2); y <= c.y + h / 2; y++) pts.push(c.x - w / 2, y, 0.001, c.x + w / 2, y, 0.001);
    const grid = new BufferGeometry();
    grid.setAttribute('position', new BufferAttribute(new Float32Array(pts), 3));
    this.board.add(new LineSegments(grid, new LineBasicMaterial({
      color: this.probe('--line', 'gray'), transparent: true, opacity: 0.22, depthWrite: false })));
    // The pads, +Y the footprint's -Y.
    const copper = new MeshBasicMaterial({ color: this.probe('--warn', 'orange'), transparent: true, opacity: 0.85,
                                           side: DoubleSide, depthWrite: false });
    for (const p of pads) {
      const shape = new Shape();
      const r = p.shape === 'oval' || p.shape === 'circle' ? Math.min(p.w, p.h) / 2 : Math.min(p.w, p.h) * 0.08;
      rounded(shape, -p.w / 2, -p.h / 2, p.w, p.h, r);
      if (p.drill) { const hole = new Path(); hole.absarc(0, 0, p.drill / 2, 0, Math.PI * 2, false); shape.holes.push(hole); }
      const m = new Mesh(new ShapeGeometry(shape, 16), copper.clone());
      m.position.set(p.x, -p.y, 0.003);
      m.rotation.z = -((p.rot ?? 0) * Math.PI) / 180;
      this.board.add(m);
    }
    copper.dispose();
  }

  /** The 3D room's viewer payload (three-cad-viewer's "data" format): a
   *  tree of groups with locations, each leaf a shape's triangles, normals
   *  and edges, inline or by reference into `instances`. */
  private tcv(payload: any): Object3D {
    const data = payload?.data ?? payload;
    const instances: any[] = data?.instances ?? [];
    const edgeColour = this.probe('--ink-dim', 'gray');
    const array = (a: any, kind: 'f' | 'i'): Float32Array | Uint32Array => {
      if (!a) return kind === 'f' ? new Float32Array() : new Uint32Array();
      if (Array.isArray(a)) return kind === 'f' ? new Float32Array(a.flat(3)) : new Uint32Array(a.flat(3));
      const raw = atob(a.buffer);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      return a.dtype === 'float32' ? new Float32Array(bytes.buffer) : new Uint32Array(bytes.buffer);
    };
    const place = (o: Object3D, loc: any) => {
      if (!Array.isArray(loc) || loc.length < 2) return;
      o.position.set(loc[0][0], loc[0][1], loc[0][2]);
      o.quaternion.copy(new Quaternion(loc[1][0], loc[1][1], loc[1][2], loc[1][3]));
    };
    const walk = (node: any): Object3D => {
      const g = new Group();
      place(g, node.loc);
      for (const part of node.parts ?? []) {
        if (part.parts) { g.add(walk(part)); continue; }
        if (part.type !== 'shapes') continue;
        const shape = part.shape?.ref != null ? instances[part.shape.ref] : part.shape;
        if (!shape) continue;
        const leaf = new Group();
        place(leaf, part.loc);
        const state = part.state ?? [1, 1];
        if (state[0] === 1 && shape.triangles) {
          const geo = new BufferGeometry();
          geo.setAttribute('position', new BufferAttribute(array(shape.vertices, 'f'), 3));
          const n = array(shape.normals, 'f');
          if (n.length) geo.setAttribute('normal', new BufferAttribute(n, 3));
          geo.setIndex(new BufferAttribute(array(shape.triangles, 'i'), 1));
          if (!n.length) geo.computeVertexNormals();
          leaf.add(new Mesh(geo, new MeshStandardMaterial({
            color: new Color(part.color || 'gray'), metalness: 0.1, roughness: 0.6, side: DoubleSide,
            transparent: (part.alpha ?? 1) < 1, opacity: part.alpha ?? 1,
            polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
          })));
        }
        if (state[1] === 1 && shape.edges) {
          const geo = new BufferGeometry();
          geo.setAttribute('position', new BufferAttribute(array(shape.edges, 'f'), 3));
          leaf.add(new LineSegments(geo, new LineBasicMaterial({ color: edgeColour, transparent: true, opacity: 0.6 })));
        }
        g.add(leaf);
      }
      return g;
    };
    return walk(data?.shapes ?? {});
  }

  /** The body and the piece of board in shot from the current side. */
  private frameIt() {
    if (!this.controls) return;
    const box = new Box3().setFromObject(this.body);
    if (box.isEmpty()) { this.draw(); return; }
    const middle = box.getCenter(new Vector3());
    const eye = this.eye;
    const right = new Vector3().crossVectors(eye, new Vector3(0, 0, 1));
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
    right.normalize();
    const above = new Vector3().crossVectors(right, eye).normalize();
    const up = Math.tan((this.camera.fov * Math.PI) / 360);
    const across = up * this.camera.aspect;
    let back = 0;
    const corner = new Vector3();
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      corner.set(x, y, z).sub(middle);
      const depth = corner.dot(eye);
      back = Math.max(back, depth + Math.abs(corner.dot(above)) / up, depth + Math.abs(corner.dot(right)) / across);
    }
    back *= 1.18;
    const reach = box.getSize(new Vector3()).length();
    this.camera.position.copy(middle).addScaledVector(eye, back);
    this.camera.near = Math.max(reach / 200, 0.01);
    this.camera.far = reach * 50 + back;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(middle);
    this.controls.update();
    this.draw();
  }
}

function rounded(s: Shape, x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, w / 2, h / 2);
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y); s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
  s.lineTo(x + w, y + h - r); s.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false);
  s.lineTo(x + r, y + h); s.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(x, y + r); s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
}
