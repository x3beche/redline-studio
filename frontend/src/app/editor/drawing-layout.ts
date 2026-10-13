import { Component, ElementRef, HostListener, OnDestroy, OnInit, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { T, t } from '../i18n';
import { Toast } from '../toast';
import { Skeleton } from '../skeleton';
import { SelectOption, UiSelect } from '../ui-select';

/** The layout editor of a model's technical drawing: a large modal opened
 *  from the Model tab's Technical drawing ("Edit layout", model-health.ts).
 *
 *  Left, the sheet as it is printed: the border, a 10 mm grid, the title
 *  block in its place with what it will say, and the view boxes - over the
 *  drawing as made while nothing has changed. A box is dragged by its body
 *  and sized by its corners on a 5 mm grid, kept inside the border and
 *  above the title block; while it moves it says its size in mm, the scale
 *  its view comes out at, and when the view will not fit. Arrows nudge the
 *  picked box, Delete takes it off, Esc closes (asking first if something
 *  changed).
 *
 *  Right, the picked box exactly: its view, its place and size (mm on the
 *  sheet, and % of the space for views), its scale - automatic (one scale
 *  every automatic box shares, the largest standard one at which each fits,
 *  as tools/techdraw.py picks it, shown) or a standard one - hidden lines
 *  and dimensions, and Fit content (the box made the size of its view).
 *  Then arrangements to start from and Equalise; the sheet (size, way
 *  round, title, notes); and for an assembly its parts, left off or drawn
 *  heavier.
 *
 *  Save & draw keeps the layout on the model (PUT .../drawing/layout,
 *  backend/drawlayout.py) and makes the drawing with it (POST .../drawing
 *  ?again=1), followed here as on the tab, then shows it under the boxes.
 *  Reset to automatic drops the layout. */

export type ViewKey = 'front' | 'back' | 'top' | 'bottom' | 'left' | 'right' | 'iso';

export interface ViewBox {
  view: ViewKey; x: number; y: number; w: number; h: number;
  scale: string; hidden_lines: boolean; dims: boolean;
}

export interface LayoutSpec {
  sheet: { size: 'auto' | 'A4' | 'A3'; orientation: 'landscape' | 'portrait' };
  views: ViewBox[];
  parts: { hide: string[]; highlight: string[] };
  title: string | null; notes: string | null;
}

/** backend/drawlayout.py read. */
interface LayoutOut { id: string; spec: LayoutSpec | null; version: number; names: string[]; key: string }

/** What of backend/release.py drawing_status this needs. */
export interface DrawState {
  id: string; state: string; pct?: number | null; stage?: string | null; key?: string;
  layout?: { custom: boolean; version: number; key: string };
  made?: { sheet?: string; scale?: string; boxes?: Partial<ViewBox>[]; parts?: string[]; unmatched?: string[];
           preview: boolean; extents?: Partial<Record<ViewKey, [number, number]>>; size_mm?: [number, number, number] };
  failed?: { reason: string };
}

/** What each box comes out as: its scale and whether its view fits. */
interface Fit { k: number | null; label: string; fits: boolean; need: [number, number] }

const SHEETS: Record<'A4' | 'A3', [number, number]> = { A4: [297, 210], A3: [420, 297] };
// tools/techdraw.py's: the border, the title block, room around a view.
const MARGIN = 10;
const TITLE_H = 36;
const PAD = { dims: [13, 4, 8, 12], plain: [4, 4, 8, 4] } as const;
const GRID = 5;                        // mm a dragged box snaps to
const MIN_MM = 20;                     // a box's least side
const GAP = 5;                         // mm between boxes an arrangement leaves
const FIT_SLACK = 0.5;                 // mm a view may overrun its box and still fit (techdraw.py FIT_SLACK)
const VIEWS: ViewKey[] = ['front', 'back', 'top', 'bottom', 'left', 'right', 'iso'];
const NAMES: Record<ViewKey, string> = { front: 'Front', back: 'Back', top: 'Top', bottom: 'Bottom', left: 'Left',
                                         right: 'Right', iso: 'Isometric' };
const SCALES: [number, number][] = [[10, 1], [5, 1], [2, 1], [1, 1], [1, 2], [1, 5], [1, 10], [1, 20], [1, 50], [1, 100]];
// The title block's columns, in A3's proportions (techdraw.py cols).
const TB_COLS: [string, number][] = [['TITLE', 120], ['PROJECT', 70], ['RELEASE', 40], ['SCALE', 30], ['UNITS', 25],
                                     ['DATE', 40], ['SHEET', 75]];

type Grip = 'move' | 'nw' | 'ne' | 'sw' | 'se';
type Preset = 'standard' | 'front' | 'iso' | 'notes' | 'six';

function box(view: ViewKey, x: number, y: number, w: number, h: number): ViewBox {
  return { view, x, y, w, h, scale: 'auto', hidden_lines: view !== 'iso', dims: view !== 'iso' };
}

function same(a: unknown, b: unknown) { return JSON.stringify(a) === JSON.stringify(b); }

function ratio(s: string): [number, number] | null {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(s);
  return m && +m[2] > 0 ? [+m[1], +m[2]] : null;
}
/** The largest ratio written to a tenth that is at most k (techdraw.py fill_ratio). */
function fillRatio(k: number): [number, number] {
  if (k >= 1) return [Math.max(1, Math.floor(k * 10 + 1e-9) / 10), 1];
  return [1, Math.max(1.1, Math.ceil(1 / Math.max(k, 1e-6) * 10 - 1e-6) / 10)];
}
/** A scale as the person types it ("1,7:1", "1.7 : 1", "2") as kept ("1.7:1"); null if it is not one. */
function typedScale(s: string): string | null {
  const t = s.replace(/\s/g, '').replace(/,/g, '.');
  const r = ratio(t) ?? (/^\d+(\.\d+)?$/.test(t) ? [+t, 1] as [number, number] : null);
  if (!r || r[0] / r[1] < 0.01 || r[0] / r[1] > 100) return null;
  return `${+r[0].toFixed(2)}:${+r[1].toFixed(2)}`;
}

@Component({
  selector: 'app-drawing-layout',
  imports: [T, UiSelect, Skeleton],
  styles: [`
    .dl-veil { position: fixed; inset: 0; z-index: 600; display: flex; align-items: center; justify-content: center;
               padding: 24px; background: var(--scrim); }
    .dl { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; width: min(1760px, 100%); height: min(1040px, 100%);
          background: var(--surface); border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 16px 48px var(--shadow-hard);
          color: var(--ink); font-size: 12.5px; overflow: hidden; }
    .dl-head { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-bottom: 1px solid var(--line); }
    .dl-head h2 { margin: 0; font-size: 14px; font-weight: 600; color: var(--ink-bright); white-space: nowrap; }
    .dl-head > span:first-of-type { flex: 1; }
    .dl-head > span { color: var(--ink-dim); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dl-chip { padding: 1px 7px; font: 11px 'IBM Plex Mono', ui-monospace, monospace; color: var(--ink-dim);
               border: 1px solid var(--line); border-radius: 10px; white-space: nowrap; }
    .dl-chip[data-on] { color: var(--accent); border-color: var(--accent-deep); }
    .dl-body { display: grid; grid-template-columns: minmax(0, 1fr) 400px; min-height: 0; }

    /* the sheet */
    .dl-stage { display: flex; flex-direction: column; gap: 10px; min-width: 0; min-height: 0; padding: 16px;
                background: var(--surface-2); }
    .dl-fit { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; container-type: size; }
    .dl-sheet { position: relative; container-type: inline-size; background: var(--dl-paper); border-radius: 2px;
                box-shadow: 0 2px 12px var(--shadow-soft); touch-action: none; user-select: none; }
    .dl-sheet > img { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
    .dl-grid { position: absolute; pointer-events: none;
               background-image: linear-gradient(to right, var(--dl-grid) 1px, transparent 1px),
                                 linear-gradient(to bottom, var(--dl-grid) 1px, transparent 1px);
               background-size: calc(var(--mm) * 10) calc(var(--mm) * 10); }
    /* The sheet is paper, white in every theme: what is drawn on it is
       pigment, as a revision's pens are. */
    .dl-sheet { --dl-paper: #fff;                             /* theme:pigment */
                --dl-ink: #4a5058;                            /* theme:pigment - the border, the title block */
                --dl-pen: #1f6fd1;                            /* theme:pigment - the view boxes */
                --dl-pen-on: #fff;                            /* theme:pigment - text on the pen */
                --dl-bad: #d32f2f;                            /* theme:pigment - a view that does not fit */
                --dl-grid: color-mix(in srgb, var(--dl-pen) 9%, transparent); }
    .dl-border { position: absolute; box-sizing: border-box; pointer-events: none; border: calc(var(--mm) * .5) solid var(--dl-ink); }
    .dl-tb { position: absolute; display: grid; grid-template-rows: 19fr 17fr; box-sizing: border-box; pointer-events: none;
             color: var(--dl-ink); border-top: calc(var(--mm) * .5) solid var(--dl-ink); }
    .dl-tb-cols { display: flex; border-bottom: 1px solid var(--dl-ink); min-height: 0; }
    .dl-tb-cols > div { display: flex; flex-direction: column; justify-content: space-between; min-width: 0; padding: calc(var(--mm) * 1.6) calc(var(--mm) * 2) calc(var(--mm) * 2.6);
                        box-sizing: border-box; overflow: hidden; }
    .dl-tb-cols > div + div { border-left: 1px solid var(--dl-ink); }
    .dl-tb small { font-size: calc(var(--mm) * 2.2); line-height: 1; }
    .dl-tb b { font-size: calc(var(--mm) * 3.3); line-height: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .dl-tb-cols > div:first-child b { font-size: calc(var(--mm) * 4); }
    .dl-tb-notes { display: flex; flex-direction: column; gap: calc(var(--mm) * 2); padding: calc(var(--mm) * 3.5) calc(var(--mm) * 2) 0;
                   font-size: calc(var(--mm) * 2.4); line-height: 1; white-space: nowrap; overflow: hidden; }
    .dl-tb-notes span { overflow: hidden; text-overflow: ellipsis; }
    .dl-sheet[data-under] .dl-tb, .dl-sheet[data-under] .dl-border { visibility: hidden; }

    .dl-box { position: absolute; box-sizing: border-box; border: 1px dashed var(--dl-pen); border-radius: 2px;
              background: color-mix(in srgb, var(--dl-pen) 6%, transparent); cursor: grab; outline: none; }
    .dl-box:hover { background: color-mix(in srgb, var(--dl-pen) 10%, transparent); }
    .dl-box[data-on] { border: 2px solid var(--dl-pen); background: color-mix(in srgb, var(--dl-pen) 12%, transparent); z-index: 2; }
    .dl-box[data-warn] { border-color: var(--dl-bad); background: color-mix(in srgb, var(--dl-bad) 8%, transparent); }
    .dl-box:focus-visible { box-shadow: 0 0 0 3px color-mix(in srgb, var(--dl-pen) 35%, transparent); }
    .dl-box[data-ro] { cursor: pointer; }
    .dl-sheet[data-dragging] .dl-box { cursor: grabbing; }
    .dl-tag { position: absolute; left: 4px; top: 4px; max-width: calc(100% - 8px); padding: 1px 6px; box-sizing: border-box;
              font: 600 10.5px 'IBM Plex Mono', ui-monospace, monospace; color: var(--dl-pen-on); background: var(--dl-pen);
              border-radius: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .dl-box[data-warn] .dl-tag { background: var(--dl-bad); color: var(--dl-pen-on); }
    /* the view as it will come out: its outline at the scale, in the box */
    .dl-ghost { position: absolute; box-sizing: border-box; border: 1px solid color-mix(in srgb, var(--dl-pen) 55%, transparent);
                background: color-mix(in srgb, var(--dl-pen) 7%, transparent); pointer-events: none; }
    .dl-box[data-warn] .dl-ghost { border-color: var(--dl-bad); }
    .dl-size { position: absolute; right: 4px; bottom: 4px; padding: 1px 6px; font: 10.5px 'IBM Plex Mono', ui-monospace, monospace;
               color: var(--dl-pen-on); background: var(--dl-ink); border-radius: 3px; white-space: nowrap; }
    .dl-box[data-warn] .dl-size { background: var(--dl-bad); }
    .dl-grip { position: absolute; width: 11px; height: 11px; background: var(--dl-paper); border: 2px solid var(--dl-pen);
               border-radius: 2px; box-sizing: border-box; z-index: 1; }
    .dl-grip[data-g="nw"] { left: -6px; top: -6px; cursor: nwse-resize; }
    .dl-grip[data-g="ne"] { right: -6px; top: -6px; cursor: nesw-resize; }
    .dl-grip[data-g="sw"] { left: -6px; bottom: -6px; cursor: nesw-resize; }
    .dl-grip[data-g="se"] { right: -6px; bottom: -6px; cursor: nwse-resize; }
    .dl-under { display: flex; align-items: center; gap: 8px; color: var(--ink-dim); font-size: 11.5px; }
    .dl-under > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dl-under kbd { padding: 0 4px; font: 10.5px 'IBM Plex Mono', ui-monospace, monospace; border: 1px solid var(--line); border-radius: 3px; }

    /* the settings */
    .dl-side { display: flex; flex-direction: column; min-height: 0; overflow-y: auto; border-left: 1px solid var(--line); }
    .dl-sec { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); align-items: center; gap: 8px; padding: 12px 14px;
              border-bottom: 1px solid var(--line); }
    .dl-sec > h3 { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; margin: 0; font-size: 10.5px;
                   font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-dim); }
    .dl-sec > h3 span { margin-left: auto; text-transform: none; letter-spacing: 0; font-weight: 400; overflow: hidden;
                        text-overflow: ellipsis; white-space: nowrap; }
    .dl-sec > h3 span[data-warn] { color: var(--danger); }
    .dl-two { grid-column: span 2; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
    .dl-one { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
    .dl-full { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
    .dl-sec label > small, .dl-lbl { font-size: 11px; color: var(--ink-dim); }
    .dl-sec wb-select { width: 100%; }
    .dl-num { display: flex; align-items: center; min-width: 0; background: var(--surface-2); border: 1px solid var(--line);
              border-radius: 5px; }
    .dl-num:focus-within { border-color: var(--accent); }
    .dl-num input { flex: 1; min-width: 0; width: 100%; padding: 5px 0 5px 8px; font: inherit; font-variant-numeric: tabular-nums;
                    color: var(--ink); background: none; border: 0; outline: none; }
    .dl-num i { padding: 0 7px; font-style: normal; font-size: 11px; color: var(--ink-dim); }
    .dl-num input:disabled { opacity: .6; }
    .dl-sec input[type="text"] { min-width: 0; padding: 5px 8px; font: inherit; color: var(--ink); background: var(--surface-2);
                                 border: 1px solid var(--line); border-radius: 5px; outline: none; }
    .dl-sec input[type="text"]:focus { border-color: var(--accent); }
    .dl-res { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; padding: 6px 8px; font-size: 11.5px;
              background: var(--surface-2); border-radius: 5px; color: var(--ink-dim); }
    .dl-res b { font: 600 12px 'IBM Plex Mono', ui-monospace, monospace; color: var(--ink); }
    .dl-res[data-warn] { color: var(--danger); }
    .dl-typed { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--ink-dim); }
    .dl-typed small { flex: none; }
    .dl-typed input { flex: 1; min-width: 0; height: 26px; padding: 0 8px; font: 12px 'IBM Plex Mono', ui-monospace, monospace;
                      color: var(--ink); background: var(--surface-2); border: 1px solid var(--line); border-radius: 5px; outline: none; }
    .dl-typed input:focus { border-color: var(--accent); }
    .dl-typed[data-bad] input { border-color: var(--danger); }
    .dl-typed em { flex: none; font-style: normal; color: var(--danger); }
    /* An automatic box drawn smaller than it could be: why, and the way out. */
    .dl-held { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; padding: 6px 8px; font-size: 11.5px; line-height: 1.4;
               color: var(--ink-dim); border: 1px dashed var(--line); border-radius: 5px; }
    .dl-held b { font: 600 12px 'IBM Plex Mono', ui-monospace, monospace; color: var(--ink); }
    .dl-held .tcv-btn { flex: none; padding: 2px 8px; font-size: 11.5px; }
    .dl-held .tcv-btn:first-of-type { margin-left: auto; }
    .dl-res[data-warn] b { color: var(--danger); }
    .dl-checks { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; }
    .dl-checks label { display: flex; align-items: center; gap: 6px; }
    .dl-checks .dl-btns { margin-left: auto; display: flex; gap: 6px; }
    .dl-none { grid-column: 1 / -1; color: var(--ink-dim); }
    .dl-presets { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
    .dl-preset { display: flex; flex-direction: column; align-items: stretch; gap: 5px; padding: 6px; font: inherit; font-size: 11px;
                 color: var(--ink-dim); background: var(--surface-2); border: 1px solid var(--line); border-radius: 5px; cursor: pointer; }
    .dl-preset:hover:not(:disabled) { color: var(--ink); border-color: var(--ink-dim); }
    .dl-preset:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .dl-preset:disabled { cursor: default; opacity: .55; }
    .dl-preset svg { width: 100%; height: auto; display: block; }
    .dl-preset svg rect { fill: none; stroke: var(--line); stroke-width: 1; }
    .dl-preset svg rect.v { fill: color-mix(in srgb, var(--accent) 22%, transparent); stroke: var(--accent); }
    .dl-parts { grid-column: 1 / -1; display: grid; grid-template-columns: minmax(0, 1fr) 52px 70px; align-items: center;
                max-height: 300px; overflow-y: auto; border: 1px solid var(--line); border-radius: 5px; }
    .dl-parts > * { padding: 4px 8px; border-bottom: 1px dashed var(--line); min-width: 0; }
    .dl-parts > .dl-ph { position: sticky; top: 0; z-index: 1; background: var(--surface); font-size: 10.5px; color: var(--ink-dim);
                         border-bottom-style: solid; }
    .dl-parts > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dl-parts > span[data-g] { font-weight: 600; }
    .dl-parts > label, .dl-parts > .dl-ph.c { display: flex; justify-content: center; }
    .dl-warn { grid-column: 1 / -1; color: var(--warn); overflow-wrap: anywhere; }

    /* the foot */
    .dl-foot { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--line); }
    .dl-state { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; color: var(--ink-dim); }
    .dl-state > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dl-state[data-tone="error"] { color: var(--danger); }
    .dl-state[data-tone="ask"] { color: var(--warn); }
    .dl-danger { color: var(--danger); border-color: var(--danger); }
    .dl-bar { flex: none; width: 220px; height: 4px; border-radius: 2px; background: var(--surface-2); overflow: hidden; }
    .dl-bar > i { display: block; height: 100%; background: var(--accent); transform-origin: left; transition: transform .2s; }
    @media (prefers-reduced-motion: reduce) { .dl-bar > i { transition: none; } }
    @media (max-width: 1000px) { .dl-body { grid-template-columns: 1fr; grid-template-rows: minmax(0, 1fr) auto; }
                                 .dl-side { border-left: 0; border-top: 1px solid var(--line); max-height: 45vh; } }
  `],
  template: `
<div class="dl-veil tcv-m-veil" (pointerdown)="veilDown = $event.target === $event.currentTarget"
     (click)="veilDown && $event.target === $event.currentTarget && close()">
  <div class="dl tcv-m-box" role="dialog" aria-modal="true" [attr.aria-label]="'Drawing layout' | t">
    <header class="dl-head">
      <h2>{{ 'Drawing layout' | t }}</h2>
      <span>{{ title() }}</span>
      @if (spec()) {
        <span class="dl-chip">{{ sheetName() }}</span>
        <span class="dl-chip" [attr.data-on]="common() ? 1 : null" [title]="'The scale the automatic views share' | t">{{ 'Scale' | t }} {{ common() || '-' }}</span>
        <span class="dl-chip" [attr.data-on]="custom() ? 1 : null">{{ (custom() ? 'Own layout' : 'Automatic layout') | t }}</span>
      }
    </header>

    <div class="dl-body">
      <!-- THE SHEET -->
      <section class="dl-stage">
        <div class="dl-fit">
          @if (spec(); as s) {
            <div class="dl-sheet" #sheet [style.aspect-ratio]="paper()[0] + ' / ' + paper()[1]"
                 [style.width]="'min(100cqw, 100cqh * ' + paper()[0] / paper()[1] + ')'"
                 [style.--mm]="'calc(100cqw / ' + paper()[0] + ')'"
                 [attr.data-under]="underlay() ? 1 : null" [attr.data-dragging]="dragging() ? 1 : null"
                 (pointerdown)="sel.set(-1)">
              @if (underlay()) { <img [src]="underlay()" alt=""> }
              @else {
                <div class="dl-grid" [style.left.%]="frame().x * 100" [style.top.%]="frame().y * 100"
                     [style.width.%]="(frame().x2 - frame().x) * 100" [style.height.%]="(frame().y2 - frame().y) * 100"></div>
              }
              <div class="dl-border" [style.left.%]="frame().x * 100" [style.top.%]="frame().y * 100"
                   [style.width.%]="(frame().x2 - frame().x) * 100" [style.height.%]="(1 - 2 * frame().y) * 100"></div>
              <div class="dl-tb" [style.left.%]="frame().x * 100" [style.top.%]="frame().y2 * 100"
                   [style.width.%]="(frame().x2 - frame().x) * 100" [style.height.%]="(1 - frame().y - frame().y2) * 100">
                <div class="dl-tb-cols">
                  @for (c of titleBlock(); track c[0]) {
                    <div [style.flex]="c[2]"><small>{{ c[0] }}</small><b>{{ c[1] }}</b></div>
                  }
                </div>
                <div class="dl-tb-notes"><span>{{ notesLine() }}</span><span>{{ 'Model' }} {{ model() }} · {{ 'views projected from the model (Workbench).' }}</span></div>
              </div>
              @for (b of s.views; track $index; let i = $index) {
                @let f = fits()[i];
                <div class="dl-box" tabindex="0" [attr.data-on]="i === sel() ? 1 : null" [attr.data-warn]="f && !f.fits ? 1 : null"
                     [attr.data-ro]="canSave() ? null : 1"
                     [style.left.%]="b.x * 100" [style.top.%]="b.y * 100" [style.width.%]="b.w * 100" [style.height.%]="b.h * 100"
                     [attr.aria-label]="viewName(b.view) + ', ' + mmOf(b.w, 0) + ' × ' + mmOf(b.h, 1) + ' mm'"
                     (pointerdown)="grab($event, i, 'move')" (focus)="sel.set(i)">
                  @if (f && ghost(i); as g) {
                    <i class="dl-ghost" [style.left.%]="g.x" [style.top.%]="g.y" [style.width.%]="g.w" [style.height.%]="g.h"></i>
                  }
                  <span class="dl-tag">{{ viewName(b.view) }} · {{ f?.label }}</span>
                  @if (i === sel() || f && !f.fits) {
                    <span class="dl-size">{{ mmOf(b.w, 0) }} × {{ mmOf(b.h, 1) }} mm@if (f && !f.fits) { · {{ 'does not fit' | t }} }</span>
                  }
                  @if (i === sel() && canSave()) {
                    @for (g of grips; track g) { <i class="dl-grip" [attr.data-g]="g" (pointerdown)="grab($event, i, g)"></i> }
                  }
                </div>
              }
            </div>
          } @else {
            <wb-skel kind="chart" [h]="420" />
          }
        </div>
        <div class="dl-under">
          <span>@if (canSave()) { {{ 'Drag a view to move it and its corners to size it (5 mm grid).' | t }} <kbd>←↑→↓</kbd> {{ 'nudge' | t }} · <kbd>Del</kbd> {{ 'remove' | t }} · <kbd>Esc</kbd> {{ 'close' | t }} } @else { {{ 'Read only: changing the layout needs the right to edit models.' | t }} }</span>
          @if (canSave()) {
            <wb-select size="sm" [options]="viewOpts()" [value]="adding()" (pick)="adding.set($any($event))" [label]="'View to add' | t" />
            <button class="tcv-btn" (click)="add()" [disabled]="!spec() || (spec()?.views?.length ?? 0) >= 8">{{ 'Add view' | t }}</button>
          }
        </div>
      </section>

      <!-- THE SETTINGS -->
      <aside class="dl-side">
        @if (spec(); as s) {
          <section class="dl-sec">
            <h3>{{ 'View' | t }}@if (picked(); as b) { <span>{{ sel() + 1 }} / {{ s.views.length }}</span> }</h3>
            @if (picked(); as b) {
              @let f = fits()[sel()];
              <label class="dl-two"><small>{{ 'Seen from' | t }}</small>
                <wb-select size="sm" [options]="viewOpts()" [value]="b.view" [disabled]="!canSave()" (pick)="set({ view: $any($event) })" [label]="'View' | t" /></label>
              <label class="dl-two"><small>{{ 'Scale' | t }}</small>
                <wb-select size="sm" [options]="scaleOpts()" [value]="b.scale" [disabled]="!canSave()" (pick)="set({ scale: $event })" [label]="'Scale' | t" /></label>
              @if (b.view !== 'iso' && canSave()) {
                <label class="dl-typed" [attr.data-bad]="typed() ? 1 : null"><small>{{ 'Or type a scale' | t }}</small>
                  <input type="text" inputmode="decimal" [placeholder]="'e.g. 1.7:1 or 1:2.5' | t" [value]="typed()"
                         (keydown.enter)="typeScale($any($event.target).value); $any($event.target).blur()"
                         (change)="typeScale($any($event.target).value)" [attr.aria-label]="'Scale' | t">
                  @if (typed()) { <em>{{ 'Write it as 1.7:1 or 1:2.5' | t }}</em> }
                </label>
              }
              <label class="dl-one"><small>X</small>
                <span class="dl-num"><input type="number" [value]="mmOf(b.x, 0)" [disabled]="!canSave()" (change)="numeric('x', $any($event.target).value, 'mm')"><i>mm</i></span></label>
              <label class="dl-one"><small>Y</small>
                <span class="dl-num"><input type="number" [value]="mmOf(b.y, 1)" [disabled]="!canSave()" (change)="numeric('y', $any($event.target).value, 'mm')"><i>mm</i></span></label>
              <label class="dl-one"><small>{{ 'Width' | t }}</small>
                <span class="dl-num"><input type="number" [value]="mmOf(b.w, 0)" [disabled]="!canSave()" (change)="numeric('w', $any($event.target).value, 'mm')"><i>mm</i></span></label>
              <label class="dl-one"><small>{{ 'Height' | t }}</small>
                <span class="dl-num"><input type="number" [value]="mmOf(b.h, 1)" [disabled]="!canSave()" (change)="numeric('h', $any($event.target).value, 'mm')"><i>mm</i></span></label>
              <span class="dl-lbl" style="grid-column: span 2">{{ 'Share of the space for views' | t }}</span>
              <label class="dl-one"><span class="dl-num"><input type="number" step="1" [value]="share(b.w, 0)" [disabled]="!canSave()" [attr.aria-label]="'Width' | t"
                     (change)="numeric('w', $any($event.target).value, '%')"><i>%</i></span></label>
              <label class="dl-one"><span class="dl-num"><input type="number" step="1" [value]="share(b.h, 1)" [disabled]="!canSave()" [attr.aria-label]="'Height' | t"
                     (change)="numeric('h', $any($event.target).value, '%')"><i>%</i></span></label>
              @if (f) {
                <div class="dl-res" [attr.data-warn]="f.fits ? null : 1">
                  <span>{{ (f.fits ? 'Comes out at' : 'Does not fit at') | t }}</span><b>{{ f.label }}</b>
                  <span style="margin-left:auto">{{ 'needs' | t }} {{ f.need[0] }} × {{ f.need[1] }} mm</span>
                </div>
                @if (heldBack(); as hb) {
                  <div class="dl-held">
                    <span>{{ 'Kept at the shared scale by' | t }} {{ hb.by || ('another view' | t) }}. {{ 'On its own this box takes' | t }} <b>{{ hb.own }}</b>.</span>
                    @if (canSave()) {
                      <button type="button" class="tcv-btn" (click)="set({ scale: 'fit' })">{{ 'Fit this box' | t }}</button>
                      @if (fillOf(sel()); as fr) { <button type="button" class="tcv-btn" (click)="set({ scale: 'fill' })">{{ 'Fill the box' | t }} ({{ fr }})</button> }
                    }
                  </div>
                }
                @if (b.scale === 'fit' && fillOf(sel()) && fillOf(sel()) !== bestOf(sel()) && canSave()) {
                  <div class="dl-held">
                    <span>{{ 'A standard scale leaves room in this box; filling it takes' | t }} <b>{{ fillOf(sel()) }}</b>.</span>
                    <button type="button" class="tcv-btn" (click)="set({ scale: 'fill' })">{{ 'Fill the box' | t }}</button>
                  </div>
                }
              }
              <div class="dl-checks">
                <label><input type="checkbox" class="tcv-check" [checked]="b.hidden_lines" [disabled]="!canSave()" (change)="set({ hidden_lines: $any($event.target).checked })"> {{ 'Hidden lines' | t }}</label>
                @if (b.view !== 'iso') {
                  <label><input type="checkbox" class="tcv-check" [checked]="b.dims" [disabled]="!canSave()" (change)="set({ dims: $any($event.target).checked })"> {{ 'Dimensions' | t }}</label>
                }
                @if (canSave()) {
                  <span class="dl-btns">
                    <button class="tcv-btn" (click)="fitContent()" [title]="'Make the box the size of its view at its scale' | t">{{ 'Fit content' | t }}</button>
                    <button class="tcv-btn" (click)="remove()" [disabled]="s.views.length < 2">{{ 'Remove' | t }}</button>
                  </span>
                }
              </div>
            } @else {
              <span class="dl-none">{{ 'Pick a view on the sheet to set it exactly.' | t }}</span>
            }
          </section>

          @if (canSave()) {
            <section class="dl-sec">
              <h3>{{ 'Arrangement' | t }}<span><button class="tcv-btn" (click)="equalise()" [title]="'Every view the same size, in an even grid' | t">{{ 'Equalise' | t }}</button></span></h3>
              <div class="dl-presets">
                @for (p of presets; track p.id) {
                  <button class="dl-preset" (click)="preset(p.id)" [title]="p.about | t">
                    <svg viewBox="0 0 60 40" aria-hidden="true">
                      <rect x="0.5" y="0.5" width="59" height="39" rx="1"></rect>
                      <rect x="2" y="32" width="56" height="6"></rect>
                      @for (r of p.icon; track $index) { <rect class="v" [attr.x]="r[0]" [attr.y]="r[1]" [attr.width]="r[2]" [attr.height]="r[3]"></rect> }
                    </svg>
                    {{ p.label | t }}
                  </button>
                }
              </div>
            </section>
          }

          <section class="dl-sec">
            <h3>{{ 'Sheet' | t }}@if (made()?.scale) { <span>{{ 'last made' | t }}: {{ made()?.sheet }} · {{ made()?.scale }}</span> }</h3>
            <label class="dl-two"><small>{{ 'Size' | t }}</small>
              <wb-select size="sm" [options]="sizeOpts()" [value]="s.sheet.size" [disabled]="!canSave()" (pick)="sheet({ size: $any($event) })" [label]="'Size' | t" /></label>
            <label class="dl-two"><small>{{ 'Orientation' | t }}</small>
              <wb-select size="sm" [options]="orientOpts()" [value]="s.sheet.orientation" [disabled]="!canSave()" (pick)="sheet({ orientation: $any($event) })" [label]="'Orientation' | t" /></label>
            <label class="dl-full"><small>{{ 'Title' | t }}</small>
              <input type="text" maxlength="120" [placeholder]="title()" [value]="s.title ?? ''" [disabled]="!canSave()" (input)="text('title', $any($event.target).value)"></label>
            <label class="dl-full"><small>{{ 'Notes' | t }}</small>
              <input type="text" maxlength="300" [placeholder]="autoNotes()" [value]="s.notes ?? ''" [disabled]="!canSave()" (input)="text('notes', $any($event.target).value)"></label>
          </section>

          @if (parts().length > 1) {
            <section class="dl-sec">
              <h3>{{ 'Parts' | t }}<span>{{ s.parts.hide.length }} {{ 'hidden' | t }} · {{ s.parts.highlight.length }} {{ 'highlighted' | t }}</span></h3>
              <div class="dl-parts">
                <span class="dl-ph">{{ 'Part' | t }}</span><span class="dl-ph c">{{ 'Hide' | t }}</span><span class="dl-ph c">{{ 'Highlight' | t }}</span>
                @for (p of parts(); track p.name) {
                  <span [attr.data-g]="p.group ? 1 : null" [title]="p.name">{{ p.name }}</span>
                  <label><input type="checkbox" class="tcv-check" [checked]="s.parts.hide.includes(p.name)" [disabled]="!canSave()" (change)="part('hide', p.name, $any($event.target).checked)" [attr.aria-label]="('Hide' | t) + ' ' + p.name"></label>
                  <label><input type="checkbox" class="tcv-check" [checked]="s.parts.highlight.includes(p.name)" [disabled]="!canSave()" (change)="part('highlight', p.name, $any($event.target).checked)" [attr.aria-label]="('Highlight' | t) + ' ' + p.name"></label>
                }
              </div>
              @if (unmatched().length) { <span class="dl-warn">{{ 'Not found in the drawing' | t }}: {{ unmatched().join(', ') }}</span> }
            </section>
          }
        } @else {
          <section class="dl-sec"><wb-skel kind="text" [count]="8" style="grid-column: 1 / -1" /></section>
        }
      </aside>
    </div>

    <footer class="dl-foot">
      @if (asking()) {
        <div class="dl-state" data-tone="ask"><span>{{ 'Close without saving the changes?' | t }}</span></div>
        <button class="tcv-btn" (click)="asking.set(false)">{{ 'Keep editing' | t }}</button>
        <button class="tcv-btn dl-danger" (click)="closed.emit()">{{ 'Discard changes' | t }}</button>
      } @else {
        <div class="dl-state" [attr.data-tone]="failed() ? 'error' : null">
          @if (busy(); as b) {
            <span>{{ b.stage | t }}</span>
            <div class="dl-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" [attr.aria-valuenow]="b.pct">
              <i [style.transform]="'scaleX(' + b.pct / 100 + ')'"></i></div>
            <b>{{ b.pct }}%</b>
          } @else if (failed()) {
            <span [title]="failed()">{{ 'The drawing failed' | t }}: {{ failed() }}</span>
          } @else if (dirty()) {
            <span>{{ 'Changed - Save & draw keeps it and makes the drawing with it.' | t }}</span>
          } @else if (underlay()) {
            <span>{{ 'The drawing as made is under the boxes.' | t }}</span>
          }
        </div>
        @if (canSave()) {
          <button class="tcv-btn" (click)="reset()" [disabled]="!!busy() || saving() || (!custom() && !dirty())">{{ 'Reset to automatic' | t }}</button>
        }
        <button class="tcv-btn" (click)="close()">{{ (canSave() ? 'Cancel' : 'Close') | t }}</button>
        @if (canSave()) {
          <button class="tcv-btn tcv-btn-accent" (click)="save()" [disabled]="!spec() || !!busy() || saving()">{{ 'Save & draw' | t }}</button>
        }
      }
    </footer>
  </div>
</div>
`,
})
export class DrawingLayout implements OnInit, OnDestroy {
  private http = inject(HttpClient);
  /** The model's id and title. */
  model = input.required<string>();
  title = input('');
  /** Its drawing's status as the tab has it. */
  status = input<DrawState | null>(null);
  /** The model's part names in order (NAMES), its tree's groups, its size. */
  names = input<string[]>([]);
  groups = input<string[]>([]);
  size = input<[number, number, number] | null>(null);
  /** May save (edit) and make the drawing (run). */
  canSave = input(false);
  canMake = input(false);
  closed = output<void>();
  /** A new drawing was made: the tab reads its status again. */
  made_ = output<void>({ alias: 'made' });

  readonly grips: Grip[] = ['nw', 'ne', 'sw', 'se'];
  readonly presets: { id: Preset; label: string; about: string; icon: number[][] }[] = [
    { id: 'standard', label: 'Three views + iso', about: 'Front, right and top with the isometric view beside them',
      icon: [[3, 2, 32, 15], [37, 2, 20, 15], [3, 19, 32, 11], [37, 19, 20, 11]] },
    { id: 'front', label: 'Front large', about: 'The front view over most of the sheet, the right and isometric views beside it',
      icon: [[3, 2, 38, 28], [43, 2, 14, 13], [43, 17, 14, 13]] },
    { id: 'iso', label: 'Iso only', about: 'One isometric view over the whole sheet', icon: [[3, 2, 54, 28]] },
    { id: 'notes', label: 'Front + notes', about: 'Front and top on the left, the right of the sheet left free for notes',
      icon: [[3, 2, 32, 15], [3, 19, 32, 11]] },
    { id: 'six', label: 'All sides', about: 'Six views and the isometric one, in an even grid',
      icon: [[3, 2, 12, 13], [17, 2, 12, 13], [31, 2, 12, 13], [45, 2, 12, 13], [3, 17, 12, 13], [17, 17, 12, 13], [31, 17, 12, 13]] },
  ];
  private sheetEl = viewChild<ElementRef<HTMLElement>>('sheet');

  spec = signal<LayoutSpec | null>(null);
  /** The spec as kept on the model (null: automatic) and its version. */
  private kept = signal<LayoutSpec | null>(null);
  /** The spec the editor started from, to tell a change. */
  private start = signal<LayoutSpec | null>(null);
  private version = 0;
  /** The drawing as the editor last knew it. */
  draw = signal<DrawState | null>(null);
  sel = signal(0);
  adding = signal<ViewKey>('back');
  saving = signal(false);
  /** Esc or Cancel with changes: asked first, in the foot. */
  asking = signal(false);
  dragging = signal(false);
  veilDown = false;
  private timer?: ReturnType<typeof setTimeout>;

  custom = computed(() => !!this.kept());
  dirty = computed(() => !same(this.spec(), this.start()));
  picked = computed(() => this.spec()?.views[this.sel()] ?? null);
  made = computed(() => this.draw()?.made ?? null);

  /** The sheet the boxes are on, in mm: the chosen size, or for "auto" the
   *  one it would come out on (A4 when the automatic scale is 1:1 or more). */
  private size_ = computed<'A4' | 'A3'>(() => {
    const s = this.spec();
    if (s && s.sheet.size !== 'auto') return s.sheet.size;
    if (!s) return 'A3';
    const k = this.commonOn('A4', s);
    return k && k[0] >= k[1] ? 'A4' : 'A3';
  });
  paper = computed<[number, number]>(() => this.dims(this.size_(), this.spec()?.sheet.orientation ?? 'landscape'));
  sheetName = computed(() => {
    const s = this.spec();
    if (!s) return '';
    return `${this.size_()}${s.sheet.size === 'auto' ? ' (' + t('automatic') + ')' : ''} · ${t(s.sheet.orientation)}`;
  });
  /** Where views may go, as fractions: inside the border, above the title block. */
  frame = computed(() => this.frameOf(this.paper()));

  /** The drawing as made, under the boxes - only while it is what they say. */
  underlay = computed(() => {
    const d = this.draw();
    // Only a drawing that says where its boxes were: one made before it did
    // was laid out otherwise, and under these boxes it would mislead.
    if (!d?.made?.preview || !d.key || !d.made.boxes?.length || this.dirty() || this.busy()) return '';
    return `/api/models/${d.id}/drawing.png?k=${d.key}&size=sheet`;
  });
  unmatched = computed(() => this.made()?.unmatched ?? []);

  busy = computed(() => {
    const d = this.draw();
    if (!d || (d.state !== 'making' && d.state !== 'queued')) return null;
    return { pct: d.pct ?? 0, stage: d.stage || (d.state === 'queued' ? 'waiting its turn' : 'starting') };
  });
  failed = computed(() => this.draw()?.state === 'failed' ? this.draw()?.failed?.reason ?? '' : '');

  /** The parts to choose from: the tree's groups, then the model's parts;
   *  the STEP's own names when the page has none. */
  parts = computed(() => {
    const list = [...this.groups().map(name => ({ name, group: true })), ...this.names().map(name => ({ name, group: false }))];
    const seen = new Set<string>();
    const out = list.filter(p => !seen.has(p.name) && seen.add(p.name));
    if (out.length > 1) return out;
    return (this.made()?.parts ?? []).map(name => ({ name, group: false }));
  });

  viewOpts = computed<SelectOption[]>(() => VIEWS.map(v => ({ value: v, label: t(NAMES[v]) })));
  scaleOpts = computed<SelectOption[]>(() => [
    { value: 'auto', label: t('Automatic') + (this.common() ? ` (${this.common()})` : ''), note: t('One scale the automatic views share') },
    { value: 'fit', label: t('Fit this box') + (this.bestOf(this.sel()) ? ` (${this.bestOf(this.sel())})` : ''),
      note: t('The largest standard scale for this box alone') },
    { value: 'fill', label: t('Fill the box') + (this.fillOf(this.sel()) ? ` (${this.fillOf(this.sel())})` : ''),
      note: t('The largest ratio, to a tenth, at which the view fills the box') },
    ...(ratio(this.picked()?.scale ?? '') && !SCALES.some(([a, b]) => `${a}:${b}` === this.picked()?.scale)
      ? [{ value: this.picked()!.scale, label: this.picked()!.scale, note: t('Typed') }] : []),
    ...SCALES.map(([a, b]) => ({ value: `${a}:${b}`, label: `${a}:${b}` }))]);
  sizeOpts = computed<SelectOption[]>(() => [{ value: 'auto', label: t('Automatic'), note: t('A4 if it fits at 1:1, else A3') },
                                              { value: 'A4', label: 'A4' }, { value: 'A3', label: 'A3' }]);
  orientOpts = computed<SelectOption[]>(() => [{ value: 'landscape', label: t('landscape') },
                                                { value: 'portrait', label: t('portrait') }]);

  // ---- what the views come out as ----------------------------------------

  /** The model's size along x, y, z: the drawing's, else the viewer's. */
  private bbox = computed<[number, number, number] | null>(() => this.made()?.size_mm ?? this.size());

  /** A view's own size at 1:1: as the drawing projected it, else from the
   *  model's size (the isometric one worked out). */
  extent(view: ViewKey): [number, number] | null {
    const e = this.made()?.extents?.[view];
    if (e) return e;
    const b = this.bbox();
    if (!b) return null;
    const [x, y, z] = b;
    switch (view) {
      case 'front': case 'back': return [x, z];
      case 'top': case 'bottom': return [x, y];
      case 'left': case 'right': return [y, z];
      default: return [(x + y) / Math.SQRT2, z * Math.sqrt(2 / 3) + (x + y) / Math.sqrt(6)];
    }
  }

  private dims(size: 'A4' | 'A3', orient: string): [number, number] {
    const [w, h] = SHEETS[size];
    return orient === 'portrait' ? [h, w] : [w, h];
  }

  private frameOf([w, h]: [number, number]) {
    return { x: MARGIN / w, y: MARGIN / h, x2: 1 - MARGIN / w, y2: 1 - (MARGIN + TITLE_H) / h };
  }

  /** A box in mm on a sheet, kept inside its frame (as techdraw.py does). */
  private boxMm(b: ViewBox, [pw, ph]: [number, number]) {
    const x = Math.max(MARGIN, b.x * pw), y = Math.max(MARGIN, b.y * ph);
    return { w: Math.min(pw - MARGIN, (b.x + b.w) * pw) - x, h: Math.min(ph - MARGIN - TITLE_H, (b.y + b.h) * ph) - y };
  }

  /** The scale the automatic boxes share on a sheet: the largest standard
   *  one at which each of their views fits its box (techdraw.py
   *  spec_cells); null with none. */
  private commonOn(size: 'A4' | 'A3', s: LayoutSpec): [number, number] | null {
    const paper = this.dims(size, s.sheet.orientation);
    const auto = s.views.filter(b => b.view !== 'iso' && (b.scale || 'auto') === 'auto');
    if (!auto.length) return null;
    for (const [a, d] of SCALES) {
      const k = a / d;
      const ok = auto.every(b => {
        const e = this.extent(b.view);
        if (!e) return true;
        const { w, h } = this.boxMm(b, paper);
        const [pl, pr, pt, pb] = b.dims ? PAD.dims : PAD.plain;
        // Half a millimetre to spare: the boxes of an automatic drawing are
        // exactly as large as their views need, and come back rounded.
        return e[0] * k + pl + pr <= w + FIT_SLACK && e[1] * k + pt + pb <= h + FIT_SLACK;
      });
      if (ok) return [a, d];
    }
    return SCALES[SCALES.length - 1];
  }

  private commonK = computed(() => { const s = this.spec(); return s ? this.commonOn(this.size_(), s) : null; });
  common = computed(() => { const k = this.commonK(); return k ? `${k[0]}:${k[1]}` : ''; });

  /** The largest standard scale at which box b's view fits b alone (techdraw.py "fit"). */
  private bestFor(b: ViewBox, paper: [number, number]): [number, number] | null {
    const e = this.extent(b.view);
    if (!e || b.view === 'iso') return null;
    const { w, h } = this.boxMm(b, paper);
    const [pl, pr, pt, pb] = b.dims ? PAD.dims : PAD.plain;
    return SCALES.find(([a, d]) => e[0] * a / d + pl + pr <= w + FIT_SLACK && e[1] * a / d + pt + pb <= h + FIT_SLACK)
      ?? SCALES[SCALES.length - 1];
  }
  /** The ratio "Fill the box" gives box i ("1.7:1"); '' for none. */
  fillOf(i: number) {
    const b = this.spec()?.views[i];
    const e = b ? this.extent(b.view) : null;
    if (!b || !e || b.view === 'iso') return '';
    const { w, h } = this.boxMm(b, this.paper());
    const [pl, pr, pt, pb] = b.dims ? PAD.dims : PAD.plain;
    const r = fillRatio(Math.max(1e-6, Math.min((w - pl - pr) / Math.max(e[0], 1e-9), (h - pt - pb) / Math.max(e[1], 1e-9))));
    return `${r[0]}:${r[1]}`;
  }
  /** A scale typed into the box's field: kept when it reads as one. */
  typed = signal('');
  typeScale(v: string) {
    const got = typedScale(v);
    if (!got) { this.typed.set(v); return; }
    this.typed.set('');
    this.set({ scale: got });
  }
  /** Box i's own best scale, as written ("1:1"); '' for none. */
  bestOf(i: number) {
    const b = this.spec()?.views[i];
    const r = b ? this.bestFor(b, this.paper()) : null;
    return r ? `${r[0]}:${r[1]}` : '';
  }
  /** For an automatic box held back by the shared scale: the view that holds it
   *  back and the scale this box alone would take - so the panel can say why
   *  a large box still draws its view small. */
  heldBack = computed(() => {
    const s = this.spec(), i = this.sel(), common = this.commonK();
    const b = s?.views[i];
    if (!s || !b || !common || b.view === 'iso' || (b.scale || 'auto') !== 'auto') return null;
    const paper = this.paper(), mine = this.bestFor(b, paper);
    if (!mine || mine[0] / mine[1] <= common[0] / common[1] + 1e-9) return null;
    const by = s.views.find((o, j) => j !== i && o.view !== 'iso' && (o.scale || 'auto') === 'auto'
      && (() => { const r = this.bestFor(o, paper); return !!r && Math.abs(r[0] / r[1] - common[0] / common[1]) < 1e-9; })());
    return { own: `${mine[0]}:${mine[1]}`, by: by ? t(NAMES[by.view]) : '' };
  });

  /** Each box: the scale it comes out at, whether its view fits, and the
   *  room it needs. */
  fits = computed<(Fit | null)[]>(() => {
    const s = this.spec();
    if (!s) return [];
    const paper = this.paper(), common = this.commonK();
    return s.views.map(b => {
      const e = this.extent(b.view);
      const { w, h } = this.boxMm(b, paper);
      const own = ratio(b.scale);
      const [pl, pr, pt, pb] = b.view === 'iso' ? [4, 4, PAD.dims[2], 4] : b.dims ? PAD.dims : PAD.plain;
      if (!e) return { k: null, label: own ? b.scale : t('auto'), fits: true, need: [0, 0] as [number, number] };
      if (b.view === 'iso' && !own) {
        const k = Math.max(0, Math.min((w - 8) / Math.max(e[0], 1e-9), (h - PAD.dims[2] - 4) / Math.max(e[1], 1e-9)));
        return { k, label: t('fit, not to scale'), fits: k > 0, need: [Math.round(w), Math.round(h)] as [number, number] };
      }
      if (b.scale === 'fill') {
        const r = fillRatio(Math.max(1e-6, Math.min((w - pl - pr) / Math.max(e[0], 1e-9), (h - pt - pb) / Math.max(e[1], 1e-9))));
        const k = r[0] / r[1];
        const need: [number, number] = [Math.round(e[0] * k + pl + pr), Math.round(e[1] * k + pt + pb)];
        return { k, label: `${r[0]}:${r[1]} ` + t('fill'), fits: true, need };
      }
      const fit = b.scale === 'fit' ? this.bestFor(b, paper) : null;
      const r = own ?? fit ?? common ?? [1, 1];
      const k = r[0] / r[1];
      const need: [number, number] = [Math.round(e[0] * k + pl + pr), Math.round(e[1] * k + pt + pb)];
      const how = own ? '' : fit ? ' ' + t('fit') : ' ' + t('auto');
      return { k, label: `${r[0]}:${r[1]}` + how, fits: need[0] <= w + .5 && need[1] <= h + .5, need };
    });
  });

  /** What the title block says (techdraw.py): the one scale every scaled view
   *  comes out at (a filled box's ratio counts), "AS SHOWN" when they differ,
   *  "NTS" with none. */
  sheetScale() {
    const s = this.spec(), f = this.fits();
    const shown = new Set((s?.views ?? []).map((b, i) => b.view === 'iso' || !f[i]?.k ? ''
      : f[i]!.label.split(' ')[0]).filter(Boolean));
    return shown.size === 1 ? [...shown][0] : shown.size ? 'AS SHOWN' : 'NTS';
  }

  /** The view's outline at its scale inside box i, as % of the box. */
  ghost(i: number) {
    const s = this.spec(), f = this.fits()[i];
    const b = s?.views[i];
    if (!b || !f?.k) return null;
    const e = this.extent(b.view)!;
    const { w, h } = this.boxMm(b, this.paper());
    const [pl, pr, pt, pb] = b.view === 'iso' ? [4, 4, PAD.dims[2], 4] : b.dims ? PAD.dims : PAD.plain;
    const vw = e[0] * f.k, vh = e[1] * f.k;
    const cx = pl + (w - pl - pr) / 2, cy = pt + (h - pt - pb) / 2;
    return { x: (cx - vw / 2) / w * 100, y: (cy - vh / 2) / h * 100, w: vw / w * 100, h: vh / h * 100 };
  }

  // ---- the title block as it will print ----------------------------------

  autoNotes = computed(() => {
    const b = this.bbox();
    return (b ? `Overall ${b.map(n => n.toFixed(1)).join(' x ')} mm.  ` : '') + 'General tolerances ISO 2768-m unless stated.';
  });
  notesLine = computed(() => this.spec()?.notes || this.autoNotes());
  titleBlock = computed<[string, string, number][]>(() => {
    const s = this.spec();
    const values: Record<string, string> = {
      TITLE: s?.title || this.title(), PROJECT: this.model().split('/')[0], RELEASE: '-',
      SCALE: this.sheetScale(), UNITS: 'mm',
      DATE: new Date().toISOString().slice(0, 10), SHEET: '1 / 1' };
    return TB_COLS.map(([k, w]) => [k, values[k], w]);
  });

  // ---- loading -----------------------------------------------------------

  ngOnInit() {
    this.draw.set(this.status());
    const id = this.model();
    this.http.get<LayoutOut>(`/api/models/${id}/drawing/layout`).subscribe({
      next: l => {
        this.version = l.version;
        this.kept.set(l.spec);
        this.begin(l.spec);
      },
      error: e => {
        Toast.show(t('The drawing layout could not be read.') + ' ' + (e.error?.detail ?? e.status), { tone: 'danger' });
        this.begin(null);
      },
    });
    this.poll(true);
  }

  ngOnDestroy() { clearTimeout(this.timer); }

  /** The spec to edit: the kept one, else the boxes of the automatic
   *  drawing as made, else the standard arrangement. */
  private begin(spec: LayoutSpec | null) {
    const s = spec ? structuredClone(spec) : this.fromDrawing();
    this.spec.set(s);
    this.start.set(structuredClone(s));
    this.sel.set(0);
  }

  private fromDrawing(): LayoutSpec {
    const made = this.made();
    const portrait = (made?.sheet ?? '').includes('portrait');
    const base: LayoutSpec = { sheet: { size: 'auto', orientation: portrait ? 'portrait' : 'landscape' }, views: [],
                               parts: { hide: [], highlight: [] }, title: null, notes: null };
    const views = (made?.boxes ?? []).filter(b => b.view && VIEWS.includes(b.view as ViewKey))
      .map(b => ({ ...box(b.view as ViewKey, b.x ?? 0, b.y ?? 0, b.w ?? .2, b.h ?? .2), scale: b.scale || 'auto' }));
    base.views = views.length ? views : this.arrange('standard', this.frame());
    return base;
  }

  viewName(v: ViewKey) { return t(NAMES[v]); }
  /** A fraction of the sheet in mm along x (0) or y (1). */
  mmOf(f: number, axis: 0 | 1) { return Math.round(f * this.paper()[axis]); }
  /** A side as % of the space for views. */
  share(f: number, axis: 0 | 1) {
    const fr = this.frame();
    return Math.round(f / (axis ? fr.y2 - fr.y : fr.x2 - fr.x) * 100);
  }

  // ---- changing it ---------------------------------------------------------

  private edit(fn: (s: LayoutSpec) => void) {
    const s = this.spec();
    if (!s || !this.canSave()) return;
    const next = structuredClone(s);
    fn(next);
    this.spec.set(next);
  }

  set(change: Partial<ViewBox>) {
    this.edit(s => {
      const b = s.views[this.sel()];
      if (!b) return;
      Object.assign(b, change);
      if (change.view === 'iso') { b.dims = false; b.hidden_lines = false; }
      else if (change.view && !b.dims && !b.hidden_lines) { b.dims = true; b.hidden_lines = true; }
    });
  }

  /** A number typed for the picked box: mm on the sheet or % of the space
   *  for views; to the millimetre, kept inside the frame. */
  numeric(key: 'x' | 'y' | 'w' | 'h', raw: string, unit: 'mm' | '%') {
    const n = parseFloat(raw);
    if (!isFinite(n)) return;
    const [pw, ph] = this.paper(), fr = this.frame();
    const along = key === 'x' || key === 'w' ? pw : ph;
    const room = key === 'x' || key === 'w' ? fr.x2 - fr.x : fr.y2 - fr.y;
    const f = unit === 'mm' ? n / along : n / 100 * room;
    this.edit(s => {
      const b = s.views[this.sel()];
      if (b) s.views[this.sel()] = this.inside({ ...b, [key]: f }, 1);
    });
  }

  sheet(change: Partial<LayoutSpec['sheet']>) {
    const before = this.frame();
    this.edit(s => { Object.assign(s.sheet, change); });
    // The boxes keep their place in the space for views of the new sheet.
    const after = this.frame();
    this.edit(s => {
      s.views = s.views.map(b => this.inside({
        ...b,
        x: after.x + (b.x - before.x) / (before.x2 - before.x) * (after.x2 - after.x),
        y: after.y + (b.y - before.y) / (before.y2 - before.y) * (after.y2 - after.y),
        w: b.w / (before.x2 - before.x) * (after.x2 - after.x),
        h: b.h / (before.y2 - before.y) * (after.y2 - after.y) }, 1));
    });
  }

  text(key: 'title' | 'notes', value: string) { this.edit(s => { s[key] = value.trim() ? value : null; }); }

  part(list: 'hide' | 'highlight', name: string, on: boolean) {
    this.edit(s => {
      s.parts[list] = s.parts[list].filter(n => n !== name);
      if (on) s.parts[list].push(name);
      // Hidden and highlighted at once means nothing: the last click wins.
      const other = list === 'hide' ? 'highlight' : 'hide';
      if (on) s.parts[other] = s.parts[other].filter(n => n !== name);
    });
  }

  /** A view added where there is room: the first free place on the grid,
   *  else over the middle. */
  add() {
    this.edit(s => {
      const f = this.frame();
      const [pw, ph] = this.paper();
      const w = Math.min(.25, f.x2 - f.x), h = Math.min(.3, f.y2 - f.y);
      let at: [number, number] | null = null;
      for (let y = f.y; !at && y + h <= f.y2 + 1e-6; y += GRID / ph) {
        for (let x = f.x; x + w <= f.x2 + 1e-6; x += GRID / pw) {
          if (!s.views.some(b => x < b.x + b.w && b.x < x + w && y < b.y + b.h && b.y < y + h)) { at = [x, y]; break; }
        }
      }
      const [x, y] = at ?? [(f.x + f.x2 - w) / 2, (f.y + f.y2 - h) / 2];
      s.views.push(this.inside(box(this.adding(), x, y, w, h)));
    });
    this.sel.set((this.spec()?.views.length ?? 1) - 1);
  }

  remove() {
    const i = this.sel();
    if ((this.spec()?.views.length ?? 0) < 2) return;
    this.edit(s => { s.views.splice(i, 1); });
    this.sel.set(Math.max(0, i - 1));
  }

  /** The picked box the size its view needs at its scale (an isometric
   *  view to scale: its view's shape at the box's width). */
  fitContent() {
    const i = this.sel(), f = this.fits()[i];
    const s = this.spec();
    const b = s?.views[i];
    if (!b || !f) return;
    const e = this.extent(b.view);
    if (!e) { Toast.show(t('The model\'s size is not known yet: build it or make the drawing once.')); return; }
    const [pw, ph] = this.paper();
    let [wm, hm] = f.need;
    if (b.view === 'iso' && !ratio(b.scale)) {
      const { w } = this.boxMm(b, this.paper());
      wm = w;
      hm = (w - 8) * e[1] / Math.max(e[0], 1e-9) + PAD.dims[2] + 4;
    }
    this.edit(sp => { sp.views[i] = this.inside({ ...b, w: (wm + 2) / pw, h: (hm + 2) / ph }); });
  }

  /** Every view the same size, in an even grid, in the order they are in. */
  equalise() {
    const s = this.spec();
    if (!s) return;
    const n = s.views.length;
    const cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);
    const cells = this.grid(this.frame(), cols, rows);
    this.edit(sp => { sp.views = sp.views.map((b, i) => this.inside({ ...b, ...cells[i] })); });
  }

  /** `cols` × `rows` equal cells of the frame, a gap between them. */
  private grid(f: { x: number; y: number; x2: number; y2: number }, cols: number, rows: number) {
    const [pw, ph] = this.paper();
    const gx = GAP / pw, gy = GAP / ph;
    const w = (f.x2 - f.x - gx * (cols - 1)) / cols, h = (f.y2 - f.y - gy * (rows - 1)) / rows;
    const out: { x: number; y: number; w: number; h: number }[] = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.push({ x: f.x + c * (w + gx), y: f.y + r * (h + gy), w, h });
    return out;
  }

  /** An arrangement's boxes in a frame. */
  private arrange(p: Preset, f: { x: number; y: number; x2: number; y2: number }): ViewBox[] {
    const [pw, ph] = this.paper();
    const gx = GAP / pw, gy = GAP / ph;
    const W = f.x2 - f.x, H = f.y2 - f.y;
    const at = (v: ViewKey, x: number, y: number, w: number, h: number) =>
      box(v, f.x + x * W, f.y + y * H, w * W - (x + w < .999 ? gx : 0), h * H - (y + h < .999 ? gy : 0));
    switch (p) {
      case 'front': return [at('front', 0, 0, .68, 1), at('right', .68, 0, .32, .5), at('iso', .68, .5, .32, .5)];
      case 'iso': return [{ ...at('iso', 0, 0, 1, 1) }];
      case 'notes': return [at('front', 0, 0, .58, .55), at('top', 0, .55, .58, .45)];
      case 'six': return (['front', 'back', 'left', 'right', 'top', 'bottom', 'iso'] as ViewKey[])
        .map((v, i) => at(v, (i % 4) / 4, Math.floor(i / 4) / 2, .25, .5));
      default: return [at('front', 0, 0, .58, .55), at('right', .58, 0, .42, .55), at('top', 0, .55, .58, .45),
                       at('iso', .58, .55, .42, .45)];
    }
  }

  preset(p: Preset) {
    this.edit(s => { s.views = this.arrange(p, this.frame()).map(b => this.inside(b, 1)); });
    this.sel.set(0);
  }

  /** `b` snapped to `grid` mm and kept inside the frame. */
  private inside(b: ViewBox, grid = GRID): ViewBox {
    const [pw, ph] = this.paper();
    const f = this.frame();
    const snap = (v: number, n: number) => Math.round(v * n / grid) * grid / n;
    let w = Math.max(MIN_MM / pw, Math.min(snap(b.w, pw), f.x2 - f.x));
    let h = Math.max(MIN_MM / ph, Math.min(snap(b.h, ph), f.y2 - f.y));
    const x = Math.min(Math.max(snap(b.x, pw), f.x), f.x2 - w);
    const y = Math.min(Math.max(snap(b.y, ph), f.y), f.y2 - h);
    w = Math.min(w, f.x2 - x);
    h = Math.min(h, f.y2 - y);
    const r = (v: number) => Math.round(v * 10000) / 10000;
    return { ...b, x: r(x), y: r(y), w: r(w), h: r(h) };
  }

  // ---- dragging and sizing ------------------------------------------------

  private drag: { i: number; grip: Grip; px: number; py: number; from: ViewBox; id: number } | null = null;

  grab(ev: PointerEvent, i: number, grip: Grip) {
    ev.stopPropagation();
    this.sel.set(i);
    if (!this.canSave() || ev.button !== 0) return;
    const from = this.spec()?.views[i];
    if (!from) return;
    ev.preventDefault();
    (ev.currentTarget as HTMLElement).focus?.({ preventScroll: true });
    this.drag = { i, grip, px: ev.clientX, py: ev.clientY, from: { ...from }, id: ev.pointerId };
    this.dragging.set(true);
  }

  @HostListener('document:pointermove', ['$event'])
  onMove(ev: PointerEvent) {
    const d = this.drag, el = this.sheetEl()?.nativeElement;
    if (!d || !el || ev.pointerId !== d.id) return;
    const r = el.getBoundingClientRect();
    const dx = (ev.clientX - d.px) / r.width, dy = (ev.clientY - d.py) / r.height;
    const f = d.from, [pw, ph] = this.paper();
    let { x, y, w, h } = f;
    if (d.grip === 'move') { x += dx; y += dy; }
    if (d.grip === 'nw' || d.grip === 'sw') { x = Math.min(f.x + dx, f.x + f.w - MIN_MM / pw); w = f.x + f.w - x; }
    if (d.grip === 'ne' || d.grip === 'se') { w = f.w + dx; }
    if (d.grip === 'nw' || d.grip === 'ne') { y = Math.min(f.y + dy, f.y + f.h - MIN_MM / ph); h = f.y + f.h - y; }
    if (d.grip === 'sw' || d.grip === 'se') { h = f.h + dy; }
    const fr = this.frame();
    if (d.grip !== 'move') {           // sizing never pushes the box: its far side stays put
      if (x < fr.x) { w -= fr.x - x; x = fr.x; }
      if (y < fr.y) { h -= fr.y - y; y = fr.y; }
      w = Math.min(w, fr.x2 - x);
      h = Math.min(h, fr.y2 - y);
    }
    const next = this.inside({ ...f, x, y, w, h });
    const s = this.spec();
    if (!s || same(s.views[d.i], next)) return;
    const views = s.views.slice();
    views[d.i] = next;
    this.spec.set({ ...s, views });
  }

  @HostListener('document:pointerup', ['$event'])
  @HostListener('document:pointercancel', ['$event'])
  onUp(ev: PointerEvent) {
    if (this.drag?.id === ev.pointerId) { this.drag = null; this.dragging.set(false); }
  }

  @HostListener('document:keydown', ['$event'])
  onKey(ev: KeyboardEvent) {
    if (ev.key === 'Escape') {
      if (this.drag || document.querySelector('.wb-sel-pop')) return;          // a list open closes first
      ev.preventDefault();
      if (this.asking()) this.asking.set(false); else this.close();
      return;
    }
    const typing = (ev.target as HTMLElement)?.closest?.('input, textarea, select, [contenteditable]');
    if (typing || !this.canSave() || !this.picked() || this.asking()) return;
    if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); this.remove(); return; }
    const step: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const s = step[ev.key];
    if (!s) return;
    ev.preventDefault();
    // Shift moves a millimetre; a plain arrow a grid step.
    const n = ev.shiftKey ? 1 : GRID;
    const [pw, ph] = this.paper();
    this.edit(sp => {
      const b = sp.views[this.sel()];
      sp.views[this.sel()] = this.inside({ ...b, x: b.x + s[0] * n / pw, y: b.y + s[1] * n / ph }, n);
    });
  }

  // ---- saving and making -------------------------------------------------

  /** Closing with changes asks first. */
  close() {
    if (this.saving()) return;
    if (this.dirty() && this.canSave()) { this.asking.set(true); return; }
    this.closed.emit();
  }

  save() { this.keep(this.spec()); }

  reset() { this.keep(null); }

  /** Keep `spec` on the model (null: automatic), then make the drawing with it. */
  private keep(spec: LayoutSpec | null) {
    const id = this.model();
    if (this.saving()) return;
    this.saving.set(true);
    this.http.put<LayoutOut>(`/api/models/${id}/drawing/layout`, { spec, version: this.version, names: this.names() }).subscribe({
      next: l => {
        this.version = l.version;
        this.kept.set(l.spec);
        if (spec) this.start.set(structuredClone(this.spec()));
        if (!this.canMake()) {
          this.saving.set(false);
          Toast.show(t('Layout saved. Making the drawing needs the right to run builds.'));
          if (!spec) this.begin(null);
          return;
        }
        // Automatic again: its drawing may well be kept already - made only if not.
        this.http.post<DrawState>(`/api/models/${id}/drawing${spec ? '?again=1' : ''}`, {}).subscribe({
          next: d => { this.saving.set(false); this.follow(d, !spec); },
          error: e => {
            this.saving.set(false);
            Toast.show(t('The technical drawing could not be made.') + ' ' + (e.error?.detail ?? e.status), { tone: 'danger', ms: 8000 });
          },
        });
      },
      error: e => {
        this.saving.set(false);
        Toast.show(t('The drawing layout could not be saved.') + ' ' + (e.error?.detail ?? e.status), { tone: 'danger', ms: 8000 });
      },
    });
  }

  /** Follow the making every second; when done, the new drawing under the
   *  boxes (and, back to automatic, its boxes). */
  private follow(d: DrawState, reseed = false) {
    clearTimeout(this.timer);
    this.draw.set(d);
    if (d.state === 'making' || d.state === 'queued') {
      this.timer = setTimeout(() => this.poll(false, reseed), 1000);
      return;
    }
    this.made_.emit();
    if (reseed) this.begin(null);
    if (d.state === 'ready') Toast.show(t('The drawing is made with the layout.'));
  }

  private poll(first: boolean, reseed = false) {
    const id = this.model();
    this.http.get<DrawState>(`/api/models/${id}/drawing/status`).subscribe({
      next: d => {
        if (!first) { this.follow(d, reseed); return; }
        this.draw.set(d);
        // No layout of its own yet: begin from this drawing's boxes.
        if (!this.kept() && this.spec() && !this.dirty() && d.made?.boxes?.length) this.begin(null);
        if (d.state === 'making' || d.state === 'queued') this.timer = setTimeout(() => this.poll(false), 1000);
      },
      error: () => { /* the tab says what is wrong */ },
    });
  }
}
