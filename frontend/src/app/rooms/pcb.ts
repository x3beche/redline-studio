import {
  Component, ElementRef, HostListener, OnDestroy, computed, effect, inject, signal, untracked, viewChild,
  viewChildren,
} from '@angular/core';
import { money } from '../money';
import {
  Activity, BoardComponent, BoardEntry, BoardGeometry, BoardSchematic, BoardStats, BoardGraph, BoardLayout, BoardRules,
  Boards, LogLine, PartHeld, PartHit,
  PartPreview, Parts, RuleSchema,
} from '../api';
import { Selection } from '../selection';
import { HttpClient } from '@angular/common/http';
import { NgTemplateOutlet } from '@angular/common';
import { Board3d } from './board3d';
import { CodeView } from './code-view';
import { PinIcon, PinnedByList } from './links';
import { Auth } from '../auth';
import { Releases } from './releases';
import { Prefs } from '../preferences';
import { isLightTheme } from '../../theme';
import { Drawing } from './drawing';
import { RouteLive } from './route-live';
import { RoomFrame, ToolButton } from './frame';
import { RulesForm } from './rules-form';
import { DrawTools, PenState, Sketchpad } from './sketchpad';
import { ImportBoard } from './import-board';
import { BoardHealth } from './board-health';
import { T, t } from '../i18n';
import { PartsDrawer } from './parts-drawer';
import { PartCard } from './part-card';
import { warmPart } from './part-assets';
import { BoardBodies } from './board-bodies';

/** An add being watched (backend main.py /api/parts-add). */
interface PartAdd {
  id?: string; lcsc: string; state: 'running' | 'done' | 'error';
  steps: { step: string; text: string }[]; error?: string | null; already?: boolean;
  place?: { group: string; branch: string; by: string } | null;
}

