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

import { Activity, Api, Catalog, Health, LogLine, Run, Stats, SystemInfo, FolderNode, ModelEntry, ModelVersion,
         Revision, RevisionStatus } from '../api';
import { OcpViewer } from './ocp';

type Stroke = { color: string; width: number; pts: [number, number][] };

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
  preview = signal<Revision | null>(null);
  editing = signal<string | null>(null);
  editText = signal('');
  editPart = signal('');
  sys = signal<SystemInfo | null>(null);
  color = signal('#ff2d3f');
  penWidth = signal(4);

  private viewer?: OcpViewer;
  private frozenShot = '';
  private strokes: Stroke[] = [];
  private active: Stroke | null = null;
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
    this.pollHealth();
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
    this.activity.run().subscribe({ next: v => this.run.set(v), error: () => {} });
    this.activity.lines().subscribe({
      next: v => {
        const grew = v.length !== this.log().length;
        this.log.set(v);
        if (grew) setTimeout(() => this.scrollLog());
      },
      error: () => {},
    });
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

  // ---- catalog ----
  loadCatalog() {
    this.cat.tree().subscribe(t => {
      this.catalog.set(t);
      if (!this.activeModel()) {
        const first = this.firstReady(t);
        if (first) this.openModel(first);
      }
    });
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
    this.busy.set('loading model…');
    try {
      // Data is not on disk; it streams from the database.
      await this.viewer.load(this.cat.viewerUrl(m.id));
      this.activeModel.set(m.id);
      this.parts.set(this.viewer.parts);
      setTimeout(() => this.sizeOverlay());
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

  imageUrl(r: Revision): string { return this.api.imageUrl(r.id); }

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

  private sizeOverlay() {
    const box = this.stage().nativeElement;
    this.viewer?.resize(box.clientWidth, box.clientHeight);

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
  async freeze() {
    if (!this.viewer) return;
    this.frozenShot = await this.viewer.image();
    this.viewer.setEnabled(false);
    this.frozen.set(true);
  }

  resume() {
    this.viewer?.setEnabled(true);
    this.frozen.set(false);
    this.strokes = []; this.active = null; this.repaint();
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
    this.drawing = true;
    (ev.target as HTMLElement).setPointerCapture(ev.pointerId);
    this.active = { color: this.color(), width: this.penWidth(), pts: [this.pos(ev)] };
    this.strokes.push(this.active);
    this.repaint();
  }

  move(ev: PointerEvent) {
    if (!this.drawing || !this.active) return;
    this.active.pts.push(this.pos(ev));
    this.repaint();
  }

  up() { this.drawing = false; this.active = null; }
  undo() { this.strokes.pop(); this.repaint(); }
  clear() { this.strokes = []; this.repaint(); }

  private repaint() {
    const c = this.overlay().nativeElement;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.lineCap = ctx.lineJoin = 'round';
    const scale = Math.min(devicePixelRatio, 2);
    for (const s of this.strokes) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width * scale;
      ctx.beginPath();
      s.pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
      ctx.stroke();
    }
  }

  // ---- save ----
  async save() {
    if (!this.viewer) return;
    if (!this.comment().trim()) { this.flash('write a comment first'); return; }
    this.saving.set(true);
    const merged = await this.merge(this.frozenShot);
    this.api.create({
      comment: this.comment().trim(), image_png: merged,
      camera: this.viewer.cameraState(), part: this.part() || null,
      model: this.activeModel() || null,
    }).subscribe({
      next: () => {
        this.saving.set(false);
        this.comment.set('');
        this.clear();
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
    this.api.list().subscribe({ next: r => this.revisions.set(r), error: () => {} });
  }

  startEdit(r: Revision) {
    this.editing.set(r.id);
    this.editText.set(r.comment);
    this.editPart.set(r.part ?? '');
  }

  cancelEdit() { this.editing.set(null); }

  saveEdit(r: Revision) {
    const text = this.editText().trim();
    if (!text) { this.flash('comment cannot be empty'); return; }
    this.api.edit(r.id, { comment: text, part: this.editPart() || null }).subscribe({
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

  private flash(msg: string) {
    this.toast.set(msg);
    setTimeout(() => this.toast.set(''), 2600);
  }
}
