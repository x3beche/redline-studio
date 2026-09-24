import {
  Component, OnDestroy, effect, inject, signal, untracked, viewChild,
} from '@angular/core';
import {
  Activity, BoardCompute, BoardEntry, BoardGeometry, BoardGraph, BoardLayout, BoardRules,
  Boards, LcscAsk, LcscJournal, LogLine, PartHeld, PartHit,
  PartPreview, Parts, RuleSchema,
} from '../api';
import { Selection } from '../selection';
import { Board3d } from './board3d';
import { Drawing } from './drawing';
import { RoomFrame, ToolButton } from './frame';
import { RulesForm } from './rules-form';
import { DrawTools, PenState, Sketchpad } from './sketchpad';

type SideTab = 'parts' | 'rules' | 'checks' | 'lcsc';

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
  imports: [Board3d, Drawing, DrawTools, RoomFrame, RulesForm, Sketchpad, ToolButton],
  template: `
<div class="tcv-room absolute inset-0 flex min-h-0 flex-col p-1">

  @if (!here()) {
    <p class="p-3 text-[12px]" style="color: var(--ink-dim)">
      Pick a board in the catalog - a <b>.pcb</b> opens here.
    </p>
  } @else {

  <!-- The 3D room's layout, because it is the app's one layout: the
       toolbar across the top with the pen at its end, the tabs down the
       left, the board beside them and the log under it. -->
  <app-room-frame room="pcb" [tabs]="sideTabs" [tab]="side()" [labels]="tabNames"
                  (tabChange)="setSide($any($event))" [log]="log()">

    <!-- THE TOOLBAR
         Which picture of the board, which side of it, how close, and the
         files it is made of. Nothing here makes anything: the agent runs
         the pipeline when a change is asked for. -->
    <ng-container ngProjectAs="[bar]">
      <app-tool icon="tcv-ico-layout" tip="Layout - the copper, placed and routed"
                [on]="boardTab() === 'layout'" (press)="setBoardTab('layout')" />
      <app-tool icon="tcv-ico-schematic" tip="Schematic - drawn from the source"
                [on]="boardTab() === 'schematic'" (press)="setBoardTab('schematic')" />
      <app-tool icon="tcv-ico-model" tip="3D - the board with its parts on"
                [on]="boardTab() === '3d'" (press)="setBoardTab('3d')" />
      <span class="tcv_separator"></span>
      <app-tool icon="tcv-ico-front" tip="Front - with the ground pour"
                [on]="boardTab() === 'layout' && view() === 'front'"
                [disabled]="boardTab() !== 'layout' || !here()?.route" (press)="view.set('front')" />
      <app-tool icon="tcv-ico-tracks" tip="Tracks - the pour left off to follow them"
                [on]="boardTab() === 'layout' && view() === 'tracks'"
                [disabled]="boardTab() !== 'layout' || !here()?.route" (press)="view.set('tracks')" />
      <app-tool icon="tcv-ico-back" tip="Back - seen from below"
                [on]="boardTab() === 'layout' && view() === 'back'"
                [disabled]="boardTab() !== 'layout' || !here()?.route" (press)="view.set('back')" />
      <span class="tcv_separator"></span>
      <app-tool icon="tcv-ico-fit" tip="Fit - all of it (or double-click)"
                [disabled]="boardTab() === '3d' || frozen()" (press)="flat()?.fit()" />
      <app-tool icon="tcv-ico-in" tip="Closer" [disabled]="boardTab() === '3d' || frozen()"
                (press)="flat()?.step(1.25)" />
      <app-tool icon="tcv-ico-out" tip="Further" [disabled]="boardTab() === '3d' || frozen()"
                (press)="flat()?.step(0.8)" />
      <span class="tcv_separator"></span>
      <app-tool icon="tcv-ico-pcbfile" tip="board.kicad_pcb - open it in KiCad"
                [href]="hasLayout() ? file('board.kicad_pcb') : null" [disabled]="!hasLayout()" />
      <app-tool icon="tcv-ico-schfile" tip="board.kicad_sch - the schematic, for KiCad"
                [href]="here()?.schematic ? file('board.kicad_sch') : null"
                [disabled]="!here()?.schematic" />
      <app-tool icon="tcv-ico-glb" tip="board.glb - the 3D model"
                [href]="has3d() ? modelUrl() : null" [disabled]="!has3d()" />
      <span class="tcv_separator"></span>
      <!-- What came of the last run, said once, where the eye already is. -->
      <span class="tcv-frame-status mono">
        @if (building()) { <span style="color: var(--accent)">building… </span> }
        @switch (boardTab()) {
          @case ('layout') {
            @if (here()?.route; as r) {
              <span [style.color]="r.unrouted || here()?.drc?.error_count ? 'var(--danger)' : 'var(--ok)'"
                    [title]="routeTitle()">
                {{ r.unrouted ? r.unrouted + ' unrouted' : 'routed' }} ·
                DRC {{ here()?.drc?.error_count ?? '?' }}
              </span>
            } @else if (hasLayout()) {
              <span>{{ here()?.layout?.placed }} placed · not routed</span>
            }
          }
          @case ('schematic') {
            @if (here()?.schematic; as s) {
              <span [style.color]="s.erc.error_count ? 'var(--danger)' : 'var(--ok)'"
                    [title]="'ERC: ' + s.erc.error_count + ' errors, ' + s.erc.warning_count
                             + ' warnings; library set-up notes left out'">
                {{ s.parts }} parts · ERC {{ s.erc.error_count }}
              </span>
            }
          }
          @case ('3d') { <span>drag to turn it over</span> }
        }
        @if (note(); as n) {
          <span style="color: var(--warn)" [title]="n"> · {{ n }}</span>
        }
      </span>
    </ng-container>

    <!-- The pen, at the toolbar's end as in the 3D room: press it and the
         view is held still as a picture to draw on; the note beside the
         room is then filed with that picture. -->
    <ng-container ngProjectAs="[barEnd]">
      <!-- The whole pipeline, as the agent runs it: build the source, draw
           the schematic, place, route to the rules, pour, DRC. -->
      <app-tool icon="tcv-ico-build"
                [tip]="building() ? 'Building…' : 'Build - source, schematic, place, route, DRC'"
                [on]="building()" [disabled]="building() || frozen() || !here()"
                (press)="build()" />
      @if (frozen()) {
        <app-draw-tools [pen]="pen" (undo)="pad()?.undo()" (clear)="pad()?.clear()" />
      }
      <span class="tcv_tooltip" [attr.data-tooltip]="frozen() ? 'Let the view go' : 'Draw on it'">
        <span class="tcv_button_frame">
          <button class="tcv_reset tcv_btn tcv-freeze" [attr.data-on]="frozen() ? 1 : null"
                  [disabled]="!canFreeze()"
                  (click)="frozen() ? resume() : freeze()"></button>
        </span>
      </span>
    </ng-container>

    <!-- THE TABS -->
    <div side class="flex h-full min-h-0 flex-col">
      @if (side() === 'parts') {
        <!-- PARTS, FROM LCSC
             A board can only be drawn out of parts somebody can buy: the
             number is what the footprint and the 3D model are fetched by,
             so this is where a board gets its shapes. Searching downloads
             nothing - a search is a list to choose from. -->

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
      } @else {
      @if (side() === 'rules') {
        <!-- ROUTING RULES
             What the router is told, as a form drawn from the server's
             schema: classes, pairs and pours added, changed and removed.
             Worked out from the net names the first time; what is saved
             is kept, and the next run routes to it. The agent edits the
             same rules (revisions.py board rules). -->
        <div class="min-h-0 flex-1 overflow-auto p-2 text-[11px]">
          @if (draft(); as r) {
            @if (schema(); as sc) {
              <app-rules-form [rules]="r" [schema]="sc" [nets]="nets()"
                              [members]="members()" [problems]="shownProblems()"
                              (changed)="draftChanged($event)" />
            }
            <div class="tcv-rule-save">
              <button (click)="saveRules()" [disabled]="!rulesDirty() || saving()"
                      class="tcv-btn tcv-btn-accent px-3 py-0.5">{{ saving() ? 'saving…' : 'Save' }}</button>
              <button (click)="loadRules()" [disabled]="!rulesDirty()"
                      class="tcv-btn px-2 py-0.5">Revert</button>
              <span class="min-w-0 truncate text-[10px]"
                    [style.color]="shownProblems().length ? 'var(--danger)' : 'var(--ink-dim)'">
                {{ shownProblems().length ? shownProblems().length + ' to fix' : rulesNote() }}
              </span>
            </div>
          } @else {
            <div style="color: var(--ink-dim)">build the board first - rules follow its nets</div>
          }
        </div>
      } @else if (side() === 'checks') {
        <!-- WHAT THE CHECKS FOUND
             KiCad's DRC over the routed board and ERC over the schematic,
             itemised: errors first, then warnings, then what sits inside a
             part's own footprint or is about the project's set-up rather
             than the design. -->
        <div class="mono min-h-0 flex-1 overflow-auto p-2 text-[11px]">
          @if (here()?.drc; as d) {
            <div class="tcv-label mb-1">DRC · the board</div>
            <div [style.color]="d.error_count ? 'var(--danger)' : 'var(--ok)'">
              {{ d.error_count }} errors · {{ d.unconnected }} unconnected
            </div>
            @for (e of entries(d.errors); track e[0]) {
              <div class="flex justify-between" style="color: var(--danger)"><span>{{ e[0] }}</span><span>{{ e[1] }}</span></div>
            }
            @for (x of d.examples; track x) {
              <div class="mb-0.5 break-words leading-snug" style="color: var(--ink-dim)">· {{ x }}</div>
            }
            @for (u of d.unconnected_examples; track u) {
              <div class="break-words leading-snug" style="color: var(--danger)">unconnected: {{ u }}</div>
            }
            <div class="mt-1" style="color: var(--ink-dim)">{{ d.warning_count }} warnings</div>
            @for (e of entries(d.warnings); track e[0]) {
              <div class="flex justify-between" style="color: var(--ink-dim)"><span>{{ e[0] }}</span><span>{{ e[1] }}</span></div>
            }
            @if (entries(d.in_footprints).length) {
              <div class="mt-1" style="color: var(--ink-dim)"
                   title="both ends of the finding are in the same part: the maker's land pattern, not the layout">
                inside a part's own footprint
              </div>
              @for (e of entries(d.in_footprints); track e[0]) {
                <div class="flex justify-between" style="color: var(--ink-dim)"><span>{{ e[0] }}</span><span>{{ e[1] }}</span></div>
              }
            }
          } @else {
            <div style="color: var(--ink-dim)">no DRC yet - run routes and checks the board</div>
          }

          @if (here()?.schematic?.erc; as e) {
            <div class="tcv-label mb-1 mt-3">ERC · the schematic</div>
            <div [style.color]="e.error_count ? 'var(--danger)' : 'var(--ok)'">
              {{ e.error_count }} errors · {{ e.warning_count }} warnings
            </div>
            @for (x of entries(e.errors); track x[0]) {
              <div class="flex justify-between" style="color: var(--danger)"><span>{{ x[0] }}</span><span>{{ x[1] }}</span></div>
            }
            @for (x of e.examples; track x) {
              <div class="mb-0.5 break-words leading-snug" style="color: var(--ink-dim)">· {{ x }}</div>
            }
            @for (x of entries(e.warnings); track x[0]) {
              <div class="flex justify-between" style="color: var(--ink-dim)"
                   [title]="x[0] === 'pin_to_pin' ? 'mostly LCSC symbols whose pins are typed Unspecified' : ''">
                <span>{{ x[0] }}</span><span>{{ x[1] }}</span>
              </div>
            }
            @if (entries(e.setup).length) {
              <div class="mt-1" style="color: var(--ink-dim)"
                   title="the generated project has no library tables; not about the design">
                library set-up notes
              </div>
              @for (x of entries(e.setup); track x[0]) {
                <div class="flex justify-between" style="color: var(--ink-dim)"><span>{{ x[0] }}</span><span>{{ x[1] }}</span></div>
              }
            }
          }
        </div>
      } @else if (side() === 'lcsc') {
        <!-- EVERY ASK MADE OF LCSC, by whoever made it. These are
             somebody else's endpoints and they turn a burst away, so what
             the agents are doing to them is worth being able to watch. -->
        @if (asks(); as j) {
          <div class="mono shrink-0 px-2 pt-1 text-[10px]" style="color: var(--ink-dim)">
            last hour: {{ j.last_hour.net }} sent · {{ j.last_hour.disk }} from disk
            @if (j.last_hour.refused) {
              · <span style="color: var(--danger)">{{ j.last_hour.refused }} refused</span>
            }
          </div>
        }
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
            <span class="flex flex-wrap gap-1">
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
              <!-- Two lines, so it reads in a narrow column: what was
                   asked for and how it went, then when, by whom and what
                   it cost. On one line the part number was the thing
                   pushed off the edge. -->
              <div class="flex items-baseline gap-1.5">
                <span class="min-w-0 flex-1 truncate" style="color: var(--ink)"
                      [title]="a.target">{{ a.target }}</span>
                <span class="shrink-0" [style.color]="sourceColor(a)">
                  {{ a.source === 'net' ? (a.status ?? 'err') : a.source }}
                </span>
              </div>
              <div class="flex flex-wrap gap-x-1.5 text-[10px]" style="color: var(--ink-dim)">
                <span style="color: var(--line)">{{ a.at.slice(11, 19) }}</span>
                <span [style.color]="whoColor(a.who)">{{ a.who }}</span>
                <span>{{ a.kind }}</span>
                @if (a.source === 'net') { <span>{{ a.ms }}ms</span> }
                @if (a.bytes) { <span>{{ size(a.bytes) }}</span> }
              </div>
              @if (openAsk() === a) {
                <div class="mb-1 mt-0.5 break-all text-[10px] leading-snug"
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
      }
    </div>


    <!-- WHAT THE RUNS COST AND WHAT IS KEPT
         Beside the log it explains, and folded with it: each run's time,
         and what the board's artifacts weigh. -->
    <div logSide class="text-[11px]">
        @if (cost()?.jobs?.length) {
          <div class="mono">
            @for (j of cost()!.jobs.slice(0, 5); track j.at) {
              <div class="flex gap-2 leading-relaxed">
                <span class="w-10 shrink-0"
                      [style.color]="j.rc ? 'var(--danger)' : 'var(--ink)'">
                  {{ j.kind === 'board' ? 'build' : j.kind }}
                </span>
                <span class="shrink-0" style="color: var(--ink-dim)">{{ secs(j.wall_s) }}</span>
                <!-- atopile runs here and is measured here; KiCad runs in
                     a container whose time is nobody's child, so a
                     placement reports the clock and nothing else. -->
                <span class="ml-auto shrink-0 truncate" style="color: var(--ink-dim)"
                      [title]="j.kind === 'layout' ? 'in the KiCad container - only its clock is measured' : ''">
                  {{ j.kind === 'layout' ? 'kicad' : cores(j.cpu_s) }}
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

    </div>

    <!-- THE BOARD
         One view, three ways of looking at the same board: the copper,
         the schematic it came from, and the thing in three dimensions. -->
    <div view class="relative h-full w-full">
      @switch (boardTab()) {
        @case ('layout') {
          @if (hasLayout()) {
            <app-drawing #flat [src]="layoutUrl()" [controls]="false"
                         [geometry]="here()?.route ? geo() : null" [mirror]="view() === 'back'"
                         [side]="view() === 'back' ? 'B' : 'all'" />
          } @else {
            <p class="p-3 text-[12px]" style="color: var(--ink-dim)">{{ notYet }}</p>
          }
        }
        @case ('schematic') {
          @if (here()?.schematic; as s) {
            <app-drawing #flat [src]="file('schematic.svg', s.at)" [controls]="false" />
          } @else {
            <p class="p-3 text-[12px]" style="color: var(--ink-dim)">{{ notYet }}</p>
          }
        }
        @case ('3d') {
          @if (has3d()) {
            <!-- Fetched when the tab is opened. three.js and a glTF
                 loader are a third of a megabyte, and they are no use
                 in any other room. -->
            <div class="h-full w-full overflow-hidden rounded"
                 style="background: var(--surface-2)">
              @defer (on viewport) {
                <app-board-3d #model [src]="modelUrl()" />
              } @placeholder {
                <p class="p-3 text-[12px]" style="color: var(--ink-dim)">
                  bringing the viewer in…
                </p>
              }
            </div>
          } @else {
            <p class="p-3 text-[12px]" style="color: var(--ink-dim)">{{ notYet }}</p>
          }
        }
      }
      @if (frozen() && shot(); as s) {
        <app-sketchpad #pad [shot]="s" [pen]="pen" />
      }
      @if (boardTab() === 'layout' && trouble().length && !frozen()) {
        <div class="absolute inset-x-2 bottom-2 rounded px-2 py-1 text-[11px]"
             style="background: var(--shade); color: var(--warn)">
          @for (m of trouble(); track m) { <div class="truncate" [title]="m">{{ m }}</div> }
        </div>
      }
    </div>

    <!-- The view's corner: which side of the board, like the 3D room's "All". -->
    @if (boardTab() === 'layout' && here()?.route && !frozen()) {
      <select ngProjectAs="[corner]" class="tcv-corner"
              (change)="view.set($any($event.target).value)" title="which side of the board">
        @for (v of views; track v) { <option [value]="v" [selected]="view() === v">{{ v }}</option> }
      </select>
    }
  </app-room-frame>
  }
</div>`,
})
export class RoomPcb implements OnDestroy {
  private api = inject(Boards);
  private picked = inject(Selection);
  private activity = inject(Activity);
  /** Read by the template for the preview URLs. */
  store = inject(Parts);
  /** The flat drawing on screen, the 3D view, and the pad over either
   *  while the view is held. The 3D one by its shape, not its class: its
   *  class would pull three.js out of the deferred chunk. */
  flat = viewChild<Drawing>('flat');
  private model = viewChild<{ snapshot(): string | null }>('model');
  pad = viewChild<Sketchpad>('pad');

