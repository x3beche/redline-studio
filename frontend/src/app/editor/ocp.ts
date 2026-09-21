import { Display, Viewer, decodeInstancedFormat, isInstancedFormat } from 'three-cad-viewer';
import type { CameraState } from '../api';

/** OCP CAD Viewer itself (three-cad-viewer): the same version and wire
 *  format the VS Code extension uses; Python produces the payload. */
export const TREE_W = 240;

export class OcpViewer {
  display!: Display;
  viewer!: Viewer;
  parts: string[] = [];
  /** resizeCadView throws before render() has been called. */
  private rendered = false;

  constructor(private container: HTMLElement) {}

  /** Display/Viewer is built once; switching models only calls load(). */
  init(size: { w: number; h: number }) {
    // Most DisplayOptions fields are required; omitting one breaks the build.
    const opts = {
      cadWidth: Math.max(size.w - TREE_W, 320), height: Math.max(size.h - 48, 320),
      treeWidth: TREE_W, treeHeight: Math.max(size.h - 220, 200),
      theme: 'dark' as const,
      tools: true, glass: false, pinning: false,
      measureTools: true, externalMeasurementBackend: false,
      selectTool: true, explodeTool: true, zscaleTool: false,
      zebraTool: true, studioTool: true,
    };
    this.display = new Display(this.container, opts);
    // render() lives on Viewer, not Display; the docs' display.render is wrong.
    this.viewer = new Viewer(this.display, opts, null);
  }

  async load(url: string) {
    if (this.rendered) this.viewer.clear();
    const envelope = await fetch(url).then(r => r.json());
    const raw = envelope.data ?? envelope;
    // The Python envelope arrives instanced; the viewer expects it decoded.
    const shapes = isInstancedFormat(raw) ? decodeInstancedFormat(raw) : raw.shapes ?? raw;

    const states: Record<string, [number, number]> = {};
    const walk = (node: any) => {
      if (node?.state) states[node.id] = node.state;
      (node?.parts ?? []).forEach(walk);
    };
    walk(shapes);

    this.parts = (shapes.parts ?? []).map((p: any) => p.name);
    this.viewer.render(shapes, states, {
      ambientIntensity: 1.0,
      directIntensity: 1.1,
      metalness: 0.3,
      roughness: 0.65,
      edgeColor: 0x707070,
      defaultOpacity: 0.5,
      normalLen: 0,
      up: 'Z',
      control: 'orbit',
      transparent: false,
      blackEdges: false,
      axes: false,
      axes0: false,
      grid: [false, false, false],
      ortho: false,
      ticks: 10,
      centerGrid: false,
    } as any);
    this.rendered = true;
  }

  /** Grow with the window; a fixed size caused overflow and page scroll.
   *  The viewer puts its toolbar above the canvas, so its height must be
   *  subtracted or the scene overflows and clips the axes marker. */
  resize(w: number, h: number) {
    if (!this.viewer || !this.rendered) return;
    const host = this.container.getBoundingClientRect();
    const c = this.container.querySelector('canvas');
    const chromeH = c ? Math.max(c.getBoundingClientRect().top - host.top, 0) : 48;
    const ch = Math.max(h - chromeH, 320);

    this.viewer.resizeCadView(Math.max(w - TREE_W, 320), TREE_W, ch, false);

    // The viewer adds its own borders, so the width we computed can overflow
    // and hide the dropdown under the side panel. Undo the measured overflow
    // once.
    const over = this.container.scrollWidth - w;
    if (over > 1) {
      this.viewer.resizeCadView(Math.max(w - TREE_W - over, 320), TREE_W, ch, false);
    }
  }

  /** Fires when a part is selected in the model.
 *
   *  The viewer emits no public selection event, so handlePick is wrapped:
   *  the original runs first, then the name is forwarded. */
  onPick(cb: (name: string | null) => void) {
    const viewer = this.viewer as any;
    const original = viewer.handlePick.bind(viewer);
    viewer.handlePick = (path: string, name: string, ...rest: unknown[]) => {
      original(path, name, ...rest);
      cb(name ?? viewer.lastSelection?.name ?? null);
    };
  }

  /** Canvas position inside the stage, used to align the drawing layer. */
  canvasRect(): DOMRect | null {
    const c = this.container.querySelector('canvas');
    return c ? c.getBoundingClientRect() : null;
  }

  /** Return the frozen frame as a PNG data URL. */
  async image(): Promise<string> {
    const res = await this.viewer.getImage('freeze');
    const d = (res as any)?.dataUrl ?? (res as any)?.data ?? res;
    return typeof d === 'string' ? d : '';
  }

  cameraState(): CameraState {
    const v = this.viewer;
    const p = v.getCameraPosition() as number[];
    const t = v.getCameraTarget() as number[];
    return { position: [p[0], p[1], p[2]], target: [t[0], t[1], t[2]], up: [0, 0, 1] };
  }

  applyCamera(s: CameraState) {
    const v = this.viewer;
    v.setCameraTarget(s.target as any, false);
    v.setCameraPosition(s.position as any, false, true);
  }

  setEnabled(on: boolean) {
    // Disable pointer interaction while frozen so the drawing layer takes over.
    const el = this.container.querySelector('canvas') as HTMLCanvasElement | null;
    if (el) el.style.pointerEvents = on ? 'auto' : 'none';
  }

  dispose() { this.viewer?.dispose?.(); this.display?.dispose?.(); }
}
