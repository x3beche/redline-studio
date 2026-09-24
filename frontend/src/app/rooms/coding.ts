import {
  Component, ElementRef, OnDestroy, OnInit, computed, effect, inject, input, signal,
  untracked, viewChild,
} from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { forkJoin } from 'rxjs';
import {
  Activity, AppCompute, AppDiff, AppEntry, AppShot, AppStatus, Api, Apps,
  DomHit, Health, LogLine, Revision, SystemInfo, TestRun,
} from '../api';
import type { Tool } from '../editor/editor';
import { CodeDraft, Selection } from '../selection';
import { FIRST_PEN, Mark, PENS, TOOLS, extent, paint } from './sketch';

type Platform = 'web' | 'embedded' | 'mobile';

/** The sizes a page is looked at. A note is drawn at one of them and the
 *  after shot is taken at the same one. */
const VIEWPORTS: { key: string; w: number; h: number; label: string }[] = [
  { key: 'desktop', w: 1280, h: 800, label: '1280' },
  { key: 'tablet', w: 820, h: 1180, label: '820' },
  { key: 'phone', w: 390, h: 844, label: '390' },
];

/** The coding rooms: Web, Embedded and Mobile.
 *
 *  Redlining a running interface. Somebody already does this by hand -
 *  screenshots the page, draws on it, says "this gap", "centre that".
 *  Here the screenshot is taken for them by a real browser, the marks are
 *  laid on the elements under them so the note says which button in
 *  which file, and the change comes back as a diff with the test suite as
 *  the check and the same screen afterwards as the "after".
 *
 *  One component for three tabs. A web page, a firmware image and a phone
 *  app go through the same loop; what differs is what there is to look at,
 *  and today only a page served over HTTP can be looked at. The other two
 *  keep everything else - notes, diff, tests, log, machine - and say so.
 *
 *  Laid out like the board room, because it is the same kind of room: a
 *  grid of panes that are all on screen at once, the log along the bottom
 *  with its ⤢, and what the machine spent in the corner.
 */
