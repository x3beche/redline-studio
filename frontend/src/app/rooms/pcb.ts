import {
  Component, ElementRef, OnDestroy, effect, inject, signal, viewChild,
} from '@angular/core';
import {
  Activity, BoardCompute, BoardEntry, BoardGraph, BoardLayout, Boards, Health,
  LcscAsk, LcscJournal, LogLine, PartHeld, PartHit, PartPreview, Parts,
  SystemInfo,
} from '../api';
import { Selection } from '../selection';
import { Board3d } from './board3d';

/** What a component sits at on the ring, and what a net draws between. */
interface Placed {
  ref: string;
  x: number;
  y: number;
  label: string;
  sub: string;
  where: string | null;
}

/** The board room.
 *
 *  A model builds into geometry and you look at the solid. A board builds
 *  into a netlist and what there is to look at is the circuit: the parts
 *  and what is joined to what. atopile does not place copper - layout
 *  stays KiCad's - so this draws the thing that is actually parametric.
 *
 *  The ring is deliberate. A netlist has no positions in it, and inventing
 *  some with a physics run gives a different picture every time you open
 *  it; a ring is the same picture for the same circuit, and a net is a
 *  chord you can follow.
 */
@Component({
  selector: 'app-room-pcb',
  imports: [Board3d],
  template: `
<div class="tcv-room absolute inset-0 flex min-h-0 flex-col">

  @if (!here()) {
    <p class="p-3 text-[12px]" style="color: var(--ink-dim)">
      Pick a board in the catalog - a <b>.pcb</b> opens here.
    </p>
  } @else {

  <!-- Four panes, all of them at once.
       A board is not one picture with three ways of looking at it: the
       drawing, the circuit and the model are different questions about
       the same thing, and answering one usually means looking at
       another. The switch made that two clicks and a lost position.

       The log under this and the queue beside it are the room's as much
       as the 3D room's - it sits in the viewer's own grid, so both are
       where they always were. -->
  <div class="grid min-h-0 flex-1 gap-2 p-2"
       style="grid-template-columns: 5fr 10fr 6fr;
              grid-template-rows: 5fr 4fr 3fr">

    <!-- PARTS, FROM LCSC
         A board can only be drawn out of parts somebody can buy: the
         number is what the footprint and the 3D model are fetched by, so
         this is where a board gets its shapes. Searching downloads
         nothing - a search is a list to choose from. -->
    <section class="tcv-pane" style="grid-column: 1; grid-row: 1 / span 3">
      <header class="tcv-pane-head">
        <span class="tcv-label">parts</span>
        <span class="mono ml-auto text-[10px]" style="color: var(--ink-dim)">
          {{ held().length }} kept
        </span>
      </header>

      <div class="flex shrink-0 gap-1 p-2" style="border-bottom: 1px solid var(--line)">
        <input [value]="term()" (input)="term.set($any($event.target).value)"
               (keydown.enter)="look()"
               placeholder="C25744, or 0603 100nF"
               class="tcv-field min-w-0 flex-1 px-1.5 py-1 text-[11px]">
        <button (click)="look()" [disabled]="looking()"
                class="tcv-btn shrink-0 px-2 py-0.5">
          {{ looking() ? '…' : 'find' }}
        </button>
      </div>

      @if (partNote(); as n) {
        <p class="shrink-0 px-2 py-1 text-[11px]" style="color: var(--ink-dim)">{{ n }}</p>
      }

      @if (seen() || seeing()) {
        <!-- ONE PART, IN FULL
             Everything that can be known about it without keeping it:
             what it is, what it costs, its footprint, its symbol and its
             shape, all straight from EasyEDA on the click. Kept on the
             server's disk, so a second look is instant. -->
        <div class="min-h-0 flex-1 overflow-auto">
          <div class="flex items-center gap-1 px-2 py-1.5"
               style="border-bottom: 1px solid var(--line)">
            <button (click)="closePart()" class="tcv-chip">&larr; list</button>
            @if (seen(); as s) {
              <span class="mono ml-auto text-[11px]" style="color: var(--ink)">{{ s.lcsc }}</span>
            }
          </div>

          @if (seen(); as s) {
            <div class="p-2">
              <div class="flex gap-2">
                @if (s.has_photo && noPhoto() !== s.lcsc) {
                  <!-- Gone quietly if the host will not hand it over:
                       LCSC's own image host turns away anything that is
                       not a browser, and a broken-image icon says less
                       than nothing. -->
                  <img [src]="store.file(s.lcsc, 'photo.jpg')" alt=""
                       (error)="noPhoto.set(s.lcsc)"
                       class="h-16 w-16 shrink-0 rounded object-contain"
                       style="background: var(--shot-bg)">
                }
                <div class="min-w-0 flex-1">
                  <div class="text-[12px] font-semibold" style="color: var(--ink)">{{ s.name }}</div>
                  <div class="text-[11px]" style="color: var(--ink-dim)">{{ s.maker }}</div>
                  <div class="mt-1 text-[11px] leading-snug" style="color: var(--ink-dim)">
                    {{ s.description }}
                  </div>
                </div>
              </div>

              <div class="mono mt-2 grid text-[11px]"
                   style="grid-template-columns: auto 1fr; column-gap: 8px; row-gap: 2px">
                <span style="color: var(--ink-dim)">package</span>
                <span class="truncate" [title]="s.package ?? ''">{{ s.package }}</span>
                <span style="color: var(--ink-dim)">price</span>
                <span>{{ money(s.price) }}@if (s.min && s.min > 1) { · min {{ s.min }} }</span>
                <span style="color: var(--ink-dim)">stock</span>
                <span>{{ countOf(s.stock) }}</span>
                <!-- JLCPCB assembles Basic parts without a loading fee;
                     an Extended one costs a feeder per run. It decides
                     between two equal parts more often than price does. -->
                <span style="color: var(--ink-dim)">jlc</span>
                <span [style.color]="basic(s) ? 'var(--ok)' : 'var(--warn)'"
                      [title]="basic(s) ? 'no loading fee at JLCPCB'
                                        : 'a feeder fee per assembly run at JLCPCB'">
                  {{ s.jlc_class || '–' }}
                </span>
              </div>

              <div class="mt-2 flex gap-1">
                @if (s.have) {
                  <span class="tcv-chip" style="color: var(--ok)">in the drawer</span>
                } @else {
                  <button (click)="keep(s.lcsc, $event)" [disabled]="!!fetching()"
                          class="tcv-btn tcv-btn-accent px-2 py-0.5">
                    {{ fetching() === s.lcsc ? 'fetching…' : '+ keep' }}
                  </button>
                }
                @if (s.url) {
                  <a [href]="s.url" target="_blank" rel="noreferrer"
                     class="tcv-chip ml-auto">LCSC &#8599;</a>
                }
              </div>
            </div>

            <!-- The shape, turned the way it sits on a board. -->
            <div class="tcv-label px-2 pt-1">3d</div>
            <div class="mx-2 mt-1 h-44 overflow-hidden rounded"
                 style="background: var(--surface-2)">
              @if (s.has_model) {
                @defer (on viewport) {
                  <app-board-3d [src]="store.file(s.lcsc, 'model.glb')" />
                } @placeholder {
                  <p class="p-2 text-[11px]" style="color: var(--ink-dim)">…</p>
                }
              } @else {
                <p class="p-2 text-[11px]" style="color: var(--ink-dim)">
                  No 3D model. It will not be standing on the board.
                </p>
              }
            </div>
            @if (s.model_name) {
              <div class="mono truncate px-2 pt-0.5 text-[10px]" style="color: var(--ink-dim)"
                   [title]="s.model_name">{{ s.model_name }}</div>
            }

            <!-- The drawings are EasyEDA's own. Only ever through <img>,
                 where nothing in the markup can run. -->
            <div class="tcv-label px-2 pt-2">footprint</div>
            <div class="mx-2 mt-1 flex h-40 items-center justify-center rounded p-2"
                 style="background: var(--pcb-bg)">
              <!-- Filled, not left at its own size: EasyEDA writes a
                   footprint in millimetres, and an LQFP-48 at its natural
                   15 mm is a stamp in the middle of the box. -->
              <img [src]="store.file(s.lcsc, 'footprint.svg')" alt="footprint"
                   class="h-full w-full object-contain">
            </div>

            <div class="tcv-label px-2 pt-2">symbol</div>
            <div class="mx-2 mb-2 mt-1 flex h-56 items-center justify-center rounded p-2"
                 style="background: var(--shot-bg)">
              <img [src]="store.file(s.lcsc, 'symbol.svg')" alt="symbol"
                   class="h-full w-full object-contain">
            </div>
          } @else {
            <p class="p-2 text-[11px]" style="color: var(--ink-dim)">looking it up…</p>
          }
        </div>
      } @else {
      <div class="min-h-0 flex-1 overflow-auto">
        <!-- What LCSC has. The number, what it is, and the two things
             that decide between two of the same part: stock and price. -->
        @for (h of hits(); track h.lcsc) {
          <div (click)="inspect(h.lcsc)"
               class="group flex cursor-pointer items-start gap-2 px-2 py-1.5"
               [style.background]="seen()?.lcsc === h.lcsc ? 'var(--accent-deep)' : null"
               style="border-bottom: 1px solid var(--line)">
            <div class="min-w-0 flex-1">
              <div class="mono text-[11px]" style="color: var(--ink)">
                {{ h.lcsc }}
                <span style="color: var(--ink-dim)">{{ h.package }}</span>
              </div>
              <div class="truncate text-[11px]" [title]="h.mpn ?? ''"
                   style="color: var(--ink-dim)">{{ h.mpn }}</div>
              <div class="mono text-[10px]" style="color: var(--ink-dim)">
                {{ h.maker }} · {{ countOf(h.stock) }} in stock
                @if (h.price != null) { · {{ money(h.price) }} }
              </div>
            </div>
            @if (h.have) {
              <span class="shrink-0 text-[11px]" style="color: var(--ok)"
                    title="already in the drawer">kept</span>
            } @else {
              <button (click)="keep(h.lcsc, $event)" [disabled]="!!fetching()"
                      class="tcv-chip shrink-0"
                      title="fetch its footprint and 3D model">
                {{ fetching() === h.lcsc ? '…' : '+' }}
              </button>
            }
          </div>
        }

        <!-- The drawer. Fetched once and kept: a part number means the
             same thing tomorrow, and a board rebuilt ten times should not
             ask somebody else's service ten times. -->
        @if (held().length) {
          <div class="tcv-label px-2 pb-1 pt-2">in the drawer</div>
          @for (p of held(); track p.lcsc) {
            <div (click)="inspect(p.lcsc)"
                 class="group flex cursor-pointer items-center gap-2 px-2 py-1"
                 [style.background]="seen()?.lcsc === p.lcsc ? 'var(--accent-deep)' : null">
              <span class="mono shrink-0 text-[11px]" style="color: var(--ink)">{{ p.lcsc }}</span>
              <span class="min-w-0 flex-1 truncate text-[11px]"
                    style="color: var(--ink-dim)" [title]="p.name ?? ''">{{ p.name }}</span>
              <span class="shrink-0 text-[10px]"
                    [style.color]="p.has_3d ? 'var(--ok)' : 'var(--ink-dim)'"
                    [title]="p.has_3d ? 'came with a 3D model'
                                      : 'footprint only - it will not stand on the board'">
                {{ p.has_3d ? '3d' : '2d' }}
              </span>
              <button (click)="forget(p, $event)"
                      class="shrink-0 text-[11px] opacity-0 group-hover:opacity-100"
                      style="color: var(--danger)" title="forget it">&times;</button>
            </div>
          }
        }
      </div>
      }
    </section>

    <!-- WHAT IT COST, AND WHAT THE MACHINE IS DOING
         The board's own figures. The catalog's foot and the revision
         cards say the same kind of thing about models; these are about
         this board, so they are counted here. -->
    <section class="tcv-pane" style="grid-column: 3; grid-row: 3">
      <header class="tcv-pane-head">
        <span class="tcv-label">machine</span>
        @if (cost(); as c) {
          <span class="mono ml-auto text-[10px]" style="color: var(--ink-dim)">
            {{ c.total.jobs }} jobs
          </span>
        }
      </header>
      <div class="min-h-0 flex-1 overflow-auto p-2 text-[11px]">
        @if (cost()?.jobs?.length) {
          <div class="mono">
            @for (j of cost()!.jobs.slice(0, 5); track j.at) {
              <div class="flex gap-2 leading-relaxed">
                <span class="w-11 shrink-0"
                      [style.color]="j.rc ? 'var(--danger)' : 'var(--ink)'">
                  {{ j.kind === 'board' ? 'build' : j.kind }}
                </span>
                <span class="shrink-0" style="color: var(--ink-dim)">{{ secs(j.wall_s) }}</span>
                <!-- atopile runs here and is measured here; KiCad runs in
                     a container whose time is nobody's child, so a
                     placement reports the clock and nothing else. -->
                <span class="ml-auto shrink-0 truncate" style="color: var(--ink-dim)">
                  {{ j.kind === 'layout' ? 'in a container' : cores(j.cpu_s) }}
                </span>
              </div>
            }
          </div>
        } @else {
          <div style="color: var(--ink-dim)">nothing built yet</div>
        }

        <!-- What is stored, which is the other half of what it cost. -->
        @if (artifacts().length) {
          <div class="mono mt-2 pt-2" style="border-top: 1px solid var(--line)">
            @for (a of artifacts(); track a.name) {
              <div class="flex justify-between leading-relaxed"
                   style="color: var(--ink-dim)">
                <span>{{ a.name }}</span>
                <span>{{ kb(a.bytes) }}</span>
              </div>
            }
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
                <div class="mt-0.5 h-[3px] overflow-hidden rounded"
                     style="background: var(--line)">
                  <div class="h-full rounded transition-[width] duration-500"
                       [style.width.%]="g.pct" style="background: var(--accent)"></div>
                </div>
              </div>
            }
          </div>
        }
      </div>
    </section>

    <!-- THE LOG
         Its own, not the 3D room's: the lines a board writes are about
         this board, and a build that happened while you were looking at
         something else is exactly what you want to read here. -->
    <section class="tcv-pane" style="grid-column: 2"
             [style.grid-row]="tall() ? '2 / span 2' : '3'">
      <header class="tcv-pane-head">
        <button (click)="setBottom('log')" class="tcv-chip"
                [attr.data-on]="bottom() === 'log' ? 1 : null">log</button>
        <!-- Every ask made of LCSC, by whoever made it. These are
             somebody else's endpoints and they turn a burst away, so what
             the agents are doing to them is worth being able to watch. -->
        <button (click)="setBottom('lcsc')" class="tcv-chip"
                [attr.data-on]="bottom() === 'lcsc' ? 1 : null">lcsc</button>
        @if (bottom() === 'log') {
          <span class="mono ml-auto text-[10px]" style="color: var(--ink-dim)">
            {{ log().length }} lines
          </span>
        } @else if (asks(); as j) {
          <span class="mono ml-auto truncate text-[10px]" style="color: var(--ink-dim)">
            last hour: {{ j.last_hour.net }} sent · {{ j.last_hour.disk }} from disk
            @if (j.last_hour.refused) {
              · <span style="color: var(--danger)">{{ j.last_hour.refused }} refused</span>
            }
          </span>
        }
        <button (click)="toggleTall()" class="tcv-chip shrink-0"
                [class.ml-auto]="bottom() === 'lcsc' && !asks()"
                [title]="tall() ? 'back to its size' : 'taller, over the drawing'">
          {{ tall() ? '⤡' : '⤢' }}
        </button>
      </header>

      @if (bottom() === 'log') {
        <div #logBox class="tcv-scroll mono min-h-0 flex-1 overflow-y-auto px-2 py-1 text-[11px]">
          @for (l of log(); track l._id) {
            <div class="flex gap-2 leading-snug">
              <span class="shrink-0" style="color: var(--line)">{{ l.at.slice(11, 19) }}</span>
              <span [style.color]="levelColor(l.level)">{{ l.text }}</span>
            </div>
          } @empty {
            <div style="color: var(--ink-dim)">no activity yet</div>
          }
        </div>
      } @else {
        <!-- The turn-taking as it stands: how far apart asks are kept,
             and - when EasyEDA has said no - why and for how long. -->
        @if (asks(); as j) {
          <div class="mono flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1 text-[10px]"
               style="border-bottom: 1px solid var(--line)">
            @if (j.state.refused_until) {
              <span style="color: var(--danger)">
                cooling off · {{ coolLeft(j) }} left · {{ j.state.refused_why }}
              </span>
            } @else {
              <span style="color: var(--ok)">asking</span>
            }
            <span style="color: var(--ink-dim)">one ask every {{ j.state.gap_s }} s</span>
            <!-- EasyEDA refuses a count, not a rate - 35 asks over 220 s
                 were enough - so this is the number that matters. -->
            <span [style.color]="j.state.used >= j.state.budget ? 'var(--warn)' : 'var(--ink-dim)'">
              {{ j.state.used }}/{{ j.state.budget }} asks in {{ j.state.window_s / 60 }} min
            </span>
            <span class="ml-auto flex gap-1">
              @for (f of askFilters; track f) {
                <button (click)="askFilter.set(f)" class="tcv-chip px-1.5 py-0"
                        [attr.data-on]="askFilter() === f ? 1 : null">{{ f }}</button>
              }
            </span>
          </div>
        }
        <div class="tcv-scroll mono min-h-0 flex-1 overflow-y-auto text-[11px]">
          @for (a of shownAsks(); track a.at + a.kind + a.target) {
            <div (click)="openAsk.set(openAsk() === a ? null : a)"
                 class="cursor-pointer px-2 py-0.5"
                 [style.background]="openAsk() === a ? 'var(--accent-deep)' : null">
              <!-- The part number or the search is what is being read
                   down this list, so it gets the room; the rest are
                   narrow and fixed. -->
              <div class="flex items-baseline gap-1.5">
                <span class="shrink-0" style="color: var(--line)">{{ a.at.slice(11, 19) }}</span>
                <span class="w-[3.6rem] shrink-0 truncate" [style.color]="whoColor(a.who)">{{ a.who }}</span>
                <span class="w-[4.2rem] shrink-0 truncate" style="color: var(--ink-dim)">{{ a.kind }}</span>
                <span class="min-w-0 flex-1 truncate" style="color: var(--ink)"
                      [title]="a.target">{{ a.target }}</span>
                <span class="w-[3.3rem] shrink-0 text-right" [style.color]="sourceColor(a)">
                  {{ a.source === 'net' ? (a.status ?? 'err') : a.source }}
                </span>
                <span class="w-[3.2rem] shrink-0 text-right" style="color: var(--ink-dim)">
                  {{ a.source === 'net' ? a.ms + 'ms' : '' }}
                </span>
                <span class="w-[2.6rem] shrink-0 text-right" style="color: var(--ink-dim)">
                  {{ a.bytes ? size(a.bytes) : '' }}
                </span>
              </div>
              @if (openAsk() === a) {
                <div class="mb-1 mt-0.5 break-all pl-[3.6rem] text-[10px] leading-snug"
                     style="color: var(--ink-dim)">
                  @if (a.url) { <div>{{ a.url }}</div> }
                  @if (a.error) { <div style="color: var(--danger)">{{ a.error }}</div> }
                  <div>{{ a.at }} · {{ a.who }} · {{ sourceWord(a.source) }}</div>
                </div>
              }
            </div>
          } @empty {
            <div class="px-2 py-1" style="color: var(--ink-dim)">nothing asked yet</div>
          }
        </div>
      }
    </section>

    <!-- LAYOUT -->
    <section class="tcv-pane" style="grid-column: 2"
             [style.grid-row]="tall() ? '1' : '1 / span 2'">
      <!-- The two things you can do to a board live over the drawing they
           change, not in a bar of their own across the top. -->
      <header class="tcv-pane-head">
        <span class="tcv-label">layout</span>
        @if (hasLayout()) {
          <span class="mono text-[10px]" style="color: var(--ink-dim)">
            {{ here()?.layout?.placed }} placed
            @if (here()?.layout?.size_mm; as mm) { · {{ mm[0] }} × {{ mm[1] }} mm }
            · not routed
          </span>
        }
        <div class="ml-auto flex shrink-0 items-center gap-1">
          @if (note(); as n) {
            <span class="mono mr-1 max-w-[16rem] truncate text-[10px]"
                  style="color: var(--warn)" [title]="n">{{ n }}</span>
          }
          <button (click)="rebuild()" [disabled]="busy()"
                  class="tcv-btn tcv-btn-accent px-2 py-0.5">
            {{ busy() ? 'building…' : 'build' }}
          </button>
          <button (click)="relayout()" [disabled]="busy() || !here()?.ready"
                  class="tcv-btn px-2 py-0.5"
                  title="place it and draw it - KiCad, in a container">
            {{ laying() ? 'placing…' : 'lay out' }}
          </button>
        </div>
      </header>
      @if (hasLayout()) {
        <!-- The sheet is the drawing, not the pane: a board is wider than
             it is tall, and stretching the element to the pane put it in
             the middle of a white block four times its height. -->
        <div class="flex min-h-0 flex-1 items-center justify-center p-2">
          <!-- Black, the way KiCad shows a board: its colours - pale
               yellow silkscreen, red and purple copper, the grey outline -
               are chosen for a dark ground, and on white the silkscreen
               was barely there. -->
          <div class="w-full rounded" style="background: var(--pcb-bg);
                      padding: 10px; max-height: 100%"
               [style.aspect-ratio]="sheet()">
            <img [src]="layoutUrl()" alt="board layout"
                 class="h-full w-full" style="object-fit: contain">
          </div>
        </div>
        @if (trouble().length) {
          <div class="shrink-0 px-2 pb-1.5 text-[11px]" style="color: var(--warn)">
            @for (m of trouble(); track m) { <div class="truncate" [title]="m">{{ m }}</div> }
          </div>
        }
      } @else {
        <p class="p-2 text-[12px]" style="color: var(--ink-dim)">
          {{ here()?.ready
             ? 'Built, but not placed yet. lay out fetches each part from LCSC, places them and draws the board.'
             : 'Not built yet. Press build and atopile will say what it makes of it.' }}
        </p>
      }
    </section>

    <!-- CIRCUIT -->
    <section class="tcv-pane" style="grid-column: 3; grid-row: 1">
      <header class="tcv-pane-head">
        <span class="tcv-label">circuit</span>
        <!-- What the board is made of, where the list of it used to be:
             the ring says which parts, so the count belongs on it. -->
        @if (graph(); as g) {
          <span class="mono ml-auto text-[10px]" style="color: var(--ink-dim)">
            {{ g.counts.components }} parts · {{ g.counts.nets }} nets ·
            {{ g.counts.joins }} joins
          </span>
        }
      </header>
      <div class="min-h-0 flex-1 p-1">
        @if (graph()) {
          <svg [attr.viewBox]="'0 0 ' + SIZE + ' ' + SIZE"
               class="h-full w-full" preserveAspectRatio="xMidYMid meet">
            <!-- nets first: a chord between two parts, a star through the
                 middle when more than two sit on it -->
            @for (l of links(); track l.key) {
              <path [attr.d]="l.d" fill="none" stroke="var(--line)"
                    stroke-width="1.4" />
            }
            @for (l of netLabels(); track l.key) {
              <text [attr.x]="l.x" [attr.y]="l.y" text-anchor="middle"
                    font-size="9" fill="var(--ink-dim)">{{ l.name }}</text>
            }
            @for (p of placed(); track p.ref) {
              <g [attr.transform]="'translate(' + p.x + ',' + p.y + ')'">
                <rect x="-34" y="-15" width="68" height="30" rx="4"
                      fill="var(--surface-2)" stroke="var(--accent)"
                      stroke-width="1.2" />
                <text y="-2" text-anchor="middle" font-size="11"
                      fill="var(--ink)">{{ p.label }}</text>
                <text y="9" text-anchor="middle" font-size="8"
                      fill="var(--ink-dim)">{{ p.sub }}</text>
                <title>{{ p.where }}</title>
              </g>
            }
          </svg>
        } @else {
          <p class="p-2 text-[12px]" style="color: var(--ink-dim)">
            The circuit comes out of the build.
          </p>
        }
      </div>
    </section>

    <!-- THE BOARD, IN THREE DIMENSIONS -->
    <section class="tcv-pane" style="grid-column: 3; grid-row: 2">
      <header class="tcv-pane-head">
        <span class="tcv-label">3d</span>
        <span class="mono ml-auto text-[10px]" style="color: var(--ink-dim)">
          drag to turn it over
        </span>
      </header>
      @if (has3d()) {
        <!-- Fetched when the pane is on screen. three.js and a glTF
             loader are a third of a megabyte, and they are no use in any
             other room. -->
        <div class="min-h-0 flex-1 overflow-hidden"
             style="background: var(--surface-2)">
          @defer (on viewport) {
            <app-board-3d [src]="modelUrl()" />
          } @placeholder {
            <p class="p-3 text-[12px]" style="color: var(--ink-dim)">
              bringing the viewer in…
            </p>
          }
        </div>
      } @else {
        <p class="p-2 text-[12px]" style="color: var(--ink-dim)">
          No model yet. <b>lay out</b> makes one alongside the drawing.
        </p>
      }
    </section>

  </div>
  }
</div>`,
})
export class RoomPcb implements OnDestroy {
  private api = inject(Boards);
  private picked = inject(Selection);
  private health = inject(Health);
  private activity = inject(Activity);
  /** Read by the template for the preview URLs. */
  store = inject(Parts);
  private logBox = viewChild<ElementRef<HTMLDivElement>>('logBox');

