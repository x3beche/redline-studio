import {
  AfterViewInit, Component, ElementRef, OnDestroy, inject, signal, viewChild,
} from '@angular/core';
import { DecimalPipe, NgTemplateOutlet } from '@angular/common';
const SEED = `"""__NAME__ - a build123d model."""

from build123d import *

TITLE = "__NAME__"

with BuildPart() as part:
    Box(40, 30, 10)
    fillet(part.edges().filter_by(Axis.Z), radius=4)

# Asset Manager reads these two names:
PARTS = [part.part]
NAMES = ["body"]
`;

import { Activity, Analytics, Api, CameraState, Catalog, Health, LogLine, Run, Stats, SystemInfo, FolderNode, ModelEntry, ModelVersion,
         Revision, RevisionStatus } from '../api';
import { OcpViewer } from './ocp';

export type Tool = 'pen' | 'line' | 'rect' | 'ellipse' | 'triangle' | 'arrow' | 'text';
type Pt = [number, number];

/** One mark on the overlay. Freehand keeps a point list; the rest are
 *  defined by the drag start and end; text by a point and a string. */
type Mark =
  | { kind: 'pen'; color: string; width: number; pts: Pt[] }
  | { kind: Exclude<Tool, 'pen' | 'text'>; color: string; width: number; a: Pt; b: Pt }
  | { kind: 'text'; color: string; size: number; at: Pt; text: string };

@Component({
  selector: 'app-editor',
  imports: [DecimalPipe, NgTemplateOutlet],
  templateUrl: './editor.html',
})
export class Editor implements AfterViewInit, OnDestroy {
  private api = inject(Api);
  private cat = inject(Catalog);
  private health = inject(Health);
  private activity = inject(Activity);
  private host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private overlay = viewChild.required<ElementRef<HTMLCanvasElement>>('overlay');
  private stage = viewChild.required<ElementRef<HTMLDivElement>>('stage');
  private caret = viewChild<ElementRef<HTMLInputElement>>('caret');
  private cadInput = viewChild<ElementRef<HTMLInputElement>>('cadInput');
  private freezeBtn = viewChild<ElementRef<HTMLButtonElement>>('freezeBtn');
  private logBox = viewChild<ElementRef<HTMLDivElement>>('logBox');

  frozen = signal(false);
  saving = signal(false);
  comment = signal('');
  part = signal('');
  parts = signal<string[]>([]);
  revisions = signal<Revision[]>([]);
  toast = signal('');
  glError = signal('');
  catalog = signal<FolderNode | null>(null);
  activeModel = signal<string>('');
  versions = signal<ModelVersion[]>([]);
  busy = signal('');
  collapsed = signal(false);
  stats = signal<Stats | null>(null);
  log = signal<LogLine[]>([]);
  run = signal<Run | null>(null);
  logOpen = signal(true);
  private builtAt = '';
  private lastRunStatus = '';
  private pendingCamera: string | null = null;
  /** resizeCadView re-frames the scene, so an explicitly set view has to be
   *  re-applied after every resize or it silently springs back. */
  private heldCamera: CameraState | null = null;
  /** The revision whose view is being held, shown over the scene. */
  focused = signal<Revision | null>(null);
  notice = signal<{ id: string | null; title: string;
                    secs: number; ok: boolean } | null>(null);
  preview = signal<Revision | null>(null);
  editing = signal<string | null>(null);
  showArchived = signal(false);
  autoArchive = signal(false);
  collapsed_ = signal<Set<string>>(new Set());
  editText = signal('');
  editPart = signal('');
  editSummary = signal('');
  sys = signal<SystemInfo | null>(null);
  color = signal('#ff2d3f');
  penWidth = signal(4);
  tool = signal<Tool>('pen');
  fontSize = signal(18);
  /** Where the text caret sits, in CSS pixels of the stage, while typing. */
  typing = signal<{ left: number; top: number } | null>(null);
  private typeAt: Pt = [0, 0];

  private viewer?: OcpViewer;
  private frozenShot = '';
  private marks: Mark[] = [];
  private active: Mark | null = null;
  private drawing = false;
  private ro?: ResizeObserver;

