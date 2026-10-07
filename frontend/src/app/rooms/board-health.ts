import { Component, computed, input, output, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { BoardComponent, BoardEntry, BoardStats } from '../api';
import { T, t } from '../i18n';
import { BomCost } from './bom-cost';

/** The board room's "Board health" tab (Turkish "Kart durumu").
 *
 *  For somebody who is having a board made rather than designing one: is
 *  it ready to order, and if not, what is wrong and where. Everything is
 *  read from what the last run already wrote on the board - DRC, ERC, the
 *  route, the netlist check against an import, the 3D component - and
 *  turned into a handful of traffic-light cards. Findings that do not
 *  matter for ordering (silkscreen nits, library pin types, what came with
 *  the original design) are kept, but folded away at the bottom.
 */

type Tone = 'ok' | 'warn' | 'error' | 'none';

/** A ref or a net an issue is about; a net can be lit on the layout. */
interface Where { label: string; net?: boolean }

interface Issue {
  what: string;
  n: number;
  hint: string;
  where: Where[];
  /** In the accepted fold: from the original design, or cosmetic. */
  from?: 'original' | 'cosmetic';
}

interface Check {
  id: string;
  title: string;
  tone: Tone;
  status: string;
  line: string;
  issues: Issue[];
  /** Only the 3D view: never holds up an order. */
  cosmetic?: boolean;
}

/** What the board document carries beyond what api.ts types. */
type Board = BoardEntry & {
  kind?: string;
  rules?: { board?: { layers?: number } };
  layout?: BoardEntry['layout'] & { held?: boolean; held_worst_mm?: number;
                                    holes?: { ref?: string; part?: string }[] };
  route?: (NonNullable<BoardEntry['route']> & { edge_exempt?: string[] }) | null;
  drc?: (NonNullable<BoardEntry['drc']> & { edge_exempt?: string[] }) | null;
  convert?: (NonNullable<BoardEntry['convert']> & {
    equivalence?: { renamed?: string[];
                    differences?: { net?: string; built_net?: string; pads: string[] }[] };
  }) | null;
};

type Comp = BoardComponent & { data: (NonNullable<BoardComponent['data']> & {
  bodies?: { ref: string }[] }) | null };

/** KiCad's DRC types, in words: what it is, how to fix it, and the start
 *  of KiCad's own description so an example can be put with its type. */
const DRC: Record<string, { what: string; hint: string; desc?: string }> = {
  clearance: { what: 'Copper too close together', desc: 'Clearance',
               hint: 'Re-route, or move the tracks apart.' },
  shorting_items: { what: 'Two nets touch (a short)', desc: 'Items shorting',
                    hint: 'Re-route the tracks shown.' },
  tracks_crossing: { what: 'Tracks cross on one layer', desc: 'Tracks crossing',
                     hint: 'Re-route the tracks shown.' },
  courtyards_overlap: { what: 'Parts overlap', desc: 'Courtyards overlap',
                        hint: 'Move one of the parts apart.' },
  track_width: { what: 'Track too thin', desc: 'Track width',
                 hint: 'Widen it in Rules and run again.' },
  via_diameter: { what: 'Via too small', desc: 'Via diameter',
                  hint: 'Use a larger via in Rules.' },
  annular_width: { what: 'Ring around a hole too thin', desc: 'Annular width',
                   hint: 'Use a larger via or pad.' },
  starved_thermal: { what: 'Weak link to a copper pour', desc: 'Thermal relief',
                     hint: 'Add a via or a wider connection.' },
  solder_mask_bridge: { what: 'Mask gap between nets', desc: 'Front solder mask',
                        hint: 'Pads very close; check with the factory.' },
  copper_edge_clearance: { what: 'Copper too close to the edge', desc: 'Board edge clearance',
                           hint: 'Pull it in from the edge; the cutter may expose it.' },
  edge_clearance: { what: 'Copper too close to the edge', desc: 'Board edge clearance',
                    hint: 'Pull it in from the edge; the cutter may expose it.' },
  hole_clearance: { what: 'Copper too close to a hole', desc: 'Hole clearance',
                    hint: 'Move the track or via away from the hole.' },
  hole_to_hole: { what: 'Holes too close together', desc: 'Drilled holes too close',
                  hint: 'Space the holes out; the drill can break through.' },
  holes_co_located: { what: 'Two holes in one place', desc: 'Drilled holes co-located',
                      hint: 'Remove one of them.' },
  drill_out_of_range: { what: 'Hole the factory cannot drill', desc: 'Drill out of range',
                        hint: 'Change the hole size.' },
};
/** Edge and hole findings: their own card, when there are any. */
const EDGE = new Set(['copper_edge_clearance', 'edge_clearance', 'hole_clearance', 'hole_to_hole',
                      'holes_co_located', 'drill_out_of_range']);
/** Printing only: the factory makes the board the same. */
const SILK = /^(silk_|text_)/;
/** About KiCad's libraries, not the design. */
const LIBRARY = /^(lib_|footprint_|malformed_|missing_courtyard|padstack|npth_inside)/;

const ERC: Record<string, { what: string; hint: string }> = {
  pin_not_connected: { what: 'A pin is left open', hint: 'Wire it, or mark it not connected.' },
  pin_not_driven: { what: 'An input has no driver', hint: 'Connect it to a signal or a supply.' },
  power_pin_not_driven: { what: 'A power pin has no supply', hint: 'Connect it to a supply rail.' },
  pin_to_pin: { what: 'Pins that should not meet', hint: 'Check the two pins shown are meant to join.' },
  multiple_net_names: { what: 'One wire, two names', hint: 'Keep one name for the net.' },
  no_connect_connected: { what: '"Not connected" pin is wired', hint: 'Remove the wire or the mark.' },
  duplicate_reference: { what: 'Two parts share a name', hint: 'Rename one of them.' },
  label_dangling: { what: 'A label goes nowhere', hint: 'Attach it to a wire, or delete it.' },
  wire_dangling: { what: 'A wire goes nowhere', hint: 'Connect it, or delete it.' },
};
/** ERC warnings that are about library pin types, not the circuit. */
const ERC_NOISE = /^(pin_to_pin|pin_not_driven|power_pin_not_driven|lib_|footprint_link|simulation|endpoint_off_grid)/;

function human(kind: string): string {
  const s = kind.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Refs and nets named in one of KiCad's descriptions. */
function placesIn(text: string, nets = true): Where[] {
  const out: Where[] = [];
  const add = (w: Where) => { if (!out.some(o => o.label === w.label)) out.push(w); };
  for (const m of text.matchAll(/\b(?:Footprint|Symbol) (\S+)/g)) add({ label: m[1] });
  for (const m of text.matchAll(/ of (\S+)/g)) add({ label: m[1] });
  if (nets) {
    for (const m of text.matchAll(/\[([^\]<>]+)\]/g)) {
      if (!/^no net$/i.test(m[1])) add({ label: m[1], net: true });
    }
  }
  return out.slice(0, 8);
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${t(n === 1 ? one : many)}`;
}

@Component({
  selector: 'app-board-health',
  imports: [BomCost, NgTemplateOutlet, T],
  styleUrls: ['../settings.css'],
  styles: [`
    :host { display: flex; flex-direction: column; min-height: 0; }
    .bh { flex: 1; min-height: 0; overflow-y: auto; padding: 8px; display: flex; flex-direction: column;
          gap: 8px; font-size: 12px; color: var(--ink); }

    /* the verdict */
    .bh-verdict { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 4px 10px;
                  padding: 10px; background: var(--surface-2); border: 1px solid var(--line);
                  border-left: 4px solid var(--line); border-radius: 6px; }
    .bh-verdict[data-tone="ok"] { border-left-color: var(--ok); }
    .bh-verdict[data-tone="warn"] { border-left-color: var(--warn); }
    .bh-verdict[data-tone="error"] { border-left-color: var(--danger); }
    .bh-mark { grid-row: span 2; width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center;
               font-size: 16px; font-weight: 700; color: var(--ink-dim); background: var(--surface); }
    .bh-verdict[data-tone="ok"] .bh-mark { background: var(--ok); color: var(--ink-on-ok); }
    .bh-verdict[data-tone="warn"] .bh-mark { background: var(--warn); color: var(--ink-on-warn); }
    .bh-verdict[data-tone="error"] .bh-mark { background: var(--danger); color: var(--surface); }
    .bh-state { font-size: 16px; font-weight: 600; line-height: 1.2; color: var(--ink-bright); }
    .bh-verdict[data-tone="ok"] .bh-state { color: var(--ok); }
    .bh-verdict[data-tone="warn"] .bh-state { color: var(--warn); }
    .bh-verdict[data-tone="error"] .bh-state { color: var(--danger); }
    .bh-when { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; min-width: 0; font-size: 11px; color: var(--ink-dim); }
    .bh-when > span { min-width: 0; }
    .bh-run { margin-left: auto; flex: none; padding: 2px 8px; font-size: 11px; }
    .bh-note { padding: 5px 8px; font-size: 11px; color: var(--ink); background: var(--surface-2);
               border-left: 3px solid var(--warn); border-radius: 4px; overflow-wrap: anywhere; }

    /* the checks */
    .bh-list { display: flex; flex-direction: column; gap: 4px; }
    .bh-check { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
    .bh-head { width: 100%; display: grid; grid-template-columns: 10px minmax(0, 1fr) auto 10px; align-items: center;
               gap: 2px 8px; padding: 7px 9px; text-align: left; background: none; border: 0; color: inherit;
               cursor: pointer; font: inherit; }
    .bh-head:hover { background: var(--hover); border-radius: 6px; }
    .bh-head:disabled { cursor: default; }
    .bh-head:disabled:hover { background: none; }
    .bh-head:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; border-radius: 6px; }
    .bh-light { width: 10px; height: 10px; border-radius: 50%; background: var(--line); }
    [data-tone="ok"] > .bh-light, [data-tone="ok"] .bh-head > .bh-light { background: var(--ok); }
    [data-tone="warn"] .bh-head > .bh-light { background: var(--warn); }
    [data-tone="error"] .bh-head > .bh-light { background: var(--danger); }
    .bh-title { font-size: 12px; font-weight: 600; color: var(--ink); min-width: 0; overflow: hidden;
                text-overflow: ellipsis; white-space: nowrap; }
    .bh-status { font-size: 11px; font-family: 'IBM Plex Mono', ui-monospace, monospace; color: var(--ink-dim);
                 white-space: nowrap; }
    [data-tone="ok"] .bh-status { color: var(--ok); }
    [data-tone="warn"] .bh-status { color: var(--warn); }
    [data-tone="error"] .bh-status { color: var(--danger); }
    .bh-chev { font-size: 10px; color: var(--ink-dim); transition: transform .12s; }
    .bh-chev[data-open] { transform: rotate(90deg); }
    .bh-line { grid-column: 2 / 4; font-size: 11px; color: var(--ink-dim); line-height: 1.35; }

    .bh-issues { border-top: 1px solid var(--line); padding: 2px 0; }
    .bh-issue { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 8px; padding: 5px 9px 5px 27px; }
    .bh-issue + .bh-issue { border-top: 1px dashed var(--line); }
    .bh-what { font-size: 11.5px; color: var(--ink); min-width: 0; }
    .bh-n { font: 11px 'IBM Plex Mono', ui-monospace, monospace; color: var(--ink-dim); }
    .bh-where { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 3px; }
    .bh-ref { padding: 0 5px; font: 10.5px/16px 'IBM Plex Mono', ui-monospace, monospace; color: var(--ink);
              background: var(--surface-2); border: 1px solid transparent; border-radius: 3px; }
    button.bh-ref { cursor: pointer; color: var(--accent); border-color: var(--accent-deep); }
    button.bh-ref:hover { background: var(--hover); }
    .bh-hint { grid-column: 1 / -1; font-size: 11px; color: var(--ink-dim); }
    .bh-hint::before { content: '→ '; color: var(--accent); }
    .bh-group { padding: 6px 9px 0; font-size: 10px; letter-spacing: .05em; text-transform: uppercase;
                color: var(--ink-dim); border-top: 1px solid var(--line); }
    .bh-group + .bh-issues { border-top: 0; }

    /* folds */
    .bh-fold { border: 1px solid var(--line); border-radius: 6px; background: var(--surface); }
    .bh-fold > summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: 8px;
                         padding: 6px 9px; font-size: 11px; color: var(--ink-dim); }
    .bh-fold > summary::-webkit-details-marker { display: none; }
    .bh-fold > summary::after { content: '›'; margin-left: auto; font-size: 10px; transition: transform .12s; }
    .bh-fold[open] > summary::after { transform: rotate(90deg); }
    .bh-fold > summary:hover { color: var(--ink); }
    .bh-fold .bh-issue { padding-left: 9px; }
    .bh-count { padding: 0 6px; border-radius: 8px; font: 10.5px/16px 'IBM Plex Mono', ui-monospace, monospace;
                color: var(--ink); background: var(--surface-2); }

    /* facts */
    .bh-sec { font-size: 10.5px; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-dim);
              margin: 4px 2px -2px; }
    .bh-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; }
    .bh-facts .st-tile { padding: 5px 7px 6px; background: var(--surface-2); border-color: transparent; }
    .bh-facts .st-tile > span { font-size: 10.5px; }
    .bh-facts .st-tile > b { font-size: 12.5px; }
    .bh-facts .st-tile > b small { font-size: 10.5px; color: var(--ink-dim); font-weight: 400; }
    .bh-adv { padding: 4px 9px 8px; display: flex; flex-direction: column; gap: 6px; font-size: 11px; }
    .bh-empty { padding: 8px 2px; font-size: 11px; color: var(--ink-dim); }
  `],
  template: `
