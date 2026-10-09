import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable, catchError, filter, map, of, switchMap, take, throwError, timer } from 'rxjs';
import type { BudgetStatus } from './money';
import type { FwAnchor } from './selection';

/** Who did something: the person, or one of the agents. */
export interface Actor { type: 'user' | 'agent'; id: string; name: string }

export interface Revision {
  id: string;
  created_at: string;
  created_by?: Actor | null;
  status_by?: Actor | null;
  comment: string;
  image_path: string;
  camera: CameraState | null;
  /** What was on screen when the note was written: which parts were shown
   *  and, from format 2 on, the clipping, the tab and the render settings
   *  (NoteView). The camera alone is only where it was seen from. */
  view: NoteView | null;
  part: string | null;
  model: string | null;
  /** A board's note or a model's: each room shows its own. */
  kind: RevisionKind;
  /** A queued note's last run, when it has one: done or failed means it
   *  waits for someone to mark it applied, not for an agent. */
  run?: { status: string; finished_at?: string | null } | null;
  status: RevisionStatus;
  queued_at: string | null;
  edited_at: string | null;
  archived: boolean;
  image_bytes: number;
  /** The same view once the work is done; 0 until an after shot is taken. */
  image_after_bytes: number;
  /** What the work changed, file by file; null if it was not kept. */
  changes?: { kind: 'model' | 'board' | 'firmware'; id: string; added: number; removed: number }[] | null;
  /** A firmware note: the pin, net or code lines it is about. */
  anchor?: FwAnchor | null;
  /** A finished firmware note: the diff, the build, its figures. */
  fw_result?: FwResult | null;
  /** What was typed, when the note was saved as an English request. */
  comment_original: string | null;
  /** One short sentence, generated from the text and the drawing. */
  summary: string | null;
  /** True once someone has written it by hand; the generator then
   *  leaves it alone. */
  summary_manual: boolean;
  /** Filed from a ```task block in a chat (backend/tasks.py): a room's
   *  thread or an AI conversation, and the line it was written in. */
  from_chat?: { kind: 'thread' | 'ai'; room?: string; chat?: string; message: string;
                index: number; title?: string | null } | null;
}

/** What one revision cost to apply: tokens, money at list price, wall clock.
 *  Read from the agent's own transcripts, not estimated. */
export interface Analytics {
  _id: string;
  /** Whose calls these are. Normally the agent that held the note (and the
   *  sub-agents it started); `approximate` when that agent could not be told
   *  from the transcripts and everything in the run's time window was summed. */
  attribution?: { method: 'agent' | 'window'; approximate: boolean; label: string | null;
                  holders: { by: string | null; session?: string | null; agent?: string | null;
                             since: string | null; until?: string | null; resolved: boolean }[] };
  title: string | null;
  started_at: string;
  finished_at: string | null;
  computed_at: string;
  seconds: number;
  totals: {
    calls: number; input: number; output: number;
    cache_read: number; cache_write: number; thinking: number;
    billed_tokens: number; cost_usd: number;
    /** cache_read / calls: the context size, which is what the huge cache
     *  read total actually is - the same conversation re-read every call. */
    context_per_call: number;
    /** False when some model had no rate; the money figure is then partial. */
    complete: boolean;
    unpriced_models: string[];
  };
  rate: {
    output_per_s: number | null;
    billed_per_s: number | null;
    usd_per_min: number | null;
  };
  models: {
    model: string; provider: string; calls: number;
    input: number; output: number; cache_read: number; cache_write: number;
    cost_usd: number;
    /** "list" = published rate, "assumed" = put in its family's tier. */
    basis: string | null;
  }[];
  providers: { provider: string; calls: number; output: number; cost_usd: number }[];
  /** Which part of the app spent it: the agent applying the revision
   *  ("claude-code") or the card summariser ("card-summary"). */
  surfaces: { surface: string; provider: string; model: string;
              calls: number; output: number; cost_usd: number }[];
  /** What the spend went on: "work", "build", "progress" notes, "reply",
   *  "summary". Decided by what each request's turn actually did. */
  kinds: { kind: string; calls: number; output: number; cost_usd: number }[];
  /** Output tokens per bucket, for the rate chart. */
  series: { bucket_s: number; output: number[] };
  /** The machine's half of the bill: the builds and renders this revision
   *  needed. Absent on revisions applied before this was measured, which is
   *  why every field is optional - an old card says "not recorded" rather
   *  than claiming zero. */
  compute?: {
    totals: {
      jobs: number; wall_s: number; cpu_s: number; core_min: number;
      /** Seconds of the GPU, from nvidia-smi's own per-process sampler.
       *  Zero where there is no card to ask. */
      gpu_s: number;
      peak_rss_mb: number | null; read_mb: number; write_mb: number;
    };
    /** "assumed" unless the host let us read a real energy counter. */
    energy: { wh: number; basis: string; watts_per_core: number | null;
              watts_gpu: number | null;
              cost_usd: number | null; kwh_price?: number };
    kinds: { kind: string; jobs: number; wall_s: number; cpu_s: number;
             gpu_s: number; peak_rss_mb: number }[];
    /** The whole machine over the same window - the browser and the desktop
     *  included. Ours is a part of this, never the other way round. */
    machine: {
      busy_core_s: number; busy_core_min: number; cores: number;
      avg_cores_busy: number | null; ours_pct: number | null;
      energy: { wh: number; basis: string; watts_per_core: number | null;
                watts_gpu: number | null; cost_usd: number | null };
    } | null;
  };
}

/** Kept server-side so the CLI honours them too, not just this browser. */
export interface Settings {
  auto_archive: boolean;
  /** Turn a note into an English revision request as it is saved, so the
   *  summary and everything downstream read the same way. */
  auto_translate: boolean;
}

interface FwSize { used: number; total: number; pct: number }
/** What finishing a firmware note kept on it (backend/fwnotes.py result). */
export interface FwResult {
  firmware: string; title?: string; from_version: number; version: number;
  files: { path: string; status: string; added: number; removed: number; diff: string; generated: boolean }[];
  added: number; removed: number;
  build: { job?: string; version: number; at?: string; errors: number; warnings: number;
           flash: { before: FwSize | null; after: FwSize | null }; ram: { before: FwSize | null; after: FwSize | null } };
  main: { file: string; line: number } | null;
}

export type RevisionKind = 'cad' | 'pcb' | 'firmware';