  async ngAfterViewInit() {
    const box = this.stage().nativeElement;
    try {
      this.viewer = new OcpViewer(this.host().nativeElement);
      this.viewer.init({ w: Math.max(box.clientWidth - 250, 400),
                         h: Math.max(box.clientHeight, 400) });
    } catch (e) {
      this.glError.set(String((e as Error)?.message ?? e));
      return;
    }
    // Clicking a part in the model fills the Part field on the right.
    this.viewer.onPick(name => {
      if (!name) return;
      const known = this.parts().find(p => p === name)
        ?? this.parts().find(p => name.endsWith(p));
      this.part.set(known ?? name);
      this.flash('part: ' + (known ?? name));
    });
    this.loadCatalog();
    this.loadVersions();
    this.applyUrlCamera();
    this.pollHealth();
    this.loadSettings();
    this.healthTimer = setInterval(() => this.pollHealth(), 2000);
    setTimeout(() => this.sizeOverlay());     // after the viewer DOM settles
    this.ro = new ResizeObserver(() => this.sizeOverlay());
    this.ro.observe(box);
    this.refresh();
  }

  ngOnDestroy() {
    this.ro?.disconnect();
    this.viewer?.dispose();
    clearInterval(this.healthTimer);
  }

  private healthTimer: ReturnType<typeof setInterval> | undefined;

  pollHealth() {
    this.health.stats().subscribe({ next: v => this.stats.set(v), error: () => {} });
    this.health.system().subscribe({ next: v => this.sys.set(v), error: () => {} });
    this.activity.run().subscribe({
      next: v => {
        const was = this.lastRunStatus;
        this.run.set(v);
        this.lastRunStatus = v?.status ?? '';
        // When a run completes, swing to the angle the revision was drawn
        // from, so the result is judged from the same viewpoint.
        if (v && was === 'running' && v.status !== 'running') {
          this.showNotice(v);
          if (v.revision) this.focusRevision(v.revision);
        }
      },
      error: () => {},
    });
    this.loadCatalog();
    this.activity.lines().subscribe({
      next: v => {
        // Only follow the tail while the user is already at the bottom, so
        // scrolling back to read something is not yanked away.
        const el = this.logBox()?.nativeElement;
        const atBottom = !el
          || el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        this.log.set(v);
        if (atBottom) {
          setTimeout(() => this.scrollLog());
          setTimeout(() => this.scrollLog(), 120);   // after layout settles
        }
      },
      error: () => {},
    });
  }

  /** Work finishes while the user is looking somewhere else, so say so in
   *  the corner rather than only moving the camera. */
  private showNotice(r: Run) {
    const t1 = r.finished_at ? Date.parse(r.finished_at) : Date.now();
    this.notice.set({
      id: r.revision, title: r.title, ok: r.status === 'done',
      secs: Math.max(0, Math.round((t1 - Date.parse(r.started_at)) / 1000)),
    });
  }

  // Stays until it is dismissed: a notice that vanishes on its own is one
  // the reader misses exactly when they were away from the screen.
  dismissNotice() { this.notice.set(null); }

  /** Run duration, short form. */
  elapsed(s: number): string {
    return s < 60 ? `${s}s`
                  : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  }

  /** Move the freeze control into the viewer's toolbar. Angular still owns
   *  the element - only its parent changes - so the binding and the click
   *  handler carry on working. */
  private dockFreezeButton() {
    const btn = this.freezeBtn()?.nativeElement;
    const bar = this.viewer?.toolbar;
    if (btn && bar && btn.parentElement !== bar) bar.appendChild(btn);
  }

  /** Keep the newest line in view, the way a terminal does. */
  private scrollLog() {
    const el = this.logBox()?.nativeElement;
    if (el) el.scrollTop = el.scrollHeight;
  }

  clearLog() { this.activity.clear().subscribe(() => this.pollHealth()); }

  toggleLog() {
    this.logOpen.update(v => !v);
    setTimeout(() => this.sizeOverlay(), 60);
    setTimeout(() => this.scrollLog(), 80);
  }

  /** A run is live from the moment work starts until it reports finished. */
  runActive(): boolean { return this.run()?.status === 'running'; }

  levelColor(l: LogLine['level']): string {
    return l === 'error' ? 'var(--danger)'
      : l === 'warn' ? 'var(--warn)'
      : l === 'done' ? 'var(--ok)'
      : l === 'work' ? 'var(--accent)' : 'var(--ink-dim)';
  }

  toggleSidebar() {
    this.collapsed.update(v => !v);
    setTimeout(() => this.sizeOverlay(), 60);   // rescale once the transition ends
  }

  gb(n: number): string { return (n / 1e9).toFixed(1) + ' GB'; }

