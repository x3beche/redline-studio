import {
  Component, ElementRef, OnDestroy, computed, effect, inject, input, signal, untracked, viewChild,
} from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { AppEntry } from '../api';
import { T, t } from '../i18n';

/** A port as backend/embedded/device.py lists it: a tty on USB, or an SWD probe. */
interface Port {
  id: string; kind: 'serial' | 'probe'; path: string | null; name: string; usb: string | null;
  vendor: string | null; product: string | null; by_id: string | null; for: 'esp32' | 'stm32' | null;
  access: boolean;
}
interface Image {
  name: string; elf: string; at: string | null; target: 'esp32' | 'stm32';
  chip: string | null; flash_size: string | null; bytes: number | null;
}
/** What the linked board's netlist says about programming it. */
interface BoardNote {
  board: string; title: string | null; usb: string | null;
  auto: { en: string; io0: string; en_net: string; io0_net: string; bridge: string | null; lines: string[] } | null;
}
interface FlashJob {
  id: string; port: string; erase: boolean; target: string; state: 'running' | 'done' | 'failed';
  pct: number | null; stage: string | null; started: string; ended: string | null; rc: number | null;
  n: number; lines: string[];
}
interface SimUart { state: string; started: number | null; uart: { t: number; port: string; dir: 'in' | 'out'; data: string }[] }
interface DeviceInfo {
  target: 'esp32' | 'stm32'; ports: Port[]; image: Image | null; board: BoardNote | null;
  flash: FlashJob | null; flashed: { at: string; ok: boolean; port: string | null } | null;
  sim: SimUart | null; bauds: number[];
}
interface Line { n: number; t: number; dir: 'rx' | 'tx' | 'sim-rx' | 'sim-tx'; text: string }
type MonState = 'closed' | 'connecting' | 'opening' | 'open' | 'paused' | 'error';

const BAUDS = [9600, 19200, 38400, 57600, 74880, 115200, 230400, 460800, 921600];
const KEEP = 5000;
const STAGES: Record<string, string> = {
  connecting: 'connecting', erasing: 'erasing', writing: 'writing', verifying: 'verifying', resetting: 'resetting',
};

function store(key: string, value?: string): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { /* private window */ }
  return null;
}

/** The Embedded room's view of a real board: its port, flashing it, its serial monitor. Lives in the room frame's view
 *  area (rooms/coding.ts), like the 3D and PCB rooms' views.
 *
 *  Three columns: the board and the ports seen on the left, the serial monitor in the middle, flashing on the right.
 *  Ports are polled; the monitor is Server-Sent Events from one reader per port shared by every viewer; a flash is a
 *  job whose lines are polled while it runs (backend/embedded/device.py). Until a board's port is open, the monitor
 *  shows the last simulation's serial transcript, and says so. */