/** draft = invisible to models; queued = in the apply queue (models read these). */
export type RevisionStatus = 'draft' | 'queued' | 'applied' | 'rejected';

export interface CameraState {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
}

/** One of the viewer's three clipping planes as it was drawn. `slider` is
 *  three-cad-viewer's own value: a distance from the model's bounding-box
 *  centre. `offset` is the same plane in world terms (n . p = offset), which
 *  is what is put back - a rebuilt model with another box keeps its cut where
 *  it was. `enabled` is false for a plane left fully open (slider at the end
 *  of its travel), which stays open whatever the new box. `normal` is the
 *  plane's real normal - the reverse switch (editor/clip-reverse.ts) negates
 *  the viewer's default - and is put back as it is. */
export interface ClipPlaneView {
  normal: [number, number, number];
  slider: number;
  offset: number;
  center: [number, number, number];
  enabled: boolean;
}

/** The whole view a note was drawn against (format 2). Older notes carry
 *  only `states`. */
export interface NoteView {
  v?: number;
  states: Record<string, [number, number]> | null;
  /** The viewer's side tab: clipping, zebra and studio only show on theirs. */
  tab?: 'tree' | 'clip' | 'zebra' | 'material' | 'studio';
  clip?: { planes: ClipPlaneView[]; intersection: boolean; helpers: boolean;
           caps: boolean; half: number };
  render?: { transparent: boolean; black_edges: boolean; axes: boolean; axes0: boolean;
             grid: [boolean, boolean, boolean]; opacity: number; edge_color: number;
             ambient: number; direct: number; metalness: number; roughness: number };
  zebra?: { count: number; opacity: number; direction: number;
            color_scheme: string; mapping_mode: string };
  studio?: Record<string, string | number | boolean>;
  camera?: { ortho: boolean; zoom: number; quaternion: [number, number, number, number] };
  /** The 3D canvas as drawn, in CSS pixels. Its aspect decides the framing. */
  canvas?: { w: number; h: number; aspect: number };
  /** The viewer's background it was drawn on (the theme's --view-top/mid/bottom). */
  backdrop?: { top: string; mid: string; bottom: string };
}

/** The only contact point with the backend. The Atlas URI lives in FastAPI. */
@Injectable({ providedIn: 'root' })
export class Api {
  private http = inject(HttpClient);

  list(archived = false): Observable<Revision[]> {
    return this.http.get<Revision[]>(`/api/revisions?archived=${archived}`);
  }

  settings(): Observable<Settings> {
    return this.http.get<Settings>('/api/settings');
  }

  setSetting(key: keyof Settings, value: boolean): Observable<Settings> {
    return this.http.put<Settings>(`/api/settings?${key}=${value}`, {});
  }

  archive(id: string, value: boolean): Observable<unknown> {
    return this.http.patch(`/api/revisions/${id}/archive?value=${value}`, {});
  }

  /** The marked image lives in the database; cards render it from this URL. */
  imageUrl(id: string, which: 'before' | 'after' = 'before'): string {
    return `/api/revisions/${id}/image?which=${which}`;
  }

  /** The viewer state a revision was drawn against: which parts were shown.
   *  Stored with the camera so the after shot can be taken from the same
   *  view, not just the same angle. */
  create(body: {
    comment: string; image_png: string | null;
    camera: CameraState | null; part: string | null; model: string | null;
      view?: NoteView | null;
      kind?: RevisionKind;
      anchor?: FwAnchor | null;
  }): Observable<Revision> {
    return this.http.post<Revision>('/api/revisions', body);
  }

  /** Only the text is editable; the drawing is the record and stays fixed. */
  edit(id: string, body: { comment?: string; part?: string | null;
                           summary?: string }): Observable<Revision> {
    return this.http.put<Revision>(`/api/revisions/${id}`, body);
  }

  one(id: string): Observable<Revision> {
    return this.http.get<Revision>(`/api/revisions/${id}`);
  }

  remove(id: string): Observable<unknown> {
    return this.http.delete(`/api/revisions/${id}`);
  }

  /** `live` re-reads the transcripts, for a run that is still going. */
  analytics(id: string, live = false): Observable<Analytics> {
    return this.http.get<Analytics>(
      `/api/revisions/${id}/analytics`, { params: { live } });
  }

  setStatus(id: string, status: RevisionStatus): Observable<unknown> {
    return this.http.patch(`/api/revisions/${id}?status=${status}`, {});
  }
}

// ---------------- model catalog ----------------
export interface ModelEntry {
  id: string; name: string; title: string;
  ready: boolean; stale: boolean; data: boolean; data_bytes: number;
  updated_at: string; built_at: string | null; sha256: string;
  /** True while a build is running, whether it was started here or from
   *  the command line. */
  building: boolean;
  build_started: string | null;
  /** Seconds the last successful build of this model took. */
  build_secs: number | null;
  /** The model as a component (backend/links.py): its version, what it
   *  imports, who imports it, and a rebuild a change elsewhere set off. */
  version?: number;
  uses?: ComponentUse[];
  used_by?: ComponentRef[];
  link?: LinkState | null;
  built_hash?: string | null;
  /** How many components it uses at a fixed version (a pin). */
  pinned?: number;
}
/** A component one model imports, at the version it is now and the one
 *  the model's last build had. */
