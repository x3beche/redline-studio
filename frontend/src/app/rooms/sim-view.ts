import {
  Component, ElementRef, OnDestroy, computed, effect, inject, input, signal,
  untracked, viewChild,
} from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Board3d } from './board3d';

/** A part's view, as the simulator sends it (backend/sim/parts.py). */
interface PartView {
  glow?: number;
  pressed?: boolean;
  rpm?: number;
  duty?: number;
  value?: number; min?: number; max?: number; unit?: string; volts?: number;
  sliders?: Record<string, { min?: number; max?: number; value?: number; unit?: string }>;
  screen?: { w: number; h: number; bits: string };
}
interface UartLine { t: number; port: string; dir: 'in' | 'out'; data: string }
interface Snapshot {
  state: 'idle' | 'starting' | 'building' | 'running' | 'stopped' | 'failed';
  error: string | null;
  t: number;
  parts: Record<string, PartView>;
  uart: UartLine[];
}
interface Model { model: string; block: string; view: Record<string, string> }
interface SimInfo {
  app: string;
  board: string | null;
  glb: boolean;
  sim: { mcu: { family?: string; emulator?: string }; parts: { ref: string; model: string }[];
         skipped?: { ref: string; why: string }[] } | null;
  models: Record<string, Model>;
  errors: string[];
  warnings: string[];
  snapshot: Snapshot;
}

/** Visual turns a second for a fan: the real 30 a second would strobe. */
const RPM_TO_RPS = 1 / 600;

/** The firmware on its virtual board, in the Embedded room.
 *
 *  Left, the board in 3D with the parts doing what the firmware makes
 *  them do: a LED glows, a display shows its picture, a fan turns, a
 *  button goes down under the pointer. Right, the same parts as a list
 *  with their sliders, and the MCU's serial port. The state comes as
 *  Server-Sent Events (backend/sim/api.py); what is done here goes back
 *  as POSTs.
 */