  /** Compact gauges shown while the panel is collapsed. */
  gauges(): { key: string; pct: number; tip: string }[] {
    const st = this.stats(), m = this.sys();
    const out: { key: string; pct: number; tip: string }[] = [];
    if (st?.quota_bytes) {
      out.push({ key: 'DB', pct: st.percent ?? 0,
                 tip: `MongoDB ${this.mb(st.used_bytes)} / ${this.mb(st.quota_bytes)}`
                    + ` · ${st.objects} docs · ${st.versions} versions`
                    + ` · ${st.revisions['queued'] ?? 0} queued` });
    }
    if (m) {
      out.push({ key: 'CPU', pct: m.cpu.load,
                 tip: `${m.cpu.name} · ${m.cpu.load.toFixed(0)}% · ${m.cpu.cores}c/${m.cpu.threads}t` });
      out.push({ key: 'RAM', pct: m.ram.percent,
                 tip: `RAM ${this.gb(m.ram.used_bytes)} / ${this.gb(m.ram.total_bytes)}` });
      if (m.gpu) {
        out.push({ key: 'GPU', pct: m.gpu.util,
                   tip: `${m.gpu.name} · ${m.gpu.util.toFixed(0)}%`
                      + ` · ${(m.gpu.mem_used_mb / 1024).toFixed(1)}/${(m.gpu.mem_total_mb / 1024).toFixed(1)} GB`
                      + ` · ${m.gpu.temp_c.toFixed(0)}°` });
      }
    }
    return out;
  }

  gaugeColor(pct: number): string {
    return pct > 85 ? 'var(--danger)' : pct > 60 ? 'var(--warn)' : 'var(--accent)';
  }

  /** ?rev=<id> opens the model at that revision's camera; ?model=<id>
   *  opens a named model, which is how a shot of one is taken. */
  private applyUrlCamera() {
    const q = new URLSearchParams(location.search);
    const rev = q.get('rev');
    if (rev) this.focusRevision(rev);
  }

  private urlModel(): string | null {
    return new URLSearchParams(location.search).get('model');
  }

  /** Move to the camera a revision was drawn from. If no model is loaded
   *  yet, remember it and apply once the load completes. */
  focusRevision(id: string) {
    if (!this.activeModel() || !this.viewer) { this.pendingCamera = id; return; }
    this.api.one(id).subscribe({
      next: r => {
        // Open the model the revision is about. Only the camera was applied
        // before, so a revision on one model was shown against whichever
        // model happened to load first.
        if (r.model && r.model !== this.activeModel()) {
          const target = this.catalog() && this.findModel(this.catalog()!, r.model);
          if (target) {
            this.pendingCamera = id;
            this.openModel(target);
            return;
          }
        }
        if (!r.camera || !this.viewer) return;
        this.heldCamera = r.camera;
        this.focused.set(r);
        this.viewer.applyCamera(r.camera);
      },
      error: () => {},
    });
  }

  // ---- catalog ----
  loadCatalog() {
    this.cat.tree().subscribe(t => {
      this.catalog.set(t);
      if (!this.activeModel()) {
        const wanted = this.urlModel();
        const pick = (wanted && this.findModel(t, wanted)) || this.firstReady(t);
        if (pick) this.openModel(pick);
        return;
      }
      // A rebuild replaces the stored viewer payload. Without this the open
      // page keeps showing the geometry it loaded the first time.
      const live = this.findModel(t, this.activeModel());
      if (live?.built_at && live.built_at !== this.builtAt) {
        this.builtAt = live.built_at;      // claim it so the poll fires once
        this.flash('model rebuilt, reloading');
        this.openModel(live);
      }
    });
  }

  /** By id, or by bare name so ?model=stand works without the folder. */
  private findModel(n: FolderNode, id: string): ModelEntry | null {
    return n.models.find(m => m.id === id || m.name === id)
      ?? n.folders.reduce<ModelEntry | null>(
        (hit, f) => hit ?? this.findModel(f, id), null);
  }

  private firstReady(n: FolderNode): ModelEntry | null {
    const hit = n.models.find(m => m.data) ?? n.models.find(m => m.ready);
    if (hit) return hit;
    for (const f of n.folders) {
      const deep = this.firstReady(f);
      if (deep) return deep;
    }
    return null;
  }

  async openModel(m: ModelEntry) {
    if (!this.viewer) return;
    if (!m.data) { this.flash(m.name + ': build it first'); return; }
    this.builtAt = m.built_at ?? '';
    this.busy.set('loading model…');
    try {
      // Data is not on disk; it streams from the database.
      await this.viewer.load(this.cat.viewerUrl(m.id, m.built_at));
      this.dockFreezeButton();
      this.activeModel.set(m.id);
      this.parts.set(this.viewer.parts);
      setTimeout(() => this.sizeOverlay());
      // render() resets the camera, so a pending view has to be applied
      // after the load finishes rather than racing it.
      if (this.pendingCamera) {
        const rev = this.pendingCamera;
        this.pendingCamera = null;
        setTimeout(() => this.focusRevision(rev), 300);
      }
    } catch (e) {
      this.flash('load failed: ' + (e as Error).message);
    }
    this.busy.set('');
  }