export interface ComponentUse {
  kind: 'model' | 'board'; id: string; title: string; module?: string | null;
  version?: number | null; built_against?: number | null; pinned?: number | null;
}
export interface ComponentRef { kind?: 'model' | 'board'; id: string; title: string }
/** A rebuild set off by a change elsewhere. */
export interface LinkState {
  state: 'queued' | 'building' | 'done' | 'failed' | 'blocked' | 'cycle';
  because?: { kind: 'model' | 'board'; id: string; title: string; version?: number | null;
              /** Set when a pin moved rather than the component itself. */
              pin?: 'pinned' | 'follow' };
  error?: string; cycle?: string[]; at?: string; done_at?: string;
}
export interface BoardNode {
  id: string; name: string; title: string; kind: 'pcb';
  ready: boolean; stale: boolean; building: boolean; build_secs?: number | null;
  laid_out: boolean;
  /** The board as a 3D component: its version and who imports it. */
  version?: number; module?: string | null; has_3d?: boolean; used_by?: ComponentRef[];
}
/** A firmware in the catalog: under its board, as `<name>.fw` (backend/firmware.py). */
export interface FirmwareNode {
  id: string; title: string; name: string; kind: 'fw'; board: string; mcu: string; sheet: string;
  board_version: number; board_now: number; changed: boolean; building: boolean; built: string | null;
}
export interface FolderNode {
  name: string; path: string;
  folders: FolderNode[]; models: ModelEntry[]; boards?: BoardNode[]; firmware?: FirmwareNode[];
}
/** Anything a model can import: the Insert picker's rows. */
export interface ComponentRow {
  kind: 'model' | 'board'; id: string; title: string; version: number | null;
  module: string | null; ready: boolean; line: string | null; used_by: string[];
  uses?: string[]; pins?: Record<string, number>; stale?: boolean; state?: string | null;
}
/** One model as a component, for its links panel. */
export interface ModelLinks {
  id: string; version: number;
  uses: ComponentUse[]; used_by: ComponentRef[]; dependents: string[];
  built: { at: string | null; hash: string | null; current: boolean };
  link: LinkState | null; cycles: string[][]; pins: Record<string, number>;
  copied: { line: number; value: number; names: string[]; text: string }[];
  /** The models that use this one at a fixed version. */
  pinned_by?: PinnedBy[];
  stale?: boolean;
}
/** A model that pins a component, at which version, and whether that is
 *  older than the latest. */
export interface PinnedBy { id: string; title: string; version: number; latest: number | null; behind: boolean }
/** A kept version of a component: what a pin can point at. */
/** A kept version; `failed` when its own build failed (pins and "latest" skip it). */
export interface ComponentVersion { version: number; at: string | null; changes: string[];
                                    failed?: boolean; error?: string | null }
export interface ComponentVersions {
  /** latest: the newest version that builds; newest: the newest saved. */
  kind: 'model' | 'board'; id: string; latest: number | null; newest?: number | null;
  versions: ComponentVersion[]; pinned_by: PinnedBy[];
}
/** An importable name, and the component it resolves to (the build's table). */
export interface ModuleTarget { kind: 'model' | 'board'; id: string; title: string }
/** A row of the build's module table. A bare name several models share
 *  means one of them per project (top folder): `in`; elsewhere nothing
 *  (kind and id null) unless a model's whole-id name is that name. */
export interface ModuleRow {
  kind: 'model' | 'board' | null; id: string | null; title: string | null;
  in?: Record<string, ModuleTarget>; ambiguous?: string[];
}
/** A board's 3D component: version and the named data a model reads. */
export interface BoardComponent {
  board: string; title: string; module: string | null; line: string | null;
  component: { version: number; digest: string; at: string; step_bytes?: number;
               summary?: { size: number[]; thickness: number; holes: number; connectors: number;
                           approximate: string[] } } | null;
  data: {
    size: number[]; thickness: number;
    holes: { x: number; y: number; d: number; ref: string }[];
    connectors: { ref: string; value: string; edge: string | null; along: number | null;
                  height: number; overhang: number | null }[];
    keepout: { top: number; bottom: number; bounds: number[] };
    approximate: string[];
  } | null;
  used_by: (ComponentRef & { pinned?: number | null; state?: string | null })[];
  dependents: string[];
  pinned_by?: PinnedBy[];
  /** Every layout or run is a new version, even one that leaves the 3D as it was. */
  every_run?: boolean;
  /** The last export that failed, and why. */
  error?: { at: string; error: string } | null;
}

export interface UploadInfo { name: string; bytes: number; at: string; }
export interface UploadResult extends UploadInfo { model: string | null; }

@Injectable({ providedIn: 'root' })
export class Catalog {
  private http = inject(HttpClient);

  tree(): Observable<FolderNode> { return this.http.get<FolderNode>('/api/catalog'); }

  newFolder(name: string, parent = ''): Observable<{ path: string }> {
    return this.http.post<{ path: string }>(
      `/api/catalog/folders?name=${encodeURIComponent(name)}&parent=${encodeURIComponent(parent)}`, {});
  }

  build(id: string): Observable<{ model: string; artifacts: Record<string, number> }> {
    return this.http.post<{ model: string; artifacts: Record<string, number> }>(
      `/api/models/${id}/build`, {});
  }

  /** A brought-in CAD file. The server also writes a model that imports it,
   *  so it shows up in the viewer without another step. */
  upload(file: File): Observable<UploadResult> {
    const body = new FormData();
    body.append('file', file);
    return this.http.post<UploadResult>('/api/uploads', body);
  }

  uploads(): Observable<UploadInfo[]> {
    return this.http.get<UploadInfo[]>('/api/uploads');
  }

  dropUpload(name: string): Observable<unknown> {
    return this.http.delete(`/api/uploads/${encodeURIComponent(name)}`);
  }

  move(id: string, folder: string): Observable<{ from: string; to: string }> {
    return this.http.post<{ from: string; to: string }>(
      `/api/models/${id}/move?folder=${encodeURIComponent(folder)}`, {});
  }

  /** force replaces the refusal when another model imports this one. */
  dropModel(id: string, force = false): Observable<unknown> {
    return this.http.delete(`/api/models/${id}${force ? '?force=true' : ''}`);
  }

  /** Everything a model can import, models and boards alike. */
  components(): Observable<ComponentRow[]> {
    return this.http.get<ComponentRow[]>('/api/components');
  }

  links(id: string): Observable<ModelLinks> {
    return this.http.get<ModelLinks>(`/api/models/${id}/links`);
  }

  /** Use a component at a fixed version, or (null) follow it again. */
  pin(id: string, component: string, version: number | null): Observable<unknown> {
    return this.http.post(`/api/models/${id}/pins`, { component, version });
  }

  /** A component's kept versions, newest first, with what each changed. */
  componentVersions(kind: 'model' | 'board', id: string): Observable<ComponentVersions> {
    return this.http.get<ComponentVersions>(`/api/components/${kind}/${id}/versions`);
  }

  /** Every model pinned to an older version of this component, moved to its latest. */
  updatePins(kind: 'model' | 'board', id: string): Observable<{ updated: { model: string }[] }> {
    return this.http.post<{ updated: { model: string }[] }>(`/api/components/${kind}/${id}/update-pins`, {});
  }

  /** Every name a model can import, and what it is - the build's own table. */
  modules(): Observable<Record<string, ModuleRow>> {
    return this.http.get<Record<string, ModuleRow>>('/api/components/modules');
  }

  source(id: string): Observable<{ source: string; rev: string }> {
    return this.http.get<{ source: string; rev: string }>(`/api/models/${id}/source`);
  }