@Component({
  selector: 'app-fw-device',
  imports: [T],
  host: { class: 'block h-full w-full' },
  styles: [`
    :host { container-type: inline-size; }
    .dev { display: flex; height: 100%; min-height: 0; font-size: 11px; line-height: 1.45;
           color: var(--ink); background: var(--surface); }
    .mono { font-family: 'IBM Plex Mono', ui-monospace, monospace; }
    .col { display: flex; flex-direction: column; min-height: 0; overflow-x: hidden; overflow-y: auto; }
    .left { width: clamp(240px, 24%, 300px); flex-shrink: 0; border-right: 1px solid var(--line); }
    .right { width: clamp(240px, 23%, 290px); flex-shrink: 0; border-left: 1px solid var(--line); }
    section { padding: 10px 10px 11px; border-bottom: 1px solid var(--line); }
    section:last-child { border-bottom: 0; }
    .tcv-label { display: flex; align-items: baseline; gap: 8px; margin: 0 0 7px; font-weight: 400; }
    .aside { margin-left: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
             text-transform: none; letter-spacing: 0; font-family: 'IBM Plex Mono', ui-monospace, monospace;
             font-size: 10.5px; }
    .dim { color: var(--ink-dim); }
    .empty { margin: 0; color: var(--ink-dim); font-size: 11px; }

    /* The board: a name, then what to do or what it is. */
    .name { display: flex; align-items: baseline; gap: 8px; min-width: 0; margin-bottom: 7px; }
    .name b { font-size: 14px; font-weight: 600; color: var(--ink-bright); white-space: nowrap;
              overflow: hidden; text-overflow: ellipsis; }
    .name span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
                 font-size: 10.5px; color: var(--ink-dim); }
    .say { margin: 0; color: var(--ink-dim); line-height: 1.55; }
    .say + .say { margin-top: 6px; }
    .say b { font-weight: 500; color: var(--ink); font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 10.5px; }
    .tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 8px; }
    .tiles > div { display: flex; flex-direction: column; min-width: 0; padding: 6px 8px;
                   border: 1px solid var(--line); border-radius: 5px; background: var(--surface-2); }
    .tiles span { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--ink-dim); }
    .tiles b { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 14px; font-weight: 600;
               color: var(--ink-bright); line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tiles em { min-height: 14px; font-style: normal; font-size: 10px; color: var(--ink-dim);
                overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* A port seen: one line, picked like a radio. */
    .port { display: grid; grid-template-columns: 12px minmax(0, 1fr) auto; column-gap: 8px; align-items: baseline;
            width: 100%; padding: 5px 0; border: 0; border-top: 1px solid var(--line); background: none;
            color: var(--ink); text-align: left; font: inherit; cursor: pointer; }
    .port:hover .pn { color: var(--ink-bright); }
    .port .r { width: 8px; height: 8px; border-radius: 50%; border: 1px solid var(--ink-dim); align-self: center; }
    .port[data-on] .r { border-color: var(--accent); background: var(--accent); }
    .port .pn { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .port .pv { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 10.5px; color: var(--ink-dim); }
    .port .pd { grid-column: 2 / -1; font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 10px;
                color: var(--ink-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* The monitor: a bar, the lines, the input. */
    .mid { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
    .bar { display: flex; align-items: center; gap: 8px; min-height: 40px; padding: 0 10px;
           border-bottom: 1px solid var(--line); flex-wrap: wrap; row-gap: 4px; }
    .bar .tcv-label { margin: 0; }
    .dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; border: 1px solid var(--ink-dim); }
    .dot[data-s="open"] { border-color: var(--ok); background: var(--ok); }
    .dot[data-s="paused"], .dot[data-s="opening"], .dot[data-s="connecting"] { border-color: var(--warn); background: var(--warn); }
    .dot[data-s="error"] { border-color: var(--danger); background: var(--danger); }
    .fig { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 10.5px; color: var(--ink-dim);
           white-space: nowrap; }
    .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
            font-size: 10.5px; color: var(--ink-dim); }
    .bar select { height: 22px; padding: 0 4px; font-size: 10.5px; font-family: 'IBM Plex Mono', ui-monospace, monospace; }
    .bar .tcv-btn { height: 22px; padding: 0 8px; font-size: 10.5px; }
    .bar label { display: flex; align-items: center; gap: 4px; font-size: 10.5px; color: var(--ink-dim); cursor: pointer; white-space: nowrap; }
    .log { position: relative; flex: 1; min-height: 0; overflow-x: hidden; overflow-y: auto; margin: 0;
           padding: 8px 10px; background: var(--preview-bg); font-family: 'IBM Plex Mono', ui-monospace, monospace;
           font-size: 11px; line-height: 17px; white-space: pre-wrap; word-break: break-all; color: var(--ink); }
    .log .ln { display: block; min-height: 17px; }
    .log .ts { color: var(--ink-dim); margin-right: 8px; user-select: none; }
    .log .tx { color: var(--accent); }
    .log .sim-rx, .log .sim-tx { color: var(--ink-dim); }
    .log .sim-tx { font-style: italic; }
    .log .sys { color: var(--ink-dim); font-style: italic; }
    .log .quiet { color: var(--ink-dim); white-space: normal; font-family: 'IBM Plex Sans', system-ui, sans-serif; }
    .follow { position: sticky; bottom: 0; float: right; height: 22px; padding: 0 8px; font-size: 10.5px; }
    .type { display: flex; gap: 6px; padding: 8px 10px; border-top: 1px solid var(--line); }
    .type input { flex: 1; min-width: 0; height: 26px; padding: 0 8px; font-size: 11px;
                  font-family: 'IBM Plex Mono', ui-monospace, monospace; }
    .type select { height: 26px; padding: 0 4px; font-size: 10.5px; font-family: 'IBM Plex Mono', ui-monospace, monospace; }

    /* Flashing. */
    .kv { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; min-width: 0; padding: 3px 0;
          border-top: 1px solid var(--line); }
    .kv:first-of-type { border-top: 0; }
    .kv .n { color: var(--ink-dim); flex-shrink: 0; }
    .kv .v { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
             font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 10.5px; }
    .go { width: 100%; height: 30px; margin-top: 10px; font-size: 11px; }
    .opt { display: flex; align-items: center; gap: 6px; margin-top: 6px; color: var(--ink-dim); cursor: pointer; }
    .opt input { margin: 0; accent-color: var(--accent); }
    .prog { display: grid; grid-template-columns: minmax(0, 1fr) 38px; column-gap: 8px; row-gap: 3px; align-items: baseline; }
    .prog .bar2 { grid-column: 1 / -1; height: 4px; border-radius: 2px; overflow: hidden; background: var(--surface-2); }
    .prog .bar2 i { display: block; height: 100%; min-width: 2px; border-radius: 2px; background: var(--accent); transition: width .2s; }
    .prog .bar2 i[data-s="failed"] { background: var(--danger); }
    .prog .p { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 10.5px; text-align: right; }
    .flog { margin: 8px 0 0; max-height: 220px; overflow-x: hidden; overflow-y: auto; padding: 6px 8px;
            border: 1px solid var(--line); border-radius: 5px; background: var(--surface-2);
            font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 10px; line-height: 1.5;
            white-space: pre-wrap; word-break: break-all; color: var(--ink-dim); }
    .bad { color: var(--danger); }
    .good { color: var(--ok); }

    /* Narrow: the monitor across the top, the board and flashing side by side under it; narrower still, one column. */
    @container (max-width: 860px) {
      .dev { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-content: start;
             overflow-x: hidden; overflow-y: auto; }
      .mid { grid-column: 1 / -1; grid-row: 1; height: clamp(200px, 36vh, 380px); border-bottom: 1px solid var(--line); }
      .left, .right { width: auto; overflow: visible; }
      .left { border-right: 1px solid var(--line); }
      .right { border-left: 0; }
    }
    @container (max-width: 480px) {
      .dev { grid-template-columns: minmax(0, 1fr); }
      .left { border-right: 0; border-bottom: 1px solid var(--line); }
    }
  `],
  template: `
<div class="dev">
  <!-- THE BOARD, AND THE PORTS SEEN -->
  <aside class="col left">
    <section>
      <h3 class="tcv-label">{{ 'Board' | t }}</h3>
      @if (!info()) {
        <p class="empty">{{ 'looking for ports…' | t }}</p>
      } @else if (chosen(); as p) {
        <div class="name"><b>{{ boardTitle() }}</b><span>{{ p.kind === 'probe' ? ('probe' | t) : ('serial port' | t) }}</span></div>
        <div class="tiles">
          <div [title]="p.by_id || p.id"><span>{{ 'Port' | t }}</span><b>{{ short(p.id) }}</b><em>{{ p.by_id || p.product || '' }}</em></div>
          <div [title]="(p.vendor || '') + ' ' + (p.usb || '')"><span>{{ p.kind === 'probe' ? ('Probe' | t) : ('Bridge' | t) }}</span>
            <b>{{ p.name }}</b><em>{{ p.usb || '' }}</em></div>
        </div>
        @if (autoNote()) { <p class="say">{{ autoNote() }}</p> }
        @if (!p.access && p.kind === 'serial') {
          <p class="say">{{ 'This port is not yours to open on this machine; the monitor reads it in the Embedded container.' | t }}</p>
        }
      } @else {
        <div class="name"><b>{{ waitingTitle() }}</b></div>
        <p class="say">{{ plugHint() }}</p>
        @if (autoNote()) { <p class="say">{{ autoNote() }}</p> }
        @if (ports().length) { <p class="say">{{ 'Pick its port below.' | t }}</p> }
      }
    </section>
    <section>
      <h3 class="tcv-label">{{ 'Ports seen' | t }} @if (ports().length) { <span class="aside">{{ ports().length }}</span> }</h3>
      @for (p of ports(); track p.id) {
        <button class="port" [attr.data-on]="p.id === portId() ? 1 : null" (click)="pick(p.id)"
                [title]="(p.vendor ? p.vendor + ' · ' : '') + (p.product || p.name) + (p.by_id ? '\\n' + p.by_id : '')">
          <span class="r"></span>
          <span class="pn">{{ p.name }}</span>
          <span class="pv">{{ p.usb || '' }}</span>
          <span class="pd">{{ p.kind === 'probe' ? ('SWD probe' | t) + ' · ' + p.id : p.id }}</span>
        </button>
      } @empty {
        <p class="empty mono">{{ 'none yet' | t }}</p>
      }
    </section>
  </aside>

  <!-- THE SERIAL MONITOR -->
  <div class="mid">
    <div class="bar">
      <h3 class="tcv-label">{{ 'Serial monitor' | t }}</h3>
      <span class="dot" [attr.data-s]="live() ? mon() : 'closed'"></span>
      <span class="grow" [title]="monNote()">{{ monNote() }}</span>
      <select class="tcv-field" [value]="baud()" (change)="setBaud(+$any($event.target).value)" [attr.aria-label]="'Baud rate' | t"
              [title]="'Baud rate' | t">
        @for (b of bauds; track b) { <option [value]="b" [selected]="b === baud()">{{ b }}</option> }
      </select>
      <span class="fig">8N1</span>
      <label><input type="checkbox" [checked]="stamps()" (change)="setStamps($any($event.target).checked)"> {{ 'time' | t }}</label>
      <button class="tcv-btn" (click)="clear()">{{ 'Clear' | t }}</button>
      @if (serialPort()) {
        @if (live()) {
          <button class="tcv-btn" (click)="disconnect()">{{ 'Close' | t }}</button>
        } @else {
          <button class="tcv-btn" (click)="connect()">{{ 'Open' | t }}</button>
        }
      }
    </div>
    <pre class="log" #log (scroll)="scrolled()">@if (showing() === 'none') {<span class="quiet">{{ emptyLog() }}</span>}@for (l of shownLines(); track l.n) {<span class="ln" [class]="'ln ' + l.dir">@if (stamps()) {<span class="ts">{{ clock(l.t) }}</span>}@if (l.dir === 'tx' || l.dir === 'sim-tx') {&gt; }{{ l.text }}</span>}@if (!stick() && shownLines().length) {<button class="tcv-btn follow" (click)="follow()">↓ {{ 'follow' | t }}</button>}</pre>
    <div class="type">
      <input class="tcv-field" #box [disabled]="!canType()" (keydown)="key($event, box)"
             [placeholder]="canType() ? ('type a line, Enter sends' | t) : (live() ? (monNote()) : ('open a board\\'s port to type to it' | t))">
      <select class="tcv-field" [value]="eol()" (change)="setEol($any($event.target).value)" [title]="'Line ending' | t"
              [attr.aria-label]="'Line ending' | t">
        <option value="crlf" [selected]="eol() === 'crlf'">CR LF</option>
        <option value="lf" [selected]="eol() === 'lf'">LF</option>
        <option value="cr" [selected]="eol() === 'cr'">CR</option>
        <option value="none" [selected]="eol() === 'none'">{{ 'none' | t }}</option>
      </select>
    </div>
  </div>

  <!-- FLASHING -->
  <aside class="col right">
    <section>
      <h3 class="tcv-label">{{ 'Flash' | t }}</h3>
      @if (image(); as im) {
        <div class="kv"><span class="n">{{ 'Image' | t }}</span><span class="v" [title]="im.elf">{{ im.name }}</span></div>
        <div class="kv"><span class="n">{{ 'Built' | t }}</span><span class="v" [title]="im.at || ''">{{ when(im.at) }}</span></div>
        <div class="kv"><span class="n">{{ 'Target' | t }}</span><span class="v">{{ targetLine(im) }}</span></div>
        @if (im.bytes) { <div class="kv"><span class="n">{{ 'Size' | t }}</span><span class="v">{{ kb(im.bytes) }}</span></div> }
      } @else {
        <p class="empty">{{ 'Nothing built yet. Build the firmware first; its image is what goes on the board.' | t }}</p>
      }
      <button class="tcv-btn tcv-btn-accent go" [disabled]="!canFlash()" (click)="flash()" [title]="flashWhy()">
        {{ flashLabel() }}
      </button>
      <label class="opt"><input type="checkbox" [checked]="monAfter()" (change)="setMonAfter($any($event.target).checked)">
        {{ 'Open the monitor after flashing' | t }}</label>
      <label class="opt"><input type="checkbox" [checked]="erase()" (change)="erase.set($any($event.target).checked)">
        {{ 'Erase the whole flash first' | t }}</label>
      @if (flashErr()) { <p class="empty bad" style="margin-top: 8px">{{ flashErr() }}</p> }
    </section>
    @if (job(); as j) {
      <section>
        <h3 class="tcv-label">{{ j.state === 'running' ? ('Flashing' | t) : ('Last flash' | t) }}
          <span class="aside">{{ short(j.port) }}</span></h3>
        <div class="prog">
          <span [class]="j.state === 'failed' ? 'bad' : j.state === 'done' ? 'good' : ''">{{ jobWord(j) }}</span>
          <span class="p">{{ j.pct != null ? j.pct + '%' : '' }}</span>
          <span class="bar2"><i [attr.data-s]="j.state" [style.width.%]="j.pct ?? (j.state === 'running' ? 3 : 100)"></i></span>
        </div>
        <pre class="flog" #flog>{{ j.lines.slice(-80).join('\\n') }}</pre>
      </section>
    } @else if (info()?.flashed; as f) {
      <section>
        <h3 class="tcv-label">{{ 'Last flash' | t }}</h3>
        <div class="kv"><span class="n">{{ when(f.at) }}</span>
          <span class="v" [class]="f.ok ? 'v good' : 'v bad'">{{ f.ok ? ('done' | t) : ('failed' | t) }}{{ f.port ? ' · ' + short(f.port) : '' }}</span></div>
      </section>
    }
  </aside>
</div>
  `,
})
export class FwDevice implements OnDestroy {
  app = input.required<AppEntry>();
  private http = inject(HttpClient);
  private logEl = viewChild<ElementRef<HTMLElement>>('log');
  private flogEl = viewChild<ElementRef<HTMLElement>>('flog');