type SideTab = 'parts' | 'rules' | 'health';
type Pane = 'layout' | 'schematic' | '3d';
type BoardView = Pane | 'split' | 'focus';

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
  imports: [Board3d, CodeView, PinIcon, PinnedByList, Drawing, RouteLive, DrawTools, ImportBoard, Releases, BoardHealth, NgTemplateOutlet,
            PartsDrawer, RoomFrame, RulesForm, Sketchpad, T, ToolButton, PartCard, BoardBodies],
  template: `
<div class="tcv-room absolute inset-0 flex min-h-0 flex-col p-1">

  <!-- Import: a board from Gerbers, a fab zip, a STEP or a design file
       (rooms/import-board.ts, backend/imports). Over the room, so it can
       be reached with no board open. -->
  @if (importing()) {
    <app-import-board [initialProject]="here() ? projectOf(here()!) : ''"
                      (closed)="importing.set(false)" (opened)="importing.set(false)" />
  }
  @if (!here()) {
    <p class="p-3 text-[12px]" style="color: var(--ink-dim)">
      Pick a board in the catalog - a <b>.pcb</b> opens here - or
      <button class="tcv-chip" (click)="importing.set(true)">import one</button>
      from Gerbers, a STEP or a design file.
    </p>
  } @else {

  <!-- The 3D room's layout, because it is the app's one layout: the
       toolbar across the top with the pen at its end, the tabs down the
       left, the board beside them and the log under it. -->
  <app-room-frame room="pcb" [tabs]="sideTabs" [tab]="side()" [labels]="tabNames()"
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
      <app-tool icon="tcv-ico-split" tip="Windows - layout, schematic and 3D side by side, each window your pick"
                [on]="boardTab() === 'split'" (press)="setBoardTab('split')" />
      <app-tool icon="tcv-ico-focus" tip="Focus - one picture large, the other two small in the corner; click a small one to swap"
                [on]="boardTab() === 'focus'" (press)="setBoardTab('focus')" />
      <span class="tcv_separator"></span>
      <app-tool icon="tcv-ico-front" tip="Front - with the ground pour"
                [on]="showsLayout() && view() === 'front'"
                [disabled]="!showsLayout() || !here()?.route" (press)="view.set('front')" />
      <app-tool icon="tcv-ico-tracks" tip="Tracks - the pour left off to follow them"
                [on]="showsLayout() && view() === 'tracks'"
                [disabled]="!showsLayout() || !here()?.route" (press)="view.set('tracks')" />
      <app-tool icon="tcv-ico-back" tip="Back - seen from below"
                [on]="showsLayout() && view() === 'back'"
                [disabled]="!showsLayout() || !here()?.route" (press)="view.set('back')" />
      <span class="tcv_separator"></span>
      <app-tool icon="tcv-ico-fit" tip="Fit - all of it (or double-click)"
                [disabled]="boardTab() === '3d' || boardTab() === 'split' || boardTab() === 'focus' || frozen()" (press)="flat()?.fit()" />
      <app-tool icon="tcv-ico-in" tip="Closer" [disabled]="boardTab() === '3d' || boardTab() === 'split' || boardTab() === 'focus' || frozen()"
                (press)="flat()?.step(1.25)" />
      <app-tool icon="tcv-ico-out" tip="Further" [disabled]="boardTab() === '3d' || boardTab() === 'split' || boardTab() === 'focus' || frozen()"
                (press)="flat()?.step(0.8)" />
    </ng-container>

    <!-- The pen, at the toolbar's end as in the 3D room: press it and the
         view is held still as a picture to draw on; the note beside the
         room is then filed with that picture. -->
    <ng-container ngProjectAs="[barEnd]">
      <!-- The whole pipeline, as the agent runs it: build the source, draw
           the schematic, place, route to the rules, pour, DRC. -->
      <app-tool icon="tcv-ico-build"
                [tip]="imported() ? 'An imported board has no source to build'
                       : building() ? 'Building…' : 'Build - source, schematic, place, route, DRC'"
                [on]="building() || liveRouting()" [disabled]="building() || liveRouting() || frozen() || !here() || imported()"
                (press)="build()" />
      <!-- Which router the build uses (rules: route.engine). TraceMaker's
           routing is drawn live in the layout while it runs. -->
      @if (here() && !imported()) {
        <div class="tcv-engine" role="radiogroup" [attr.aria-label]="'Router' | t"
             [title]="'Which router the next build uses - TraceMaker can be watched routing in the layout' | t">
          @for (e of engines; track e.id) {
            <button role="radio" [attr.aria-checked]="engine() === e.id" [attr.data-on]="engine() === e.id ? '' : null"
                    [disabled]="building() || liveRouting() || frozen() || savingEngine() || !auth.can('edit')"
                    (click)="setEngine(e.id)">{{ e.label }}</button>
          }
        </div>
      }
      <!-- A board from outside: Gerbers, a fab zip, a STEP, a design file. -->
      <app-tool icon="tcv-ico-open" tip="Import - a board from Gerbers, a fab zip, a STEP or a design file"
                [on]="importing()" [disabled]="frozen()" (press)="importing.set(true)" />
      <!-- The project packed for a fab: Gerbers, BOM, pick-and-place, PDFs, STEP. -->
      <app-tool icon="tcv-ico-release" tip="Release - pack the project for manufacturing"
                [disabled]="!here()" (press)="releasing.set(true)" />
      <!-- The board's source, as an IDE shows it, over the view. -->
      <app-tool icon="tcv-ico-code" [tip]="imported() ? 'An imported board has no atopile source'
                       : ide() ? 'Back to the view' : 'Code - the board source (atopile)'"
                [on]="ide()" [disabled]="!here() || frozen() || imported()" (press)="ide.set(!ide())" />
      <!-- An imported board has no source: this writes it (atopile, every
           net as imported, guessed parts marked), builds it and checks
           the build against the import. With a BOM, the guesses go. -->
      @if (imported() || converted()) {
        <app-tool icon="tcv-ico-schfile"
                  [tip]="converting() ? 'Converting…' : imported()
                         ? 'Convert to code - write this board as atopile, build it, check it against the import'
                         : 'Convert again with a BOM - its part numbers replace the guessed parts'"
                  [on]="converting()" [disabled]="converting() || frozen() || !here()"
                  (press)="imported() ? convert() : bomPick.click()" />
        <input #bomPick type="file" accept=".csv,text/csv" hidden (change)="convertWithBom(bomPick)" />
      }
      @if (frozen()) {
        <app-draw-tools [pen]="pen" (undo)="pad()?.undo()" (clear)="pad()?.clear()" />
      }
      <span class="tcv_tooltip" [attr.data-tooltip]="frozen() ? 'Let the view go' : 'Draw on it'">
        <span class="tcv_button_frame">
          <button class="tcv_reset tcv_btn tcv-freeze" [attr.data-on]="frozen() ? 1 : null"
                  [disabled]="!canFreeze()"
                  (click)="ide.set(false); frozen() ? resume() : freeze()"></button>
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

      <!-- ADD A PART: its LCSC number, and the fetch watched step by step
           (POST /api/parts-add). Anything else typed is a search of LCSC,
           each hit with its own Add. -->
      <div class="flex shrink-0 gap-1 p-2" style="border-bottom: 1px solid var(--line)">
        <input [value]="term()" (input)="term.set($any($event.target).value)"
               (keydown.enter)="addOrLook()"
               placeholder="C25744, or search"
               class="tcv-field mono min-w-0 flex-1 px-1.5 py-1 text-[11px]">
        <button (click)="addOrLook()" [disabled]="looking() || adding()?.state === 'running'"
                class="tcv-btn tcv-btn-accent shrink-0 px-2.5 py-0.5">
          {{ looking() ? '…' : isNumber(term()) || !term().trim() ? 'Add' : 'Search' }}
        </button>
      </div>

      @if (adding(); as ad) {
        <div class="tcv-add-progress shrink-0" [attr.data-state]="ad.state">
          @for (st of ad.steps; track $index; let last = $last) {
            <div class="tcv-add-step" [class.tcv-add-now]="last">
              <span class="tcv-add-mark">{{ last ? (ad.state === 'running' ? '…' : ad.state === 'error' ? '!' : '✓')
                                                 : ad.state === 'error' && $index === ad.steps.length - 2 ? '–' : '✓' }}</span>
              <span>{{ st.text }}</span>
            </div>
          }
          @if (ad.state !== 'running') {
            <button class="tcv-add-close" (click)="adding.set(null)" title="dismiss">&times;</button>
          }
        </div>
      }

      @if (partNote(); as n) {
        <p class="shrink-0 px-2 py-1 text-[11px]" style="color: var(--ink-dim)">{{ n }}</p>
      }

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
              <button (click)="keep(h.lcsc, $event)" [disabled]="adding()?.state === 'running'"
                      class="tcv-chip shrink-0"
                      title="fetch its footprint and 3D model">
                {{ adding()?.lcsc === h.lcsc && adding()?.state === 'running' ? '…' : 'Add' }}
              </button>
            }
          </div>
        }

        <!-- The drawer. Fetched once and kept: a part number means the
             same thing tomorrow, and a board rebuilt ten times should not
             ask somebody else's service ten times. A cabinet of drawers,
             one per group, each a tray of bins (rooms/parts-drawer.ts). -->
        @if (held().length) {
          <app-parts-drawer [held]="held()" [seenLcsc]="seen()?.lcsc ?? null"
                            [pulse]="pulse()" (inspect)="inspect($event)" (forget)="forget($event)" />
        }
      </div>

      <!-- ONE PART, IN FULL, as a card over the room: what it is, what it
           costs, which drawer it is in, its pins, its footprint, symbol
           and shape - straight from EasyEDA, kept on the server's disk so
           a second look is instant. Esc or a click beside it closes it. -->
      @if (seen() || seeing()) {
        <div (click)="closePart()" class="fixed inset-0 flex items-center justify-center p-4"
             style="background: var(--scrim); z-index: 1100">
          <div class="tcv-card tcv-part-modal flex max-h-[90vh] w-[min(60rem,96vw)] flex-col overflow-hidden p-0"
               (click)="$event.stopPropagation()" role="dialog" aria-modal="true"
               [attr.aria-label]="('Part' | t) + ' ' + (seen()?.lcsc ?? seeing())"
               style="box-shadow: 0 12px 36px var(--shadow-hard)">
            <div class="tcv-scroll min-h-0 flex-1 overflow-y-auto">
              @if (seen(); as s) {
                <app-part-card [part]="s" [pins]="seenPins()" [held]="heldRow(s.lcsc)" [places]="places()"
                               [adding]="adding()" [datasheet]="datasheetFor(s.lcsc)"
                               [canEdit]="canEdit()" [canRun]="canRun()"
                               (closed)="closePart()" (keep)="keep(s.lcsc)" (openDatasheet)="openDatasheet(s.lcsc)"
                               (place)="placeIt(s.lcsc, $event)" />
              } @else {
                <div class="flex items-center gap-2 px-4 py-3 text-[11px]" style="color: var(--ink-dim)">
                  <span class="mono" style="color: var(--ink)">{{ seeing() }}</span>
                  <span>{{ 'looking it up…' | t }}</span>
                  <button (click)="closePart()" class="tcv-chip ml-auto px-1.5 py-0" [title]="'close (Esc)' | t">&times;</button>
                </div>
              }
            </div>
          </div>
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
      } @else if (side() === 'health') {
        <!-- BOARD HEALTH (rooms/board-health.ts): ready to order or not,
             a traffic light per check, the board in a few figures. What
             the old Checks and Analytics tabs listed beyond that stays on
             the board document; the files are under Advanced details. -->
        <app-board-health class="min-h-0 flex-1" [board]="here()" [stats]="stats()"
                          [component]="comp()" [parts]="graph()?.components ?? null"
                          [building]="building()" [canRun]="canRun()" [canEditPoses]="canEdit()"
                          [canFocus]="!!here()?.route && !!geo()" [note]="note()"
                          (rerun)="build()" (focusNet)="focusNet($event)" (removePose)="removePose($event)">
          <app-board-bodies bodies [board]="here()?._id ?? null" [canEdit]="canEdit()" />
          <div advanced class="tcv-files" style="margin-bottom: 0">
            <a [attr.href]="hasPcb() ? file('board.kicad_pcb') : null" [class.off]="!hasPcb()"
               title="the layout, to open in KiCad">.kicad_pcb</a>
            @if (imported()) {
              <a [attr.href]="here()?.artifacts?.['layers_pdf'] ? '/api/boards/import/files/' + here()!._id + '/layers.pdf' : null"
                 [class.off]="!here()?.artifacts?.['layers_pdf']" target="_blank" rel="noreferrer"
                 title="every layer, a page each">.pdf</a>
            }
            <a [attr.href]="here()?.schematic ? file('board.kicad_sch') : null" [class.off]="!here()?.schematic"
               [title]="here()?.schematic?.sheets?.length ? 'the schematic for KiCad - every sheet, zipped' : 'the schematic, for KiCad'">.kicad_sch</a>
            <a [attr.href]="has3d() ? modelUrl() : null" [class.off]="!has3d()"
               title="the 3D model">.glb</a>
          </div>
        </app-board-health>
      }
      }
    </div>


    <!-- THE BOARD
         One view, three ways of looking at the same board - the copper,
         the schematic it came from, the thing in three dimensions - or
         all three at once in windows, each window showing whichever of
         them it is set to. -->
    <div view class="relative h-full w-full">
      @if (releasing() && here(); as b) {
        <app-releases [project]="projectOf(b)" (closed)="releasing.set(false)" />
      }
      @if (ide() && here(); as b) {
        <app-code-view kind="board" [id]="b._id" [title]="b.title || b._id" [line]="ideLine()" (closed)="ide.set(false)" />
      }
      @if (boardTab() === 'split') {
        <div #split class="tcv-split">
          @for (w of windows; track w.slot) {
            <section class="tcv-split-pane" [style.grid-area]="w.area">
              <header class="tcv-split-head">
                <select class="tcv-corner" (change)="setPane(w.slot, $any($event.target).value)"
                        [title]="'what this window shows'">
                  @for (k of boardTabs; track k) {
                    <option [value]="k" [selected]="panes()[w.slot] === k">{{ tabName[k] }}</option>
                  }
                </select>
              </header>
              <div class="relative min-h-0 flex-1">
                <ng-container *ngTemplateOutlet="board; context: { $implicit: panes()[w.slot], own: true }" />
              </div>
            </section>
          }
        </div>
      } @else if (boardTab() === 'focus') {
        <!-- FOCUS: one picture large, the other two small in the corner,
             like a video call's own view. A small one's header swaps it
             into the large place; the small ones stay live - the 3D can
             still be turned. -->
        <div #split class="tcv-focus">
          <div class="tcv-focus-main">
            <ng-container *ngTemplateOutlet="board; context: { $implicit: focusMain(), own: true }" />
          </div>
          <div class="tcv-focus-minis">
            @for (k of focusMinis(); track k) {
              <section class="tcv-focus-mini">
                <button class="tcv-focus-head" (click)="setFocus(k)"
                        [title]="'make ' + tabName[k] + ' the large one'">
                  {{ tabName[k] }} <span aria-hidden="true">⤢</span>
                </button>
                <div class="relative min-h-0 flex-1">
                  <ng-container *ngTemplateOutlet="board; context: { $implicit: k, own: false }" />
                </div>
              </section>
            }
          </div>
        </div>
      } @else {
        <ng-container *ngTemplateOutlet="board; context: { $implicit: boardTab(), own: false }" />
      }
      @if (frozen() && shot(); as s) {
        <app-sketchpad #pad [shot]="s" [pen]="pen" />
      }
      @if (showsLayout() && trouble().length && !frozen()) {
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

  <!-- One picture of the board, whichever it is asked for. In a window of
       the split view it keeps its own zoom buttons; alone, the toolbar has
       them. -->
  <ng-template #board let-kind let-own="own">
    @switch (kind) {
      @case ('layout') {
        <!-- TraceMaker routing it, drawn over the layout while it runs. -->
        <div class="relative h-full w-full">
          @if (hasLayout()) {
            <app-drawing #flat [src]="layoutUrl()" [controls]="own"
                         [geometry]="here()?.route ? geo() : null" [mirror]="view() === 'back'"
                         [side]="view() === 'back' ? 'B' : 'all'" />
          } @else {
            <p class="p-3 text-[12px]" style="color: var(--ink-dim)">{{ imported() ? importedNote : notYet }}</p>
          }
          <!-- Which router drew the copper on show, and when. -->
          @if (hasLayout() && here()?.route && !liveRouting() && !frozen()) {
            <div class="tcv-route-stamp" [title]="routeStampTip()">
              <b>{{ routeEngineName() }}</b>
              <span>{{ routeAgo() }}</span>
              <span class="mono">{{ here()!.route!.unrouted === 0 ? ('all connected' | t) : here()!.route!.unrouted + ' ' + ('open' | t) }} · {{ here()!.route!.vias }} via</span>
            </div>
          }
          <app-route-live [board]="here()?._id ?? null" (finished)="refresh()" (showing)="liveRouting.set($event)" />
        </div>
      }
      @case ('schematic') {
        @if (here()?.schematic; as sch) {
          @if (sch.sheets?.length) {
            <!-- Drawn in sheets: the root (the boxes), a sheet per MCU,
                 Power, the rest. A net on two sheets carries the same
                 global label on both. -->
            <div class="flex h-full w-full flex-col">
              <div class="tcv-sheets" role="tablist" aria-label="schematic sheets">
                <button class="tcv-sheet-tab" role="tab" [attr.data-on]="sheetOf(sch) === 'root' ? 1 : null"
                        [attr.aria-selected]="sheetOf(sch) === 'root'" (click)="pickSheet('root')"
                        title="the root sheet: a box for each sheet">Overview</button>
                @for (s of sch.sheets; track s.key) {
                  <button class="tcv-sheet-tab" role="tab" [attr.data-on]="sheetOf(sch) === s.key ? 1 : null"
                          [attr.aria-selected]="sheetOf(sch) === s.key" (click)="pickSheet(s.key)"
                          [title]="s.parts + ' parts' + (s.kind === 'mcu' ? ' - the MCU and the parts that serve only it' : '')"
                          [disabled]="!s.svg">{{ s.name }}<span class="tcv-sheet-count">{{ s.parts }}</span></button>
                }
                <!-- An MCU's sheet: its firmware, in the Firmware room. -->
                @if (sheetMcu(sch); as mcu) {
                  <button class="tcv-chip ml-auto shrink-0 self-center" (click)="firmwareFor(mcu)"
                          [disabled]="makingFw() || (!fwOfMcu(mcu) && !auth.can('edit'))"
                          [title]="fwOfMcu(mcu) ? 'Open the firmware of ' + mcu + ' in the Firmware room'
                                                : 'Make a firmware for ' + mcu + ' (PlatformIO, Arduino) from this sheet'">
                    {{ fwOfMcu(mcu) ? ('Open firmware' | t) : makingFw() ? '…' : ('Create firmware' | t) }}</button>
                }
              </div>
              <div class="relative min-h-0 flex-1">
                <app-drawing #flat [src]="sheetUrl(sch)" [controls]="own" />
              </div>
            </div>
          } @else {
            <app-drawing #flat [src]="file('schematic.svg', sch.at)" [controls]="own" />
          }
        } @else {
          <p class="p-3 text-[12px]" style="color: var(--ink-dim)">{{ imported() ? importedNote : notYet }}</p>
        }
      }
      @case ('3d') {
        @if (has3d()) {
          <!-- Fetched when it is first shown. three.js and a glTF loader
               are a third of a megabyte, and no use in any other room. -->
          <div class="relative h-full w-full overflow-hidden rounded" style="background: var(--surface-2)">
            @defer (on viewport) {
              <app-board-3d #model [src]="modelUrl()" />
            } @placeholder {
              <p class="p-3 text-[12px]" style="color: var(--ink-dim)">bringing the viewer in…</p>
            }
            <!-- The board is a component: this is the 3D a model imports
                 (backend/board3d.py) - no second document, no export step. -->
            @if (!frozen() && !own) {
              <div class="tcv-card absolute bottom-2 right-2 max-w-[22rem] p-0 text-[11px]"
                   style="box-shadow: 0 6px 20px var(--shadow-soft)">
                <div class="flex items-center gap-2 px-2 py-1"
                     [style.border-bottom]="compOpen() ? '1px solid var(--line)' : null">
                  <button class="tcv-pcb-fold" (click)="toggleComp()" [attr.aria-expanded]="compOpen()"
                          [title]="compOpen() ? 'Fold the 3D component card' : 'Show the 3D component card'">
                    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"
                         [style.transform]="compOpen() ? 'rotate(90deg)' : null">
                      <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6"
                            stroke-linecap="round" stroke-linejoin="round"/></svg>
                    <span class="tcv-label">3D component</span>
                  </button>
                  @if (here()?.component; as c) {
                    <span class="font-mono text-[10px]" style="color: var(--ink-dim)"
                          [title]="'made by the layout of ' + c.at.slice(0, 16).replace('T', ' ')">v{{ c.version }}</span>
                  }
                  <span class="tcv-files ml-auto" style="margin-bottom: 0">
                    <a [attr.href]="hasStep() ? file('board.step') : null" [class.off]="!hasStep()"
                       title="the board with its parts, as STEP - for any CAD tool">.step</a>
                    <a [attr.href]="has3d() ? modelUrl() : null" [class.off]="!has3d()" download
                       title="the board as KiCad renders it, glTF">.glb</a>
                    <a [attr.href]="hasStl() ? file('board.stl') : null" [class.off]="!hasStl()"
                       title="the board's triangles, in the same frame as the STEP">.stl</a>
                  </span>
                </div>
                @if (compOpen() && comp(); as c) {
                  <div class="px-2 py-1.5 leading-snug">
                    @if (c.line) {
                      <div class="flex items-center gap-1">
                        <code class="min-w-0 flex-1 truncate font-mono text-[10px]" [title]="c.line">{{ c.line }}</code>
                        <button class="tcv-chip px-1.5 py-0 text-[10px]" (click)="copyLine(c.line)"
                                title="the line a 3D model imports this board with">{{ copiedLine() ? 'copied' : 'copy' }}</button>
                      </div>
                    }
                    @if (c.data; as d) {
                      <div class="mt-1" style="color: var(--ink-dim)">
                        {{ d.size[0].toFixed(1) }} × {{ d.size[1].toFixed(1) }} × {{ d.thickness }} mm ·
                        {{ d.holes.length }} holes · {{ d.connectors.length }} connectors ·
                        {{ d.keepout.top.toFixed(1) }} mm up, {{ d.keepout.bottom.toFixed(1) }} down
                      </div>
                      @if (d.approximate.length) {
                        <div class="text-[10px]" style="color: var(--ink-dim)"
                             title="their only 3D model is a mesh, which STEP cannot hold">
                          a box stands in for {{ d.approximate.join(', ') }} in B.part (mesh-only model)
                        </div>
                      }
                    } @else {
                      <div style="color: var(--ink-dim)">the next layout makes its STEP and named data</div>
                    }
                    @if (c.error; as e) {
                      <div class="mt-1 truncate text-[10px]" style="color: var(--danger)"
                           [title]="e.error">last export failed: {{ e.error.trim().split('\n').pop() }}</div>
                    }
                    <div class="mt-1">
                      <span class="tcv-label mr-1">used in</span>
                      @for (u of c.used_by; track u.id; let last = $last) {
                        <span [title]="u.id + (u.pinned != null ? ' - pinned at v' + u.pinned : ' - follows the latest')"
                              >@if (u.pinned != null) {<app-pin-icon class="mr-0.5" />}{{ u.title }}{{ last ? '' : ', ' }}</span>
                      } @empty { <span style="color: var(--ink-dim)">nothing yet</span> }
                    </div>
                    <!-- Who uses it at a fixed version, and one button to bring them up to date. -->
                    @if (c.pinned_by?.length) {
                      <div class="mt-1">
                        <app-pinned-by kind="board" [id]="c.board" [rows]="c.pinned_by!" (changed)="readComponent()" />
                      </div>
                    }
                    <!-- Off: a layout that leaves the 3D as it was is no new version. -->
                    <label class="mt-1.5 flex items-center gap-1.5">
                      <span class="min-w-0 flex-1 truncate"
                            title="On: every layout or run makes a new version, even one that leaves the 3D as it was - so a model can pin the board as of that run. Off: only a changed 3D is a new version.">
                        Every run is a new version</span>
                      <button class="tcv-switch" [attr.data-on]="c.every_run ? 1 : null"
                              [attr.aria-pressed]="!!c.every_run" [disabled]="!canEdit()"
                              (click)="setEveryRun(!c.every_run)"
                              aria-label="Every run is a new version"></button>
                    </label>
                  </div>
                }
              </div>
            }
          </div>
        } @else {
          <p class="p-3 text-[12px]" style="color: var(--ink-dim)">{{ imported() ? importedNote : notYet }}</p>
        }
      }
    }
  </ng-template>
</div>`,
})
export class RoomPcb implements OnDestroy {
  private api = inject(Boards);
  private picked = inject(Selection);
  private prefs = inject(Prefs);
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
  /** The router the next build uses: the switch beside Build. */
  readonly engines = [{ id: 'freerouting', label: 'Freerouting' }, { id: 'tracemaker', label: 'TraceMaker' }] as const;
  engine = signal<string>('freerouting');
  savingEngine = signal(false);
  /** A run of this board is being routed, seen in the layout - also after a reload. */
  liveRouting = signal(false);
  /** When the copper on show was routed: the run's own stamp, else the drawing's. */
  private routeAt = computed(() => this.here()?.route?.at ?? this.here()?.artifacts?.['routed']?.at
                                    ?? this.here()?.layout?.at ?? null);
  /** A route stored before the engine was: TraceMaker's has no Freerouting passes. */
  routeEngineName = computed(() => {
    const r = this.here()?.route;
    const e = r?.engine ?? (r && r.passes == null ? 'tracemaker' : 'freerouting');
    return e === 'tracemaker' ? 'TraceMaker' : 'Freerouting';
  });
  routeAgo = computed(() => {
    this.clockTick();
    const at = this.routeAt();
    const ms = at ? Date.parse(at) : NaN;
    if (isNaN(ms)) return '';
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return t('just now');
    if (m < 60) return `${m} ${t('min ago')}`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} ${t('h ago')}`;
    return new Date(ms).toLocaleString(navigator.language || 'en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  });
  routeStampTip = computed(() => {
    const r = this.here()?.route, at = this.routeAt();
    if (!r) return '';
    const when = at ? new Date(at).toLocaleString(navigator.language || 'en-GB') : '';
    return [`${this.routeEngineName()} - ${when}`,
            `${r.tracks} ${t('tracks')}, ${r.vias} via, ${r.length_mm} mm, ${r.unrouted} ${t('open')}`,
            r.route_s ? `${Math.round(r.route_s)} s` : '', r.tracemaker?.summary ?? ''].filter(Boolean).join('\n');
  });
  private clockTick = signal(0);
  private clockTimer = setInterval(() => this.clockTick.update(n => n + 1), 30_000);
  private hereId = computed(() => this.here()?._id ?? null);
  graph = signal<BoardGraph | null>(null);
  /** The routed board as data: what the mouse can point at on the layout. */
  geo = signal<BoardGeometry | null>(null);
  note = signal('');

  /** The board window's tab, which pane is made large if any, and which
   *  side tab is showing - all kept across a reload like the other panels. */
  readonly boardTabs = ['layout', 'schematic', '3d'] as const;
  readonly tabName = { layout: 'Layout', schematic: 'Schematic', '3d': '3D' } as const;
  boardTab = signal<BoardView>(
    RoomPcb.pick(RoomPcb.recall('board', 'layout'),
                 ['layout', 'schematic', '3d', 'split', 'focus'], 'layout'));
  /** The focus view's large picture; the other two sit small in the corner. */
  focusMain = signal<Pane>(RoomPcb.pick(RoomPcb.recall('focus', 'schematic'),
                                        ['layout', 'schematic', '3d'], 'schematic'));
  /** The split view's windows: a tall one on the left, two stacked on the
   *  right. Which picture each shows is the person's, and kept. */
  readonly windows = [
    { slot: 'a', area: '1 / 1 / 5 / 4' },
    { slot: 'b', area: '1 / 4 / 3 / 7' },
    { slot: 'c', area: '3 / 4 / 5 / 7' },
  ] as const;
  panes = signal<Record<string, Pane>>(RoomPcb.recallPanes());
  private splitBox = viewChild<ElementRef<HTMLDivElement>>('split');
  private flats = viewChildren<Drawing>('flat');
  private models = viewChildren<{ snapshot(): string | null; host(): ElementRef<HTMLElement> }>('model');
  /** What an empty tab says. Nothing here makes a board: the agent runs
   *  the pipeline when a change is asked for. */
  readonly notYet = 'Nothing yet. Ask for the change - a board note, or the '
    + 'room\'s thread in Chat - and the agent runs the pipeline: build, '
    + 'schematic, place, route, DRC.';
  readonly sideTabs = ['parts', 'rules', 'health'] as const;
  /** Board health replaced the Checks and Analytics tabs; a browser that
   *  remembers one of those opens it. */
  readonly tabNames = computed(() => ({ parts: t('Parts'), rules: t('Rules'), health: t('Board health') }));
  side = signal<SideTab>(RoomPcb.pick(
    RoomPcb.recall('side', 'parts').replace(/^(checks|analytics)$/, 'health'), this.sideTabs, 'parts'));

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
  /** The board's figures (Board health), and whether the agent is at
   *  work in this room - the room turns to Board health when it starts. */
  stats = signal<BoardStats | null>(null);
  busy = signal(false);
  private statsAt = 0;
  /** The task Board health was last opened for, so it opens once per task. */
  private shownFor: string | null = null;
  /** The drawer of parts, and what a search in LCSC turned up. */
  held = signal<PartHeld[]>([]);
  hits = signal<PartHit[]>([]);
  term = signal('');
  looking = signal(false);
  partNote = signal('');
  /** The part open in the column, and the one being looked up. */
  seen = signal<PartPreview | null>(null);
  seeing = signal<string | null>(null);

  log = signal<LogLine[]>([]);
  private timers: ReturnType<typeof setInterval>[] = [];

  /** The code view: the board's source over the view (rooms/code-view.ts). */
  ide = signal(false);
  /** The releases of the board's project (rooms/releases.ts). */
  releasing = signal(false);
  /** The line the code view should open at (a search's), once. */
  ideLine = signal<number | null>(null);
  /** The last palette ask this room acted on - each is acted on once. */
  private handled = 0;
  projectOf(b: BoardEntry) { return ((b as BoardEntry & { folder?: string }).folder || b._id).split('/')[0]; }

  constructor() {
    // The engine of the board on show, read when another board is picked.
    effect(() => {
      const id = this.hereId();
      if (!id) return;
      untracked(() => this.api.rules(id).subscribe({
        next: r => { if (this.hereId() === id) this.engine.set(r.rules?.route?.engine ?? 'freerouting'); },
      }));
    });
    // What the command palette asks of this room.
    effect(() => {
      const w = this.picked.want();
      if (!w || w.n <= this.handled || untracked(() => this.picked.room()) !== 'pcb') return;
      untracked(() => {
        this.handled = w.n;
        if (['code', 'code-line', 'release', 'build', 'part'].includes(w.what)) this.picked.want.set(null);
        if (w.what === 'code') { if (!this.imported()) this.ide.set(!this.ide()); }
        else if (w.what === 'code-line' && w.arg) {
          const [id, line] = w.arg.split('#');
          if (this.here()?._id !== id) this.picked.openBoard(id);
          this.ideLine.set(+line || null);
          this.ide.set(false);
          setTimeout(() => this.ide.set(true), this.here()?._id === id ? 0 : 1200);
        } else if (w.what === 'release' && this.here()) this.releasing.set(true);
        else if (w.what === 'build' && this.here() && !this.building() && !this.imported()) this.build();
        else if (w.what === 'part' && w.arg) { this.side.set('parts'); this.term.set(w.arg); this.look(); }
      });
    });
    this.readUrl();
    // What is on screen, for the headless render to check before a shot.
    effect(() => {
      const b = this.here();
      (window as unknown as Record<string, unknown>)['redlineBoard'] = {
        board: b?._id ?? null, tab: this.boardTab(), model3d: b?.artifacts?.['model3d']?.at ?? null,
        want: this.urlBoard, error: this.boardError() || null,
      };
    });
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
    // The board as a component, read again when a layout makes a new version.
    effect(() => {
      const id = this.here()?._id, v = this.here()?.component?.version;
      untracked(() => {
        if (!id) { this.comp.set(null); return; }
        this.api.component(id).subscribe({
          next: c => { if (this.here()?._id === id) this.comp.set(c); },
          error: () => this.comp.set(null),
        });
      });
      void v;
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
    clearInterval(this.clockTimer);
    for (const id of this.timers) clearInterval(id);
    this.picked.boardDraft.set(null);
  }

  // ---- the pipeline ----

  building = signal(false);
  /** The import dialog (rooms/import-board.ts). */
  importing = signal(false);

  /** A board brought in from outside (SPEC §5): no atopile source, so
   *  nothing to build or edit - the room shows what came with it. */
  imported(): boolean {
    return (this.here() as (BoardEntry & { kind?: string }) | null)?.kind === 'imported';
  }
  readonly importedNote = 'Not in what was imported - the import dialog said which file would bring it.';

  /** Imported once, now a board with source (backend/convert.py). */
  converted(): boolean {
    return !this.imported() && !!(this.here() as BoardEntry | null)?.convert;
  }
  converting = signal(false);

  /** Write the imported board as atopile, build it, check it. The answer
   *  goes in the files note; the whole account is in the room's log. */
  convert(bom?: string) {
    const b = this.here();
    if (!b || this.converting()) return;
    this.converting.set(true);
    this.note.set('converting - LCSC lookups can take minutes on a first run');
    this.api.convert(b._id, bom).subscribe({
      next: c => {
        this.converting.set(false);
        const eq = c.equivalence;
        this.note.set(c.status === 'converted'
          ? `converted: ${eq?.parts.built} parts, ${eq?.nets.same} nets identical to the import`
            + ` · ${c.guessed.length} parts guessed` + (c.bom ? '' : ' (no BOM)')
          : c.status === 'needs parts'
            ? `${c.unresolved.length} parts need choosing: ${c.unresolved[0]}`
            : `${c.status} - see the log`);
        this.refresh();
      },
      error: e => {
        this.converting.set(false);
        this.note.set(String(e?.error?.detail ?? 'the conversion failed - see the log').slice(0, 160));
      },
    });
  }

  convertWithBom(input: HTMLInputElement) {
    const file = input.files?.[0];
    input.value = '';
    if (file) file.text().then(text => this.convert(text));
  }

  /** A KiCad board file to download: a built board's, or an imported design's. */
  hasPcb(): boolean {
    const a = this.here()?.artifacts ?? {};
    return this.hasLayout() && (!this.imported() || !!a['pcb'] || !!a['routed']);
  }

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
    if (t === 'split' || t === 'focus') {
      return this.flats().some(f => f.ready()) || this.models().length > 0;
    }
    return t === '3d' ? !!this.model() : !!this.flat()?.ready();
  }

  /** Hold the view still as a picture - exactly what is on screen, at the
   *  zoom and angle it is at - and put the pad over it. */
  async freeze() {
    const shot = this.boardTab() === 'split' || this.boardTab() === 'focus' ? await this.splitShot()
      : this.boardTab() === '3d' ? this.model()?.snapshot() : this.flat()?.snapshot();
    if (!shot) { this.note.set('nothing on screen to draw on yet'); return; }
    this.shot.set(shot);
    this.frozen.set(true);
    this.picked.boardDraft.set(() => this.pad()?.merged() ?? Promise.resolve(null));
  }

  /** The three windows as one picture: each window's own shot laid where
   *  the window is, on the room's surface. */
  private async splitShot(): Promise<string | null> {
    const box = this.splitBox()?.nativeElement;
    if (!box) return null;
    const at = box.getBoundingClientRect();
    const k = Math.min(devicePixelRatio, 2);
    const out = document.createElement('canvas');
    out.width = Math.round(at.width * k);
    out.height = Math.round(at.height * k);
    const ctx = out.getContext('2d')!;
    ctx.fillStyle = getComputedStyle(box).backgroundColor;
    ctx.fillRect(0, 0, out.width, out.height);
    const parts = [
      ...this.flats().map(f => ({ url: f.snapshot(), el: f.host() })),
      ...this.models().map(m => ({ url: m.snapshot(), el: m.host() })),
    ];
    for (const p of parts) {
      if (!p.url) continue;
      const r = p.el.nativeElement.getBoundingClientRect();
      const img = new Image();
      await new Promise(done => { img.onload = img.onerror = done; img.src = p.url!; });
      ctx.drawImage(img, (r.left - at.left) * k, (r.top - at.top) * k, r.width * k, r.height * k);
    }
    return out.toDataURL('image/png');
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
    this.seenPins.set(null);
    // A part in the drawer is on the server's disk: its drawings, model and
    // footprint frame are asked for now, beside the facts, not after them.
    const kept = this.heldRow(lcsc);
    if (kept) warmPart(lcsc, kept.has_3d);
    if (!this.places().length) {
      this.http.get<{ group: string; branches: string[] }[]>('/api/parts-places')
        .subscribe({ next: p => this.places.set(p) });
    }
    this.http.get<{ number: string; name: string }[]>(`/api/parts/${encodeURIComponent(lcsc)}/pins`).subscribe({
      next: p => { if (this.seeing() === lcsc) this.seenPins.set(p); },
      error: () => { if (this.seeing() === lcsc) this.seenPins.set([]); },
    });
    this.store.preview(lcsc).subscribe({
      next: p => { if (this.seeing() === lcsc) this.seen.set(p); },
      error: e => {
        if (this.seeing() !== lcsc) return;
        this.seeing.set(null);
        this.partNote.set(String(e?.error?.detail ?? `${lcsc} could not be looked up`));
      },
    });
  }

  // ---- the datasheet, on request (GET /api/parts/{C}/datasheet) ----

  /** One part's datasheet: being fetched, at hand, or why not. */
  datasheet = signal<{ lcsc: string; state: 'busy' | 'ready' | 'error'; text?: string } | null>(null);
  datasheetFor(lcsc: string) { const d = this.datasheet(); return d && d.lcsc === lcsc ? d : null; }
  datasheetUrl(lcsc: string): string { return `/api/parts/${encodeURIComponent(lcsc)}/datasheet`; }

  /** Fetched by the server the first time (two polite asks of LCSC), then
   *  opened in a tab from its kept copy. If the browser holds the tab back
   *  because the fetch took a while, the button has become a link. */
  openDatasheet(lcsc: string) {
    if (this.datasheetFor(lcsc)?.state === 'busy') return;
    this.datasheet.set({ lcsc, state: 'busy' });
    this.http.get(this.datasheetUrl(lcsc), { responseType: 'blob' }).subscribe({
      next: () => {
        this.datasheet.set({ lcsc, state: 'ready' });
        const w = window.open(this.datasheetUrl(lcsc), '_blank');
        if (w) w.opener = null;
      },
      error: async e => {
        let text = t('LCSC did not answer');
        try {
          const raw = e?.error instanceof Blob ? await e.error.text() : '';
          text = String(JSON.parse(raw)?.detail ?? text);
        } catch { /* not JSON: keep the plain line */ }
        // A 404 is LCSC having none: said in the page's language.
        if (e?.status === 404) text = t('LCSC has no datasheet for this part');
        this.datasheet.set({ lcsc, state: 'error', text });
      },
    });
  }

  closePart() {
    this.seen.set(null);
    this.seeing.set(null);
  }
  @HostListener('document:keydown.escape')
  escape() { if (this.seen() || this.seeing()) this.closePart(); }

  /** Keep one: its footprint, and its 3D model if it has one. That is
   *  what puts it within reach of a board. Watched step by step. */
  keep(lcsc: string, ev?: Event) {
    ev?.stopPropagation();
    this.addPart(lcsc);
  }

  // ---- adding a part, watched (POST /api/parts-add) ----

  adding = signal<PartAdd | null>(null);
  /** The bin to show and blink once its part is added or asked for again. */
  pulse = signal<string | null>(null);
  private http = inject(HttpClient);
  private addTimer?: ReturnType<typeof setTimeout>;

  isNumber(t: string): boolean { return /^\s*c\d{2,}\s*$/i.test(t); }

  /** A C-number is added; anything else is a search of LCSC. */
  addOrLook() {
    const t = this.term().trim();
    if (!t) { this.adding.set({ lcsc: '', state: 'error', steps: [{ step: 'error', text: 'type an LCSC number - C25744' }] }); return; }
    if (this.isNumber(t)) this.addPart(t.toUpperCase());
    else this.look();
  }

  addPart(lcsc: string) {
    if (this.adding()?.state === 'running') return;
    this.partNote.set('');
    this.adding.set({ lcsc, state: 'running', steps: [{ step: 'start', text: `${lcsc}: starting…` }] });
    this.http.post<PartAdd>('/api/parts-add', { lcsc }).subscribe({
      next: job => this.follow(job),
      error: e => this.adding.set({ lcsc, state: 'error',
        steps: [{ step: 'error', text: String(e?.error?.detail ?? 'the server did not answer') }] }),
    });
  }

  private follow(job: PartAdd) {
    this.adding.set(job);
    clearTimeout(this.addTimer);
    if (job.state === 'running') {
      this.addTimer = setTimeout(() => this.http.get<PartAdd>(`/api/parts-add/${job.id}`).subscribe({
        next: j => this.follow(j),
        error: () => this.adding.set({ ...job, state: 'error',
          steps: [...job.steps, { step: 'error', text: 'lost track of the add - look in the drawer' }] }),
      }), 600);
      return;
    }
    if (job.state !== 'done') return;
    this.hits.update(rows => rows.map(r => r.lcsc === job.lcsc ? { ...r, have: true } : r));
    this.term.set('');
    this.store.held().subscribe({ next: rows => {
      this.held.set(rows);
      this.pulse.set(job.lcsc);
      setTimeout(() => this.pulse() === job.lcsc && this.pulse.set(null), 2500);
    } });
    this.seen.set(null);
    this.seeing.set(null);
    this.inspect(job.lcsc);
  }

  // ---- the part card's drawer, and its pins ----

  places = signal<{ group: string; branches: string[] }[]>([]);
  seenPins = signal<{ number: string; name: string }[] | null>(null);
  heldRow(lcsc: string): PartHeld | undefined { return this.held().find(p => p.lcsc === lcsc); }
  placeIt(lcsc: string, value: string | null) {
    const [group, branch] = value ? [value.slice(0, value.indexOf('/')), value.slice(value.indexOf('/') + 1)] : [null, null];
    this.http.put(`/api/parts/${encodeURIComponent(lcsc)}/place`, { group, branch }).subscribe({
      next: () => this.drawer(),
      error: e => this.partNote.set(String(e?.error?.detail ?? 'could not move it')),
    });
  }

  forget(part: PartHeld, ev?: Event) {
    ev?.stopPropagation();
    this.store.drop(part.lcsc).subscribe({ next: () => this.drawer() });
  }

  /** A price in dollars, in the display currency (money.ts). */
  money(p: number | null): string { return p == null ? '–' : money(p); }

  countOf(n: number | null): string {
    if (!n) return 'none';
    return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
  }

  private static KEY = 'redline.pcb.';

  /** A remembered value, if it is still one of the choices - a tab that
   *  no longer exists is not a reason to show nothing. */
  private static pick<T extends string>(value: string, choices: readonly T[], fallback: T): T {
    return (choices as readonly string[]).includes(value) ? value as T : fallback;
  }

  private static recall(key: string, fallback: string): string {
    try { return localStorage.getItem(RoomPcb.KEY + key) ?? fallback; }
    catch { return fallback; }
  }

  /** The 3D component card over the board's 3D: open or folded, per browser. */
  compOpen = signal(RoomPcb.recall('component-card', 'open') !== 'folded');
  toggleComp() {
    this.compOpen.update(v => !v);
    RoomPcb.keep('component-card', this.compOpen() ? 'open' : 'folded');
  }

  private static keep(key: string, value: string) {
    try { localStorage.setItem(RoomPcb.KEY + key, value); } catch { /* private window */ }
  }

  /** The live half: what the machine is doing, and what has happened. */
  private tick() {
    this.activity.lines(60, 'pcb').subscribe({ next: rows => this.log.set(rows) });
    // This room's own run: while it goes, the agent's card is docked here.
    this.activity.run('pcb').subscribe({ next: r => {
      const was = this.busy();
      this.busy.set(r?.status === 'running');
      // Once per task - when it starts, or when the page is opened while it
      // runs - the room turns to Board health to show where the board stands.
      // Only once: a tab picked by hand after that is left alone.
      const task = r?.status === 'running' ? (r.revision ?? r.started_at) : null;
      if (task && task !== this.shownFor) {
        this.shownFor = task;
        if (this.side() !== 'health') this.setSide('health');
      }
      // A run that just ended changed the board: read the figures again.
      if (was && !this.busy() && this.here()) this.readStats(this.here()!._id);
    } });
    const b = this.here();
    if (b && this.side() === 'health' && Date.now() - this.statsAt > 15000) {
      this.readStats(b._id);
    }
  }

  private readStats(id: string) {
    this.statsAt = Date.now();
    this.api.analytics(id).subscribe({ next: st => this.stats.set(st) });
  }

  /** Board health's "Run checks again": the same whole run as Build. */
  canRun(): boolean {
    return this.auth.can('run') && !this.imported() && !this.frozen() && !!this.here();
  }

  /** A net named in Board health, lit on the layout. */
  focusNet(net: string) {
    if (!this.showsLayout()) this.setBoardTab('layout');
    setTimeout(() => this.flat()?.pinned.set(net), 60);
  }


  /** ?board=<id> (and ?tab=layout|schematic|3d|split|focus) opens that
   *  board in that view: how render.py takes a board note's after shot.
   *  Taken once per page - the address keeps them while the person goes
   *  on to other boards. A board named there that is not in the list is
   *  said, never swapped for the first one. */
  private static urlTaken = false;
  private urlBoard: string | null = null;
  boardError = signal('');

  private readUrl() {
    if (RoomPcb.urlTaken) return;
    RoomPcb.urlTaken = true;
    const q = new URLSearchParams(location.search);
    this.urlBoard = q.get('board');
    if (this.urlBoard) this.picked.board.set(this.urlBoard);
    const sheet = q.get('sheet');
    if (sheet) this.schSheet.set(sheet);
    const tab = q.get('tab');
    if (tab) this.boardTab.set(RoomPcb.pick(tab, ['layout', 'schematic', '3d', 'split', 'focus'],
                                            this.boardTab()));
  }

  refresh() {
    this.api.list().subscribe({
      next: rows => {
        this.boards.set(rows);
        const want = this.picked.board() ?? this.here()?._id;
        const keep = want ? rows.find(b => b._id === want) : null;
        if (want && !keep && want === this.urlBoard) {
          this.boardError.set(`${want}: no such board`);
          this.note.set(this.boardError());
          return;
        }
        this.open(keep ?? rows.find(b => b.ready) ?? rows[0] ?? null);
      },
      error: () => this.note.set('could not read the boards'),
    });
  }

  open(b: BoardEntry | null) {
    if (this.frozen()) this.resume();
    this.note.set('');
    this.here.set(b);
    // The board on screen is the board a note is about, whether it was
    // clicked in the catalog or opened by the room itself after a reload.
    if (b && this.picked.board() !== b._id) this.picked.board.set(b._id);
    this.graph.set(null);
    this.picked.boardParts.set([]);
    this.stats.set(null);
    this.geo.set(null);
    if (!b) return;
    if (b.artifacts?.['geometry']) {
      this.api.geometry(b._id, b.artifacts['geometry'].at).subscribe({
        next: g => { if (this.here()?._id === b._id) this.geo.set(g); },
      });
    }
    this.readStats(b._id);
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

  /** The drawing's own shape, so the sheet is the board and not a white
   *  block around it. The exporter writes the board area as the page. */
  sheet(): string {
    const mm = this.here()?.layout?.size_mm;
    return mm && mm[1] ? `${mm[0]} / ${mm[1]}` : '3 / 2';
  }

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

  /** The schematic's sheet on screen: 'root' or a sheet's key. Kept; a
   *  board without that sheet shows its root. */
  schSheet = signal<string>(RoomPcb.recall('sheet', 'root'));

  pickSheet(key: string) {
    this.schSheet.set(key);
    RoomPcb.keep('sheet', key);
  }

  sheetOf(sch: BoardSchematic): string {
    const want = this.schSheet();
    return sch.sheets?.some(s => s.key === want && s.svg) ? want : 'root';
  }

  /** The firmware made from this board's MCUs (rooms/firmware.ts). */
  boardFw = signal<{ id: string; mcu: string }[]>([]);
  makingFw = signal(false);
  private fwFor = effect(() => {
    const id = this.here()?._id;
    untracked(() => {
      this.boardFw.set([]);
      if (!id) return;
      this.http.get<{ id: string; mcu: string }[]>(`/api/boards/${encodeURIComponent(id)}/firmware`)
        .subscribe({ next: rows => { if (this.here()?._id === id) this.boardFw.set(rows); }, error: () => {} });
    });
  });

  /** The MCU whose sheet is on screen, if it is an MCU's. */
  sheetMcu(sch: BoardSchematic): string | null {
    const key = this.sheetOf(sch);
    return sch.sheets?.find(s => s.key === key && s.kind === 'mcu')?.mcu ?? null;
  }
  fwOfMcu(mcu: string): string | null { return this.boardFw().find(f => f.mcu === mcu)?.id ?? null; }

  /** Open the MCU's firmware, or make it first. */
  firmwareFor(mcu: string) {
    const have = this.fwOfMcu(mcu), board = this.here()?._id;
    if (have) { this.picked.openFirmware(have); return; }
    if (!board) return;
    this.makingFw.set(true);
    this.http.post<{ id: string; mcu: string }>(`/api/boards/${encodeURIComponent(board)}/firmware`, { mcu })
      .subscribe({
        next: f => { this.makingFw.set(false); this.boardFw.update(r => [...r, f]); this.picked.openFirmware(f.id); },
        error: e => { this.makingFw.set(false); this.note.set(e?.error?.detail ?? 'the firmware could not be made'); },
      });
  }

  sheetUrl(sch: BoardSchematic): string {
    const key = this.sheetOf(sch);
    return key === 'root' ? this.file('schematic.svg', sch.at) : this.file(`sheets/${key}.svg`, sch.at);
  }

  /** A drawing or a KiCad file of the open board. */
  file(name: string, stamp?: string | null): string {
    const url = this.api.file(this.here()?._id ?? '', name, stamp ?? undefined);
    // On a light theme the drawings come with inks that show on white.
    return name.endsWith('.svg') && isLightTheme(this.prefs.theme())
      ? url + (url.includes('?') ? '&' : '?') + 'light=1' : url;
  }

  // ---- which pane goes where ----

  /** Whether the layout is on screen - alone, or in one of the windows. */
  showsLayout(): boolean {
    const t = this.boardTab();
    return t === 'layout' || t === 'focus'
      || (t === 'split' && Object.values(this.panes()).includes('layout'));
  }

  /** The two pictures not large in the focus view, in their usual order. */
  focusMinis(): Pane[] {
    return this.boardTabs.filter(k => k !== this.focusMain());
  }

  setFocus(kind: Pane) {
    if (this.frozen()) this.resume();
    this.focusMain.set(kind);
    RoomPcb.keep('focus', kind);
  }

  setPane(slot: string, kind: Pane) {
    if (this.frozen()) this.resume();
    this.panes.update(p => ({ ...p, [slot]: kind }));
    RoomPcb.keep('panes', JSON.stringify(this.panes()));
  }

  private static recallPanes(): Record<string, Pane> {
    const fallback: Record<string, Pane> = { a: 'layout', b: '3d', c: 'schematic' };
    try {
      const got = JSON.parse(RoomPcb.recall('panes', '{}'));
      const ok = ['layout', 'schematic', '3d'];
      return Object.fromEntries(Object.keys(fallback).map(
        k => [k, ok.includes(got[k]) ? got[k] : fallback[k]])) as Record<string, Pane>;
    } catch { return fallback; }
  }

  setBoardTab(tab: BoardView) {
    if (this.frozen()) this.resume();
    this.boardTab.set(tab);
    RoomPcb.keep('board', tab);
  }

  setSide(tab: SideTab) {
    this.side.set(tab);
    RoomPcb.keep('side', tab);
    if (tab === 'rules' && !this.draft()) this.loadRules();
  }

  // ---- the rules ----

  setEngine(e: string) {
    const b = this.here();
    if (!b || e === this.engine()) return;
    const was = this.engine();
    this.engine.set(e); this.savingEngine.set(true);
    this.api.saveEngine(b._id, e).subscribe({
      next: () => {
        this.savingEngine.set(false);
        // The rules tab, if open, shows the same and is not left dirty by it.
        const d = this.draft();
        if (d) {
          const saved = JSON.parse(this.savedRules() || 'null');
          if (saved?.route) { saved.route.engine = e; this.savedRules.set(JSON.stringify(saved)); }
          this.draft.set({ ...d, route: { ...d.route, engine: e } });
        }
      },
      error: err => {
        this.savingEngine.set(false); this.engine.set(was);
        this.note.set(String(err?.error?.detail ?? 'the router was not changed').slice(0, 160));
      },
    });
  }

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

  /** Take a part's 3D pose off the board (Board health's ×). */
  removePose(ref: string) {
    const b = this.here();
    if (!b) return;
    this.api.removePose(b._id, ref).subscribe({
      next: () => this.refresh(),
      error: e => this.note.set(String(e?.error?.detail ?? e?.message ?? 'not removed')),
    });
  }

  has3d(): boolean {
    return !!this.here()?.artifacts?.['model3d'];
  }

  hasStep(): boolean { return !!this.here()?.artifacts?.['step']; }
  hasStl(): boolean { return !!this.here()?.artifacts?.['stl']; }

  /** The board as a component: its import line, named data, who uses it. */
  comp = signal<BoardComponent | null>(null);
  copiedLine = signal(false);

  auth = inject(Auth);
  canEdit = () => this.auth.can('edit');

  /** The component card, read again (a layout, a pin moved). */
  readComponent() {
    const id = this.here()?._id;
    if (!id) return;
    this.api.component(id).subscribe({
      next: c => { if (this.here()?._id === id) this.comp.set(c); },
      error: () => this.comp.set(null),
    });
  }

  /** "Every run is a new version", kept on the board. */
  setEveryRun(on: boolean) {
    const c = this.comp(), id = this.here()?._id;
    if (!c || !id) return;
    this.comp.set({ ...c, every_run: on });
    this.api.componentSettings(id, on).subscribe({
      error: () => this.comp.set({ ...c, every_run: !on }),
    });
  }

  copyLine(line: string) {
    navigator.clipboard?.writeText(line).then(() => {
      this.copiedLine.set(true);
      setTimeout(() => this.copiedLine.set(false), 1500);
    });
  }

  modelUrl(): string {
    const b = this.here();
    return `/api/boards/${b?._id}/board.glb?v=`
      + encodeURIComponent(b?.artifacts?.['model3d']?.at ?? '');
  }

}