  saveSource(id: string, source: string, ifMatch: string): Observable<{ rev: string }> {
    return this.http.put<{ rev: string }>(`/api/models/${id}`, { source, if_match: ifMatch });
  }

  dropFolder(path: string): Observable<unknown> {
    return this.http.delete(`/api/catalog/folders/${path}`);
  }

  createModel(id: string, source: string): Observable<unknown> {
    return this.http.put(`/api/models/${id}`, { source });
  }

  /** The payload is served immutable, so the URL has to change when the
   *  model is rebuilt - without the stamp the browser keeps showing the
   *  build it cached, whatever the server now holds. */
  viewerUrl(id: string, stamp?: string | null): string {
    const url = `/api/models/${id}/viewer.json`;
    return stamp ? `${url}?v=${encodeURIComponent(stamp)}` : url;
  }

}

// ---------------- machine (the Analytics room's "now") ----------------
export interface SystemInfo {
  host: string; os: string;
  cpu: { name: string; cores: number; threads: number; load: number; freq_mhz: number | null };
  ram: { used_bytes: number; total_bytes: number; percent: number };
  gpu: { name: string; util: number; mem_used_mb: number;
         mem_total_mb: number; temp_c: number } | null;
}

// ---------------- boards ----------------
/** A board is parametric atopile that builds into a netlist: the parts it
 *  is made of and what is joined to what. */
/** What the router made of a board. */
export interface BoardRoute {
  tracks: number; vias: number; length_mm: number; zones: number;
  unrouted: number; route_s: number; passes: number;
  /** Which router drew it (absent: before there was a choice - Freerouting), and when. */
  engine?: string; at?: string;
  tracemaker?: { summary?: string | null; seconds?: number | null } | null;
}

/** KiCad's DRC over the routed board, as counts. */
export interface BoardDrc {
  errors: Record<string, number>;
  warnings: Record<string, number>;
  /** Findings wholly inside one part's footprint: the maker's land
   *  pattern, not the layout's doing. */
  in_footprints: Record<string, number>;
  error_count: number; warning_count: number; unconnected: number;
  unconnected_examples: string[];
  examples: string[];
  at: string;
}

export interface BoardErc {
  errors: Record<string, number>;
  warnings: Record<string, number>;
  /** About the generated project's library set-up, not the design. */
  setup: Record<string, number>;
  error_count: number; warning_count: number;
  examples: string[];
}

export interface BoardSchematic {
  parts: number; wires: number; labels: number; no_connects: number;
  symbols: number; size_mm: [number, number];
  erc: BoardErc;
  at: string;
  /** Drawn in sheets (backend/sheets.py): one per MCU, Power, Connectors &
   *  peripherals. Empty or missing: one sheet, the whole board. */
  sheets?: SchematicSheet[];
  mcus?: BoardMcu[];
}

export interface SchematicSheet {
  key: string; name: string; file: string;
  kind: 'mcu' | 'power' | 'peripherals';
  mcu?: string | null; refs: string[]; parts: number; global_labels: number;
  svg: string | null;
}

/** An MCU of the board, as GET /api/boards/{id}/mcus gives it. */
export interface BoardMcu {
  ref: string; part: string | null; title: string; sheet: string; key: string; file: string;
  svg: string | null;
  pins: { number: string; name: string; net: string | null; parts: string[] }[];
}

/** A net class: how wide, how far apart, which via, and its nets. */
export interface NetClass {
  name: string; track: number; clearance: number; via: number; drill: number;
  nets: string[]; patterns: string[];
}

export interface DiffPair { name: string; p: string; n: string; width: number; gap: number; }

export interface Pour {
  net: string; layers: string[]; clearance: number; connection: 'solid' | 'thermal';
}

export interface BoardRules {
  classes: NetClass[];
  pairs: DiffPair[];
  board: { layers: number; min_track: number; min_clearance: number;
           min_via: number; min_drill: number; min_edge?: number };
  pours: Pour[];
  route: { passes: number; tries?: number; engine?: string; seconds?: number };
  edited: boolean;
}

/** A long board step running apart from the API (backend/jobs.py). */
export interface BoardJob {
  job: string; kind: string; board: string;
  status: 'running' | 'done' | 'failed' | 'lost';
  result?: unknown; code?: number; detail?: unknown;
}

/** One rule field, as the server describes it (backend/rules.py SCHEMA). */
export interface RuleField {
  key: string; label: string;
  type: 'text' | 'number' | 'integer' | 'choice' | 'net' | 'nets' | 'patterns' | 'layers';
  unit?: string; min?: number; max?: number; step?: number; help?: string;
  options?: string[];
  /** How a choice's options read, where not as they are kept. */
  labels?: Record<string, string>;
}

/** Every section of the rules: one set of fields, or a list of rows. */
export type RuleSchema = Record<string, {
  label: string; help: string; list: boolean; fields: RuleField[];
  new?: Record<string, unknown>; fixed?: string[];
}>;

export interface RulesRead {
  rules: BoardRules; problems: string[]; nets: string[];
  members: Record<string, string[]>;
}

/** The routed board as data (docker/route.py geometry), in mm. `box` is
 *  the area the drawing is cropped to. */
export interface BoardGeometry {
  box: [number, number, number, number];
  tracks: { x1: number; y1: number; x2: number; y2: number; w: number;
            layer: string; net: string }[];
  vias: { x: number; y: number; d: number; drill: number; net: string }[];
  pads: { x: number; y: number; w: number; h: number; angle: number;
          shape: 'circle' | 'oval' | 'rect' | 'roundrect'; side: 'F' | 'B' | 'FB';
          net: string; ref: string; num: string; pin: string; drill: number }[];
  parts: { ref: string; value: string; side: 'F' | 'B'; box: number[] }[];
}

export interface BoardEntry {
  _id: string;
  title?: string;
  ready: boolean;
  layout?: BoardLayout;
  route?: BoardRoute | null;
  drc?: BoardDrc | null;
  schematic?: BoardSchematic | null;
  stale?: boolean;
  building?: boolean;
  build_secs?: number;
  artifacts?: Record<string, { bytes: number; at: string }>;
  kind?: string;
  /** An imported board written as atopile (backend/convert.py). */
  convert?: BoardConversion | null;
  /** The board as a 3D component: a new version with every layout that
   *  changes its STEP or named data (backend/board3d.py). */
  component?: { version: number; digest: string; at: string; module?: string;
                summary?: { size: number[]; thickness: number; holes: number; connectors: number;
                            approximate: string[] } } | null;
}

