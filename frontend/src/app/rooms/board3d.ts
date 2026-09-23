import {
  AfterViewInit, Component, ElementRef, OnDestroy, effect, input, signal,
  viewChild,
} from '@angular/core';
import {
  AmbientLight, Box3, Color, DirectionalLight, Object3D, PerspectiveCamera,
  Scene, Vector3, WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

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

  private host = viewChild.required<ElementRef<HTMLDivElement>>('host');
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

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(box);
    this.resize();

    const tick = () => {
      this.frame = requestAnimationFrame(tick);
      this.controls?.update();
      if (this.renderer && this.scene && this.camera) {
        this.renderer.render(this.scene, this.camera);
      }
    };
    tick();

    this.started = true;
    if (this.src()) this.load(this.src());
  }

  ngOnDestroy() {
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
    this.touched = false;
    this.frame_the(object);
    this.note.set('');
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
    const eye = Board3d.EYE;
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

  /** The backdrop follows the theme; the board brings its own colours. */
  background(css: string) {
    if (this.scene) this.scene.background = new Color(css);
  }
}