  rebuild(m: ModelEntry, ev: Event) {
    ev.stopPropagation();
    this.busy.set('building ' + m.name + '…');
    this.cat.build(m.id).subscribe({
      next: () => { this.busy.set(''); this.flash(m.name + ' rebuilt');
                    this.loadCatalog(); },
      error: e => { this.busy.set(''); this.flash('error: ' + (e.error?.detail ?? e.status)); },
    });
  }

  newFolder(parent: string) {
    const name = prompt('Folder name (letters, digits, - , _):');
    if (!name) return;
    this.cat.newFolder(name, parent).subscribe({
      next: () => this.loadCatalog(),
      error: e => this.flash(e.error?.detail ?? 'could not create folder'),
    });
  }

  /** Bring in a STEP (or IGES/BREP/STL). The server stores it and writes a
   *  model that imports it, so it is on screen without a second step. */
  pickCad() { this.cadInput()?.nativeElement.click(); }

  // ---- left column: move and delete ----
  // Two clicks rather than drag and drop: pick the model, then pick the
  // folder. Works the same on a trackpad and is testable.
  moving = signal<ModelEntry | null>(null);

  armMove(m: ModelEntry, ev: Event) {
    ev.stopPropagation();
    this.moving.set(this.moving()?.id === m.id ? null : m);
  }

  cancelMove() { this.moving.set(null); }

  moveTo(folder: string, ev?: Event) {
    ev?.stopPropagation();
    const m = this.moving();
    if (!m) return;
    this.moving.set(null);
    this.cat.move(m.id, folder).subscribe({
      next: r => {
        this.flash(`${m.title} -> ${folder || 'root'}`);
        // The id carries the path, so the open model is now under a new one.
        if (this.activeModel() === m.id) this.activeModel.set(r.to);
        this.loadCatalog();
      },
      error: e => this.flash(e.error?.detail ?? 'move failed'),
    });
  }

  // Two clicks, no dialog: the first arms the row, the second deletes. A
  // browser confirm() freezes the page and cannot be driven in a test.
  deleting = signal<string | null>(null);
  private deleteTimer: ReturnType<typeof setTimeout> | undefined;

  armDelete(m: ModelEntry, ev: Event) {
    ev.stopPropagation();
    clearTimeout(this.deleteTimer);
    if (this.deleting() !== m.id) {
      this.deleting.set(m.id);
      this.deleteTimer = setTimeout(() => this.deleting.set(null), 4000);
      return;
    }
    this.deleting.set(null);
    this.cat.dropModel(m.id).subscribe({
      next: () => this.afterDelete(m),
      error: e => {
        // 409: another model imports this one. Say so and offer the override.
        const detail = e.error?.detail ?? 'could not delete';
        if (e.status === 409) {
          this.forcing.set({ model: m, why: detail });
        } else {
          this.flash(detail);
        }
      },
    });
  }

  forcing = signal<{ model: ModelEntry; why: string } | null>(null);

  forceDelete() {
    const f = this.forcing();
    if (!f) return;
    this.forcing.set(null);
    this.cat.dropModel(f.model.id, true).subscribe({
      next: () => this.afterDelete(f.model),
      error: e => this.flash(e.error?.detail ?? 'could not delete'),
    });
  }

  private afterDelete(m: ModelEntry) {
    this.flash(m.title + ' deleted');
    if (this.activeModel() === m.id) this.activeModel.set('');
    this.loadCatalog();
  }

  dropFolder(path: string, ev: Event) {
    ev.stopPropagation();
    this.cat.dropFolder(path).subscribe({
      next: () => { this.flash(path + ' deleted'); this.loadCatalog(); },
      error: e => this.flash(e.error?.detail ?? 'could not delete folder'),
    });
  }

  uploadCad(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';                       // same file twice must still fire
    if (!file) return;
    this.busy.set('uploading ' + file.name);
    this.cat.upload(file).subscribe({
      next: r => {
        this.busy.set('');
        this.flash(`${r.name} imported (${Math.round(r.bytes / 1024)} kB)`);
        this.loadCatalog();
        if (r.model) this.cat.build(r.model).subscribe({
          next: () => { this.flash(r.model + ' built'); this.loadCatalog(); },
          error: e => this.flash('build failed: ' + (e.error?.detail ?? e.status)),
        });
      },
      error: e => {
        this.busy.set('');
        this.flash(e.error?.detail ?? 'upload failed');
      },
    });
  }

