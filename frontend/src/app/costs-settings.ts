import { Component, OnDestroy, computed, effect, inject, signal, untracked } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { Auth } from './auth';
import { T, t } from './i18n';
import { BudgetBars } from './budget-bars';
import {
  Budget, BudgetKind, COMMON, CURRENCY, CostLine, Costs, CostsPatch, Money, Period, Price,
  convert, currencies, currencyName, money, moneyIn, setOverride, toUsd,
} from './money';

/** Settings > Costs & currency: what Redline costs to run, and the currency
 *  money is shown in (money.ts).
 *
 *  The subscriptions, the price of a kWh and of a GB of proxy traffic and
 *  the other recurring costs, each typed in its own currency - the server
 *  keeps them so and works the dollars out (/api/costs). Then the exchange
 *  rates the server reads from frankfurter.dev every hour, with a small
 *  table and a converter. Each card is edited as a draft and saved on its
 *  own; changing anything is for the owner and the admins.
 */
interface Row {
  id?: string; name: string; amount: number | null; currency: string; period: Period;
  covers: 'llm' | 'other'; note: string;
}
interface PriceDraft { amount: number | null; currency: string }
/** A budget being edited: the warning threshold in percent, as typed. */
interface BudgetDraft { amount: number | null; currency: string; warn: number }
type BudgetDrafts = Record<BudgetKind, BudgetDraft>;
type Section = 'subscriptions' | 'other' | 'usage' | 'budgets';
const BUDGET_KINDS: BudgetKind[] = ['total', 'llm', 'electricity', 'proxy'];

function budgetsOf(b: Costs['budgets'] | undefined, fallback: string): BudgetDrafts {
  const one = (x: Budget | undefined): BudgetDraft => x
    ? { amount: x.amount, currency: x.currency, warn: Math.round((x.warn ?? 0.8) * 100) }
    : { amount: null, currency: fallback, warn: 80 };
  return { total: one(b?.total), llm: one(b?.llm), electricity: one(b?.electricity), proxy: one(b?.proxy) };
}

function rowsOf(list: CostLine[] | undefined, covers: 'llm' | 'other'): Row[] {
  return (list ?? []).map(c => ({ id: c.id, name: c.name ?? '', amount: c.amount ?? null, currency: c.currency || 'USD',
    period: c.period === 'year' ? 'year' : 'month', covers: c.covers ?? covers, note: c.note ?? '' }));
}
function priceOf(p: Price | null | undefined, fallback: string): PriceDraft {
  return p ? { amount: p.amount, currency: p.currency } : { amount: null, currency: fallback };
}
/** The rows worth keeping: a name or an amount. */
function kept(rows: Row[]): Row[] { return rows.filter(r => r.name.trim() || r.amount != null); }
function same(a: unknown, b: unknown) { return JSON.stringify(a) === JSON.stringify(b); }