@Component({
  selector: 'app-room-coding',
  template: `
<div class="tcv-room absolute inset-0 flex min-h-0 flex-col">

  @if (!here()) {
    <p class="p-3 text-[12px]" style="color: var(--ink-dim)">
      Pick a project in the catalog - a <b>{{ ext() }}</b> opens here.
      @if (!mine().length) {
        There is none yet: <code>PUT /api/apps/&lt;id&gt;</code> with the
        checkout, its url and its test command makes one.
      }
    </p>
  } @else {

  <div class="grid min-h-0 flex-1 gap-2 p-2"
       style="grid-template-columns: 11fr 7fr; grid-template-rows: 5fr 4fr 3fr">

    <!-- THE PAGE, RUNNING
         The project's own dev server in a frame, at the size it is being
         judged at. Freezing swaps the frame for a real screenshot of the
         same route at the same size, taken by headless Chrome, and the
         pens go over that - a frame cannot be drawn on, and a picture of
         what the browser rendered is what the note has to carry. -->
    <section class="tcv-pane" style="grid-column: 1"
             [style.grid-row]="tall() ? '1' : '1 / span 2'">
      <header class="tcv-pane-head">
        <span class="tcv-label">{{ platform() === 'embedded' ? 'firmware'
                                   : platform() === 'mobile' ? 'phone' : 'preview' }}</span>
        <span class="h-1.5 w-1.5 shrink-0 rounded-full"
              [style.background]="live() ? 'var(--ok)' : 'var(--danger)'"
              [title]="liveNote()"></span>
        @if (frozen()) {
          <span class="mono min-w-0 flex-1 truncate text-[10px]" style="color: var(--ink-dim)">
            {{ shot()?.width }} × {{ shot()?.height }} · {{ platform() === 'embedded' ? 'as built' : route() }}
            · {{ shot()?.elements }} elements
          </span>
        } @else if (platform() === 'embedded') {
          <!-- What the build made of it, in the head the way the board
               room puts its size over the layout. Built by the agent. -->
          <span class="mono min-w-0 flex-1 truncate text-[10px]" style="color: var(--ink-dim)">
            @if (here()!.firmware; as fw) {
              {{ fw.ok ? 'built' : 'build failed' }} {{ fw.at.slice(11, 16) }}
              @for (r of usedRegions(); track r.name) { · {{ r.name }} {{ r.pct.toFixed(2) }}% }
            } @else { not built yet - the agent builds it (revisions.py code build) }
          </span>
        } @else {
          @if (platform() === 'web' || here()!.url) {
            <input [value]="route()" (change)="setRoute($any($event.target).value)"
                   (keydown.enter)="setRoute($any($event.target).value)"
                   [attr.list]="'routes-' + platform()"
                   class="tcv-field mono min-w-0 flex-1 px-1.5 py-0.5 text-[11px]"
                   title="the route, after {{ here()!.url }}">
            <datalist [id]="'routes-' + platform()">
              @for (r of here()!.routes; track r) { <option [value]="r"></option> }
            </datalist>
          } @else {
            <span class="mono min-w-0 flex-1 truncate text-[10px]" style="color: var(--ink-dim)">
              {{ here()!.package }}
            </span>
          }
          @if (platform() === 'web') {
            @for (v of viewports; track v.key) {
              <button (click)="setViewport(v.key)" class="tcv-chip shrink-0 px-1.5 py-0"
                      [attr.data-on]="viewport().key === v.key ? 1 : null"
                      [title]="v.key + ' · ' + v.w + ' × ' + v.h">{{ v.label }}</button>
            }
            <button (click)="reload()" class="tcv-chip shrink-0 px-1.5 py-0"
                    title="load the page again">↻</button>
          }
        }
        <!-- The 3D room's own freeze control: the viewer's button markup
             and the same pen glyph, loud while the page is held. -->
        <span class="tcv_tooltip shrink-0" [attr.data-on]="frozen() ? 1 : null">
          <span class="tcv_button_frame">
            <button class="tcv_reset tcv_btn tcv-freeze"
                    [attr.data-on]="frozen() ? 1 : null"
                    [disabled]="shooting() || !canLook()"
                    (click)="frozen() ? resume() : freeze()"
                    [title]="frozen() ? 'let the page go' : 'photograph the page and draw on it'"></button>
          </span>
        </span>
      </header>

      <!-- The drawing tools, while the page is held. The same row the 3D
           room docks in its viewer's toolbar: tools, inks, width, undo. -->
      @if (frozen()) {
        <div class="tcv-draw tcv-draw-row">
          @for (t of tools; track t.id) {
            <button (click)="tool.set(t.id)" [title]="t.label"
                    class="tcv-btn tcv-draw-btn"
                    [style.background]="tool() === t.id ? 'var(--accent)' : null"
                    [style.color]="tool() === t.id ? 'var(--ink-bright)' : null">{{ t.glyph }}</button>
          }
          <span class="tcv-draw-sep"></span>
          @for (c of PENS; track c) {
            <button (click)="color.set(c)" [style.background]="c"
                    class="tcv-draw-swatch"
                    [style.outline]="color() === c ? '2px solid var(--ink)' : 'none'"
                    [style.outline-offset]="'1px'"></button>
          }
          @if (tool() === 'text') {
            <input type="range" min="10" max="48" [value]="fontSize()"
                   (input)="fontSize.set($any($event.target).valueAsNumber)"
                   class="tcv-draw-range" style="accent-color: var(--accent)" title="Text size">
            <span class="tcv-label tcv-draw-num">{{ fontSize() }}</span>
          } @else {
            <input type="range" min="1" max="16" [value]="penWidth()"
                   (input)="penWidth.set($any($event.target).valueAsNumber)"
                   class="tcv-draw-range" style="accent-color: var(--accent)" title="Stroke width">
            <span class="tcv-label tcv-draw-num">{{ penWidth() }}</span>
          }
          <span class="tcv-draw-sep"></span>
          <button (click)="undo()" class="tcv-btn tcv-draw-text">Undo</button>
          <button (click)="clear()" class="tcv-btn tcv-draw-text">Clear</button>
        </div>
      }

      <!-- Dark around the page, the way the board sits on black: the
           frame is what is being looked at, and a light surround bleeds
           into a light page. The page itself renders as it really does. -->
      <div #box class="tcv-preview relative min-h-0 flex-1 overflow-hidden">
        @if (!canLook()) {
          <p class="p-3 text-[12px]" style="color: var(--ink-dim)">
            {{ platform() === 'embedded'
               ? 'Not built yet. The agent builds the firmware in the Embedded Programming container, and what it made of the source - memory and the largest symbols, each with its file - is drawn here.'
               : 'This project has no url to show. Give it one, and the page it serves is framed here.' }}
          </p>
        } @else if (framed) {
          <!-- Redline framing Redline: the page in the frame shares this
               origin's storage, opens its own Web room and would frame
               itself again, all the way down. One level is enough. -->
          <p class="p-3 text-[12px]" style="color: var(--ink-dim)">
            This page is already inside a frame, so it does not frame another.
          </p>
        } @else if (!live() && !frozen()) {
          <div class="p-3 text-[12px]" style="color: var(--ink-dim)">
            @if (platform() === 'mobile') {
              <!-- The phone is the Mobile Programming container's; the agent
                   starts it (revisions.py code phone). -->
              <p>The phone is off. The agent starts it in the Mobile Programming
                 container - ask in the thread.</p>
            } @else {
              <p class="mb-2">Nothing answers at <span class="mono">{{ here()!.url }}</span>.</p>
              @if (here()!.dev) {
                <!-- Started by the agent (revisions.py code serve), not from
                     a button: the person marks, the agent runs things. -->
                <p>The agent starts it with <span class="mono">{{ here()!.dev }}</span>
                   - ask in the thread.</p>
              }
            }
          </div>
        } @else {
          <div class="absolute" [style.left.px]="fit().x" [style.top.px]="fit().y"
               [style.width.px]="fit().w" [style.height.px]="fit().h"
               [class.tcv-phone]="platform() === 'mobile'">
            @if (!frozen()) {
              @if (platform() === 'mobile') {
                <!-- The phone's own screen, a picture every second and a
                     half: there is no frame to put a phone in. -->
                <img [src]="screenUrl()" alt="the phone's screen" class="block h-full w-full"
                     draggable="false" (load)="phoneSized($event)">
              } @else {
                <!-- Drawn at its real size and scaled down, so a 1280 px page
                     lays itself out as 1280 px wide, not as the pane is. -->
                <iframe [src]="frameUrl()" title="preview" class="tcv-preview-frame"
                        [style.width.px]="liveSize().w" [style.height.px]="liveSize().h"
                        [style.transform]="'scale(' + fit().k + ')'"></iframe>
              }
            } @else if (shot(); as s) {
              <img [src]="s.image" alt="the page, frozen" class="block h-full w-full" draggable="false">
              <!-- What the marks landed on, outlined over the picture but
                   not into it: the saved drawing is the person's marks. -->
              @for (d of dom(); track d.selector) {
                <div class="tcv-hit" [title]="d.selector"
                     [style.left.px]="d.box[0] * fit().k" [style.top.px]="d.box[1] * fit().k"
                     [style.width.px]="d.box[2] * fit().k" [style.height.px]="d.box[3] * fit().k"></div>
              }
            }
            <canvas #overlay class="absolute left-0 top-0 h-full w-full"
                    [class.hidden]="!frozen()" [class.cursor-crosshair]="frozen()"
                    (pointerdown)="down($event)" (pointermove)="move($event)"
                    (pointerup)="up()" (pointerleave)="up()"></canvas>
            @if (typing(); as tp) {
              <input #caret class="absolute rounded px-1 py-0.5 text-sm outline-none"
                     [style.left.px]="tp.left" [style.top.px]="tp.top - 12"
                     [style.color]="color()" [style.font-size.px]="fontSize()"
                     style="background: var(--draw-label); border: 1px dashed currentColor;
                            min-width: 120px; transform: translateY(-2px)"
                     placeholder="label…"
                     (keydown.enter)="commitText($any($event.target).value)"
                     (keydown.escape)="typing.set(null)"
                     (blur)="commitText($any($event.target).value)">
            }
          </div>
          @if (shooting()) {
            <div class="absolute bottom-3 left-1/2 -translate-x-1/2 rounded px-3 py-1.5 text-[12px]"
                 style="background: var(--shade); color: var(--ink)">photographing {{ route() }}…</div>
          }
        }
      </div>

      <!-- What the marks are about, in the words the note will use. -->
      @if (frozen()) {
        <div class="mono flex shrink-0 flex-wrap gap-1 px-2 py-1 text-[10px]"
             style="border-top: 1px solid var(--line)">
          @for (l of labels(); track l) {
            <span class="tcv-chip px-1.5 py-0" style="color: var(--ink)">{{ l }}</span>
          } @empty {
            <span style="color: var(--ink-dim)">
              ring something or point at it - what is under the mark goes into the note
            </span>
          }
        </div>
      }
      @if (note(); as n) {
        <p class="mono shrink-0 truncate px-2 pb-1 text-[10px]" style="color: var(--warn)"
           [title]="n">{{ n }}</p>
      }
    </section>

    <!-- THE LOG
         The room's own, like the board room's: what was frozen, what the
         tests said, what the agent is doing. The server tab is the dev
         server's output when this room started it. -->
    <section class="tcv-pane" style="grid-column: 1"
             [style.grid-row]="tall() ? '2 / span 2' : '3'">
      <header class="tcv-pane-head">
        <button (click)="setBottom('log')" class="tcv-chip"
                [attr.data-on]="bottom() === 'log' ? 1 : null">log</button>
        <!-- The second tab is what the machine said: the dev server's
             output for a page or a phone app, the build's for firmware. -->
        <button (click)="setBottom('server')" class="tcv-chip"
                [attr.data-on]="bottom() === 'server' ? 1 : null">
          {{ platform() === 'embedded' ? 'build' : 'server' }}</button>
        <span class="mono ml-auto text-[10px]" style="color: var(--ink-dim)">
          {{ bottom() === 'log' ? log().length + ' lines' : serverLines().length + ' lines' }}
        </span>
        <button (click)="toggleTall()" class="tcv-chip shrink-0"
                [title]="tall() ? 'back to its size' : 'taller, over the preview'">
          {{ tall() ? '⤡' : '⤢' }}
        </button>
      </header>
      <div #logBox class="tcv-scroll mono min-h-0 flex-1 overflow-y-auto px-2 py-1 text-[11px]">
        @if (bottom() === 'log') {
          @for (l of log(); track l._id) {
            <div class="flex gap-2 leading-snug">
              <span class="shrink-0" style="color: var(--line)">{{ l.at.slice(11, 19) }}</span>
              <span [style.color]="levelColor(l.level)">{{ l.text }}</span>
            </div>
          } @empty {
            <div style="color: var(--ink-dim)">no activity yet</div>
          }
        } @else {
          @for (l of serverLines(); track $index) {
            <div class="whitespace-pre-wrap break-all leading-snug" style="color: var(--ink-dim)">{{ l }}</div>
          } @empty {
            <div style="color: var(--ink-dim)">
              {{ platform() === 'embedded'
                 ? 'No build yet. The agent builds in the Embedded Programming container, and its output lands here.'
                 : 'Nothing from the dev server. It prints here when the agent started it; one started elsewhere writes to its own terminal.' }}
            </div>
          }
        }
      </div>
    </section>

    <!-- THE CHANGE
         The working tree against HEAD, or one note's own change: only the
         files that moved since that note was drawn, so somebody else's
         uncommitted work in the same checkout stays out of it. A note's
         before and after sit over its diff - the same route, the same
         size, two pictures. -->
    <section class="tcv-pane" style="grid-column: 2; grid-row: 1">
      <header class="tcv-pane-head">
        <span class="tcv-label">diff</span>
        <select [value]="diffOf() ?? ''" (change)="pickDiff($any($event.target).value)"
                class="tcv-field min-w-0 flex-1 px-1 py-0 text-[11px]">
          <option value="">working tree</option>
          @for (r of notes(); track r.id) {
            <option [value]="r.id">{{ noteLine(r) }}</option>
          }
        </select>
        @if (diff(); as d) {
          <span class="mono shrink-0 text-[10px]">
            <span style="color: var(--ok)">+{{ d.added }}</span>
            <span style="color: var(--danger)"> −{{ d.removed }}</span>
            <span style="color: var(--ink-dim)"> · {{ d.files.length }}</span>
          </span>
        }
        <button (click)="loadDiff()" class="tcv-chip shrink-0 px-1.5 py-0" title="read it again">↻</button>
      </header>
      <div class="tcv-scroll min-h-0 flex-1 overflow-auto">
        @if (diffNote(); as r) {
          @if (r.image_bytes) {
            <div class="flex gap-1 p-1.5" style="border-bottom: 1px solid var(--line)">
              <a [href]="api.imageUrl(r.id)" target="_blank"
                 class="relative block min-w-0 flex-1 overflow-hidden rounded"
                 style="border: 1px solid var(--line)" title="before, with the marks">
                <img [src]="api.imageUrl(r.id)" alt="before" class="block h-24 w-full object-contain"
                     style="background: var(--pcb-bg)">
                <span class="absolute left-0 top-0 px-1 text-[9px] uppercase"
                      style="background: var(--surface-2); color: var(--ink-dim)">before</span>
              </a>
              <a [href]="r.image_after_bytes ? api.imageUrl(r.id, 'after') : null" target="_blank"
                 class="relative flex min-w-0 flex-1 items-center justify-center overflow-hidden rounded"
                 style="border: 1px solid var(--line); background: var(--pcb-bg)"
                 title="after: the same route at the same size">
                @if (r.image_after_bytes) {
                  <img [src]="api.imageUrl(r.id, 'after')" alt="after" class="block h-24 w-full object-contain">
                } @else {
                  <span class="text-[10px]" style="color: var(--ink-dim)">no after shot yet</span>
                }
                <span class="absolute left-0 top-0 px-1 text-[9px] uppercase"
                      style="background: var(--surface-2); color: var(--ok)">after</span>
              </a>
            </div>
          }
        }
        @if (diff(); as d) {
          @for (f of d.files; track f.path) {
            <div class="tcv-diff-file" (click)="foldFile(f.path)">
              <span class="shrink-0" style="color: var(--ink-dim)">{{ shutFiles().has(f.path) ? '▸' : '▾' }}</span>
              <span class="min-w-0 flex-1 truncate" [title]="f.path">{{ f.path }}</span>
              @if (f.status !== 'modified') {
                <span class="shrink-0" [style.color]="f.status === 'deleted' ? 'var(--danger)' : 'var(--ok)'">{{ f.status }}</span>
              }
              <span class="shrink-0" style="color: var(--ok)">+{{ f.added }}</span>
              <span class="shrink-0" style="color: var(--danger)">−{{ f.removed }}</span>
            </div>
            @if (!shutFiles().has(f.path)) {
              @if (f.binary) {
                <div class="tcv-diff-line px-2" style="color: var(--ink-dim)">binary file</div>
              }
              @for (h of f.hunks; track $index) {
                <div class="tcv-diff-hunk">{{ h.head }}</div>
                @for (l of h.lines; track $index) {
                  <div class="tcv-diff-line" [attr.data-k]="l[0]">
                    <span class="tcv-diff-no">{{ l[1] ?? '' }}</span>
                    <span class="tcv-diff-no">{{ l[2] ?? '' }}</span>
                    <span class="tcv-diff-text">{{ l[0] }}{{ l[3] }}</span>
                  </div>
                }
              }
              @if (f.cut) {
                <div class="tcv-diff-hunk">… cut here, the rest is too long to show</div>
              }
            }
          } @empty {
            <p class="p-2 text-[12px]" style="color: var(--ink-dim)">
              {{ diffOf() ? 'Nothing has changed since this note was drawn.'
                          : 'The working tree matches HEAD.' }}
            </p>
          }
        } @else {
          <p class="p-2 text-[12px]" style="color: var(--ink-dim)">{{ diffNote_() }}</p>
        }
      </div>
    </section>

    <!-- THE CHECK
         A note is not done until these pass and the after shot is taken.
         A pass counts for the tree it ran on: change a file and it says
         so, rather than showing a green that belongs to yesterday. -->
    <section class="tcv-pane" style="grid-column: 2; grid-row: 2">
      <header class="tcv-pane-head">
        <span class="tcv-label">tests</span>
        @if (tests(); as t) {
          <span class="mono shrink-0 rounded px-1.5 text-[10px] font-bold uppercase"
                [style.background]="t.ok ? 'var(--ok)' : 'var(--danger)'"
                style="color: var(--ink-bright)">{{ t.ok ? 'pass' : 'fail' }}</span>
          <span class="mono min-w-0 truncate text-[10px]" style="color: var(--ink-dim)">
            {{ countLine(t) }} · {{ secs(t.wall_s) }}
            @if (t.current === false) { · <span style="color: var(--warn)">tree changed since</span> }
          </span>
        }
        <!-- No run button: the agent runs the check (revisions.py code
             test), the way it builds a board. This pane reads it out. -->
        @if (!tests()) {
          <span class="mono ml-auto shrink-0 text-[10px]" style="color: var(--ink-dim)">run by the agent</span>
        }
      </header>
      <div class="tcv-scroll mono min-h-0 flex-1 overflow-auto px-2 py-1 text-[11px]">
        @if (tests(); as t) {
          <div class="mb-1 truncate" style="color: var(--ink-dim)" [title]="t.command">
            $ {{ t.command }} · {{ t.at.slice(11, 19) }} · exit {{ t.rc }}
          </div>
          <pre class="whitespace-pre-wrap break-all leading-snug" style="color: var(--ink)">{{ t.tail }}</pre>
        } @else {
          <div style="color: var(--ink-dim)">
            {{ here()!.test ? 'Not run yet. The agent runs ' + here()!.test + ' when it works a note.'
                            : 'This project has no test command.' }}
          </div>
        }
      </div>
    </section>

    <!-- WHAT IT COST, AND WHAT THE MACHINE IS DOING
         Every freeze is a browser and every check is a test run; the board
         room counts its builds the same way. -->
    <section class="tcv-pane" style="grid-column: 2; grid-row: 3">
      <header class="tcv-pane-head">
        <span class="tcv-label">machine</span>
        @if (cost(); as c) {
          <span class="mono ml-auto text-[10px]" style="color: var(--ink-dim)">
            {{ c.total.jobs }} jobs · {{ cores(c.total.cpu_s) }}
          </span>
        }
      </header>
      <div class="min-h-0 flex-1 overflow-auto p-2 text-[11px]">
        @if (cost()?.jobs?.length) {
          <div class="mono">
            @for (j of cost()!.jobs.slice(0, 5); track j.at) {
              <div class="flex gap-2 leading-relaxed">
                <span class="w-11 shrink-0"
                      [style.color]="j.rc ? 'var(--danger)' : 'var(--ink)'">{{ j.kind }}</span>
                <span class="shrink-0" style="color: var(--ink-dim)">{{ secs(j.wall_s) }}</span>
                <span class="ml-auto shrink-0 truncate" style="color: var(--ink-dim)">{{ cores(j.cpu_s) }}</span>
              </div>
            }
          </div>
        } @else {
          <div style="color: var(--ink-dim)">nothing run yet</div>
        }
        @if (status()?.git; as g) {
          <div class="mono mt-2 pt-2" style="border-top: 1px solid var(--line); color: var(--ink-dim)">
            <div class="flex justify-between leading-relaxed">
              <span>{{ g.branch }}</span><span>{{ g.short }}</span>
            </div>
            <div class="flex justify-between leading-relaxed">
              <span>uncommitted</span><span>{{ g.dirty }} files</span>
            </div>
          </div>
        }
        @if (sys()) {
          <div class="mt-2 pt-2" style="border-top: 1px solid var(--line)">
            @for (g of gauges(); track g.key) {
              <div class="mb-1.5">
                <div class="flex justify-between leading-tight">
                  <span class="truncate" [title]="g.tip">{{ g.key }}</span>
                  <span class="mono shrink-0" style="color: var(--ink-dim)">{{ g.read }}</span>
                </div>
                <div class="mt-0.5 h-[3px] overflow-hidden rounded" style="background: var(--line)">
                  <div class="h-full rounded transition-[width] duration-500"
                       [style.width.%]="g.pct" style="background: var(--accent)"></div>
                </div>
              </div>
            }
          </div>
        }
      </div>
    </section>

  </div>
  }
</div>`,
})
export class RoomCoding implements OnInit, OnDestroy {
  platform = input.required<Platform>();

