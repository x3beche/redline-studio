import {
  Component, ElementRef, OnDestroy, computed, effect, inject, input, signal,
  untracked, viewChild,
} from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Board3d } from './board3d';
import { T } from '../i18n';

/** A part's view, as the simulator sends it (backend/sim/parts.py). */
interface PartView {
  glow?: number;
  pressed?: boolean;
  position?: number;
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
/** A part as sim.json has it: its model, the MCU pins it is wired to, and
 *  for a bus part its bus and address; `dead` when the board cannot work it. */
interface SimPart {
  ref: string; model: string; pins?: Record<string, string>;
  bus?: string; addr?: number; dead?: string; note?: string;
}
interface SimInfo {
  app: string;
  board: string | null;
  glb: boolean;
  sim: { mcu: { family?: string; emulator?: string }; parts: SimPart[];
         skipped?: { ref: string; why: string }[] } | null;
  models: Record<string, Model>;
  errors: string[];
  warnings: string[];
  snapshot: Snapshot;
}
/** A part ready to draw: sim.json and the model and the live view together. */
interface Row {
  ref: string; model: string; block: string; colour: string; view: PartView;
  pins: string; where: string; title: string;
}

/** Visual turns a second for a fan: the real 30 a second would strobe. */
const RPM_TO_RPS = 1 / 600;

/** `GPIO32 GPIO33 GPIO4` reads `GPIO32/33/4`: the name said once. */
function pinList(pins: Record<string, string> | undefined): string {
  const all = Object.values(pins ?? {});
  const head = all[0]?.match(/^[A-Za-z_]+/)?.[0];
  if (head && all.every(p => p.startsWith(head) && /^\d+$/.test(p.slice(head.length)))) {
    return head + all.map(p => p.slice(head.length)).join('/');
  }
  return all.join(' ');
}

/** `LED2 LED3 LED4` reads `LED2–4` when they run on; otherwise a list. */
function refRange(refs: string[]): string {
  const m = refs.map(r => r.match(/^([A-Za-z_]+)(\d+)$/));
  if (refs.length > 1 && m.every(x => x && x[1] === m[0]![1])) {
    const n = m.map(x => Number(x![2]));
    if (n.every((v, i) => i === 0 || v === n[i - 1] + 1)) return `${refs[0]}–${n[n.length - 1]}`;
  }
  return refs.join(', ');
}

/** The firmware on its virtual board, in the Embedded room.
 *
 *  The board in 3D fills the view with the parts doing what the firmware
 *  makes them do: a LED glows, a display shows its picture, a fan turns,
 *  a button goes down under the pointer. Beside it, one column: the run's
 *  state and its start and stop, the displays large, the parts as a list
 *  to press and turn, and the MCU's serial port. The state comes as
 *  Server-Sent Events (backend/sim/api.py); what is done here goes back
 *  as POSTs. A narrow view puts the column's parts under the board.
 */
@Component({
  selector: 'app-sim-view',
  imports: [Board3d, T],
  styles: [`
    :host { display: block; height: 100%; container-type: inline-size; }
    .sim { display: flex; height: 100%; min-height: 0; font-size: 11px; line-height: 1.45;
           color: var(--ink); background: var(--surface); }
    .mono, .log, .type input { font-family: 'IBM Plex Mono', ui-monospace, monospace; }

    /* The board. */
    .stage { position: relative; flex: 1; min-width: 0; min-height: 0; overflow: hidden; }
    .cams { position: absolute; left: 12px; bottom: 12px; display: flex; gap: 6px; }
    .cams button { height: 24px; padding: 0 10px; font-size: 11px; color: var(--ink); background: var(--surface-2); }
    .hint { position: absolute; right: 12px; bottom: 16px; max-width: calc(100% - 200px); overflow: hidden;
            text-overflow: ellipsis; white-space: nowrap; font-size: 10.5px; color: var(--ink-dim); pointer-events: none; }
    .why { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
           padding: 24px; text-align: center; font-size: 11px; line-height: 1.6; color: var(--ink-dim); }
    .link { display: flex; flex-direction: column; gap: 8px; max-width: 420px; padding: 14px 16px; text-align: left;
      border: 1px solid var(--line); border-radius: 6px; background: var(--surface-2); color: var(--ink); font-size: 11px; }
    .link b { font-size: 14px; font-weight: 600; color: var(--ink-bright); }
    .link span { color: var(--ink-dim); line-height: 1.5; }
    .link .pick { display: flex; gap: 6px; }
    .link select { flex: 1; min-width: 0; }
    .link .hint2 { font-size: 10.5px; }

    /* The column. */
    .side { width: clamp(320px, 34%, 392px); flex-shrink: 0; display: flex; flex-direction: column; min-height: 0;
            border-left: 1px solid var(--line); }
    .top { border-bottom: 1px solid var(--line); }
    .bar { display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 12px; }
    .dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; background: var(--ink-dim); }
    .dot[data-s="running"] { background: var(--ok); }
    .dot[data-s="building"], .dot[data-s="starting"] { background: var(--warn); }
    .dot[data-s="failed"] { background: var(--danger); }
    .state { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; overflow: hidden; white-space: nowrap; }
    .state b { flex-shrink: 0; font-weight: 500; color: var(--ink); }
    .state span { font-size: 10.5px; color: var(--ink-dim); overflow: hidden; text-overflow: ellipsis; }
    .bar button { height: 26px; padding: 0 12px; font-size: 11px; }
    .bar .halt { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 55%, var(--line)); background: transparent; }
    .msg { margin: 0 12px 10px; white-space: pre-wrap; word-break: break-word; max-height: 96px; overflow-y: auto;
           font-size: 10.5px; color: var(--danger); }

    .panel { flex: 0 1 auto; min-height: 0; overflow-x: hidden; overflow-y: auto; }
    section { padding: 12px 12px 12px; border-bottom: 1px solid var(--line); }
    section:last-child { border-bottom: 0; }
    .tcv-label { display: flex; align-items: baseline; gap: 8px; margin: 0 0 8px; }
    .aside { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-transform: none;
             letter-spacing: 0; font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 10.5px; }
    .aside.end { margin-left: auto; }

    /* A display: the glass black whatever the theme - it is the part. */
    .screen + .screen { margin-top: 12px; }
    .bezel { max-width: 380px; padding: 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--pcb-bg); }
    .bezel canvas { display: block; width: 100%; height: auto; image-rendering: pixelated; }

    /* The parts: one line each, the figures in mono, the control at the end. */
    .part { display: flex; align-items: center; gap: 8px; min-height: 30px; border-top: 1px solid var(--line); }
    .ref { width: 64px; flex-shrink: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .kind { width: 52px; flex-shrink: 0; font-size: 10.5px; color: var(--ink-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pins { flex: 1; min-width: 0; font-size: 10.5px; color: var(--ink-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fig { flex-shrink: 0; min-width: 36px; text-align: right; font-size: 10.5px; }
    .ctl { display: flex; gap: 4px; flex-shrink: 0; }
    .ctl button { height: 22px; min-width: 26px; padding: 0 8px; font-size: 10.5px; user-select: none; touch-action: none; }
    .ctl button[data-on] { background: var(--accent-deep); border-color: var(--accent); }
    .meter { flex: 1; min-width: 40px; height: 4px; border-radius: 2px; background: var(--surface-2); overflow: hidden; }
    .meter > span { display: block; height: 100%; border-radius: 2px; background: var(--accent); }
    .lamp { width: 8px; height: 8px; flex-shrink: 0; border-radius: 50%; border: 1px solid var(--line); background: var(--surface-2); }
    .part input[type=range] { flex: 1; min-width: 0; accent-color: var(--accent); }
    .part .dead { font-size: 10.5px; color: var(--warn); }
    .none { margin: 0; color: var(--ink-dim); }
    .more { margin-top: 6px; }
    .more summary { display: flex; align-items: baseline; padding: 6px 0 2px; cursor: pointer; list-style: none; color: var(--ink-dim); }
    .more summary::-webkit-details-marker { display: none; }
    .more summary::before { content: '▸'; margin-right: 5px; }
    .more[open] summary::before { content: '▾'; }
    .more .part { min-height: 24px; color: var(--ink-dim); }
    .more .pins { white-space: nowrap; }

    /* What the board itself gets wrong: one quiet note. */
    .note { margin: 0; padding: 8px 10px; border: 1px solid color-mix(in srgb, var(--warn) 35%, var(--line));
            border-radius: 5px; background: color-mix(in srgb, var(--warn) 7%, transparent);
            color: color-mix(in srgb, var(--warn) 65%, var(--ink)); font-size: 10.5px; line-height: 1.55; }
    .note p { margin: 0; }
    .note p + p { margin-top: 4px; }

    /* The serial port: what is left of the height. */
    .uart { flex: 1 0 170px; min-height: 150px; display: flex; flex-direction: column; border-top: 1px solid var(--line); }
    .uart .tcv-label { margin: 0; padding: 10px 12px 6px; }
    .clear { margin-left: auto; padding: 0; border: 0; background: none; font-size: 10.5px; color: var(--ink-dim);
             text-transform: none; letter-spacing: 0; cursor: pointer; }
    .clear:hover { color: var(--ink); }
    .log { flex: 1; min-height: 0; overflow-x: hidden; overflow-y: auto; margin: 0; padding: 0 12px; white-space: pre-wrap;
           word-break: break-word; font-size: 11px; line-height: 1.55; color: var(--ink-dim); }
    .log .in { color: var(--accent); }
    .log .out { color: var(--ink); }
    .log .err { color: var(--danger); }
    .type { padding: 8px 12px 12px; }
    .type input { display: block; width: 100%; height: 28px; padding: 0 8px; font-size: 11px; background: var(--surface-2); }

    /* Narrow: the state across the top, the board and the column's parts
       side by side under it, and the serial port across the bottom. */
    @container (max-width: 820px) {
      .sim { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 300px);
             grid-template-rows: auto minmax(0, 1fr) minmax(140px, 34%);
             grid-template-areas: "top top" "stage panel" "uart uart"; }
      .side { display: contents; }
      .top { grid-area: top; }
      .stage { grid-area: stage; }
      .panel { grid-area: panel; border-left: 1px solid var(--line); }
      .uart { grid-area: uart; min-height: 0; }
      .hint { display: none; }
    }
    /* Narrower still: one column that scrolls as a whole - four small
       scrolling boxes would show nothing well. */
    @container (max-width: 480px) {
      .sim { display: flex; flex-direction: column; overflow-x: hidden; overflow-y: auto; }
      .sim > *, .side > * { flex-shrink: 0; }
      .top { order: -1; position: sticky; top: 0; z-index: 1; background: var(--surface); }
      .stage { flex: 0 0 260px; border-bottom: 1px solid var(--line); }
      .panel { overflow: visible; border-left: 0; }
      .uart { flex: 0 0 300px; border-top: 1px solid var(--line); }
    }
  `],
  template: `
<div class="sim">
  <div class="stage">
    @if (glbUrl(); as url) {
      <app-board-3d [src]="url" />
      <div class="cams">
        <button class="tcv-btn" (click)="look('fit')">{{ 'Fit' | t }}</button>
        <button class="tcv-btn" (click)="look('top')">{{ 'Top' | t }}</button>
        <button class="tcv-btn" (click)="look('front')">{{ 'Front' | t }}</button>
      </div>
      @if (hasButtons()) {
        <span class="hint mono">{{ 'click a button on the board to press it' | t }}</span>
      }
    } @else {
      <div class="why">
        @if (!info()) { {{ 'reading the board…' | t }} }
        @else if (!info()!.board) {
          <!-- No board yet: pick it here. The parts come from its netlist. -->
          <div class="link">
            <b>{{ 'This firmware is not linked to a board yet.' | t }}</b>
            <span>{{ 'Which board does it run on? The simulator finds its parts from that board.' | t }}</span>
            <div class="pick">
              <select class="tcv-field px-1.5 py-1" #pick>
                @for (b of boards(); track b.id) {
                  <option [value]="b.id">{{ b.title }}{{ b.users.length ? ' - ' + b.users.join(', ') : '' }}</option>
                }
              </select>
              <button class="tcv-btn tcv-btn-accent px-2" [disabled]="busy() || !boards().length"
                      (click)="linkTo(pick.value)">{{ 'Link' | t }}</button>
            </div>
            @if (someTaken()) {
              <span class="hint2">{{ 'A board that already runs another firmware is usually the right one only if that firmware is this one under another name.' | t }}</span>
            }
          </div>
        } @else {
          {{ 'This board has no 3D model yet. Lay it out in the PCB room (the placed board is exported as board.glb) and it shows here; the parts still run in the list.' | t }}
        }
      </div>
    }
  </div>

  <aside class="side">
    <!-- The run: its state, and the one thing to do next. -->
    <div class="top">
      <div class="bar">
        <span class="dot" [attr.data-s]="snap().state"></span>
        <span class="state mono" [title]="stateLine()">
          <b>{{ stateWord() | t }}</b>
          @if (stateFigures().length) { <span>{{ stateFigures().join(' · ') }}</span> }
        </span>
        @if (live()) {
          <button class="tcv-btn" (click)="post('reset')" [disabled]="busy()">{{ 'Reset' | t }}</button>
          <button class="tcv-btn halt" (click)="stop()" [disabled]="busy()">{{ 'Stop' | t }}</button>
        } @else {
          <button class="tcv-btn tcv-btn-accent" (click)="post('start')"
                  [disabled]="busy() || !runnable()">{{ 'Start' | t }}</button>
        }
      </div>
      @if (problems().length) { <div class="msg">{{ problems().join('\\n') }}</div> }
    </div>

    <div class="panel">
      <!-- The displays, large: the picture is the point of them. -->
      @if (screens().length) {
        <section>
          @for (s of screens(); track s.ref) {
            <div class="screen">
              <h3 class="tcv-label" [title]="s.title">
                <span>{{ s.ref }}</span>
                <span class="aside">{{ s.view.screen ? s.view.screen.w + '×' + s.view.screen.h : s.model }}@if (s.where) { · {{ s.where }} }</span>
              </h3>
              <div class="bezel">
                <canvas class="scr" [attr.data-ref]="s.ref" width="128" height="64"
                        [style.aspect-ratio]="s.view.screen ? s.view.screen.w + '/' + s.view.screen.h : '2/1'"></canvas>
              </div>
            </div>
          }
        </section>
      }

      @if (info()?.sim) {
      <section>
        <h3 class="tcv-label"><span>{{ 'Parts' | t }}</span></h3>
        @for (p of rows(); track p.ref) {
          <div class="part" [attr.data-ref]="p.ref" [title]="p.title">
            <span class="ref mono">{{ p.ref }}</span>
            <span class="kind">{{ p.model }}</span>
            @switch (p.block) {
              @case ('light') {
                <span class="pins mono">{{ p.pins }}</span>
                <span class="lamp" [style.background]="(p.view.glow ?? 0) > 0.02 ? p.colour : null"
                      [style.opacity]="(p.view.glow ?? 0) > 0.02 ? 0.35 + 0.65 * (p.view.glow ?? 0) : null"
                      [style.box-shadow]="(p.view.glow ?? 0) > 0.02 ? '0 0 ' + (2 + 6 * (p.view.glow ?? 0)) + 'px ' + p.colour : null"></span>
                <span class="fig mono">{{ pct(p.view.glow) }}</span>
              }
              @case ('press') {
                <span class="pins mono">{{ p.pins }}</span>
                <span class="ctl">
                  <button class="tcv-btn" [attr.data-on]="p.view.pressed ? 1 : null" [disabled]="!live()"
                          (pointerdown)="press(p.ref, true)" (pointerup)="press(p.ref, false)"
                          (pointerleave)="p.view.pressed && press(p.ref, false)">{{ 'Press' | t }}</button>
                </span>
              }
              @case ('quad') {
                <span class="pins mono">{{ p.pins }}</span>
                <span class="ctl">
                  <button class="tcv-btn" [disabled]="!live()" (click)="turn(p.ref, -1)"
                          [attr.aria-label]="'Turn left' | t" [title]="'Turn left' | t">◀</button>
                  <button class="tcv-btn" [disabled]="!live()" (click)="turn(p.ref, 1)"
                          [attr.aria-label]="'Turn right' | t" [title]="'Turn right' | t">▶</button>
                  <button class="tcv-btn" [attr.data-on]="p.view.pressed ? 1 : null" [disabled]="!live()"
                          (pointerdown)="press(p.ref, true)" (pointerup)="press(p.ref, false)"
                          (pointerleave)="p.view.pressed && press(p.ref, false)">{{ 'Push' | t }}</button>
                </span>
              }
              @case ('motor') {
                <span class="meter"><span [style.width.%]="(p.view.duty ?? 0) * 100"></span></span>
                <span class="fig mono" style="min-width: 64px">{{ p.view.rpm ?? 0 }} rpm</span>
              }
              @case ('level') {
                <input type="range" [min]="p.view.min ?? 0" [max]="p.view.max ?? 1"
                       [step]="((p.view.max ?? 1) - (p.view.min ?? 0)) / 100"
                       [value]="p.view.value ?? 0" [disabled]="!live()"
                       (input)="set(p.ref, 'value', $any($event.target).value)">
                <span class="fig mono">{{ p.view.value ?? 0 }}{{ p.view.unit }}</span>
              }
              @case ('regs') {
                @for (s of sliders(p.view); track s.key) {
                  <input type="range" [min]="s.min" [max]="s.max" [step]="(s.max - s.min) / 100"
                         [value]="s.value" [disabled]="!live()" [title]="s.key"
                         (input)="set(p.ref, s.key, $any($event.target).value)">
                  <span class="fig mono">{{ s.value }}{{ s.unit }}</span>
                }
              }
              @case ('dead') {
                <span class="pins mono">{{ p.pins }}</span>
                <span class="dead">{{ "can't light" | t }}</span>
              }
              @default {
                <span class="pins mono">{{ p.where || p.pins }}</span>
              }
            }
          </div>
        } @empty {
          @if (info()?.sim && !screens().length) { <p class="none">{{ 'no part on this board has a model' | t }}</p> }
        }
        @if (info()?.sim?.skipped?.length) {
          <!-- What is not simulated, folded: a board is mostly passives. -->
          <details class="more">
            <summary>{{ info()!.sim!.skipped!.length }} {{ 'parts not simulated' | t }}</summary>
            @for (s of info()?.sim?.skipped ?? []; track $index) {
              <div class="part" [title]="s.why">
                <span class="ref mono">{{ s.ref }}</span><span class="pins">{{ s.why }}</span>
              </div>
            }
          </details>
        }
      </section>
      }

      @if (notes().length) {
        <section>
          <div class="note">@for (n of notes(); track $index) { <p>{{ n }}</p> }</div>
        </section>
      }
    </div>

    <!-- The MCU's serial port. -->
    <div class="uart">
      <h3 class="tcv-label">
        <span>{{ console() }}</span>
        <button class="clear" (click)="clear()" [disabled]="!uart().length">{{ 'clear' | t }}</button>
      </h3>
      <pre #log class="log">@for (l of uart(); track $index) {<span [class]="l.cls">{{ l.text }}</span>}</pre>
      <div class="type">
        <input #line class="tcv-field cmd" [placeholder]="'type a command, Enter sends' | t"
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
  /** The end of the transcript when the console was cleared; the run's own stays whole. */
  private clearedAt = signal<string | null>(null);
  private events?: EventSource;
  private screens_ = new Map<string, HTMLCanvasElement>();

  live = computed(() => ['starting', 'building', 'running'].includes(this.snap().state));
  runnable = computed(() => !!this.info()?.sim);
  glbUrl = computed(() => {
    const i = this.info();
    return i?.board && i.glb ? `/api/boards/${i.board}/board.glb` : null;
  });

  problems = computed(() => {
    // Not linked yet: the picker says it, not an error.
    const out = this.info() && !this.info()!.board ? [] : [...(this.info()?.errors ?? [])];
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

  /** The state in a word, then its figures: time, emulator, board. */
  stateWord = computed(() => {
    const s = this.snap().state;
    return s === 'idle' ? 'not running' : s === 'building' ? 'building' : s === 'starting' ? 'starting' : s;
  });
  stateFigures = computed(() => {
    const s = this.snap();
    const i = this.info();
    const out: string[] = [];
    if (s.state === 'running') out.push(`${(s.t / 1e6).toFixed(1)} s`);
    if (i?.sim?.mcu?.emulator && s.state !== 'idle') out.push(i.sim.mcu.emulator);
    if (i?.board) out.push(i.board);
    return out;
  });

  /** The parts, in sim.json's order, with what the model says about drawing them. */
  parts = computed<Row[]>(() => {
    const i = this.info();
    const views = this.snap().parts;
    return (i?.sim?.parts ?? []).map(p => {
      const m = i!.models[p.ref];
      const pins = pinList(p.pins);
      const where = p.bus ? `${p.bus}${p.addr != null ? ' 0x' + p.addr.toString(16).toUpperCase().padStart(2, '0') : ''}` : '';
      const wiring = Object.entries(p.pins ?? {}).map(([r, pin]) => `${r} → ${pin}`).join('\n');
      return { ref: p.ref, model: p.model, block: p.dead ? 'dead' : m?.block ?? 'code',
               colour: m?.view?.['glow'] ?? 'var(--accent)', view: views[p.ref] ?? {}, pins, where,
               title: [p.ref + ' · ' + p.model, wiring, p.note ?? '', p.dead ?? ''].filter(Boolean).join('\n') };
    });
  });

  /** The displays: whatever draws a picture, or is a screen by its model. */
  screens = computed(() => this.parts().filter(p =>
    p.block !== 'dead' && (p.view.screen || this.info()?.models[p.ref]?.view?.['kind'] === 'screen')));

  /** The list: every other part, and the dead ones of a model folded into one line. */
  rows = computed<Row[]>(() => {
    const shown = new Set(this.screens().map(s => s.ref));
    const out: Row[] = [];
    const dead = new Map<string, Row[]>();
    for (const p of this.parts()) {
      if (shown.has(p.ref)) continue;
      if (p.block !== 'dead') { out.push(p); continue; }
      if (!dead.has(p.model)) dead.set(p.model, []);
      dead.get(p.model)!.push(p);
    }
    for (const [model, ps] of dead) {
      out.push({ ...ps[0], ref: refRange(ps.map(p => p.ref)), model,
                 pins: ps.length > 1 ? '' : ps[0].pins, title: ps.map(p => p.title).join('\n\n') });
    }
    return out;
  });

  /** What the board gets wrong, said once: the parts that cannot work, then the warnings. */
  notes = computed(() => {
    const byWhy = new Map<string, string[]>();
    for (const p of this.info()?.sim?.parts ?? []) {
      if (!p.dead) continue;
      if (!byWhy.has(p.dead)) byWhy.set(p.dead, []);
      byWhy.get(p.dead)!.push(p.ref);
    }
    const out = [...byWhy].map(([why, refs]) => `${refs.join(', ')}: ${why}.`);
    return [...out, ...(this.info()?.warnings ?? [])];
  });

  hasButtons = computed(() => Object.values(this.info()?.models ?? {}).some(m => m.block === 'press'));

  /** The lines since the console was cleared. The server joins a run of
   *  output into one entry and keeps only the tail, so what was on screen
   *  is found again by its last characters; gone (a new run), all shows. */
  private shownUart = computed(() => {
    const all = this.snap().uart;
    const tail = this.clearedAt();
    if (!tail) return all;
    const cut0 = SimView.flat(all).lastIndexOf(tail);
    if (cut0 < 0) return all;
    const cut = cut0 + tail.length;
    const out: UartLine[] = [];
    let off = 0;
    for (const e of all) {
      const head = SimView.mark(e).length;
      const end = off + head + e.data.length;
      if (end > cut) out.push({ ...e, data: e.data.slice(Math.max(0, cut - off - head)) });
      off = end;
    }
    return out.filter(e => e.data);
  });
  /** The console: the port the firmware writes to (an ESP32's UART0, an
   *  STM32F0's USART1), so what is typed reaches the same port. */
  console = computed(() => this.snap().uart.find(l => l.dir === 'out')?.port ?? 'UART0');
  private static mark(e: UartLine) { return `\u0001${e.port}${e.dir}\u0002`; }
  private static flat(lines: UartLine[]) { return lines.map(e => SimView.mark(e) + e.data).join(''); }

  /** The transcript with the terminal's colour codes taken out, a line at
   *  a time: what was typed, the SDK's own log lines (quiet; an error in
   *  red), and what the firmware says. */
  uart = computed(() => {
    const out: { cls: string; text: string }[] = [];
    for (const l of this.shownUart()) {
      const text = l.data.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '');
      if (l.dir === 'in') { out.push({ cls: 'in', text: '› ' + text }); continue; }
      for (const line of text.split(/(?<=\n)/)) {
        const lvl = line.match(/^([EWIDV]) \(\d+\)/)?.[1];
        out.push({ cls: lvl === 'E' ? 'err' : lvl ? 'sys' : 'out', text: line });
      }
    }
    return out;
  });

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
    // The displays in the column follow too, board or no board. After the
    // render, so a canvas that has just appeared is drawn at once.
    effect(() => {
      const snap = this.snap();
      const i = this.info();
      this.screens();
      if (i) queueMicrotask(() => this.paintScreens(i, snap));
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
    this.clearedAt.set(null);
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

  /** The boards to pick from, and which firmware already runs on each. */
  boards = signal<{ id: string; title: string; users: string[] }[]>([]);
  someTaken = computed(() => this.boards().some(b => b.users.length > 0));
  private loadBoards = effect(() => {
    const i = this.info();
    if (!i || i.board) return;
    untracked(() => this.http.get<{ _id?: string; id?: string; title?: string }[]>('/api/boards').subscribe(list =>
      this.http.get<{ _id?: string; id?: string; title?: string; board?: string | null; platform?: string }[]>('/api/apps')
        .subscribe({
          next: apps => this.boards.set(list.map(b => {
            const id = (b._id ?? b.id)!;
            return { id, title: b.title || id,
                     users: apps.filter(a => a.board === id).map(a => a.title || (a._id ?? a.id)!) };
          })),
          error: () => this.boards.set(list.map(b => ({ id: (b._id ?? b.id)!, title: b.title || (b._id ?? b.id)!, users: [] }))),
        })));
  });

  linkTo(board: string) {
    if (!board) return;
    this.busy.set(true);
    this.note.set('');
    this.http.post(`/api/sim/${encodeURIComponent(this.app())}/link`, { board }).subscribe({
      next: () => { this.busy.set(false); this.reload(); },
      error: e => { this.busy.set(false); this.note.set(this.why(e)); },
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

  look(side: 'fit' | 'top' | 'front') {
    this.board()?.look(side);
  }

  press(ref: string, down: boolean) {
    this.act(ref, { press: down });
  }

  /** An encoder, `n` detents: positive clockwise. */
  turn(ref: string, n: number) {
    this.act(ref, { turn: n });
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
    this.http.post(`/api/sim/${encodeURIComponent(this.app())}/uart`, { port: this.console(), data: text + '\r\n' })
      .subscribe({ error: e => this.note.set(this.why(e)) });
  }

  clear() {
    const all = SimView.flat(this.snap().uart);
    this.clearedAt.set(all ? all.slice(-300) : null);
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
      if (v.screen) b.face(ref, this.screen(ref, v.screen, m.view['pixel']),
                             m.view['module'] as unknown as Parameters<Board3d['face']>[2]);
    }
    b.pickable(buttons, (ref, down) => this.press(ref, down));
  }

  /** The displays' pictures into the column's canvases, each only when it changed. */
  private paintScreens(i: SimInfo, snap: Snapshot) {
    const root = this.host.nativeElement as HTMLElement;
    for (const [ref, v] of Object.entries(snap.parts)) {
      if (!v.screen) continue;
      const big = root.querySelector(`canvas.scr[data-ref="${ref}"]`) as HTMLCanvasElement | null;
      if (!big || big.dataset['bits'] === v.screen.bits) continue;
      const src = this.screen(ref, v.screen, i.models[ref]?.view?.['pixel']);
      big.dataset['bits'] = v.screen.bits;
      big.width = v.screen.w;
      big.height = v.screen.h;
      big.getContext('2d')!.drawImage(src, 0, 0);
    }
  }

  /** A display's frame buffer (rows MSB first, base64) drawn into a canvas:
   *  the 3D texture, and what the column's picture is copied from. */
  private screen(ref: string, s: { w: number; h: number; bits: string }, pixel?: string): HTMLCanvasElement {
    let c = this.screens_.get(ref);
    if (c && c.dataset['bits'] === s.bits) return c;
    if (!c) {
      c = document.createElement('canvas');
      this.screens_.set(ref, c);
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
    return c;
  }

  private why(e: unknown): string {
    const err = e as HttpErrorResponse;
    return (err?.error?.detail as string) ?? err?.message ?? String(e);
  }
}