<div class="bh">
  <!-- THE VERDICT: one line, a big state, when it was checked. -->
  <section class="bh-verdict" [attr.data-tone]="verdict().tone">
    <span class="bh-mark" aria-hidden="true">{{ verdict().mark }}</span>
    <div class="bh-state">{{ verdict().text }}</div>
    <div class="bh-when">
      <span [title]="checkedAt() ?? ''">{{ building() ? ('Checking…' | t) : when() }}</span>
      @if (canRun()) {
        <button class="tcv-btn bh-run" (click)="rerun.emit()" [disabled]="building()"
                [title]="'Builds and checks the whole board again (a few minutes)' | t">
          {{ 'Run checks again' | t }}</button>
      }
    </div>
  </section>
  @if (note()) { <div class="bh-note">{{ note() }}</div> }

  <!-- THE CHECKS: a traffic light each; opened, what and where. -->
  @if (checks().length) {
    <div class="bh-list">
      @for (c of checks(); track c.id) {
        <section class="bh-check" [attr.data-tone]="c.tone">
          <button class="bh-head" (click)="toggle(c.id)" [disabled]="!c.issues.length"
                  [attr.aria-expanded]="c.issues.length ? isOpen(c.id) : null">
            <i class="bh-light" aria-hidden="true"></i>
            <span class="bh-title">{{ c.title | t }}</span>
            <span class="bh-status">{{ c.status }}</span>
            <span class="bh-chev" [attr.data-open]="isOpen(c.id) ? 1 : null" aria-hidden="true">
              {{ c.issues.length ? '›' : '' }}</span>
            <span class="bh-line">{{ c.line | t }}</span>
          </button>
          @if (isOpen(c.id) && c.issues.length) {
            <div class="bh-issues">
              @for (i of c.issues; track $index) {
                <ng-container *ngTemplateOutlet="issue; context: { $implicit: i }" />
              }
            </div>
          }
        </section>
      }
    </div>
  }

  <!-- ACCEPTED: kept, not lost - but not what decides an order. -->
  @if (accepted().length) {
    <details class="bh-fold">
      <summary>{{ 'Accepted' | t }} <span class="bh-count">{{ accepted().length }}</span></summary>
      @for (g of acceptedGroups(); track g.title) {
        <div class="bh-group">{{ g.title | t }}</div>
        <div class="bh-issues">
          @for (i of g.items; track $index) {
            <ng-container *ngTemplateOutlet="issue; context: { $implicit: i }" />
          }
        </div>
      }
    </details>
  }

  <!-- THE BOARD IN FIGURES -->
  @if (facts().length) {
    <div class="bh-sec">{{ 'The board' | t }}</div>
    <div class="bh-facts">
      @for (f of facts(); track f.label) {
        <div class="st-tile" [title]="f.title ?? ''">
          <span>{{ f.label | t }}</span>
          <b>{{ f.value }}@if (f.unit) { <small> {{ f.unit }}</small> }</b>
        </div>
      }
    </div>
  }

  <!-- COST: rooms/bom-cost.ts, what the parts come to. -->
  @if (board(); as bd) {
    <app-bom-cost [board]="bd._id" />
  }

  <!-- Everything else a non-expert does not need, in one fold. -->
  <details class="bh-fold">
    <summary>{{ 'Advanced details' | t }}</summary>
    <div class="bh-adv">
      <div class="bh-sec" style="margin: 0">{{ 'Files, for KiCad' | t }}</div>
      <ng-content select="[advanced]"></ng-content>
    </div>
  </details>