  /** Read by the template for the before and after URLs. */
  api = inject(Api);
  private apps = inject(Apps);
  private picked = inject(Selection);
  private health = inject(Health);
  private activity = inject(Activity);
  private box = viewChild<ElementRef<HTMLDivElement>>('box');
  private overlay = viewChild<ElementRef<HTMLCanvasElement>>('overlay');
  private caret = viewChild<ElementRef<HTMLInputElement>>('caret');
  private logBox = viewChild<ElementRef<HTMLDivElement>>('logBox');

  readonly viewports = VIEWPORTS;
  /** Whether this page is itself the one being previewed. */
  readonly framed = window !== window.top;
  readonly tools = TOOLS;
  readonly PENS = PENS;

  all = signal<AppEntry[]>([]);
  here = signal<AppEntry | null>(null);
  status = signal<AppStatus | null>(null);
  note = signal('');

  route = signal('/');
  viewport = signal(VIEWPORTS[0]);
  /** Bumped to load the frame again: the same URL twice is not a reload. */
  private nonce = signal(0);
  /** The preview's box, measured, so the page can be scaled into it. */
  private room = signal({ w: 0, h: 0 });

  frozen = signal(false);
  shooting = signal(false);
  shot = signal<AppShot | null>(null);
  dom = signal<DomHit[]>([]);
  labels = signal<string[]>([]);
  tool = signal<Tool>('pen');
  color = signal(FIRST_PEN);
  penWidth = signal(4);
  fontSize = signal(18);
  typing = signal<{ left: number; top: number } | null>(null);
  private typeAt: [number, number] = [0, 0];
  private marks: Mark[] = [];
  private active: Mark | null = null;
  private drawing = false;