  readonly SIZE = 520;
  boards = signal<BoardEntry[]>([]);
  here = signal<BoardEntry | null>(null);
  graph = signal<BoardGraph | null>(null);
  busy = signal(false);
  laying = signal(false);
  note = signal('');
  lastLayout = signal<BoardLayout | null>(null);
  cost = signal<BoardCompute | null>(null);
  /** The drawer of parts, and what a search in LCSC turned up. */
  held = signal<PartHeld[]>([]);
  hits = signal<PartHit[]>([]);
  term = signal('');
  looking = signal(false);
  fetching = signal<string | null>(null);
  partNote = signal('');
  /** The part open in the column, and the one being looked up. */
  seen = signal<PartPreview | null>(null);
  seeing = signal<string | null>(null);
  /** The part whose photo would not load, so the frame is not left empty. */
  noPhoto = signal<string | null>(null);

  /** The bottom pane: this room's log, or every ask made of LCSC. Kept
   *  across a reload, like the other panels. */
  bottom = signal<'log' | 'lcsc'>(RoomPcb.recall('bottom', 'log') as 'log' | 'lcsc');
  tall = signal(RoomPcb.recall('tall', '') === '1');
  asks = signal<LcscJournal | null>(null);
  readonly askFilters = ['all', 'sent', 'disk', 'refused', 'agent', 'page'] as const;
  askFilter = signal<(typeof RoomPcb.prototype.askFilters)[number]>('all');
  openAsk = signal<LcscAsk | null>(null);
  sys = signal<SystemInfo | null>(null);
  log = signal<LogLine[]>([]);
  private timers: ReturnType<typeof setInterval>[] = [];

