/** The board while TraceMaker routes it, drawn in the layout view.
 *
 *  TraceMaker streams what it does (docker/tm_relay.py keeps it, and
 *  backend/routelive.py hands it over a few times a second): the board,
 *  each track and via it lays and rips up, the connections still open, the
 *  search front it is spreading, where it failed, its progress. This draws
 *  that in the room's own colours - copper by layer, the open connections
 *  as thin lines, a new track lit for a moment, a ripped one fading, the
 *  search as a spray of dots - with the counts above it.
 *
 *  It shows nothing until a run is live, and hides itself a few seconds
 *  after it ends, when the routed board's own drawing takes over.
 */
import { HttpClient } from '@angular/common/http';
import {
  AfterViewInit, Component, ElementRef, OnDestroy, computed, effect, inject, input, output, signal, viewChild,
} from '@angular/core';
import { T } from '../i18n';

type Pt = [number, number];
interface Pad { id: number; net: number; layers: number[]; shape: 'circle' | 'segment' | 'polygon'; pts: Pt[]; r: number }
interface Track { id: number; a: Pt; b: Pt; w: number; layer: number; net: number }
interface Via { id: number; p: Pt; d: number; drill: number; net: number }
interface Board {
  bbox: [number, number, number, number]; layers: { name: string; index: number }[];
  nets: string[]; outline: Pt[][]; pads: Pad[]; tracks: Track[]; vias: Via[];
}
interface Stats { stage: string; routed: number; total: number; unrouted: number; rips: number; failures: number; elapsed_s: number }
interface LiveAnswer { active: boolean; engine: string | null; attempt?: number; events: any[]; at: number; more?: boolean }

/** How long a new track stays lit, a ripped one fades, a failure rings, ms. */
const LIT = 700, FADE = 600, RING = 1600, FRONT = 900;