  diff = signal<AppDiff | null>(null);
  diffOf = signal<string | null>(null);
  diffNote_ = signal('reading git…');
  shutFiles = signal<Set<string>>(new Set());
  revisions = signal<Revision[]>([]);

  tests = signal<TestRun | null>(null);
  cost = signal<AppCompute | null>(null);
  sys = signal<SystemInfo | null>(null);
  log = signal<LogLine[]>([]);
  serverLines = signal<string[]>([]);

  bottom = signal<'log' | 'server'>(RoomCoding.recall('bottom', 'log') as 'log' | 'server');
  tall = signal(RoomCoding.recall('tall', '') === '1');

  private timers: ReturnType<typeof setInterval>[] = [];
  private ro?: ResizeObserver;

  /** This platform's projects. */
  mine = computed(() => this.all().filter(a => a.platform === this.platform()));

  /** This project's notes, newest first, for the diff's picker. */
  notes = computed(() => this.revisions().filter(
    r => r.kind === this.platform() && r.model === this.here()?._id));

  diffNote = computed(() => this.notes().find(r => r.id === this.diffOf()) ?? null);

  /** Not in the constructor: the platform is an input, and it is not set
   *  until the room is initialised - reading it any earlier throws, and
   *  took the whole shell down with it. */
  ngOnInit() {
    this.refresh();
    this.tick();
    this.timers.push(setInterval(() => this.tick(), 3000));
    this.timers.push(setInterval(() => this.slowTick(), 8000));
    // The phone's screen, again every second and a half while it is the
    // live view: a picture that moves once in eight seconds reads as stuck.
    this.timers.push(setInterval(() => {
      if (this.platform() === 'mobile' && this.phoneUp() && !this.frozen()) {
        this.phoneNonce.update(n => n + 1);
      }
    }, 1500));
  }

