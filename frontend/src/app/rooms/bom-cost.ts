import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { CURRENCY, fromUsd, money } from '../money';

/** One part line of the board's bill (backend/bom_cost.py). Dollars. */
export interface BomAlt {
  lcsc: string; mpn?: string | null; package?: string | null; stock?: number | null;
  unit_usd?: number | null; why?: string;
}
export type StockState = 'ok' | 'low' | 'short' | 'out' | 'unsure' | 'unknown' | 'no_part';
export interface BomLine {
  lcsc: string | null; refs: string[]; qty: number; value: string | null; mpn: string | null;
  package: string | null; maker: string | null; jlc_class: string | null;
  stock: number | null; stock_record: number | null; state: StockState; need: number;
  unit_usd: number | null; break_qty: number | null; line_usd: number | null;
  source: 'search' | 'component' | null; checked_at: string | null; stale: boolean;
  flags: string[]; alternatives: BomAlt[]; alternatives_at: string | null;
}
export interface BomRefresh {
  running: boolean; done: number; total: number; asked: number; failed: string[];
  error: string | null; current: string | null; started: string; finished: string | null;
}
export interface BomCostData {
  board: string; qty: number; lines: BomLine[]; parts: number; distinct: number; priced: number;
  unpriced: string[][]; per_board_usd: number; total_usd: number; min_order_usd: number;
  quantities: { qty: number; per_board_usd: number; total_usd: number; min_order_usd: number }[];
  extended: number; extended_fee_usd: number; extended_fee_note: string;
  stock: Record<'out' | 'short' | 'low' | 'unsure' | 'unknown' | 'no_part' | 'ok', number>;
  stale: number; oldest_at: string | null; refresh: BomRefresh | null;
  budget: { used: number; budget: number; window_s: number; refused_until: number | null };
}

const PRESETS = [1, 10, 100, 1000];
const STATE_WORD: Record<StockState, string> = {
  ok: 'in stock', low: 'running low', short: 'not enough', out: 'out of stock',
  unsure: 'maybe out', unknown: 'not checked', no_part: 'no LCSC number',
};
const STATE_TONE: Record<StockState, string> = {
  ok: 'ok', low: 'warn', short: 'danger', out: 'danger', unsure: 'warn', unknown: 'dim', no_part: 'dim',
};

/** What the board's parts cost and whether they can be bought.
 *
 *  Self-contained: give it a board id. The figures come from
 *  GET /api/boards/{id}/bom/cost, which reads what is on disk; "Refresh
 *  prices" asks LCSC for the parts whose prices are missing or a day old,
 *  one polite ask at a time, and this polls until it is done. Amounts are
 *  dollars from the server, shown in the reader's currency (money.ts).
 *  Alternatives are suggestions only - nothing on the board changes. */