@Component({
  selector: 'app-costs-settings',
  imports: [BudgetBars, NgTemplateOutlet, T],
  styleUrl: './settings.css',
  template: `
<div class="st-page">
  <p class="st-lead">{{ 'What Redline costs to run - the subscriptions, the electricity, the proxy traffic - each typed in its own currency. Analytics adds them to the work of each range, and every amount in the app is shown in the display currency.' | t }}</p>
  @if (!canEdit()) { <div class="st-banner">{{ 'These are the server\\'s settings: only the owner and the admins can change them.' | t }}</div> }
  @if (m.costsError(); as e) {
    <div class="st-banner">{{ (e === 'not-yet' ? 'The server does not keep costs yet - the figures here are empty until it does.' : 'The costs did not load') | t }}@if (e !== 'not-yet') { ({{ e }}) }</div>
  }

  <!-- What it comes to, in the display currency -->
  <div class="st-tiles">
    <div class="st-tile hero"><span>{{ 'Fixed costs a month' | t }}</span><b>{{ money(fixedMonth()) }}</b>
      <small>{{ subs().length }} {{ 'subscriptions' | t }} · {{ others().length }} {{ 'other' | t }} · {{ money(fixedMonth() * 12) }} {{ 'a year' | t }}</small></div>
    <div class="st-tile"><span>{{ 'LLM plans a month' | t }}</span><b>{{ money(llmMonth()) }}</b>
      <small>{{ llmCount() }} {{ 'covering LLM work' | t }}</small></div>
    <div class="st-tile" [attr.data-tone]="elec().amount == null ? 'dim' : null"><span>{{ 'Electricity' | t }}</span>
      <b>{{ elec().amount == null ? '–' : money(usdOf(elec())) }}</b>
      <small>{{ elec().amount == null ? ('not set' | t) : ('per kWh' | t) + (elec().currency !== cur() ? ' · ' + inCur(elec().amount, elec().currency) : '') }}</small></div>
    <div class="st-tile" [attr.data-tone]="proxy().amount == null ? 'dim' : null"><span>{{ 'Proxy traffic' | t }}</span>
      <b>{{ proxy().amount == null ? '–' : money(usdOf(proxy())) }}</b>
      <small>{{ proxy().amount == null ? ('not set' | t) : ('per GB' | t) + (proxy().currency !== cur() ? ' · ' + inCur(proxy().amount, proxy().currency) : '') }}</small></div>
    <div class="st-tile"><span>1 USD</span><b>{{ cur() === 'USD' ? '$1' : inCur(rateOf(cur()), cur()) }}</b>
      <small>{{ m.fx()?.date ?? ('no rates yet' | t) }} · frankfurter.dev</small></div>
  </div>

  <div class="st-split">
    <!-- Display currency -->
    <div class="st-card">
      <div class="st-card-head"><h3>{{ 'Display currency' | t }}</h3>
        <span class="st-sub">{{ 'every amount in the app is shown in it' | t }}</span></div>
      <div class="st-card-body">
        <div class="st-grid">
          <label class="st-f" style="grid-column: 1 / -1"><span>{{ 'Default for everyone' | t }}</span>
            <select class="st-in" [disabled]="!canEdit() || busy() === 'currency'" (change)="setDefault($any($event.target).value)">
              @for (c of list(); track c) {
                <option [value]="c" [selected]="c === m.defaultCurrency()">{{ label(c) }}</option>
              }
            </select></label>
        </div>
        <div class="st-row">
          <span class="st-sec-title">{{ 'This browser' | t }}</span>
          <div class="st-seg">
            <button [class.on]="!m.override()" (click)="override(null)">{{ 'Default' | t }} <small>{{ m.defaultCurrency() }}</small></button>
            @for (c of common(); track c) {
              <button [class.on]="m.override() === c" (click)="override(c)">{{ c }}</button>
            }
            @if (m.override() && !common().includes(m.override()!)) {
              <button class="on">{{ m.override() }}</button>
            }
          </div>
        </div>
        <p class="st-hint">{{ 'Each person can show another currency in their own browser - here, or with the currency menu in Analytics. Amounts stay in dollars on the server; only the showing changes.' | t }}</p>
      </div>
    </div>

    <!-- Exchange rates -->
    <div class="st-card">
      <div class="st-card-head"><h3>{{ 'Exchange rates' | t }}</h3>
        @if (m.fx(); as fx) {
          <span class="st-badge" [attr.data-tone]="fx.stale ? 'warn' : 'ok'">{{ (fx.stale ? 'stale' : 'up to date') | t }}</span>
        }
        <span class="st-sub">{{ 'read every hour from' | t }} <a class="st-link" href="https://frankfurter.dev" target="_blank" rel="noopener">frankfurter.dev ↗</a></span>
        @if (canEdit()) {
          <div class="st-right"><button class="tcv-btn tcv-files-btn" [disabled]="busy() === 'fx'" (click)="refresh()">{{ busy() === 'fx' ? '…' : ('Refresh' | t) }}</button></div>
        }
      </div>
      <div class="st-card-body">
        @if (m.fx(); as fx) {
          @if (fx.stale) { <div class="st-banner">{{ 'The last reading failed - these are the latest rates the server has.' | t }}</div> }
          <div class="st-tiles tight">
            <div class="st-tile"><span>{{ 'Rates of' | t }}</span><b>{{ fx.date ?? '–' }}</b><small>{{ 'ECB reference day' | t }}</small></div>
            <div class="st-tile"><span>{{ 'Read' | t }}</span><b>{{ ago(fx.fetched_at) }}</b><small>{{ stamp(fx.fetched_at) }}</small></div>
            <div class="st-tile"><span>{{ 'Currencies' | t }}</span><b>{{ list().length }}</b><small>{{ 'against' | t }} {{ fx.base }}</small></div>
          </div>
          <div class="st-table-wrap st-fx-wrap">
            <table class="st-table st-fx">
              <thead><tr><th>1 ×</th>@for (b of grid(); track b) { <th class="r">{{ b }}</th> }</tr></thead>
              <tbody>
                @for (a of grid(); track a) {
                  <tr [class.st-fx-on]="a === cur()"><td [title]="currencyName(a)"><b class="mono">{{ a }}</b><span class="dim st-fx-name">{{ currencyName(a) }}</span></td>
                    @for (b of grid(); track b) {
                      <td class="r mono" [class.dim]="a === b">{{ a === b ? '1' : cross(a, b) }}</td>
                    }
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <div class="st-conv">
            <input class="st-in" type="number" min="0" step="any" [value]="convAmount()" (input)="convAmount.set(+$any($event.target).value || 0)">
            <select class="st-in" (change)="convFrom.set($any($event.target).value)">
              @for (c of list(); track c) { <option [value]="c" [selected]="c === convFrom()">{{ c }}</option> }
            </select>
            <button class="tcv-btn tcv-files-btn" (click)="swap()" [title]="'swap' | t">⇄</button>
            <select class="st-in" (change)="convTo.set($any($event.target).value)">
              @for (c of list(); track c) { <option [value]="c" [selected]="c === convTo()">{{ c }}</option> }
            </select>
            <span class="st-conv-out mono">= {{ inCur(convert(convAmount(), convFrom(), convTo()), convTo()) }}</span>
          </div>
        } @else {
          <p class="st-hint">{{ 'No rates yet - amounts are shown in dollars until the server has read them.' | t }}</p>
        }
      </div>
    </div>
  </div>

  <!-- Budgets: a month's limit for the total and for what is metered -->
  <div class="st-card">
    <div class="st-card-head"><h3>{{ 'Budgets' | t }}</h3>
      <span class="st-sub">{{ 'a month, in any currency - the calendar month in UTC' | t }}</span>
      <div class="st-right">
        @if (m.costs()?.budget_status?.state; as s) {
          @if (s !== 'ok') { <span class="st-badge" [attr.data-tone]="s === 'over' ? 'danger' : 'warn'">{{ (s === 'over' ? 'over budget' : 'near budget') | t }}</span> }
        }
        @if (dirty('budgets')) { <span class="st-badge" data-tone="warn">{{ 'unsaved' | t }}</span> }
        @if (canEdit()) {
          @if (dirty('budgets')) { <button class="tcv-btn tcv-files-btn" (click)="revert('budgets')">{{ 'Revert' | t }}</button> }
          <button class="tcv-btn tcv-files-btn" [disabled]="!dirty('budgets') || busy() === 'budgets'" (click)="save('budgets')">{{ busy() === 'budgets' ? '…' : ('Save' | t) }}</button>
        }
      </div>
    </div>
    <div class="st-card-body">
      <div class="st-prices st-budgets">
        @for (k of budgetKinds; track k.id) {
          <div class="st-key">
            <div class="st-key-top"><b>{{ k.label | t }}</b><span class="st-sub">{{ k.about | t }}</span></div>
            <div class="st-row">
              <input class="st-in st-num" type="number" min="0" step="any" [disabled]="!canEdit()" [placeholder]="k.optional ? ('none' | t) : k.hint"
                     [value]="budget(k.id).amount ?? ''" (input)="editBudget(k.id, { amount: num($any($event.target).value) })">
              <select class="st-in" [disabled]="!canEdit()" (change)="editBudget(k.id, { currency: $any($event.target).value })">
                @for (c of listWith(budget(k.id).currency); track c) { <option [value]="c" [selected]="c === budget(k.id).currency">{{ c }}</option> }
              </select>
              <span class="st-dim">/ {{ 'month' | t }}</span>
              <label class="st-warn-at" [title]="'The bar and the top bar turn the warning colour from this share of the budget' | t">
                <span class="st-dim">{{ 'warn at' | t }}</span>
                <input class="st-in st-pct" type="number" min="5" max="100" step="1" [disabled]="!canEdit()"
                       [value]="budget(k.id).warn" (input)="editBudget(k.id, { warn: num($any($event.target).value) ?? 80 })"><span class="st-dim">%</span>
              </label>
              <span class="st-right mono">
                @if (budget(k.id).amount != null) { {{ money(toUsd(budget(k.id).amount!, budget(k.id).currency)) }} }
                @else { <span class="st-dim">{{ 'not set' | t }}</span> }
              </span>
            </div>
          </div>
        }
      </div>
      <app-budget-bars [status]="m.costs()?.budget_status">
        <p class="st-hint">{{ 'No budgets yet. Set a monthly budget for the total spend - and, if you like, separate ones for the LLM work at list prices, the electricity and the proxy - to see the month so far against them, where the month is heading, and a warning in the top bar near the limit.' | t }}</p>
      </app-budget-bars>
      <p class="st-hint">{{ 'The total is the subscriptions and other costs prorated to today, the electricity and the proxy traffic - and the LLM work at list prices when no subscription covers it. The month-end forecast keeps the fixed costs at their full month and runs the metered ones on at the month\\'s daily average, or at the last 7 days\\' rate while the month is under 7 days old or when spending has picked up. Crossing the warning and 100% each write one line in the activity log, once a month.' | t }}</p>
    </div>
  </div>

  <!-- Subscriptions -->
  <div class="st-card">
    <div class="st-card-head"><h3>{{ 'Subscriptions' | t }}</h3>
      <span class="st-sub">{{ 'plans and services paid every month or year' | t }}</span>
      <div class="st-right">
        <span class="st-sub mono">{{ money(monthOf(subs())) }} / {{ 'month' | t }}</span>
        @if (dirty('subscriptions')) { <span class="st-badge" data-tone="warn">{{ 'unsaved' | t }}</span> }
        @if (canEdit()) {
          <button class="tcv-btn tcv-files-btn" (click)="add('subscriptions')">+ {{ 'Add' | t }}</button>
          @if (dirty('subscriptions')) { <button class="tcv-btn tcv-files-btn" (click)="revert('subscriptions')">{{ 'Revert' | t }}</button> }
          <button class="tcv-btn tcv-files-btn" [disabled]="!dirty('subscriptions') || busy() === 'subscriptions'" (click)="save('subscriptions')">{{ busy() === 'subscriptions' ? '…' : ('Save' | t) }}</button>
        }
      </div>
    </div>
    @if (subs().length) {
      <ng-container *ngTemplateOutlet="table; context: { s: 'subscriptions', rows: subs() }" />
    } @else {
      <div class="st-card-body"><p class="st-hint">{{ 'No subscriptions yet. Add the plans you pay for - for example Claude Max, 200 USD a month, covering LLM work - and Analytics sets them against what the same work would have cost on the API.' | t }}</p></div>
    }
  </div>

  <!-- Usage prices -->
  <div class="st-card">
    <div class="st-card-head"><h3>{{ 'Prices of what is used' | t }}</h3>
      <span class="st-sub">{{ 'multiplied by what the machine and the proxy used in each range' | t }}</span>
      <div class="st-right">
        @if (dirty('usage')) { <span class="st-badge" data-tone="warn">{{ 'unsaved' | t }}</span> }
        @if (canEdit()) {
          @if (dirty('usage')) { <button class="tcv-btn tcv-files-btn" (click)="revert('usage')">{{ 'Revert' | t }}</button> }
          <button class="tcv-btn tcv-files-btn" [disabled]="!dirty('usage') || busy() === 'usage'" (click)="save('usage')">{{ busy() === 'usage' ? '…' : ('Save' | t) }}</button>
        }
      </div>
    </div>
    <div class="st-card-body">
      <div class="st-prices">
        @for (p of priceKinds; track p.id) {
          <div class="st-key">
            <div class="st-key-top"><b>{{ p.label | t }}</b><span class="st-sub">{{ p.about | t }}</span></div>
            <div class="st-row">
              <input class="st-in st-num" type="number" min="0" step="any" [disabled]="!canEdit()" [placeholder]="p.hint"
                     [value]="priceDraft(p.id).amount ?? ''" (input)="editPrice(p.id, { amount: num($any($event.target).value) })">
              <select class="st-in" [disabled]="!canEdit()" (change)="editPrice(p.id, { currency: $any($event.target).value })">
                @for (c of listWith(priceDraft(p.id).currency); track c) { <option [value]="c" [selected]="c === priceDraft(p.id).currency">{{ c }}</option> }
              </select>
              <span class="st-dim">{{ p.unit | t }}</span>
              <span class="st-right mono">
                @if (priceDraft(p.id).amount != null) {
                  {{ money(usdOf(priceDraft(p.id))) }} <span class="st-dim">{{ p.unit | t }}</span>
                } @else { <span class="st-dim">{{ 'not set' | t }}</span> }
              </span>
            </div>
          </div>
        }
      </div>
    </div>
  </div>

  <!-- Other recurring costs -->
  <div class="st-card">
    <div class="st-card-head"><h3>{{ 'Other recurring costs' | t }}</h3>
      <span class="st-sub">{{ 'hosting, a domain, the internet line - anything paid regularly' | t }}</span>
      <div class="st-right">
        <span class="st-sub mono">{{ money(monthOf(others())) }} / {{ 'month' | t }}</span>
        @if (dirty('other')) { <span class="st-badge" data-tone="warn">{{ 'unsaved' | t }}</span> }
        @if (canEdit()) {
          <button class="tcv-btn tcv-files-btn" (click)="add('other')">+ {{ 'Add' | t }}</button>
          @if (dirty('other')) { <button class="tcv-btn tcv-files-btn" (click)="revert('other')">{{ 'Revert' | t }}</button> }
          <button class="tcv-btn tcv-files-btn" [disabled]="!dirty('other') || busy() === 'other'" (click)="save('other')">{{ busy() === 'other' ? '…' : ('Save' | t) }}</button>
        }
      </div>
    </div>
    @if (others().length) {
      <ng-container *ngTemplateOutlet="table; context: { s: 'other', rows: others() }" />
    } @else {
      <div class="st-card-body"><p class="st-hint">{{ 'Nothing else yet - add what else is paid regularly to run Redline, and Analytics counts it in each range.' | t }}</p></div>
    }
  </div>

  @if (msg(); as x) { <p class="st-msg">{{ x }}</p> }
  @if (err(); as e) { <p class="st-err">{{ e }}</p> }
</div>
<!-- The rows of a list of costs: a grid that folds onto two lines when the stage is narrow. -->
<ng-template #table let-s="s" let-rows="rows">
  <div class="st-lines" [class.st-lines-covers]="s === 'subscriptions'">
    <div class="st-line st-line-head">
      <span>{{ 'Name' | t }}</span><span class="r">{{ 'Amount' | t }}</span><span>{{ 'Currency' | t }}</span><span>{{ 'Every' | t }}</span>
      @if (s === 'subscriptions') { <span>{{ 'Covers' | t }}</span> }
      <span>{{ 'Note' | t }}</span><span class="r">{{ 'A month' | t }}</span><span></span>
    </div>
    @for (r of rows; track $index; let i = $index) {
      <div class="st-line">
        <input class="st-in st-l-name" [value]="r.name" [disabled]="!canEdit()" [placeholder]="s === 'subscriptions' ? 'Claude Max' : ('Hosting' | t)"
               (input)="edit(s, i, { name: $any($event.target).value })">
        <input class="st-in st-num" type="number" min="0" step="any" [value]="r.amount ?? ''" [disabled]="!canEdit()"
               [placeholder]="s === 'subscriptions' ? '200' : '10'" (input)="edit(s, i, { amount: num($any($event.target).value) })">
        <select class="st-in" [disabled]="!canEdit()" (change)="edit(s, i, { currency: $any($event.target).value })">
          @for (c of listWith(r.currency); track c) { <option [value]="c" [selected]="c === r.currency">{{ c }}</option> }
        </select>
        <div class="st-seg st-l-period">
          <button [class.on]="r.period === 'month'" [disabled]="!canEdit()" (click)="edit(s, i, { period: 'month' })">{{ 'month' | t }}</button>
          <button [class.on]="r.period === 'year'" [disabled]="!canEdit()" (click)="edit(s, i, { period: 'year' })">{{ 'year' | t }}</button>
        </div>
        @if (s === 'subscriptions') {
          <div class="st-seg st-l-covers" [title]="'Plans that cover LLM work are set against the work at API list prices in Analytics' | t">
            <button [class.on]="r.covers === 'llm'" [disabled]="!canEdit()" (click)="edit(s, i, { covers: 'llm' })">{{ 'LLM work' | t }}</button>
            <button [class.on]="r.covers !== 'llm'" [disabled]="!canEdit()" (click)="edit(s, i, { covers: 'other' })">{{ 'other' | t }}</button>
          </div>
        }
        <input class="st-in st-l-note" [value]="r.note" [disabled]="!canEdit()" [placeholder]="'note, optional' | t"
               (input)="edit(s, i, { note: $any($event.target).value })">
        <span class="st-l-month mono">{{ rowMonth(r) == null ? '–' : money(rowMonth(r)!) }}
          @if (r.currency !== cur() && r.amount != null) { <small>{{ inCur(r.period === 'year' ? r.amount / 12 : r.amount, r.currency) }}</small> }</span>
        @if (canEdit()) { <button class="st-x" (click)="drop(s, i)" [title]="'Remove this row' | t">×</button> } @else { <span></span> }
      </div>
    }
  </div>
</ng-template>`,
})
export class CostsSettingsPanel implements OnDestroy {
  readonly m = inject(Money);
  private auth = inject(Auth);
  canEdit = computed(() => this.auth.can('settings'));
  readonly cur = CURRENCY;
  readonly money = money;
  readonly inCur = moneyIn;
  readonly convert = convert;
  readonly currencyName = currencyName;
  readonly toUsd = toUsd;
  readonly budgetKinds = [
    { id: 'total' as const, label: 'Total spend', about: 'everything paid this month', hint: '500', optional: false },
    { id: 'llm' as const, label: 'LLM work', about: 'at API list prices', hint: '1000', optional: true },
    { id: 'electricity' as const, label: 'Electricity', about: 'the machine\'s measured energy', hint: '50', optional: true },
    { id: 'proxy' as const, label: 'Proxy traffic', about: 'what the proxy carried', hint: '20', optional: true },
  ];
  readonly priceKinds = [
    { id: 'electricity' as const, label: 'Electricity', about: 'what a kWh costs where the machine is', unit: 'per kWh', hint: '3' },
    { id: 'proxy' as const, label: 'Proxy traffic', about: 'what the proxy provider bills a GB', unit: 'per GB', hint: '4' },
  ];