  constructor() {
    this.refresh();
    this.drawer();
    this.tick();
    // The room is only mounted while its tab is on, so this stops when
    // somebody leaves rather than polling behind another room.
    this.timers.push(setInterval(() => this.tick(), 3000));
    // Opened from the catalog: the tree is shared, so the room follows
    // what was clicked rather than keeping a list beside it.
    effect(() => {
      const want = this.picked.board();
      if (!want || this.here()?._id === want) return;
      const found = this.boards().find(b => b._id === want);
      if (found) this.open(found);
      else this.refresh();
    });
  }

  ngOnDestroy() {
    for (const id of this.timers) clearInterval(id);
  }

  // ---- parts, from LCSC ----

  private drawer() {
    this.store.held().subscribe({ next: rows => this.held.set(rows) });
  }

  /** Look in LCSC's catalogue. A part number finds itself; anything else
   *  is a search, and nothing is downloaded by looking. */
  look() {
    const q = this.term().trim();
    if (!q || this.looking()) return;
    this.looking.set(true);
    this.partNote.set('');
    this.store.search(q).subscribe({
      next: rows => {
        this.looking.set(false);
        this.hits.set(rows);
        if (!rows.length) this.partNote.set('nothing came back for that');
      },
      error: e => {
        this.looking.set(false);
        this.partNote.set(String(e?.error?.detail ?? 'LCSC did not answer'));
      },
    });
  }