  boards = signal<BoardEntry[]>([]);
  here = signal<BoardEntry | null>(null);
  graph = signal<BoardGraph | null>(null);
  /** The routed board as data: what the mouse can point at on the layout. */
  geo = signal<BoardGeometry | null>(null);
  note = signal('');

  /** The board window's tab, which pane is made large if any, and which
   *  side tab is showing - all kept across a reload like the other panels. */
  readonly boardTabs = ['layout', 'schematic', '3d'] as const;
  boardTab = signal<'layout' | 'schematic' | '3d'>(
    RoomPcb.pick(RoomPcb.recall('board', 'layout'), ['layout', 'schematic', '3d'], 'layout'));
  /** What an empty tab says. Nothing here makes a board: the agent runs
   *  the pipeline when a change is asked for. */
  readonly notYet = 'Nothing yet. Ask for the change - a board note, or the '
    + 'thread under the queue - and the agent runs the pipeline: build, '
    + 'schematic, place, route, DRC.';
  readonly sideTabs = ['parts', 'rules', 'checks', 'lcsc'] as const;
  /** The LCSC tab is the parts supplier's side of things - every request
   *  made of it and the turn-taking - so it is named for what it is. */
  readonly tabNames = { parts: 'Parts', rules: 'Rules', checks: 'Checks', lcsc: 'Sourcing' };
  side = signal<SideTab>(RoomPcb.pick(RoomPcb.recall('side', 'parts'), this.sideTabs, 'parts'));