@Component({
  selector: 'app-route-live',
  imports: [T],
  template: `
@if (shown()) {
  <div class="rl-root">
    <canvas #cv class="rl-canvas" (wheel)="wheel($event)" (pointerdown)="down($event)" (pointermove)="move($event)"
            (pointerup)="up()" (pointerleave)="up()" (dblclick)="fit()"></canvas>

    <div class="rl-hud">
      <div class="rl-head">
        <span class="rl-dot" [attr.data-state]="state()"></span>
        <b>TraceMaker</b>
        <span class="rl-dim">{{ stateText() | t }}</span>
        @if (attempt() > 1) { <span class="rl-dim">· {{ 'layout' | t }} {{ attempt() }}</span> }
        <span class="rl-clock mono">{{ clock() }}</span>
      </div>
      <div class="rl-bar"><i [style.width.%]="pct()"></i></div>
      <div class="rl-counts mono">
        <span><b>{{ stats()?.routed ?? 0 }}</b>/{{ stats()?.total ?? '–' }} {{ 'connections' | t }}</span>
        <span><b>{{ trackCount() }}</b> {{ 'tracks' | t }}</span>
        <span><b>{{ viaCount() }}</b> {{ 'vias' | t }}</span>
        <span [attr.data-hot]="(stats()?.rips ?? 0) > 0 ? '' : null"><b>{{ stats()?.rips ?? 0 }}</b> {{ 'rip-ups' | t }}</span>
        <span [attr.data-bad]="(stats()?.failures ?? 0) > 0 ? '' : null"><b>{{ stats()?.failures ?? 0 }}</b> {{ 'failed tries' | t }}</span>
      </div>
      @if (searchDone() && state() === 'live') {
        <p class="rl-note">{{ 'The router drawn here has finished; the others in the portfolio are still trying, and the best board is kept.' | t }}</p>
      }
      <div class="rl-tools">
        @for (l of layerNames(); track l.index) {
          <button class="rl-chip" [attr.data-off]="hidden().has(l.index) ? '' : null" (click)="toggleLayer(l.index)">
          <i [style.background]="layerColour(l.index)"></i>{{ l.name }}</button>
      }
      <button class="rl-chip" [attr.data-off]="showSearch() ? null : ''" (click)="showSearch.set(!showSearch())">
        <i class="rl-sw-search"></i>{{ 'search' | t }}</button>
      <button class="rl-chip" [attr.data-off]="showHeat() ? null : ''" (click)="showHeat.set(!showHeat())">
        <i class="rl-sw-heat"></i>{{ 'heat' | t }}</button>
      <button class="rl-chip" [attr.data-off]="showRats() ? null : ''" (click)="showRats.set(!showRats())">
        <i class="rl-sw-rats"></i>{{ 'open' | t }}</button>
        @if (state() !== 'live') { <button class="rl-chip" (click)="close()">{{ 'Close' | t }}</button> }
      </div>

    </div>

    @if (lastFailure(); as f) {
      <div class="rl-foot mono" [title]="f">{{ f }}</div>
    }
  </div>
}`,
  styles: [`
:host { position: absolute; inset: 0; z-index: 5; pointer-events: none; }
.rl-root { position: absolute; inset: 0; pointer-events: auto; background: var(--pcb-bg); overflow: hidden; }
.rl-canvas { position: absolute; inset: 0; width: 100%; height: 100%; cursor: grab; touch-action: none; }
.rl-canvas:active { cursor: grabbing; }
.rl-hud { position: absolute; top: 8px; left: 8px; min-width: 260px; max-width: min(520px, calc(100% - 16px));
  padding: 7px 10px 8px; border-radius: 5px; background: var(--overlay); border: 1px solid var(--line);
  display: flex; flex-direction: column; gap: 5px; font-size: 11px; color: var(--ink); }
.rl-head { display: flex; align-items: center; gap: 6px; }
.rl-head b { font-weight: 600; letter-spacing: .02em; }
.rl-dim { color: var(--ink-dim); }
.rl-clock { margin-left: auto; color: var(--ink-dim); }
.rl-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ink-dim); }
.rl-dot[data-state="live"] { background: var(--accent); animation: rl-pulse 1.2s ease-in-out infinite; }
.rl-dot[data-state="done"] { background: var(--ok); }
@keyframes rl-pulse { 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { .rl-dot[data-state="live"] { animation: none; } }
.rl-bar { height: 3px; border-radius: 2px; background: var(--line); overflow: hidden; }
.rl-bar > i { display: block; height: 100%; background: var(--accent); transition: width .3s; }
.rl-counts { display: flex; flex-wrap: wrap; gap: 2px 12px; font-size: 10.5px; color: var(--ink-dim); }
.rl-counts b { color: var(--ink); font-weight: 600; }
.rl-counts [data-hot] b { color: var(--warn); }
.rl-counts [data-bad] b { color: var(--danger); }
.rl-note { margin: 0; font-size: 10.5px; color: var(--ink-dim); }
.rl-tools { display: flex; flex-wrap: wrap; gap: 4px; padding-top: 5px; border-top: 1px solid var(--line); }
.rl-chip { display: inline-flex; align-items: center; gap: 5px; padding: 1px 7px; font-size: 10.5px; border-radius: 3px;
  color: var(--ink); background: transparent; border: 1px solid var(--line); cursor: pointer; }
.rl-chip:hover { background: var(--hover); }
.rl-chip[data-off] { color: var(--ink-dim); }
.rl-chip[data-off] > i { opacity: .3; }
.rl-chip > i { width: 8px; height: 8px; border-radius: 2px; }
.rl-sw-search { background: var(--warn); border-radius: 50% !important; }
.rl-sw-heat { background: var(--chart-progress); }
.rl-sw-rats { background: var(--ink-dim); height: 2px !important; }
.rl-foot { position: absolute; left: 8px; bottom: 8px; max-width: calc(100% - 16px); padding: 3px 8px; border-radius: 3px; font-size: 10.5px;
  background: var(--overlay); color: var(--danger); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
`],
})
export class RouteLive implements AfterViewInit, OnDestroy {
  private http = inject(HttpClient);
  private host = inject(ElementRef<HTMLElement>);
  /** The board whose run to follow. */
  board = input<string | null>(null);
  /** Said when the view starts and stops covering the drawing. */
  showing = output<boolean>();
  /** A run ended: time to load the routed board. */
  finished = output<void>();