  /** Open one part in the column: the facts at once, the drawings and
   *  the model as they arrive. Clicking through a list quickly starts
   *  several lookups; only the last one clicked may land. */
  inspect(lcsc: string) {
    if (this.seen()?.lcsc === lcsc) return;
    this.seeing.set(lcsc);
    this.seen.set(null);
    this.store.preview(lcsc).subscribe({
      next: p => { if (this.seeing() === lcsc) this.seen.set(p); },
      error: e => {
        if (this.seeing() !== lcsc) return;
        this.seeing.set(null);
        this.partNote.set(String(e?.error?.detail ?? `${lcsc} could not be looked up`));
      },
    });
  }

  closePart() {
    this.seen.set(null);
    this.seeing.set(null);
  }

  /** JLCPCB's Basic parts carry no loading fee. */
  basic(p: PartPreview): boolean {
    return (p.jlc_class ?? '').toLowerCase().startsWith('basic');
  }

  /** Keep one: its footprint, and its 3D model if it has one. That is
   *  what puts it within reach of a board. */
  keep(lcsc: string, ev?: Event) {
    ev?.stopPropagation();
    if (this.fetching()) return;
    this.fetching.set(lcsc);
    this.partNote.set('');
    this.store.add(lcsc).subscribe({
      next: got => {
        this.fetching.set(null);
        this.hits.update(rows => rows.map(
          r => r.lcsc === lcsc ? { ...r, have: true } : r));
        this.seen.update(s => s?.lcsc === lcsc ? { ...s, have: true } : s);
        this.partNote.set(`${got.lcsc} kept`
          + (got.has_3d ? ' with a 3D model' : ', footprint only'));
        this.drawer();
      },
      error: e => {
        this.fetching.set(null);
        this.partNote.set(String(e?.error?.detail ?? 'could not fetch it')
          .slice(0, 200));
      },
    });
  }

