import {
  AfterViewInit, Component, ElementRef, OnDestroy, inject, signal, viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
const SEED = `"""__NAME__ - build123d modeli."""

from build123d import *

TITLE = "__NAME__"

with BuildPart() as part:
    Box(40, 30, 10)
    fillet(part.edges().filter_by(Axis.Z), radius=4)

# Asset Manager bu iki degiskeni okur:
PARTS = [part.part]
NAMES = ["govde"]
`;

import { Api, Catalog, Health, Stats, SystemInfo, FolderNode, ModelEntry, ModelVersion,
         Revision, RevisionStatus } from '../api';
import { OcpViewer } from './ocp';

type Stroke = { color: string; width: number; pts: [number, number][] };

@Component({
  selector: 'app-editor',
  imports: [NgTemplateOutlet],
  templateUrl: './editor.html',
})
export class Editor implements AfterViewInit, OnDestroy {
  private api = inject(Api);
  private cat = inject(Catalog);
  private health = inject(Health);
  private host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private overlay = viewChild.required<ElementRef<HTMLCanvasElement>>('overlay');
  private stage = viewChild.required<ElementRef<HTMLDivElement>>('stage');

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
  preview = signal<Revision | null>(null);
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
    // Modelde parcaya tiklayinca sagdaki formun Parca alanini doldur.
    this.viewer.onPick(name => {
      if (!name) return;
      const known = this.parts().find(p => p === name)
        ?? this.parts().find(p => name.endsWith(p));
      this.part.set(known ?? name);
      this.flash('parca: ' + (known ?? name));
    });
    this.loadCatalog();
    this.loadVersions();
    this.pollHealth();
    this.healthTimer = setInterval(() => this.pollHealth(), 5000);
    setTimeout(() => this.sizeOverlay());     // viewer DOM'u yerlestikten sonra
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
  }

  toggleSidebar() {
    this.collapsed.update(v => !v);
    setTimeout(() => this.sizeOverlay(), 60);   // gecis bitince sahneyi olcekle
  }

  gb(n: number): string { return (n / 1e9).toFixed(1) + ' GB'; }

  /** Daraltilmis panelde gosterilen kompakt olculer. */
  gauges(): { key: string; pct: number; tip: string }[] {
    const st = this.stats(), m = this.sys();
    const out: { key: string; pct: number; tip: string }[] = [];
    if (st?.quota_bytes) {
      out.push({ key: 'DB', pct: st.percent ?? 0,
                 tip: `MongoDB ${this.mb(st.used_bytes)} / ${this.mb(st.quota_bytes)}`
                    + ` · ${st.objects} kayit · ${st.versions} surum`
                    + ` · sirada ${st.revisions['queued'] ?? 0}` });
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

  // ---- katalog ----
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
    if (!m.data) { this.flash(m.name + ': once uret'); return; }
    this.busy.set('model yukleniyor');
    try {
      // Veri diskte degil; veritabanindan akiyor.
      await this.viewer.load(this.cat.viewerUrl(m.id));
      this.activeModel.set(m.id);
      this.parts.set(this.viewer.parts);
      setTimeout(() => this.sizeOverlay());
    } catch (e) {
      this.flash('yuklenemedi: ' + (e as Error).message);
    }
    this.busy.set('');
  }

  rebuild(m: ModelEntry, ev: Event) {
    ev.stopPropagation();
    this.busy.set(m.name + ' uretiliyor...');
    this.cat.build(m.id).subscribe({
      next: () => { this.busy.set(''); this.flash(m.name + ' guncellendi');
                    this.loadCatalog(); },
      error: e => { this.busy.set(''); this.flash('hata: ' + (e.error?.detail ?? e.status)); },
    });
  }

  newFolder(parent: string) {
    const name = prompt('Klasor adi (harf, rakam, - , _):');
    if (!name) return;
    this.cat.newFolder(name, parent).subscribe({
      next: () => this.loadCatalog(),
      error: e => this.flash(e.error?.detail ?? 'klasor olusturulamadi'),
    });
  }

  newModel(folder: string) {
    const name = prompt('Model adi (harf, rakam, - , _):');
    if (!name) return;
    const id = folder ? `${folder}/${name}` : name;
    const source = SEED.replace('__NAME__', name);
    this.cat.createModel(id, source).subscribe({
      next: () => { this.flash(name + ' olusturuldu'); this.loadCatalog(); },
      error: e => this.flash(e.error?.detail ?? 'model olusturulamadi'),
    });
  }

  imageUrl(r: Revision): string { return this.api.imageUrl(r.id); }

  openShot(r: Revision) { this.preview.set(r); }
  closeShot() { this.preview.set(null); }

  // ---- surum gecmisi ----
  loadVersions() { this.cat.versions().subscribe({ next: v => this.versions.set(v),
                                                   error: () => {} }); }

  takeSnapshot() {
    const note = prompt('Surum notu:') ?? '';
    this.busy.set('surum aliniyor');
    this.cat.snapshot(note).subscribe({
      next: () => { this.busy.set(''); this.flash('surum kaydedildi'); this.loadVersions(); },
      error: e => { this.busy.set(''); this.flash(e.error?.detail ?? 'surum alinamadi'); },
    });
  }

  restore(v: ModelVersion) {
    if (!confirm(`${v.short} surumune donulsun mu?\nMevcut hal once yedeklenir.`)) return;
    this.busy.set('geri yukleniyor');
    this.cat.restore(v._id).subscribe({
      next: () => { this.busy.set(''); this.flash('geri yuklendi: ' + v.short);
                    this.loadVersions(); this.loadCatalog(); },
      error: e => { this.busy.set(''); this.flash(e.error?.detail ?? 'geri yuklenemedi'); },
    });
  }

  mb(n: number): string { return (n / 1e6).toFixed(1) + ' MB'; }

  /** WebGL tavsiyesini yalnizca gercekten WebGL hatasiysa goster. */
  isWebglError(): boolean {
    return /webgl|context|gpu/i.test(this.glError());
  }

  private sizeOverlay() {
    const box = this.stage().nativeElement;
    this.viewer?.resize(box.clientWidth, box.clientHeight);

    // getImage() yalnizca canvas'i dondurur; overlay tam onun ustune
    // oturmazsa isaretler kaydedilen goruntude kayar.
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

  // ---- dondur / coz ----
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

  // ---- cizim ----
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

  // ---- kaydet ----
  async save() {
    if (!this.viewer) return;
    if (!this.comment().trim()) { this.flash('once yorum yaz'); return; }
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
        this.flash('revizyon kaydedildi');
        this.refresh();
      },
      error: e => { this.saving.set(false); this.flash('kaydedilemedi: ' + e.status); },
    });
  }

  /** Dondurulmus kare + cizim katmanini tek PNG'de birlestirir. */
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

  goTo(r: Revision) {
    if (r.camera && this.viewer) { this.resume(); this.viewer.applyCamera(r.camera); }
  }

  remove(r: Revision) {
    if (!confirm(`Revizyon silinsin mi?\n\n"${r.comment}"`)) return;
    this.api.remove(r.id).subscribe({
      next: () => { this.flash('revizyon silindi'); this.refresh(); this.pollHealth(); },
      error: () => this.flash('silinemedi'),
    });
  }

  mark(r: Revision, status: RevisionStatus) {
    this.api.setStatus(r.id, status).subscribe(() => this.refresh());
  }

  /** Sirada kacinci oldugu; liste zaten queued_at'e gore sirali geliyor. */
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
    return s === 'applied' ? 'uygulandi'
      : s === 'queued' ? 'sirada'
      : s === 'rejected' ? 'iptal' : 'taslak';
  }

  private flash(msg: string) {
    this.toast.set(msg);
    setTimeout(() => this.toast.set(''), 2600);
  }
}