  private cv = viewChild<ElementRef<HTMLCanvasElement>>('cv');
  shown = signal(false);
  state = signal<'live' | 'done' | 'idle'>('idle');
  stats = signal<Stats | null>(null);
  attempt = signal(0);
  trackCount = signal(0);
  viaCount = signal(0);
  lastFailure = signal<string | null>(null);
  searchDone = signal(false);
  hidden = signal<Set<number>>(new Set());
  showSearch = signal(true);
  showHeat = signal(false);
  showRats = signal(true);
  private startedAt = 0;
  private now = signal(Date.now());

  // The scene: the board, then what the router has done to it.
  private b: Board | null = null;
  private tracks = new Map<number, Track & { born: number }>();
  private vias = new Map<number, Via & { born: number }>();
  private ghosts: { t: Track; gone: number }[] = [];
  private rats: number[][] = [];
  private front: { pts: Pt[]; layer: number; at: number } | null = null;
  private fails: { p: Pt; at: number }[] = [];
  private heat: { x0: number; y0: number; cell: number; w: number; h: number; max: number; data: number[] } | null = null;
  private heatImg: HTMLCanvasElement | null = null;
  private dirty = true;

  // Where we are in the stream, and the view.
  private at = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private raf = 0;
  private zoom = 1;
  private pan: Pt = [0, 0];
  private drag: { x: number; y: number; px: number; py: number } | null = null;
  private colours: Record<string, string> = {};
  private ro?: ResizeObserver;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;