  info = signal<DeviceInfo | null>(null);
  ports = signal<Port[]>([]);
  portId = signal<string | null>(null);
  baud = signal(115200);
  readonly bauds = BAUDS;
  stamps = signal(store('x3.dev.stamps') === '1');
  eol = signal<'crlf' | 'lf' | 'cr' | 'none'>((store('x3.dev.eol') as any) || 'crlf');
  monAfter = signal(store('x3.dev.monAfter') !== '0');
  erase = signal(false);

  lines = signal<Line[]>([]);
  mon = signal<MonState>('closed');
  monWhy = signal<string | null>(null);
  monWhere = signal<string | null>(null);
  wanted = signal(true);                     // the person has not closed the monitor
  stick = signal(true);
  job = signal<FlashJob | null>(null);
  flashErr = signal<string | null>(null);
  private sent: string[] = [];
  private histAt = -1;
  private es?: EventSource;
  private pollPorts?: ReturnType<typeof setInterval>;
  private pollJob?: ReturnType<typeof setTimeout>;
  private cleared = 0;

  constructor() {
    // A new app: read what there is, pick up where its last port and baud were.
    effect(() => {
      const id = this.app()._id;
      untracked(() => {
        this.disconnect(false);
        this.info.set(null);
        this.job.set(null);
        this.lines.set([]);
        this.cleared = 0;
        this.portId.set(store(`x3.dev.port.${id}`));
        this.baud.set(Number(store(`x3.dev.baud.${id}`)) || 115200);
        this.wanted.set(true);
        this.load();
      });
    });
    clearInterval(this.pollPorts);
    this.pollPorts = setInterval(() => this.refreshPorts(), 3000);
    // The monitor follows the chosen serial port and baud.
    effect(() => {
      const p = this.serialId();
      const baud = this.baud();
      const want = this.wanted();
      const running = this.flashingQuiet();
      untracked(() => {
        if (p && want && !running) this.connect(p, baud);
        else this.disconnect(false);
      });
    });
    // New lines: stay at the bottom unless the person scrolled up.
    effect(() => {
      this.shownLines();
      if (untracked(this.stick)) queueMicrotask(() => this.toBottom());
    });
    effect(() => {
      this.job();
      queueMicrotask(() => { const f = this.flogEl()?.nativeElement; if (f) f.scrollTop = f.scrollHeight; });
    });
  }