  constructor() {
    // Opened from the catalog: the tree is shared, so the room follows
    // what was clicked rather than keeping a list beside it.
    effect(() => {
      const want = this.picked.app();
      if (!want || this.here()?._id === want) return;
      const found = this.all().find(a => a._id === want && a.platform === this.platform());
      if (found) this.open(found);
      else if (this.all().length) this.refresh();
    });
    // The note is filed: let go of the page, as the 3D room lets go of
    // its view once a revision is saved.
    // On the count moving, not on it being non-zero: read as a flag, the
    // first note filed let go of every page frozen after it.
    let filed = this.picked.codeFiled();
    effect(() => {
      const now = this.picked.codeFiled();
      if (now === filed) return;
      filed = now;
      if (untracked(this.frozen)) this.resume();
    });
    // The box the page is scaled into. Measured, not assumed: the panes
    // move when the log is made tall and when a column folds.
    effect(() => {
      const el = this.box()?.nativeElement;
      this.ro?.disconnect();
      if (!el) return;
      this.ro = new ResizeObserver(() => {
        this.room.set({ w: el.clientWidth, h: el.clientHeight });
        setTimeout(() => this.sizeOverlay());
      });
      this.ro.observe(el);
    });
  }

  ngOnDestroy() {
    for (const t of this.timers) clearInterval(t);
    this.ro?.disconnect();
    // A frozen page belongs to this room; the form must not file it from
    // another one.
    this.picked.codeDraft.set(null);
    this.picked.codeParts.set([]);
  }