  forget(part: PartHeld, ev: Event) {
    ev.stopPropagation();
    this.store.drop(part.lcsc).subscribe({ next: () => this.drawer() });
  }

  money(p: number | null): string {
    return p == null ? '–' : p < 0.01 ? `$${p.toFixed(4)}` : `$${p.toFixed(2)}`;
  }

  countOf(n: number | null): string {
    if (!n) return 'none';
    return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
  }

  private static KEY = 'x3.pcb.';

  private static recall(key: string, fallback: string): string {
    try { return localStorage.getItem(RoomPcb.KEY + key) ?? fallback; }
    catch { return fallback; }
  }

  private static keep(key: string, value: string) {
    try { localStorage.setItem(RoomPcb.KEY + key, value); } catch { /* private window */ }
  }

  setBottom(which: 'log' | 'lcsc') {
    this.bottom.set(which);
    RoomPcb.keep('bottom', which);
    if (which === 'lcsc') this.readJournal();
    else setTimeout(() => this.scrollLog(), 30);
  }

  toggleTall() {
    this.tall.update(v => !v);
    RoomPcb.keep('tall', this.tall() ? '1' : '');
  }

  private readJournal() {
    this.store.journal(300).subscribe({ next: j => this.asks.set(j) });
  }

  shownAsks(): LcscAsk[] {
    const rows = this.asks()?.rows ?? [];
    switch (this.askFilter()) {
      case 'sent': return rows.filter(a => a.source === 'net');
      case 'disk': return rows.filter(a => a.source === 'disk');
      case 'refused': return rows.filter(a => a.source === 'refused'
                                          || a.status === 403 || a.status === 429);
      case 'agent': return rows.filter(a => a.who !== 'page');
      case 'page': return rows.filter(a => a.who === 'page');
      default: return rows;
    }
  }

