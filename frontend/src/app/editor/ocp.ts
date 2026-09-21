import { Display, Viewer, decodeInstancedFormat, isInstancedFormat } from 'three-cad-viewer';
import type { CameraState } from '../api';

/** OCP CAD Viewer'in kendisi (three-cad-viewer). VS Code eklentisiyle ayni
 *  surum ve ayni veri formati; model.json'u Python tarafi ureiyor. */
export const TREE_W = 240;

export class OcpViewer {
  display!: Display;
  viewer!: Viewer;
  parts: string[] = [];
  /** resizeCadView, render() cagrilmadan once hata firlatiyor. */
  private rendered = false;

  constructor(private container: HTMLElement) {}

  /** Display/Viewer bir kez kurulur; model degisince sadece load() cagrilir. */
  init(size: { w: number; h: number }) {
    // DisplayOptions alanlarinin cogu zorunlu; eksik birakmak derlemede patliyor.
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
    // render() Display'de degil Viewer'da; dokumandaki display.render ornegi yanlis.
    this.viewer = new Viewer(this.display, opts, null);
  }

  async load(url: string) {
    if (this.rendered) this.viewer.clear();
    const envelope = await fetch(url).then(r => r.json());
    const raw = envelope.data ?? envelope;
    // Python zarfi "instanced" formatta gelir; viewer once cozmemizi bekler.
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

  /** Pencereyle birlikte buyusun; sabit olcu tasma ve kaydirma yaratiyordu.
   *  Viewer kendi arac cubugunu canvas'in ustune koyuyor, onun yuksekligini
   *  dusmezsek sahne pencereden tasip eksen gostergesini kirpiyor. */
  resize(w: number, h: number) {
    if (!this.viewer || !this.rendered) return;
    const host = this.container.getBoundingClientRect();
    const c = this.container.querySelector('canvas');
    const chromeH = c ? Math.max(c.getBoundingClientRect().top - host.top, 0) : 48;
    const ch = Math.max(h - chromeH, 320);

    this.viewer.resizeCadView(Math.max(w - TREE_W, 320), TREE_W, ch, false);

    // Viewer kendi kenarliklarini ekliyor; hesapla verilen genislik gercekte
    // tasabiliyor ve sagdaki acilir liste panelin altinda kaliyordu.
    // Olculen tasmayi bir kez geri al.
    const over = this.container.scrollWidth - w;
    if (over > 1) {
      this.viewer.resizeCadView(Math.max(w - TREE_W - over, 320), TREE_W, ch, false);
    }
  }

  /** Modelde bir parca secilince haber verir.

   *  Viewer secim icin disa acik bir olay yayinlamiyor; handlePick'i sarmalayip
   *  orijinali cagirdiktan sonra adi iletiyoruz. */
  onPick(cb: (name: string | null) => void) {
    const viewer = this.viewer as any;
    const original = viewer.handlePick.bind(viewer);
    viewer.handlePick = (path: string, name: string, ...rest: unknown[]) => {
      original(path, name, ...rest);
      cb(name ?? viewer.lastSelection?.name ?? null);
    };
  }

  /** Cizim katmanini hizalamak icin canvas'in sahne icindeki konumu. */
  canvasRect(): DOMRect | null {
    const c = this.container.querySelector('canvas');
    return c ? c.getBoundingClientRect() : null;
  }

  /** Dondurulmus kareyi PNG data-URL olarak verir. */
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
    // Dondurunca fare etkilesimini kapat, cizim katmani devralsin.
    const el = this.container.querySelector('canvas') as HTMLCanvasElement | null;
    if (el) el.style.pointerEvents = on ? 'auto' : 'none';
  }

  dispose() { this.viewer?.dispose?.(); this.display?.dispose?.(); }
}
