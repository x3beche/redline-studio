import { Display, Viewer, decodeInstancedFormat, isInstancedFormat } from 'three-cad-viewer';
import type { CameraState, ClipPlaneView, NoteView } from '../api';
import { ClipWheel } from './clip-wheel';

/** OCP CAD Viewer itself (three-cad-viewer): the same version and wire
 *  format the VS Code extension uses; Python produces the payload. */
export const TREE_W = 240;
/** Where the layout turns into the phone's (the same width as styles.css). */
const PHONE = '(max-width: 768px)';

/** The format of NoteView written now. 1 (no `v`) held only `states`. */
export const VIEW_FORMAT = 2;

type Vec3 = [number, number, number];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: number[]): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** A fingerprint of a stored view, the same in the page and in
 *  tools/render.py (view_hash): keys sorted, numbers to four decimals,
 *  FNV-1a over the UTF-8. The render compares it with its own to know the
 *  page applied this note's view and not some other. */
export function viewHash(view: unknown): string {
  const canon = (x: unknown): string => {
    if (x === null || x === undefined) return 'null';
    if (typeof x === 'boolean') return x ? 'true' : 'false';
    if (typeof x === 'number') {
      if (!Number.isFinite(x)) return 'null';
      const t = x.toFixed(4);
      return t === '-0.0000' ? '0.0000' : t;
    }
    if (typeof x === 'string') return JSON.stringify(x);
    if (Array.isArray(x)) return '[' + x.map(canon).join(',') + ']';
    const o = x as Record<string, unknown>;
    return '{' + Object.keys(o).filter(k => o[k] !== undefined).sort()
      .map(k => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}';
  };
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(canon(view))) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** What the viewer shows now of the things a NoteView sets, read back from
 *  the viewer itself - not from what was asked of it. */
export interface ViewReadback {
  tab: string;
  planes: { normal: Vec3; slider: number; offset: number }[];
  half: number;
  intersection: boolean;
  caps: boolean;
  helpers: boolean;
  ortho: boolean;
}

export interface ViewApplied {
  /** Every part of the view went in and reads back as asked. */
  ok: boolean;
  /** What did not, when not. */
  error: string | null;
  /** Parts in the note's tree that this build no longer has. */
  missing: number;
}

export class OcpViewer {
  display!: Display;
  viewer!: Viewer;
  parts: string[] = [];
  /** The wheel on the Clip tab's plane sliders, and its step control. */
  clipWheel: ClipWheel | null = null;
  /** resizeCadView throws before render() has been called. */
  private rendered = false;

  constructor(private container: HTMLElement) {}