  ngOnDestroy() {
    clearInterval(this.pollPorts);
    clearTimeout(this.pollJob);
    this.disconnect(false);
  }

  private base() { return `/api/embedded/${encodeURIComponent(this.app()._id)}`; }

  // ---------------- reading ----------------
  load() {
    const id = this.app()._id;
    this.http.get<DeviceInfo>(`${this.base()}/device`).subscribe({
      next: d => {
        if (id !== this.app()._id) return;
        this.info.set(d);
        this.setPorts(d.ports);
        if (d.flash) {
          this.job.set(d.flash);
          if (d.flash.state === 'running') this.watchJob();
        }
      },
      error: () => this.info.set({ target: 'esp32', ports: [], image: null, board: null, flash: null,
                                   flashed: null, sim: null, bauds: BAUDS }),
    });
  }

  refreshPorts() {
    if (!this.info()) return;
    this.http.get<Port[]>(`${this.base()}/ports`).subscribe({ next: p => this.setPorts(p), error: () => {} });
  }

  private setPorts(ports: Port[]) {
    this.ports.set(ports);
    const id = this.portId();
    if (id && ports.some(p => p.id === id)) return;
    // The one port that fits the target is the board's; more than one, the person picks.
    const target = this.info()?.target ?? 'esp32';
    const fits = ports.filter(p => target === 'stm32' ? p.kind === 'probe' || p.for === 'stm32' : p.kind === 'serial');
    this.portId.set(fits.length === 1 ? fits[0].id : null);
  }