  coolLeft(j: LcscJournal): string {
    const s = Math.max(0, Math.round((j.state.refused_until ?? 0) - j.state.now));
    return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
  }

  whoColor(who: string): string {
    return who === 'page' ? 'var(--ink-dim)' : 'var(--accent)';
  }

  sourceColor(a: LcscAsk): string {
    if (a.source === 'refused' || a.status === 403 || a.status === 429) return 'var(--danger)';
    if (a.source === 'disk') return 'var(--ink-dim)';
    if (a.source === 'wait') return 'var(--warn)';
    return a.status === 200 ? 'var(--ok)' : 'var(--warn)';
  }

  sourceWord(s: LcscAsk['source']): string {
    return s === 'net' ? 'sent to EasyEDA'
      : s === 'disk' ? 'answered from disk, nothing sent'
      : s === 'wait' ? 'an agent waiting for the budget; sent when it frees'
      : 'not sent - cooling off, or the budget is spent';
  }

  size(bytes: number): string {
    return bytes >= 1e6 ? (bytes / 1e6).toFixed(1) + 'M'
      : bytes >= 1000 ? Math.round(bytes / 1000) + 'k' : bytes + 'B';
  }

  /** The live half: what the machine is doing, and what has happened. */
  private tick() {
    if (this.bottom() === 'lcsc') this.readJournal();
    this.health.system().subscribe({ next: s => this.sys.set(s) });
    this.activity.lines(60).subscribe({
      next: rows => {
        const last = this.log()[this.log().length - 1]?._id;
        this.log.set(rows);
        if (rows[rows.length - 1]?._id !== last) {
          setTimeout(() => this.scrollLog(), 30);
        }
      },
    });
  }

