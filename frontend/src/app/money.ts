import { Component, DestroyRef, Injectable, Input, booleanAttribute, computed, effect, inject, signal, untracked } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap } from 'rxjs';
import { Auth } from './auth';
import { LANG, t } from './i18n';

/** Money, app-wide: every amount the server sends is in US dollars, and
 *  this shows it in the currency the person reading wants.
 *
 *  The exchange rates come from the server (/api/fx - frankfurter.dev,
 *  refreshed there every hour), read at start, every hour, and when the
 *  tab comes back after more than an hour away. The display currency is
 *  this browser's own choice if it made one ("redline.currency"), else the
 *  server's default (/api/costs display_currency), else dollars.
 *
 *  The state is in plain signals at module level, so the helpers below
 *  work from code without injection (the chart formatters) - and a
 *  template that calls them re-renders when the currency or a rate
 *  changes, since the signals they read are tracked.
 */

export interface FxInfo {
  base: string; date: string | null; fetched_at: string | null; source: string; stale: boolean;
  rates: Record<string, number>; names: Record<string, string>;
}
export type Period = 'month' | 'year';
export interface CostLine {
  id?: string; name: string; amount: number; currency: string; period: Period;
  covers?: 'llm' | 'other'; note?: string;
}
export interface Price { amount: number; currency: string }
/** A budget a month, as typed: an amount in its own currency and the
 *  share of it (0.8) at which it warns. */
export type BudgetKind = 'total' | 'llm' | 'electricity' | 'proxy';
export interface Budget { amount: number; currency: string; warn: number }
export type BudgetState = 'ok' | 'warn' | 'over';
/** One budget this month (backend/budgets.py): dollars, like every figure. */
export interface BudgetItem {
  kind: BudgetKind; name: string; amount: number; currency: string; warn: number;
  budget_usd: number; spent_usd: number; forecast_usd: number;
  ratio: number | null; forecast_ratio: number | null; state: BudgetState; forecast_state: BudgetState;
  basis: 'month_avg' | 'last_7d'; basis_why: string;
  forecast_month_avg_usd: number; forecast_last_7d_usd: number;
  rate_month_per_day_usd: number; rate_7d_per_day_usd: number;
  fixed_month_usd?: number; llm_included?: boolean; missing?: string; error?: string;
}
/** The calendar month in UTC so far, and every budget in it. */
export interface BudgetStatus {
  month: string; timezone: string; start: string; end: string;
  days_in_month: number; days_elapsed: number; days_left: number; recent_days: number;
  items: BudgetItem[]; state?: BudgetState; error?: string;
  month_so_far?: MonthSoFar;
}
/** The month to date whether or not a budget is set: what was metered and
 *  what it cost, the fixed costs prorated, and the forecast for its end. */
export interface MonthSoFar {
  llm_usd: number; kwh: number; proxy_gb: number; electricity_usd: number; proxy_usd: number;
  fixed_usd: number; fixed_month_usd: number; llm_in_total: boolean; total_usd: number;
  forecast_usd: number; basis: 'month_avg' | 'last_7d'; llm_7d_per_day_usd: number; llm_forecast_usd: number;
}
export interface Costs {
  display_currency: string;
  budgets: Partial<Record<BudgetKind, Budget>>;
  budget_status?: BudgetStatus;
  subscriptions: CostLine[];
  electricity: Price | null;
  proxy: Price | null;
  other: CostLine[];
  usd: { electricity_per_kwh: number | null; proxy_per_gb: number | null;
         llm_subscriptions_per_month: number; subscriptions_per_month: number; other_per_month: number };
  fx: { date: string | null; fetched_at: string | null };
}
export type CostsPatch = Partial<Pick<Costs, 'display_currency' | 'subscriptions' | 'electricity' | 'proxy' | 'other'>>
  & { budgets?: Partial<Record<BudgetKind, Budget | null>> };

const OVERRIDE_KEY = 'redline.currency';
const FX_KEY = 'redline.fx';
const HOUR = 3600_000;
/** The currencies most people here want, first in every list. */
export const COMMON = ['USD', 'EUR', 'TRY', 'GBP'];

function readOverride(): string | null {
  try { const v = localStorage.getItem(OVERRIDE_KEY); return v && /^[A-Z]{3}$/.test(v) ? v : null; } catch { return null; }
}
function readFx(): FxInfo | null {
  try { const v = JSON.parse(localStorage.getItem(FX_KEY) ?? 'null'); return v?.rates ? v : null; } catch { return null; }
}