  /** The drafts, and what the server had when each was taken. */
  subs = signal<Row[]>([]);
  others = signal<Row[]>([]);
  elec = signal<PriceDraft>({ amount: null, currency: 'USD' });
  proxy = signal<PriceDraft>({ amount: null, currency: 'USD' });
  budgets = signal<BudgetDrafts>(budgetsOf(undefined, 'USD'));
  private base = signal<{ subscriptions: Row[]; other: Row[]; usage: [PriceDraft, PriceDraft]; budgets: BudgetDrafts }>(
    { subscriptions: [], other: [], usage: [{ amount: null, currency: 'USD' }, { amount: null, currency: 'USD' }],
      budgets: budgetsOf(undefined, 'USD') });

  busy = signal<Section | 'currency' | 'fx' | null>(null);
  msg = signal<string | null>(null);
  err = signal<string | null>(null);
  convAmount = signal(100);
  convFrom = signal('USD');
  convTo = signal(CURRENCY() === 'USD' ? 'TRY' : CURRENCY());
  private now = signal(Date.now());
  private tick = setInterval(() => this.now.set(Date.now()), 30_000);

  list = computed(() => currencies());
  common = computed(() => COMMON.filter(c => this.list().includes(c)));
  /** The table of rates: the common ones and the one on show. */
  grid = computed(() => [...new Set([...COMMON, this.cur()])].filter(c => this.list().includes(c)));