  /** Bumped when a board snapshot comes, so what is read off it follows. */
  private boardRev = signal(0);
  layerNames = computed(() => { this.boardRev(); return this.b?.layers ?? []; });
  pct = computed(() => { const s = this.stats(); return s && s.total ? Math.min(100, s.routed / s.total * 100) : 0; });
  clock = computed(() => {
    if (!this.startedAt) return '';
    const s = Math.max(0, Math.round((this.now() - this.startedAt) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  });
  stateText = computed(() => this.state() === 'live' ? 'routing' : this.state() === 'done' ? 'routed - loading the board' : '');

  constructor() {
    effect(() => { this.board(); this.reset(); this.poll(0); });
  }

  ngAfterViewInit() {
    this.ro = new ResizeObserver(() => { this.dirty = true; });
    this.ro.observe(this.host.nativeElement);
    const loop = () => { this.frame(); this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
  }

  ngOnDestroy() {
    if (this.timer) clearTimeout(this.timer);
    if (this.hideTimer) clearTimeout(this.hideTimer);
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
  }

  // ---- the stream ----

  private reset() {
    this.b = null; this.tracks.clear(); this.vias.clear(); this.ghosts = []; this.rats = [];
    this.front = null; this.fails = []; this.heat = null; this.heatImg = null; this.at = 0;
    this.stats.set(null); this.trackCount.set(0); this.viaCount.set(0); this.lastFailure.set(null);
    this.searchDone.set(false); this.dirty = true;
  }

  /** Every 2 s while nothing runs, every 350 ms while it does. */
  private poll(delay: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.read(), delay);
  }

  private read() {
    const id = this.board();
    if (!id) return;
    this.http.get<LiveAnswer>(`/api/boards/${encodeURIComponent(id)}/route/live`, { params: { at: this.at } }).subscribe({
      next: r => {
        if (this.board() !== id) return;
        if (r.active && (r.attempt ?? 0) !== this.attempt()) {
          // A new layout try: its own stream, read from its start.
          const fromStart = this.at === 0;
          this.reset(); this.attempt.set(r.attempt ?? 0);
          if (!fromStart) { this.poll(0); return; }
        }
        if (r.at < this.at) this.reset();
        this.at = r.at;
        for (const e of r.events) this.apply(e);
        if (r.events.length) this.dirty = true;
        if (r.active) {
          if (this.state() !== 'live') { this.state.set('live'); this.startedAt = Date.now(); this.show(true); }
        } else if (this.state() === 'live') {
          this.state.set('done'); this.finished.emit();
          this.hideTimer = setTimeout(() => this.close(), 4000);
        }
        this.now.set(Date.now());
        this.poll(r.active ? (r.more ? 0 : 350) : 3000);
      },
      error: () => this.poll(4000),
    });
  }

  private apply(e: any) {
    const now = performance.now();
    switch (e.type) {
      case 'board':
        this.b = e as Board;
        this.tracks.clear(); this.vias.clear();
        for (const t of this.b.tracks ?? []) this.tracks.set(t.id, { ...t, born: 0 });
        for (const v of this.b.vias ?? []) this.vias.set(v.id, { ...v, born: 0 });
        this.boardRev.update(n => n + 1);
        this.fit();
        break;
      case 'track_add': this.tracks.set(e.track.id, { ...e.track, born: now }); break;
      case 'track_remove': {
        const t = this.tracks.get(e.id);
        if (t) { this.tracks.delete(e.id); this.ghosts.push({ t, gone: now }); }
        break;
      }
      case 'via_add': this.vias.set(e.via.id, { ...e.via, born: now }); break;
      case 'via_remove': this.vias.delete(e.id); break;
      case 'ratsnest': this.rats = e.edges ?? []; break;
      case 'frontier': this.front = { pts: e.pts ?? [], layer: e.layer ?? 0, at: now }; break;
      case 'path_try':
        this.front = { pts: (e.pts ?? []).map((p: number[]) => [p[0], p[1]] as Pt), layer: e.pts?.[0]?.[2] ?? 0, at: now };
        break;
      case 'failure': {
        if (e.a) this.fails.push({ p: e.a, at: now });
        const net = this.b?.nets?.[e.net] ?? `net ${e.net}`;
        this.lastFailure.set(`${net}: ${e.cause ?? 'failed'}`);
        break;
      }
      case 'heatmap':
        if (e.name === 'expansions') { this.heat = e; this.heatImg = null; }
        break;
      case 'stats':
        this.stats.set(e);
        if (e.stage === 'done') this.searchDone.set(true);
        break;
    }
    this.trackCount.set(this.tracks.size);
    this.viaCount.set(this.vias.size);
  }

  private show(on: boolean) {
    if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }
    this.shown.set(on); this.showing.emit(on);
    if (on) setTimeout(() => { this.fit(); this.dirty = true; });
  }

  close() { this.state.set('idle'); this.show(false); }

  toggleLayer(i: number) {
    this.hidden.update(s => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; });
    this.dirty = true;
  }

  // ---- the view ----

  fit() { this.zoom = 1; this.pan = [0, 0]; this.dirty = true; }

  wheel(ev: WheelEvent) {
    ev.preventDefault();
    const c = this.cv()?.nativeElement;
    if (!c) return;
    const r = c.getBoundingClientRect(), mx = ev.clientX - r.left - r.width / 2, my = ev.clientY - r.top - r.height / 2;
    const k = Math.exp(-ev.deltaY * 0.0015), z = Math.min(40, Math.max(0.5, this.zoom * k)), f = z / this.zoom;
    this.pan = [mx - (mx - this.pan[0]) * f, my - (my - this.pan[1]) * f];
    this.zoom = z; this.dirty = true;
  }
  down(ev: PointerEvent) { this.drag = { x: ev.clientX, y: ev.clientY, px: this.pan[0], py: this.pan[1] }; }
  move(ev: PointerEvent) {
    if (!this.drag) return;
    this.pan = [this.drag.px + ev.clientX - this.drag.x, this.drag.py + ev.clientY - this.drag.y];
    this.dirty = true;
  }
  up() { this.drag = null; }