/** The last rates this browser saw, so a reload shows the right currency at once. */
const cached = readFx();
/** Units of each currency per 1 USD. */
export const RATES = signal<Record<string, number>>(cached?.rates ?? { USD: 1 });
export const NAMES = signal<Record<string, string>>(cached?.names ?? {});
export const FX = signal<FxInfo | null>(cached);
/** The server's default display currency. */
export const DEFAULT_CURRENCY = signal<string>('USD');
/** This browser's own choice, or null for the default. */
export const OVERRIDE = signal<string | null>(readOverride());
/** The currency amounts are shown in - the one chosen, as long as there
 *  is a rate for it (dollars until then, rather than dollars under a lira sign). */
export const CURRENCY = computed(() => {
  const want = OVERRIDE() ?? DEFAULT_CURRENCY();
  return RATES()[want] ? want : 'USD';
});

export function setOverride(cur: string | null) {
  OVERRIDE.set(cur);
  try { if (cur) localStorage.setItem(OVERRIDE_KEY, cur); else localStorage.removeItem(OVERRIDE_KEY); } catch { /* private window */ }
}

export function rate(cur: string): number | null { return RATES()[cur] ?? null; }
/** An amount in `cur`, in dollars (null when there is no rate for it). */
export function toUsd(amount: number, cur: string): number | null {
  const r = rate(cur); return r ? amount / r : null;
}
/** Dollars, in `cur` (null when there is no rate for it). */
export function fromUsd(usd: number, cur: string): number | null {
  const r = rate(cur); return r ? usd * r : null;
}
/** From one currency to another. */
export function convert(amount: number, from: string, to: string): number | null {
  const u = toUsd(amount, from); return u == null ? null : fromUsd(u, to);
}

/* ---- How an amount is written: ONE rule for the whole app ----
 *
 *  1. Costs the app works out (LLM spend, proxy traffic, budgets,
 *     electricity, subscriptions, Jina, a BOM's total) are kept in dollars
 *     and shown in the display currency: money(usd). Where the dollar figure
 *     itself matters, the tooltip (usdTip) gives it with the rate and its date.
 *  2. A price that belongs to something in its own currency (a catalog
 *     product priced in lira by its seller, an LCSC part in dollars, a price
 *     per GB typed in dollars, a stock item's unit price) is shown in that
 *     currency: moneyIn(amount, cur) - and when that is not the display
 *     currency, a muted "≈ <display>" after it (moneyAlt) or the same in a
 *     tooltip (moneyTip). <wb-money> does both kinds in a template.
 *  3. Strike-through list prices are written the same way.
 *
 *  The writing: the currency's own sign, never its code ("₺435,12", not
 *  "TRY 435.12"), before the figure; the separators of the UI language,
 *  not the browser's - "₺1.234,56" in Turkish, "₺1,234.56" in English.
 *  Two decimals from one up, whole above 100,000; under one, two to four
 *  decimals ("$0.50", "$0.0123"); tinier, two significant figures. Prompts
 *  for a model (backend) write ISO codes instead, which is unambiguous there.
 */

/** The locale numbers are written in: the UI language's (i18n.ts). */
export function moneyLocale(): string { return LANG() === 'tr' ? 'tr-TR' : 'en-US'; }

const formats = new Map<string, Intl.NumberFormat>();
function nf(cur: string, min: number, max = min, sig = false): Intl.NumberFormat {
  const lang = moneyLocale();
  const key = `${lang}|${cur}|${min}|${max}|${sig}`;
  let f = formats.get(key);
  if (!f) {
    const base: Intl.NumberFormatOptions = { style: 'currency', currency: cur, currencyDisplay: 'narrowSymbol' };
    const opts: Intl.NumberFormatOptions = sig ? { ...base, maximumSignificantDigits: max }
      : { ...base, minimumFractionDigits: min, maximumFractionDigits: max };
    try { f = new Intl.NumberFormat(lang, opts); }
    catch {
      // Not a currency code the browser knows: the figure, then the code.
      const plain = new Intl.NumberFormat(lang, sig ? { maximumSignificantDigits: max } : { minimumFractionDigits: min, maximumFractionDigits: max });
      f = { format: (v: number) => plain.format(v) + (cur ? ' ' + cur : ''),
            formatToParts: (v: number) => [{ type: 'integer', value: plain.format(v) }, { type: 'currency', value: cur }] } as unknown as Intl.NumberFormat;
    }
    formats.set(key, f);
  }
  return f;
}