  private scrollLog() {
    const box = this.logBox()?.nativeElement;
    if (box) box.scrollTop = box.scrollHeight;
  }

  /** The three live readings, drawn the way the catalog's foot draws
   *  them. Its own copy: this one is beside a board, and the one down
   *  there is beside the models. */
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

  levelColor(l: LogLine['level']): string {
    return l === 'error' ? 'var(--danger)'
      : l === 'warn' ? 'var(--warn)'
      : l === 'done' ? 'var(--ok)'
      : l === 'work' ? 'var(--accent)' : 'var(--ink-dim)';
  }

  refresh() {
    this.api.list().subscribe({
      next: rows => {
        this.boards.set(rows);
        const want = this.picked.board() ?? this.here()?._id;
        const keep = want ? rows.find(b => b._id === want) : null;
        this.open(keep ?? rows.find(b => b.ready) ?? rows[0] ?? null);
      },
      error: () => this.note.set('could not read the boards'),
    });
  }

  open(b: BoardEntry | null) {
    this.here.set(b);
    this.graph.set(null);
    this.picked.boardParts.set([]);
    this.cost.set(null);
    if (!b) return;
    this.api.compute(b._id).subscribe({ next: c => this.cost.set(c) });
    if (!b.ready) return;
    // The artifact is immutable and served that way, so the build time is
    // what tells the browser to fetch a new one.
    this.api.graph(b._id, b.artifacts?.['graph']?.at).subscribe({
      next: g => {
        this.graph.set(g);
        this.picked.boardParts.set(g.components.map(
          c => c.part ? `${c.ref} · ${c.part}` : c.ref));
      },
      error: () => this.note.set('the build output could not be read'),
    });
  }

  /** Everything the placement could not do, in one list. */
  trouble(): string[] {
    return [
      ...(this.here()?.layout?.missing ?? []).map(m => `no footprint for ${m}`),
      ...(this.lastLayout()?.part_trouble ?? []),
    ];
  }

  /** What is stored for this board, which is the other half of what it
   *  cost: a netlist is kilobytes, a model with parts on it is not. */
  artifacts(): { name: string; bytes: number }[] {
    const a = this.here()?.artifacts ?? {};
    const named: Record<string, string> = {
      graph: 'netlist', footprints: 'footprints',
      layout: 'drawing', model3d: 'model',
    };
    return Object.entries(named)
      .filter(([key]) => a[key])
      .map(([key, name]) => ({ name, bytes: a[key].bytes ?? 0 }));
  }

