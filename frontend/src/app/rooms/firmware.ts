import {
  AfterViewInit, Component, ElementRef, OnDestroy, computed, effect, inject, input, output, signal, untracked, viewChild,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type * as Monaco from 'monaco-editor';
import { LogLine } from '../api';
import { Auth } from '../auth';
import { T, t } from '../i18n';
import { Prefs } from '../preferences';
import { FwAnchor, Selection } from '../selection';
import { isLightTheme } from '../../theme';
import { Drawing, DrawingMarks } from './drawing';
import { RoomFrame, ToolButton } from './frame';
import { DrawTools, PenState, Sketchpad } from './sketchpad';
import { loadMonaco, redlineTheme } from './code-view';
import {
  BAUDS, FlashManifest, FlashProgress, FlashRecord, Plain, SerialLine, SerialLink, WrongChip,
  browserEnv, choosePort, fileArray, flashImage, hexOf, macTail, plainError, portLabel, quickCommands,
  rememberedPort, webSerialSupport,
} from './flasher';

/** One pin of the MCU, as the board draws it (backend/firmware.py pin_rows). */
export interface FwPin {
  number: string; name: string; net: string | null; gpio: number | null; parts: string[];
  kind: 'gpio' | 'power' | 'ground' | 'flash' | 'nc' | 'other';
  macro: string; input_only: boolean; strapping: boolean; used_in: string[];
}
interface Size { used: number; total: number; pct: number }
interface Diag { file: string; line: number | null; col: number | null; text: string }
export interface FwBuild {
  state?: 'running' | 'ok' | 'errors' | 'failed' | 'lost'; job?: string; at?: string; started_at?: string;
  seconds?: number; version?: number; why?: string | null; last?: string | null;
  error_count?: number; warning_count?: number; errors?: Diag[]; warnings?: Diag[];
  flash?: Size | null; ram?: Size | null; detail?: string | null;
  artifacts?: Record<string, { bytes: number }>; artifacts_version?: number;
}
export interface Firmware {
  id: string; _id: string; title: string; board: string; board_title?: string; folder?: string;
  mcu: string; mcu_title?: string; sheet: string; sheet_name?: string;
  platform: string; pio_board: string; framework: string; env: string;
  board_version: number; version: number; updated_at?: string;
  board_change?: { at: string; text: string; board_version: number; from_version?: number;
                   moved: { net: string; from: number; to: number }[]; added: string[]; removed: string[];
                   missing?: boolean } | null;
  build?: FwBuild | null;
  last_flash?: FlashRecord | null;
}
/** GET /api/firmware/{id}: the record and the MCU's pins as the board has them now. */
export interface FirmwareDetail extends Firmware {
  pins: FwPin[]; svg: string | null; matches: boolean; found: boolean; board_now: number;
}
interface FwFile { path: string; bytes: number; version: number; at: string; generated: boolean }
interface Mcu { ref: string; title: string; sheet: string }

type View = 'schematic' | 'code' | 'monitor';
type FlashStep = 'blocked' | 'ready' | 'connecting' | 'flashing' | 'verifying' | 'done' | 'error';
type FileState = 'wait' | 'write' | 'verify' | 'done';
type Side = 'first' | 'status';
type Tone = 'ok' | 'warn' | 'error' | 'none';

/** Where text sits in a KiCad SVG: KiCad writes each label twice, as
 *  strokes and as an invisible <text> with its x, y, length and anchor -
 *  which is enough to put a box round it. Rotated labels sit in a
 *  <g transform="rotate(a cx cy)">. */
export function textBoxes(svg: string, words: string[]): DrawingMarks | null {
  const got = labelBoxes(svg, words);
  return got ? { box: got.box, rects: got.labels.map(l => l.rect) } : null;
}

/** The same, saying which word each box is round - what a click on the
 *  sheet is matched against. */
export function labelBoxes(svg: string, words: string[]):
    { box: number[]; labels: { word: string; rect: DrawingMarks['rects'][number] }[] } | null {
  const want = new Set(words.filter(Boolean));
  if (!want.size) return null;
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  const vb = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  if (vb.length !== 4 || vb.some(n => !isFinite(n))) return null;
  const labels: { word: string; rect: DrawingMarks['rects'][number] }[] = [];
  for (const el of Array.from(doc.getElementsByTagName('text'))) {
    const text = (el.textContent || '').trim();
    if (!want.has(text)) continue;
    const x = +(el.getAttribute('x') ?? NaN), y = +(el.getAttribute('y') ?? NaN);
    const len = +(el.getAttribute('textLength') ?? 0) || text.length * 1.1;
    const size = +(el.getAttribute('font-size') ?? 1.7) || 1.7;
    if (!isFinite(x) || !isFinite(y)) continue;
    const anchor = el.getAttribute('text-anchor');
    const x0 = anchor === 'end' ? x - len : anchor === 'middle' ? x - len / 2 : x;
    const pad = size * 0.35;
    let box = { x: x0 - pad, y: y - size - pad * 0.6, w: len + 2 * pad, h: size + 1.6 * pad };
    const g = el.parentElement?.closest('g[transform]');
    const rot = g?.getAttribute('transform')?.match(/rotate\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/);
    if (rot) {
      const a = (+rot[1] * Math.PI) / 180, cx = +rot[2], cy = +rot[3];
      const pts = [[box.x, box.y], [box.x + box.w, box.y], [box.x, box.y + box.h], [box.x + box.w, box.y + box.h]]
        .map(([px, py]) => [cx + (px - cx) * Math.cos(a) - (py - cy) * Math.sin(a),
                            cy + (px - cx) * Math.sin(a) + (py - cy) * Math.cos(a)]);
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs),
              h: Math.max(...ys) - Math.min(...ys) };
    }
    labels.push({ word: text, rect: box });
  }
  return { box: vb, labels };
}

/** A theme token's colour as the canvas takes it (the pictures a note
 *  carries are drawn in the theme on screen). */
