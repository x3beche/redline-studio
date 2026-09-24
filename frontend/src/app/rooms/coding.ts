import {
  Component, ElementRef, OnDestroy, OnInit, computed, effect, inject, input,
  signal, untracked, viewChild,
} from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { forkJoin } from 'rxjs';
import {
  Activity, AppCompute, AppDiff, AppEntry, AppShot, AppStatus, Api, Apps,
  DomHit, Health, LogLine, Revision, SystemInfo, TestRun,
} from '../api';
import { CodeDraft, Selection } from '../selection';
import { RoomFrame, ToolButton } from './frame';
import { Mark, extent, paint } from './sketch';
import { DrawTools, PenState } from './sketchpad';

type Platform = 'web' | 'embedded' | 'mobile';
type View = 'live' | 'diff';
type Side = 'check' | 'server' | 'boards' | 'machine';

/** The sizes a page is looked at. A note is drawn at one of them and the
 *  after shot is taken at the same one. */
const VIEWPORTS: { key: string; w: number; h: number; icon: string; tip: string }[] = [
  { key: 'desktop', w: 1280, h: 800, icon: 'tcv-ico-desktop', tip: 'Desktop - 1280 × 800' },
  { key: 'tablet', w: 820, h: 1180, icon: 'tcv-ico-tablet', tip: 'Tablet - 820 × 1180' },
  { key: 'phone', w: 390, h: 844, icon: 'tcv-ico-phone', tip: 'Phone - 390 × 844' },
];

/** A symbol from the firmware, as the view lists it. */
interface FwSymbol {
  name: string; size: number; where: 'flash' | 'ram' | 'both';
  file: string | null; line: number | null;
}
interface FwData {
  regions: { name: string; used: number; size: number; pct: number }[];
  symbols: FwSymbol[];
  before?: { regions?: { name: string; used: number }[] } | null;
  at?: string;
}

/** The programming rooms: Web, Embedded and Mobile Programming.
 *
 *  Redlining what a program shows. Somebody already does this by hand -
 *  screenshots the page, draws on it, says "this gap", "centre that". Here
 *  the screenshot is taken for them by a real browser or a real phone, the
 *  marks are laid on the elements under them so the note says which
 *  button in which file, and the change comes back as a diff with the
 *  tests as the check and the same screen afterwards as the "after".
 *
 *  Firmware has no screen to draw on. Its view is what the build made of
 *  the source - memory per region, the largest functions and tables with
 *  their files - and a note is written about one of them, picked here
 *  the way the board room offers its components.
 *
 *  On the frame every room shares: the toolbar across the top with the
 *  pen at its end, tabs down the left, the view, the log band under it.
 *  Nothing here builds, serves or tests: the agent does, in the tab's own
 *  container, and the room shows what came of it.
 */