/** How an imported board came to have source: which parts were guessed,
 *  and whether the build is the imported circuit. */
export interface BoardConversion {
  status: 'converted' | 'needs parts' | 'build failed' | 'not equivalent' | 'building';
  bom: string | null;
  guessed: string[];
  unresolved: string[];
  findings: string[];
  problems?: string[];
  equivalence?: {
    equivalent: boolean;
    parts: { imported: number; built: number; missing: string[]; extra: string[] };
    nets: { imported: number; built: number; same: number; only_imported: number; only_built: number };
    pads_joined: { imported: number; built: number };
  };
}

/** What came of placing a board: how much of it could be drawn, and what
 *  could not - a part with no footprint anywhere is named, not skipped. */
export interface BoardLayout {
  placed: number | null;
  missing: string[];
  size_mm: [number, number] | null;
  parts_from_lcsc?: number;
  part_trouble?: string[];
  svg_bytes?: number;
  glb_bytes?: number;
  at?: string;
}

export interface BoardGraph {
  components: {
    ref: string; value: string | null; footprint: string | null;
    part: string | null;
    /** Where in the source it came from, so a mark leads back to a line. */
    where: string | null;
  }[];
  nets: { name: string | null; code: string | null;
          nodes: { ref: string | null; pin: string | null }[] }[];
  counts: { components: number; nets: number; joins: number };
  bom: Record<string, string>[];
  built_at: string;
}

/** The board room's Analytics tab: the board, its bill and its library,
 *  from what is already known. */
export interface BoardStats {
  parts: { components: number; nets: number | null; joins: number | null };
  size: { mm: [number, number] | null; area_cm2: number | null; density: number | null };
  route: { tracks: number; vias: number; length_mm: number; unrouted: number } | null;
  checks: { drc_errors: number | null; drc_warnings: number | null;
            unconnected: number | null; erc_errors: number | null } | null;
  bom: { lines: number; priced: number; cost_usd: number; basic: number;
         extended: number; unpartnumbered: number } | null;
  /** For the tab's charts: what the board is built of, and how its nets
   *  spread. */
  blocks: { label: string; value: number }[];
  fanout: { label: string; value: number }[];
}

/** One build or one placement, as the machine saw it. */
export interface BoardJob {
  kind: string;
  at: string;
  wall_s?: number;
  cpu_s?: number;
  cores_used?: number;
  peak_rss_mb?: number;
  rc?: number;
}

export interface BoardCompute {
  board: string;
  jobs: BoardJob[];
  total: { jobs: number; wall_s: number; cpu_s: number };
}

@Injectable({ providedIn: 'root' })
export class Boards {
  private http = inject(HttpClient);
  list(): Observable<BoardEntry[]> {
    return this.http.get<BoardEntry[]>('/api/boards');
  }
  source(id: string): Observable<{ source: string; entry?: string; title?: string }> {
    return this.http.get<{ source: string; entry?: string; title?: string }>(
      `/api/boards/${id}`);
  }
  save(id: string, source: string): Observable<unknown> {
    return this.http.put(`/api/boards/${id}`, { source });
  }
  build(id: string): Observable<{ components: number; nets: number; joins: number }> {
    return this.http.post<{ components: number; nets: number; joins: number }>(
      `/api/boards/${id}/build`, {});
  }
  /** Place the built netlist and draw it. KiCad runs in a container. */
  layout(id: string): Observable<BoardLayout> {
    return this.job<BoardLayout>(id, 'layout', {});
  }
  /** The whole of it: build, schematic, place, route, pour, DRC. */
  run(id: string): Observable<unknown> {
    return this.job<unknown>(id, 'run', {});
  }
  /** An imported board to atopile source, built and checked against the
   *  import; with a BOM CSV (as text) its part numbers replace guesses. */
  convert(id: string, bom?: string): Observable<BoardConversion> {
    return this.job<BoardConversion>(id, 'convert', { bom: bom ?? null });
  }
  /** A long board step as a job (backend/jobs.py): started detached, then
   *  followed until it is done - so the request never holds the server, and
   *  a reload of it in between is only a pause. Fails the way the step's own
   *  request would have, with its status and `detail`. */
  private job<T>(id: string, step: 'run' | 'convert' | 'layout', body: unknown): Observable<T> {
    const detail = (d: unknown) => (d && typeof d === 'object' && 'detail' in d ? (d as { detail: unknown }).detail : d);
    return this.http.post<BoardJob>(`/api/boards/${id}/${step}?detach=1`, body).pipe(
      catchError((e: HttpErrorResponse) => throwError(() => new HttpErrorResponse({
        error: { ...(e.error ?? {}), detail: detail(e.error?.detail) }, status: e.status, statusText: e.statusText }))),
      switchMap(started => timer(1500, 2500).pipe(
        switchMap(() => this.http.get<BoardJob>(`/api/boards/${id}/jobs/${started.job}`).pipe(
          // The server restarting under a reload: the job is not, ask again.
          catchError((e: HttpErrorResponse) => e.status === 0 || e.status >= 502 ? of(null) : throwError(() => e)))),
        filter((j): j is BoardJob => !!j && j.status !== 'running'),
        take(1),
        map(j => {
          if (j.status === 'done') return j.result as T;
          throw new HttpErrorResponse({ error: { detail: detail(j.detail) ?? `the ${step} was ${j.status}` },
                                        status: j.code ?? 500, statusText: j.status });
        }))));
  }
  rules(id: string): Observable<RulesRead> {
    return this.http.get<RulesRead>(`/api/boards/${id}/rules`);
  }
  /** What would be wrong with a draft, and who each class would hold. */
  checkRules(id: string, rules: BoardRules):
      Observable<{ problems: string[]; members: Record<string, string[]> }> {
    return this.http.post<{ problems: string[]; members: Record<string, string[]> }>(
      `/api/boards/${id}/rules/check`, { rules });
  }
  /** What every rule field is - the form is drawn from it. */
  rulesSchema(): Observable<RuleSchema> {
    return this.http.get<RuleSchema>('/api/rules/schema');
  }
  /** Only the router the next run uses (the switch beside Build). */
  saveEngine(id: string, engine: string): Observable<unknown> {
    return this.http.put(`/api/boards/${id}/rules/engine`, { engine });
  }
  saveRules(id: string, rules: BoardRules): Observable<unknown> {
    return this.http.put(`/api/boards/${id}/rules`, { rules });
  }
  geometry(id: string, stamp?: string): Observable<BoardGeometry> {
    return this.http.get<BoardGeometry>(
      `/api/boards/${id}/geometry.json` + (stamp ? `?v=${encodeURIComponent(stamp)}` : ''));
  }
  /** A drawing or a KiCad file of the board, stamped so a new one is not
   *  answered from the browser's cache. */
  file(id: string, name: string, stamp?: string): string {
    return `/api/boards/${id}/${name}` + (stamp ? `?v=${encodeURIComponent(stamp)}` : '');
  }
  /** The board's MCUs: the sheet each is drawn on and its pin map. */
  mcus(id: string): Observable<BoardMcu[]> {
    return this.http.get<BoardMcu[]>(`/api/boards/${encodeURIComponent(id)}/mcus`);
  }
  /** The Analytics tab's figures. Nothing in it asks LCSC. */
  analytics(id: string): Observable<BoardStats> {
    return this.http.get<BoardStats>(`/api/boards/${id}/analytics`);
  }
  /** What this board has cost the machine, job by job. */
  compute(id: string): Observable<BoardCompute> {
    return this.http.get<BoardCompute>(`/api/boards/${id}/compute`);
  }
  /** Put it in a folder. The id does not change: it is not a path. */
  move(id: string, folder: string): Observable<unknown> {
    return this.http.post(
      `/api/boards/${id}/move?folder=${encodeURIComponent(folder)}`, {});
  }
  drop(id: string, force = false): Observable<unknown> {
    return this.http.delete(`/api/boards/${id}${force ? '?force=true' : ''}`);
  }
  /** The board as a 3D component. */
  component(id: string): Observable<BoardComponent> {
    return this.http.get<BoardComponent>(`/api/boards/${id}/component`);
  }
  /** How the board's 3D component is versioned. */
  componentSettings(id: string, everyRun: boolean): Observable<unknown> {
    return this.http.put(`/api/boards/${id}/component/settings`, { every_run: everyRun });
  }
  graph(id: string, stamp?: string): Observable<BoardGraph> {
    return this.http.get<BoardGraph>(
      `/api/boards/${id}/graph.json` + (stamp ? `?v=${encodeURIComponent(stamp)}` : ''));
  }
}