/** An amount already in `cur`, written the app's one way (above); with
 *  no currency (an old stock item), the figure alone. */
export function moneyIn(amount: number | null | undefined, cur: string | null | undefined): string {
  if (amount == null || !isFinite(amount)) return '–';
  const c = /^[A-Za-z]{3}$/.test(cur ?? '') ? cur!.toUpperCase() : '';
  const a = Math.abs(amount);
  if (a === 0) return nf(c, 2).format(0);
  if (a >= 100_000) return nf(c, 0).format(amount);
  if (a >= 1) return nf(c, 2).format(amount);
  if (a >= 0.001) return nf(c, 2, 4).format(amount);
  return nf(c, 0, 2, true).format(amount);
}

/** Dollars from the server, in the display currency. */
export function money(usd: number | null | undefined): string {
  if (usd == null || !isFinite(usd)) return '–';
  const cur = CURRENCY();
  return moneyIn(fromUsd(usd, cur) ?? usd, cur);
}

/** An amount in `cur` written as it is (rule 2), or with `convert` in the
 *  display currency (rule 1, for a cost typed in another currency). */
export function fmtMoney(amount: number | null | undefined, cur: string | null | undefined,
                         opts: { convert?: boolean } = {}): string {
  if (amount == null || !isFinite(amount)) return '–';
  const c = (cur || 'USD').toUpperCase();
  if (!opts.convert) return moneyIn(amount, c);
  const u = toUsd(amount, c);
  return u == null ? moneyIn(amount, c) : money(u);
}

/** "≈ $10.56": an amount in `cur` in the display currency, when that is
 *  another one and there is a rate - else ''. */
export function moneyAlt(amount: number | null | undefined, cur: string | null | undefined): string {
  if (amount == null || !isFinite(amount) || !/^[A-Za-z]{3}$/.test(cur ?? '')) return '';
  const c = cur!.toUpperCase(), d = CURRENCY();
  if (c === d) return '';
  const v = convert(amount, c, d);
  return v == null ? '' : '≈ ' + moneyIn(v, d);
}

function rateNote(): string {
  const date = FX()?.date;
  return date ? ` · ${t('rates of')} ${date}` : '';
}

/** A tooltip for a price in its own currency: "₺435,12 ≈ $10.56 · rates of
 *  2026-10-11", or '' when it is in the display currency already. */
export function moneyTip(amount: number | null | undefined, cur: string | null | undefined): string {
  const alt = moneyAlt(amount, cur);
  return alt ? `${moneyIn(amount, cur)} ${alt}${rateNote()}` : '';
}

/** A tooltip for a cost shown converted from dollars: "$4.00 · 1 USD = ₺41,23
 *  · rates of 2026-10-11", or '' when the display currency is the dollar. */
export function usdTip(usd: number | null | undefined): string {
  if (usd == null || !isFinite(usd)) return '';
  const d = CURRENCY();
  if (d === 'USD') return '';
  const r = rate(d);
  return `${moneyIn(usd, 'USD')}${r ? ` · 1 USD = ${moneyIn(r, d)}` : ''}${rateNote()}`;
}

/** Shorter still, for a chip: "₺12,3B" / "₺12.3K". */
export function moneyShort(usd: number): string {
  const cur = CURRENCY();
  const v = fromUsd(usd, cur) ?? usd;
  if (Math.abs(v) < 1000) return nf(cur, 0).format(v);
  try {
    return new Intl.NumberFormat(moneyLocale(), { style: 'currency', currency: cur, currencyDisplay: 'narrowSymbol',
      notation: 'compact', maximumFractionDigits: 1 }).format(v);
  } catch { return moneyIn(v, cur); }
}

/** An amount in a template, by the rule above:
 *    <wb-money [usd]="x" />                 a cost, in the display currency,
 *                                           the dollars and rate in its tooltip;
 *    <wb-money [amount]="p" cur="TRY" />    a price in its own currency, with a
 *                                           muted "≈ $10.56" when that differs
 *                                           (alt="tip" puts it in the tooltip,
 *                                           alt="none" leaves it out);
 *    <wb-money ... strike />                a list price, struck through. */
