import { Injectable, inject, signal } from '@angular/core';
import {
  AmbientLight, Box3, BufferAttribute, BufferGeometry, DirectionalLight, DoubleSide, Group, LineBasicMaterial,
  LineSegments, Material, Mesh, MeshLambertMaterial, Object3D, PerspectiveCamera, Scene, Vector3,
  WebGLRenderer,
} from 'three';
import { FilesApi, StoredFile, extOf, inlineUrl, meshUrl } from './files-model';
import type { MeshJob, MeshReply } from './mesh.worker';

/** The picture of a 3D file in the Files grid, drawn here once.
 *
 *  The server has no GPU, so the first page to show a STEP, STL, OBJ, 3MF
 *  or GLB without a picture draws one - off screen, with one renderer for
 *  all of them, one file at a time and only when the page is idle - and
 *  sends it to the server, which keeps it by the file's content for
 *  everyone in the workspace (files_api.py `PUT /thumb`). A STEP is drawn
 *  from the GLB the server makes of it (`/mesh`); while that is still
 *  being made it is asked again later.
 *
 *  The picture is shading alone: white parts, grey where they turn from
 *  the light, on a transparent background, from the 3D view's iso corner.
 *  The page tints it with the theme's model colour (styles.css
 *  `.tcv-fm-solid`), so one picture reads in every theme. */

const W = 640, H = 480;
// From the target to the eye, Z up: the 3D view's iso (mesh-view.ts).
const ISO = new Vector3(1, -1, 0.8);
// Larger than this is not fetched for a picture: it keeps its icon.
const MAX_BYTES: Record<string, number> = { stl: 60 * 2 ** 20, obj: 40 * 2 ** 20, glb: 40 * 2 ** 20, gltf: 20 * 2 ** 20, '3mf': 20 * 2 ** 20 };
// Feature edges are worked out up to this many triangles; past it, shading only.
const EDGE_TRIANGLES = 1_500_000;
// A STEP still being made is asked again after this long, longer each time.
const RETRY_MS = [5_000, 10_000, 20_000, 40_000, 60_000];
const RETRY_FOR_MS = 15 * 60_000;
// The renderer is given back this long after the last picture.
const IDLE_MS = 20_000;

type Job = { file: StoredFile; send: boolean; tries: number; since: number };

@Injectable({ providedIn: 'root' })
export class MeshThumbs {
  private api = inject(FilesApi);
  /** Pictures drawn on this page, by file id (object URLs). */
  readonly drawn = signal<Record<string, string>>({});
  private asked = new Set<string>();
  private waiting: Job[] = [];
  private busy = false;
  private renderer?: WebGLRenderer;
  private worker?: Worker;
  private idle?: ReturnType<typeof setTimeout>;

  /** A file without a picture came into view. Asked once per file. */
  want(file: StoredFile, send: boolean) {
    if (this.asked.has(file.id)) return;
    const ext = extOf(file.name);
    if (file.preview === 'mesh' && file.bytes > (MAX_BYTES[ext] ?? 0)) return;
    this.asked.add(file.id);
    this.waiting.push({ file, send, tries: 0, since: Date.now() });
    this.next();
  }

  private next() {
    if (this.busy || !this.waiting.length) return;
    this.busy = true;
    clearTimeout(this.idle);
    whenIdle(async () => {
      const job = this.waiting.shift()!;
      try {
        await this.run(job);
      } catch {
        // unreadable, or 3D is not available here: the icon stays
      }
      this.busy = false;
      if (this.waiting.length) this.next();
      else this.idle = setTimeout(() => this.release(), IDLE_MS);
    });
  }