// ---------------- parts ----------------
/** A part as LCSC lists it: enough to choose between two capacitors. */
export interface PartHit {
  lcsc: string;
  mpn: string | null;
  package: string | null;
  maker: string | null;
  stock: number | null;
  price: number | null;
  have?: boolean;
}

/** Everything about a part that can be known without keeping it. The
 *  drawings, model and photo are separate URLs so the facts can show at
 *  once and the 3D shape arrive when it arrives. */
export interface PartPreview {
  lcsc: string;
  name: string | null;
  description: string;
  maker: string | null;
  mpn: string | null;
  package: string | null;
  /** JLCPCB's assembly class: "Basic Part" or "Extended Part". */
  jlc_class: string | null;
  price: number | null;
  stock: number | null;
  min: number | null;
  url: string | null;
  has_photo: boolean;
  has_model: boolean;
  model_name: string | null;
  have: boolean;
}

/** A part that has been fetched and kept. */
export interface PartHeld {
  lcsc: string;
  name: string | null;
  has_3d: boolean;
  at: string;
  /** Where it sits in the drawer (backend/lcsc.py drawer_place). */
  group?: string;
  branch?: string;
  category?: string | null;
  value?: string | null;
  mpn?: string | null;
  maker?: string | null;
  /** Who put it there: LCSC's category (rules), a model, or somebody by hand. */
  place_by?: 'rules' | 'llm' | 'manual';
  place_model?: string | null;
}

@Injectable({ providedIn: 'root' })
export class Parts {
  private http = inject(HttpClient);
  /** The drawer: what has been fetched already. */
  held(): Observable<PartHeld[]> { return this.http.get<PartHeld[]>('/api/parts'); }
  /** LCSC's catalogue. Nothing is downloaded by looking. */
  search(q: string, limit = 20): Observable<PartHit[]> {
    return this.http.get<PartHit[]>(
      `/api/parts/search?q=${encodeURIComponent(q)}&limit=${limit}`);
  }
  /** Fetch one and keep it: footprint, and the model if there is one. */
  add(lcsc: string): Observable<{ lcsc: string; name: string; has_3d: boolean }> {
    return this.http.post<{ lcsc: string; name: string; has_3d: boolean }>(
      `/api/parts/${lcsc}`, {});
  }
  drop(lcsc: string): Observable<unknown> {
    return this.http.delete(`/api/parts/${lcsc}`);
  }
  /** A look before keeping: facts now, drawings and the model by URL. */
  preview(lcsc: string): Observable<PartPreview> {
    return this.http.get<PartPreview>(`/api/parts/${lcsc}/preview`);
  }
  file(lcsc: string, name: 'footprint.svg' | 'symbol.svg' | 'model.glb' | 'photo.jpg'): string {
    return `/api/parts/${encodeURIComponent(lcsc)}/${name}`;
  }
}

// ---------------- the line to the agent ----------------
/** Everything that is not a mark on a model: move these into a folder,
 *  rename that one, why is this build slow. */
export interface ChatLine {
  _id: string;
  at: string;
  role: 'user' | 'agent';
  /** Which agent, or which person, wrote it (absent on older lines). */
  by?: Actor;
  text: string;
  /** "Stop what you are doing", as opposed to "when you get a moment". An
   *  urgent line kills a build that is running when it lands. */
  urgent?: boolean;
  /** Null until the agent has picked it up - that is what its idle wait
   *  watches, and what the page shows as "not read yet". */
  seen_at: string | null;
  /** Which ```task blocks went to the queue, by index (backend/tasks.py). */
  tasks?: Record<string, { note_id?: string; at: string; by?: { id?: string; name?: string };
                           room?: string; target?: string; pending?: boolean }>;
  /** Changed after it was written, and by whom and why (e.g. a task block
   *  added by Redline to an older answer). */
  edited?: { at: string; by: string; why?: string };
  /** Which room's thread it is in. */
  room?: string;
  /** Files of the Files tab it carries - pictures pasted, dropped or
   *  attached in the composer (backend/chat.py file_chips). */
  mentions?: { kind: 'file'; id: string; label: string; sub?: string; image?: boolean; bytes?: number }[];
}