@Component({
  selector: 'app-bom-cost',
  template: `
<div class="bc">
  <div class="bc-head">
    <span class="bc-title">Parts cost</span>
    <span class="bc-qty" title="How many boards">
      @for (q of presets; track q) {
        <button class="tcv-chip" [attr.data-on]="qty() === q && !customOn() ? 1 : null" (click)="setQty(q)">{{ q }}</button>
      }
      <input class="bc-custom mono" type="number" min="1" max="1000000" placeholder="other"
             [value]="customOn() ? qty() : ''" (change)="custom($any($event.target).value)"
             title="Any number of boards" />
    </span>
  </div>

  @if (error(); as e) { <div class="bc-note" data-tone="danger">{{ e }}</div> }

  @if (data(); as d) {
    <div class="bc-tiles">
      <div class="bc-tile hero" [title]="'Parts only, at LCSC prices for ' + d.qty + ' boards'">
        <span>per board</span><b>{{ money(d.per_board_usd) }}</b>
      </div>
      <div class="bc-tile" [title]="'Buying the minimum LCSC sells: ' + money(d.min_order_usd)">
        <span>{{ d.qty }} {{ d.qty === 1 ? 'board' : 'boards' }}</span><b>{{ money(d.total_usd) }}</b>
      </div>
      <div class="bc-tile" [attr.data-tone]="d.priced < d.distinct ? 'warn' : 'ok'"
           title="Distinct parts with a price">
        <span>priced</span><b>{{ d.priced }}/{{ d.distinct }}</b>
      </div>
      <div class="bc-tile" [attr.data-tone]="d.stock.out + d.stock.short ? 'danger' : d.stock.low + d.stock.unsure ? 'warn' : 'ok'"
           title="Out of stock or not enough for this many boards · maybe out or running low">
        <span>stock</span>
        <b>{{ d.stock.out + d.stock.short }} <small>out</small></b>
        <small>{{ d.stock.unsure + d.stock.low }} to check</small>
      </div>
    </div>

    <!-- The one list that matters: what cannot be bought for this many boards. -->
    @for (w of warnings(); track w.key) {
      <div class="bc-warn" [attr.data-tone]="w.tone">
        <span>{{ w.text }}</span>
        @if (w.alts) { <button class="bc-link" (click)="showProblems()">see alternatives</button> }
      </div>
    }
    @if (d.priced < d.distinct) {
      <div class="bc-note">{{ d.distinct - d.priced }} {{ d.distinct - d.priced === 1 ? 'part has' : 'parts have' }}
        no price yet - not counted.</div>
    }
    @if (d.extended) {
      <div class="bc-note" [title]="d.extended_fee_note">
        Assembly at JLCPCB: about {{ money(d.extended_fee_usd) }} extra per order for {{ d.extended }} non-basic parts.
      </div>
    }

    <div class="bc-bar">
      <button class="tcv-chip" (click)="refresh()" [disabled]="running()"
              title="Ask LCSC for prices and stock that are missing or more than a day old">
        {{ running() ? 'Refreshing…' : 'Refresh prices' }}
      </button>
      @if (d.refresh; as r) {
        @if (r.running) {
          <span class="bc-prog"><span [style.width.%]="r.total ? 100 * r.done / r.total : 0"></span></span>
          <span class="bc-dim mono">{{ r.done }}/{{ r.total }}</span>
        } @else if (r.error) {
          <span class="bc-dim" [title]="r.error" style="color: var(--warn)">paused - LCSC asked us to wait</span>
        } @else if (r.total === 0) {
          <span class="bc-dim">already up to date</span>
        } @else {
          <span class="bc-dim">updated {{ r.asked }} parts</span>
        }
      } @else {
        <span class="bc-dim">{{ ageWords() }}</span>
      }
      <span class="bc-grow"></span>
      <button class="bc-link" (click)="details.set(!details())">{{ details() ? 'hide details' : 'show details' }}</button>
    </div>

    @if (details()) {
      <div class="bc-bar">
        <button class="tcv-chip" [attr.data-on]="onlyProblems() ? 1 : null" (click)="onlyProblems.set(!onlyProblems())">
          only problems
        </button>
        <span class="bc-grow"></span>
        <button class="bc-link" (click)="csv()">export CSV</button>
      </div>
      <div class="bc-table-wrap">
        <table class="bc-table">
          <thead><tr>
            <th>parts</th><th>LCSC</th><th>value / MPN</th><th class="r">qty</th>
            <th class="r">unit</th><th class="r">line</th><th>stock</th><th>alternatives</th>
          </tr></thead>
          <tbody>
            @for (l of shown(); track l.refs[0]) {
              <tr>
                <td class="mono" [title]="l.refs.join(', ')">{{ refsShort(l.refs) }}</td>
                <td class="mono">
                  @if (l.lcsc) { {{ l.lcsc }} } @else { <span style="color: var(--danger)">none</span> }
                  @if (isExtended(l)) { <span class="bc-tag" title="JLCPCB Extended part">ext</span> }
                </td>
                <td [title]="(l.mpn || '') + (l.package ? ' · ' + l.package : '')">
                  <div class="bc-cell">{{ l.value || l.mpn || '–' }}</div>
                  @if (l.mpn && l.mpn !== l.value) { <div class="bc-cell bc-dim">{{ l.mpn }}</div> }
                </td>
                <td class="r mono">{{ l.qty }}</td>
                <td class="r mono" [title]="l.break_qty ? 'price for ' + l.break_qty + '+ pieces' : (l.flags.join(', ') || '')">
                  {{ l.unit_usd == null ? '–' : money(l.unit_usd) }}
                </td>
                <td class="r mono">{{ l.line_usd == null ? '–' : money(l.line_usd) }}</td>
                <td>
                  <span class="bc-chip" [attr.data-tone]="tone(l.state)"
                        [title]="'need ' + l.need + (l.stock_record != null && l.state === 'unsure' ? ' · the part record says ' + l.stock_record + ' in stock' : '') + (l.checked_at ? ' · checked ' + l.checked_at.slice(0, 16).replace('T', ' ') : '')">
                    {{ stockWord(l) }}
                  </span>
                </td>
                <td>
                  @for (a of l.alternatives; track a.lcsc) {
                    <div class="bc-cell mono" [title]="(a.mpn || '') + ' · ' + (a.why || '')">
                      {{ a.lcsc }} <span class="bc-dim">{{ count(a.stock) }}</span>
                    </div>
                  }
                  @if (problem(l) && l.lcsc && !l.alternatives_at) {
                    <button class="bc-link" [disabled]="finding() === l.lcsc" (click)="findAlts(l)">
                      {{ finding() === l.lcsc ? 'looking…' : 'find' }}
                    </button>
                  } @else if (problem(l) && !l.alternatives.length) {
                    <span class="bc-dim">none found</span>
                  }
                </td>
              </tr>
            } @empty {
              <tr><td colspan="8" class="bc-dim">no problems at {{ d.qty }} boards</td></tr>
            }
          </tbody>
        </table>
      </div>
    }
  } @else if (!error()) {
    <div class="bc-note">reading the parts…</div>
  }
</div>`,
  styles: [`
:host { display: block; min-width: 0; font-size: 11px; color: var(--ink); }
.bc { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.bc-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.bc-title { font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; }
.bc-qty { display: inline-flex; gap: 3px; align-items: center; margin-left: auto; flex-wrap: wrap; }
.bc-qty .tcv-chip { padding: 0 6px; }
.bc .tcv-chip[data-on] { background: var(--accent-deep); border-color: var(--accent); color: var(--ink-bright); }
.bc-custom { width: 58px; height: 20px; padding: 0 4px; font-size: 11px; color: var(--ink);
  background: var(--surface-2); border: 1px solid var(--line); border-radius: 4px; }
.bc-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(84px, 1fr)); gap: 5px; }
.bc-tile { min-width: 0; padding: 5px 8px 6px; background: var(--surface-2); border: 1px solid transparent; border-radius: 5px; }
.bc-tile > span { display: block; font-size: 10.5px; color: var(--ink-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bc-tile > b { display: block; font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 15px; font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bc-tile > b small { font-size: 10.5px; font-weight: 400; color: var(--ink-dim); }
.bc-tile > small { display: block; font-size: 10px; color: var(--ink-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bc-tile.hero { border-color: var(--accent-deep); }
.bc-tile.hero > b { font-size: 18px; }
.bc-tile[data-tone="ok"] > b { color: var(--ok); }
.bc-tile[data-tone="warn"] > b { color: var(--warn); }
.bc-tile[data-tone="danger"] > b { color: var(--danger); }
.bc-warn { display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap; padding: 4px 8px; border-radius: 5px;
  border: 1px solid var(--line); border-left: 3px solid var(--warn); background: var(--surface-2); }
.bc-warn[data-tone="danger"] { border-left-color: var(--danger); }
.bc-note { color: var(--ink-dim); font-size: 10.5px; }
.bc-note[data-tone="danger"] { color: var(--danger); }
.bc-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.bc-grow { flex: 1; }
.bc-dim { color: var(--ink-dim); }
.bc-link { background: none; border: 0; padding: 0; color: var(--accent); cursor: pointer; font-size: 11px; }
.bc-link:hover { text-decoration: underline; }
.bc-link:disabled { color: var(--ink-dim); cursor: default; text-decoration: none; }
.bc-prog { width: 80px; height: 4px; background: var(--surface-2); border-radius: 2px; overflow: hidden; }
.bc-prog > span { display: block; height: 100%; background: var(--accent); }
.bc-table-wrap { overflow-x: auto; max-height: 420px; overflow-y: auto; border: 1px solid var(--line); border-radius: 5px; }
.bc-table { width: 100%; border-collapse: collapse; font-size: 10.5px; }
.bc-table th { position: sticky; top: 0; background: var(--surface); color: var(--ink-dim); font-weight: 400;
  text-align: left; padding: 3px 5px; border-bottom: 1px solid var(--line); white-space: nowrap; }
.bc-table td { padding: 3px 5px; border-bottom: 1px solid var(--line); vertical-align: top; }
.bc-table .r { text-align: right; }
.bc-cell { max-width: 140px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bc-chip { display: inline-block; padding: 0 5px; border-radius: 8px; font-size: 10px; white-space: nowrap;
  border: 1px solid var(--line); color: var(--ink-dim); }
.bc-chip[data-tone="ok"] { color: var(--ok); border-color: var(--ok); }
.bc-chip[data-tone="warn"] { color: var(--warn); border-color: var(--warn); }
.bc-chip[data-tone="danger"] { color: var(--danger); border-color: var(--danger); }
.bc-tag { font-size: 9px; color: var(--ink-dim); border: 1px solid var(--line); border-radius: 3px; padding: 0 2px; margin-left: 2px; }
`],
})
export class BomCost {
  private http = inject(HttpClient);
  /** The board's id. */
  board = input.required<string>();