  ext(): string {
    return { web: '.web', embedded: '.fw', mobile: '.mobile' }[this.platform()];
  }

  /** Whether there is anything to frame. Firmware has no page. */
  /** Whether there is anything to show. A page needs an address,
   *  firmware a build; the phone is always there to be looked at. */
  canLook(): boolean {
    const a = this.here();
    if (!a) return false;
    if (this.platform() === 'embedded') return !!a.firmware;
    if (this.platform() === 'mobile') return true;
    return !!a.url;
  }

  /** Whether what is shown is current: the dev server answers, the
   *  firmware built, the phone is up. */
  live(): boolean {
    if (this.platform() === 'embedded') return !!this.here()?.firmware?.ok;
    if (this.platform() === 'mobile') return this.phoneUp();
    return !!this.status()?.up;
  }

  liveNote(): string {
    const a = this.here();
    if (this.platform() === 'embedded') {
      return a?.firmware ? (a.firmware.ok ? 'the last build succeeded' : 'the last build failed')
                         : 'not built yet';
    }
    if (this.platform() === 'mobile') return this.phoneUp() ? 'the phone is up' : 'the phone is off';
    return this.status()?.up ? `${a?.url} answers` : `nothing answers at ${a?.url}`;
  }

  /** The regions the firmware actually uses, for the head. */
  usedRegions(): { name: string; pct: number }[] {
    return (this.here()?.firmware?.summary?.regions ?? []).filter(r => r.used > 0);
  }

  /** The size the live view is drawn at before it is scaled into the
   *  pane: the chosen viewport for a page, the firmware page's fixed size,
   *  the phone's own screen. */
  liveSize(): { w: number; h: number } {
    if (this.platform() === 'embedded') return { w: 1280, h: 800 };
    if (this.platform() === 'mobile') return this.phoneSize();
    return { w: this.viewport().w, h: this.viewport().h };
  }

  // ---- the phone ----
  phoneUp = signal(false);
  phoneSize = signal({ w: 1080, h: 2400 });
  private phoneNonce = signal(0);

  screenUrl(): string { return `/api/apps/phone/screen.png?t=${this.phoneNonce()}`; }

  phoneSized(ev: Event) {
    const img = ev.target as HTMLImageElement;
    const s = this.phoneSize();
    if (img.naturalWidth && (img.naturalWidth !== s.w || img.naturalHeight !== s.h)) {
      this.phoneSize.set({ w: img.naturalWidth, h: img.naturalHeight });
    }
  }

  // ---- which project ----

  refresh() {
    this.apps.list().subscribe({
      next: rows => {
        this.all.set(rows);
        const want = this.picked.app() ?? RoomCoding.recall('app.' + this.platform(), '');
        const mine = rows.filter(a => a.platform === this.platform());
        const found = mine.find(a => a._id === want) ?? mine[0] ?? null;
        if (found && found._id !== this.here()?._id) this.open(found);
      },
      error: () => this.note.set('could not read the projects'),
    });
  }

  open(a: AppEntry) {
    if (this.frozen()) this.resume();
    this.here.set(a);
    if (this.picked.app() !== a._id) this.picked.app.set(a._id);
    RoomCoding.keep('app.' + this.platform(), a._id);
    this.route.set(RoomCoding.recall('route.' + a._id, a.routes[0] ?? '/'));
    const vp = RoomCoding.recall('viewport.' + a._id,
                                 this.platform() === 'mobile' ? 'phone' : 'desktop');
    this.viewport.set(VIEWPORTS.find(v => v.key === vp) ?? VIEWPORTS[0]);
    this.diffOf.set(null);
    this.diff.set(null);
    this.tests.set(null);
    this.status.set(null);
    this.slowTick();
    this.loadDiff();
    this.apps.lastTest(a._id).subscribe({ next: t => this.tests.set(t) });
  }

  // ---- the frame ----

  setRoute(r: string) {
    const clean = (r || '/').trim();
    this.route.set(clean.startsWith('/') ? clean : '/' + clean);
    const a = this.here();
    if (a) RoomCoding.keep('route.' + a._id, this.route());
  }

  setViewport(key: string) {
    this.viewport.set(VIEWPORTS.find(v => v.key === key) ?? VIEWPORTS[0]);
    const a = this.here();
    if (a) RoomCoding.keep('viewport.' + a._id, key);
  }

  reload() { this.nonce.update(n => n + 1); }

  /** The page's address. The nonce rides in the fragment, which reloads
   *  the frame without the server or the app's router seeing it. */
  frameUrl = computed(() => {
    const a = this.here();
    // Firmware's page is drawn by this server from the last build.
    if (a && this.platform() === 'embedded') {
      return this.trust(`/api/apps/${a._id}/firmware.html?v=`
                        + encodeURIComponent(a.firmware?.at ?? ''));
    }
    if (!a?.url) return null;
    const url = a.url.replace(/\/$/, '') + this.route() + '#r' + this.nonce();
    return this.trust(url);
  });

  private sanitizer = inject(DomSanitizer);

  private trust(url: string): SafeResourceUrl {
    // A project's own address, written by whoever registered it. It is
    // shown in a frame - which is the whole point of the room - and
    // nothing from it is ever run in this page.
    return this.sanitizer.bypassSecurityTrustResourceUrl(url);
  }