  /** The pen: the view held as a picture, and what is being drawn with. */
  readonly pen = new PenState();
  frozen = signal(false);
  shot = signal<string | null>(null);
  /** The copper as KiCad draws it with the ground pour, without it so the
   *  tracks can be followed, and the back seen from below. */
  readonly views = ['front', 'tracks', 'back'] as const;
  view = signal<'front' | 'tracks' | 'back'>('tracks');

  /** The rules as saved, and as being edited. */
  private savedRules = signal<string>('');
  draft = signal<BoardRules | null>(null);
  nets = signal<string[]>([]);
  rulesNote = signal('');
  schema = signal<RuleSchema | null>(null);
  members = signal<Record<string, string[]>>({});
  shownProblems = signal<string[]>([]);
  saving = signal(false);
  private checking?: ReturnType<typeof setTimeout>;
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

  asks = signal<LcscJournal | null>(null);
  readonly askFilters = ['all', 'sent', 'disk', 'refused', 'agent', 'page'] as const;
  askFilter = signal<(typeof RoomPcb.prototype.askFilters)[number]>('all');
  openAsk = signal<LcscAsk | null>(null);
  log = signal<LogLine[]>([]);
  private timers: ReturnType<typeof setInterval>[] = [];

  constructor() {
    this.refresh();
    this.drawer();
    this.tick();
    // The room is only mounted while its tab is on, so this stops when
    // somebody leaves rather than polling behind another room.
    this.timers.push(setInterval(() => this.tick(), 3000));
    // A note filed with the drawing lets the view go, as the 3D room does.
    let filed = this.picked.boardFiled();
    effect(() => {
      const n = this.picked.boardFiled();
      if (n !== filed) { filed = n; untracked(() => this.resume()); }
    });
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
    this.picked.boardDraft.set(null);
  }