  readonly presets = PRESETS;
  readonly money = money;
  qty = signal(10);
  customOn = signal(false);
  data = signal<BomCostData | null>(null);
  error = signal<string | null>(null);
  details = signal(false);
  onlyProblems = signal(false);
  finding = signal<string | null>(null);
  running = computed(() => !!this.data()?.refresh?.running);
  private timer?: ReturnType<typeof setTimeout>;
  private wasRunning = false;

  shown = computed(() => {
    const ls = this.data()?.lines ?? [];
    return this.onlyProblems() ? ls.filter(l => this.problem(l)) : ls;
  });

  /** Plain sentences, worst first: "2 parts are out of stock: R7, U3". */
  warnings = computed(() => {
    const d = this.data();
    if (!d) return [];
    const out: { key: string; text: string; tone: string; alts: boolean }[] = [];
    const group = (st: StockState, one: string, many: string, tone: string) => {
      const ls = d.lines.filter(l => l.state === st);
      if (!ls.length) return;
      // One name per part: R18 +4 is one resistor value on five pads.
      const each = ls.map(l => l.refs.length <= 2 ? l.refs.join(', ') : `${l.refs[0]} +${l.refs.length - 1}`);
      const names = each.slice(0, 6).join(', ') + (each.length > 6 ? ` and ${each.length - 6} more` : '');
      out.push({ key: st, tone, alts: true,
                 text: `${ls.length} ${ls.length === 1 ? one : many}: ${names}` });
    };
    const n = d.qty === 1 ? '1 board' : `${d.qty} boards`;
    group('out', 'part is out of stock', 'parts are out of stock', 'danger');
    group('short', `part has too few for ${n}`, `parts have too few for ${n}`, 'danger');
    group('unsure', 'part may be out of stock (LCSC’s listings disagree)',
          'parts may be out of stock (LCSC’s listings disagree)', 'warn');
    group('low', 'part is running low', 'parts are running low', 'warn');
    group('no_part', 'part has no LCSC number', 'parts have no LCSC number', 'warn');
    return out;
  });