  /** A theme colour, read off the page (the theme may change under us). */
  private col(name: string): string {
    return this.colours[name] ??= getComputedStyle(this.host.nativeElement).getPropertyValue(name).trim();
  }
  /** Copper by layer: the front the room's warm red, the back its blue, inner layers between. */
  layerColour(i: number): string {
    const n = this.b?.layers?.length ?? 2;
    if (i === 0) return 'var(--chart-summary)';
    if (i === n - 1) return 'var(--chart-work)';
    return ['var(--chart-translate)', 'var(--chart-reply)', 'var(--chart-progress)'][(i - 1) % 3];
  }
  private layerRaw(i: number): string { return this.col(this.layerColour(i).slice(4, -1)); }

  private frame() {
    const c = this.cv()?.nativeElement, b = this.b;
    if (!c || !b) return;
    const now = performance.now();
    const animating = this.ghosts.length || this.fails.some(f => now - f.at < RING)
      || [...this.tracks.values()].some(t => t.born && now - t.born < LIT) || (this.front && now - this.front.at < FRONT);
    if (!this.dirty && !animating) return;
    this.dirty = false;
    this.colours = {};
    const dpr = window.devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);

    const [x0, y0, x1, y1] = b.bbox, bw = x1 - x0 || 1, bh = y1 - y0 || 1;
    const s = Math.min((W - 40) / bw, (H - 40) / bh) * this.zoom;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const X = (x: number) => (x - cx) * s + W / 2 + this.pan[0];
    const Y = (y: number) => (y - cy) * s + H / 2 + this.pan[1];
    const px = (v: number) => Math.max(0.6, v * s);

    // The outline.
    g.lineWidth = 1; g.strokeStyle = this.col('--ink-dim'); g.globalAlpha = 0.7;
    for (const ring of b.outline ?? []) {
      g.beginPath();
      ring.forEach((p, i) => i ? g.lineTo(X(p[0]), Y(p[1])) : g.moveTo(X(p[0]), Y(p[1])));
      g.closePath(); g.stroke();
    }
    g.globalAlpha = 1;

    // The search effort, under everything.
    if (this.showHeat() && this.heat) this.drawHeat(g, X, Y, s);

    // Copper, the bottom layer first.
    const order = [...(b.layers ?? [])].map(l => l.index).sort((p, q) => q - p);
    for (const li of order) {
      if (this.hidden().has(li)) continue;
      const colour = this.layerRaw(li);
      g.lineCap = 'round';
      g.fillStyle = colour; g.strokeStyle = colour;
      g.globalAlpha = 0.3;
      for (const p of b.pads) if (p.layers.includes(li) && Math.min(...p.layers.filter(l => !this.hidden().has(l))) === li) this.drawPad(g, p, X, Y, s);
      g.globalAlpha = 0.95;
      for (const t of this.tracks.values()) {
        if (t.layer !== li) continue;
        g.lineWidth = px(t.w);
        const age = t.born ? now - t.born : LIT;
        g.strokeStyle = age < LIT ? this.col('--ink-bright') : colour;
        g.globalAlpha = age < LIT ? 0.7 + 0.3 * (1 - age / LIT) : 1;
        g.beginPath(); g.moveTo(X(t.a[0]), Y(t.a[1])); g.lineTo(X(t.b[0]), Y(t.b[1])); g.stroke();
      }
    }
    g.globalAlpha = 1;

    // Ripped up: a red ghost that fades.
    this.ghosts = this.ghosts.filter(gh => now - gh.gone < FADE);
    g.strokeStyle = this.col('--danger');
    for (const gh of this.ghosts) {
      if (this.hidden().has(gh.t.layer)) continue;
      g.globalAlpha = 0.8 * (1 - (now - gh.gone) / FADE);
      g.lineWidth = px(gh.t.w);
      g.beginPath(); g.moveTo(X(gh.t.a[0]), Y(gh.t.a[1])); g.lineTo(X(gh.t.b[0]), Y(gh.t.b[1])); g.stroke();
    }
    g.globalAlpha = 1;

