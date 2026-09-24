import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface Revision {
  id: string;
  created_at: string;
  comment: string;
  image_path: string;
  camera: CameraState | null;
  /** Which parts were shown when the note was written. The camera alone is
   *  only where it was seen from. */
  view: { states: Record<string, [number, number]> | null } | null;
  part: string | null;
  model: string | null;
  /** A board's note, a model's, or one of the coding rooms': each room
   *  shows its own. */
  kind: RevisionKind;
  /** A note on a running interface: where it was drawn and what was under
   *  the marks. Null for the other rooms. */
  code: CodeNote | null;
  status: RevisionStatus;
  queued_at: string | null;
  edited_at: string | null;
  archived: boolean;
  image_bytes: number;
  /** The same view once the work is done; 0 until an after shot is taken. */
  image_after_bytes: number;
  /** What was typed, when the note was saved as an English request. */
  comment_original: string | null;
  /** One short sentence, generated from the text and the drawing. */
  summary: string | null;
  /** True once someone has written it by hand; the generator then
   *  leaves it alone. */
  summary_manual: boolean;
}

/** What one revision cost to apply: tokens, money at list price, wall clock.
 *  Read from the agent's own transcripts, not estimated. */
export interface Analytics {
  _id: string;
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

export type RevisionKind = 'cad' | 'pcb' | 'web' | 'embedded' | 'mobile';

/** One element a mark landed on, as the note keeps it. */
export interface DomHit {
  selector: string;
  tag: string;
  text: string;
  box: [number, number, number, number];
  component: string | null;
  file: string | null;
  line: number | null;
}

export interface CodeNote {
  route: string;
  viewport: [number, number];
  base: string | null;
  dom: DomHit[];
}

/** draft = invisible to models; queued = in the apply queue (models read these). */
export type RevisionStatus = 'draft' | 'queued' | 'applied' | 'rejected';

export interface CameraState {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
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
      view?: { states: Record<string, [number, number]> | null } | null;
      kind?: RevisionKind;
      code?: unknown;
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
}
export interface FolderNode {
  name: string; path: string;
  folders: FolderNode[]; models: ModelEntry[];
}

// ---------------- version history ----------------
export interface ModelVersion {
  _id: string; created_at: string; note: string;
  short: string; sha256: string;
  model_count: number; chars: number;
  models?: { id: string; title: string; short: string; chars: number }[];
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

  versions(): Observable<ModelVersion[]> {
    return this.http.get<ModelVersion[]>('/api/versions');
  }

  snapshot(note: string): Observable<ModelVersion> {
    return this.http.post<ModelVersion>(`/api/versions?note=${encodeURIComponent(note)}`, {});
  }

  restore(id: string): Observable<unknown> {
    return this.http.post(`/api/versions/${id}/restore`, {});
  }
}

// ---------------- status ----------------
export interface Stats {
  db?: string; collections?: number; objects?: number;
  data_bytes?: number; used_bytes: number; index_bytes?: number;
  quota_bytes: number | null; percent?: number | null;
  revisions: Record<string, number>; versions: number; models?: number;
}
export interface SystemInfo {
  host: string; os: string;
  cpu: { name: string; cores: number; threads: number; load: number; freq_mhz: number | null };
  ram: { used_bytes: number; total_bytes: number; percent: number };
  gpu: { name: string; util: number; mem_used_mb: number;
         mem_total_mb: number; temp_c: number } | null;
}

@Injectable({ providedIn: 'root' })
export class Health {
  private http = inject(HttpClient);
  stats(): Observable<Stats> { return this.http.get<Stats>('/api/stats'); }
  system(): Observable<SystemInfo> { return this.http.get<SystemInfo>('/api/system'); }
}

// ---------------- boards ----------------
/** A board is parametric atopile that builds into a netlist: the parts it
 *  is made of and what is joined to what. */
/** What the router made of a board. */
export interface BoardRoute {
  tracks: number; vias: number; length_mm: number; zones: number;
  unrouted: number; route_s: number; passes: number;
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
           min_via: number; min_drill: number };
  pours: Pour[];
  route: { passes: number };
  edited: boolean;
}