  private async run(job: Job) {
    const f = job.file;
    const obj = await this.load(f);
    if (obj === 'later') {
      // the server is still making the STEP's mesh: asked again later
      if (Date.now() - job.since < RETRY_FOR_MS) {
        const wait = RETRY_MS[Math.min(job.tries, RETRY_MS.length - 1)];
        setTimeout(() => { this.waiting.push({ ...job, tries: job.tries + 1 }); this.next(); }, wait);
      }
      return;
    }
    if (!obj) return;
    try {
      await this.edges(obj);
      const blob = await this.draw(obj);
      if (!blob) return;
      this.drawn.update(d => ({ ...d, [f.id]: URL.createObjectURL(blob) }));
      if (job.send) this.api.putThumb(f.id, blob).subscribe({ error: () => {} });
    } finally {
      dispose(obj);
    }
  }

  /** The file as something to draw; 'later' for a STEP still being made. */
  private async load(f: StoredFile): Promise<Object3D | 'later' | null> {
    const step = f.preview === 'step';
    const ext = step ? 'glb' : extOf(f.name);
    const r = await fetch(step ? `${meshUrl(f.id)}?wait=0` : inlineUrl(f.id), { credentials: 'same-origin' });
    if (r.status === 202) return 'later';
    if (!r.ok) return null;
    const data = await r.arrayBuffer();
    if (ext === 'stl' || ext === 'obj') {
      const reply = await this.ask({ op: 'parse', ext, data }, [data]);
      if (reply.op !== 'parse') return null;
      const geo = new BufferGeometry();
      geo.setAttribute('position', new BufferAttribute(reply.pos, 3));
      geo.setAttribute('normal', new BufferAttribute(reply.nor, 3));
      geo.setIndex(new BufferAttribute(reply.index, 1));
      return new Mesh(geo);
    }
    if (ext === '3mf') {
      const { ThreeMFLoader } = await import('three/examples/jsm/loaders/3MFLoader.js');
      return new ThreeMFLoader().parse(data);
    }
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const scene = await new Promise<Object3D>((ok, bad) => new GLTFLoader().parse(data, '', g => ok(g.scene), bad));
    // metres and Y up, as glTF has it -> mm and Z up, as the 3D view
    scene.rotation.x = Math.PI / 2;
    scene.scale.setScalar(1000);
    const root = new Group();
    root.add(scene);
    return root;
  }