@Component({
  selector: 'app-sim-view',
  imports: [Board3d],
  styles: [`
    :host { display: block; height: 100%; }
    .sim { display: flex; height: 100%; min-height: 0; gap: 4px; background: var(--surface); }
    .stage { position: relative; flex: 1; min-width: 0; }
    .why { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
           padding: 24px; text-align: center; font-size: 12px; line-height: 1.6; color: var(--ink-dim); }
    .side { width: 270px; flex-shrink: 0; display: flex; flex-direction: column; min-height: 0;
            border-left: 1px solid var(--line); font-size: 11px; color: var(--ink); }
    .bar { display: flex; align-items: center; gap: 4px; padding: 4px 6px; border-bottom: 1px solid var(--line); }
    .dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; background: var(--ink-dim); }
    .dot[data-s="running"] { background: var(--ok); }
    .dot[data-s="building"], .dot[data-s="starting"] { background: var(--warn); }
    .dot[data-s="failed"] { background: var(--danger); }
    .state { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-dim); }
    .msg { padding: 4px 6px; white-space: pre-wrap; word-break: break-word; max-height: 120px; overflow: auto;
           border-bottom: 1px solid var(--line); }
    .msg.err { color: var(--danger); }
    .msg.warn { color: var(--warn); }
    .parts { overflow: auto; padding: 2px 6px; max-height: 45%; flex-shrink: 0; }
    .part { display: flex; align-items: center; gap: 6px; padding: 3px 0; border-bottom: 1px solid var(--line); }
    .ref { width: 44px; flex-shrink: 0; font-weight: 600; }
    .kind { width: 58px; flex-shrink: 0; color: var(--ink-dim); overflow: hidden; text-overflow: ellipsis; }
    .read { flex: 1; min-width: 0; display: flex; align-items: center; gap: 4px; }
    .meter { flex: 1; height: 4px; border-radius: 2px; background: var(--line); overflow: hidden; }
    .meter > span { display: block; height: 100%; background: var(--accent); }
    .read input[type=range] { flex: 1; min-width: 0; accent-color: var(--accent); }
    .hold { padding: 0 8px; }
    .hold[data-on] { background: var(--accent-deep); border-color: var(--accent); }
    .uart { flex: 1; min-height: 80px; display: flex; flex-direction: column; border-top: 1px solid var(--line); }
    .log { flex: 1; min-height: 0; overflow: auto; margin: 0; padding: 4px 6px; white-space: pre-wrap;
           word-break: break-all; line-height: 1.35; color: var(--ink-dim); }
    .log .in { color: var(--accent); }
    .log .out { color: var(--ink); }
    .type { display: flex; gap: 4px; padding: 4px 6px; border-top: 1px solid var(--line); }
    .type input { flex: 1; min-width: 0; }
    canvas.scr { image-rendering: pixelated; height: 24px; border: 1px solid var(--line); }
  `],
  template: `
<div class="sim">
  <div class="stage">
    @if (glbUrl(); as url) {
      <app-board-3d [src]="url" />
    } @else {
      <div class="why">
        @if (!info()) { reading the board… }
        @else if (!info()!.board) {
          This firmware is not linked to a board, so there is nothing to run it on.
          Link the board it runs on and the simulator builds sim.json from its netlist:
          POST /api/sim/{{ app() }}/link with {{ '{' }}"board": "&lt;board id&gt;"{{ '}' }},
          or tools/revisions.py sim link {{ app() }} &lt;board&gt;.
        } @else {
          Board {{ info()!.board }} has no 3D model yet. Lay it out in the PCB room
          (the placed board is exported as board.glb) and it shows here; the parts
          still run in the list on the right.
        }
      </div>
    }
  </div>

  <aside class="side">
    <div class="bar">
      <span class="dot" [attr.data-s]="snap().state"></span>
      <span class="state mono" [title]="stateLine()">{{ stateLine() }}</span>
      @if (live()) {
        <button class="tcv-btn px-2" (click)="stop()" [disabled]="busy()">Stop</button>
        <button class="tcv-btn px-2" (click)="post('reset')" [disabled]="busy()">Reset</button>
      } @else {
        <button class="tcv-btn tcv-btn-accent px-2" (click)="post('start')"
                [disabled]="busy() || !runnable()">Start</button>
      }
    </div>
    @for (e of problems(); track e) { <div class="msg err">{{ e }}</div> }
    @for (w of info()?.warnings ?? []; track w) { <div class="msg warn">{{ w }}</div> }

    <div class="parts">
      @for (p of parts(); track p.ref) {
        <div class="part">
          <span class="ref mono" [title]="p.model">{{ p.ref }}</span>
          <span class="kind">{{ p.model }}</span>
          <span class="read mono">
            @switch (p.block) {
              @case ('light') {
                <span class="meter"><span [style.width.%]="(p.view.glow ?? 0) * 100"
                      [style.background]="p.colour"></span></span>
                {{ pct(p.view.glow) }}
              }
              @case ('press') {
                <button class="tcv-btn hold" [attr.data-on]="p.view.pressed ? 1 : null" [disabled]="!live()"
                        (pointerdown)="press(p.ref, true)" (pointerup)="press(p.ref, false)"
                        (pointerleave)="p.view.pressed && press(p.ref, false)">press</button>
              }
              @case ('motor') {
                <span class="meter"><span [style.width.%]="(p.view.duty ?? 0) * 100"></span></span>
                {{ p.view.rpm ?? 0 }} rpm
              }
              @case ('level') {
                <input type="range" [min]="p.view.min ?? 0" [max]="p.view.max ?? 1"
                       [step]="((p.view.max ?? 1) - (p.view.min ?? 0)) / 100"
                       [value]="p.view.value ?? 0" [disabled]="!live()"
                       (input)="set(p.ref, 'value', $any($event.target).value)">
                {{ p.view.value ?? 0 }}{{ p.view.unit }}
              }
              @case ('regs') {
                @for (s of sliders(p.view); track s.key) {
                  <input type="range" [min]="s.min" [max]="s.max" [step]="(s.max - s.min) / 100"
                         [value]="s.value" [disabled]="!live()" [title]="s.key"
                         (input)="set(p.ref, s.key, $any($event.target).value)">
                  {{ s.value }}{{ s.unit }}
                }
              }
              @default {
                @if (p.view.screen) {
                  <canvas class="scr" [attr.data-ref]="p.ref"></canvas>
                }
              }
            }
          </span>
        </div>
      } @empty {
        @if (info()?.sim) { <p class="py-1" style="color: var(--ink-dim)">no part on this board has a model</p> }
      }
      @for (s of info()?.sim?.skipped ?? []; track s.ref) {
        <div class="part" style="color: var(--ink-dim)" [title]="s.why">
          <span class="ref mono">{{ s.ref }}</span><span class="read">{{ s.why }}</span>
        </div>
      }
    </div>

    <div class="uart">
      <pre #log class="log mono">@for (l of uart(); track $index) {<span [class]="l.dir">{{ l.text }}</span>}</pre>
      <div class="type">
        <input #line class="tcv-field mono px-1.5 py-0.5" placeholder="type to UART0, Enter sends"
               [disabled]="!live()" (keydown.enter)="send(line)">
      </div>
    </div>
  </aside>
</div>`,
})
export class SimView implements OnDestroy {
  /** The embedded app whose firmware runs. */
  app = input.required<string>();