  // ---- the pipeline ----

  building = signal(false);

  /** Build it the whole way through, the same run the agent does - never
   *  a step on its own - and show what came of it. */
  build() {
    const b = this.here();
    if (!b || this.building()) return;
    this.building.set(true);
    this.note.set('');
    this.api.run(b._id).subscribe({
      next: () => { this.building.set(false); this.refresh(); },
      error: e => {
        this.building.set(false);
        this.note.set(String(e?.error?.detail ?? 'the run failed - see the log').slice(0, 160));
        this.refresh();
      },
    });
  }

  // ---- the pen ----

  canFreeze(): boolean {
    const t = this.boardTab();
    return t === '3d' ? !!this.model() : !!this.flat()?.ready();
  }

  /** Hold the view still as a picture - exactly what is on screen, at the
   *  zoom and angle it is at - and put the pad over it. */
  freeze() {
    const shot = this.boardTab() === '3d' ? this.model()?.snapshot() : this.flat()?.snapshot();
    if (!shot) { this.note.set('nothing on screen to draw on yet'); return; }
    this.shot.set(shot);
    this.frozen.set(true);
    this.picked.boardDraft.set(() => this.pad()?.merged() ?? Promise.resolve(null));
  }

  resume() {
    this.frozen.set(false);
    this.shot.set(null);
    this.picked.boardDraft.set(null);
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

  /** A remembered value, if it is still one of the choices - a tab that
   *  no longer exists is not a reason to show nothing. */
  private static pick<T extends string>(value: string, choices: readonly T[], fallback: T): T {
    return (choices as readonly string[]).includes(value) ? value as T : fallback;
  }

  private static recall(key: string, fallback: string): string {
    try { return localStorage.getItem(RoomPcb.KEY + key) ?? fallback; }
    catch { return fallback; }
  }

  private static keep(key: string, value: string) {
    try { localStorage.setItem(RoomPcb.KEY + key, value); } catch { /* private window */ }
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
    if (this.side() === 'lcsc') this.readJournal();
    this.activity.lines(60, 'pcb').subscribe({ next: rows => this.log.set(rows) });
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
    if (this.frozen()) this.resume();
    this.note.set('');
    this.here.set(b);
    this.graph.set(null);
    this.picked.boardParts.set([]);
    this.cost.set(null);
    this.geo.set(null);
    if (!b) return;
    if (b.artifacts?.['geometry']) {
      this.api.geometry(b._id, b.artifacts['geometry'].at).subscribe({
        next: g => { if (this.here()?._id === b._id) this.geo.set(g); },
      });
    }
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
      // A run rewrites this file; asked for in that moment it can miss.
      // Once more after a pause, and only then is it worth saying.
      error: () => setTimeout(() => this.api.graph(b._id, b.artifacts?.['graph']?.at).subscribe({
        next: g => {
          this.graph.set(g);
          this.picked.boardParts.set(g.components.map(
            c => c.part ? `${c.ref} · ${c.part}` : c.ref));
        },
        error: () => this.note.set('the build output could not be read'),
      }), 2000),
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
    const a = b?.artifacts ?? {};
    if (b?.route && this.view() === 'tracks' && a['tracks']) {
      return this.file('tracks.svg', a['tracks'].at);
    }
    if (b?.route && this.view() === 'back' && a['bottom']) {
      return this.file('bottom.svg', a['bottom'].at);
    }
    return this.file('layout.svg', b?.layout?.at);
  }

  /** A drawing or a KiCad file of the open board. */
  file(name: string, stamp?: string | null): string {
    return this.api.file(this.here()?._id ?? '', name, stamp ?? undefined);
  }

  routeTitle(): string {
    const r = this.here()?.route;
    const d = this.here()?.drc;
    if (!r) return '';
    return `${r.tracks} track segments, ${r.vias} vias, ${r.length_mm} mm of copper, `
      + `routed in ${r.route_s} s; DRC ${d?.error_count ?? '?'} errors, `
      + `${d?.warning_count ?? '?'} warnings, ${d?.unconnected ?? '?'} unconnected`;
  }

  // ---- which pane goes where ----

  setBoardTab(tab: 'layout' | 'schematic' | '3d') {
    if (this.frozen()) this.resume();
    this.boardTab.set(tab);
    RoomPcb.keep('board', tab);
  }

  setSide(tab: SideTab) {
    this.side.set(tab);
    RoomPcb.keep('side', tab);
    if (tab === 'rules' && !this.draft()) this.loadRules();
    if (tab === 'lcsc') this.readJournal();
  }

  entries(o: Record<string, number> | null | undefined): [string, number][] {
    return Object.entries(o ?? {}).sort((a, b) => b[1] - a[1]);
  }

  // ---- the rules ----

  loadRules() {
    const b = this.here();
    if (!b?.ready) { this.draft.set(null); return; }
    if (!this.schema()) this.api.rulesSchema().subscribe({ next: sc => this.schema.set(sc) });
    this.api.rules(b._id).subscribe({
      next: r => {
        this.nets.set(r.nets);
        this.draft.set(r.rules);
        this.members.set(r.members ?? {});
        this.shownProblems.set(r.problems);
        this.savedRules.set(JSON.stringify(r.rules));
        this.rulesNote.set('');
      },
    });
  }

  rulesDirty(): boolean {
    return !!this.draft() && JSON.stringify(this.draft()) !== this.savedRules();
  }

  /** A change in the form: kept as the draft, and checked by the server a
   *  moment later - the same check the save and the agent go through. */
  draftChanged(r: BoardRules) {
    this.draft.set(r);
    this.rulesNote.set('');
    clearTimeout(this.checking);
    const b = this.here();
    if (!b) return;
    this.checking = setTimeout(() => {
      this.api.checkRules(b._id, r).subscribe({
        next: got => {
          if (this.draft() !== r) return;
          this.shownProblems.set(got.problems);
          this.members.set(got.members);
        },
      });
    }, 250);
  }

  saveRules() {
    const b = this.here();
    const r = this.draft();
    if (!b || !r) return;
    this.saving.set(true);
    this.api.saveRules(b._id, r).subscribe({
      next: () => {
        this.saving.set(false);
        this.savedRules.set(JSON.stringify(r));
        this.shownProblems.set([]);
        this.rulesNote.set('saved - the next run routes to these');
      },
      error: e => {
        this.saving.set(false);
        const d = e?.error?.detail;
        if (d?.problems) this.shownProblems.set(d.problems);
        else this.rulesNote.set(String(d ?? 'not saved'));
      },
    });
  }

  has3d(): boolean {
    return !!this.here()?.artifacts?.['model3d'];
  }

  modelUrl(): string {
    const b = this.here();
    return `/api/boards/${b?._id}/board.glb?v=`
      + encodeURIComponent(b?.artifacts?.['model3d']?.at ?? '');
  }

}