  constructor() {
    // Take what the server has into each card that holds no unsaved change.
    effect(() => {
      const c = this.m.costs();
      if (!c) return;
      untracked(() => {
        for (const s of ['subscriptions', 'other', 'usage', 'budgets'] as Section[]) if (!this.dirty(s)) this.take(c, s);
      });
    });
  }
  ngOnDestroy() { clearInterval(this.tick); }

  private take(c: Costs, s: Section) {
    const d = c.display_currency || 'USD';
    if (s === 'subscriptions') {
      const r = rowsOf(c.subscriptions, 'other');
      this.subs.set(r); this.base.update(b => ({ ...b, subscriptions: structuredClone(r) }));
    } else if (s === 'other') {
      const r = rowsOf(c.other, 'other');
      this.others.set(r); this.base.update(b => ({ ...b, other: structuredClone(r) }));
    } else if (s === 'budgets') {
      const b = budgetsOf(c.budgets, d);
      this.budgets.set(b); this.base.update(x => ({ ...x, budgets: structuredClone(b) }));
    } else {
      const e = priceOf(c.electricity, d), p = priceOf(c.proxy, d);
      this.elec.set(e); this.proxy.set(p);
      this.base.update(b => ({ ...b, usage: [{ ...e }, { ...p }] }));
    }
  }