  pick(id: string) {
    this.portId.set(this.portId() === id ? null : id);
    store(`x3.dev.port.${this.app()._id}`, this.portId() ?? '');
    this.wanted.set(true);
    this.flashErr.set(null);
  }

  chosen = computed(() => this.ports().find(p => p.id === this.portId()) ?? null);
  /** The port the monitor reads: the chosen one if it is a tty, else a tty on the same USB device (ST-Link's VCP). */
  serialPort = computed(() => {
    const p = this.chosen();
    if (!p) return null;
    if (p.kind === 'serial') return p;
    return this.ports().find(x => x.kind === 'serial' && x.usb === p.usb) ?? null;
  });

  /** The id alone, so a fresh list of the same ports does not reopen the monitor. */
  serialId = computed(() => this.serialPort()?.id ?? null);
  /** A flash with the monitor not wanted after it: the monitor stays shut meanwhile. */
  flashingQuiet = computed(() => this.job()?.state === 'running' && !this.monAfter());

  // ---------------- the monitor ----------------
  connect(id?: string, baud?: number) {
    const p = id ?? this.serialPort()?.id;
    if (!p) return;
    this.wanted.set(true);
    this.es?.close();
    this.mon.set('connecting');
    this.monWhy.set(null);
    const url = `${this.base()}/serial/stream?port=${encodeURIComponent(p)}&baud=${baud ?? this.baud()}`;
    const es = this.es = new EventSource(url);
    es.addEventListener('hello', (e: MessageEvent) => {
      const d = JSON.parse(e.data);
      this.state(d);
      const have = new Set(this.lines().map(l => l.n));
      const add = (d.backlog as Line[]).filter(l => !have.has(l.n) && l.n > this.cleared);
      if (add.length) this.push(add);
    });
    es.addEventListener('line', (e: MessageEvent) => this.push([JSON.parse(e.data)]));
    es.addEventListener('state', (e: MessageEvent) => this.state(JSON.parse(e.data)));
    es.onerror = () => {
      if (this.es !== es) return;
      if (es.readyState === EventSource.CLOSED) { this.mon.set('error'); this.monWhy.set(t('the monitor could not be opened')); }
      else this.mon.set('connecting');
    };
  }