  /** Where the page sits in the box and how far it is scaled. Never up:
   *  a phone page blown up to the pane's width is not what a phone shows. */
  fit = computed(() => {
    const { w: bw, h: bh } = this.room();
    const s = this.shot();
    const live = this.liveSize();
    const vw = this.frozen() && s ? s.width : live.w;
    const vh = this.frozen() && s ? s.height : live.h;
    const pad = 10;
    const k = Math.max(0.05, Math.min((bw - 2 * pad) / vw, (bh - 2 * pad) / vh, 1));
    const w = Math.round(vw * k), h = Math.round(vh * k);
    return { k, w, h, x: Math.round((bw - w) / 2), y: Math.round((bh - h) / 2) };
  });

  // ---- freeze, draw ----

  freeze() {
    const a = this.here();
    if (!a || this.shooting()) return;
    this.shooting.set(true);
    this.note.set('');
    const vp = this.liveSize();
    this.apps.shot(a._id, this.route(), vp.w, vp.h).subscribe({
      next: s => {
        this.shooting.set(false);
        this.shot.set(s);
        this.marks = [];
        this.dom.set([]);
        this.labels.set([]);
        this.picked.codeParts.set([]);
        this.frozen.set(true);
        this.picked.codeDraft.set(() => this.draft());
        setTimeout(() => this.sizeOverlay());
      },
      error: e => { this.shooting.set(false); this.note.set(this.why(e)); },
    });
  }

  resume() {
    this.frozen.set(false);
    this.shot.set(null);
    this.typing.set(null);
    this.marks = [];
    this.active = null;
    this.dom.set([]);
    this.labels.set([]);
    this.picked.codeParts.set([]);
    this.picked.codeDraft.set(null);
  }

  /** The canvas matches the picture's box on screen, at the screen's own
   *  density, the way the 3D room's overlay matches its viewer. */
  private sizeOverlay() {
    const c = this.overlay()?.nativeElement;
    if (!c) return;
    const f = this.fit();
    const ratio = Math.min(devicePixelRatio, 2);
    const w = Math.round(f.w * ratio), h = Math.round(f.h * ratio);
    if (c.width === w && c.height === h) return;
    // Marks are kept in the canvas's pixels; a resize rescales them so a
    // mark stays on what it was drawn over.
    if (c.width && c.height && this.marks.length) {
      const sx = w / c.width, sy = h / c.height;
      for (const m of this.marks) {
        if (m.kind === 'pen') m.pts = m.pts.map(p => [p[0] * sx, p[1] * sy]);
        else if (m.kind === 'text') m.at = [m.at[0] * sx, m.at[1] * sy];
        else { m.a = [m.a[0] * sx, m.a[1] * sy]; m.b = [m.b[0] * sx, m.b[1] * sy]; }
      }
    }
    c.width = w;
    c.height = h;
    this.repaint();
  }

  private pos(ev: PointerEvent): [number, number] {
    const c = this.overlay()!.nativeElement;
    const r = c.getBoundingClientRect();
    return [(ev.clientX - r.left) * c.width / r.width,
            (ev.clientY - r.top) * c.height / r.height];
  }