@Injectable({ providedIn: 'root' })
export class Chat {
  private http = inject(HttpClient);
  /** One room's thread - each tab has its own. */
  history(room: string): Observable<ChatLine[]> {
    return this.http.get<ChatLine[]>(`/api/chat?room=${room}`);
  }
  say(text: string, urgent = false, room = 'cad', files: string[] = []): Observable<ChatLine> {
    return this.http.post<ChatLine>('/api/chat', { text, urgent, room, files });
  }
  /** Unsend. Refused once the agent has picked the message up. */
  retract(id: string): Observable<unknown> {
    return this.http.delete(`/api/chat/${id}`);
  }
  /** A line in the reader's language (backend/reading.py). */
  translate(id: string, lang: string): Observable<Translation> {
    return this.http.post<Translation>(`/api/chat/${id}/translate`, { lang });
  }
}

// ---------------- questions the agent is waiting on ----------------
/** An agent applying a revision sometimes reaches a fork that is not its
 *  to choose. It writes the question here and blocks; the page answers. */
export interface Question {
  _id: string;
  at: string;
  text: string;
  /** What the agent already knows, so the reader need not reconstruct it. */
  context: string | null;
  /** Offered answers. The form takes free text whether or not these exist. */
  options: string[];
  multi: boolean;
  revision: string | null;
  status: 'open' | 'answered' | 'dropped';
  answer: string | null;
  /** Whose thread it belongs in: a board note's question is the PCB room's. */
  room?: string;
  answered_at?: string | null;
  /** Who answered it (absent on older questions). */
  answered_by?: Actor | null;
  /** Which agent asked. */
  asked_by?: Actor | null;
}

@Injectable({ providedIn: 'root' })
export class Questions {
  private http = inject(HttpClient);
  open(): Observable<Question[]> {
    return this.http.get<Question[]>('/api/questions');
  }
  /** Answered ones, oldest first: a room's thread keeps them in its log. */
  answered(room: string): Observable<Question[]> {
    return this.http.get<Question[]>('/api/questions/answered', { params: { room } });
  }
  answer(id: string, answer: string): Observable<Question> {
    return this.http.post<Question>(`/api/questions/${id}/answer`, { answer });
  }
  /** The question in another language (backend/reading.py). Asked once per
   *  language; the server keeps it on the question. */
  translate(id: string, lang: string): Observable<Translation> {
    return this.http.post<Translation>(`/api/questions/${id}/translate`, { lang });
  }
}

/** A question, or a line of the thread, in the reader's language. Only the
 *  fields the thing has: a thread line has no context or options. */
export interface Translation {
  id: string;
  lang: string | null;
  text: string;
  context?: string | null;
  options?: string[];
  provider?: string;
  model?: string;
  cached: boolean;
  original?: boolean;
}

// ---------------- activity log and run progress ----------------
export interface LogLine {
  _id: string; at: string; text: string;
  level: 'info' | 'work' | 'done' | 'warn' | 'error';
}
export interface Run {
  _id: string; title: string; revision: string | null; model: string | null;
  percent: number; status: 'running' | 'done' | 'failed';
  started_at: string; finished_at: string | null;
}

@Injectable({ providedIn: 'root' })
export class Activity {
  private http = inject(HttpClient);
  /** One room's log: the 3D room's is about models, the board room's
   *  about boards. */
  lines(limit = 120, room: 'cad' | 'pcb' = 'cad'): Observable<LogLine[]> {
    return this.http.get<LogLine[]>(`/api/activity?limit=${limit}&room=${room}`);
  }
  /** The run in one room. Each room has its own, so the tabs' agents can
   *  work at once. */
  run(room: string = 'cad'): Observable<Run | null> {
    return this.http.get<Run | null>(`/api/run?room=${room}`);
  }
}

// ---------------- analytics ----------------

/** What /api/insights answers: everything used over a range, bucketed. */
export interface InsightSeries { t0: number; step: number; n: number;
  series: { name: string; values: (number | null)[] }[] }
export interface InsightRow { name: string; calls?: number; cost_usd?: number; tokens?: number;
  [k: string]: unknown }