  disconnect(byHand = true) {
    this.es?.close();
    this.es = undefined;
    this.mon.set('closed');
    this.monWhy.set(null);
    if (byHand) this.wanted.set(false);
  }

  private state(d: { state: MonState; why: string | null; where: string | null; baud: number }) {
    this.mon.set(d.state);
    this.monWhy.set(d.why);
    this.monWhere.set(d.where);
  }

  private push(add: Line[]) {
    const all = this.lines().concat(add);
    this.lines.set(all.length > KEEP ? all.slice(all.length - KEEP) : all);
  }

  live = computed(() => this.mon() !== 'closed');
  canType = computed(() => this.mon() === 'open');
  /** What the log shows: the board's lines, or until a board is open, the last simulation's. */
  showing = computed<'board' | 'sim' | 'none'>(() =>
    this.live() || this.lines().length ? 'board' : this.simLines().length ? 'sim' : 'none');
  simLines = computed<Line[]>(() => {
    const s = this.info()?.sim;
    if (!s) return [];
    const out: Line[] = [];
    let n = 0;
    for (const e of s.uart) {
      const parts = e.data.replace(/\r/g, '').split('\n');
      if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
      for (const text of parts) {
        out.push({ n: ++n, t: (s.started ?? 0) * 1000 + e.t / 1000, dir: e.dir === 'in' ? 'sim-tx' : 'sim-rx', text });
      }
    }
    return out;
  });
  shownLines = computed(() => this.showing() === 'sim' ? this.simLines() : this.lines());