  newModel(folder: string) {
    const name = prompt('Model name (letters, digits, - , _):');
    if (!name) return;
    const id = folder ? `${folder}/${name}` : name;
    const source = SEED.replace('__NAME__', name);
    this.cat.createModel(id, source).subscribe({
      next: () => { this.flash(name + ' created'); this.loadCatalog(); },
      error: e => this.flash(e.error?.detail ?? 'could not create model'),
    });
  }

  /** What a folded card says. The generated sentence when there is one,
   *  otherwise the first line cut short - the full text is what folding is
   *  meant to get rid of. */
  cardLine(r: Revision): string {
    if (r.summary) return r.summary;
    const text = (r.comment ?? '').trim();
    const first = text.split('\n')[0].trim();
    if (first.length > 64) return first.slice(0, 64).trimEnd() + '…';
    return first === text ? first : first + '…';
  }

  imageUrl(r: Revision): string { return this.api.imageUrl(r.id); }

  // ---- what the work cost ----
  // The numbers come from the agent's own transcripts and are frozen onto the
  // revision when its run finishes; a run still going is re-read live. Kept
  // per card and fetched on demand: most cards are never opened.
  cost = signal<Record<string, Analytics | 'loading' | 'none'>>({});
  costOpen = signal<Set<string>>(new Set());

  costShown(id: string): boolean { return this.costOpen().has(id); }

  costOf(id: string): Analytics | null {
    const v = this.cost()[id];
    return v && v !== 'loading' && v !== 'none' ? v : null;
  }

  costState(id: string): 'loading' | 'none' | 'ok' | 'idle' {
    const v = this.cost()[id];
    if (v === 'loading' || v === 'none') return v;
    return v ? 'ok' : 'idle';
  }

  toggleCost(r: Revision) {
    const open = new Set(this.costOpen());
    if (open.has(r.id)) {
      open.delete(r.id);
      this.costOpen.set(open);
      return;
    }
    open.add(r.id);
    this.costOpen.set(open);
    this.loadCost(r);
  }

  loadCost(r: Revision) {
    const rn = this.run();
    const live = rn?.revision === r.id && rn.status === 'running';
    this.cost.set({ ...this.cost(), [r.id]: 'loading' });
    this.api.analytics(r.id, live).subscribe({
      next: a => this.cost.set({ ...this.cost(), [r.id]: a }),
      // 404 means nobody recorded a run for it - older revisions, or one
      // applied by hand. That is a fact about the card, not an error.
      error: () => this.cost.set({ ...this.cost(), [r.id]: 'none' }),
    });
  }

  /** 12_714_933 -> "12.7M". Cache reads run to millions and the raw number
   *  pushes every other column off the card. */
  tokens(n: number | null | undefined): string {
    const v = n ?? 0;
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
    return String(v);
  }

  usd(n: number | null | undefined): string {
    if (n == null) return '-';
    if (n >= 1) return '$' + n.toFixed(2);
    if (n >= 0.01) return '$' + n.toFixed(3);
    return '$' + n.toFixed(5);
  }

  /** 825.1 -> "13m 45s" */
  duration(sec: number | null | undefined): string {
    const s = Math.max(0, Math.round(sec ?? 0));
    if (s < 60) return s + 's';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
  }

  /** Output tokens per bucket as an SVG polyline, scaled to the tallest
   *  bucket. A flat empty chart says "no samples" more clearly than a
   *  missing element, so an empty series still draws the baseline. */
  spark(a: Analytics, w = 250, h = 34): string {
    const v = a.series?.output ?? [];
    if (v.length < 2) return `0,${h} ${w},${h}`;
    const top = Math.max(...v, 1);
    return v.map((n, i) =>
      `${(i / (v.length - 1) * w).toFixed(1)},` +
      `${(h - (n / top) * (h - 2)).toFixed(1)}`).join(' ');
  }

  /** Tokens per second at the busiest bucket, for the chart's scale label. */
  sparkPeak(a: Analytics): number {
    const v = a.series?.output ?? [];
    if (!v.length) return 0;
    return Math.round(Math.max(...v) / (a.series.bucket_s || 30));
  }

  openShot(r: Revision) { this.preview.set(r); }
  closeShot() { this.preview.set(null); }

  // ---- version history ----
  loadVersions() { this.cat.versions().subscribe({ next: v => this.versions.set(v),
                                                   error: () => {} }); }

  takeSnapshot() {
    const note = prompt('Version note:') ?? '';
    this.busy.set('taking snapshot…');
    this.cat.snapshot(note).subscribe({
      next: () => { this.busy.set(''); this.flash('version saved'); this.loadVersions(); },
      error: e => { this.busy.set(''); this.flash(e.error?.detail ?? 'snapshot failed'); },
    });
  }