@Component({
  selector: 'app-room-coding',
  imports: [RoomFrame, ToolButton, DrawTools],
  template: `
<div class="tcv-room absolute inset-0 flex min-h-0 flex-col p-1">

  @if (!here()) {
    <p class="p-3 text-[12px]" style="color: var(--ink-dim)">
      Pick a project in the catalog - a <b>{{ ext() }}</b> opens here.
    </p>
  } @else {

  <app-room-frame [room]="platform()" [tabs]="sideTabs()" [tab]="side()" [labels]="tabNames"
                  (tabChange)="setSide($any($event))" [log]="log()">

    <!-- THE TOOLBAR
         What is looked at - the live thing or the change - and, for a
         page, at which size. Nothing here makes or runs anything. -->
    <ng-container ngProjectAs="[bar]">
      <app-tool [icon]="liveIcon()" [tip]="liveTip()"
                [on]="view() === 'live'" (press)="setView('live')" />
      <app-tool icon="tcv-ico-diff" tip="Diff - the change, and a note's before and after"
                [on]="view() === 'diff'" [disabled]="frozen()" (press)="setView('diff')" />
      @if (platform() === 'web') {
        <span class="tcv_separator"></span>
        @for (v of viewports; track v.key) {
          <app-tool [icon]="v.icon" [tip]="v.tip" [on]="viewport().key === v.key"
                    [disabled]="frozen() || view() !== 'live'" (press)="setViewport(v.key)" />
        }
      }
      @if (platform() !== 'embedded') {
        <span class="tcv_separator"></span>
        <app-tool icon="tcv-ico-reload" tip="Load it again" [disabled]="frozen() || view() !== 'live'"
                  (press)="reload()" />
        @if (platform() === 'web' && here()!.url) {
          <app-tool icon="tcv-ico-open" tip="Open the page in a tab of its own"
                    [href]="pageHref()" />
        }
        <!-- The route: the page's own address after the server's. -->
        @if (here()!.url) {
          <input [value]="route()" (change)="setRoute($any($event.target).value)"
                 (keydown.enter)="setRoute($any($event.target).value)"
                 [disabled]="frozen()" [attr.list]="'routes-' + platform()"
                 class="tcv-field mono mx-1 w-40 px-1.5 py-0.5 text-[11px]"
                 [title]="'the route, after ' + here()!.url">
          <datalist [id]="'routes-' + platform()">
            @for (r of here()!.routes; track r) { <option [value]="r"></option> }
          </datalist>
        }
      } @else {
        <span class="tcv_separator"></span>
        <app-tool icon="tcv-ico-elf" tip="The last build's .elf"
                  [href]="elfHref()" [disabled]="!here()!.firmware?.ok" />
      }
      <span class="tcv_separator"></span>
      <!-- What is true now, said once, where the eye already is. -->
      <span class="tcv-frame-status mono" [title]="liveNote()">
        <span class="mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle"
              [style.background]="live() ? 'var(--ok)' : 'var(--danger)'"></span>
        @if (frozen()) {
          {{ shot()?.width }} × {{ shot()?.height }} · {{ shot()?.elements }} elements
        } @else if (platform() === 'embedded') {
          {{ targetName() }}
          @if (here()!.firmware; as fw) {
            · {{ fw.ok ? 'built' : 'build failed' }} {{ fw.at.slice(11, 16) }}
            @for (r of usedRegions(); track r.name) { · {{ r.name }} {{ r.pct.toFixed(1) }}% }
          } @else { · not built yet }
        } @else {
          {{ liveNote() }}
        }
        @if (note(); as n) { <span style="color: var(--warn)"> · {{ n }}</span> }
      </span>
    </ng-container>

    <!-- The pen, at the toolbar's end as in every room. Firmware has no
         screen to draw on, so its notes are written about what is picked. -->
    <ng-container ngProjectAs="[barEnd]">
      @if (platform() !== 'embedded') {
        @if (frozen()) {
          <app-draw-tools [pen]="pen" (undo)="undo()" (clear)="clear()" />
        }
        <span class="tcv_tooltip"
              [attr.data-tooltip]="frozen() ? 'Let it go' : 'Photograph it and draw on it'">
          <span class="tcv_button_frame">
            <button class="tcv_reset tcv_btn tcv-freeze" [attr.data-on]="frozen() ? 1 : null"
                    [disabled]="shooting() || !canFreeze()"
                    (click)="frozen() ? resume() : freeze()"></button>
          </span>
        </span>
      }
    </ng-container>

    <!-- THE TABS -->
    <div side class="flex h-full min-h-0 flex-col text-[11px]">
      @switch (side()) {
        @case ('check') {
          <!-- A note is not done until this passes. A pass counts for the
               tree it ran on: change a file and it says so. -->
          <div class="flex shrink-0 items-center gap-2 px-2 py-1.5"
               style="border-bottom: 1px solid var(--line)">
            @if (tests(); as t) {
              <span class="mono rounded px-1.5 text-[10px] font-bold uppercase"
                    [style.background]="t.ok ? 'var(--ok)' : 'var(--danger)'"
                    style="color: var(--ink-bright)">{{ t.ok ? 'pass' : 'fail' }}</span>
              <span class="mono min-w-0 truncate" style="color: var(--ink-dim)">
                {{ countLine(t) }} · {{ secs(t.wall_s) }}
              </span>
            } @else {
              <span style="color: var(--ink-dim)">not run yet</span>
            }
          </div>
          <div class="tcv-scroll mono min-h-0 flex-1 overflow-auto px-2 py-1">
            @if (tests(); as t) {
              <div class="mb-1" style="color: var(--ink-dim)">
                $ {{ t.command }} · {{ t.at.slice(11, 19) }} · exit {{ t.rc }}
                @if (t.current === false) { · <span style="color: var(--warn)">tree changed since</span> }
              </div>
              <pre class="whitespace-pre-wrap break-all leading-snug" style="color: var(--ink)">{{ t.tail }}</pre>
            } @else {
              <p class="leading-relaxed" style="color: var(--ink-dim)">
                {{ here()!.test
                   ? 'The agent runs ' + here()!.test + ' in the ' + roomName() + ' container when it works a note.'
                   : 'This project has no test command.' }}
              </p>
            }
          </div>
        }
        @case ('server') {
          <!-- What the machine said: the dev server's output for a page or
               a phone app, the build's for firmware. -->
          <div class="tcv-scroll mono min-h-0 flex-1 overflow-y-auto px-2 py-1">
            @for (l of serverLines(); track $index) {
              <div class="whitespace-pre-wrap break-all leading-snug" style="color: var(--ink-dim)">{{ l }}</div>
            } @empty {
              <p class="leading-relaxed" style="color: var(--ink-dim)">
                {{ platform() === 'embedded'
                   ? 'No build yet. The agent builds in the Embedded Programming container, and what it prints lands here.'
                   : 'Nothing from the dev server yet. The agent starts it in the ' + roomName() + ' container.' }}
              </p>
            }
          </div>
        }
        @case ('boards') {
          <!-- What is plugged in that firmware could go to: an ST-Link for
               the STM32, a serial port for the ESP32. The agent programs it. -->
          <div class="tcv-scroll min-h-0 flex-1 overflow-y-auto p-2">
            @for (b of boards(); track b.name + (b.port ?? b.usb)) {
              <div class="mb-1.5 rounded px-2 py-1.5" style="background: var(--surface-2)">
                <div class="flex items-center gap-2">
                  <span class="mono rounded px-1 text-[10px] uppercase"
                        style="background: var(--accent-deep); color: var(--ink)">{{ b.kind }}</span>
                  <span class="min-w-0 truncate" style="color: var(--ink)" [title]="b.name">{{ b.name }}</span>
                </div>
                <div class="mono mt-0.5 text-[10px]" style="color: var(--ink-dim)">{{ b.port ?? b.usb }}</div>
              </div>
            } @empty {
              <p class="leading-relaxed" style="color: var(--ink-dim)">
                Nothing plugged in. An STM32 is programmed through an ST-Link on
                its SWD header, an ESP32 over its USB serial port - plug either in
                and it shows here.
              </p>
            }
            @if (here()!.flashed; as f) {
              <p class="mono mt-2 pt-2" style="border-top: 1px solid var(--line); color: var(--ink-dim)">
                last programmed {{ f.at.slice(0, 16).replace('T', ' ') }} ·
                <span [style.color]="f.ok ? 'var(--ok)' : 'var(--danger)'">{{ f.ok ? 'verified' : 'failed' }}</span>
              </p>
            }
          </div>
        }
        @default {
          <!-- What the shots, builds and test runs cost the machine. -->
          <div class="tcv-scroll min-h-0 flex-1 overflow-auto p-2">
            @if (cost()?.jobs?.length) {
              <div class="mono">
                @for (j of cost()!.jobs.slice(0, 8); track j.at) {
                  <div class="flex gap-2 leading-relaxed">
                    <span class="w-10 shrink-0" [style.color]="j.rc ? 'var(--danger)' : 'var(--ink)'">{{ j.kind }}</span>
                    <span class="shrink-0" style="color: var(--ink-dim)">{{ secs(j.wall_s) }}</span>
                    <span class="ml-auto shrink-0" style="color: var(--ink-dim)">{{ cores(j.cpu_s) }}</span>
                  </div>
                }
              </div>
            } @else {
              <div style="color: var(--ink-dim)">nothing run yet</div>
            }
            @if (status()?.git; as g) {
              <div class="mono mt-2 pt-2" style="border-top: 1px solid var(--line); color: var(--ink-dim)">
                <div class="flex justify-between leading-relaxed"><span>{{ g.branch }}</span><span>{{ g.short }}</span></div>
                <div class="flex justify-between leading-relaxed"><span>uncommitted</span><span>{{ g.dirty }} files</span></div>
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
        }
      }
    </div>

    <!-- THE VIEW -->
    <div view class="relative h-full w-full overflow-hidden rounded">
      @if (view() === 'diff') {
        <!-- THE CHANGE: the working tree against HEAD, or one note's own
             change - only the files that moved since it was drawn, so
             somebody else's uncommitted work stays out of it. -->
        <div class="flex h-full min-h-0 flex-col" style="background: var(--surface)">
          <div class="flex shrink-0 items-center gap-2 px-2 py-1" style="border-bottom: 1px solid var(--line)">
            <select [value]="diffOf() ?? ''" (change)="pickDiff($any($event.target).value)"
                    class="tcv-field min-w-0 flex-1 px-1 py-0 text-[11px]">
              <option value="">working tree</option>
              @for (r of notes(); track r.id) { <option [value]="r.id">{{ noteLine(r) }}</option> }
            </select>
            @if (diff(); as d) {
              <span class="mono shrink-0 text-[11px]">
                <span style="color: var(--ok)">+{{ d.added }}</span>
                <span style="color: var(--danger)"> −{{ d.removed }}</span>
                <span style="color: var(--ink-dim)"> · {{ d.files.length }} files</span>
              </span>
            }
          </div>
          <div class="tcv-scroll min-h-0 flex-1 overflow-auto">
            @if (diffNote(); as r) {
              @if (r.image_bytes) {
                <div class="grid gap-2 p-2" style="grid-template-columns: 1fr 1fr; border-bottom: 1px solid var(--line)">
                  <a [href]="api.imageUrl(r.id)" target="_blank" class="tcv-shot" title="before, with the marks">
                    <img [src]="api.imageUrl(r.id)" alt="before">
                    <span>before</span>
                  </a>
                  <a [href]="r.image_after_bytes ? api.imageUrl(r.id, 'after') : null" target="_blank"
                     class="tcv-shot" title="after: the same screen again">
                    @if (r.image_after_bytes) { <img [src]="api.imageUrl(r.id, 'after')" alt="after"> }
                    @else { <em>no after shot yet</em> }
                    <span style="color: var(--ok)">after</span>
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
                  @if (f.cut) { <div class="tcv-diff-hunk">… cut here, the rest is too long to show</div> }
                }
              } @empty {
                <p class="p-3 text-[12px]" style="color: var(--ink-dim)">
                  {{ diffOf() ? 'Nothing has changed since this note was drawn.' : 'The working tree matches HEAD.' }}
                </p>
              }
            } @else {
              <p class="p-3 text-[12px]" style="color: var(--ink-dim)">{{ diffWait() }}</p>
            }
          </div>
        </div>
      } @else if (platform() === 'embedded') {
        <!-- THE FIRMWARE, AS BUILT
             Memory per region, then what fills it, file by file. A click
             on a function or a table makes it the note's Part. -->
        <div class="tcv-scroll h-full overflow-auto p-3" style="background: var(--surface)">
          @if (fw(); as d) {
            <div class="mb-3">
              @for (r of d.regions; track r.name) {
                <div class="tcv-fw-region">
                  <span class="mono">{{ r.name }}</span>
                  <span class="tcv-fw-track"><span [style.width.%]="r.pct"></span></span>
                  <span class="mono tcv-fw-num">
                    {{ kb(r.used) }} / {{ kb(r.size) }} · {{ r.pct.toFixed(2) }}%
                    @if (grew(r); as g) {
                      <b [style.color]="g > 0 ? 'var(--warn)' : 'var(--ok)'">{{ g > 0 ? '+' : '−' }}{{ kb(abs(g)) }}</b>
                    }
                  </span>
                </div>
              } @empty {
                <p style="color: var(--ink-dim)">The build printed no memory map (link with -Wl,--print-memory-usage).</p>
              }
            </div>
            <div class="grid gap-4" style="grid-template-columns: 1fr 1fr">
              @for (col of fwColumns(); track col.label) {
                <section>
                  <h3 class="tcv-label mb-1.5">{{ col.label }} · {{ kb(col.total) }}</h3>
                  @for (f of col.files; track f.file) {
                    <div class="tcv-fw-file">
                      <div class="tcv-fw-fname mono">
                        <span class="truncate" [title]="f.file">{{ f.file }}</span><span>{{ kb(f.total) }}</span>
                      </div>
                      <div class="tcv-fw-syms">
                        @for (s of f.syms; track s.name) {
                          <button class="tcv-fw-sym mono" [style.flex-grow]="s.size"
                                  [attr.data-on]="pickedSym() === s.name ? 1 : null"
                                  [title]="s.name + ' · ' + kb(s.size) + (s.file ? ' · ' + s.file + ':' + s.line : '')"
                                  (click)="pickSymbol(s)">{{ s.name }}</button>
                        }
                      </div>
                    </div>
                  }
                </section>
              }
            </div>
          } @else {
            <div class="flex h-full items-center justify-center">
              <p class="max-w-md text-center text-[12px] leading-relaxed" style="color: var(--ink-dim)">
                Not built yet. The agent builds {{ here()!.title }} for the {{ targetName() }} in the
                Embedded Programming container, and what the build makes of the source
                shows here: memory per region, and the largest functions and tables with
                their files. Pick one and write the note about it.
              </p>
            </div>
          }
        </div>
      } @else {
        <!-- THE LIVE THING: a page in a frame at its real size, scaled into
             the view; or the phone's own screen, a picture every second
             and a half. Frozen, the real screenshot with the pens over it. -->
        <div #box class="tcv-preview relative h-full w-full overflow-hidden">
          @if (framed) {
            <p class="p-3 text-[12px]" style="color: var(--ink-dim)">
              This page is already inside a frame, so it does not frame another.
            </p>
          } @else if (!live() && !frozen()) {
            @if (platform() === 'mobile') {
              <div class="tcv-phone absolute" [style.left.px]="fit().x" [style.top.px]="fit().y"
                   [style.width.px]="fit().w" [style.height.px]="fit().h">
                <div class="flex h-full w-full items-center justify-center p-6 text-center">
                  <p class="text-[12px] leading-relaxed" style="color: var(--ink-dim)">
                    The phone is off. The agent starts it in the Mobile Programming
                    container - ask in the thread.
                  </p>
                </div>
              </div>
            } @else {
              <div class="p-3 text-[12px]" style="color: var(--ink-dim)">
                <p class="mb-2">Nothing answers at <span class="mono">{{ here()!.url }}</span>.</p>
                @if (here()!.dev) {
                  <p>The agent starts it with <span class="mono">{{ here()!.dev }}</span>
                     in the Web Programming container - ask in the thread.</p>
                }
              </div>
            }
          } @else {
            <div class="absolute" [style.left.px]="fit().x" [style.top.px]="fit().y"
                 [style.width.px]="fit().w" [style.height.px]="fit().h"
                 [class.tcv-phone]="platform() === 'mobile'">
              @if (!frozen()) {
                @if (platform() === 'mobile') {
                  <img [src]="screenUrl()" alt="the phone's screen" class="block h-full w-full"
                       draggable="false" (load)="phoneSized($event)">
                } @else {
                  <iframe [src]="frameUrl()" title="preview" class="tcv-preview-frame"
                          [style.width.px]="liveSize().w" [style.height.px]="liveSize().h"
                          [style.transform]="'scale(' + fit().k + ')'"></iframe>
                }
              } @else if (shot(); as s) {
                <img [src]="s.image" alt="frozen" class="block h-full w-full" draggable="false">
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
                       [style.color]="pen.color()" [style.font-size.px]="pen.fontSize()"
                       style="background: var(--draw-label); border: 1px dashed currentColor;
                              min-width: 120px; transform: translateY(-2px)"
                       placeholder="label…"
                       (keydown.enter)="commitText($any($event.target).value)"
                       (keydown.escape)="typing.set(null)"
                       (blur)="commitText($any($event.target).value)">
              }
            </div>
          }
          @if (shooting()) {
            <div class="absolute bottom-3 left-1/2 -translate-x-1/2 rounded px-3 py-1.5 text-[12px]"
                 style="background: var(--shade); color: var(--ink)">photographing {{ route() }}…</div>
          }
          <!-- What the marks are about, in the words the note will use. -->
          @if (frozen()) {
            <div class="absolute inset-x-2 bottom-2 flex flex-wrap gap-1">
              @for (l of labels(); track l) {
                <span class="tcv-chip mono px-1.5 py-0 text-[10px]"
                      style="background: var(--overlay); color: var(--ink)">{{ l }}</span>
              }
            </div>
          }
        </div>
      }
    </div>
  </app-room-frame>
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
  private sanitizer = inject(DomSanitizer);
  private box = viewChild<ElementRef<HTMLDivElement>>('box');
  private overlay = viewChild<ElementRef<HTMLCanvasElement>>('overlay');
  private caret = viewChild<ElementRef<HTMLInputElement>>('caret');

  readonly viewports = VIEWPORTS;
  /** Whether this page is itself the one being previewed. */
  readonly framed = window !== window.top;
  readonly pen = new PenState();
  readonly tabNames = { check: 'Check', server: 'Server', boards: 'Boards', machine: 'Machine' };

  all = signal<AppEntry[]>([]);
  here = signal<AppEntry | null>(null);
  status = signal<AppStatus | null>(null);
  note = signal('');

  view = signal<View>('live');
  side = signal<Side>('check');
  route = signal('/');
  viewport = signal(VIEWPORTS[0]);
  /** Bumped to load the frame again: the same URL twice is not a reload. */
  private nonce = signal(0);
  /** The view's box, measured, so the page can be scaled into it. */
  private room = signal({ w: 0, h: 0 });

  frozen = signal(false);
  shooting = signal(false);
  shot = signal<AppShot | null>(null);
  dom = signal<DomHit[]>([]);
  labels = signal<string[]>([]);
  typing = signal<{ left: number; top: number } | null>(null);
  private typeAt: [number, number] = [0, 0];
  private marks: Mark[] = [];
  private active: Mark | null = null;
  private drawing = false;

  diff = signal<AppDiff | null>(null);
  diffOf = signal<string | null>(null);
  diffWait = signal('reading git…');
  shutFiles = signal<Set<string>>(new Set());
  revisions = signal<Revision[]>([]);

  tests = signal<TestRun | null>(null);
  cost = signal<AppCompute | null>(null);
  sys = signal<SystemInfo | null>(null);
  log = signal<LogLine[]>([]);
  serverLines = signal<string[]>([]);

  fw = signal<FwData | null>(null);
  boards = signal<{ kind: string; name: string; port?: string; usb?: string }[]>([]);
  pickedSym = signal<string | null>(null);

  phoneUp = signal(false);
  phoneSize = signal({ w: 1080, h: 2400 });
  private phoneNonce = signal(0);

  private timers: ReturnType<typeof setInterval>[] = [];
  private ro?: ResizeObserver;

  /** This project's notes, for the diff's picker. */
  notes = computed(() => this.revisions().filter(
    r => r.kind === this.platform() && r.model === this.here()?._id));
  diffNote = computed(() => this.notes().find(r => r.id === this.diffOf()) ?? null);

  /** The tabs down the left: the check, what the machine printed, the
   *  boards for firmware, and what it all cost. */
  sideTabs = computed<readonly Side[]>(() => this.platform() === 'embedded'
    ? ['check', 'server', 'boards', 'machine'] : ['check', 'server', 'machine']);

  /** Not in the constructor: the platform is an input, and reading it
   *  before the room is initialised throws and takes the shell with it. */
  ngOnInit() {
    const p = this.platform();
    this.tabNames.server = p === 'embedded' ? 'Build' : 'Server';
    this.view.set(RoomCoding.recall(p, 'view', 'live') === 'diff' ? 'diff' : 'live');
    const side = RoomCoding.recall(p, 'side', 'check') as Side;
    this.side.set(this.sideTabs().includes(side) ? side : 'check');
    this.refresh();
    this.tick();
    this.timers.push(setInterval(() => this.tick(), 3000));
    this.timers.push(setInterval(() => this.slowTick(), 8000));
    // The phone's screen, again every second and a half while it is the
    // live view: a picture that moves once in eight seconds reads as stuck.
    this.timers.push(setInterval(() => {
      if (this.platform() === 'mobile' && this.phoneUp() && !this.frozen()
          && this.view() === 'live') {
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
      if (found) untracked(() => this.open(found));
      else if (this.all().length) untracked(() => this.refresh());
    });
    // The note is filed: let go of the picture, as the 3D room lets go of
    // its view. On the count moving, not on it being non-zero.
    let filed = this.picked.codeFiled();
    effect(() => {
      const now = this.picked.codeFiled();
      if (now === filed) return;
      filed = now;
      if (untracked(this.frozen)) untracked(() => this.resume());
    });
    // The box the page is scaled into, measured: it moves when the log
    // band folds and when a column does.
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
    // A frozen picture belongs to this room; the form must not file it
    // from another one.
    this.picked.codeDraft.set(null);
    this.picked.codeParts.set([]);
  }

  // ---- names ----

  ext(): string {
    return { web: '.web', embedded: '.fw', mobile: '.mobile' }[this.platform()];
  }

  roomName(): string {
    return { web: 'Web Programming', embedded: 'Embedded Programming',
             mobile: 'Mobile Programming' }[this.platform()];
  }

  liveIcon(): string {
    return { web: 'tcv-ico-page', embedded: 'tcv-ico-chip', mobile: 'tcv-ico-phone' }[this.platform()];
  }

  liveTip(): string {
    return { web: 'The page, running', embedded: 'The firmware, as built',
             mobile: 'The phone' }[this.platform()];
  }

  targetName(): string {
    return this.here()?.target === 'esp32' ? 'ESP32' : 'STM32';
  }

  // ---- what is live ----

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
    if (this.platform() === 'mobile') {
      const s = this.phoneSize();
      return this.phoneUp() ? `phone up · ${s.w} × ${s.h}` : 'the phone is off';
    }
    return this.status()?.up ? `${a?.url} answers` : `nothing answers at ${a?.url}`;
  }

  canFreeze(): boolean {
    return this.view() === 'live' && this.live() && !this.framed;
  }

  usedRegions(): { name: string; pct: number }[] {
    return (this.here()?.firmware?.summary?.regions ?? []).filter(r => r.used > 0);
  }

  /** The size the live view is drawn at before it is scaled: the chosen
   *  viewport for a page, the phone's own screen. */
  liveSize(): { w: number; h: number } {
    if (this.platform() === 'mobile') return this.phoneSize();
    return { w: this.viewport().w, h: this.viewport().h };
  }

  /** Which project the phone was last told to show. */
  private phoneFor: string | null = null;

  private showOnPhone() {
    const a = this.here();
    if (!a || this.frozen()) return;
    this.phoneFor = a._id;
    this.apps.phoneOpen(a._id, this.route()).subscribe({ error: e => this.note.set(this.why(e)) });
  }

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
        const want = this.picked.app() ?? RoomCoding.recall(this.platform(), 'app', '');
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
    const p = this.platform();
    RoomCoding.keep(p, 'app', a._id);
    this.route.set(RoomCoding.recall(p, 'route.' + a._id, a.routes[0] ?? '/'));
    const vp = RoomCoding.recall(p, 'viewport.' + a._id, 'desktop');
    this.viewport.set(VIEWPORTS.find(v => v.key === vp) ?? VIEWPORTS[0]);
    this.diffOf.set(null);
    this.diff.set(null);
    this.tests.set(null);
    this.status.set(null);
    this.fw.set(null);
    this.pickedSym.set(null);
    this.slowTick();
    this.loadDiff();
    this.loadFirmware();
    this.apps.lastTest(a._id).subscribe({ next: t => this.tests.set(t) });
  }

  // ---- the toolbar ----

  setView(v: View) {
    this.view.set(v);
    RoomCoding.keep(this.platform(), 'view', v);
    if (v === 'diff') this.loadDiff();
  }

  setSide(s: Side) {
    this.side.set(s);
    RoomCoding.keep(this.platform(), 'side', s);
    this.tick();
  }

  setRoute(r: string) {
    const clean = (r || '/').trim();
    this.route.set(clean.startsWith('/') ? clean : '/' + clean);
    const a = this.here();
    if (a) RoomCoding.keep(this.platform(), 'route.' + a._id, this.route());
  }

  setViewport(key: string) {
    this.viewport.set(VIEWPORTS.find(v => v.key === key) ?? VIEWPORTS[0]);
    const a = this.here();
    if (a) RoomCoding.keep(this.platform(), 'viewport.' + a._id, key);
  }

  reload() {
    this.nonce.update(n => n + 1);
    this.phoneNonce.update(n => n + 1);
    if (this.platform() === 'mobile' && this.phoneUp()) this.showOnPhone();
  }

  pageHref(): string | null {
    const a = this.here();
    return a?.url ? a.url.replace(/\/$/, '') + this.route() : null;
  }

  elfHref(): string | null {
    const a = this.here();
    return a?.firmware?.ok ? `/api/apps/${a._id}/firmware.elf` : null;
  }

  /** The page's address. The nonce rides in the fragment, which reloads
   *  the frame without the server or the app's router seeing it. */
  frameUrl = computed(() => {
    const a = this.here();
    if (!a?.url) return null;
    return this.trust(a.url.replace(/\/$/, '') + this.route() + '#r' + this.nonce());
  });

  private trust(url: string): SafeResourceUrl {
    // A project's own address, written by whoever registered it. It is
    // shown in a frame - which is the whole point of the room - and
    // nothing from it is ever run in this page.
    return this.sanitizer.bypassSecurityTrustResourceUrl(url);
  }

  /** Where the picture sits in the view and how far it is scaled. Never
   *  up: a phone page blown up to the view's width is not what a phone
   *  shows. */
  fit = computed(() => {
    const { w: bw, h: bh } = this.room();
    const s = this.shot();
    const live = this.liveSize();
    const vw = this.frozen() && s ? s.width : live.w;
    const vh = this.frozen() && s ? s.height : live.h;
    // The phone's bezel is drawn outside the picture, so it is left room
    // for: the screen is the picture, the bezel only frames it.
    const pad = 12, bez = this.platform() === 'mobile' ? 6 : 0;
    const k = Math.max(0.05, Math.min((bw - 2 * (pad + bez)) / vw,
                                      (bh - 2 * (pad + bez)) / vh, 1));
    const w = Math.round(vw * k), h = Math.round(vh * k);
    return { k, w, h, x: Math.round((bw - w) / 2) - bez, y: Math.round((bh - h) / 2) - bez };
  });

  // ---- the firmware ----

  private loadFirmware() {
    const a = this.here();
    if (!a || this.platform() !== 'embedded') return;
    this.apps.firmware(a._id).subscribe({ next: d => this.fw.set(d as FwData | null) });
    this.apps.boards().subscribe({ next: b => this.boards.set(b) });
  }

  /** Flash and RAM, file by file, largest first: where the bytes went. */
  fwColumns(): { label: string; total: number;
                 files: { file: string; total: number; syms: FwSymbol[] }[] }[] {
    const d = this.fw();
    if (!d) return [];
    const col = (label: string, want: string[]) => {
      const mine = d.symbols.filter(s => want.includes(s.where));
      const by = new Map<string, FwSymbol[]>();
      for (const s of mine) {
        const k = s.file ?? '(libraries)';
        by.set(k, [...(by.get(k) ?? []), s]);
      }
      const files = [...by.entries()]
        .map(([file, syms]) => ({ file, syms: syms.slice(0, 12),
                                  total: syms.reduce((n, s) => n + s.size, 0) }))
        .sort((a, b) => b.total - a.total).slice(0, 16);
      return { label, total: mine.reduce((n, s) => n + s.size, 0), files };
    };
    return [col('Flash', ['flash', 'both']), col('RAM', ['ram', 'both'])];
  }

  /** How much a region grew or shrank since the build before. */
  grew(r: { name: string; used: number }): number {
    const was = this.fw()?.before?.regions?.find(b => b.name === r.name);
    return was ? r.used - was.used : 0;
  }

  /** A function or a table, made the note's Part: what it is and where it
   *  is written, as the agent will want to find it. */
  pickSymbol(s: FwSymbol) {
    this.pickedSym.set(s.name);
    const where = s.file ? ` · ${s.file}${s.line ? ':' + s.line : ''}` : '';
    const label = `${s.name}${where}`;
    this.picked.codeParts.set([label]);
    this.picked.codePick.set({ label });
  }

  kb(n: number): string { return n >= 1024 ? (n / 1024).toFixed(1) + ' kB' : n + ' B'; }
  abs(n: number): number { return Math.abs(n); }

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

  /** The canvas matches the picture's box on screen at the screen's own
   *  density; a resize carries the marks with it. */
  private sizeOverlay() {
    const c = this.overlay()?.nativeElement;
    if (!c) return;
    const f = this.fit();
    const ratio = Math.min(devicePixelRatio, 2);
    const w = Math.round(f.w * ratio), h = Math.round(f.h * ratio);
    if (c.width === w && c.height === h) return;
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
    const t = this.pen.tool();
    if (t === 'text') {
      const c = this.overlay()!.nativeElement.getBoundingClientRect();
      this.typeAt = at;
      this.typing.set({ left: ev.clientX - c.left, top: ev.clientY - c.top });
      setTimeout(() => this.caret()?.nativeElement.focus());
      return;
    }
    this.drawing = true;
    (ev.target as HTMLElement).setPointerCapture(ev.pointerId);
    const color = this.pen.color(), width = this.pen.width();
    this.active = t === 'pen'
      ? { kind: 'pen', color, width, pts: [at] }
      : { kind: t, color, width, a: at, b: at };
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
    this.marks.push({ kind: 'text', color: this.pen.color(),
                      size: this.pen.fontSize() * scale, at: this.typeAt, text });
    this.repaint();
    this.lookUnder();
  }

  undo() { this.marks.pop(); this.repaint(); this.lookUnder(); }
  clear() { this.marks = []; this.repaint(); this.lookUnder(); }

  private repaint() {
    const ctx = this.overlay()?.nativeElement.getContext('2d');
    if (ctx) paint(ctx, this.marks, Math.min(devicePixelRatio, 2));
  }

  /** Lay the marks on the elements, in the picture's own pixels: the
   *  canvas is the picture scaled to the screen. */
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
        viewport: [s?.width ?? this.liveSize().w, s?.height ?? this.liveSize().h],
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
      error: e => { this.diff.set(null); this.diffWait.set(this.why(e)); },
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

  countLine(t: TestRun): string {
    const c = Object.entries(t.counts ?? {});
    return c.length ? c.map(([k, v]) => `${v} ${k}`).join(', ') : `exit ${t.rc}`;
  }

  // ---- the live half ----

  private tick() {
    this.health.system().subscribe({ next: s => this.sys.set(s) });
    this.activity.lines(60, this.platform()).subscribe({ next: rows => this.log.set(rows) });
    const a = this.here();
    if (a && this.side() === 'server') {
      const src = this.platform() === 'embedded' ? this.apps.buildLog(a._id)
                                                 : this.apps.serverLog(a._id);
      src.subscribe({ next: r => this.serverLines.set(r.lines) });
    }
  }

  /** What changes on the scale of an edit rather than a second. */
  private slowTick() {
    const a = this.here();
    if (!a) return;
    this.apps.status(a._id).subscribe({ next: s => this.status.set(s) });
    if (this.platform() === 'mobile') {
      this.apps.phoneState().subscribe({ next: st => {
        // The phone just came up, or the project was just opened: put the
        // project on it, so the live view is the app and not a home screen.
        const was = this.phoneUp();
        this.phoneUp.set(st.booted);
        if (st.booted && (!was || this.phoneFor !== a._id)) this.showOnPhone();
      } });
    }
    if (this.platform() === 'embedded') {
      this.apps.boards().subscribe({ next: b => this.boards.set(b) });
    }
    // A build or a test run the agent made since: the room follows it.
    this.apps.one(a._id).subscribe({ next: fresh => {
      if (fresh.firmware?.at !== a.firmware?.at) { this.here.set(fresh); this.loadFirmware(); }
      if (fresh.last_test?.at !== this.tests()?.at) {
        this.apps.lastTest(a._id).subscribe({ next: t => this.tests.set(t) });
      }
    } });
    // Archived ones as well: auto-archive files a note away the moment it
    // is done, which is exactly when its before and after are worth seeing.
    forkJoin([this.api.list(false), this.api.list(true)]).subscribe({
      next: ([open, filed]) => this.revisions.set([...open, ...filed]),
    });
    this.apps.compute(a._id).subscribe({ next: c => this.cost.set(c) });
    if (this.view() === 'diff' && !this.diff()?.frozen) this.loadDiff();
  }

  gauges(): { key: string; pct: number; read: string; tip: string }[] {
    const m = this.sys();
    if (!m) return [];
    const out = [
      { key: 'cpu', pct: m.cpu.load,
        read: `${m.cpu.load.toFixed(0)}% · ${m.cpu.cores}c/${m.cpu.threads}t`, tip: m.cpu.name },
      { key: 'ram', pct: 100 * m.ram.used_bytes / (m.ram.total_bytes || 1),
        read: `${(m.ram.used_bytes / 1e9).toFixed(1)} / ${(m.ram.total_bytes / 1e9).toFixed(1)} GB`,
        tip: 'memory in use' },
    ];
    if (m.gpu) {
      out.push({ key: 'gpu', pct: m.gpu.util,
                 read: `${m.gpu.util.toFixed(0)}% · ${m.gpu.temp_c.toFixed(0)}°`, tip: m.gpu.name });
    }
    return out;
  }

  secs(s?: number | null): string {
    if (!s) return '–';
    return s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${s.toFixed(1)} s`;
  }

  cores(s?: number | null): string { return s ? `${s.toFixed(1)} core-s` : '–'; }

  private why(e: { error?: { detail?: unknown }; message?: string }): string {
    return String(e?.error?.detail ?? e?.message ?? e).slice(0, 300);
  }

  // ---- what survives F5: x3.<room>.* like the board room's x3.pcb.* ----

  private static recall(room: string, key: string, fallback: string): string {
    try { return localStorage.getItem(`x3.${room}.${key}`) ?? fallback; }
    catch { return fallback; }
  }

  private static keep(room: string, key: string, value: string) {
    try { localStorage.setItem(`x3.${room}.${key}`, value); } catch { /* private window */ }
  }
}