  monNote = computed(() => {
    const p = this.serialPort();
    if (this.showing() === 'sim' && !this.live()) return t('the last simulation, until a board is connected');
    if (!p) return this.chosen() ? t('this probe has no serial port') : t('no board connected');
    switch (this.mon()) {
      case 'closed': return t('closed');
      case 'connecting': case 'opening': return t('opening') + ' ' + this.short(p.id) + '…';
      case 'paused': return this.monWhy() === 'flashing' ? t('paused while flashing') : t('paused');
      case 'error': return this.monWhy() || t('the port went away');
      default: return this.short(p.id) + (this.monWhere() === 'container' ? ' · ' + t('in the container') : '');
    }
  });

  emptyLog = computed(() => {
    if (!this.info()) return '';
    if (!this.ports().length) return t('No board connected, and no simulation has run yet. Its serial output shows here.');
    return t('Pick a port on the left to read it.');
  });

  setBaud(b: number) {
    this.baud.set(b);
    store(`x3.dev.baud.${this.app()._id}`, String(b));
  }
  setStamps(on: boolean) { this.stamps.set(on); store('x3.dev.stamps', on ? '1' : '0'); }
  setEol(v: 'crlf' | 'lf' | 'cr' | 'none') { this.eol.set(v); store('x3.dev.eol', v); }
  setMonAfter(on: boolean) { this.monAfter.set(on); store('x3.dev.monAfter', on ? '1' : '0'); }

  clear() {
    const l = this.lines();
    if (l.length) this.cleared = l[l.length - 1].n;
    this.lines.set([]);
    if (this.showing() === 'sim' || !this.live()) {
      const i = this.info();
      if (i) this.info.set({ ...i, sim: null });
    }
    this.stick.set(true);
  }

  key(e: KeyboardEvent, box: HTMLInputElement) {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (!this.sent.length) return;
      e.preventDefault();
      this.histAt = e.key === 'ArrowUp' ? Math.max(0, (this.histAt < 0 ? this.sent.length : this.histAt) - 1)
                                         : Math.min(this.sent.length, this.histAt + 1);
      box.value = this.sent[this.histAt] ?? '';
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const p = this.serialPort();
    if (!p) return;
    const text = box.value;
    const end = { crlf: '\r\n', lf: '\n', cr: '\r', none: '' }[this.eol()];
    this.http.post(`${this.base()}/serial/write`, { port: p.id, text: text + end }).subscribe({
      next: () => {
        if (text && this.sent[this.sent.length - 1] !== text) this.sent.push(text);
        this.histAt = -1;
        box.value = '';
        this.follow();
      },
      error: (err: HttpErrorResponse) => this.push([{ n: 0, t: Date.now(), dir: 'tx', text: `(${err.error?.detail ?? err.message})` }]),
    });
  }

  scrolled() {
    const el = this.logEl()?.nativeElement;
    if (!el) return;
    this.stick.set(el.scrollTop + el.clientHeight >= el.scrollHeight - 12);
  }
  follow() { this.stick.set(true); queueMicrotask(() => this.toBottom()); }
  private toBottom() {
    const el = this.logEl()?.nativeElement;
    if (el) el.scrollTop = el.scrollHeight;
  }

  // ---------------- flashing ----------------
  image = computed(() => this.info()?.image ?? null);
  running = computed(() => this.job()?.state === 'running');
  flashPort = computed(() => {
    const p = this.chosen();
    const target = this.info()?.target;
    if (!p) return null;
    if (target === 'esp32' && p.kind !== 'serial') return null;
    return p;
  });
  canFlash = computed(() => !!this.image() && !!this.flashPort() && !this.running());
  flashWhy = computed(() => !this.image() ? t('build the firmware first')
    : !this.chosen() ? t('connect a board and pick its port first')
    : !this.flashPort() ? t('an ESP32 is flashed through its serial port, not a probe') : '');
  flashLabel = computed(() => {
    const j = this.job();
    if (j?.state === 'running') return t('Flashing…') + (j.pct != null ? ` ${j.pct}%` : '');
    if (!this.image()) return t('Flash - build it first');
    if (!this.chosen()) return t('Flash - connect a board first');
    return t('Flash') + ' ' + this.short(this.flashPort()?.id ?? this.chosen()!.id);
  });