  restore(v: ModelVersion) {
    if (!confirm(`Roll back to ${v.short}?\nThe current state is snapshotted first.`)) return;
    this.busy.set('restoring…');
    this.cat.restore(v._id).subscribe({
      next: () => { this.busy.set(''); this.flash('restored: ' + v.short);
                    this.loadVersions(); this.loadCatalog(); },
      error: e => { this.busy.set(''); this.flash(e.error?.detail ?? 'restore failed'); },
    });
  }

  mb(n: number): string { return (n / 1e6).toFixed(1) + ' MB'; }

  /** Only offer the WebGL advice when the failure really is WebGL related. */
  isWebglError(): boolean {
    return /webgl|context|gpu/i.test(this.glError());
  }

  /** The host sits 8 px above the card's bottom edge; the viewer must be
   *  told the shorter height or it paints straight over that gap. */
  private static GUTTER = 8;

  private sizeOverlay() {
    const box = this.stage().nativeElement;
    this.viewer?.resize(box.clientWidth, box.clientHeight - Editor.GUTTER);
    if (this.heldCamera) this.viewer?.applyCamera(this.heldCamera);

    // getImage() returns the canvas only; unless the overlay sits exactly on
    // top of it, marks land in the wrong place in the saved image.
    const c = this.overlay().nativeElement;
    const cad = this.viewer?.canvasRect();
    const stage = box.getBoundingClientRect();
    const w = cad ? cad.width : box.clientWidth;
    const h = cad ? cad.height : box.clientHeight;
    const ratio = Math.min(devicePixelRatio, 2);
    c.width = Math.round(w * ratio);
    c.height = Math.round(h * ratio);
    c.style.width = w + 'px';
    c.style.height = h + 'px';
    c.style.left = (cad ? cad.left - stage.left : 0) + 'px';
    c.style.top = (cad ? cad.top - stage.top : 0) + 'px';
    this.repaint();
  }

  // ---- freeze / unfreeze ----
  /** Once the user orbits, stop forcing the stored view and drop the card. */
  releaseCamera() {
    if (!this.heldCamera) return;
    this.heldCamera = null;
    this.focused.set(null);
  }

  async freeze() {
    if (!this.viewer) return;
    this.frozenShot = await this.viewer.image();
    this.viewer.setEnabled(false);
    this.frozen.set(true);
  }

  resume() {
    this.viewer?.setEnabled(true);
    this.frozen.set(false);
    this.typing.set(null);
    this.marks = []; this.active = null; this.repaint();
  }

  // ---- drawing ----
  private pos(ev: PointerEvent): [number, number] {
    const c = this.overlay().nativeElement;
    const r = c.getBoundingClientRect();
    return [(ev.clientX - r.left) * c.width / r.width,
            (ev.clientY - r.top) * c.height / r.height];
  }

  down(ev: PointerEvent) {
    if (!this.frozen()) return;
    const at = this.pos(ev);
    const t = this.tool();

    if (t === 'text') {
      // An inline caret rather than prompt(): a modal dialog freezes the
      // whole page, and the label has to be placed while the model is visible.
      const stage = this.stage().nativeElement.getBoundingClientRect();
      this.typeAt = at;
      this.typing.set({ left: ev.clientX - stage.left, top: ev.clientY - stage.top });
      setTimeout(() => this.caret()?.nativeElement.focus());
      return;
    }

    this.drawing = true;
    (ev.target as HTMLElement).setPointerCapture(ev.pointerId);
    this.active = t === 'pen'
      ? { kind: 'pen', color: this.color(), width: this.penWidth(), pts: [at] }
      : { kind: t, color: this.color(), width: this.penWidth(), a: at, b: at };
    this.marks.push(this.active);
    this.repaint();
  }

  move(ev: PointerEvent) {
    if (!this.drawing || !this.active) return;
    const at = this.pos(ev);
    if (this.active.kind === 'pen') this.active.pts.push(at);
    else if (this.active.kind !== 'text') this.active.b = at;
    this.repaint();
  }

  up() {
    // A click with a shape tool leaves a zero-size mark; drop it.
    if (this.active && this.active.kind !== 'pen' && this.active.kind !== 'text') {
      const [ax, ay] = this.active.a, [bx, by] = this.active.b;
      if (Math.hypot(bx - ax, by - ay) < 3) this.marks.pop();
    }
    this.drawing = false;
    this.active = null;
    this.repaint();
  }

  undo() { this.marks.pop(); this.repaint(); }
  clear() { this.marks = []; this.repaint(); }