  down(ev: PointerEvent) {
    if (!this.frozen()) return;
    const at = this.pos(ev);
    const t = this.tool();
    if (t === 'text') {
      const c = this.overlay()!.nativeElement.getBoundingClientRect();
      this.typeAt = at;
      this.typing.set({ left: ev.clientX - c.left, top: ev.clientY - c.top });
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
    if (!this.drawing) return;
    if (this.active && this.active.kind !== 'pen' && this.active.kind !== 'text') {
      const [ax, ay] = this.active.a, [bx, by] = this.active.b;
      if (Math.hypot(bx - ax, by - ay) < 3) this.marks.pop();
    }
    this.drawing = false;
    this.active = null;
    this.repaint();
    this.lookUnder();
  }

  commitText(value: string) {
    if (!this.typing()) return;
    const text = value.trim();
    this.typing.set(null);
    if (!text) return;
    const scale = Math.min(devicePixelRatio, 2);
    this.marks.push({ kind: 'text', color: this.color(),
                      size: this.fontSize() * scale, at: this.typeAt, text });
    this.repaint();
    this.lookUnder();
  }

  undo() { this.marks.pop(); this.repaint(); this.lookUnder(); }
  clear() { this.marks = []; this.repaint(); this.lookUnder(); }

  private repaint() {
    const c = this.overlay()?.nativeElement;
    const ctx = c?.getContext('2d');
    if (ctx) paint(ctx, this.marks, Math.min(devicePixelRatio, 2));
  }

  /** Lay the marks on the page's elements. In the picture's own pixels:
   *  the canvas is the picture scaled to the screen. */
  private lookUnder() {
    const s = this.shot();
    const c = this.overlay()?.nativeElement;
    if (!s || !c || !c.width) return;
    if (!this.marks.length) {
      this.dom.set([]);
      this.labels.set([]);
      this.picked.codeParts.set([]);
      return;
    }
    const k = s.width / c.width;
    const marks = this.marks.map(m => {
      const e = extent(m);
      return { box: e.box.map(v => Math.round(v * k)),
               tip: e.tip ? e.tip.map(v => Math.round(v * k)) : null };
    });
    this.apps.under(s.shot, marks).subscribe({
      next: r => {
        this.dom.set(r.dom);
        this.labels.set(r.labels);
        this.picked.codeParts.set(r.labels);
      },
      error: e => this.note.set(this.why(e)),
    });
  }

  /** The note as the form files it: the picture with the marks on it, at
   *  the picture's own size, and where it was drawn. */
  private async draft(): Promise<CodeDraft> {
    const s = this.shot();
    const image = s ? await this.merge(s.image) : null;
    return {
      image_png: image,
      code: {
        route: this.route(),
        viewport: [s?.width ?? this.viewport().w, s?.height ?? this.viewport().h],
        base: s?.base ?? null,
        shot: s?.shot ?? null,
        dom: this.dom(),
      },
    };
  }

  private merge(shotUrl: string): Promise<string> {
    return new Promise(resolve => {
      const overlay = this.overlay()!.nativeElement;
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

  // ---- the diff ----

  pickDiff(id: string) {
    this.diffOf.set(id || null);
    this.loadDiff();
  }

  loadDiff() {
    const a = this.here();
    if (!a) return;
    const want = this.diffOf();
    this.apps.diff(a._id, want).subscribe({
      next: d => { if (this.diffOf() === want) this.diff.set(d); },
      error: e => { this.diff.set(null); this.diffNote_.set(this.why(e)); },
    });
  }

  foldFile(path: string) {
    const next = new Set(this.shutFiles());
    next.has(path) ? next.delete(path) : next.add(path);
    this.shutFiles.set(next);
  }

  noteLine(r: Revision): string {
    const text = (r.summary || r.comment).split('\n')[0];
    return `${r.status} · ${text.length > 48 ? text.slice(0, 48) + '…' : text}`;
  }

  // ---- the check ----

  countLine(t: TestRun): string {
    const c = Object.entries(t.counts ?? {});
    return c.length ? c.map(([k, v]) => `${v} ${k}`).join(', ') : `exit ${t.rc}`;
  }

  // ---- the live half ----

  private tick() {
    this.health.system().subscribe({ next: s => this.sys.set(s) });
    this.activity.lines(60, this.platform()).subscribe({
      next: rows => {
        const last = this.log()[this.log().length - 1]?._id;
        this.log.set(rows);
        if (rows[rows.length - 1]?._id !== last) setTimeout(() => this.scrollLog(), 30);
      },
    });
    const a = this.here();
    if (a && this.bottom() === 'server') {
      if (this.platform() === 'embedded') {
        this.apps.buildLog(a._id).subscribe({ next: r => this.serverLines.set(r.lines) });
      } else {
        this.apps.serverLog(a._id).subscribe({ next: r => this.serverLines.set(r.lines) });
      }
    }
  }

  /** What changes on the scale of an edit rather than a second: whether
   *  the server answers, the checkout, the notes, the diff. */
  private slowTick() {
    const a = this.here();
    if (!a) return;
    this.apps.status(a._id).subscribe({ next: s => this.status.set(s) });
    if (this.platform() === 'mobile') {
      this.apps.phoneState().subscribe({ next: st => this.phoneUp.set(st.booted) });
    }
    // A build the agent made since: the head and the page follow it.
    this.apps.one(a._id).subscribe({ next: fresh => {
      if (fresh.firmware?.at !== a.firmware?.at) this.here.set(fresh);
    } });
    // Archived ones as well: auto-archive files a note away the moment it
    // is done, which is exactly when its before and after are worth seeing.
    forkJoin([this.api.list(false), this.api.list(true)]).subscribe({
      next: ([open, filed]) => this.revisions.set([...open, ...filed]),
    });
    this.loadCost();
    if (!this.diffOf() || !this.diff()?.frozen) this.loadDiff();
  }

  private loadCost() {
    const a = this.here();
    if (a) this.apps.compute(a._id).subscribe({ next: c => this.cost.set(c) });
  }

  private scrollLog() {
    const box = this.logBox()?.nativeElement;
    if (box) box.scrollTop = box.scrollHeight;
  }

  gauges(): { key: string; pct: number; read: string; tip: string }[] {
    const m = this.sys();
    if (!m) return [];
    const out = [
      { key: 'cpu', pct: m.cpu.load,
        read: `${m.cpu.load.toFixed(0)}% · ${m.cpu.cores}c/${m.cpu.threads}t`,
        tip: m.cpu.name },
      { key: 'ram', pct: 100 * m.ram.used_bytes / (m.ram.total_bytes || 1),
        read: `${this.gb(m.ram.used_bytes)} / ${this.gb(m.ram.total_bytes)}`,
        tip: 'memory in use' },
    ];
    if (m.gpu) {
      out.push({ key: 'gpu', pct: m.gpu.util,
                 read: `${m.gpu.util.toFixed(0)}% · ${m.gpu.temp_c.toFixed(0)}°`,
                 tip: m.gpu.name });
    }
    return out;
  }

  gb(bytes: number): string { return (bytes / 1e9).toFixed(1) + ' GB'; }

  secs(s?: number): string {
    if (!s) return '–';
    return s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${s.toFixed(1)} s`;
  }

  cores(s?: number): string { return s ? `${s.toFixed(1)} core-s` : '–'; }

  levelColor(l: LogLine['level']): string {
    return l === 'error' ? 'var(--danger)'
      : l === 'warn' ? 'var(--warn)'
      : l === 'done' ? 'var(--ok)'
      : l === 'work' ? 'var(--accent)' : 'var(--ink-dim)';
  }

  private why(e: { error?: { detail?: unknown }; message?: string }): string {
    return String(e?.error?.detail ?? e?.message ?? e).slice(0, 300);
  }

  // ---- what survives F5 ----

  private static KEY = 'x3.code.';

  private static recall(key: string, fallback: string): string {
    try { return localStorage.getItem(RoomCoding.KEY + key) ?? fallback; }
    catch { return fallback; }
  }

  private static keep(key: string, value: string) {
    try { localStorage.setItem(RoomCoding.KEY + key, value); } catch { /* private window */ }
  }

  setBottom(which: 'log' | 'server') {
    this.bottom.set(which);
    RoomCoding.keep('bottom', which);
    this.tick();
    setTimeout(() => this.scrollLog(), 30);
  }

  toggleTall() {
    this.tall.update(v => !v);
    RoomCoding.keep('tall', this.tall() ? '1' : '');
  }
}