    // Vias.
    for (const v of this.vias.values()) {
      const r = px(v.d / 2), age = v.born ? now - v.born : LIT;
      g.fillStyle = age < LIT ? this.col('--ink-bright') : this.col('--ink');
      g.beginPath(); g.arc(X(v.p[0]), Y(v.p[1]), r, 0, Math.PI * 2); g.fill();
      g.fillStyle = this.col('--pcb-bg');
      g.beginPath(); g.arc(X(v.p[0]), Y(v.p[1]), Math.max(0.4, px(v.drill / 2)), 0, Math.PI * 2); g.fill();
    }

    // What is still open.
    if (this.showRats() && this.rats.length) {
      g.strokeStyle = this.col('--ink-dim'); g.lineWidth = 1; g.globalAlpha = 0.55; g.setLineDash([3, 3]);
      g.beginPath();
      for (const e of this.rats) { g.moveTo(X(e[0]), Y(e[1])); g.lineTo(X(e[2]), Y(e[3])); }
      g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
    }

    // The search front: where the router is looking right now.
    if (this.showSearch() && this.front && now - this.front.at < FRONT) {
      const a = 1 - (now - this.front.at) / FRONT;
      g.fillStyle = this.col('--warn'); g.globalAlpha = 0.85 * a;
      for (const p of this.front.pts) { g.beginPath(); g.arc(X(p[0]), Y(p[1]), 1.6, 0, Math.PI * 2); g.fill(); }
      g.globalAlpha = 1;
    }

    // Failures: a ring that opens and fades.
    this.fails = this.fails.filter(f => now - f.at < RING);
    g.strokeStyle = this.col('--danger'); g.lineWidth = 1.5;
    for (const f of this.fails) {
      const k = (now - f.at) / RING;
      g.globalAlpha = 1 - k;
      g.beginPath(); g.arc(X(f.p[0]), Y(f.p[1]), 4 + 14 * k, 0, Math.PI * 2); g.stroke();
    }
    g.globalAlpha = 1;
  }

  private drawPad(g: CanvasRenderingContext2D, p: Pad, X: (v: number) => number, Y: (v: number) => number, s: number) {
    if (p.shape === 'circle') {
      g.beginPath(); g.arc(X(p.pts[0][0]), Y(p.pts[0][1]), Math.max(0.8, p.r * s), 0, Math.PI * 2); g.fill();
    } else if (p.shape === 'segment') {
      g.lineWidth = Math.max(1, 2 * p.r * s);
      g.beginPath(); g.moveTo(X(p.pts[0][0]), Y(p.pts[0][1])); g.lineTo(X(p.pts[1][0]), Y(p.pts[1][1])); g.stroke();
    } else {
      g.beginPath();
      p.pts.forEach((q, i) => i ? g.lineTo(X(q[0]), Y(q[1])) : g.moveTo(X(q[0]), Y(q[1])));
      g.closePath(); g.fill();
      if (p.r > 0) { g.lineWidth = 2 * p.r * s; g.lineJoin = 'round'; g.stroke(); }
    }
  }

  /** The A* expansions per cell, as a warm wash: where the router has worked hardest. */
  private drawHeat(g: CanvasRenderingContext2D, X: (v: number) => number, Y: (v: number) => number, s: number) {
    const h = this.heat!;
    if (!this.heatImg) {
      const img = document.createElement('canvas');
      img.width = h.w; img.height = h.h;
      const ctx = img.getContext('2d')!, id = ctx.createImageData(h.w, h.h);
      const probe = document.createElement('canvas').getContext('2d')!;
      probe.fillStyle = this.col('--chart-progress');
      probe.fillRect(0, 0, 1, 1);
      const [r, gg, bb] = probe.getImageData(0, 0, 1, 1).data;
      for (let i = 0; i < h.data.length; i++) {
        id.data[i * 4] = r; id.data[i * 4 + 1] = gg; id.data[i * 4 + 2] = bb; id.data[i * 4 + 3] = Math.round(h.data[i] * 0.6);
      }
      ctx.putImageData(id, 0, 0);
      this.heatImg = img;
    }
    g.imageSmoothingEnabled = true;
    g.drawImage(this.heatImg, X(h.x0), Y(h.y0), h.w * h.cell * s, h.h * h.cell * s);
  }
}
