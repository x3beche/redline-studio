import { Component, computed, input } from '@angular/core';
import { T, t } from './i18n';
import { BudgetItem, BudgetState, BudgetStatus, CURRENCY, money, moneyIn } from './money';

/** The month's budgets as bars (backend/budgets.py): what is spent so far
 *  against each budget, the warning threshold and 100% marked on the track,
 *  and a tick where the month is heading. Settings > Costs and Analytics
 *  show the same thing; the colours are the theme's ok / warn / danger. */
@Component({
  selector: 'app-budget-bars',
  imports: [T],
  styles: [`
    :host { display: block; min-width: 0; }
    .bb { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px 14px; }
    .bb-row { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
    .bb-top { display: flex; align-items: baseline; gap: 6px; min-width: 0; font-size: 11.5px; }
    .bb-name { font-weight: 600; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .bb-state { flex: none; padding: 0 5px; border-radius: 3px; font-size: 10px; line-height: 15px; letter-spacing: .03em;
      text-transform: uppercase; color: var(--ink-dim); background: var(--surface-2); }
    [data-state="warn"] > .bb-top .bb-state { color: var(--ink-on-warn); background: var(--warn); }
    [data-state="over"] > .bb-top .bb-state { color: var(--ink-bright); background: var(--danger); }
    .bb-fig { margin-left: auto; white-space: nowrap; color: var(--ink-bright); font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 11.5px; }
    .bb-fig small { margin-left: 4px; color: var(--ink-dim); font-size: 10px; }
    .bb-track { position: relative; height: 8px; border-radius: 4px; background: var(--line); }
    .bb-fill { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 4px; background: var(--ok); }
    [data-state="warn"] .bb-fill { background: var(--warn); }
    [data-state="over"] .bb-fill { background: var(--danger); }
    .bb-mark { position: absolute; top: -2px; bottom: -2px; width: 1px; background: var(--ink-dim); }
    .bb-mark.warn { background: var(--warn); opacity: .8; }
    .bb-fc { position: absolute; top: -4px; width: 0; height: 0; margin-left: -4px;
      border-left: 4px solid transparent; border-right: 4px solid transparent; border-top: 5px solid var(--ink-bright); }
    .bb-fc::after { content: ''; position: absolute; left: -.5px; top: 0; width: 1px; height: 11px; background: var(--ink-bright); opacity: .7; }
    .bb-fc[data-state="warn"] { border-top-color: var(--warn); }
    .bb-fc[data-state="over"] { border-top-color: var(--danger); }
    .bb-foot { display: flex; flex-wrap: wrap; gap: 2px 10px; font-size: 10.5px; color: var(--ink-dim); }
    .bb-foot b { font-weight: 500; color: var(--ink); }
    .bb-foot [data-state="warn"] { color: var(--warn); }
    .bb-foot [data-state="over"] { color: var(--danger); }
    .bb-meta { margin-top: 8px; font-size: 10.5px; color: var(--ink-dim); }
  `],
  template: `
@if (status(); as st) {
  @if (items().length) {
    <div class="bb">
      @for (b of items(); track b.kind) {
        <div class="bb-row" [attr.data-state]="b.state" [title]="tip(b)">
          <div class="bb-top">
            <span class="bb-name">{{ b.name | t }}</span>
            <span class="bb-state">{{ stateName(b.state) | t }}</span>
            <span class="bb-fig">{{ money(b.spent_usd) }} / {{ money(b.budget_usd) }}@if (b.currency !== cur()) {<small>{{ own(b) }}</small>}</span>
          </div>
          <div class="bb-track" role="meter" [attr.aria-label]="b.name | t" aria-valuemin="0"
               [attr.aria-valuemax]="b.budget_usd" [attr.aria-valuenow]="b.spent_usd">
            <i class="bb-fill" [style.width.%]="at(b, b.ratio)"></i>
            <i class="bb-mark warn" [style.left.%]="at(b, b.warn)"></i>
            <i class="bb-mark" [style.left.%]="at(b, 1)"></i>
            <i class="bb-fc" [attr.data-state]="b.forecast_state" [style.left.%]="at(b, b.forecast_ratio)"></i>
          </div>
          <div class="bb-foot">
            <span><b>{{ pct(b.ratio) }}</b> {{ 'used' | t }}</span>
            <span [attr.data-state]="b.forecast_state">{{ 'month end' | t }} <b>{{ money(b.forecast_usd) }}</b> ({{ pct(b.forecast_ratio) }})</span>
            <span>{{ (b.basis === 'last_7d' ? 'at the last 7 days\\' rate' : 'at the month\\'s daily average') | t }}</span>
            @if (b.missing) { <span>{{ b.missing | t }}</span> }
          </div>
        </div>
      }
    </div>
    @if (meta()) {
      <div class="bb-meta">{{ st.month }} · {{ 'calendar month in UTC' | t }} · {{ daysLeft() }} {{ 'days left' | t }} · {{ 'warning at the tick, 100% at the line, ▼ where the month is heading' | t }}</div>
    }
  } @else { <ng-content /> }
} @else { <ng-content /> }`,
})
export class BudgetBars {
  status = input<BudgetStatus | null | undefined>(null);
  /** The line under the bars: the month, the days left, the key. */
  meta = input(true);
  readonly money = money;
  readonly cur = CURRENCY;
  items = computed(() => (this.status()?.items ?? []).filter(i => !i.error));
  daysLeft = computed(() => Math.max(0, Math.round(this.status()?.days_left ?? 0)));

  /** Where a share of the budget sits on the track: the track runs to 100%,
   *  or further when the month is heading past it (to 150% at most). */
  at(b: BudgetItem, v: number | null | undefined): number {
    const end = Math.min(1.5, Math.max(1, b.ratio ?? 0, b.forecast_ratio ?? 0));
    return Math.max(0, Math.min(v ?? 0, end)) / end * 100;
  }
  pct(v: number | null | undefined) { return v == null ? '–' : `${Math.round(v * 100)}%`; }
  own(b: BudgetItem) { return moneyIn(b.amount, b.currency); }
  stateName(s: BudgetState) { return s === 'over' ? 'over' : s === 'warn' ? 'warning' : 'ok'; }
  tip(b: BudgetItem): string { return budgetTip(b); }
}

/** A budget in one line, for a tooltip. */
export function budgetTip(b: BudgetItem): string {
  const pct = (v: number | null) => v == null ? '–' : `${Math.round(v * 100)}%`;
  return `${t(b.name)}: ${money(b.spent_usd)} ${t('of')} ${money(b.budget_usd)} (${pct(b.ratio)}) - `
    + `${t('month end')} ${money(b.forecast_usd)} (${pct(b.forecast_ratio)}), ${t(b.basis_why)}; `
    + `${t('warning at')} ${pct(b.warn)}`;
}
