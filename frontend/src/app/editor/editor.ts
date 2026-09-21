import {
  AfterViewInit, Component, ElementRef, OnDestroy, inject, signal, viewChild,
} from '@angular/core';
import { Api, Revision } from '../api';
import { OcpViewer } from './ocp';

type Stroke = { color: string; width: number; pts: [number, number][] };

@Component({
  selector: 'app-editor',
  templateUrl: './editor.html',
})
export class Editor implements AfterViewInit, OnDestroy {
  private api = inject(Api);
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
      await this.viewer.init('assets/model.json',
        { w: Math.max(box.clientWidth - 250, 400), h: Math.max(box.clientHeight, 400) });
      this.parts.set(this.viewer.parts);
    } catch (e) {
      this.glError.set(String((e as Error)?.message ?? e));
      return;
    }
    setTimeout(() => this.sizeOverlay());     // viewer DOM'u yerlestikten sonra
    this.ro = new ResizeObserver(() => this.sizeOverlay());
    this.ro.observe(box);
    this.refresh();
  }

  ngOnDestroy() { this.ro?.disconnect(); this.viewer?.dispose(); }

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

  mark(r: Revision, status: Revision['status']) {
    this.api.setStatus(r.id, status).subscribe(() => this.refresh());
  }

  private flash(msg: string) {
    this.toast.set(msg);
    setTimeout(() => this.toast.set(''), 2600);
  }
}