/** One rule field, as the server describes it (backend/rules.py SCHEMA). */
export interface RuleField {
  key: string; label: string;
  type: 'text' | 'number' | 'integer' | 'choice' | 'net' | 'nets' | 'patterns' | 'layers';
  unit?: string; min?: number; max?: number; step?: number; help?: string;
  options?: string[];
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
    return this.http.post<BoardLayout>(`/api/boards/${id}/layout`, {});
  }
  /** The whole of it: build, schematic, place, route, pour, DRC. */
  run(id: string): Observable<unknown> {
    return this.http.post(`/api/boards/${id}/run`, {});
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
  /** What this board has cost the machine, job by job. */
  compute(id: string): Observable<BoardCompute> {
    return this.http.get<BoardCompute>(`/api/boards/${id}/compute`);
  }
  /** Put it in a folder. The id does not change: it is not a path. */
  move(id: string, folder: string): Observable<unknown> {
    return this.http.post(
      `/api/boards/${id}/move?folder=${encodeURIComponent(folder)}`, {});
  }
  drop(id: string): Observable<unknown> {
    return this.http.delete(`/api/boards/${id}`);
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

/** One ask made of LCSC, as the journal wrote it down. */
export interface LcscAsk {
  at: string;
  /** page (the browser), agent (command line or curl), passives (the builder). */
  who: string;
  /** search, component, drawings, 3d model, photo. */
  kind: string;
  /** The search, or the part number. */
  target: string;
  /** net: went to EasyEDA. disk: already here. refused: not sent, cooling
   *  off or out of budget. wait: an agent waiting for the budget. */
  source: 'net' | 'disk' | 'refused' | 'wait';
  url: string;
  status: number | null;
  ms: number;
  bytes: number;
  error: string | null;
}

export interface LcscJournal {
  state: { gap_s: number; cool_off_s: number; now: number;
           refused_until: number | null; refused_why: string | null;
           last_ask: number | null;
           /** At most `budget` asks in any `window_s`; `used` so far. */
           budget: number; window_s: number; used: number };
  rows: LcscAsk[];
  last_hour: { net: number; disk: number; refused: number };
}

/** A part that has been fetched and kept. */
export interface PartHeld {
  lcsc: string;
  name: string | null;
  has_3d: boolean;
  at: string;
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
  /** Every ask made of LCSC, newest first. */
  journal(limit = 200): Observable<LcscJournal> {
    return this.http.get<LcscJournal>(`/api/lcsc/requests?limit=${limit}`);
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
  text: string;
  /** "Stop what you are doing", as opposed to "when you get a moment". An
   *  urgent line kills a build that is running when it lands. */
  urgent?: boolean;
  /** Null until the agent has picked it up - that is what its idle wait
   *  watches, and what the page shows as "not read yet". */
  seen_at: string | null;
  /** Which room's thread it is in. */
  room?: string;
}

@Injectable({ providedIn: 'root' })
export class Chat {
  private http = inject(HttpClient);
  /** One room's thread - each tab has its own. */
  history(room: string): Observable<ChatLine[]> {
    return this.http.get<ChatLine[]>(`/api/chat?room=${room}`);
  }
  say(text: string, urgent = false, room = 'cad'): Observable<ChatLine> {
    return this.http.post<ChatLine>('/api/chat', { text, urgent, room });
  }
  /** Unsend. Refused once the agent has picked the message up. */
  retract(id: string): Observable<unknown> {
    return this.http.delete(`/api/chat/${id}`);
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
}

@Injectable({ providedIn: 'root' })
export class Questions {
  private http = inject(HttpClient);
  open(): Observable<Question[]> {
    return this.http.get<Question[]>('/api/questions');
  }
  answer(id: string, answer: string): Observable<Question> {
    return this.http.post<Question>(`/api/questions/${id}/answer`, { answer });
  }
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
  lines(limit = 120, room: 'cad' | 'pcb' | 'web' | 'embedded' | 'mobile' = 'cad'): Observable<LogLine[]> {
    return this.http.get<LogLine[]>(`/api/activity?limit=${limit}&room=${room}`);
  }
  /** The run in one room. Each room has its own, so the tabs' agents can
   *  work at once. */
  run(room: string = 'cad'): Observable<Run | null> {
    return this.http.get<Run | null>(`/api/run?room=${room}`);
  }
}

// ---------------- code projects ----------------
/** A running interface: its checkout, where it is served, and the command
 *  whose exit code says it still works. */
export interface AppEntry {
  _id: string;
  title: string;
  platform: 'web' | 'embedded' | 'mobile';
  folder: string;
  repo: string;
  cwd: string;
  url: string | null;
  dev: string | null;
  test: string | null;
  routes: string[];
  last_test: TestRun | null;
}

export interface AppStatus {
  up: boolean;
  git: { head: string; short: string; branch: string; dirty: number } | null;
  error?: string;
}

/** A frozen page: the picture inline, the element list kept server-side. */
export interface AppShot {
  shot: string;
  image: string;
  width: number;
  height: number;
  elements: number;
  title: string | null;
  base: string | null;
  wall_s: number | null;
}

/** One line of a hunk: kind, old line number, new line number, text. */
export type DiffLine = [' ' | '+' | '-', number | null, number | null, string];

export interface DiffFile {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed';
  added: number;
  removed: number;
  binary: boolean;
  cut: boolean;
  hunks: { head: string; lines: DiffLine[] }[];
}

export interface AppDiff {
  files: DiffFile[];
  added: number;
  removed: number;
  cut: boolean;
  base: string | null;
  note: string | null;
  frozen: boolean;
}

export interface TestRun {
  at: string;
  ok: boolean;
  rc: number;
  wall_s: number;
  cpu_s: number | null;
  counts: Record<string, number>;
  command: string;
  head: string | null;
  tail?: string;
  lines: number;
  /** Whether the tree is still the one the run was made on. */
  current?: boolean;
}

export interface AppCompute {
  app: string;
  jobs: BoardJob[];
  total: { jobs: number; wall_s: number; cpu_s: number };
}

@Injectable({ providedIn: 'root' })
export class Apps {
  private http = inject(HttpClient);
  list(): Observable<AppEntry[]> { return this.http.get<AppEntry[]>('/api/apps'); }
  status(id: string): Observable<AppStatus> {
    return this.http.get<AppStatus>(`/api/apps/${id}/status`);
  }
  /** Start the dev server, unless something already answers. */
  serve(id: string): Observable<{ started: boolean; up: boolean; why?: string }> {
    return this.http.post<{ started: boolean; up: boolean; why?: string }>(
      `/api/apps/${id}/serve`, {});
  }
  serverLog(id: string): Observable<{ lines: string[] }> {
    return this.http.get<{ lines: string[] }>(`/api/apps/${id}/server-log`);
  }
  /** A real screenshot of a route at a size, from headless Chrome. */
  shot(id: string, route: string, width: number, height: number): Observable<AppShot> {
    return this.http.post<AppShot>(`/api/apps/${id}/shot`, { route, width, height });
  }
  /** What the marks landed on. Boxes are in the picture's own pixels. */
  under(shot: string, marks: { box: number[]; tip: number[] | null }[]):
      Observable<{ dom: DomHit[]; labels: string[] }> {
    return this.http.post<{ dom: DomHit[]; labels: string[] }>(
      `/api/apps/shots/${shot}/under`, { marks });
  }
  diff(id: string, note?: string | null): Observable<AppDiff> {
    return this.http.get<AppDiff>(`/api/apps/${id}/diff`,
      note ? { params: { note } } : {});
  }
  test(id: string): Observable<TestRun> {
    return this.http.post<TestRun>(`/api/apps/${id}/test`, {});
  }
  lastTest(id: string): Observable<TestRun | null> {
    return this.http.get<TestRun | null>(`/api/apps/${id}/test`);
  }
  compute(id: string): Observable<AppCompute> {
    return this.http.get<AppCompute>(`/api/apps/${id}/compute`);
  }
  move(id: string, folder: string): Observable<unknown> {
    return this.http.post(`/api/apps/${id}/move?folder=${encodeURIComponent(folder)}`, {});
  }
  drop(id: string): Observable<unknown> {
    return this.http.delete(`/api/apps/${id}`);
  }
}
