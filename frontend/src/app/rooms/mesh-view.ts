import { AfterViewInit, Component, ElementRef, OnDestroy, input, signal, viewChild } from '@angular/core';
import {
  AmbientLight, Box3, BufferGeometry, Color, DirectionalLight, Group, HemisphereLight, Mesh, MeshStandardMaterial,
  Object3D, PerspectiveCamera, Scene, Vector3, WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { T } from '../i18n';
import { extOf } from './files-model';

/** A mesh from the Files tab (STL, OBJ, 3MF, GLB) turned in the hand:
 *  read-only, three.js and its own loaders, nothing kept. A STEP needs the
 *  CAD kernel, so it is shown once it has been added to a project. */
@Component({
  selector: 'app-mesh-view',
  imports: [T],
  host: { class: 'tcv-fv-host' },
  template: `
<div class="tcv-mesh">
  <div #host class="tcv-mesh-host"></div>
  @if (note()) { <div class="tcv-fm-center" [class.tcv-fm-err]="failed()">@if (!failed()) {<span class="tcv-fm-spin"></span>}{{ note() | t }}</div> }
  @if (!note()) { <div class="tcv-mesh-hint">{{ 'Drag to turn, scroll to zoom, right-drag to pan' | t }}</div> }
</div>`,
})
export class MeshView implements AfterViewInit, OnDestroy {
  src = input.required<string>();
  name = input.required<string>();
  private host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  note = signal('Loading the model…');
  failed = signal(false);

  private renderer?: WebGLRenderer;
  private camera = new PerspectiveCamera(40, 1, 0.1, 1e6);
  private scene = new Scene();
  private controls?: OrbitControls;
  private frame = 0;
  private resize?: ResizeObserver;
  private dead = false;

  ngAfterViewInit() {
    const el = this.host().nativeElement;
    try {
      this.renderer = new WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      this.fail('3D is not available in this browser');
      return;
    }
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    el.appendChild(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.scene.add(new HemisphereLight(0xffffff, 0x444444, 1.6));  // theme:pigment - light, not chrome
    this.scene.add(new AmbientLight(0xffffff, 0.35));               // theme:pigment
    const sun = new DirectionalLight(0xffffff, 1.8);                // theme:pigment
    sun.position.set(1, 2, 1.5);
    this.camera.add(sun);
    this.scene.add(this.camera);
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(el);
    this.fit();
    const tick = () => {
      if (this.dead) return;
      this.controls?.update();
      this.renderer?.render(this.scene, this.camera);
      this.frame = requestAnimationFrame(tick);
    };
    tick();
    void this.load();
  }

  private fit() {
    const el = this.host().nativeElement;
    const w = el.clientWidth || 1, h = el.clientHeight || 1;
    this.renderer?.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private material() {
    const probe = getComputedStyle(this.host().nativeElement).getPropertyValue('--series-1').trim();
    return new MeshStandardMaterial({ color: new Color(probe || 'gray'), metalness: 0.1, roughness: 0.6 });
  }

  private async load() {
    const ext = extOf(this.name());
    try {
      const data = await (await fetch(this.src(), { credentials: 'same-origin' })).arrayBuffer();
      let obj: Object3D;
      if (ext === 'stl') {
        const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js');
        const geo: BufferGeometry = new STLLoader().parse(data);
        geo.computeVertexNormals();
        obj = new Mesh(geo, this.material());
      } else if (ext === 'obj') {
        const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
        obj = new OBJLoader().parse(new TextDecoder().decode(data));
        const m = this.material();
        obj.traverse(o => { if ((o as Mesh).isMesh) (o as Mesh).material = m; });
      } else if (ext === '3mf') {
        const { ThreeMFLoader } = await import('three/examples/jsm/loaders/3MFLoader.js');
        obj = new ThreeMFLoader().parse(data);
      } else {
        const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
        obj = await new Promise<Object3D>((ok, bad) => new GLTFLoader().parse(data, '', g => ok(g.scene), bad));
      }
      if (this.dead) return;
      const group = new Group();
      group.add(obj);
      // Z up, as CAD has it: the camera's up says so.
      this.camera.up.set(0, 0, 1);
      if (ext === 'glb' || ext === 'gltf') this.camera.up.set(0, 1, 0);
      this.scene.add(group);
      const box = new Box3().setFromObject(group);
      if (box.isEmpty()) { this.fail('The file holds no 3D shape'); return; }
      const c = box.getCenter(new Vector3()), r = box.getSize(new Vector3()).length() / 2 || 1;
      const eye = this.camera.up.z ? new Vector3(1, -1.4, 0.9) : new Vector3(1, 0.9, 1.4);
      this.camera.near = r / 100;
      this.camera.far = r * 100;
      this.camera.position.copy(c).add(eye.normalize().multiplyScalar(r * 3.4));
      this.camera.updateProjectionMatrix();
      this.controls!.target.copy(c);
      this.note.set('');
    } catch {
      this.fail('The model could not be read');
    }
  }

  private fail(msg: string) { this.failed.set(true); this.note.set(msg); }

  ngOnDestroy() {
    this.dead = true;
    cancelAnimationFrame(this.frame);
    this.resize?.disconnect();
    this.controls?.dispose();
    this.renderer?.dispose();
    this.renderer?.domElement.remove();
  }
}