export interface Insights {
  range: { since: string; until: string; step: number };
  /** When the server worked it out, and whether a newer one is on its way. */
  computed_at?: string; stale?: boolean; age_s?: number; shape?: number;
  /** How long the server took to work the figures out. */
  took_ms?: number;
  llm: { calls: number; cost_usd: number; unpriced_calls: number;
         tokens: Record<string, number>;
         cost_by_provider: InsightSeries; cost_by_model: InsightSeries; tokens_by_type: InsightSeries;
         by_model: InsightRow[]; by_provider: InsightRow[]; by_surface: InsightRow[];
         by_room: InsightRow[]; by_project: InsightRow[];
         /** Each note as its card costs it; `approximate` when its agent could
          *  not be told and the time window was used (backend/insights.py). */
         top_notes: { id: string; title: string; room: string; project: string; calls: number;
                      cost_usd: number; tokens: number; approximate?: boolean;
                      approximate_label?: string | null }[] };
  compute: { count: number; wall_s: number; cpu_s: number; wh: number; failed: number;
             cpu_hours_by_kind: InsightSeries;
             by_kind: { name: string; jobs: number; wall_s: number; cpu_s: number; wh: number;
                        peak_rss_mb: number }[] };
  machine: { cpu: InsightSeries; ram: InsightSeries; gpu: InsightSeries; watts: InsightSeries;
             energy_wh: InsightSeries; now: SystemInfo };
  energy: { machine_kwh: number; jobs_kwh: number; basis: string; kwh_price: number | null;
            machine_cost: number | null; samples: number; sampled_since: string | null;
            watts_per_core: number };
  work: { notes_by_room: InsightSeries; runs_done_by_room: InsightSeries;
          status: Record<string, number>;
          runs_by_room: { room: string; runs: number; done: number; seconds: number; avg_s: number | null }[];
          chat: InsightSeries;
          questions: { asked: number; answered: number; avg_wait_s: number | null } };
  storage: { db_bytes: number; db_storage: number; index_bytes: number; objects: number;
             collections: { name: string; docs: number; bytes: number; storage: number }[];
             caches: { name: string; bytes: number }[];
             disk: { total: number; used: number; free: number } };
  catalog: { folders: number; models: number; boards: number; parts: number;
             notes: number;
             projects: { name: string; models: number; boards: number; notes: number;
                         cost_usd: number }[] };
  lcsc: { by_source: InsightSeries; totals: Record<string, number> };
  lead_times: { by_room: { room: string; notes: number; writing: number | null; waiting: number | null;
                           working: number | null; total: number | null }[];
                slowest: { id: string; room: string; title: string; writing: number | null;
                           waiting: number | null; working: number | null; total: number | null }[] };
  questions: { at: string; question: string; text: string; answer: string; status: string;
               wait_s: number | null; room: string | null }[];
  cache: { read: number; write: number; fresh: number; hit_ratio: number | null; saved_usd: number;
           by_model: { name: string; cache_read: number; cache_write: number; input: number;
                       hit_ratio: number | null; saved_usd: number | null }[];
           hit_series: InsightSeries };
  subscription: { plan_usd_month: number | null; plan_name: string | null; months: number;
                  list_usd: number; plan_usd: number | null; saved_usd?: number; ratio?: number | null };
  builds: { by_kind: { name: string; jobs: number; failed: number; fail_rate: number | null;
                       median_s: number | null; max_s: number | null }[];
            model_trend: InsightSeries;
            by_model: { name: string; builds: number; median_s: number | null; max_s: number }[] };
  note_costs: { series: InsightSeries; notes: number; median: number | null; mean: number | null;
                approximate?: number; approximate_label?: string };
  api: { requests: number; errors: number; per_bucket: InsightSeries; latency: InsightSeries;
         routes: { route: string; count: number; avg_ms: number; p95_ms: number | null;
                   max_ms: number; errors: number }[] };
  board_quality: { board: string; runs: BoardRunRow[]; first: BoardRunRow; last: BoardRunRow }[];
  loops: { jobs: { id: string; kind: string; runs: number; failed: number; wall_s: number; title: string;
                   room: string; project: string }[];
           reruns: { id: string; runs: number; title: string }[] };
  waste: { rerun_usd: number; rerun_runs: number; rejected_usd: number; rejected_notes: number;
           failed_jobs: number; failed_cpu_h: number; failed_wh: number;
           failed_by_kind: Record<string, number>; usd: number };
  uptime: { starts: { at: string; server: string }[]; gaps: { from: string; to: string; minutes: number }[];
            down_minutes: number; watched_hours: number; up_pct: number | null; errors_5xx: number;
            error_routes: { route: string; errors: number }[] };
  db_latency: { series: InsightSeries; median_ms: number | null; p95_ms: number | null; samples: number };
  growth: { added: InsightSeries; per_day_bytes: number; files: number; files_bytes: number;
            quota_bytes: number; db_storage?: number; quota_days?: number | null;
            disk_free?: number; disk_per_day_bytes?: number; disk_days?: number | null };
  docker: { available: boolean;
            summary?: { type: string; total: string; active: string; size: string; reclaimable: string }[];
            images?: { name: string; size: string; created: string; redline: boolean }[];
            containers?: { name: string; image: string; state: string; status: string; size: string }[] };
  anomalies: { buckets: number[]; items: { kind: string; what: string; id?: string; at?: string; value: number;
                                           typical: number; unit: string }[] };
  previous: Record<string, number>;
  change: Record<string, number | null>;
  now_totals: Record<string, number>;
  weekly: { at: string; week: string; text: string }[];
  project_detail: Record<string, ProjectDetail>;
  /** The rates the figures were read against (money.ts converts on screen). */
  fx?: { display_currency: string; rates: Record<string, number>; date: string | null };
  /** What running Redline cost over the range, in dollars (Settings > Costs & currency). */
  costs?: InsightCosts;
  /** This calendar month's budgets (UTC), whatever the range. */
  budget_status?: BudgetStatus;
}

export interface InsightCosts {
  /** The range's length in months, for the prorated subscriptions. */
  months: number;
  items: { name: string; kind: 'subscription' | 'electricity' | 'proxy' | 'other' | 'llm_list' | string;
           usd: number; detail?: string }[];
  subscriptions_usd: number; other_usd: number; electricity_usd: number | null; proxy_usd: number | null;
  proxy_gb: number | null; total_usd: number; llm_list_usd: number;
}

export interface ProjectItem {
  id: string; kind: 'model' | 'board' | string; title: string; picture: string | null;
  notes: number; applied: number; spend_usd: number; runs: number; run_median_s: number | null;
  jobs: number; failed: number; job_median_s: number | null;
  history: Record<string, unknown>[];
  size_bytes?: number | null; build_secs?: number | null;
  build_walls?: { at: string; wall_s: number | null; ok: boolean }[];
  unrouted?: number | null; drc_errors?: number | null; size_mm?: number[] | null;
  board_runs?: BoardRunRow[];
}

export interface ProjectDetail {
  name: string; items: ProjectItem[]; spend_usd: number; notes: number; runs: number; jobs: number;
  failed: number; spend_series: InsightSeries | null;
  lead: Insights['lead_times']['slowest'];
  questions: Insights['questions'];
}

export interface BoardRunRow {
  at: string; unrouted: number | null; drc_errors: number | null; drc_warnings: number | null;
  erc_errors: number | null; area_cm2: number | null; tracks: number | null; vias: number | null;
  length_mm: number | null; parts: number | null; seconds: number | null;
}

@Injectable({ providedIn: 'root' })
export class InsightsApi {
  private http = inject(HttpClient);
  get(range: string): Observable<Insights> {
    return this.http.get<Insights>(`/api/insights?range=${encodeURIComponent(range)}`);
  }
  /** Who deleted, changed or reset what, newest first. */
  audit(limit = 100): Observable<AuditRow[]> {
    return this.http.get<AuditRow[]>(`/api/audit?limit=${limit}`);
  }
  /** The last seven days in a few lines, and the weekly write-ups kept. */
  weekly(): Observable<{ now: string; kept: { at: string; week: string; text: string }[] }> {
    return this.http.get<{ now: string; kept: { at: string; week: string; text: string }[] }>('/api/insights/weekly');
  }
  /** The electricity price and the subscription; only what is sent changes. */
  setSettings(patch: { kwh_price?: number | null; plan_usd_month?: number | null;
                       plan_name?: string | null }): Observable<unknown> {
    return this.http.put('/api/insights/settings', patch);
  }
}

export interface AuditRow { at: string; actor: Actor; action: string; target: string;
  detail?: { method?: string; query?: string } }