  ageWords = computed(() => {
    const d = this.data();
    if (!d) return '';
    if (d.stale === d.distinct) return 'prices not checked yet';
    if (!d.oldest_at) return '';
    const h = (Date.now() - Date.parse(d.oldest_at)) / 3600_000;
    const age = h < 1 ? 'less than an hour' : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days`;
    return d.stale ? `${d.stale} prices older than a day (oldest ${age})` : `prices checked within ${age}`;
  });

  constructor() {
    effect(() => {
      const b = this.board(), q = this.qty();
      untracked(() => this.load(b, q, false));
    });
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
  }

  setQty(q: number) { this.customOn.set(false); this.qty.set(q); }
  custom(v: string) {
    const q = Math.round(Number(v));
    if (!isFinite(q) || q < 1) { this.setQty(10); return; }
    this.customOn.set(!PRESETS.includes(q));
    this.qty.set(Math.min(q, 1_000_000));
  }

  refresh() { this.load(this.board(), this.qty(), true); }

  private load(board: string, qty: number, refresh: boolean) {
    clearTimeout(this.timer);
    const url = `/api/boards/${encodeURIComponent(board)}/bom/cost?qty=${qty}&refresh=${refresh ? 1 : 0}`;
    this.http.get<BomCostData>(url).subscribe({
      next: d => {
        this.error.set(null);
        // The server forgets a refresh when it restarts (uvicorn --reload):
        // one that was running and is gone is asked for again - it picks up
        // only the parts still missing, so nothing is asked twice.
        const lost = !refresh && !d.refresh && this.wasRunning;
        this.wasRunning = !!d.refresh?.running;
        this.data.set(d);
        if (lost) { this.load(board, qty, true); return; }
        if (d.refresh?.running) this.timer = setTimeout(() => this.load(this.board(), this.qty(), false), 3000);
      },
      error: e => this.error.set(e?.status === 404 ? 'This board has no parts list yet.'
                                                   : `Could not read the parts cost (${e?.status ?? '?'}).`),
    });
  }

  findAlts(l: BomLine) {
    if (!l.lcsc) return;
    this.finding.set(l.lcsc);
    const url = `/api/boards/${encodeURIComponent(this.board())}/bom/alternatives?lcsc_id=${l.lcsc}&qty=${this.qty()}`;
    this.http.get<{ rows: BomAlt[] }>(url).subscribe({
      next: () => { this.finding.set(null); this.load(this.board(), this.qty(), false); },
      error: e => { this.finding.set(null); this.error.set(e?.error?.detail || `LCSC search failed (${e?.status ?? '?'})`); },
    });
  }

  showProblems() { this.details.set(true); this.onlyProblems.set(true); }

  problem(l: BomLine): boolean { return ['out', 'short', 'unsure', 'low', 'no_part'].includes(l.state); }
  isExtended(l: BomLine): boolean { return (l.jlc_class || '').toLowerCase().startsWith('extended'); }
  tone(s: StockState): string { return STATE_TONE[s]; }
  stockWord(l: BomLine): string {
    if (l.stock == null || l.state === 'no_part') return STATE_WORD[l.state];
    return l.state === 'ok' ? this.count(l.stock) : `${STATE_WORD[l.state]} · ${this.count(l.stock)}`;
  }
  count(n: number | null | undefined): string {
    if (n == null) return '–';
    return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : String(n);
  }
  refsShort(refs: string[]): string {
    return refs.length <= 3 ? refs.join(', ') : `${refs.slice(0, 2).join(', ')} +${refs.length - 2}`;
  }

  /** The table as a CSV, in the reader's currency (and dollars). */
  csv() {
    const d = this.data();
    if (!d) return;
    const cur = CURRENCY();
    const inCur = (usd: number | null) => usd == null ? '' : String(+(fromUsd(usd, cur) ?? usd).toFixed(5));
    const q = (s: unknown) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const head = ['refs', 'lcsc', 'value', 'mpn', 'package', 'jlc_class', 'qty_per_board', `need_for_${d.qty}`,
                  `unit_${cur}`, `line_${cur}`, 'unit_usd', 'stock', 'status', 'alternatives'];
    const rows = d.lines.map(l => [l.refs.join(' '), l.lcsc, l.value, l.mpn, l.package, l.jlc_class, l.qty, l.need,
      inCur(l.unit_usd), inCur(l.line_usd), l.unit_usd ?? '', l.stock ?? '', STATE_WORD[l.state],
      l.alternatives.map(a => a.lcsc).join(' ')].map(q).join(','));
    rows.push(['', '', 'per board', '', '', '', '', '', '', inCur(d.per_board_usd), d.per_board_usd].map(q).join(','));
    rows.push(['', '', `${d.qty} boards`, '', '', '', '', '', '', inCur(d.total_usd), d.total_usd].map(q).join(','));
    const blob = new Blob([[head.map(q).join(','), ...rows].join('\n') + '\n'], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${d.board}-bom-${d.qty}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}
