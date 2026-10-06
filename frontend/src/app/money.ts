import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap } from 'rxjs';
import { Auth } from './auth';

/** Money, app-wide: every amount the server sends is in US dollars, and
 *  this shows it in the currency the person reading wants.
 *
 *  The exchange rates come from the server (/api/fx - frankfurter.dev,
 *  refreshed there every hour), read at start, every hour, and when the
 *  tab comes back after more than an hour away. The display currency is
 *  this browser's own choice if it made one ("redline.currency"), else the
 *  workspace's default (/api/costs display_currency), else dollars.
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
/** The workspace's default display currency. */
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

const formats = new Map<string, Intl.NumberFormat>();
function nf(cur: string, digits: number, sig = false): Intl.NumberFormat {
  const key = `${cur}|${digits}|${sig}`;
  let f = formats.get(key);
  if (!f) {
    const lang = navigator.language || 'en-US';
    const base: Intl.NumberFormatOptions = { style: 'currency', currency: cur, currencyDisplay: 'narrowSymbol' };
    const opts: Intl.NumberFormatOptions = sig ? { ...base, maximumSignificantDigits: digits }
      : { ...base, minimumFractionDigits: digits, maximumFractionDigits: digits };
    try { f = new Intl.NumberFormat(lang, opts); } catch { f = new Intl.NumberFormat('en-US', opts); }
    formats.set(key, f);
  }
  return f;
}

/** An amount already in `cur`, the app's compact way: big ones whole with
 *  thousands separators, everyday ones with cents, small ones with a digit
 *  more, tiny ones to two significant figures. The browser's language for
 *  the separators, the currency's own sign. */
export function moneyIn(amount: number | null | undefined, cur: string): string {
  if (amount == null || !isFinite(amount)) return '–';
  const a = Math.abs(amount);
  if (a === 0) return nf(cur, 0).format(0);
  if (a >= 1000) return nf(cur, 0).format(amount);
  if (a >= 1) return nf(cur, 2).format(amount);
  if (a >= 0.01) return nf(cur, 3).format(amount);
  if (a >= 0.001) return nf(cur, 4).format(amount);
  return nf(cur, 2, true).format(amount);
}

/** Dollars from the server, in the display currency. */
export function money(usd: number | null | undefined): string {
  if (usd == null || !isFinite(usd)) return '–';
  const cur = CURRENCY();
  return moneyIn(fromUsd(usd, cur) ?? usd, cur);
}

/** Shorter still, for a chip: "₺12.3k". */
export function moneyShort(usd: number): string {
  const cur = CURRENCY();
  const v = fromUsd(usd, cur) ?? usd;
  if (Math.abs(v) < 1000) return nf(cur, 0).format(v);
  const lang = navigator.language || 'en-US';
  try {
    return new Intl.NumberFormat(lang, { style: 'currency', currency: cur, currencyDisplay: 'narrowSymbol',
      notation: 'compact', maximumFractionDigits: 1 }).format(v);
  } catch { return moneyIn(v, cur); }
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
  /** The workspace's costs (/api/costs), null until read. */
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