  private http = inject(HttpClient);
  private host = inject(ElementRef<HTMLElement>);
  private board = viewChild(Board3d);
  private log = viewChild<ElementRef<HTMLPreElement>>('log');

  info = signal<SimInfo | null>(null);
  snap = signal<Snapshot>({ state: 'idle', error: null, t: 0, parts: {}, uart: [] });
  busy = signal(false);
  note = signal('');
  private events?: EventSource;
  private screens = new Map<string, HTMLCanvasElement>();

  live = computed(() => ['starting', 'building', 'running'].includes(this.snap().state));
  runnable = computed(() => !!this.info()?.sim);
  glbUrl = computed(() => {
    const i = this.info();
    return i?.board && i.glb ? `/api/boards/${i.board}/board.glb` : null;
  });

  problems = computed(() => {
    const out = [...(this.info()?.errors ?? [])];
    const s = this.snap();
    if (s.error && (s.state === 'failed' || s.state === 'stopped')) out.push(s.error);
    if (this.note()) out.push(this.note());
    return out;
  });

  stateLine = computed(() => {
    const s = this.snap();
    const i = this.info();
    const mcu = i?.sim?.mcu?.emulator ?? '';
    switch (s.state) {
      case 'building': return `building the firmware for ${mcu}…`;
      case 'starting': return 'starting…';
      case 'running': return `running · ${(s.t / 1e6).toFixed(1)} s · ${mcu}`;
      case 'failed': return 'failed';
      case 'stopped': return 'stopped';
      default: return i?.board ? `${i.board} · not running` : 'not running';
    }
  });

  /** The parts, in sim.json's order, with what the model says about drawing them. */
  parts = computed(() => {
    const i = this.info();
    const views = this.snap().parts;
    return (i?.sim?.parts ?? []).map(p => {
      const m = i!.models[p.ref];
      return { ref: p.ref, model: p.model, block: m?.block ?? 'code',
               colour: m?.view?.['glow'] ?? 'var(--accent)', view: views[p.ref] ?? {} };
    });
  });