</div>

<ng-template #issue let-i>
  <div class="bh-issue">
    <span class="bh-what">{{ i.what | t }}</span>
    <span class="bh-n">{{ i.n > 1 ? '×' + i.n : '' }}</span>
    @if (i.where.length) {
      <span class="bh-where">
        @for (w of i.where; track w.label) {
          @if (w.net && canFocus()) {
            <button class="bh-ref" (click)="focusNet.emit(w.label)"
                    [title]="'Light this net up on the layout' | t">{{ w.label }}</button>
          } @else {
            <span class="bh-ref">{{ w.label }}</span>
          }
        }
      </span>
    }
    @if (i.hint) { <span class="bh-hint">{{ i.hint | t }}</span> }
  </div>
</ng-template>
`,
})
export class BoardHealth {
  board = input<BoardEntry | null>(null);
  stats = input<BoardStats | null>(null);
  component = input<BoardComponent | null>(null);
  /** The parts the build made, to say which have no 3D body. */
  parts = input<{ ref: string }[] | null>(null);
  building = input(false);
  /** Whether "Run checks again" is offered: a run endpoint and the right. */
  canRun = input(false);
  /** Whether a net can be lit on the layout (the board is routed). */
  canFocus = input(false);
  /** What the room last had to say: a failed run, a conversion. */
  note = input('');
  rerun = output<void>();
  focusNet = output<string>();

  private open = signal<Set<string>>(new Set());
  isOpen(id: string): boolean { return this.open().has(id); }
  toggle(id: string) {
    this.open.update(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  private b = computed(() => this.board() as Board | null);
  private built = computed(() => !!(this.b()?.drc || this.b()?.route));

  /** Every finding, sorted into the cards and the accepted fold. */
  private sorted = computed(() => {
    const b = this.b();
    const checks: Check[] = [];
    const accepted: Issue[] = [];
    if (!b) return { checks, accepted };
    const d = b.drc;
    const held = !!b.layout?.held;

    // -- Design rules: KiCad's DRC, less what has a card of its own.
    const examples = d?.examples ?? [];
    const exampleFor = (kind: string, only: boolean) => examples.filter(x =>
      only || (DRC[kind]?.desc && x.toLowerCase().startsWith(DRC[kind].desc!.toLowerCase())));
    const drcIssue = (kind: string, n: number, only: boolean): Issue => ({
      what: DRC[kind]?.what ?? human(kind), n,
      hint: DRC[kind]?.hint ?? 'Open the board in KiCad to see where.',
      where: exampleFor(kind, only).flatMap(x => placesIn(x.split(' - ').slice(1).join(' - ')))
        .filter((w, i, all) => all.findIndex(o => o.label === w.label) === i).slice(0, 10),
    });
    const errKinds = Object.keys(d?.errors ?? {});
    const drcErr: Issue[] = [], drcWarn: Issue[] = [], edge: Issue[] = [];
    for (const [kind, n] of Object.entries(d?.errors ?? {})) {
      const i = drcIssue(kind, n, errKinds.length === 1);
      if (EDGE.has(kind)) edge.push(i);
      else if (held && kind === 'courtyards_overlap') {
        accepted.push({ ...i, from: 'original', hint: 'Placed this way in the import.' });
      } else drcErr.push(i);
    }
    let silk = 0, library = 0;
    for (const [kind, n] of Object.entries(d?.warnings ?? {})) {
      if (SILK.test(kind)) silk += n;
      else if (LIBRARY.test(kind)) library += n;
      else if (EDGE.has(kind)) edge.push(drcIssue(kind, n, false));
      else drcWarn.push(drcIssue(kind, n, false));
    }
    if (silk) accepted.push({ what: 'Printed labels overlap', n: silk, where: [], from: 'cosmetic',
                              hint: 'Silkscreen only; works the same.' });
    if (library) accepted.push({ what: 'Library notes', n: library, where: [], from: 'cosmetic', hint: '' });
    const inside = Object.values(d?.in_footprints ?? {}).reduce((a, n) => a + n, 0);
    if (inside) accepted.push({ what: 'Inside a part\'s own footprint', n: inside, where: [],
                                from: 'cosmetic', hint: 'The maker\'s pad layout.' });
    if (d) {
      const e = drcErr.length, w = drcWarn.length;
      checks.push({
        id: 'drc', title: 'Design rules (DRC)', issues: [...drcErr, ...drcWarn],
        tone: e ? 'error' : w ? 'warn' : 'ok',
        status: e ? plural(drcErr.reduce((a, i) => a + i.n, 0), 'error', 'errors')
          : w ? plural(drcWarn.reduce((a, i) => a + i.n, 0), 'warning', 'warnings') : t('OK'),
        line: e ? 'Rules broken; the factory may reject it.'
          : w ? 'Small notes; usually fine to order.'
          : 'Spacing and sizes the factory can make.',
      });
    } else if (b.layout?.at || b.ready) {
      checks.push({ id: 'drc', title: 'Design rules (DRC)', tone: 'none', status: t('not run'),
                    line: 'Checked once the board is routed.', issues: [] });
    }

    // -- Connections: every net joined by copper.
    const r = b.route;
    if (r || d) {
      const open = Math.max(r?.unrouted ?? 0, d?.unconnected ?? 0);
      checks.push({
        id: 'route', title: 'Connections', tone: !r ? 'none' : open ? 'error' : 'ok',
        status: !r ? t('not routed') : open ? `${open} ${t('open')}` : t('all joined'),
        line: !r ? 'Not routed yet.' : open ? 'Some links have no copper; it won\'t work.'
          : 'Every connection is joined by copper.',
        issues: (d?.unconnected_examples ?? []).map(u => ({
          what: 'Not connected', n: 1, hint: 'Run again, or route this one by hand.',
          where: placesIn(u),
        })),
      });
    }

    // -- Schematic (ERC), when the board has one.
    const erc = b.schematic?.erc;
    if (erc) {
      const errs = Object.entries(erc.errors ?? {}).map(([kind, n]) => ({
        what: ERC[kind]?.what ?? human(kind), n, hint: ERC[kind]?.hint ?? 'See the schematic.',
        where: Object.keys(erc.errors).length === 1
          ? (erc.examples ?? []).flatMap(x => placesIn(x, false)).slice(0, 10) : [],
      }));
      const warns: Issue[] = [];
      let noise = 0;
      for (const [kind, n] of Object.entries(erc.warnings ?? {})) {
        if (ERC_NOISE.test(kind)) noise += n;
        else warns.push({ what: ERC[kind]?.what ?? human(kind), n, where: [],
                          hint: ERC[kind]?.hint ?? 'See the schematic.' });
      }
      noise += Object.values(erc.setup ?? {}).reduce((a, n) => a + n, 0);
      if (noise) accepted.push({ what: 'Schematic library notes', n: noise, where: [], from: 'cosmetic',
                                 hint: 'Untyped library pins.' });
      const e = errs.reduce((a, i) => a + i.n, 0), w = warns.reduce((a, i) => a + i.n, 0);
      checks.push({
        id: 'erc', title: 'Schematic (ERC)', issues: [...errs, ...warns],
        tone: e ? 'error' : w ? 'warn' : 'ok',
        status: e ? plural(e, 'error', 'errors') : w ? plural(w, 'warning', 'warnings') : t('OK'),
        line: e ? 'The circuit has wiring mistakes.'
          : w ? 'A few wiring notes worth a look.' : 'No wiring mistakes in the circuit.',
      });
    }

    // -- Matches the original: an imported board, written as source.
    const cv = b.convert;
    const eq = cv?.equivalence;
    if (cv && (eq || cv.unresolved?.length)) {
      const issues: Issue[] = [];
      if (cv.unresolved?.length) {
        issues.push({ what: 'Parts still to choose', n: cv.unresolved.length,
                      where: cv.unresolved.slice(0, 10).map(x => ({ label: x.split(/[\s:]/)[0] })),
                      hint: 'Pick them in Parts, or add a BOM.' });
      }
      if (eq?.parts.missing.length) {
        issues.push({ what: 'Parts missing from the build', n: eq.parts.missing.length,
                      where: eq.parts.missing.slice(0, 10).map(x => ({ label: x })), hint: 'Convert again.' });
      }
      if (eq?.parts.extra.length) {
        issues.push({ what: 'Parts not in the original', n: eq.parts.extra.length,
                      where: eq.parts.extra.slice(0, 10).map(x => ({ label: x })), hint: 'Remove them, or convert again.' });
      }
      for (const df of (eq?.differences ?? []).slice(0, 6)) {
        const net = df.net ?? df.built_net ?? '';
        issues.push({ what: df.net ? 'Net joined differently' : 'Net not in the original', n: 1,
                      where: [{ label: net, net: true }, ...df.pads.slice(0, 4).map(p => ({ label: p }))],
                      hint: 'Check the source against the import.' });
      }
      for (const f of cv.findings ?? []) {
        const net = /net (\S+)/.exec(f)?.[1];
        accepted.push({ what: 'Unusual net, kept as imported', n: 1, from: 'original',
                        where: net ? [{ label: net, net: true }] : [], hint: '' });
      }
      const bad = !eq?.equivalent || !!cv.unresolved?.length;
      checks.push({
        id: 'same', title: 'Matches the original', issues,
        tone: bad ? 'error' : 'ok',
        status: bad ? t('differs') : `${eq!.nets.same}/${eq!.nets.imported} ${t('nets')}`,
        line: bad ? 'Not the same circuit as the import.'
          : held ? 'Same circuit and layout as the import.'
          : 'Same circuit as the import.',
      });
    }

    // -- Edge and holes: only when there is something to say.
    const exempt = r?.edge_exempt ?? d?.edge_exempt ?? [];
    if (exempt.length) {
      accepted.push({ what: 'Parts over the board edge', n: exempt.length, from: 'original',
                      where: exempt.map(x => ({ label: x })), hint: 'Meant to stick out.' });
    }
    if (edge.length) {
      const n = edge.reduce((a, i) => a + i.n, 0);
      checks.push({ id: 'edge', title: 'Edge and holes', issues: edge, tone: 'error',
                    status: plural(n, 'error', 'errors'),
                    line: 'Copper or holes too close together.' });
    }

    // -- Parts with 3D: only the 3D view.
    const bodies = (this.component() as Comp | null)?.data?.bodies;
    const parts = this.parts();
    if (bodies && parts?.length) {
      const have = new Set(bodies.map(x => x.ref));
      const missing = parts.map(p => p.ref).filter(ref => !have.has(ref));
      checks.push({
        id: '3d', title: 'Parts with 3D', cosmetic: true, tone: missing.length ? 'warn' : 'ok',
        status: `${parts.length - missing.length}/${parts.length}`,
        line: missing.length ? 'A few parts have no 3D shape.'
          : 'Every part shows in 3D.',
        issues: missing.length ? [{ what: 'No 3D model', n: missing.length,
                                    where: missing.slice(0, 12).map(x => ({ label: x })),
                                    hint: 'Only the 3D view; not for ordering.' }] : [],
      });
    }
    return { checks, accepted };
  });

  checks = computed(() => this.sorted().checks);
  accepted = computed(() => this.sorted().accepted);
  acceptedGroups = computed(() => [
    { title: 'From the original design', items: this.accepted().filter(i => i.from === 'original') },
    { title: 'Cosmetic, not the design', items: this.accepted().filter(i => i.from !== 'original') },
  ].filter(g => g.items.length));

  verdict = computed(() => {
    if (!this.b() || !this.built()) {
      return { tone: 'none' as Tone, mark: '·', text: t('Not built yet') };
    }
    const bad = this.checks().filter(c => !c.cosmetic && (c.tone === 'error' || c.tone === 'warn'));
    if (!bad.length) return { tone: 'ok' as Tone, mark: '✓', text: t('Ready to order') };
    const error = bad.some(c => c.tone === 'error');
    return { tone: (error ? 'error' : 'warn') as Tone, mark: '!',
             text: `${t('Needs attention')} (${bad.length})` };
  });

  checkedAt = computed(() => this.b()?.drc?.at ?? this.b()?.layout?.at ?? null);

  when = computed(() => {
    const at = this.checkedAt();
    if (!at) return t('No checks run yet');
    const s = Math.max(0, (Date.now() - Date.parse(at)) / 1000);
    const ago = s < 90 ? t('just now')
      : s < 5400 ? `${Math.round(s / 60)} ${t('min ago')}`
      : s < 129600 ? `${Math.round(s / 3600)} ${t('h ago')}`
      : `${Math.round(s / 86400)} ${t('days ago')}`;
    return `${t('Checked')} ${ago}`;
  });

  facts = computed(() => {
    const b = this.b(), st = this.stats();
    if (!b) return [];
    const out: { label: string; value: string; unit?: string; title?: string }[] = [];
    const mm = st?.size.mm ?? b.layout?.size_mm;
    if (mm) out.push({ label: 'Size, mm', value: `${mm[0].toFixed(1)}×${mm[1].toFixed(1)}`,
                      title: `${mm[0]} × ${mm[1]} mm` });
    const layers = b.rules?.board?.layers;
    if (layers) out.push({ label: 'Layers', value: String(layers) });
    const parts = st?.parts.components ?? b.layout?.placed;
    if (parts != null) out.push({ label: 'Parts', value: String(parts) });
    if (st?.parts.nets != null) out.push({ label: 'Nets', value: String(st.parts.nets) });
    const r = b.route;
    if (r) {
      out.push({ label: 'Vias', value: String(r.vias) });
      out.push(r.length_mm >= 1000
        ? { label: 'Tracks', value: (r.length_mm / 1000).toFixed(2), unit: 'm', title: `${r.length_mm} mm` }
        : { label: 'Tracks', value: r.length_mm.toFixed(0), unit: 'mm' });
    }
    return out;
  });
}