  private repaint() {
    const c = this.overlay().nativeElement;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.lineCap = ctx.lineJoin = 'round';
    const scale = Math.min(devicePixelRatio, 2);

    for (const m of this.marks) {
      ctx.strokeStyle = m.color;
      ctx.fillStyle = m.color;

      if (m.kind === 'text') {
        ctx.font = `600 ${m.size}px 'IBM Plex Sans', sans-serif`;
        ctx.textBaseline = 'middle';
        ctx.fillText(m.text, m.at[0], m.at[1]);
        continue;
      }

      ctx.lineWidth = m.width * scale;
      ctx.beginPath();

      if (m.kind === 'pen') {
        m.pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
      } else {
        const [ax, ay] = m.a, [bx, by] = m.b;
        if (m.kind === 'line') {
          ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
        } else if (m.kind === 'rect') {
          ctx.rect(ax, ay, bx - ax, by - ay);
        } else if (m.kind === 'ellipse') {
          ctx.ellipse((ax + bx) / 2, (ay + by) / 2,
                      Math.abs(bx - ax) / 2, Math.abs(by - ay) / 2, 0, 0, Math.PI * 2);
        } else if (m.kind === 'triangle') {
          ctx.moveTo((ax + bx) / 2, ay);
          ctx.lineTo(bx, by); ctx.lineTo(ax, by); ctx.closePath();
        } else if (m.kind === 'arrow') {
          const head = Math.max(10, m.width * scale * 3);
          const ang = Math.atan2(by - ay, bx - ax);
          ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
          ctx.moveTo(bx, by);
          ctx.lineTo(bx - head * Math.cos(ang - 0.4), by - head * Math.sin(ang - 0.4));
          ctx.moveTo(bx, by);
          ctx.lineTo(bx - head * Math.cos(ang + 0.4), by - head * Math.sin(ang + 0.4));
        }
      }
      ctx.stroke();
    }
  }

  commitText(value: string) {
    // Enter closes the caret, which then blurs: without this guard the label
    // is committed twice, one copy exactly on top of the other.
    if (!this.typing()) return;
    const text = value.trim();
    this.typing.set(null);
    if (!text) return;
    const scale = Math.min(devicePixelRatio, 2);
    this.marks.push({ kind: 'text', color: this.color(),
                      size: this.fontSize() * scale, at: this.typeAt, text });
    this.repaint();
  }

  cancelText() { this.typing.set(null); }

  readonly tools: { id: Tool; glyph: string; label: string }[] = [
    { id: 'pen', glyph: '✎', label: 'freehand' },
    { id: 'line', glyph: '╱', label: 'line' },
    { id: 'arrow', glyph: '→', label: 'arrow' },
    { id: 'rect', glyph: '▭', label: 'rectangle' },
    { id: 'ellipse', glyph: '◯', label: 'ellipse' },
    { id: 'triangle', glyph: '△', label: 'triangle' },
    { id: 'text', glyph: 'T', label: 'text' },
  ];

  // ---- save ----
  async save() {
    if (!this.viewer) return;
    if (!this.comment().trim()) { this.flash('write a comment first'); return; }
    this.saving.set(true);
    // A note about a part is a valid revision; the drawing is optional.
    const merged = this.frozen() ? await this.merge(this.frozenShot) : null;
    this.api.create({
      comment: this.comment().trim(), image_png: merged,
      camera: this.viewer.cameraState(), part: this.part() || null,
      model: this.activeModel() || null,
    }).subscribe({
      next: () => {
        this.saving.set(false);
        this.comment.set('');
        // The revision is filed, so let go of the view: staying frozen just
        // means the next orbit is a click on Unfreeze first.
        if (this.frozen()) this.resume(); else this.clear();
        this.flash('revision saved');
        this.refresh();
      },
      error: e => { this.saving.set(false); this.flash('save failed: ' + e.status); },
    });
  }

  /** Merge the frozen frame and the drawing layer into one PNG. */
  private merge(shotUrl: string): Promise<string> {
    return new Promise(resolve => {
      const overlay = this.overlay().nativeElement;
      if (!shotUrl) { resolve(overlay.toDataURL('image/png')); return; }
      const out = document.createElement('canvas');
      const img = new Image();
      img.onload = () => {
        out.width = img.width; out.height = img.height;
        const c = out.getContext('2d')!;
        c.drawImage(img, 0, 0);
        c.drawImage(overlay, 0, 0, out.width, out.height);
        resolve(out.toDataURL('image/png'));
      };
      img.onerror = () => resolve(overlay.toDataURL('image/png'));
      img.src = shotUrl;
    });
  }

  refresh() {
    this.api.list(this.showArchived()).subscribe({
      next: r => this.revisions.set(r), error: () => {} });
  }