  dirty(s: Section): boolean {
    const b = this.base();
    if (s === 'subscriptions') return !same(kept(this.subs()), b.subscriptions);
    if (s === 'other') return !same(kept(this.others()), b.other);
    if (s === 'budgets') return !same(this.budgets(), b.budgets);
    return !same([this.elec(), this.proxy()], b.usage);
  }

  label(c: string) { const n = currencyName(c); return n && n !== c ? `${c} · ${n}` : c; }
  /** The currencies, with one a row holds even if there is no rate for it. */
  listWith(c: string) { const l = this.list(); return l.includes(c) ? l : [c, ...l]; }
  num(v: string): number | null { return v === '' || isNaN(+v) ? null : +v; }
  rateOf(c: string) { return this.m.rates()[c] ?? null; }
  cross(a: string, b: string): string {
    const v = convert(1, a, b);
    if (v == null) return '–';
    return new Intl.NumberFormat(navigator.language || 'en-US', { maximumSignificantDigits: 5 }).format(v);
  }
  usdOf(p: PriceDraft): number | null { return p.amount == null ? null : toUsd(p.amount, p.currency); }
  /** A row's cost a month, in dollars. */
  rowMonth(r: Row): number | null {
    if (r.amount == null) return null;
    const u = toUsd(r.amount, r.currency);
    return u == null ? null : r.period === 'year' ? u / 12 : u;
  }
  monthOf(rows: Row[]) { return rows.reduce((a, r) => a + (this.rowMonth(r) ?? 0), 0); }
  fixedMonth = computed(() => this.monthOf(this.subs()) + this.monthOf(this.others()));
  llmMonth = computed(() => this.monthOf(this.subs().filter(r => r.covers === 'llm')));
  llmCount = computed(() => this.subs().filter(r => r.covers === 'llm').length);

