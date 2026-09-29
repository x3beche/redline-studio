import {
  AfterViewInit, Component, ElementRef, OnDestroy, effect, input, signal,
  viewChild,
} from '@angular/core';
import {
  AmbientLight, Box3, BoxGeometry, CanvasTexture, Color, DirectionalLight, Material, Mesh,
  MeshBasicMaterial, NearestFilter, Object3D, PerspectiveCamera, PlaneGeometry,
  Quaternion, Raycaster, Scene, Vector2, Vector3, WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { capture } from './sketchpad';
import { whenSettled } from '../fold';

/** The board, in three dimensions.
 *
 *  KiCad exports the placed board as a GLB with the parts standing on it,
 *  which is a normal glTF scene - so this is a small three.js viewer and
 *  not another CAD viewer. The one in the 3D room speaks a tessellation
 *  format of its own and has a tree, a clip plane and a measuring tape
 *  attached; none of that applies to a board somebody wants to turn over
 *  and look at.
 */
@Component({
  selector: 'app-board-3d',
  template: `
<div class="relative h-full w-full">
  <div #host class="h-full w-full"></div>
  @if (note(); as n) {
    <p class="absolute inset-x-0 top-2 text-center text-[11px]"
       style="color: var(--ink-dim)">{{ n }}</p>
  }
</div>`,
})
export class Board3d implements AfterViewInit, OnDestroy {
  /** Where the GLB is - a board from KiCad, or one part, which the server
   *  converts from EasyEDA's OBJ. Changing it loads the new one into the
   *  same scene. */
  src = input.required<string>();

  host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  note = signal('loading the model…');

  private renderer?: WebGLRenderer;
  private scene?: Scene;
  private camera?: PerspectiveCamera;
  private controls?: OrbitControls;
  private ro?: ResizeObserver;
  private frame = 0;
  private started = false;

  /** What is on screen, and whether the camera is still ours to move.
   *  A board is wider than it is deep, so how much of the window it fills
   *  depends on the shape of the window - it has to be framed again when
   *  that changes, but not after somebody has turned it by hand. */
  private held?: Box3;
  private touched = false;

  constructor() {
    // The source arrives before the canvas does on a first paint, and
    // changes afterwards when another board is opened.
    effect(() => {
      const url = this.src();
      if (this.started && url) this.load(url);
    });
  }

  private resized = () => this.resize();

  ngAfterViewInit() {
    const box = this.host().nativeElement;
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    box.appendChild(this.renderer.domElement);

    this.scene = new Scene();
    this.camera = new PerspectiveCamera(40, 1, 0.1, 5000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.addEventListener('start', () => { this.touched = true; });

    // Enough light to read a board by: one from above for the copper, one
    // from the side so the parts standing on it have an edge.
    this.scene.add(new AmbientLight(0xffffff, 2.2));
    const key = new DirectionalLight(0xffffff, 2.4);
    key.position.set(1, 2, 1.5);
    this.scene.add(key);
    const fill = new DirectionalLight(0xffffff, 0.8);
    fill.position.set(-1.5, -0.5, -1);
    this.scene.add(fill);

    this.ro = new ResizeObserver(() => whenSettled(this.resized));
    this.ro.observe(box);
    this.resize();

    const tick = () => {
      this.frame = requestAnimationFrame(tick);
      this.turn();
      this.controls?.update();
      if (this.renderer && this.scene && this.camera) {
        this.renderer.render(this.scene, this.camera);
      }
    };
    tick();

    this.started = true;
    if (this.src()) this.load(this.src());

    // Parts that take a click (the simulator's buttons): caught before the
    // orbit controls see the pointer, so pressing one does not turn the board.
    box.addEventListener('pointerdown', this.pointerDown, { capture: true });
    box.addEventListener('pointermove', this.pointerMove);
    window.addEventListener('pointerup', this.pointerUp);
  }

  /** What is on screen, as a picture the size of the box. Rendered and
   *  read in one go: the drawing buffer is not kept between frames. */
  snapshot(): string | null {
    const box = this.host().nativeElement;
    if (!this.renderer || !this.scene || !this.camera) return null;
    this.renderer.render(this.scene, this.camera);
    const gl = this.renderer.domElement;
    let bg = getComputedStyle(box).backgroundColor;
    for (let el: HTMLElement | null = box; el && /rgba\(.*, 0\)|transparent/.test(bg);
         el = el.parentElement) {
      bg = getComputedStyle(el).backgroundColor;
    }
    return capture(box, bg, [{ src: gl, x: 0, y: 0, w: box.clientWidth, h: box.clientHeight }]);
  }

  ngOnDestroy() {
    const box = this.host().nativeElement;
    box.removeEventListener('pointerdown', this.pointerDown, { capture: true });
    box.removeEventListener('pointermove', this.pointerMove);
    window.removeEventListener('pointerup', this.pointerUp);
    for (const f of this.faces.values()) (f.material as MeshBasicMaterial).map?.dispose();
    cancelAnimationFrame(this.frame);
    this.ro?.disconnect();
    this.controls?.dispose();
    this.renderer?.dispose();
    this.renderer?.forceContextLoss?.();
  }

  private resize() {
    const box = this.host().nativeElement;
    const w = box.clientWidth || 1;
    const h = box.clientHeight || 1;
    this.renderer?.setSize(w, h, false);
    if (this.camera) {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    if (!this.touched) this.place_camera();
  }

  /** Which load is the current one. Clicking through five parts starts
   *  five downloads, and they finish in whatever order they like: only
   *  the last one asked for may reach the screen. */
  private asked = 0;

  private load(url: string) {
    if (!this.scene) return;
    const mine = ++this.asked;
    const current = () => mine === this.asked;
    this.note.set('loading the model…');
    const failed = () => { if (current()) this.note.set('the model could not be read'); };
    new GLTFLoader().load(url, gltf => { if (current()) this.show(gltf.scene); },
                          undefined, failed);
  }

  /** Put this in the scene in place of whatever was there. */
  private show(object: Object3D) {
    if (!this.scene) return;
    // Only the model: the lights and the camera stay.
    for (const child of [...this.scene.children]) {
      if ((child as { isLight?: boolean }).isLight) continue;
      this.scene.remove(child);
    }
    this.scene.add(object);
    this.model = object;
    // What was lit, pictured or spinning belonged to the model that left.
    for (const f of this.faces.values()) (f.material as MeshBasicMaterial).map?.dispose();
    this.faces.clear();
    this.spinning.clear();
    this.lit.clear();
    this.touched = false;
    this.frame_the(object);
    this.note.set('');
    this.loaded.update(n => n + 1);
  }

  /** Measure what came in, then put the camera on it. */
  private frame_the(object: { }) {
    const bounds = new Box3().setFromObject(object as never);
    if (bounds.isEmpty()) {
      this.note.set('the model is empty - no part had a 3D shape');
      return;
    }
    this.held = bounds;
    this.place_camera();
  }

  /** Which way the camera looks from: over one corner, tilted down. */
  private static readonly EYE = new Vector3(0.42, 0.62, 0.66).normalize();

  /** The direction the camera looks from now: EYE until `look` says otherwise. */
  private eye = Board3d.EYE;

  /** Seen from a named side, the whole model in shot: `fit` is the usual
   *  corner view, `top` straight down, `front` from the front edge, a
   *  little above it. Framed again when the window changes, as on load. */
  look(side: 'fit' | 'top' | 'front') {
    this.eye = side === 'top' ? new Vector3(0, 1, 0.0001).normalize()
      : side === 'front' ? new Vector3(0, 0.3, 1).normalize() : Board3d.EYE;
    this.touched = false;
    this.place_camera();
  }

  /** Put the camera where the whole board is in shot, from above and to
   *  one side - which is how a board is photographed.
   *
   *  The distance is the smallest one that still holds every corner of
   *  the board inside both fields of view, measured in the camera's own
   *  axes. A board is a wide, thin strip: fitting a sphere around it, or
   *  its tallest dimension, leaves it a ribbon across the middle of the
   *  window, and at that range the parts on it - one to three
   *  millimetres - are specks. It reads as an empty viewer.
   */
  private place_camera() {
    if (!this.camera || !this.controls || !this.held) return;
    const middle = this.held.getCenter(new Vector3());
    const reach = this.held.getSize(new Vector3()).length() / 2;

    // The camera's own axes, for the direction it will look from.
    const eye = this.eye;
    const right = new Vector3().crossVectors(eye, new Vector3(0, 1, 0))
      .normalize();
    const above = new Vector3().crossVectors(right, eye).normalize();

    const up = Math.tan((this.camera.fov * Math.PI) / 360);
    const across = up * this.camera.aspect;
    let back = 0;
    const corner = new Vector3();
    for (const x of [this.held.min.x, this.held.max.x]) {
      for (const y of [this.held.min.y, this.held.max.y]) {
        for (const z of [this.held.min.z, this.held.max.z]) {
          corner.set(x, y, z).sub(middle);
          const depth = corner.dot(eye);
          back = Math.max(back,
                          depth + Math.abs(corner.dot(above)) / up,
                          depth + Math.abs(corner.dot(right)) / across);
        }
      }
    }
    back *= 1.08;

    this.camera.position.copy(middle).addScaledVector(eye, back);
    this.camera.near = reach / 100;
    this.camera.far = reach * 100;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(middle);
    this.controls.update();
  }

  // ---- live parts: what the simulator shows on the board ----
  // Every board GLB names its nodes by reference designator (SPEC §5), so a
  // part is found by its ref and lit, pictured or turned where it stands.

  /** Bumped each time a model reaches the screen: whatever is drawn on
   *  its parts has to be drawn again on the new one. */
  loaded = signal(0);
  private model?: Object3D;
  private lit = new Map<string, Mesh[]>();
  private faces = new Map<string, Mesh>();
  /** Display modules drawn onto headers (face with a module). */
  private modules = new Map<string, Object3D>();
  private spinning = new Map<string, { rps: number; centre: Vector3; last: number }>();
  private pickNames: ReadonlySet<string> = new Set();
  private pickCb?: (name: string, down: boolean) => void;
  private held_down: string | null = null;
  private ray = new Raycaster();

  /** The node with this name in the loaded model (a ref: `U2`, `LED3`). */
  node(name: string): Object3D | undefined {
    return this.model?.getObjectByName(name) ?? undefined;
  }

  /** Make a part glow: `strength` 0..1 of `color`. 0 puts its own
   *  material back. Returns whether the part is in the model. */
  glow(name: string, color: string | number, strength: number): boolean {
    const node = this.node(name);
    if (!node) return false;
    let meshes = this.lit.get(name);
    if (!meshes) {
      meshes = [];
      node.traverse(o => {
        const m = o as Mesh;
        if (!m.isMesh) return;
        // Materials are shared between parts: each lit mesh gets its own copy.
        m.userData['simOwn'] = m.material;
        m.material = Array.isArray(m.material) ? m.material.map(x => x.clone()) : m.material.clone();
        meshes!.push(m);
      });
      this.lit.set(name, meshes);
    }
    const on = Math.max(0, Math.min(1, strength));
    for (const m of meshes) {
      for (const mat of (Array.isArray(m.material) ? m.material : [m.material]) as Material[]) {
        const e = mat as Material & { emissive?: Color; emissiveIntensity?: number };
        if (!e.emissive) continue;
        e.emissive.set(on > 0 ? color : 0x000000);
        e.emissiveIntensity = on * 2.5;
      }
    }
    return true;
  }

  /** A picture on the part's top face - a display's screen. The same
   *  canvas again updates it; null takes it off. */
  /** A display module on a header: `module` gives its size in mm (the
   *  catalog's view hint). When the part in the model is only the header
   *  it plugs into - a board's STEP rarely carries the module - the module
   *  is drawn on it, its size scaled by the header's own pin pitch, set off
   *  towards the middle of the board, and the picture goes on its glass. */
  face(name: string, canvas: HTMLCanvasElement | null,
       module?: { w: number; h: number; glass: number[]; active: number[]; pins: number; pitch: number }): boolean {
    if (canvas && module && !this.faces.has(name) && this.moduleOn(name, canvas, module)) return true;
    return this.plainFace(name, canvas);
  }

  private moduleOn(name: string, canvas: HTMLCanvasElement,
                   m: { w: number; h: number; glass: number[]; active: number[]; pins: number; pitch: number }): boolean {
    const node = this.node(name);
    if (!node || !this.scene) return false;
    const box = new Box3().setFromObject(node);
    if (box.isEmpty()) return false;
    const size = box.getSize(new Vector3());
    const along = size.x >= size.z;                       // the header's row
    const long = along ? size.x : size.z;
    const mm = long / (m.pins * m.pitch);                 // scene units per millimetre
    if (!(mm > 0) || long > m.w * mm * 0.8) return false; // the part is already the module
    const c = box.getCenter(new Vector3());
    // Towards the middle of the board, across the row.
    const mid = new Box3().setFromObject(this.scene).getCenter(new Vector3());
    const sign = along ? Math.sign(mid.z - c.z) || 1 : Math.sign(mid.x - c.x) || 1;
    const off = (m.h / 2 - m.pitch / 2) * mm * sign;
    const top = box.max.y + 0.3 * mm;
    const group = new Object3D();
    const slab = (w: number, h: number, t: number, colour: number, y: number) => {
      const mesh = new Mesh(new BoxGeometry(w * mm, t * mm, h * mm), new MeshBasicMaterial({ color: colour }));
      mesh.position.y = y;
      group.add(mesh);
    };
    slab(m.w, m.h, 1.2, 0x1d3f7a, top + 0.6 * mm);                        // theme:pigment - the module's board
    slab(m.glass[0], m.glass[1], 1.4, 0x0b0b0d, top + 1.9 * mm);          // theme:pigment - its glass
    const tex = new CanvasTexture(canvas);
    tex.magFilter = NearestFilter;
    const pic = new Mesh(new PlaneGeometry(m.active[0] * mm, m.active[1] * mm),
                         new MeshBasicMaterial({ map: tex, toneMapped: false }));
    pic.rotation.x = -Math.PI / 2;
    pic.position.y = top + 2.61 * mm;
    group.add(pic);
    group.position.set(along ? c.x : c.x + off, 0, along ? c.z + off : c.z);
    if (!along) group.rotation.y = Math.PI / 2;
    this.scene.add(group);
    this.faces.set(name, pic);
    this.modules.set(name, group);
    return true;
  }

  private plainFace(name: string, canvas: HTMLCanvasElement | null): boolean {
    const had = this.faces.get(name);
    if (!canvas) {
      if (had) { had.removeFromParent(); (had.material as MeshBasicMaterial).map?.dispose(); this.faces.delete(name); }
      this.modules.get(name)?.removeFromParent();
      this.modules.delete(name);
      return true;
    }
    if (had) {
      const map = (had.material as MeshBasicMaterial).map!;
      if (map.image !== canvas) map.image = canvas;
      map.needsUpdate = true;
      return true;
    }
    const node = this.node(name);
    if (!node || !this.scene) return false;
    const box = new Box3().setFromObject(node);
    if (box.isEmpty()) return false;
    const size = box.getSize(new Vector3());
    const wide = size.x >= size.z;
    // The picture's long side along the part's long side.
    const w = (wide ? size.x : size.z) * 0.9;
    const h = Math.min((wide ? size.z : size.x) * 0.9, w * canvas.height / canvas.width);
    const tex = new CanvasTexture(canvas);
    tex.magFilter = NearestFilter;
    const plane = new Mesh(new PlaneGeometry(w, h),
                           new MeshBasicMaterial({ map: tex, toneMapped: false }));
    plane.rotation.x = -Math.PI / 2;
    if (!wide) plane.rotation.z = Math.PI / 2;
    const c = box.getCenter(new Vector3());
    plane.position.set(c.x, box.max.y + size.y * 0.02 + 1e-4, c.z);
    this.scene.add(plane);
    this.faces.set(name, plane);
    return true;
  }

  /** Turn a part about its own vertical axis, `rps` turns a second (0 stops it). */
  spin(name: string, rps: number) {
    const had = this.spinning.get(name);
    if (!rps) { this.spinning.delete(name); return; }
    if (had) { had.rps = rps; return; }
    const node = this.node(name);
    if (!node) return;
    const centre = new Box3().setFromObject(node).getCenter(new Vector3());
    node.parent?.worldToLocal(centre);
    this.spinning.set(name, { rps, centre, last: performance.now() });
  }

  private turn() {
    if (!this.spinning.size) return;
    const now = performance.now();
    const q = new Quaternion();
    const axis = new Vector3();
    const pq = new Quaternion();
    for (const [name, s] of this.spinning) {
      const node = this.node(name);
      if (!node) continue;
      const angle = ((now - s.last) / 1000) * s.rps * Math.PI * 2;
      s.last = now;
      // Up in the parent's own axes, about the part's middle.
      node.parent?.getWorldQuaternion(pq);
      axis.set(0, 1, 0).applyQuaternion(pq.invert());
      q.setFromAxisAngle(axis, angle);
      node.position.sub(s.centre).applyQuaternion(q).add(s.centre);
      node.quaternion.premultiply(q);
    }
  }

  /** Which parts take a press, and what to tell when one is pressed and let go. */
  pickable(names: ReadonlySet<string>, cb: (name: string, down: boolean) => void) {
    this.pickNames = names;
    this.pickCb = cb;
  }

  private hit(ev: PointerEvent): string | null {
    if (!this.pickNames.size || !this.camera || !this.renderer) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    this.ray.setFromCamera(new Vector2(((ev.clientX - r.left) / r.width) * 2 - 1,
                                       -((ev.clientY - r.top) / r.height) * 2 + 1), this.camera);
    const nodes = [...this.pickNames].map(n => this.node(n)).filter((n): n is Object3D => !!n);
    const first = this.ray.intersectObjects(nodes, true)[0];
    for (let o: Object3D | null = first?.object ?? null; o; o = o.parent) {
      if (this.pickNames.has(o.name)) return o.name;
    }
    return null;
  }

  private pointerDown = (ev: PointerEvent) => {
    const name = this.hit(ev);
    if (!name || !this.controls) return;
    this.controls.enabled = false;
    this.held_down = name;
    this.pickCb?.(name, true);
  };

  private pointerUp = () => {
    if (!this.held_down) return;
    const name = this.held_down;
    this.held_down = null;
    if (this.controls) this.controls.enabled = true;
    this.pickCb?.(name, false);
  };

  private pointerMove = (ev: PointerEvent) => {
    if (!this.pickNames.size || ev.buttons) return;
    this.host().nativeElement.style.cursor = this.hit(ev) ? 'pointer' : '';
  };

  /** The backdrop follows the theme; the board brings its own colours. */
  background(css: string) {
    if (this.scene) this.scene.background = new Color(css);
  }
}