  toggleArchivedView() { this.showArchived.update(v => !v); this.refresh(); }

  /** Server-side so the CLI honours it too, not just this browser. */
  loadSettings() {
    this.api.settings().subscribe({
      next: s => this.autoArchive.set(s.auto_archive), error: () => {} });
  }

  toggleAutoArchive() {
    const next = !this.autoArchive();
    this.api.setAutoArchive(next).subscribe({
      next: s => {
        this.autoArchive.set(s.auto_archive);
        this.flash(s.auto_archive ? 'applied revisions will be archived'
                                  : 'auto-archive off');
      },
      error: () => this.flash('could not change the setting'),
    });
  }

  archive(r: Revision) {
    this.api.archive(r.id, !r.archived).subscribe(() => {
      this.flash(r.archived ? 'restored from archive' : 'archived');
      this.refresh();
    });
  }

  /** Cards fold to a single line; the set holds the folded ids. */
  isFolded(id: string): boolean { return this.collapsed_().has(id); }

  toggleFold(id: string) {
    const next = new Set(this.collapsed_());
    next.has(id) ? next.delete(id) : next.add(id);
    this.collapsed_.set(next);
  }

  foldAll() {
    this.collapsed_.set(new Set(this.revisions().map(r => r.id)));
  }

  unfoldAll() { this.collapsed_.set(new Set()); }

  startEdit(r: Revision) {
    this.editing.set(r.id);
    this.editText.set(r.comment);
    this.editPart.set(r.part ?? '');
    this.editSummary.set(r.summary ?? '');
  }

  cancelEdit() { this.editing.set(null); }

  saveEdit(r: Revision) {
    const text = this.editText().trim();
    if (!text) { this.flash('comment cannot be empty'); return; }
    // An unchanged summary is not sent: sending it back would mark a
    // generated sentence as hand-written and freeze it.
    const summary = this.editSummary().trim();
    const body: { comment: string; part: string | null; summary?: string } =
      { comment: text, part: this.editPart() || null };
    if (summary !== (r.summary ?? '')) body.summary = summary;
    this.api.edit(r.id, body).subscribe({
      next: () => { this.editing.set(null); this.flash('revision updated'); this.refresh(); },
      error: e => this.flash(e.error?.detail ?? 'update failed'),
    });
  }

  remove(r: Revision) {
    if (!confirm(`Delete this revision?\n\n"${r.comment}"`)) return;
    this.api.remove(r.id).subscribe({
      next: () => { this.flash('revision deleted'); this.refresh(); this.pollHealth(); },
      error: () => this.flash('delete failed'),
    });
  }

  mark(r: Revision, status: RevisionStatus) {
    this.api.setStatus(r.id, status).subscribe(() => { this.refresh(); this.pollHealth(); });
  }

  /** One button, three-state cycle: draft -> queued -> applied -> draft,
   *  so "applied" can be undone. */
  private static NEXT: Record<string, RevisionStatus> = {
    draft: 'queued', queued: 'applied', applied: 'draft', rejected: 'draft',
  };

  cycle(r: Revision) { this.mark(r, Editor.NEXT[r.status] ?? 'draft'); }

  /** The button always reads as the action the next click performs. */
  nextLabel(s: RevisionStatus): string {
    return s === 'draft' ? 'queue'
      : s === 'queued' ? 'mark applied'
      : 'back to draft';
  }

  nextClass(s: RevisionStatus): string {
    return s === 'draft' ? 'tcv-chip tcv-chip-accent'
      : s === 'queued' ? 'tcv-chip tcv-chip-ok'
      : 'tcv-chip';
  }

  /** Position in the queue; the list already arrives ordered by queued_at. */
  queueIndex(r: Revision): number {
    return this.revisions().filter(x => x.status === 'queued').indexOf(r) + 1;
  }

  queueCount(): number {
    return this.revisions().filter(x => x.status === 'queued').length;
  }

  badge(s: RevisionStatus): string {
    return s === 'applied' ? 'var(--ok)'
      : s === 'queued' ? 'var(--accent-deep)'
      : s === 'rejected' ? 'var(--line)' : 'var(--warn)';
  }

  label(s: RevisionStatus): string {
    return s === 'applied' ? 'applied'
      : s === 'queued' ? 'queued'
      : s === 'rejected' ? 'rejected' : 'draft';
  }

  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  private flash(msg: string) {
    // Cancel the previous timer: without this an older message's timeout
    // wipes a newer one, and the second of two quick messages barely shows.
    clearTimeout(this.toastTimer);
    this.toast.set(msg);
    this.toastTimer = setTimeout(() => this.toast.set(''), 2600);
  }
}