  ago(iso: string | null): string {
    if (!iso) return '–';
    const mins = Math.round((this.now() - Date.parse(iso)) / 60000);
    if (isNaN(mins)) return '–';
    if (mins < 1) return t('just now');
    if (mins < 60) return `${mins} ${t('min ago')}`;
    const h = Math.round(mins / 60);
    return h < 48 ? `${h} ${t('h ago')}` : `${Math.round(h / 24)} ${t('days ago')}`;
  }
  stamp(iso: string | null): string {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? iso : d.toLocaleString(navigator.language || 'en-GB',
      { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  private rows(s: 'subscriptions' | 'other') { return s === 'subscriptions' ? this.subs : this.others; }
  edit(s: 'subscriptions' | 'other', i: number, patch: Partial<Row>) {
    this.rows(s).update(list => list.map((r, j) => j === i ? { ...r, ...patch } : r));
  }
  add(s: 'subscriptions' | 'other') {
    this.rows(s).update(list => [...list, { name: '', amount: null, currency: this.m.defaultCurrency(),
      period: 'month', covers: s === 'subscriptions' ? 'llm' : 'other', note: '' }]);
  }
  drop(s: 'subscriptions' | 'other', i: number) { this.rows(s).update(list => list.filter((_, j) => j !== i)); }
  priceDraft(id: 'electricity' | 'proxy') { return id === 'electricity' ? this.elec() : this.proxy(); }
  editPrice(id: 'electricity' | 'proxy', patch: Partial<PriceDraft>) {
    (id === 'electricity' ? this.elec : this.proxy).update(p => ({ ...p, ...patch }));
  }
  budget(k: BudgetKind) { return this.budgets()[k]; }
  editBudget(k: BudgetKind, patch: Partial<BudgetDraft>) {
    this.budgets.update(b => ({ ...b, [k]: { ...b[k], ...patch } }));
  }
  revert(s: Section) {
    const b = this.base();
    if (s === 'budgets') this.budgets.set(structuredClone(b.budgets));
    else if (s === 'subscriptions') this.subs.set(structuredClone(b.subscriptions));
    else if (s === 'other') this.others.set(structuredClone(b.other));
    else { this.elec.set({ ...b.usage[0] }); this.proxy.set({ ...b.usage[1] }); }
  }
  swap() { const f = this.convFrom(); this.convFrom.set(this.convTo()); this.convTo.set(f); }
  override(c: string | null) { setOverride(c); }

  save(s: Section) {
    const lines = (rows: Row[], covers: boolean): CostLine[] | null => {
      const out: CostLine[] = [];
      for (const r of kept(rows)) {
        if (!r.name.trim()) { this.err.set(t('Every row needs a name.')); return null; }
        if (r.amount == null || r.amount < 0) { this.err.set(t('Every row needs an amount of 0 or more.')); return null; }
        const l: CostLine = { name: r.name.trim(), amount: r.amount, currency: r.currency, period: r.period, note: r.note.trim() };
        if (r.id) l.id = r.id;
        if (covers) l.covers = r.covers;
        out.push(l);
      }
      return out;
    };
    const price = (p: PriceDraft): Price | null => p.amount == null ? null : { amount: p.amount, currency: p.currency };
    let patch: CostsPatch;
    if (s === 'subscriptions') { const l = lines(this.subs(), true); if (!l) return; patch = { subscriptions: l }; }
    else if (s === 'other') { const l = lines(this.others(), false); if (!l) return; patch = { other: l }; }
    else if (s === 'budgets') {
      const out: NonNullable<CostsPatch['budgets']> = {};
      for (const k of BUDGET_KINDS) {
        const b = this.budget(k);
        if (b.amount != null && b.amount <= 0) { this.err.set(t('A budget has to be more than 0 - leave it empty for none.')); return; }
        if (b.warn < 5 || b.warn > 100) { this.err.set(t('The warning threshold is between 5% and 100%.')); return; }
        out[k] = b.amount == null ? null : { amount: b.amount, currency: b.currency, warn: b.warn / 100 };
      }
      patch = { budgets: out };
    } else {
      if ([this.elec(), this.proxy()].some(p => p.amount != null && p.amount < 0)) { this.err.set(t('A price cannot be negative.')); return; }
      patch = { electricity: price(this.elec()), proxy: price(this.proxy()) };
    }
    this.put(s, patch, c => this.take(c, s));
  }

  setDefault(c: string) { this.put('currency', { display_currency: c }); }

  refresh() {
    this.busy.set('fx'); this.err.set(null);
    this.m.refreshFx().subscribe({
      next: () => { this.busy.set(null); this.flash(t('Rates read again.')); },
      error: e => { this.busy.set(null); this.err.set(this.text(e)); },
    });
  }

  private put(what: Section | 'currency', patch: CostsPatch, after?: (c: Costs) => void) {
    this.busy.set(what); this.err.set(null);
    this.m.saveCosts(patch).subscribe({
      next: c => { this.busy.set(null); after?.(c); this.flash(t('Saved.')); },
      error: e => { this.busy.set(null); this.err.set(this.text(e)); },
    });
  }
  private flash(s: string) { this.msg.set(s); setTimeout(() => this.msg.set(null), 3000); }
  private text(e: unknown): string {
    const err = e as { error?: { detail?: unknown }; message?: string };
    return typeof err?.error?.detail === 'string' ? err.error.detail : (err?.message ?? t('Something went wrong.'));
  }
}