  flash() {
    const p = this.flashPort();
    if (!p) return;
    this.flashErr.set(null);
    this.http.post<FlashJob>(`${this.base()}/flash`, { port: p.id, erase: this.erase() }).subscribe({
      next: j => { this.job.set(j); this.watchJob(); },
      error: (err: HttpErrorResponse) => this.flashErr.set(err.error?.detail ?? err.message),
    });
  }

  private watchJob() {
    clearTimeout(this.pollJob);
    const id = this.app()._id;
    const tick = () => {
      const j = this.job();
      if (!j || id !== this.app()._id) return;
      this.http.get<FlashJob | null>(`${this.base()}/flash?since=${j.n}`).subscribe({
        next: d => {
          if (!d || id !== this.app()._id) return;
          const same = d.id === j.id;
          this.job.set({ ...d, lines: same ? j.lines.concat(d.lines) : d.lines });
          if (d.state === 'running') this.pollJob = setTimeout(tick, 400);
          else this.flashed(d);
        },
        error: () => { this.pollJob = setTimeout(tick, 1500); },
      });
    };
    this.pollJob = setTimeout(tick, 300);
  }

  private flashed(j: FlashJob) {
    const i = this.info();
    if (i) this.info.set({ ...i, flashed: { at: j.ended ?? '', ok: j.state === 'done', port: j.port } });
    if (j.state === 'done' && this.monAfter() && this.serialPort()) {
      this.wanted.set(true);
      if (!this.live()) this.connect();
    }
  }

  jobWord(j: FlashJob): string {
    if (j.state === 'done') return t('done') + (j.ended ? ' · ' + this.when(j.ended) : '');
    if (j.state === 'failed') return t('failed') + (j.rc != null ? ` (${j.rc})` : '');
    return t(STAGES[j.stage ?? ''] ?? 'starting');
  }

  // ---------------- words ----------------
  boardTitle = computed(() => this.info()?.board?.title || this.info()?.board?.board || t('Board'));
  waitingTitle = computed(() => {
    const b = this.info()?.board;
    return b ? t('Waiting for the {board}').replace('{board}', b.title || b.board) : t('Waiting for a board');
  });
  plugHint = computed(() => {
    const i = this.info();
    if (!i) return '';
    if (i.target === 'stm32') return t('Plug in its ST-Link probe over USB. The probe appears below.');
    const usb = i.board?.usb;
    return usb ? t('Plug it in over {usb}. Its USB-serial bridge shows up as a serial port and appears below.').replace('{usb}', usb)
               : t('Plug it in over USB. Its USB-serial bridge shows up as a serial port and appears below.');
  });
  autoNote = computed(() => {
    const a = this.info()?.board?.auto;
    if (!a) return '';
    const s = a.bridge
      ? t("The board resets into download mode by itself ({q1} and {q2} drive EN and IO0 from {u}'s DTR and RTS), so there is no button to hold while flashing.")
      : t('The board resets into download mode by itself ({q1} and {q2} drive EN and IO0 from DTR and RTS), so there is no button to hold while flashing.');
    const [q1, q2] = [a.io0, a.en].sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
    return s.replace('{q1}', q1).replace('{q2}', q2).replace('{u}', a.bridge ?? '');
  });

  targetLine(im: Image): string {
    return [(im.chip || im.target).toUpperCase(), im.flash_size?.replace(/(\d)([KMG]B)$/, '$1 $2')].filter(Boolean).join(' · ');
  }
  short(id: string): string { return id.startsWith('/dev/') ? id.slice(5) : id.split('/').pop() || id; }
  kb(n: number): string { return n >= 1024 * 1024 ? (n / 1048576).toFixed(2) + ' MB' : (n / 1024).toFixed(1) + ' kB'; }
  clock(ms: number): string {
    const d = new Date(ms);
    const p = (x: number, w = 2) => String(x).padStart(w, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  }
  when(iso: string | null): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(+d)) return iso;
    const p = (x: number) => String(x).padStart(2, '0');
    const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
    return d.toDateString() === new Date().toDateString() ? hm : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
  }
}