function tokenColour(name: string): string {
  const probe = document.createElement('span');
  probe.style.color = `var(${name})`;
  probe.style.display = 'none';
  document.body.appendChild(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  return c;
}

/** Lines of code as a picture: what a code note is drawn on, and its
 *  "before". The anchored lines are banded in the accent colour. */
export function codePicture(width: number, height: number, path: string, lines: string[], first: number,
                            lit: [number, number] | null): string {
  const k = Math.min(devicePixelRatio, 2);
  const c = document.createElement('canvas');
  c.width = Math.round(width * k);
  c.height = Math.round(height * k);
  const x = c.getContext('2d')!;
  x.scale(k, k);
  const bg = tokenColour('--surface'), ink = tokenColour('--ink'), dim = tokenColour('--ink-dim');
  const band = tokenColour('--accent-deep'), accent = tokenColour('--accent'), head = tokenColour('--surface-2');
  x.fillStyle = bg;
  x.fillRect(0, 0, width, height);
  x.fillStyle = head;
  x.fillRect(0, 0, width, 24);
  const mono = "12px 'IBM Plex Mono', ui-monospace, monospace";
  x.font = mono;
  x.textBaseline = 'middle';
  x.fillStyle = ink;
  x.fillText(path + (lit ? `  ·  ${lit[0]}${lit[1] !== lit[0] ? '-' + lit[1] : ''}` : ''), 8, 12);
  const lh = 18, top = 30;
  lines.forEach((text, i) => {
    const n = first + i, y = top + i * lh;
    if (y > height) return;
    if (lit && n >= lit[0] && n <= lit[1]) {
      x.fillStyle = band;
      x.fillRect(0, y, width, lh);
      x.fillStyle = accent;
      x.fillRect(0, y, 3, lh);
    }
    x.fillStyle = dim;
    x.textAlign = 'right';
    x.fillText(String(n), 40, y + lh / 2);
    x.textAlign = 'left';
    x.fillStyle = ink;
    x.fillText(text.replace(/\t/g, '    '), 52, y + lh / 2);
  });
  return c.toDataURL('image/png');
}

function ago(at: string | null | undefined, now = Date.now()): string {
  if (!at) return '';
  const s = Math.max(0, (now - Date.parse(at)) / 1000);
  if (s < 45) return t('just now');
  if (s < 3600) return `${Math.round(s / 60)} ${t('min ago')}`;
  if (s < 86400) return `${Math.round(s / 3600)} ${t('h ago')}`;
  return `${Math.round(s / 86400)} ${t('d ago')}`;
}

/** 20:41, from an ISO time. */
function hhmm(at: string | null | undefined): string {
  if (!at) return '';
  const d = new Date(at);
  return isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function kb(n: number | undefined): string {
  if (n == null) return '–';
  return n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${(n / 1024).toFixed(0)} KB`;
}

/** The selected file, read-only, in Monaco - the editor the PCB and 3D
 *  rooms' code views use - with the schematic's net names lit. */
@Component({
  selector: 'app-fw-code',
  template: `<div #host class="h-full w-full"></div>`,
  host: { class: 'block h-full w-full' },
})
export class FwCode implements AfterViewInit, OnDestroy {
  text = input('');
  path = input('');
  /** The macros pins.h defines: lit wherever the code names them. */
  nets = input<string[]>([]);
  /** A line to show, when a build's error points at one. */
  line = input<number | null>(null);
  /** The lines a note is anchored to, banded. */
  anchor = input<[number, number] | null>(null);
  /** Lines selected by hand (or a line number clicked): first and last. */
  picked = output<[number, number]>();
  private host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private ed?: Monaco.editor.IStandaloneCodeEditor;
  private m?: typeof Monaco;
  private marks: string[] = [];
  private lit: string[] = [];

  constructor() {
    effect(() => {
      const text = this.text(), path = this.path(), nets = this.nets(), line = this.line();
      untracked(() => this.show(text, path, nets, line));
    });
    effect(() => { const a = this.anchor(); this.text(); untracked(() => this.band(a)); });
  }

  /** The first and last line on screen, with their text. */
  visible(): { first: number; lines: string[] } | null {
    const ed = this.ed, model = ed?.getModel();
    const r = ed?.getVisibleRanges()[0];
    if (!model || !r) return null;
    const lines: string[] = [];
    for (let n = r.startLineNumber; n <= r.endLineNumber; n++) lines.push(model.getLineContent(n));
    return { first: r.startLineNumber, lines };
  }

  private band(a: [number, number] | null) {
    const m = this.m, ed = this.ed;
    if (!m || !ed) return;
    this.lit = ed.deltaDecorations(this.lit, a ? [{
      range: new m.Range(a[0], 1, a[1], 1),
      options: { isWholeLine: true, className: 'fw-anchor-line', linesDecorationsClassName: 'fw-anchor-gutter' },
    }] : []);
  }

  ngAfterViewInit() {
    loadMonaco().then(m => {
      this.m = m;
      this.ed = m.editor.create(this.host().nativeElement, {
        value: '', readOnly: true, domReadOnly: true, theme: redlineTheme(m), automaticLayout: true,
        minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false, renderWhitespace: 'none',
        lineNumbersMinChars: 3, wordWrap: 'off', fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
      });
      this.show(this.text(), this.path(), this.nets(), this.line());
      this.band(this.anchor());
      // A selection made by hand (a line number clicked selects its line):
      // the lines a note can be anchored to.
      this.ed.onDidChangeCursorSelection(e => {
        if (e.source === 'api' || e.selection.isEmpty()) return;
        const s = e.selection;
        const last = s.endColumn === 1 && s.endLineNumber > s.startLineNumber ? s.endLineNumber - 1 : s.endLineNumber;
        this.picked.emit([s.startLineNumber, last]);
      });
    }).catch(() => { /* the file list still says what there is */ });
  }

  ngOnDestroy() { this.ed?.getModel()?.dispose(); this.ed?.dispose(); }

  private language(path: string): string {
    if (/\.(c|cc|cpp|cxx|h|hh|hpp|ino)$/i.test(path)) return 'cpp';
    if (/\.ini$/i.test(path)) return 'ini';
    if (/\.py$/i.test(path)) return 'python';
    if (/\.json$/i.test(path)) return 'json';
    if (/\.md$/i.test(path)) return 'markdown';
    return 'plaintext';
  }

  private show(text: string, path: string, nets: string[], line: number | null) {
    const m = this.m, ed = this.ed;
    if (!m || !ed) return;
    let model = ed.getModel();
    const lang = this.language(path);
    if (!model) {
      model = m.editor.createModel(text, lang);
      ed.setModel(model);
    } else {
      if (model.getValue() !== text) model.setValue(text);
      m.editor.setModelLanguage(model, lang);
    }
    const ranges: Monaco.editor.IModelDeltaDecoration[] = [];
    if (nets.length) {
      const rx = new RegExp(`\\b(${nets.map(n => n.replace(/[^\w]/g, '')).filter(Boolean).join('|')})\\b`, 'g');
      for (let n = 1; n <= model.getLineCount(); n++) {
        const l = model.getLineContent(n);
        for (const hit of l.matchAll(rx)) {
          const c = (hit.index ?? 0) + 1;
          ranges.push({ range: new m.Range(n, c, n, c + hit[0].length),
                        options: { inlineClassName: 'fw-net-mark', hoverMessage: { value: `net ${hit[0]} (pins.h)` } } });
        }
      }
    }
    this.marks = ed.deltaDecorations(this.marks, ranges);
    if (line) {
      ed.revealLineInCenter(line);
      ed.setSelection(new m.Range(line, 1, line, model.getLineMaxColumn(line)));
    } else {
      ed.setScrollTop(0);
    }
  }
}

/** The Firmware room.
 *
 *  The code that runs on one of a board's chips. The schematic is the
 *  board's own (the PCB room's MCU sheet, drawn by KiCad); the pins are
 *  read from it, and include/pins.h is generated from them, so the code
 *  says L_SDA where the board says L_SDA. A build is PlatformIO in a
 *  container (backend/fwbuild.py), detached: it carries on with the page
 *  closed, and its lines come into the log band.
 *
 *  The same frame as the 3D and PCB rooms (rooms/frame.ts): the toolbar
 *  with the pen at its end, two tabs on the left - the first follows the
 *  view (Pins beside the schematic, Files beside the code), the second is
 *  Status - the view, and the log.
 */
@Component({
  selector: 'app-room-firmware',
  imports: [Drawing, DrawTools, FwCode, RoomFrame, Sketchpad, T, ToolButton],
  styles: [`
    :host { display: contents; }
    .fw-pane { display: flex; flex-direction: column; min-height: 0; height: 100%; font-size: 12px; color: var(--ink); }
    .fw-scroll { flex: 1; min-height: 0; overflow-y: auto; }
    .fw-head { display: flex; align-items: center; gap: 6px; padding: 6px 8px; font-size: 11px; color: var(--ink-dim);
               border-bottom: 1px solid var(--line); min-width: 0; }
    .fw-head b { color: var(--ink); font-weight: 600; }
    .fw-tag { flex: none; padding: 0 6px; border-radius: 8px; font: 10.5px/16px 'IBM Plex Mono', ui-monospace, monospace;
              color: var(--ink-dim); background: var(--surface-2); border: 1px solid var(--line); }
    .fw-tag[data-tone="warn"] { color: var(--warn); }
    .fw-tag[data-tone="ok"] { color: var(--ok); }

    /* pins */
    .fw-pins { width: 100%; border-collapse: collapse; table-layout: fixed; }
    .fw-pins th { position: sticky; top: 0; z-index: 1; background: var(--surface); text-align: left; font-weight: 500;
                  font-size: 10.5px; color: var(--ink-dim); padding: 4px 6px; border-bottom: 1px solid var(--line); }
    .fw-pins td { padding: 4px 6px; border-bottom: 1px solid var(--line); vertical-align: top; font-size: 11.5px;
                  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fw-pins tr { cursor: pointer; }
    .fw-pins tbody tr:hover { background: var(--hover); }
    .fw-pins tr[data-on] { background: var(--accent-deep); }
    .fw-gpio { font-family: 'IBM Plex Mono', ui-monospace, monospace; color: var(--ink-dim); }
    .fw-gpio b { color: var(--ink); font-weight: 500; }
    .fw-net { font-family: 'IBM Plex Mono', ui-monospace, monospace; color: var(--ink); }
    .fw-parts { color: var(--ink-dim); }
    .fw-yes { color: var(--ok); }
    .fw-no { color: var(--ink-dim); }
    .fw-flag { margin-left: 4px; font-size: 10px; color: var(--warn); }
    .fw-more { padding: 6px 8px; font-size: 11px; color: var(--ink-dim); }
    .fw-more summary { cursor: pointer; }
    .fw-more summary:hover { color: var(--ink); }
    .fw-other { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 2px 10px; padding: 4px 0 2px;
                font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 10.5px; }

    /* files */
    .fw-tree { padding: 4px 0; }
    .fw-dir { padding: 4px 8px 2px; font-size: 11px; color: var(--ink-dim); }
    .fw-file { display: flex; align-items: center; gap: 6px; width: 100%; padding: 3px 8px 3px 20px; border: 0;
               background: none; color: var(--ink); font: 12px 'IBM Plex Mono', ui-monospace, monospace; text-align: left;
               cursor: pointer; min-width: 0; }
    .fw-file.fw-top { padding-left: 8px; }
    .fw-file:hover { background: var(--hover); }
    .fw-file[data-on] { background: var(--accent-deep); }
    .fw-file > span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fw-gen { flex: none; margin-left: auto; padding: 0 5px; border-radius: 3px; font: 10px/15px system-ui, sans-serif;
              color: var(--accent); background: var(--surface-2); border: 1px solid var(--line); }

    /* status - the Board health cards, in this room's words */
    .fs { flex: 1; min-height: 0; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 8px; }
    .fs-verdict { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 4px 10px;
                  padding: 10px; background: var(--surface-2); border: 1px solid var(--line); border-radius: 6px; }
    .fs-mark { grid-row: span 2; width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center;
               font-size: 12px; font-weight: 700; color: var(--ink-dim); background: var(--surface); }
    .fs-verdict[data-tone="ok"] .fs-mark { background: var(--ok); color: var(--ink-on-ok); }
    .fs-verdict[data-tone="warn"] .fs-mark { background: var(--warn); color: var(--ink-on-warn); }
    .fs-verdict[data-tone="error"] .fs-mark { background: var(--danger); color: var(--surface); }
    .fs-state { font-size: 13.5px; font-weight: 600; line-height: 1.2; color: var(--ink-bright); }
    .fs-when { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; font-size: 11px; color: var(--ink-dim); }
    .fs-run { margin-left: auto; padding: 2px 8px; font-size: 11px; }
    .fs-note { padding: 5px 8px; font-size: 11px; background: var(--surface-2); border: 1px solid var(--line);
               border-radius: 4px; overflow-wrap: anywhere; }
    .fs-list { display: flex; flex-direction: column; gap: 4px; }
    .fs-card { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
    .fs-head { width: 100%; display: grid; grid-template-columns: 10px minmax(0, 1fr) auto 10px; align-items: center;
               gap: 2px 8px; padding: 7px 9px; text-align: left; background: none; border: 0; color: inherit;
               font: inherit; cursor: pointer; }
    .fs-head:disabled { cursor: default; }
    .fs-head:not(:disabled):hover { background: var(--hover); border-radius: 6px; }
    .fs-light { width: 10px; height: 10px; border-radius: 50%; background: var(--line); }
    [data-tone="ok"] .fs-light { background: var(--ok); }
    [data-tone="warn"] .fs-light { background: var(--warn); }
    [data-tone="error"] .fs-light { background: var(--danger); }
    .fs-title { font-size: 12px; font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fs-status { font: 11px 'IBM Plex Mono', ui-monospace, monospace; color: var(--ink-dim); white-space: nowrap; }
    [data-tone="ok"] .fs-status { color: var(--ok); }
    [data-tone="warn"] .fs-status { color: var(--warn); }
    [data-tone="error"] .fs-status { color: var(--danger); }
    .fs-chev { font-size: 10px; color: var(--ink-dim); transition: transform .12s; }
    .fs-chev[data-open] { transform: rotate(90deg); }
    .fs-line { grid-column: 2 / 4; font-size: 11px; color: var(--ink-dim); line-height: 1.35; }
    .fs-items { border-top: 1px solid var(--line); padding: 2px 0; }
    .fs-item { display: block; width: 100%; padding: 5px 9px 5px 27px; border: 0; background: none; color: var(--ink);
               text-align: left; font: 11px/1.35 'IBM Plex Mono', ui-monospace, monospace; overflow-wrap: anywhere; }
    button.fs-item { cursor: pointer; }
    button.fs-item:hover { background: var(--hover); }
    .fs-item + .fs-item { border-top: 1px dashed var(--line); }
    .fs-item i { font-style: normal; color: var(--accent); }
    .fs-meters { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
    .fs-meter { padding: 6px 8px 7px; background: var(--surface-2); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
    .fs-meter > span { display: block; font-size: 10.5px; color: var(--ink-dim); }
    .fs-meter > b { display: block; font-size: 13px; font-weight: 600; margin: 1px 0 4px; }
    .fs-meter > small { display: block; font: 10px 'IBM Plex Mono', ui-monospace, monospace; color: var(--ink-dim);
                        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .fs-bar { height: 4px; border-radius: 2px; background: var(--line); overflow: hidden; margin-bottom: 4px; }
    .fs-bar > i { display: block; height: 100%; background: var(--accent); }
    .fs-bar[data-tone="warn"] > i { background: var(--warn); }
    .fs-bar[data-tone="error"] > i { background: var(--danger); }
    .fs-fold { border: 1px solid var(--line); border-radius: 6px; background: var(--surface); }
    .fs-fold > summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: 8px; padding: 6px 9px;
                         font-size: 11px; color: var(--ink-dim); }
    .fs-fold > summary::-webkit-details-marker { display: none; }
    .fs-fold > summary::after { content: '›'; margin-left: auto; font-size: 10px; transition: transform .12s; }
    .fs-fold[open] > summary::after { transform: rotate(90deg); }
    .fs-fold > summary:hover { color: var(--ink); }
    .fs-deep { padding: 4px 9px 9px; display: flex; flex-direction: column; gap: 6px; font-size: 11px; }
    .fs-files { display: flex; flex-wrap: wrap; gap: 6px; }
    .fs-files a { color: var(--accent); }
    .fs-files a.off { color: var(--ink-dim); pointer-events: none; }
    .fs-facts { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 2px 10px;
                font: 10.5px 'IBM Plex Mono', ui-monospace, monospace; color: var(--ink-dim); }
    .fs-facts b { color: var(--ink); font-weight: 400; overflow-wrap: anywhere; }
    .fs-raw { max-height: 220px; overflow: auto; margin: 0; padding: 6px; border-radius: 4px; background: var(--surface-2);
              font: 10px/1.4 'IBM Plex Mono', ui-monospace, monospace; color: var(--ink-dim); white-space: pre-wrap; }

    /* loading: the panel's own shape, its lines pulsing */
    .fw-skel { padding: 10px 8px; display: flex; flex-direction: column; gap: 9px; }
    .fw-skel .sk { display: block; height: 10px; border-radius: 4px; background: var(--hover);
                   animation: fw-sk 1.2s ease-in-out infinite; }
    .fw-skel .sk-big { height: 40px; border-radius: 6px; }
    @keyframes fw-sk { 50% { opacity: .4; } }
    @media (prefers-reduced-motion: reduce) { .fw-skel .sk { animation: none; } }

    /* nothing open */
    .fw-empty { padding: 12px; font-size: 12px; color: var(--ink-dim); display: flex; flex-direction: column; gap: 8px;
                max-width: 34rem; }
    .fw-empty button { align-self: flex-start; }
    .fw-pick { max-width: 14rem; }
    .fw-view { position: relative; height: 100%; width: 100%; min-height: 0; }
    .fw-codehead { display: flex; align-items: center; gap: 8px; padding: 4px 8px; font: 11px 'IBM Plex Mono', ui-monospace, monospace;
                   color: var(--ink-dim); border-bottom: 1px solid var(--line); background: var(--surface); }
    .fw-codehead b { color: var(--ink); font-weight: 500; }
    .fw-hint { position: absolute; left: 8px; top: 8px; z-index: 2; padding: 2px 8px; border-radius: 4px; font-size: 11px;
               color: var(--ink); background: var(--surface-2); border: 1px solid var(--line); pointer-events: none; }
    .fs-flash { padding: 2px 10px; font-size: 11px; }
    .fs-needs { color: var(--warn); }

    /* the serial monitor */
    .fm { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; font-size: 12px;
          color: var(--ink); background: var(--surface); }
    .fm-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 5px 8px; border-bottom: 1px solid var(--line); }
    .fm-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--line); flex: none; }
    .fm-dot[data-on] { background: var(--ok); }
    .fm-port { font: 11px 'IBM Plex Mono', ui-monospace, monospace; color: var(--ink-dim); white-space: nowrap; }
    .fm-baud { padding: 1px 4px; font-size: 11px; width: auto; }
    .fm-gap { flex: 1; }
    .fm-b { padding: 2px 8px; font-size: 11px; }
    .fm-lines { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 8px; font: 11.5px/1.45 'IBM Plex Mono', ui-monospace, monospace; }
    .fm-line { display: flex; gap: 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .fm-ts { flex: none; color: var(--ink-dim); opacity: .75; }
    .fm-line[data-kind="tx"] .fm-text { color: var(--accent); }
    .fm-line[data-kind="info"] .fm-text { color: var(--ink-dim); font-style: italic; }
    .fm-line[data-kind="error"] .fm-text { color: var(--danger); }
    .fm-empty { margin: 8px 0; color: var(--ink-dim); font-family: system-ui, sans-serif; }
    .fm-jump { position: absolute; right: 14px; bottom: 50px; z-index: 2; }
    .fm-send { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px 8px; border-top: 1px solid var(--line); }
    .fm-q { font: 11px 'IBM Plex Mono', ui-monospace, monospace; }
    .fm-in { flex: 1; min-width: 10rem; padding: 3px 6px; font: 12px 'IBM Plex Mono', ui-monospace, monospace; }

    /* the flash dialog */
    .fl-scrim { position: fixed; inset: 0; z-index: 60; background: var(--scrim); }
    .fl-box { position: fixed; z-index: 61; left: 50%; top: 12vh; transform: translateX(-50%); width: min(34rem, calc(100vw - 32px));
              max-height: 76vh; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; padding: 14px;
              background: var(--surface); color: var(--ink); border: 1px solid var(--line); border-radius: 8px;
              box-shadow: var(--shadow-hard); font-size: 12px; }
    .fl-head { display: flex; align-items: flex-start; gap: 8px; }
    .fl-head b { display: block; font-size: 14px; font-weight: 600; color: var(--ink-bright); }
    .fl-sub { display: block; font: 11px 'IBM Plex Mono', ui-monospace, monospace; color: var(--ink-dim); margin-top: 2px; }
    .fl-x { margin-left: auto; padding: 0 7px; }
    .fl-steps { display: flex; gap: 4px; margin: 0; padding: 0; list-style: none; }
    .fl-steps li { flex: 1; display: flex; align-items: center; gap: 6px; padding: 5px 6px; border-radius: 4px; font-size: 11px;
                   color: var(--ink-dim); background: var(--surface-2); border: 1px solid var(--line); min-width: 0; white-space: nowrap;
                   overflow: hidden; text-overflow: ellipsis; }
    .fl-steps li i { font-style: normal; flex: none; width: 16px; height: 16px; border-radius: 50%; display: grid; place-items: center;
                     font-size: 10px; background: var(--surface); border: 1px solid var(--line); }
    .fl-steps li[data-state="now"] { color: var(--ink-bright); border-color: var(--accent); }
    .fl-steps li[data-state="now"] i { background: var(--accent); color: var(--ink-on-accent); border-color: var(--accent); }
    .fl-steps li[data-state="done"] i { background: var(--ok); color: var(--ink-on-ok); border-color: var(--ok); }
    .fl-steps li[data-state="error"] { border-color: var(--danger); }
    .fl-steps li[data-state="error"] i { background: var(--danger); color: var(--surface); border-color: var(--danger); }
    .fl-files { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; }
    .fl-files li { display: grid; grid-template-columns: 4.6rem minmax(0, 1fr) 3.6rem 5rem 4.6rem; align-items: center; gap: 8px;
                   font: 11px 'IBM Plex Mono', ui-monospace, monospace; }
    .fl-addr { color: var(--accent); }
    .fl-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fl-size, .fl-word { color: var(--ink-dim); text-align: right; white-space: nowrap; }
    .fl-files li[data-state="done"] .fl-word { color: var(--ok); }
    .fl-bar { height: 5px; border-radius: 3px; background: var(--line); overflow: hidden; }
    .fl-bar > i { display: block; height: 100%; background: var(--accent); transition: width .15s; }
    .fl-files li[data-state="done"] .fl-bar > i { background: var(--ok); }
    .fl-msg { margin: 0; padding: 7px 9px; border-radius: 5px; background: var(--surface-2); border: 1px solid var(--line); line-height: 1.45; }
    .fl-msg[data-tone="ok"] { border-color: var(--ok); }
    .fl-msg[data-tone="warn"] { border-color: var(--warn); }
    .fl-msg[data-tone="error"] { border-color: var(--danger); }
    .fl-msg[data-tone="error"] b { color: var(--danger); }
    .fl-hint { margin: 0; font-size: 11px; color: var(--ink-dim); }
    .fl-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .fl-actions .tcv-btn { padding: 3px 12px; }
    .fl-busy { font-size: 11px; color: var(--ink-dim); }
    .fl-log summary { cursor: pointer; font-size: 11px; color: var(--ink-dim); }
    .fl-log pre { max-height: 160px; overflow: auto; margin: 4px 0 0; padding: 6px; border-radius: 4px; background: var(--surface-2);
                  font: 10px/1.4 'IBM Plex Mono', ui-monospace, monospace; color: var(--ink-dim); white-space: pre-wrap; }
    @media (max-width: 560px) {
      .fl-files li { grid-template-columns: 4.2rem minmax(0, 1fr) 4rem; }
      .fl-files .fl-size, .fl-files .fl-word { display: none; }
    }
    @media (max-width: 768px) {
      .fw-pins .fw-c-parts { display: none; }
      .fs-meters { grid-template-columns: 1fr 1fr; }
    }
  `],
  template: `
<div class="tcv-room absolute inset-0 flex min-h-0 flex-col p-1">
@if (!fw() && !loading()) {
  <div class="fw-empty">
    @if (list().length) {
      <p>{{ 'Pick a firmware - a .fw in the catalog, under its board - or one of these:' | t }}</p>
      @for (f of list(); track f.id) {
        <button class="tcv-chip" (click)="pick(f.id)">{{ f.title }} <span style="color: var(--ink-dim)">· {{ f.board_title || f.board }}</span></button>
      }
    } @else {
      <p>{{ 'No firmware yet. A firmware is made from one of a board\\'s chips: open the board in PCB Design, its schematic\\'s MCU sheet has "Create firmware".' | t }}</p>
    }
    @if (mcusHere().length) {
      <p>{{ 'On' | t }} <b>{{ picked.board() }}</b>:</p>
      @for (m of mcusHere(); track m.ref) {
        <button class="tcv-btn tcv-btn-accent px-2 py-0.5" [disabled]="!auth.can('edit') || making()"
                (click)="create(picked.board()!, m.ref)">{{ 'Create firmware' | t }} · {{ m.ref }} {{ m.title }}</button>
      }
    }
    @if (note()) { <p style="color: var(--warn)">{{ note() }}</p> }
  </div>
} @else {
  <app-room-frame room="firmware" [tabs]="sideTabs" [tab]="side()" [labels]="tabNames()"
                  (tabChange)="setSide($any($event))" [log]="log()">

    <!-- THE TOOLBAR: which view, then build, flash and the serial
         monitor (in this browser, over USB), then how close - and the pen
         at the far end. -->
    <ng-container ngProjectAs="[bar]">
      <app-tool icon="tcv-ico-schematic" [tip]="'Schematic - the MCU\\'s sheet of the board' | t"
                [on]="view() === 'schematic'" (press)="setView('schematic')" />
      <app-tool icon="tcv-ico-code" [tip]="'Code - the project\\'s files' | t"
                [on]="view() === 'code'" (press)="setView('code')" />
      <span class="tcv_separator"></span>
      <app-tool icon="tcv-ico-build"
                [tip]="building() ? ('Building…' | t) : ('Build - PlatformIO, in a container' | t)"
                [on]="building()" [disabled]="building() || !fw() || !auth.can('run')" (press)="build()" />
      <app-tool icon="tcv-ico-flash" [tip]="flashTip()" [on]="flashOpen()"
                [disabled]="!serial().ok || !fw() || !auth.can('run')" (press)="openFlash()" />
      <app-tool icon="tcv-ico-monitor" [tip]="monitorTip()"
                [on]="view() === 'monitor'" [disabled]="!serial().ok || !fw()" (press)="toggleMonitor()" />
      <span class="tcv_separator"></span>
      <app-tool icon="tcv-ico-fit" [tip]="'Fit - all of it (or double-click)' | t" [disabled]="view() !== 'schematic'"
                (press)="flat()?.fit()" />
      <app-tool icon="tcv-ico-in" [tip]="'Closer' | t" [disabled]="view() !== 'schematic'" (press)="flat()?.step(1.25)" />
      <app-tool icon="tcv-ico-out" [tip]="'Further' | t" [disabled]="view() !== 'schematic'" (press)="flat()?.step(0.8)" />
    </ng-container>
    <ng-container ngProjectAs="[barEnd]">
      <!-- The pen: a note on a pin or on lines of code, for the Firmware
           room's agent. Pick a pin (or a net on the sheet) or select lines
           first; the pen holds the view still to draw on, and the note's
           form is in the right-hand column. -->
      @if (frozen()) {
        <app-draw-tools [pen]="pen" (undo)="pad()?.undo()" (clear)="pad()?.clear()" />
      }
      <span class="tcv_tooltip" [attr.data-tooltip]="frozen() ? ('Let the view go' | t) : ('Draw a note - on the pin or the lines picked' | t)">
        <span class="tcv_button_frame">
          <button class="tcv_reset tcv_btn tcv-freeze" [attr.data-on]="frozen() ? 1 : null"
                  [disabled]="!fw() || view() === 'monitor'" [attr.aria-label]="'Draw a note' | t"
                  (click)="frozen() ? resume() : freeze()"></button>
        </span>
      </span>
    </ng-container>

    <!-- THE TABS -->
    <div side class="fw-pane">
      @if (!fw()) {
        <div class="fw-skel" aria-busy="true">
          <span class="sk sk-big"></span><span class="sk" style="width: 80%"></span><span class="sk" style="width: 65%"></span>
          <span class="sk" style="width: 90%"></span><span class="sk" style="width: 55%"></span><span class="sk" style="width: 75%"></span>
        </div>
      } @else if (side() === 'first' && view() !== 'code') {
        <!-- PINS: every pin on a signal net, its GPIO, and whether the code uses it. -->
        @let f = fw()!;
        <div class="fw-head">
          <b>{{ f.mcu }}</b><span class="min-w-0 truncate">{{ f.mcu_title }}</span>
          <span class="fw-tag ml-auto" [attr.data-tone]="f.matches ? 'ok' : 'warn'"
                [title]="f.matches ? ('pins.h matches the board' | t) : ('the board changed since pins.h was written' | t)">board v{{ f.board_version }}</span>
        </div>
        <div class="fw-scroll">
          <table class="fw-pins">
            <colgroup><col style="width: 26%"><col style="width: 30%"><col class="fw-c-parts" style="width: 28%"><col style="width: 16%"></colgroup>
            <thead><tr><th>{{ 'Chip pin' | t }}</th><th>{{ 'Net' | t }}</th><th class="fw-c-parts">{{ 'Parts' | t }}</th><th>{{ 'Code' | t }}</th></tr></thead>
            <tbody>
              @for (p of signalPins(); track p.number) {
                <tr (click)="pickPin(p)" [attr.data-on]="pin()?.number === p.number ? 1 : null"
                    [title]="p.name + ' (pin ' + p.number + ') - ' + p.net + (p.parts.length ? ' - ' + p.parts.join(', ') : '')">
                  <td class="fw-gpio">{{ p.name }} <b>{{ p.gpio }}</b>
                    @if (p.input_only) { <span class="fw-flag" [title]="'input only' | t">in</span> }
                  </td>
                  <td class="fw-net">{{ p.macro || p.net }}</td>
                  <td class="fw-parts fw-c-parts">{{ p.parts.join(', ') || '–' }}</td>
                  <td>
                    @if (p.used_in.length) { <span class="fw-yes" [title]="p.used_in.join(', ')">{{ 'yes' | t }}</span> }
                    @else { <span class="fw-no">{{ 'no' | t }}</span> }
                  </td>
                </tr>
              }
            </tbody>
          </table>
          @if (otherPins().length) {
            <details class="fw-more">
              <summary>{{ 'Other pins' | t }} · {{ otherPins().length }} <span style="opacity: .8">({{ 'power, ground, flash, not connected' | t }})</span></summary>
              <div class="fw-other">
                @for (p of otherPins(); track p.number) {
                  <span>{{ p.number }} {{ p.name }}</span><span>{{ p.net || kindName(p.kind) }}</span>
                }
              </div>
            </details>
          }
          <p class="fw-more">{{ 'From the schematic of' | t }} {{ f.board_title || f.board }} · {{ f.sheet_name }}.
            {{ 'pins.h is generated from these; when the board changes it is written again.' | t }}</p>
        </div>
      } @else if (side() === 'first') {
        <!-- FILES: the project, folders first; pins.h is the schematic's. -->
        <div class="fw-head"><b>{{ fw()!.title }}</b><span class="fw-tag ml-auto">v{{ fw()!.version }}</span></div>
        <div class="fw-scroll fw-tree">
          @for (d of tree(); track d.dir) {
            @if (d.dir) { <div class="fw-dir">▾ {{ d.dir }}</div> }
            @for (f of d.files; track f.path) {
              <button class="fw-file" [class.fw-top]="!d.dir" [attr.data-on]="file() === f.path ? 1 : null"
                      (click)="openFile(f.path)" [title]="f.path + ' · ' + f.bytes + ' B · v' + f.version">
                <span>{{ f.path.split('/').pop() }}</span>
                @if (f.generated) { <span class="fw-gen" [title]="'generated from the schematic - not edited by hand' | t">{{ 'from schematic' | t }}</span> }
              </button>
            }
          }
        </div>
      } @else {
        <!-- STATUS: ready to flash or not, and why. -->
        @let f = fw()!;
        @let b = f.build;
        <div class="fs">
          <section class="fs-verdict" [attr.data-tone]="verdict().tone">
            <span class="fs-mark" aria-hidden="true">{{ verdict().mark }}</span>
            <div class="fs-state">{{ verdict().text | t }}</div>
            <div class="fs-when">
              <span>{{ building() ? ('Building…' | t) : builtWhen() }}</span>
              @if (auth.can('run')) {
                <button class="tcv-btn fs-run" (click)="build()" [disabled]="building()">{{ 'Build again' | t }}</button>
                @if (serial().ok && manifest()) {
                  <button class="tcv-btn tcv-btn-accent fs-flash" (click)="openFlash()">{{ 'Flash' | t }}</button>
                }
              }
            </div>
          </section>
          @if (!serial().ok) {
            <div class="fs-note fs-needs">{{ serial().why | t }}.</div>
          }
          @if (f.board_change; as ch) {
            <div class="fs-note">{{ ch.text }}@if (ch.moved.length) { - @for (m of ch.moved; track m.net) { {{ m.net }} {{ m.from }}→{{ m.to }}@if (!$last) {,} } }</div>
          }
          <div class="fs-list">
            @for (c of cards(); track c.id) {
              <section class="fs-card" [attr.data-tone]="c.tone">
                <button class="fs-head" (click)="toggle(c.id)" [disabled]="!c.items.length">
                  <i class="fs-light" aria-hidden="true"></i>
                  <span class="fs-title">{{ c.title | t }}</span>
                  <span class="fs-status">{{ c.status }}</span>
                  <span class="fs-chev" [attr.data-open]="opened().has(c.id) ? 1 : null" aria-hidden="true">{{ c.items.length ? '›' : '' }}</span>
                  <span class="fs-line">{{ c.line }}</span>
                </button>
                @if (opened().has(c.id) && c.items.length) {
                  <div class="fs-items">
                    @for (it of c.items; track $index) {
                      @if (it.file) {
                        <button class="fs-item" (click)="openFile(it.file, it.line)"><i>{{ it.where }}</i> {{ it.text }}</button>
                      } @else {
                        <div class="fs-item">@if (it.where) { <i>{{ it.where }}</i> } {{ it.text }}</div>
                      }
                    }
                  </div>
                }
              </section>
            }
          </div>
          <div class="fs-meters">
            @for (m of meters(); track m.label) {
              <div class="fs-meter" [title]="m.title">
                <span>{{ m.label | t }}</span>
                <b>{{ m.pct != null ? m.pct + '%' : '–' }}</b>
                <div class="fs-bar" [attr.data-tone]="m.tone"><i [style.width.%]="m.pct ?? 0"></i></div>
                <small>{{ m.text }}</small>
              </div>
            }
          </div>
          <details class="fs-fold">
            <summary>{{ 'Advanced details' | t }}</summary>
            <div class="fs-deep">
              <div class="fs-files">
                <a [attr.href]="b?.artifacts?.['firmware.bin'] ? download('firmware.bin') : null"
                   [class.off]="!b?.artifacts?.['firmware.bin']" download>firmware.bin
                   @if (b?.artifacts?.['firmware.bin']; as a) { ({{ kbOf(a.bytes) }}) }</a>
                <a [attr.href]="b?.artifacts?.['firmware.elf'] ? download('firmware.elf') : null"
                   [class.off]="!b?.artifacts?.['firmware.elf']" download>firmware.elf
                   @if (b?.artifacts?.['firmware.elf']; as a) { ({{ kbOf(a.bytes) }}) }</a>
                @for (n of extraFiles; track n) {
                  @if (b?.artifacts?.[n]; as a) { <a [attr.href]="download(n)" download>{{ n }} ({{ kbOf(a.bytes) }})</a> }
                }
              </div>
              <div class="fs-facts">
                <span>platform</span><b>{{ f.platform }}</b>
                <span>board</span><b>{{ f.pio_board }} · {{ f.framework }}</b>
                <span>files</span><b>v{{ f.version }}@if (b?.version != null) { · {{ 'built' | t }} v{{ b?.version }} }</b>
                <span>MCU</span><b>{{ f.board }} {{ f.mcu }} ({{ f.sheet }})</b>
              </div>
              <div>{{ 'Compiler output' | t }}</div>
              <pre class="fs-raw">{{ rawLog() }}</pre>
            </div>
          </details>
        </div>
      }
    </div>

    <!-- THE VIEW -->
    <div view class="fw-view">
      @if (fw(); as f) {
        @if (view() === 'schematic') {
          @if (sheetUrl(); as url) {
            <app-drawing #flat [src]="url" [controls]="false" [marks]="marks()" (clicked)="sheetClick($event)" />
            @if (pin(); as p) {
              <span class="fw-hint">{{ p.macro || p.net }} · GPIO{{ p.gpio }} · {{ marks()?.rects?.length ?? 0 }} {{ 'labels' | t }}
                @if (anchorIsPin()) { · {{ 'the note is about this pin' | t }} }</span>
            }
          } @else {
            <p class="p-3 text-[12px]" style="color: var(--ink-dim)">{{ 'The board\\'s schematic is not drawn yet - build the board in PCB Design.' | t }}</p>
          }
        } @else if (view() === 'code') {
          <div class="flex h-full min-h-0 flex-col">
            <div class="fw-codehead"><b>{{ file() }}</b>
              @if (fileGenerated()) { <span class="fw-gen">{{ 'from schematic' | t }}</span> }
              @if (codeAnchor(); as a) {
                <span class="fw-tag" data-tone="ok">{{ 'note on' | t }} {{ a[0] }}@if (a[1] !== a[0]) {-{{ a[1] }}}</span>
              }
              <span class="ml-auto">{{ 'read only - select lines to write a note on them' | t }}</span></div>
            <div class="min-h-0 flex-1">
              <app-fw-code #code [text]="text()" [path]="file() ?? ''" [nets]="macros()" [line]="line()"
                           [anchor]="codeAnchor()" (picked)="pickLines($event)" />
            </div>
          </div>
        } @else {
          <!-- THE SERIAL MONITOR: the board's console, over USB, in this browser. -->
          <div class="fm">
            <div class="fm-bar">
              <span class="fm-dot" [attr.data-on]="monOn() ? 1 : null" aria-hidden="true"></span>
              <span class="fm-port">@if (monOn()) { {{ monPort() }} · {{ monBaud() }} } @else { {{ 'Not connected' | t }} }</span>
              <select class="tcv-field fm-baud" (change)="setBaud(+$any($event.target).value)"
                      [attr.aria-label]="'Baud rate' | t">
                @for (b of bauds; track b) { <option [value]="'' + b" [selected]="b === monBaud()">{{ b }}</option> }
              </select>
              <span class="fm-gap"></span>
              @if (monOn()) {
                <button class="tcv-btn fm-b" (click)="resetBoard()" [title]="'Restart the board (EN, through DTR/RTS)' | t">{{ 'Reset board' | t }}</button>
                <button class="tcv-btn fm-b" (click)="clearMonitor()">{{ 'Clear' | t }}</button>
                <button class="tcv-btn fm-b" (click)="disconnect()">{{ 'Disconnect' | t }}</button>
              } @else {
                <button class="tcv-btn fm-b" (click)="clearMonitor()" [disabled]="!monLines().length">{{ 'Clear' | t }}</button>
                <button class="tcv-btn tcv-btn-accent fm-b" (click)="connectMonitor()" [disabled]="!serial().ok">{{ 'Connect' | t }}</button>
              }
            </div>
            <div #monBox class="fm-lines" (scroll)="onMonScroll()">
              @for (l of monLines(); track l.id) {
                <div class="fm-line" [attr.data-kind]="l.kind"><span class="fm-ts">{{ stamp(l.at) }}</span><span class="fm-text">{{ l.text }}</span></div>
              } @empty {
                <p class="fm-empty">
                  @if (!serial().ok) { {{ serial().why | t }}. }
                  @else if (monOn()) { {{ 'Connected - waiting for the board to say something.' | t }} }
                  @else { {{ 'Plug the board in by USB and press Connect: its console prints here.' | t }} }
                </p>
              }
            </div>
            @if (monPaused() && monNew()) {
              <button class="tcv-chip fm-jump" (click)="monFollow()">↓ {{ monNew() }} {{ 'new lines' | t }}</button>
            }
            <form class="fm-send" (submit)="$event.preventDefault(); sendLine()">
              @for (q of quick(); track q) {
                <button type="button" class="tcv-chip fm-q" [disabled]="!monOn()" (click)="send(q)">{{ q }}</button>
              }
              <input #monIn class="tcv-field fm-in" [disabled]="!monOn()" [value]="monText()" (input)="monText.set($any($event.target).value)"
                     [placeholder]="'a command - Enter sends it' | t" autocomplete="off" spellcheck="false" />
              <button type="submit" class="tcv-btn fm-b" [disabled]="!monOn() || !monText().trim()">{{ 'Send' | t }}</button>
            </form>
          </div>
        }
      }
      @if (frozen() && shot(); as s) {
        <app-sketchpad #pad [shot]="s" [pen]="pen" />
      }
    </div>

    <!-- More than one firmware: which one. -->
    <ng-container ngProjectAs="[corner]">
      @if (list().length > 1) {
        <select class="tcv-field fw-pick px-1 py-0.5 text-[11px]" [value]="fw()?.id ?? ''"
                (change)="pick($any($event.target).value)">
          @for (o of list(); track o.id) { <option [value]="o.id">{{ o.title }} · {{ o.board_title || o.board }}</option> }
        </select>
      }
    </ng-container>
  </app-room-frame>
}
@if (flashOpen()) {
  <!-- FLASHING: Connect -> Flashing -> Verifying -> Done, in this browser. -->
  <div class="fl-scrim" (click)="closeFlash()"></div>
  <section class="fl-box" role="dialog" aria-modal="true" [attr.aria-label]="'Flash the board' | t">
    <header class="fl-head">
      <div class="min-w-0">
        <b>{{ 'Flash' | t }} {{ fw()?.title }}</b>
        @if (manifest(); as m) {
          <span class="fl-sub">{{ m.chip }} · v{{ m.version }} · {{ 'build of' | t }} {{ hhmmOf(m.built_at) }}</span>
        }
      </div>
      <button class="tcv-btn fl-x" (click)="closeFlash()" [disabled]="flashBusy()" [attr.aria-label]="'Close' | t">✕</button>
    </header>
    <ol class="fl-steps">
      @for (s of steps; track s.id; let i = $index) {
        <li [attr.data-state]="stepState(i)"><i>{{ i + 1 }}</i>{{ s.label | t }}</li>
      }
    </ol>
    @if (blocked(); as bl) {
      <p class="fl-msg" data-tone="warn">{{ blockedText() }}</p>
      <div class="fl-actions">
        @if (bl.reason !== 'running') {
          <button class="tcv-btn tcv-btn-accent" (click)="buildFirst()" [disabled]="building() || !auth.can('run')">{{ 'Build first' | t }}</button>
        }
        <button class="tcv-btn" (click)="closeFlash()">{{ 'Close' | t }}</button>
      </div>
    } @else if (manifest(); as m) {
      <ul class="fl-files">
        @for (f of m.files; track f.name; let i = $index) {
          <li [attr.data-state]="fileStates()[i]">
            <span class="fl-addr">0x{{ f.offset.toString(16) }}</span>
            <span class="fl-name">{{ f.name }}</span>
            <span class="fl-size">{{ kbOf(f.size) }}</span>
            <span class="fl-bar"><i [style.width.%]="fileProg()[i] || 0"></i></span>
            <span class="fl-word">{{ fileWord(i) | t }}</span>
          </li>
        }
      </ul>
      @switch (flashStep()) {
        @case ('ready') {
          <p class="fl-msg">{{ 'Plug the board in by USB, press Connect and pick its port (USB-SERIAL CH340 or USB2.0-Serial). It goes into its bootloader by itself.' | t }}</p>
        }
        @case ('connecting') { <p class="fl-msg">{{ 'Connecting - resetting the board into its bootloader…' | t }}</p> }
        @case ('flashing') { <p class="fl-msg">{{ 'Writing' | t }} {{ m.files[curFile()]?.name }} · {{ flashBaud() }} baud</p> }
        @case ('verifying') { <p class="fl-msg">{{ 'Verifying' | t }} {{ m.files[curFile()]?.name }} (MD5)…</p> }
        @case ('done') {
          <p class="fl-msg" data-tone="ok">{{ 'Flashed and verified' | t }} · {{ flashChip() }} · {{ flashSecs() }} s · {{ flashBaud() }} baud.
            {{ 'The board restarted; the serial monitor is open.' | t }}</p>
        }
        @case ('error') {
          @if (flashErr(); as e) {
            <p class="fl-msg" data-tone="error"><b>{{ e.text | t }}</b> {{ (e.hint ?? '') | t }}</p>
          }
        }
      }
      @if (flashStep() !== 'done') {
        <p class="fl-hint">{{ 'If it does not connect: hold BOOT, tap RST, let go of BOOT, then press Connect again.' | t }}</p>
      }
      <div class="fl-actions">
        @if (flashStep() === 'ready' || flashStep() === 'error') {
          <button class="tcv-btn tcv-btn-accent" (click)="startFlash(false)">{{ (flashStep() === 'error' ? 'Try again' : 'Connect') | t }}</button>
          @if (knownPort()) {
            <button class="tcv-btn" (click)="startFlash(true)" [title]="knownPortName()">{{ 'Another port…' | t }}</button>
          }
          <button class="tcv-btn" (click)="closeFlash()">{{ 'Cancel' | t }}</button>
        } @else if (flashStep() === 'done') {
          <button class="tcv-btn tcv-btn-accent" (click)="closeFlash()">{{ 'Close' | t }}</button>
        } @else {
          <span class="fl-busy">{{ 'Keep the board plugged in…' | t }}</span>
        }
      </div>
      @if (flashLog().length) {
        <details class="fl-log"><summary>esptool · {{ flashLog().length }}</summary><pre>{{ flashLogText() }}</pre></details>
      }
    } @else {
      <p class="fl-msg">{{ 'Reading the build…' | t }}</p>
    }
  </section>
}
</div>`,
})
export class RoomFirmware implements OnDestroy {
  private http = inject(HttpClient);
  picked = inject(Selection);
  auth = inject(Auth);
  private prefs = inject(Prefs);
  flat = viewChild<Drawing>('flat');
  private code = viewChild<FwCode>('code');
  pad = viewChild<Sketchpad>('pad');

  // ---- the pen: a note on a pin or on lines of code ----
  readonly pen = new PenState();
  frozen = signal(false);
  shot = signal<string | null>(null);
  /** The note's anchor is the room's pick: a pin, or lines of the open file. */
  anchorIsPin = computed(() => {
    const a = this.picked.fwAnchor(), p = this.pin();
    return !!a && !!p && (a.kind === 'pin' || a.kind === 'net') && a.pin === p.number;
  });
  codeAnchor = computed<[number, number] | null>(() => {
    const a = this.picked.fwAnchor();
    return a?.kind === 'code' && a.file === this.file() && a.lines ? a.lines : null;
  });

  list = signal<Firmware[]>([]);
  fw = signal<FirmwareDetail | null>(null);
  loading = signal(true);
  note = signal('');
  making = signal(false);
  mcusHere = signal<Mcu[]>([]);
  files = signal<FwFile[]>([]);
  file = signal<string | null>(null);
  text = signal('');
  line = signal<number | null>(null);
  log = signal<LogLine[]>([]);
  pin = signal<FwPin | null>(null);
  private svgText = signal<string | null>(null);
  private svgFor = '';
  opened = signal<Set<string>>(new Set(['builds', 'flash']));

  view = signal<View>(RoomFirmware.recall('view', 'schematic') === 'code' ? 'code' : 'schematic');
  side = signal<Side>(RoomFirmware.recall('side', 'first') === 'status' ? 'status' : 'first');
  readonly sideTabs = ['first', 'status'] as const;
  readonly tabNames = computed(() => ({ first: this.view() === 'code' ? t('Files') : t('Pins'),
                                        status: t('Status') }));

  private timer = setInterval(() => this.tick(), 3000);
  private filesAt = -1;

  constructor() {
    const q = new URLSearchParams(location.search).get('fw');
    if (q && !this.picked.firmware()) this.picked.firmware.set(q);
    this.readList();
    // Opened from the catalog (or the PCB room): the room follows.
    effect(() => {
      const want = this.picked.firmware();
      untracked(() => { if (want && want !== this.fw()?.id) this.load(want); });
    });
    // With nothing to open, the board open in PCB Design offers its MCUs.
    effect(() => {
      const b = this.picked.board();
      untracked(() => {
        if (!b) { this.mcusHere.set([]); return; }
        this.http.get<Mcu[]>(`/api/boards/${encodeURIComponent(b)}/mcus`).subscribe({
          next: m => this.mcusHere.set(m), error: () => this.mcusHere.set([]) });
      });
    });
    // The note's form offers the pins by their macros; its picture is the
    // view on screen until the pen holds it still.
    effect(() => { const m = this.macros(); untracked(() => this.picked.fwParts.set(m)); });
    this.picked.fwDraft.set(() => this.viewShot());
    // A note filed lets the view go.
    let filed = this.picked.fwFiled();
    effect(() => {
      const n = this.picked.fwFiled();
      if (n !== filed) { filed = n; untracked(() => { if (this.frozen()) this.resume(); }); }
    });
    // "Open in Firmware" from a note's card: the file at the line, or the pin.
    let jumped = 0;
    effect(() => {
      const j = this.picked.fwJump(), f = this.fw(), files = this.files();
      if (!j || j.n === jumped || !f || f.id !== j.firmware || !files.length) return;
      jumped = j.n;
      untracked(() => {
        const a = j.anchor;
        if (j.file || a?.kind === 'code') {
          const path = j.file ?? a!.file!;
          if (files.some(x => x.path === path)) this.openFile(path, j.line ?? a?.lines?.[0]);
        } else if (a) {
          const p = f.pins.find(x => x.number === a.pin);
          if (p) { this.setView('schematic'); this.pin.set(p); this.centerWanted = true; }
        }
      });
    });
    // The sheet's text, to find a net's labels in it.
    effect(() => {
      const url = this.sheetUrl();
      untracked(() => {
        if (!url || url === this.svgFor) return;
        this.svgFor = url;
        this.svgText.set(null);
        this.http.get(url, { responseType: 'text' }).subscribe({ next: s => this.svgText.set(s), error: () => {} });
      });
    });
  }

  ngOnDestroy() {
    clearInterval(this.timer);
    this.link.close().catch(() => {});
    this.picked.fwDraft.set(null);
    this.picked.fwParts.set([]);
  }

  /** Hold the view still - the sheet as it is zoomed, or the code lines on
   *  screen - and put the pad over it. */
  async freeze() {
    const shot = await this.viewShot();
    if (!shot) { this.note.set(t('nothing on screen to draw on yet')); return; }
    this.shot.set(shot);
    this.frozen.set(true);
    this.picked.fwDraft.set(() => this.pad()?.merged() ?? Promise.resolve(null));
  }

  resume() {
    this.frozen.set(false);
    this.shot.set(null);
    this.picked.fwDraft.set(() => this.viewShot());
  }

  /** What is on screen as the note's picture: the sheet with the picked
   *  net's labels boxed, or the code with the anchored lines banded. */
  private async viewShot(): Promise<string | null> {
    if (this.view() === 'schematic') return this.sheetShot();
    if (this.view() === 'code') return this.codeShot();
    return null;
  }

  private async sheetShot(): Promise<string | null> {
    const d = this.flat();
    if (!d?.ready()) return null;
    const url = d.snapshot();
    const mk = this.marks();
    if (!mk?.rects.length) return url;
    const img = new Image();
    await new Promise(done => { img.onload = img.onerror = done; img.src = url; });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const x = c.getContext('2d')!;
    x.drawImage(img, 0, 0);
    const box = d.host().nativeElement;
    const k = c.width / (box.clientWidth || 1);
    x.strokeStyle = tokenColour('--accent');
    x.lineWidth = 2 * k;
    for (const r of mk.rects) {
      const px = d.x() + ((r.x - mk.box[0]) / mk.box[2]) * d.w(), py = d.y() + ((r.y - mk.box[1]) / mk.box[3]) * d.h();
      const pw = (r.w / mk.box[2]) * d.w(), ph = (r.h / mk.box[3]) * d.h();
      x.strokeRect(px * k - 3 * k, py * k - 3 * k, pw * k + 6 * k, ph * k + 6 * k);
    }
    return c.toDataURL('image/png');
  }

  private codeShot(): string | null {
    const host = this.code(), path = this.file();
    if (!host || !path) return null;
    const box = document.querySelector<HTMLElement>('.fw-view');
    const w = box?.clientWidth || 900, h = box?.clientHeight || 520;
    const all = this.text().split('\n');
    const a = this.codeAnchor();
    const rows = Math.max(8, Math.floor((h - 30) / 18));
    // What is on screen, from its first line - moved down to the anchored
    // lines when they would fall outside the picture.
    let first = host.visible()?.first ?? 1;
    if (a && (a[0] < first || a[1] > first + rows - 1)) first = Math.max(1, a[0] - 3);
    return codePicture(w, h, path, all.slice(first - 1, first - 1 + rows), first, a);
  }

  /** A pin of the sheet clicked: the pin whose net (or name) label is
   *  under the click. */
  sheetClick(at: { fx: number; fy: number }) {
    const svg = this.svgText(), pins = this.signalPins();
    if (!svg || !pins.length || this.frozen()) return;
    const words = pins.flatMap(p => [p.net ?? '', p.name]).filter(Boolean);
    const got = labelBoxes(svg, words);
    if (!got) return;
    const [bx, by, bw, bh] = got.box;
    const x = bx + at.fx * bw, y = by + at.fy * bh, slack = bw / 300;
    const hit = got.labels.find(l => x >= l.rect.x - slack && x <= l.rect.x + l.rect.w + slack
                                     && y >= l.rect.y - slack && y <= l.rect.y + l.rect.h + slack);
    if (!hit) return;
    const byNet = pins.find(p => p.net === hit.word);
    const p = byNet ?? pins.find(p => p.name === hit.word);
    if (!p) return;
    this.pin.set(p);
    this.anchorPin(p, byNet ? 'net' : 'pin');
  }

  private anchorPin(p: FwPin, kind: 'pin' | 'net' = 'pin') {
    this.picked.fwAnchor.set({ kind, pin: p.number, name: p.name, net: p.net, macro: p.macro || null,
                               gpio: p.gpio, parts: p.parts });
  }

  /** Lines selected in the code: the note's anchor. */
  pickLines(lines: [number, number]) {
    const f = this.file();
    if (!f || this.frozen()) return;
    this.picked.fwAnchor.set({ kind: 'code', file: f, lines });
  }

  // ---- what is shown ----

  sheetUrl = computed(() => {
    const f = this.fw();
    if (!f?.svg) return null;
    const stamp = encodeURIComponent(f.board_now + '-' + (f.updated_at ?? ''));
    return f.svg + '?v=' + stamp + (isLightTheme(this.prefs.theme()) ? '&light=1' : '');
  });
  signalPins = computed(() => (this.fw()?.pins ?? []).filter(p => p.kind === 'gpio'));
  otherPins = computed(() => (this.fw()?.pins ?? []).filter(p => p.kind !== 'gpio'));
  macros = computed(() => (this.fw()?.pins ?? []).map(p => p.macro).filter(Boolean));
  building = computed(() => this.fw()?.build?.state === 'running');
  fileGenerated = computed(() => this.files().find(f => f.path === this.file())?.generated ?? false);

  marks = computed<DrawingMarks | null>(() => {
    const p = this.pin(), svg = this.svgText();
    if (!p || !svg) return null;
    return textBoxes(svg, [p.net ?? '', p.name]);
  });

  /** The files as a tree: folders first (include, src, lib), then the top. */
  tree = computed(() => {
    const dirs = new Map<string, FwFile[]>();
    for (const f of this.files()) {
      const i = f.path.lastIndexOf('/');
      const d = i < 0 ? '' : f.path.slice(0, i);
      if (!dirs.has(d)) dirs.set(d, []);
      dirs.get(d)!.push(f);
    }
    return [...dirs.entries()]
      .sort((a, b) => (a[0] === '' ? 1 : 0) - (b[0] === '' ? 1 : 0) || a[0].localeCompare(b[0]))
      .map(([dir, files]) => ({ dir, files: files.sort((x, y) => x.path.localeCompare(y.path)) }));
  });

  verdict = computed<{ tone: Tone; mark: string; text: string }>(() => {
    const f = this.fw(), b = f?.build;
    if (!f) return { tone: 'none', mark: '…', text: 'Reading…' };
    if (b?.state === 'running' && !b.last) return { tone: 'none', mark: '…', text: 'Building…' };
    const state = b?.state === 'running' ? b.last : b?.state;
    if (!state) return { tone: 'none', mark: '–', text: 'Not built yet' };
    if (state === 'ok' && f.matches && !(b?.warning_count) && b?.version === f.version)
      return { tone: 'ok', mark: '✓', text: 'Ready to flash' };
    return { tone: state === 'ok' ? 'warn' : 'error', mark: '!', text: 'Needs attention' };
  });

  /** The clock "2 min ago" is read against: moved on by the poll, so a
   *  check of the page never sees it change under it. */
  private now = signal(Date.now());
  builtWhen = computed(() => {
    const b = this.fw()?.build;
    if (!b?.state || b.state === 'running') return b?.state === 'running' ? t('Building…') : '';
    const what = b.state === 'ok' ? t('built') : b.state === 'errors' ? t('build failed') : t('the build did not run');
    return `${what} · ${ago(b.at, this.now())}${b.seconds != null ? ' · ' + b.seconds + ' s' : ''}`;
  });

  cards = computed(() => {
    const f = this.fw();
    if (!f) return [];
    const b = f.build ?? {};
    const out: { id: string; title: string; tone: Tone; status: string; line: string;
                 items: { where: string; text: string; file?: string; line?: number }[] }[] = [];
    const errs = b.errors ?? [], warns = b.warnings ?? [];
    const built = !!b.state && b.state !== 'running';
    const stale = built && b.version != null && b.version !== f.version;
    out.push({
      id: 'builds', title: 'Builds',
      tone: !built ? 'none' : b.state === 'ok' ? (warns.length || stale ? 'warn' : 'ok') : 'error',
      status: !built ? '–' : `${b.error_count ?? 0} ${t('errors')} · ${b.warning_count ?? 0} ${t('warnings')}`,
      line: !built ? t('Not built yet - press Build.')
        : stale ? `${t('The code changed since the last build')} (v${b.version} → v${f.version}).`
        : b.state === 'ok' ? `${t('Compiles with PlatformIO')} (${f.pio_board}, ${f.framework}).`
        : (b.detail || t('The compiler stopped - the errors are below.')),
      items: [...errs.map(e => ({ where: `${e.file}${e.line ? ':' + e.line : ''}`, text: e.text, ...this.at(e) })),
              ...warns.map(w => ({ where: `${w.file}${w.line ? ':' + w.line : ''}`, text: '⚠ ' + w.text, ...this.at(w) }))],
    });
    const ch = f.board_change;
    out.push({
      id: 'pins', title: 'Pins match the board',
      tone: !f.found ? 'error' : f.matches ? 'ok' : 'warn',
      status: `board v${f.board_now}`,
      line: !f.found ? t('This MCU is not on the board\'s schematic any more.')
        : f.matches ? `${t('pins.h is the board\'s pin map')} (${f.sheet_name ?? f.sheet}).`
        : t('The board changed - pins.h will be written again.'),
      items: ch ? [...ch.moved.map(m => ({ where: m.net, text: `GPIO${m.from} → GPIO${m.to}` })),
                   ...ch.added.map(n => ({ where: n, text: t('new') })), ...ch.removed.map(n => ({ where: n, text: t('gone') }))] : [],
    });
    const lf = f.last_flash, m = this.manifest(), bl = this.blocked();
    out.push({
      id: 'flash', title: 'Flashing',
      tone: lf ? (lf.ok ? 'ok' : 'error') : 'none',
      status: m ? `${m.files.length} ${t('files')} · ${m.chip}` : bl ? t('build first') : '–',
      line: lf ? `${lf.ok ? t('Flashed') : t('Flash failed')} ${ago(lf.at, this.now())}`
                 + (lf.build_at ? ` · ${t('build of')} ${hhmm(lf.build_at)}` : '')
                 + (lf.mac ? ` · …${lf.mac}` : '') + (lf.error ? ` · ${lf.error}` : '')
        : t('Not flashed yet - the image below is what Flash writes, from this browser over USB.'),
      items: m ? m.files.map(x => ({ where: '0x' + x.offset.toString(16).padStart(5, '0'),
                                     text: `${x.name} · ${kb(x.size)} · sha256 ${x.sha256.slice(0, 12)}…` }))
        : bl ? [{ where: '', text: this.blockedText() }] : [],
    });
    const unused = this.signalPins().filter(p => p.macro && !p.used_in.length);
    out.push({
      id: 'unused', title: 'Unused pins', tone: unused.length ? 'none' : 'ok',
      status: `${unused.length}`,
      line: unused.length ? t('On the board, not named in the code - free, or not done yet.') : t('Every pin on the board is used in the code.'),
      items: unused.map(p => ({ where: p.macro, text: `GPIO${p.gpio} · ${p.parts.join(', ') || '–'}` })),
    });
    return out;
  });

  meters = computed(() => {
    const b = this.fw()?.build;
    const one = (label: string, s: Size | null | undefined) => ({
      label, pct: s ? Math.round(s.pct * 10) / 10 : null,
      tone: (s && s.pct > 90 ? 'error' : s && s.pct > 75 ? 'warn' : 'ok') as Tone,
      text: s ? `${kb(s.used)} / ${kb(s.total)}` : t('after a build'),
      title: s ? `${s.used} / ${s.total} bytes` : '',
    });
    return [one('Flash', b?.flash), one('RAM', b?.ram)];
  });

  rawLog = computed(() => this.log().map(l => l.text).join('\n'));

  private at(d: Diag): { file?: string; line?: number } {
    const path = d.file.replace(/^\/project\//, '');
    return this.files().some(f => f.path === path) ? { file: path, line: d.line ?? undefined } : {};
  }

  kindName(k: FwPin['kind']): string {
    return { power: t('power'), ground: t('ground'), flash: t('module flash'), nc: t('not connected'),
             other: t('other'), gpio: 'GPIO' }[k];
  }
  kbOf(n: number) { return kb(n); }
  download(name: string): string { return `/api/firmware/${this.fw()?.id}/download/${name}`; }

  // ---- what is done ----

  setView(v: View) {
    if (this.frozen() && v !== this.view()) this.resume();
    this.view.set(v);
    if (v !== 'monitor') RoomFirmware.keep('view', v);
    if (v === 'monitor') this.readQuick();
    if (v === 'code' && !this.file()) this.openFile(this.defaultFile());
  }
  setSide(s: Side) { this.side.set(s); RoomFirmware.keep('side', s); }
  toggle(id: string) {
    this.opened.update(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  pick(id: string) { if (id) this.picked.firmware.set(id); }

  pickPin(p: FwPin) {
    const off = this.pin()?.number === p.number;
    this.pin.set(off ? null : p);
    this.centerWanted = true;
    // The pin picked is what a note written now is about.
    const a = this.picked.fwAnchor();
    if (off) { if (a && a.kind !== 'code') this.picked.fwAnchor.set(null); }
    else this.anchorPin(p);
  }
  /** A pin picked: its labels brought to the middle once they are found
   *  (the sheet's text may still be on its way). */
  private centerWanted = false;
  private centering = effect(() => {
    const mk = this.marks(), d = this.flat(), ready = d?.ready();
    if (!mk?.rects.length || !d || !ready || !this.centerWanted) return;
    this.centerWanted = false;
    untracked(() => setTimeout(() => d.centerOn(mk.box, mk.rects[0]), 0));
  });

  openFile(path: string, line?: number) {
    this.file.set(path);
    this.line.set(line ?? null);
    if (this.view() !== 'code') this.setView('code');
    const id = this.fw()?.id;
    if (!id) return;
    this.http.get<{ content: string }>(`/api/firmware/${id}/files/${path}`).subscribe({
      next: r => { if (this.file() === path) this.text.set(r.content); },
      error: () => this.text.set(''),
    });
  }

  private defaultFile(): string {
    const paths = this.files().map(f => f.path);
    return paths.find(p => p === 'src/main.cpp') ?? paths.find(p => p.startsWith('src/')) ?? paths[0] ?? 'platformio.ini';
  }

  build() {
    const id = this.fw()?.id;
    if (!id || this.building()) return;
    this.http.post(`/api/firmware/${id}/build`, {}).subscribe({
      next: () => { this.setSide('status'); this.tick(); },
      error: e => this.note.set(e?.error?.detail?.detail ?? e?.error?.detail ?? 'the build could not start'),
    });
  }

  create(board: string, mcu: string) {
    this.making.set(true);
    this.http.post<Firmware>(`/api/boards/${encodeURIComponent(board)}/firmware`, { mcu }).subscribe({
      next: f => { this.making.set(false); this.readList(); this.picked.firmware.set(f.id); },
      error: e => { this.making.set(false); this.note.set(e?.error?.detail ?? 'could not make it'); },
    });
  }

  private readList() {
    this.http.get<Firmware[]>('/api/firmware').subscribe({
      next: rows => {
        this.list.set(rows);
        if (!this.picked.firmware()) {
          const last = RoomFirmware.recall('open', '');
          const first = rows.find(r => r.id === last) ?? rows[0];
          if (first) this.picked.firmware.set(first.id);
          else this.loading.set(false);
        }
      },
      error: () => { this.loading.set(false); this.note.set('could not read the firmware list'); },
    });
  }

  private load(id: string) {
    this.loading.set(true);
    this.fw.set(null);
    this.pin.set(null);
    this.files.set([]);
    this.file.set(null);
    this.text.set('');
    this.log.set([]);
    this.filesAt = -1;
    if (this.frozen()) this.resume();
    this.picked.fwAnchor.set(null);
    RoomFirmware.keep('open', id);
    this.read(id, true);
  }

  private read(id: string, first = false) {
    this.http.get<FirmwareDetail>(`/api/firmware/${id}`).subscribe({
      next: f => {
        if (this.picked.firmware() !== id) return;
        this.fw.set(f);
        this.loading.set(false);
        if (f.version !== this.filesAt) this.readFiles(id, f.version);
        if (first || f.build?.state === 'running' || this.log().length === 0) this.readLog(id);
      },
      error: () => {
        this.loading.set(false);
        if (first) { this.note.set(`no firmware ${id}`); this.picked.firmware.set(null); }
      },
    });
  }

  private readFiles(id: string, version: number) {
    this.http.get<FwFile[]>(`/api/firmware/${id}/files`).subscribe({
      next: rows => {
        this.files.set(rows);
        this.filesAt = version;
        if (this.view() === 'monitor') this.readQuick();
        const want = this.file() ?? (this.view() === 'code' ? this.defaultFile() : null);
        if (want) this.openFile(want, this.line() ?? undefined);
      },
    });
  }

  private readLog(id: string) {
    this.http.get<LogLine[]>(`/api/firmware/${id}/log`).subscribe({ next: rows => this.log.set(rows) });
  }

  private wasBuilding = false;
  private tick() {
    this.now.set(Date.now());
    const id = this.fw()?.id;
    if (!id) return;
    const before = this.building();
    this.read(id);
    if (before || this.wasBuilding) this.readLog(id);
    this.wasBuilding = before;
  }

  // ---- flashing and the serial monitor (flasher.ts) ----

  readonly serial = signal(webSerialSupport(browserEnv()));
  readonly steps = [{ id: 'connect', label: 'Connect' }, { id: 'flash', label: 'Flashing' },
                    { id: 'verify', label: 'Verifying' }, { id: 'done', label: 'Done' }] as const;
  readonly bauds = BAUDS;
  readonly extraFiles = ['bootloader.bin', 'partitions.bin', 'boot_app0.bin'];
  manifest = signal<FlashManifest | null>(null);
  blocked = signal<{ reason: string; detail: string } | null>(null);
  flashOpen = signal(false);
  flashStep = signal<FlashStep>('ready');
  fileProg = signal<number[]>([]);
  fileStates = signal<FileState[]>([]);
  curFile = signal(0);
  flashErr = signal<Plain | null>(null);
  flashLog = signal<string[]>([]);
  flashLogText = computed(() => this.flashLog().join('\n'));
  flashBaud = signal<number | null>(null);
  flashChip = signal('');
  flashSecs = signal<number | null>(null);
  flashBusy = computed(() => ['connecting', 'flashing', 'verifying'].includes(this.flashStep()));
  knownPort = signal<SerialPort | null>(null);
  knownPortName = computed(() => portLabel(this.knownPort()));
  /** How far each step got, for the four steps across the dialog's top. */
  private failedAt = signal(0);

  monitorTip = computed(() => this.serial().ok ? t('Serial monitor - the board\'s console, over USB') : t(this.serial().why));
  flashTip = computed(() => {
    if (!this.serial().ok) return t(this.serial().why);
    if (!this.auth.can('run')) return t('Flash - needs the right to run builds');
    return t('Flash - write the last build to the board, from this browser over USB');
  });

  monLines = signal<SerialLine[]>([]);
  monOn = signal(false);
  monPort = signal('');
  monBaud = signal(115200);
  monPaused = signal(false);
  monNew = signal(0);
  monText = signal('');
  quick = signal<string[]>([]);
  private monBox = viewChild<ElementRef<HTMLDivElement>>('monBox');
  private monIn = viewChild<ElementRef<HTMLInputElement>>('monIn');
  private monSeq = 0;
  private monPending: SerialLine[] = [];
  private monFrame = 0;
  private quickFor = '';
  private link = new SerialLink(text => this.addLine(text, 'rx'), why => {
    this.monOn.set(false);
    if (why) this.addLine(`${t('disconnected')}: ${t(why)}`, 'error');
  });

  /** The build Flash would write, read again when the build or the code moves on. */
  private manifestKey = '';
  private manifestWatch = effect(() => {
    const f = this.fw();
    const key = f ? `${f.id}:${f.version}:${f.build?.job}:${f.build?.state}` : '';
    untracked(() => {
      if (key === this.manifestKey) return;
      this.manifestKey = key;
      if (!f) { this.manifest.set(null); this.blocked.set(null); return; }
      this.readManifest(f.id);
    });
  });

  private readManifest(id: string, then?: () => void) {
    this.http.get<FlashManifest>(`/api/firmware/${id}/flash-manifest`).subscribe({
      next: m => {
        if (this.fw()?.id !== id) return;
        this.manifest.set(m);
        this.blocked.set(null);
        if (!this.monOn() && !this.monTouched) this.monBaud.set(m.monitor_baud || 115200);
        then?.();
      },
      error: e => {
        if (this.fw()?.id !== id) return;
        this.manifest.set(null);
        const d = e?.error?.detail;
        this.blocked.set(d?.reason ? d : { reason: 'error', detail: t('The build could not be read.') });
        then?.();
      },
    });
  }
  private monTouched = false;

  /** Why there is nothing to flash, in the reader's language. */
  blockedText = computed(() => {
    const bl = this.blocked(), f = this.fw();
    if (!bl) return '';
    switch (bl.reason) {
      case 'never': return t('Not built yet - build it first.');
      case 'running': return t('A build is running - wait for it to finish.');
      case 'failed': return t('The last build failed - fix it and build again before flashing.');
      case 'stale': return `${t('The code changed since the last build')} (v${f?.build?.version} → v${f?.version}) - ${t('build first.')}`;
      case 'missing': return t('This build is from before flashing (no bootloader or partition table) - build again.');
      default: return bl.detail;
    }
  });

  hhmmOf(at: string | null | undefined) { return hhmm(at); }

  stepState(i: number): 'done' | 'now' | 'error' | 'wait' {
    const at = { blocked: 0, ready: 0, connecting: 0, flashing: 1, verifying: 2, done: 3, error: this.failedAt() }[this.flashStep()];
    if (this.flashStep() === 'done') return 'done';
    if (this.flashStep() === 'error' && i === at) return 'error';
    if (this.flashStep() === 'blocked' && i === 0) return 'error';
    return i < at ? 'done' : i === at && this.flashStep() !== 'ready' ? 'now' : i === 0 && this.flashStep() === 'ready' ? 'now' : 'wait';
  }

  fileWord(i: number): string {
    const s = this.fileStates()[i] ?? 'wait';
    return s === 'done' ? 'verified' : s === 'verify' ? 'verifying' : s === 'write' ? `${Math.round(this.fileProg()[i] ?? 0)}%` : '';
  }

  openFlash() {
    const f = this.fw();
    if (!f || !this.serial().ok) return;
    this.flashOpen.set(true);
    this.resetFlash();
    this.manifest.set(null);
    this.readManifest(f.id, () => this.flashStep.set(this.blocked() ? 'blocked' : 'ready'));
    rememberedPort().then(p => this.knownPort.set(p)).catch(() => {});
  }

  private resetFlash() {
    this.flashStep.set('ready');
    this.flashErr.set(null);
    this.flashLog.set([]);
    this.fileProg.set([]);
    this.fileStates.set([]);
    this.curFile.set(0);
    this.failedAt.set(0);
    this.flashSecs.set(null);
  }

  closeFlash() { if (!this.flashBusy()) this.flashOpen.set(false); }

  buildFirst() {
    this.flashOpen.set(false);
    this.build();
  }

  /** Connect (a click: the browser asks for the port only then), download
   *  and check the files, write them, verify, reset - then the monitor. */
  async startFlash(other: boolean) {
    const f = this.fw();
    let m = this.manifest();
    if (!f || !m || this.flashBusy()) return;
    let port: SerialPort;
    try {
      port = (!other && this.knownPort()) || await choosePort();
    } catch (e) {
      const p = plainError(e);
      if ((e as { name?: string })?.name !== 'NotFoundError') { this.flashErr.set(p); this.flashStep.set('error'); }
      return;
    }
    this.knownPort.set(port);
    this.resetFlash();
    this.flashStep.set('connecting');
    const log = (line: string) => this.flashLog.update(l => [...l.slice(-400), line.replace(/\s+$/, '')]);
    // The monitor holds the same port: let go of it first.
    if (this.monOn()) { await this.link.close(); log(t('serial monitor closed for flashing')); }
    let flashId: string | null = null;
    const t0 = performance.now();
    try {
      const blobs: Record<string, Uint8Array> = {};
      for (const file of m.files) {
        const r = await fetch(file.url, { credentials: 'same-origin' });
        if (r.status === 409) throw new Error(t('A newer build came in - open Flash again.'));
        if (!r.ok) throw new Error(`${file.name}: ${r.status} ${r.statusText}`);
        const data = new Uint8Array(await r.arrayBuffer());
        const sum = hexOf(await crypto.subtle.digest('SHA-256', data));
        if (sum !== file.sha256) throw new Error(`${file.name}: ${t('the download does not match the build (sha256)')}`);
        blobs[file.name] = data;
      }
      const files = fileArray(m, blobs);
      this.fileProg.set(files.map(() => 0));
      this.fileStates.set(files.map(() => 'wait' as FileState));
      try {
        const rec = await this.post<{ id: string }>(`/api/firmware/${f.id}/flashes`, { build_job: m.build_job });
        flashId = rec?.id ?? null;
      } catch { /* the flash does not wait for its record */ }
      const order = [...m.files].sort((a, b) => a.offset - b.offset).map(x => m!.files.indexOf(x));
      const progress = (p: FlashProgress) => {
        this.flashBaud.set(p.baud ?? null);
        if (p.phase === 'connecting') { this.flashStep.set('connecting'); return; }
        if (p.phase === 'resetting') return;
        const i = order[p.file ?? 0] ?? 0;
        this.curFile.set(i);
        const pct = p.total ? Math.min(100, (100 * (p.written ?? 0)) / p.total) : 0;
        this.fileProg.update(a => a.map((v, k) => (k === i ? pct : v)));
        this.fileStates.update(a => a.map((v, k) => k === i ? (p.phase === 'verifying' ? 'verify' : 'write')
                                                       : order.indexOf(k) < (p.file ?? 0) ? 'done' : v));
        this.flashStep.set(p.phase === 'verifying' ? 'verifying' : 'flashing');
      };
      let got;
      try {
        got = await flashImage(port, m, files, m.baud, progress, log);
      } catch (e) {
        const p = plainError(e);
        if (e instanceof WrongChip || /in use|went away/.test(p.text) || m.baud === m.fallback_baud) throw e;
        log(`${t('failed at')} ${m.baud} baud (${(e as Error)?.message ?? e}) - ${t('trying again at')} ${m.fallback_baud}`);
        this.fileProg.set(files.map(() => 0));
        this.fileStates.set(files.map(() => 'wait' as FileState));
        got = await flashImage(port, m, files, m.fallback_baud, progress, log);
      }
      this.fileProg.set(files.map(() => 100));
      this.fileStates.set(files.map(() => 'done' as FileState));
      this.flashChip.set(got.description);
      this.flashSecs.set(got.secs);
      this.flashBaud.set(got.baud);
      this.flashStep.set('done');
      await this.endFlash(f.id, flashId, m.build_job, { ok: true, chip: got.description, mac: macTail(got.mac),
                                                         secs: got.secs, baud: got.baud });
      // The board restarted with the new code: listen to it.
      this.setView('monitor');
      await this.openMonitor(port, true);
    } catch (e) {
      const p: Plain = e instanceof WrongChip
        ? { text: `${t('This board has an')} ${e.found}; ${t('the firmware is built for')} ${e.want}.`,
            hint: t('Pick the port of the right board.') }
        : plainError(e);
      this.failedAt.set(this.flashStep() === 'connecting' ? 0 : this.flashStep() === 'verifying' ? 2 : 1);
      this.flashErr.set(p);
      this.flashStep.set('error');
      log(`error: ${(e as Error)?.message ?? e}`);
      await this.endFlash(f.id, flashId, m.build_job, {
        ok: false, error: p.text, chip: e instanceof WrongChip ? e.found : null,
        secs: Math.round((performance.now() - t0) / 100) / 10, baud: this.flashBaud() });
    }
  }

  private async endFlash(fid: string, flashId: string | null, buildJob: string, body: Record<string, unknown>) {
    try {
      await this.post(flashId ? `/api/firmware/${fid}/flashes/${flashId}` : `/api/firmware/${fid}/flashes`,
                      flashId ? body : { ...body, build_job: buildJob });
    } catch { /* recorded or not, the board is what it is */ }
    this.tick();
  }

  private post<R>(url: string, body: unknown): Promise<R> {
    return new Promise((resolve, reject) => this.http.post<R>(url, body).subscribe({ next: resolve, error: reject }));
  }

  // the monitor

  toggleMonitor() {
    if (this.view() === 'monitor') { this.setView(RoomFirmware.recall('view', 'schematic') === 'code' ? 'code' : 'schematic'); return; }
    this.setView('monitor');
  }

  /** Connect: the port of this session, or the browser asks (a click). */
  async connectMonitor() {
    let port = this.knownPort() ?? await rememberedPort();
    try {
      if (!port) port = await choosePort();
      this.knownPort.set(port);
      await this.openMonitor(port, false);
    } catch (e) {
      if ((e as { name?: string })?.name === 'NotFoundError') return;
      const p = plainError(e);
      this.addLine(`${t(p.text)} ${p.hint ? t(p.hint) : ''}`, 'error');
    }
  }

  private async openMonitor(port: SerialPort, reset: boolean) {
    await this.link.connect(port, this.monBaud(), reset);
    this.monOn.set(true);
    this.monPort.set(portLabel(port));
    this.addLine(`${t('connected')} · ${portLabel(port)} · ${this.monBaud()} baud${reset ? ' · ' + t('board reset') : ''}`, 'info');
    setTimeout(() => this.monIn()?.nativeElement.focus(), 50);
  }

  async setBaud(b: number) {
    this.monTouched = true;
    this.monBaud.set(b);
    const port = this.link.port;
    if (port && this.monOn()) {
      try { await this.openMonitor(port, false); } catch (e) { this.addLine(plainError(e).text, 'error'); }
    }
  }

  async disconnect() {
    await this.link.close();
    this.monOn.set(false);
    this.addLine(t('disconnected'), 'info');
  }

  async resetBoard() {
    try { await this.link.reset(); this.addLine(t('board reset (EN pulsed through RTS)'), 'info'); }
    catch (e) { this.addLine(plainError(e).text, 'error'); }
  }

  clearMonitor() { this.monLines.set([]); this.monNew.set(0); this.monPaused.set(false); }

  sendLine() {
    const text = this.monText().trim();
    if (!text) return;
    this.send(text);
    this.monText.set('');
  }

  async send(text: string) {
    try { await this.link.send(text); this.addLine('> ' + text, 'tx'); }
    catch (e) { this.addLine(plainError(e).text, 'error'); }
  }

  /** Lines come in bursts (a boot prints dozens at once): gathered and put
   *  on screen once a frame, the list kept to its last 3000. */
  addLine(text: string, kind: SerialLine['kind']) {
    this.monPending.push({ id: ++this.monSeq, at: Date.now(), text, kind });
    if (this.monFrame) return;
    this.monFrame = requestAnimationFrame(() => {
      this.monFrame = 0;
      const add = this.monPending;
      this.monPending = [];
      this.monLines.update(l => { const n = l.concat(add); return n.length > 3000 ? n.slice(-3000) : n; });
      if (this.monPaused()) this.monNew.update(n => n + add.length);
      else setTimeout(() => this.monScrollDown(), 0);
    });
  }

  /** Reading back up stops the following; back at the bottom, it follows again. */
  onMonScroll() {
    const el = this.monBox()?.nativeElement;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    this.monPaused.set(!atBottom);
    if (atBottom) this.monNew.set(0);
  }

  monFollow() { this.monPaused.set(false); this.monNew.set(0); this.monScrollDown(); }

  private monScrollDown() {
    const el = this.monBox()?.nativeElement;
    if (el) el.scrollTop = el.scrollHeight;
  }

  stamp(at: number): string {
    const d = new Date(at);
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  }

  /** The console's commands worth a button, read from the code. */
  private readQuick() {
    const id = this.fw()?.id;
    const key = `${id}:${this.fw()?.version}`;
    if (!id || key === this.quickFor || !this.files().length) return;
    this.quickFor = key;
    const paths = this.files().map(x => x.path).filter(p => /^(src|include)\/.*\.(c|cc|cpp|h|hpp|ino)$/.test(p) && p !== 'include/pins.h');
    const texts: string[] = [];
    let left = paths.length;
    if (!left) { this.quick.set([]); return; }
    for (const p of paths) {
      this.http.get<{ content: string }>(`/api/firmware/${id}/files/${p}`).subscribe({
        next: r => texts.push(r.content),
        complete: () => { if (--left === 0) this.quick.set(quickCommands(texts.join('\n'))); },
        error: () => { if (--left === 0) this.quick.set(quickCommands(texts.join('\n'))); },
      });
    }
  }

  private static recall(k: string, fallback: string): string {
    try { return localStorage.getItem('redline.firmware.' + k) ?? fallback; } catch { return fallback; }
  }
  private static keep(k: string, v: string) {
    try { localStorage.setItem('redline.firmware.' + k, v); } catch { /* private window */ }
  }
}