  /** The viewer's own toolbar, so a control of ours can sit among its
   *  buttons instead of in a panel off to the side. */
  get toolbar(): HTMLElement | null {
    return this.container.querySelector('.tcv_cad_toolbar');
  }

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
    // Handle for tooling: the headless render and UI tests drive clipping
    // and the camera through this, and there is no other way in from outside
    // the component.
    (window as unknown as Record<string, unknown>)['tcv'] = this.viewer;
    this.clipWheel = new ClipWheel(this.container);
  }

  /** Load a payload into the scene. False, with the scene untouched, when
   *  `stillWanted` says another load has taken over while this one was
   *  downloading: two loads in flight used to both render, and whichever
   *  download finished last won - a big assembly reloaded by the poll
   *  landed on top of the small part that had been asked for. */
  async load(url: string, stillWanted: () => boolean = () => true): Promise<boolean> {
    // Fetch before clearing: a rebuild replaces the stored payload, and
    // clearing first left the scene blank for the whole download - or for
    // good, if the request failed.
    const res = await fetch(url);
    if (!res.ok) throw new Error(`viewer payload ${res.status}`);
    const envelope = await res.json();
    if (!stillWanted()) return false;
    if (this.rendered) this.viewer.clear();
    const raw = envelope.data ?? envelope;
    // The Python envelope arrives instanced; the viewer expects it decoded.
    const shapes = isInstancedFormat(raw) ? decodeInstancedFormat(raw) : raw.shapes ?? raw;

    const states: Record<string, [number, number]> = {};
    const walk = (node: any) => {
      if (node?.state) states[node.id] = node.state;
      (node?.parts ?? []).forEach(walk);
    };
    walk(shapes);

    // The model's own part names (NAMES). A model that uses components has
    // them under one node each (backend/assembly.py), so the tree's top
    // level is "Base", "Fan Module"... - not what the Part field offers.
    this.parts = Array.isArray(envelope.names) && envelope.names.length
      ? envelope.names.map(String)
      : (shapes.parts ?? []).map((p: any) => p.name);
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
    this.clipWheel?.ensure();
    return true;
  }

  /** Grow with the window; a fixed size caused overflow and page scroll.
   *  The viewer puts its toolbar above the canvas, so its height must be
   *  subtracted or the scene overflows and clips the axes marker. */
  resize(w: number, h: number) {
    if (!this.viewer || !this.rendered) return;
    const host = this.container.getBoundingClientRect();
    const c = this.container.querySelector('canvas');
    const chromeH = c ? Math.max(c.getBoundingClientRect().top - host.top, 0) : 48;

    // The body is a grid: the 3D area on top, the log under it. Sizing the
    // area to the whole stage made a canvas taller than the cell it is drawn
    // in, and the model then sat centred in the canvas rather than in what
    // you can see. The log's height comes off first.
    const log = this.container.querySelector('.tcv-log') as HTMLElement | null;
    const logH = log ? log.offsetHeight + 8 : 0;
    // On a phone the tree is not beside the view but under it (styles.css,
    // "PHONES"): the view takes the whole width and a little over half of
    // what is left under the toolbar, the tree and the log the rest.
    const phone = matchMedia(PHONE).matches;
    const ch = phone ? Math.max(Math.round((h - chromeH) * 0.55), 200)
                     : Math.max(h - chromeH - logH, 240);

    let cw = phone ? Math.max(w - 8, 200) : Math.max(w - TREE_W, 320);
    this.viewer.resizeCadView(cw, TREE_W, ch, false);

    // The viewer adds its own borders to the width it is given, so the canvas
    // comes out wider than the cell it is drawn in - and the model then sits
    // off-centre by half that. Measure what came out and take it off. The
    // grid fixes the column, so this settles rather than chasing itself.
    const cell = this.view?.getBoundingClientRect();
    const can = this.container.querySelector('canvas')?.getBoundingClientRect();
    if (cell && can) {
      const over = Math.round(can.width - cell.width);
      if (Math.abs(over) > 1) {
        cw = Math.max(cw - over, phone ? 200 : 320);
        this.viewer.resizeCadView(cw, TREE_W, ch, false);
      }
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

  /** The column holding the model tree. The running task is docked here,
   *  in the place the version/axes box used to sit: that box repeated what
   *  the page already knows and the task belongs next to the model. */
  get tree(): HTMLElement | null {
    return this.container.querySelector(".tcv_cad_navigation");
  }

  /** Which parts are shown and which are hidden, as the viewer keeps it:
   *  a map of tree path to [shape, edges]. The camera alone does not
   *  reproduce a view - half of what you see is what has been switched off. */
  states(): Record<string, [number, number]> | null {
    const v: any = this.viewer;
    return v?.getStates ? v.getStates() : null;
  }

  /** A note's part states against this build's tree. A part the note
   *  knew at a path the tree no longer has - "/Group/taban_kapak" from
   *  before components were grouped, now "/Station/Base/Lid/taban_kapak" -
   *  is found again by its own name, when exactly one part has that name. */
  static movedPaths(states: Record<string, [number, number]>,
                    have: Record<string, [number, number]>): Record<string, [number, number]> {
    const byLeaf = new Map<string, string[]>();
    for (const p of Object.keys(have)) {
      const leaf = p.slice(p.lastIndexOf('/') + 1);
      byLeaf.set(leaf, [...(byLeaf.get(leaf) ?? []), p]);
    }
    const out: Record<string, [number, number]> = {};
    for (const [p, st] of Object.entries(states)) {
      if (p in have) { out[p] = st; continue; }
      const found = byLeaf.get(p.slice(p.lastIndexOf('/') + 1)) ?? [];
      const to = found.length === 1 ? found[0] : p;
      if (!(to in out)) out[to] = st;
    }
    return out;
  }

  applyStates(states: Record<string, [number, number]> | null | undefined) {
    const v: any = this.viewer;
    if (!states || !v?.setState) return;
    for (const [path, st] of Object.entries(states)) {
      try { v.setState(path, st); } catch { /* a part that no longer exists */ }
    }
  }

  // ---- the whole view: clipping, tab, render settings ----
  // A note drawn on a clipped cross-section is a note about the inside of
  // the part; the same camera over the unclipped model shows the outside
  // wall. So everything that changes what the picture shows is kept with
  // the note and put back: three-cad-viewer's own getters and setters,
  // nothing reached into below them except the display's remembered
  // helper checkbox (see applyView).

  /** The centre a plane's slider is measured from: the CenteredPlane's own,
   *  i.e. the bounding box's centre of the model loaded now. */
  private clipCenter(i: number): Vec3 {
    const v: any = this.viewer;
    const c = v?.clipping?.clipPlanes?.[i]?.center ?? v?.bbox?.center?.() ?? [0, 0, 0];
    return [Number(c[0]) || 0, Number(c[1]) || 0, Number(c[2]) || 0];
  }

  /** Half the clipping sliders' travel: a slider here is a fully open plane. */
  private clipHalf(): number {
    return ((this.viewer as any)?.gridSize ?? 0) / 2;
  }

  readback(): ViewReadback {
    const v: any = this.viewer;
    const planes = [0, 1, 2].map(i => {
      const normal = unit(v.getClipNormal(i) as number[]);
      const slider = Number(v.getClipSlider(i));
      // CenteredPlane: n . p = n . centre - slider.
      return { normal, slider, offset: dot(normal, this.clipCenter(i)) - slider };
    });
    return {
      tab: v.state?.get('activeTab') ?? 'tree', planes, half: this.clipHalf(),
      intersection: !!v.getClipIntersection(), caps: !!v.state?.get('clipObjectColors'),
      helpers: !!v.getClipPlaneHelpers(), ortho: !!v.getOrtho(),
    };
  }

  /** Everything on screen that the camera does not say (NoteView). */
  captureView(): NoteView {
    const v: any = this.viewer;
    const rb = this.readback();
    const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
    const planes: ClipPlaneView[] = rb.planes.map((p, i) => ({
      normal: p.normal.map(r4) as Vec3, slider: r4(p.slider), offset: r4(p.offset),
      center: this.clipCenter(i).map(r4) as Vec3,
      enabled: p.slider < rb.half - Math.max(1e-6, rb.half * 1e-6),
    }));
    const studio: Record<string, string | number | boolean> = {};
    for (const k of ['Environment', 'EnvIntensity', 'Background', 'ToneMapping', 'Exposure',
                     'TextureMapping', 'EnvRotation', 'ShadowIntensity', 'ShadowSoftness',
                     'AOIntensity']) {
      const got = v['getStudio' + k]?.();
      if (got !== undefined && got !== null) studio[k] = got;
    }
    const c = this.canvasRect();
    const w = Math.round(c?.width ?? 0), h = Math.round(c?.height ?? 0);
    return {
      v: VIEW_FORMAT,
      states: this.states(),
      tab: rb.tab as NoteView['tab'],
      clip: { planes, intersection: rb.intersection, helpers: rb.helpers, caps: rb.caps,
              half: r4(rb.half) },
      render: {
        transparent: !!v.getTransparent(), black_edges: !!v.getBlackEdges(),
        axes: !!v.getAxes(), axes0: !!v.getAxes0(),
        grid: [...(v.getGrids() as [boolean, boolean, boolean])],
        opacity: v.getOpacity(), edge_color: v.getEdgeColor(),
        ambient: v.getAmbientLight(), direct: v.getDirectLight(),
        metalness: v.getMetalness(), roughness: v.getRoughness(),
      },
      zebra: {
        count: v.getZebraCount(), opacity: v.getZebraOpacity(),
        direction: v.getZebraDirection(), color_scheme: v.getZebraColorScheme(),
        mapping_mode: v.getZebraMappingMode(),
      },
      studio,
      camera: { ortho: rb.ortho, zoom: v.getCameraZoom(),
                quaternion: v.getCameraQuaternion() },
      canvas: { w, h, aspect: h ? Math.round((w / h) * 1e4) / 1e4 : 0 },
    };
  }

  /** Put a note's view back: parts, render settings, camera type, zebra and
   *  studio settings, the clipping planes, then the tab they show on. The
   *  camera itself is the caller's (applyCamera), after this - the camera
   *  type has to be switched first. A note from before format 2 gets its
   *  parts and nothing else, as it always did.
   *
   *  Clipping planes are put back by their world position (`offset`), not by
   *  the slider: the slider is measured from the bounding box's centre, so
   *  a rebuilt model of another size would move the same slider value to
   *  another cut. A plane that was fully open is opened fully again. */
  async applyView(view: NoteView | null | undefined): Promise<ViewApplied> {
    const v: any = this.viewer;
    if (!view || !v || !this.rendered) return { ok: true, error: null, missing: 0 };
    const have = this.states() ?? {};
    const states = OcpViewer.movedPaths(view.states ?? {}, have);
    const missing = Object.keys(states).filter(p => !(p in have)).length;
    if (v.setStates) {
      // One pass and one repaint, not a repaint per part.
      const known: Record<string, [number, number]> = {};
      for (const [p, st] of Object.entries(states)) if (p in have) known[p] = st;
      v.setStates(known);
      v.update?.(true, false);
    } else {
      this.applyStates(states);
    }
    if ((view.v ?? 1) < 2) return { ok: true, error: null, missing };

    // Setters are called with their notify left on: it is what drives the
    // viewer's own listeners - a tab set without it changes the state and
    // never switches the tab, and the checkboxes and sliders never follow.
    const errors: string[] = [];
    const tryDo = (what: string, f: () => void) => {
      try { f(); } catch (e) { errors.push(`${what}: ${(e as Error)?.message ?? e}`); }
    };
    const r = view.render;
    if (r) tryDo('render settings', () => {
      if (v.getTransparent() !== r.transparent) v.setTransparent(r.transparent);
      if (v.getBlackEdges() !== r.black_edges) v.setBlackEdges(r.black_edges);
      if (v.getAxes() !== r.axes) v.setAxes(r.axes);
      if (v.getAxes0() !== r.axes0) v.setAxes0(r.axes0);
      if (r.grid && JSON.stringify(v.getGrids()) !== JSON.stringify(r.grid)) v.setGrids(r.grid);
      if (r.opacity != null && v.getOpacity() !== r.opacity) v.setOpacity(r.opacity);
      if (r.edge_color != null && v.getEdgeColor() !== r.edge_color) v.setEdgeColor(r.edge_color);
      if (r.ambient != null) v.setAmbientLight(r.ambient);
      if (r.direct != null) v.setDirectLight(r.direct);
      if (r.metalness != null) v.setMetalness(r.metalness);
      if (r.roughness != null) v.setRoughness(r.roughness);
    });
    const cam = view.camera;
    if (cam && !!v.getOrtho() !== !!cam.ortho) tryDo('camera type', () => v.setOrtho(!!cam.ortho));
    const z = view.zebra;
    if (z) tryDo('zebra settings', () => {
      v.setZebraCount(z.count); v.setZebraOpacity(z.opacity); v.setZebraDirection(z.direction);
      v.setZebraColorScheme(z.color_scheme); v.setZebraMappingMode(z.mapping_mode);
    });
    if (view.studio) tryDo('studio settings', () => {
      for (const [k, val] of Object.entries(view.studio!)) v['setStudio' + k]?.(val);
    });
    const clip = view.clip;
    if (clip) tryDo('clipping', () => {
      const half = this.clipHalf();
      clip.planes.slice(0, 3).forEach((p, i) => {
        const n = unit(p.normal);
        const slider = p.enabled === false ? half
          : p.offset != null ? dot(n, this.clipCenter(i)) - p.offset : p.slider;
        v.setClipNormal(i, n, slider);
      });
      v.setClipIntersection(!!clip.intersection);
      v.setClipObjectColorCaps(!!clip.caps);
    });
    const tab = view.tab ?? 'tree';
    tryDo('tab', () => {
      // The display remembers the helper checkbox and puts it back on
      // every switch to the clip tab, over whatever was set before.
      if (clip && v.display) v.display.lastPlaneState = !!clip.helpers;
      if (v.state?.get('activeTab') !== tab) v.setActiveTab(tab);
      if (clip) v.setClipPlaneHelpers(!!clip.helpers);
    });
    if (tab === 'studio') {
      // Entering studio mode loads its environment asynchronously.
      for (let i = 0; i < 100 && !v.studioActive; i++) await new Promise(res => setTimeout(res, 100));
      if (!v.studioActive) errors.push('studio mode did not start');
    }
    v.update?.(true, false);
    errors.push(...this.viewMismatch(view));
    return { ok: !errors.length, error: errors.join('; ') || null, missing };
  }

  /** Where the viewer now differs from a note's view: the tab, the planes
   *  (by world position), the clip switches and the camera type. Empty when
   *  it shows what the note was drawn on. */
  viewMismatch(view: NoteView): string[] {
    if ((view.v ?? 1) < 2) return [];
    const rb = this.readback(), out: string[] = [];
    if ((view.tab ?? 'tree') !== rb.tab) out.push(`tab is ${rb.tab}, not ${view.tab}`);
    if (view.camera && !!view.camera.ortho !== rb.ortho) out.push('camera type differs');
    const clip = view.clip;
    if (clip) {
      const tol = Math.max(1e-3, rb.half * 1e-4);
      clip.planes.slice(0, 3).forEach((p, i) => {
        const got = rb.planes[i];
        if (Math.abs(dot(unit(p.normal), got.normal) - 1) > 1e-6) out.push(`plane ${i + 1} normal differs`);
        else if (p.enabled === false) {
          if (got.slider < rb.half - tol) out.push(`plane ${i + 1} is not open`);
        } else if (Math.abs(got.offset - p.offset) > tol) {
          out.push(`plane ${i + 1} cuts at ${got.offset.toFixed(3)}, not ${p.offset.toFixed(3)}`);
        }
      });
      if (!!clip.intersection !== rb.intersection) out.push('intersection mode differs');
      if (!!clip.caps !== rb.caps) out.push('cap colours differ');
      if (rb.tab === 'clip' && !!clip.helpers !== rb.helpers) out.push('plane helpers differ');
    }
    return out;
  }

  /** The viewer's body: the grid holding the tree column, the 3D area and
   *  the log. */
  get body(): HTMLElement | null {
    return this.container.querySelector(".tcv_cad_body");
  }

  /** The white 3D area itself. The log is docked inside it so it spans that
   *  band and not the tree column beside it. */
  get view(): HTMLElement | null {
    return this.container.querySelector(".tcv_cad_view");
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

  /** `zoom` is an orthographic camera's: a perspective camera's zoom is its
   *  distance, which the position already says. */
  applyCamera(s: CameraState, view?: NoteView | null) {
    const v = this.viewer;
    v.setCameraTarget(s.target as any, false);
    v.setCameraPosition(s.position as any, false, true);
    const zoom = view?.camera?.zoom;
    if (view?.camera?.ortho && v.getOrtho() && typeof zoom === 'number' && zoom > 0) {
      v.setCameraZoom(zoom, false);
    }
  }

  setEnabled(on: boolean) {
    // Disable pointer interaction while frozen so the drawing layer takes over.
    const el = this.container.querySelector('canvas') as HTMLCanvasElement | null;
    if (el) el.style.pointerEvents = on ? 'auto' : 'none';
  }

  dispose() { this.viewer?.dispose?.(); this.display?.dispose?.(); }
}
