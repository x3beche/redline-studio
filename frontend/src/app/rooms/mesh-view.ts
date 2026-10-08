import { AfterViewInit, Component, ElementRef, OnDestroy, effect, input, signal, untracked, viewChild } from '@angular/core';
import {
  AmbientLight, Box3, BufferAttribute, BufferGeometry, Color, DirectionalLight, DoubleSide, Group, HemisphereLight,
  LineBasicMaterial, LineSegments, Material, Mesh, MeshStandardMaterial, Object3D, PerspectiveCamera, Scene, Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { T } from '../i18n';
import { extOf } from './files-model';
import type { MeshJob, MeshReply } from './mesh.worker';

/** A 3D file from the Files tab turned in the hand: STL, OBJ, 3MF, GLB, and a
 *  STEP once the server has made a GLB of it (files_api.py `/mesh`).
 *
 *  Drawn only when something changed - the camera moved, the box was
 *  resized, the model came in - and not sixty times a second while it
 *  sits there. An STL or OBJ is read in a worker (mesh.worker.ts), so a
 *  big one does not stop the page. Everything is in millimetres and Z up,
 *  as CAD has it: a glTF (metres, Y up) is turned and scaled to match. */

type View = 'iso' | 'top' | 'front' | 'right';
type Look = 'shaded' | 'edges' | 'wire';

// From the target to the eye, Z up. Top is a hair off vertical: looking
// straight down the up axis leaves the orbit without a heading.
const VIEWS: Record<View, Vector3> = {
  iso: new Vector3(1, -1, 0.8),
  top: new Vector3(0, -1e-4, 1),
  front: new Vector3(0, -1, 0),
  right: new Vector3(1, 0, 0),
};

@Component({
  selector: 'app-mesh-view',
  imports: [T],
  host: { class: 'tcv-fv-host' },
  template: `
<div class="tcv-mesh">
  <div #host class="tcv-mesh-host" (pointerdown)="touched.set(true)"></div>
  @if (note()) {
    <div class="tcv-fm-center tcv-mesh-note" [class.tcv-fm-err]="failed()">
      <div class="tcv-mesh-card">
        <span class="tcv-mesh-line">@if (!failed()) {<span class="tcv-fm-spin"></span>}{{ note() | t }}@if (waited()) { <span class="tcv-mesh-secs">{{ waited() }} s</span> }</span>
        @if (sub()) { <span class="tcv-mesh-sub">{{ sub() | t }}</span> }
      </div>
    </div>
  }
  @if (size(); as s) { <div class="tcv-mesh-size" [title]="'Size of the bounding box' | t">{{ s }}</div> }
  @if (!note()) {
    @if (!touched()) { <div class="tcv-mesh-hint">{{ 'Drag to turn, scroll to zoom, right-drag to pan' | t }}</div> }
    <div class="tcv-fv-zoom tcv-mesh-bar" role="toolbar" [attr.aria-label]="'3D view' | t">
      <button class="tcv-fm-icon-btn" (click)="view(current)" [title]="'Fit to the window' | t" [attr.aria-label]="'Fit to the window' | t">
        <svg class="tcv-fm-ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6"
             stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/></svg>
      </button>
      <span class="tcv-mesh-sep"></span>
      <div class="tcv-fm-seg" role="group" [attr.aria-label]="'View' | t">
        @for (v of views; track v.id) {
          <button [attr.data-on]="current === v.id ? 1 : null" (click)="view(v.id)">{{ v.label | t }}</button>
        }
      </div>
      <span class="tcv-mesh-sep"></span>
      <div class="tcv-fm-seg" role="group" [attr.aria-label]="'Display' | t">
        @for (l of looks; track l.id) {
          <button [attr.data-on]="look() === l.id ? 1 : null" (click)="setLook(l.id)">{{ l.label | t }}</button>
        }
      </div>
    </div>
  }
</div>`,
})
export class MeshView implements AfterViewInit, OnDestroy {
  src = input.required<string>();
  name = input.required<string>();
  /** `src` is the files API's STEP mesh: asked again while it is made. */
  step = input(false);
  private host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  note = signal('Loading the model…');
  sub = signal('');
  waited = signal(0);
  failed = signal(false);
  size = signal('');
  touched = signal(false);
  look = signal<Look>('shaded');
  current: View = 'iso';
  readonly views: { id: View; label: string }[] = [
    { id: 'iso', label: 'Iso' }, { id: 'top', label: 'Top' }, { id: 'front', label: 'Front' }, { id: 'right', label: 'Right' },
  ];
  readonly looks: { id: Look; label: string }[] = [
    { id: 'shaded', label: 'Shaded' }, { id: 'edges', label: 'Edges' }, { id: 'wire', label: 'Wireframe' },
  ];

  private renderer?: WebGLRenderer;
  private camera = new PerspectiveCamera(35, 1, 0.1, 1e6);
  private scene = new Scene();
  private model = new Group();
  private controls?: OrbitControls;
  private resize?: ResizeObserver;
  private worker?: Worker;
  private frame = 0;
  private dead = false;
  private abort = new AbortController();
  private box = new Box3();
  private edges = new Map<Mesh, LineSegments>();
  private edgesAsked = false;
  private edgeMaterial?: LineBasicMaterial;
  private run = 0;
  private tick?: ReturnType<typeof setInterval>;
  private pending = new Set<() => void>();

  constructor() {
    // The preview steps from file to file in the same view: start again.
    effect(() => {
      this.src();
      untracked(() => { if (this.renderer) this.reset(); });
    });
  }

  private reset() {
    clearInterval(this.tick);
    this.stopWorker();
    this.abort.abort();
    this.abort = new AbortController();
    for (const o of [...this.model.children]) { this.model.remove(o); dispose(o); }
    this.edges.clear();
    this.edgesAsked = false;
    this.box.makeEmpty();
    this.size.set('');
    this.failed.set(false);
    this.sub.set('');
    this.waited.set(0);
    this.note.set('Loading the model…');
    if (this.look() !== 'shaded') this.look.set('shaded');
    this.draw();
    void this.load();
  }

  ngAfterViewInit() {
    const el = this.host().nativeElement;
    try {
      this.renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    } catch {
      this.fail('3D is not available in this browser');
      return;
    }
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    el.appendChild(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.15;
    this.controls.addEventListener('change', () => this.draw());
    this.camera.up.set(0, 0, 1);
    this.scene.add(new HemisphereLight(0xffffff, 0x444444, 1.5));  // theme:pigment - light, not chrome
    this.scene.add(new AmbientLight(0xffffff, 0.35));               // theme:pigment
    const sun = new DirectionalLight(0xffffff, 1.7);                // theme:pigment
    sun.position.set(1, 2, 1.5);
    this.camera.add(sun);
    this.scene.add(this.camera, this.model);
    this.resize = new ResizeObserver(() => { this.fit(); this.draw(); });
    this.resize.observe(el);
    this.fit();
    void this.load();
  }

  /** One frame on the next paint. While the orbit is still settling after
   *  a drag it asks for the next one itself; once it is still, nothing runs. */
  private draw() {
    if (this.frame || this.dead || !this.renderer) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const moving = this.controls?.update() ?? false;   // may call draw() again: frame is 0, so it queues the next
      this.renderer?.render(this.scene, this.camera);
      if (moving) this.draw();
    });
  }

  private fit() {
    const el = this.host().nativeElement;
    const w = el.clientWidth || 1, h = el.clientHeight || 1;
    this.renderer?.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private probe(name: string, fallback: string): Color {
    const v = getComputedStyle(this.host().nativeElement).getPropertyValue(name).trim();
    try { return new Color(v || fallback); } catch { return new Color(fallback); }
  }

  private material() {
    return new MeshStandardMaterial({
      color: this.probe('--series-1', 'gray'), metalness: 0.05, roughness: 0.55, side: DoubleSide,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    });
  }

  private async fetchBytes(run: number): Promise<ArrayBuffer> {
    const signal = this.abort.signal;
    if (!this.step()) {
      const r = await fetch(this.src(), { credentials: 'same-origin', signal });
      if (!r.ok) throw new Error('The model could not be read');
      return r.arrayBuffer();
    }
    // The server makes it once and keeps it; until then it answers 202
    // with how long it has been at it, and is asked again.
    const sep = this.src().includes('?') ? '&' : '?';
    for (;;) {
      const r = await fetch(`${this.src()}${sep}wait=4`, { credentials: 'same-origin', signal });
      clearInterval(this.tick);
      if (run !== this.run) throw new Error('abort');
      if (r.status === 202) {
        const body = await r.json().catch(() => ({}));
        this.note.set('Preparing the 3D view…');
        this.sub.set('A STEP is read on the server the first time it is opened; after that it opens at once.');
        // the server's count, then a second at a time until it answers again
        const since = performance.now() - (body?.seconds ?? 0) * 1000;
        this.waited.set(Math.round(body?.seconds ?? 0));
        clearInterval(this.tick);
        this.tick = setInterval(() => this.waited.set(Math.round((performance.now() - since) / 1000)), 1000);
        continue;
      }
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(typeof body?.detail === 'string' ? body.detail : 'The model could not be read');
      }
      return r.arrayBuffer();
    }
  }

  private async load() {
    const run = ++this.run;
    const ext = this.step() ? 'glb' : extOf(this.name());
    const stale = () => this.dead || run !== this.run;
    try {
      if (this.step()) this.note.set('Preparing the 3D view…');
      const data = await this.fetchBytes(run);
      if (stale()) return;
      this.note.set('Loading the model…');
      this.sub.set('');
      this.waited.set(0);
      let obj: Object3D;
      if (ext === 'stl' || ext === 'obj') {
        obj = new Mesh(await this.parse(ext, data), this.material());
      } else if (ext === '3mf') {
        const { ThreeMFLoader } = await import('three/examples/jsm/loaders/3MFLoader.js');
        obj = new ThreeMFLoader().parse(data);
      } else {
        const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
        const gltf = await new Promise<Object3D>((ok, bad) => new GLTFLoader().parse(data, '', g => ok(g.scene), bad));
        // metres and Y up, as glTF has it (a STEP's mesh too) -> mm, Z up
        gltf.rotation.x = Math.PI / 2;
        gltf.scale.setScalar(1000);
        obj = gltf;
      }
      if (stale()) { dispose(obj); return; }
      this.tidy(obj);
      this.model.add(obj);
      this.model.updateMatrixWorld(true);
      this.box.setFromObject(this.model);
      if (this.box.isEmpty()) { this.fail('The file holds no 3D shape'); return; }
      const s = this.box.getSize(new Vector3());
      const mm = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
      this.size.set(`${mm(s.x)} × ${mm(s.y)} × ${mm(s.z)} mm`);
      // shaders compiled off the page's thread where the browser can
      // (KHR_parallel_shader_compile), so the first frame does not stall it
      await this.renderer?.compileAsync(this.model, this.camera, this.scene).catch(() => undefined);
      if (stale()) return;
      this.note.set('');
      this.view('iso');
    } catch (e) {
      if (stale()) return;
      const msg = (e as Error)?.message;
      this.fail(msg && !/fetch|network|abort/i.test(msg) ? msg : 'The model could not be read');
    }
  }

  /** Normals where a file has none; glTF's stand-in material (white and
   *  fully metal, so it shows black) swapped for the theme's. */
  private tidy(obj: Object3D) {
    let fallback: MeshStandardMaterial | undefined;
    obj.traverse(o => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      if (!m.geometry.getAttribute('normal')) m.geometry.computeVertexNormals();
      const mat = m.material as MeshStandardMaterial;
      if (!Array.isArray(m.material) && mat.isMeshStandardMaterial && !mat.name && mat.metalness === 1 && mat.roughness === 1) {
        mat.dispose();
        m.material = fallback ??= this.material();
      } else {
        for (const x of Array.isArray(m.material) ? m.material : [m.material]) {
          x.polygonOffset = true; x.polygonOffsetFactor = 1; x.polygonOffsetUnits = 1;
        }
      }
    });
  }

  private ensureWorker(): Worker | undefined {
    if (this.worker || typeof Worker === 'undefined') return this.worker;
    try {
      this.worker = new Worker(new URL('./mesh.worker', import.meta.url), { type: 'module' });
    } catch {
      this.worker = undefined;
    }
    return this.worker;
  }

  /** The worker and whatever it was still doing for the last file. */
  private stopWorker() {
    this.worker?.terminate();
    this.worker = undefined;
    for (const quit of this.pending) quit();
    this.pending.clear();
  }

  private ask(job: MeshJob, transfer: Transferable[]): Promise<MeshReply> {
    const w = this.ensureWorker();
    if (!w) return Promise.reject(new Error('no worker'));
    return new Promise((ok, bad) => {
      const quit = () => bad(new Error('abort'));
      this.pending.add(quit);
      const done = (e: MessageEvent<MeshReply>) => {
        const r = e.data;
        if (r.op === 'error') { off(); bad(new Error('The model could not be read')); return; }
        if (r.op !== job.op || (r.op === 'edges' && job.op === 'edges' && r.id !== job.id)) return;
        off();
        ok(r);
      };
      const fail = () => { off(); bad(new Error('The model could not be read')); };
      const off = () => {
        this.pending.delete(quit);
        w.removeEventListener('message', done);
        w.removeEventListener('error', fail);
      };
      w.addEventListener('message', done);
      w.addEventListener('error', fail);
      w.postMessage(job, transfer);
    });
  }

  /** An STL or OBJ in the worker; on the page only if there is none. */
  private async parse(ext: 'stl' | 'obj', data: ArrayBuffer): Promise<BufferGeometry> {
    const geo = new BufferGeometry();
    if (this.ensureWorker()) {
      try {
        // copied, not handed over: if the worker fails, the page reads it
        const r = await this.ask({ op: 'parse', ext, data }, []);
        if (r.op === 'parse') {
          geo.setAttribute('position', new BufferAttribute(r.pos, 3));
          geo.setAttribute('normal', new BufferAttribute(r.nor, 3));
          geo.setIndex(new BufferAttribute(r.index, 1));
          return geo;
        }
      } catch (e) {
        if ((e as Error).message === 'abort') throw e;
      }
    }
    if (ext === 'stl') {
      const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js');
      const g = new STLLoader().parse(data);
      g.computeVertexNormals();
      return g;
    }
    const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
    const group = new OBJLoader().parse(new TextDecoder().decode(data));
    let first: BufferGeometry | undefined;
    group.traverse(o => { if (!first && (o as Mesh).isMesh) first = (o as Mesh).geometry; });
    return first ?? geo;
  }

  /** The camera on one side of the model, as close as it can be with all
   *  eight corners of the box in the picture. */
  view(v: View) {
    this.current = v;
    if (this.box.isEmpty() || !this.controls) return;
    const c = this.box.getCenter(new Vector3());
    const r = this.box.getSize(new Vector3()).length() / 2 || 1;
    const back = VIEWS[v].clone().normalize();
    const side = new Vector3().crossVectors(this.camera.up, back).normalize();
    const up = new Vector3().crossVectors(back, side);
    // a margin, and room for the toolbar under it
    const tanV = Math.tan(this.camera.fov * Math.PI / 360) * 0.82, tanH = tanV * this.camera.aspect * 1.05;
    let dist = 0;
    for (let i = 0; i < 8; i++) {
      const p = new Vector3(i & 1 ? this.box.max.x : this.box.min.x, i & 2 ? this.box.max.y : this.box.min.y,
        i & 4 ? this.box.max.z : this.box.min.z).sub(c);
      const z = p.dot(back);
      dist = Math.max(dist, z + Math.abs(p.dot(side)) / tanH, z + Math.abs(p.dot(up)) / tanV);
    }
    // no swing left over from the last drag: flushed before the move
    this.controls.enableDamping = false;
    this.controls.update();
    this.camera.position.copy(c).addScaledVector(back, dist);
    this.camera.near = r / 500;
    this.camera.far = dist + r * 20;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(c);
    this.controls.minDistance = r / 100;
    this.controls.maxDistance = r * 15;
    this.controls.update();
    this.controls.enableDamping = true;
    this.draw();
  }

  async setLook(l: Look) {
    this.look.set(l);
    this.model.traverse(o => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      for (const x of Array.isArray(m.material) ? m.material : [m.material]) (x as MeshStandardMaterial).wireframe = l === 'wire';
    });
    for (const e of this.edges.values()) e.visible = l === 'edges';
    this.draw();
    if (l === 'edges' && !this.edgesAsked) {
      this.edgesAsked = true;
      await this.makeEdges();
    }
  }

  /** Feature edges for every mesh, worked out in the worker once. */
  private async makeEdges() {
    const run = this.run;
    this.edgeMaterial ??= new LineBasicMaterial({ color: this.probe('--ink', 'black'), transparent: true, opacity: 0.55 });
    const meshes: Mesh[] = [];
    this.model.traverse(o => { if ((o as Mesh).isMesh) meshes.push(o as Mesh); });
    let id = 0;
    for (const m of meshes) {
      if (this.dead || run !== this.run) return;
      const pos = (m.geometry.getAttribute('position').array as Float32Array).slice();
      const idx = m.geometry.index ? Uint32Array.from(m.geometry.index.array) : null;
      let lines: Float32Array;
      try {
        const r = await this.ask({ op: 'edges', id: ++id, pos, index: idx }, idx ? [pos.buffer, idx.buffer] : [pos.buffer]);
        if (r.op !== 'edges') continue;
        lines = r.lines;
      } catch {
        return;
      }
      if (this.dead || run !== this.run) return;
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(lines, 3));
      const seg = new LineSegments(g, this.edgeMaterial);
      seg.visible = this.look() === 'edges';
      m.add(seg);
      this.edges.set(m, seg);
      this.draw();
    }
  }

  private fail(msg: string) {
    clearInterval(this.tick);
    this.failed.set(true);
    this.sub.set('');
    this.waited.set(0);
    this.note.set(msg);
  }

  ngOnDestroy() {
    this.dead = true;
    clearInterval(this.tick);
    this.abort.abort();
    cancelAnimationFrame(this.frame);
    this.resize?.disconnect();
    this.stopWorker();
    this.controls?.dispose();
    dispose(this.model);
    this.edgeMaterial?.dispose();
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
    this.renderer?.domElement.remove();
  }
}

/** Geometries and materials of everything under it, given back to the GPU. */
function dispose(root: Object3D) {
  const mats = new Set<Material>();
  root.traverse(o => {
    const m = o as Mesh;
    if (!m.geometry) return;
    m.geometry.dispose();
    for (const x of Array.isArray(m.material) ? m.material : [m.material]) if (x) mats.add(x as Material);
  });
  for (const x of mats) {
    for (const v of Object.values(x)) if (v && typeof v === 'object' && 'isTexture' in v) (v as { dispose(): void }).dispose();
    x.dispose();
  }
}