  /** Feature edges for every mesh, from the worker, as the 3D view's. */
  private async edges(obj: Object3D) {
    const meshes: Mesh[] = [];
    let triangles = 0;
    obj.traverse(o => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      meshes.push(m);
      triangles += (m.geometry.index?.count ?? m.geometry.getAttribute('position').count) / 3;
    });
    if (triangles > EDGE_TRIANGLES) return;
    const line = new LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32 });  // theme:pigment - shading, tinted by the page
    let id = 0;
    for (const m of meshes) {
      const pos = (m.geometry.getAttribute('position').array as Float32Array).slice();
      const idx = m.geometry.index ? Uint32Array.from(m.geometry.index.array) : null;
      const r = await this.ask({ op: 'edges', id: ++id, pos, index: idx }, idx ? [pos.buffer, idx.buffer] : [pos.buffer]);
      if (r.op !== 'edges' || !r.lines.length) continue;
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(r.lines, 3));
      m.add(new LineSegments(g, line));
    }
  }

  /** One frame of it from the iso corner, fitted, as a WebP (or PNG). */
  private async draw(obj: Object3D): Promise<Blob | null> {
    // An OffscreenCanvas where there is one: its convertToBlob encodes at
    // once, where a page canvas's toBlob waits for an idle moment.
    const r = this.renderer ??= new WebGLRenderer({
      antialias: true, alpha: true, preserveDrawingBuffer: true,
      ...(typeof OffscreenCanvas === 'function' ? { canvas: new OffscreenCanvas(W, H) as unknown as HTMLCanvasElement } : {}),
    });
    r.setPixelRatio(1);
    r.setSize(W, H, false);
    r.setClearColor(0x000000, 0);  // theme:pigment - transparent
    // One white material for every part, whatever colours the file has:
    // the picture is light and shade, and the page gives it its colour.
    const white = new MeshLambertMaterial({ color: 0xffffff, side: DoubleSide,  // theme:pigment
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    const theirs = new Set<Material>();
    obj.traverse(o => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      for (const x of Array.isArray(m.material) ? m.material : [m.material]) if (x) theirs.add(x);
      m.material = white;
    });
    for (const x of theirs) disposeMaterial(x);
    const scene = new Scene();
    const camera = new PerspectiveCamera(35, W / H, 0.1, 1e6);
    camera.up.set(0, 0, 1);
    // Flat light from above, a little to the front and the left: from the
    // iso corner the top reads full, the front a fifth darker, the right
    // side darker again - the three faces of a box are always told apart.
    // (three's lights are physical: a Lambert surface gives back 1/pi of them)
    scene.add(new AmbientLight(0xffffff, 0.12 * Math.PI));   // theme:pigment - light, not chrome
    const sun = new DirectionalLight(0xffffff, 1.05 * Math.PI);  // theme:pigment
    sun.position.set(0.25, -0.55, 1);
    scene.add(sun, obj);
    obj.updateMatrixWorld(true);
    const box = new Box3().setFromObject(obj);
    if (box.isEmpty()) return null;
    fit(camera, box);
    await r.compileAsync(scene, camera).catch(() => undefined);
    r.render(scene, camera);
    white.dispose();
    const canvas = r.domElement as HTMLCanvasElement | OffscreenCanvas;
    if ('convertToBlob' in canvas) return canvas.convertToBlob({ type: 'image/webp', quality: 0.9 });
    return new Promise(ok => canvas.toBlob(b => ok(b), 'image/webp', 0.9));
  }

  private ask(job: MeshJob, transfer: Transferable[]): Promise<MeshReply> {
    const w = this.worker ??= new Worker(new URL('./mesh.worker', import.meta.url), { type: 'module' });
    return new Promise((ok, bad) => {
      const done = (e: MessageEvent<MeshReply>) => {
        const r = e.data;
        if (r.op !== 'error' && (r.op !== job.op || (r.op === 'edges' && job.op === 'edges' && r.id !== job.id))) return;
        off();
        if (r.op === 'error') bad(new Error(r.message)); else ok(r);
      };
      const fail = () => { off(); bad(new Error('the worker stopped')); };
      const off = () => { w.removeEventListener('message', done); w.removeEventListener('error', fail); };
      w.addEventListener('message', done);
      w.addEventListener('error', fail);
      w.postMessage(job, transfer);
    });
  }

  /** The GPU context and the worker given back while nothing is drawn. */
  private release() {
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
    this.renderer = undefined;
    this.worker?.terminate();
    this.worker = undefined;
  }
}

/** The camera at the iso corner, as close as it can be with all eight
 *  corners of the box in the picture and a margin round them. */
function fit(camera: PerspectiveCamera, box: Box3) {
  const c = box.getCenter(new Vector3());
  const r = box.getSize(new Vector3()).length() / 2 || 1;
  const back = ISO.clone().normalize();
  const side = new Vector3().crossVectors(camera.up, back).normalize();
  const up = new Vector3().crossVectors(back, side);
  const tanV = Math.tan(camera.fov * Math.PI / 360) * 0.86, tanH = tanV * camera.aspect;
  let dist = 0;
  for (let i = 0; i < 8; i++) {
    const p = new Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(c);
    const z = p.dot(back);
    dist = Math.max(dist, z + Math.abs(p.dot(side)) / tanH, z + Math.abs(p.dot(up)) / tanV);
  }
  camera.position.copy(c).addScaledVector(back, dist);
  camera.near = r / 500;
  camera.far = dist + r * 20;
  camera.lookAt(c);
  camera.updateProjectionMatrix();
}

/** Run when the page has nothing better to do, so a scroll never waits. */
function whenIdle(job: () => void) {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(() => job(), { timeout: 1500 });
  else setTimeout(job, 200);
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
  for (const x of mats) disposeMaterial(x);
}

function disposeMaterial(x: Material) {
  for (const v of Object.values(x)) if (v && typeof v === 'object' && 'isTexture' in v) (v as { dispose(): void }).dispose();
  x.dispose();
}