  /** The drawing's own shape, so the sheet is the board and not a white
   *  block around it. The exporter writes the board area as the page. */
  sheet(): string {
    const mm = this.here()?.layout?.size_mm;
    return mm && mm[1] ? `${mm[0]} / ${mm[1]}` : '3 / 2';
  }

  kb(bytes: number): string {
    return bytes >= 1e6 ? (bytes / 1e6).toFixed(1) + ' MB'
                        : Math.round(bytes / 1000) + ' kB';
  }

  secs(s?: number): string {
    if (!s) return '–';
    return s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
                   : `${s.toFixed(1)} s`;
  }

  cores(s?: number): string { return s ? `${s.toFixed(1)} core-s` : '–'; }

  hasLayout(): boolean {
    return !!this.here()?.layout?.at;
  }

  /** The build time stamps the URL: the file is served immutable, so
   *  without it the browser keeps showing the board from last time. */
  layoutUrl(): string {
    const b = this.here();
    return `/api/boards/${b?._id}/layout.svg?v=`
      + encodeURIComponent(b?.layout?.at ?? '');
  }

  has3d(): boolean {
    return !!this.here()?.artifacts?.['model3d'];
  }

  modelUrl(): string {
    const b = this.here();
    return `/api/boards/${b?._id}/board.glb?v=`
      + encodeURIComponent(b?.artifacts?.['model3d']?.at ?? '');
  }

  relayout() {
    const b = this.here();
    if (!b || this.laying()) return;
    this.laying.set(true);
    this.note.set('');
    this.api.layout(b._id).subscribe({
      next: r => {
        this.laying.set(false);
        this.lastLayout.set(r);
        this.refresh();
      },
      error: e => {
        this.laying.set(false);
        this.note.set(String(e?.error?.detail ?? e?.message ?? e).slice(0, 400));
      },
    });
  }

  rebuild() {
    const b = this.here();
    if (!b || this.busy()) return;
    this.busy.set(true);
    this.note.set('');
    this.api.build(b._id).subscribe({
      next: () => { this.busy.set(false); this.refresh(); },
      error: e => {
        this.busy.set(false);
        // atopile's own words: it is better at saying what is wrong with a
        // circuit than anything this could paraphrase.
        this.note.set(String(e?.error?.detail ?? e?.message ?? e).slice(0, 400));
      },
    });
  }

  /** Components on a ring, in the order the netlist lists them. */
  placed(): Placed[] {
    const g = this.graph();
    if (!g) return [];
    const n = g.components.length || 1;
    const r = n <= 2 ? 110 : Math.min(190, 60 + n * 14);
    const mid = this.SIZE / 2;
    return g.components.map((c, i) => {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      return {
        ref: c.ref,
        x: Math.round(mid + Math.cos(a) * r),
        y: Math.round(mid + Math.sin(a) * r),
        label: c.ref,
        sub: (c.footprint ?? '').replace(/^lib:/, '') || (c.part ?? ''),
        where: [c.where, c.part, c.value].filter(Boolean).join(' · '),
      };
    });
  }

  private at(ref: string | null): Placed | undefined {
    return this.placed().find(p => p.ref === ref);
  }

  /** A net with two pins is a chord; with more, a star through its middle,
   *  which is what a shared rail actually is. */
  links(): { key: string; d: string }[] {
    const g = this.graph();
    if (!g) return [];
    const out: { key: string; d: string }[] = [];
    const mid = this.SIZE / 2;
    for (const net of g.nets) {
      const ends = net.nodes.map(nd => this.at(nd.ref)).filter(Boolean) as Placed[];
      if (ends.length === 2) {
        const [a, b] = ends;
        // bowed towards the middle, so two nets between the same pair do
        // not lie on top of each other
        const cx = (a.x + b.x) / 2 * 0.75 + mid * 0.25;
        const cy = (a.y + b.y) / 2 * 0.75 + mid * 0.25;
        out.push({ key: net.code + '-' + net.name,
                   d: `M${a.x},${a.y} Q${cx},${cy} ${b.x},${b.y}` });
      } else if (ends.length > 2) {
        const hx = ends.reduce((s, p) => s + p.x, 0) / ends.length;
        const hy = ends.reduce((s, p) => s + p.y, 0) / ends.length;
        ends.forEach((p, i) => out.push({
          key: net.code + '-' + net.name + '-' + i,
          d: `M${p.x},${p.y} L${Math.round(hx)},${Math.round(hy)}`,
        }));
      }
    }
    return out;
  }

  netLabels(): { key: string; name: string; x: number; y: number }[] {
    const g = this.graph();
    if (!g) return [];
    return g.nets.map(net => {
      const ends = net.nodes.map(nd => this.at(nd.ref)).filter(Boolean) as Placed[];
      if (!ends.length) return null;
      const x = ends.reduce((s, p) => s + p.x, 0) / ends.length;
      const y = ends.reduce((s, p) => s + p.y, 0) / ends.length;
      return { key: net.code + '-' + net.name, name: net.name ?? '',
               x: Math.round(x), y: Math.round(y) - 4 };
    }).filter(Boolean) as { key: string; name: string; x: number; y: number }[];
  }
}