  /** The transcript with the terminal's colour codes taken out. */
  uart = computed(() => this.snap().uart.map(l => ({
    dir: l.dir, text: (l.dir === 'in' ? '› ' : '') + l.data.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''),
  })));

  constructor() {
    effect(() => {
      const app = this.app();
      untracked(() => this.open(app));
    });
    // The board follows the state: on every snapshot, and again when a
    // (new) model has loaded.
    effect(() => {
      const b = this.board();
      b?.loaded();
      const snap = this.snap();
      const i = this.info();
      if (b && i) untracked(() => this.paint(b, i, snap));
    });
    // The console keeps to its end while something is said.
    effect(() => {
      this.uart();
      const el = this.log()?.nativeElement;
      if (el) queueMicrotask(() => { el.scrollTop = el.scrollHeight; });
    });
  }

  ngOnDestroy() {
    this.events?.close();
  }

  private open(app: string) {
    this.events?.close();
    this.info.set(null);
    this.reload();
    this.events = new EventSource(`/api/sim/${encodeURIComponent(app)}/events`);
    this.events.addEventListener('snapshot', ev => {
      const s = JSON.parse((ev as MessageEvent).data) as Snapshot;
      const was = this.snap().state;
      this.snap.set(s);
      // A run started or ended somewhere else: its sim.json may differ.
      if (was !== s.state && (s.state === 'running' || was === 'idle')) this.reload();
    });
  }

  private reload() {
    const app = this.app();
    this.http.get<SimInfo>(`/api/sim/${encodeURIComponent(app)}`).subscribe({
      next: i => { if (app === this.app()) { this.info.set(i); if (i.snapshot) this.snap.set(i.snapshot); } },
      error: e => this.note.set(this.why(e)),
    });
  }

  post(what: 'start' | 'reset') {
    this.busy.set(true);
    this.note.set('');
    this.http.post(`/api/sim/${encodeURIComponent(this.app())}/${what}`, {}).subscribe({
      next: () => { this.busy.set(false); this.reload(); },
      error: e => { this.busy.set(false); this.note.set(this.why(e)); },
    });
  }

  stop() {
    this.busy.set(true);
    this.http.post(`/api/sim/${encodeURIComponent(this.app())}/stop`, {}).subscribe({
      next: () => this.busy.set(false),
      error: e => { this.busy.set(false); this.note.set(this.why(e)); },
    });
  }

  press(ref: string, down: boolean) {
    this.act(ref, { press: down });
  }

  set(ref: string, key: string, value: string) {
    this.act(ref, { [key]: Number(value) });
  }

  private act(ref: string, action: Record<string, unknown>) {
    if (!this.live()) return;
    this.http.post(`/api/sim/${encodeURIComponent(this.app())}/act`, { ref, action })
      .subscribe({ error: e => this.note.set(this.why(e)) });
  }

  send(input: HTMLInputElement) {
    const text = input.value;
    input.value = '';
    this.http.post(`/api/sim/${encodeURIComponent(this.app())}/uart`, { port: 'UART0', data: text + '\r\n' })
      .subscribe({ error: e => this.note.set(this.why(e)) });
  }

  sliders(v: PartView) {
    return Object.entries(v.sliders ?? {}).map(([key, s]) => ({
      key, min: s.min ?? 0, max: s.max ?? 100, value: s.value ?? 0, unit: s.unit ?? '' }));
  }

  pct(x?: number): string {
    return `${Math.round((x ?? 0) * 100)}%`;
  }

  /** The live parts onto the 3D board: glow, pictures, turning, and which take a press. */
  private paint(b: Board3d, i: SimInfo, snap: Snapshot) {
    const buttons = new Set<string>();
    for (const [ref, m] of Object.entries(i.models)) {
      const v = snap.parts[ref] ?? {};
      if (m.block === 'light') b.glow(ref, m.view['glow'] ?? 0xffffff, v.glow ?? 0);
      else if (m.block === 'motor') b.spin(ref, (v.rpm ?? 0) * RPM_TO_RPS);
      else if (m.block === 'press') buttons.add(ref);
      if (v.screen) b.face(ref, this.screen(ref, v.screen, m.view['pixel']));
    }
    b.pickable(buttons, (ref, down) => this.press(ref, down));
  }

  /** A display's frame buffer (rows MSB first, base64) drawn into a canvas,
   *  which is both the 3D texture and the list's little picture. */
  private screen(ref: string, s: { w: number; h: number; bits: string }, pixel?: string): HTMLCanvasElement {
    let c = this.screens.get(ref);
    if (c && c.dataset['bits'] === s.bits) return c;
    if (!c) {
      c = document.createElement('canvas');
      this.screens.set(ref, c);
    }
    c.dataset['bits'] = s.bits;
    c.width = s.w;
    c.height = s.h;
    const g = c.getContext('2d')!;
    // The glass is dark whatever the theme: it is the part, not the page.
    g.fillStyle = 'black';
    g.fillRect(0, 0, s.w, s.h);
    g.fillStyle = pixel ?? 'white';
    const bits = atob(s.bits);
    const stride = (s.w + 7) >> 3;
    for (let y = 0; y < s.h; y++) {
      for (let x = 0; x < s.w; x++) {
        if (bits.charCodeAt(y * stride + (x >> 3)) & (0x80 >> (x & 7))) g.fillRect(x, y, 1, 1);
      }
    }
    // The copy in the list.
    const small = (this.host.nativeElement as HTMLElement)
      .querySelector(`canvas.scr[data-ref="${ref}"]`) as HTMLCanvasElement | null;
    if (small) {
      small.width = s.w;
      small.height = s.h;
      small.getContext('2d')!.drawImage(c, 0, 0);
    }
    return c;
  }

  private why(e: unknown): string {
    const err = e as HttpErrorResponse;
    return (err?.error?.detail as string) ?? err?.message ?? String(e);
  }
}