@Component({
  selector: 'wb-money',
  host: { '[class.wb-money-strike]': 'strike' },
  template: `@if (usd != null) {<span class="wb-money-v" [title]="usdTip(usd)">{{ money(usd) }}</span>}
    @else {<span class="wb-money-v" [title]="alt === 'tip' ? moneyTip(amount, cur) : ''">{{ moneyIn(amount, cur) }}</span>@if (alt === 'inline' && moneyAlt(amount, cur); as a) {<small class="wb-money-alt">{{ a }}</small>}}`,
  styles: [`:host { white-space: nowrap; }
    :host(.wb-money-strike) .wb-money-v { text-decoration: line-through; }
    .wb-money-alt { margin-left: .4em; color: var(--ink-dim); font-weight: 400; font-size: .85em; }`],
})
export class MoneyView {
  @Input() usd: number | null | undefined = undefined;
  @Input() amount: number | null | undefined = undefined;
  @Input() cur: string | null | undefined = 'USD';
  @Input() alt: 'inline' | 'tip' | 'none' = 'inline';
  @Input({ transform: booleanAttribute }) strike = false;
  readonly money = money; readonly moneyIn = moneyIn; readonly moneyAlt = moneyAlt;
  readonly moneyTip = moneyTip; readonly usdTip = usdTip;
}

/** The currency's sign alone: "₺". */
export function symbol(cur = CURRENCY()): string {
  return nf(cur, 0).formatToParts(0).find(p => p.type === 'currency')?.value ?? cur;
}

/** Every currency there is a rate for: the common ones, then the rest by code. */
export function currencies(): string[] {
  const all = Object.keys(RATES());
  return [...COMMON.filter(c => all.includes(c)), ...all.filter(c => !COMMON.includes(c)).sort()];
}
export function currencyName(cur: string): string { return NAMES()[cur] ?? cur; }

/** Loads and keeps the rates and the costs; one for the app, started by the shell. */
@Injectable({ providedIn: 'root' })
export class Money {
  private http = inject(HttpClient);
  private auth = inject(Auth);
  readonly rates = RATES;
  readonly names = NAMES;
  readonly fx = FX;
  readonly currency = CURRENCY;
  readonly override = OVERRIDE;
  readonly defaultCurrency = DEFAULT_CURRENCY;
  /** The server's costs (/api/costs), null until read. */
  costs = signal<Costs | null>(null);
  costsError = signal<string | null>(null);
  private fxAt = 0;
  private timer?: ReturnType<typeof setInterval>;

  constructor() {
    effect(() => {
      if (!this.auth.signedIn()) return;
      untracked(() => { this.loadFx(); this.loadCosts(); });
    });
    this.timer = setInterval(() => { if (this.auth.signedIn()) this.loadFx(); }, HOUR);
    const back = () => {
      if (document.visibilityState === 'visible' && this.auth.signedIn() && Date.now() - this.fxAt > HOUR) {
        this.loadFx(); this.loadCosts();
      }
    };
    document.addEventListener('visibilitychange', back);
    inject(DestroyRef).onDestroy(() => { clearInterval(this.timer); document.removeEventListener('visibilitychange', back); });
  }

  setOverride(cur: string | null) { setOverride(cur); }

  private takeFx(d: FxInfo) {
    if (!d?.rates) return;
    this.fxAt = Date.now();
    FX.set(d);
    RATES.set({ ...d.rates, [d.base || 'USD']: 1 });
    NAMES.set(d.names ?? {});
    try { localStorage.setItem(FX_KEY, JSON.stringify(d)); } catch { /* private window */ }
  }
  private takeCosts(c: Costs) {
    this.costs.set(c);
    this.costsError.set(null);
    if (c?.display_currency) DEFAULT_CURRENCY.set(c.display_currency);
  }

  loadFx() {
    this.http.get<FxInfo>('/api/fx').subscribe({ next: d => this.takeFx(d), error: () => { /* keep the last rates */ } });
  }
  loadCosts() {
    this.http.get<Costs>('/api/costs').subscribe({
      next: c => this.takeCosts(c),
      error: e => this.costsError.set(e?.status === 404 ? 'not-yet' : String(e?.status ?? '?')),
    });
  }
  /** Ask the server to fetch the rates now (owners and admins). */
  refreshFx(): Observable<FxInfo> {
    return this.http.post<FxInfo>('/api/fx/refresh', {}).pipe(tap(d => this.takeFx(d)));
  }
  saveCosts(patch: CostsPatch): Observable<Costs> {
    return this.http.put<Costs>('/api/costs', patch).pipe(tap(c => this.takeCosts(c)));
  }
}
