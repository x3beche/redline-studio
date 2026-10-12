import { Component, computed, effect, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { T, t } from './i18n';
import { BarList, Row, TimeChart, TimeData, fmt } from './rooms/charts';
import { Money, MoneyView, money, usdTip } from './money';
import { TrafficPeriod } from './jina-settings';
import { CountUp } from './count';
import { Skeleton } from './skeleton';

/** Settings > Proxy & Data, at the foot of the page and always in sight:
 *  the data traffic of every outside lookup together (GET
 *  /api/proxy/overview, backend/netoverview.py) - the Drawer's LCSC lookups,
 *  the Product Catalog's crawler and the Chat's web tools, by the route each
 *  request took (Local, Proxy, Jina), in the same buckets; what the proxy
 *  carried on the wire and costs, and the Jina tokens. The period is the
 *  page's one (TrafficPeriod). */
type RouteId = 'local' | 'proxy' | 'jina';
interface RouteFig {
  requests: number; ok: number; failed: number; refused: number; bytes: number; success_rate: number | null;
  p50_ms: number | null; p95_ms: number | null; timed: number; tokens?: number; wire_bytes?: number; usd?: number;
}
interface Overview {
  days: number; step: number; t0: number; n: number; tz: string;
  totals: { requests: number; ok: number; failed: number; success_rate: number | null; refused: number;
            rescued: number; rescued_by: { parts: number; catalog: number }; held: number; disk: number };
  routes: Record<RouteId, RouteFig>;
  consumers: { id: string; requests: number; ok: number; local: number; proxy: number; jina: number }[];
  cost: { price_per_gb: number; proxy_bytes: number; proxy_usd: number; jina_tokens: number };
  requests: TimeData; by_consumer: TimeData; proxy_usd: TimeData; jina_tokens: TimeData;
}

const ROUTES: { id: RouteId; name: string; about: string }[] = [
  { id: 'local', name: 'Local', about: 'from this machine' },
  { id: 'proxy', name: 'Proxy', about: 'through the proxy' },
  { id: 'jina', name: 'Jina', about: 'Reader and Search' },
];
const CONSUMER_NAMES: Record<string, string> = {
  parts: 'Drawer · LCSC lookups', catalog: 'Product Catalog', chat: 'Chat web tools', checks: 'Health checks and tests',
};
const ms = (v: number | null | undefined) => v == null ? '–' : v >= 1000 ? (v / 1000).toFixed(1) + ' s' : Math.round(v) + ' ms';

@Component({
  selector: 'app-traffic-overview',
  imports: [Skeleton, CountUp, MoneyView, T, TimeChart, BarList],
  styleUrl: './settings.css',
  template: `
<section class="st-card">
  <div class="st-card-head"><h3>{{ 'Data traffic' | t }}</h3>
    <span class="st-sub">{{ 'every outside lookup, by the route it took: directly, through the proxy or through Jina' | t }}</span>
    <div class="st-right"><div class="st-seg">
      @for (x of period.periods; track x.days) { <button [class.on]="period.days() === x.days" (click)="period.set(x.days)">{{ x.label }}</button> }
    </div></div>
  </div>
  <div class="st-card-body">
    @if (o(); as v) {
      <div class="st-tiles tr-tiles wb-in">
        <div class="st-tile hero" [attr.data-tone]="tone(v.totals.success_rate)"><span>{{ 'Outgoing requests' | t }} · {{ period.label() }}</span>
          <b [wbCount]="f.count(v.totals.requests)"></b>
          <small>{{ pct(v.totals.success_rate) }} {{ 'answered' | t }} · {{ f.count(v.totals.refused) }} {{ 'refused' | t }}</small></div>
        @for (r of routes; track r.id) {
          @if (v.routes[r.id]; as x) {
            <div class="st-tile" [attr.data-tone]="x.requests ? tone(x.success_rate) : 'dim'"
                 [title]="(r.about | t) + ' · ' + ('median' | t) + ' ' + ms(x.p50_ms) + (x.timed ? ' · p95 ' + ms(x.p95_ms) : '')">
              <span>{{ r.name | t }}</span><b [wbCount]="f.count(x.requests)"></b>
              <small>{{ pct(x.success_rate) }} · {{ ms(x.p50_ms) }}</small></div>
          }
        }
        <div class="st-tile" [title]="'measured on the wire between this machine and the proxy; priced from Settings > Costs' | t">
          <span>{{ 'Proxy on the wire' | t }}</span><b [wbCount]="f.bytes(v.cost.proxy_bytes)"></b>
          <small><wb-money [usd]="v.cost.proxy_usd" /> · @if (proxyPrice(); as pp) {<wb-money [amount]="pp.amount" [cur]="pp.currency" alt="tip" />} @else {<wb-money [usd]="v.cost.price_per_gb" />}/GB</small></div>
        <div class="st-tile"><span>{{ 'Jina tokens' | t }}</span><b [wbCount]="f.count(v.cost.jina_tokens)"></b>
          <small>{{ f.count(v.routes.jina.requests) }} {{ 'calls' | t }}</small></div>
        <div class="st-tile" [attr.data-tone]="v.totals.rescued ? 'ok' : null"
             [title]="'requests a later route answered after the first was refused or could not reach the site' | t">
          <span>{{ 'Refusals avoided' | t }}</span><b [wbCount]="f.count(v.totals.rescued)"></b>
          <small>{{ f.count(v.totals.held) }} {{ 'held back' | t }} · {{ f.count(v.totals.disk) }} {{ 'from disk' | t }}</small></div>
      </div>

      <div class="st-charts">
        <section class="st-chart c8"><h4>{{ 'Requests by route' | t }}<em>{{ f.count(v.totals.requests) }}</em></h4>
          <app-time-chart [data]="charts()!.requests" kind="bar" [f]="f.count" [height]="170" /></section>
        <section class="st-chart c4"><h4>{{ 'By consumer' | t }}</h4>
          <app-bar-list [rows]="consumers()" [f]="f.count" />
          <div class="tr-split">
            @for (c of v.consumers; track c.id) {
              @if (c.requests) {
                <div><span>{{ consumerName(c.id) | t }}</span>
                  <small class="mono">{{ 'Local' | t }} {{ f.count(c.local) }} · {{ 'Proxy' | t }} {{ f.count(c.proxy) }} · Jina {{ f.count(c.jina) }}</small></div>
              }
            }
          </div></section>
        <section class="st-chart c6"><h4>{{ 'Proxy cost' | t }} · {{ 'estimated from the bytes on the wire' | t }}<em [title]="usdTip(v.cost.proxy_usd)">{{ usd(v.cost.proxy_usd) }}</em></h4>
          <app-time-chart [data]="charts()!.usd" kind="area" [f]="fusd" [legend]="false" [height]="110" /></section>
        <section class="st-chart c6"><h4>{{ 'Jina tokens' | t }} · {{ 'used per bucket' | t }}<em>{{ f.count(v.cost.jina_tokens) }}</em></h4>
          <app-time-chart [data]="charts()!.tokens" kind="bar" [f]="f.count" [legend]="false" [height]="110" /></section>
      </div>
      <p class="st-hint">{{ 'The Product Catalog\\'s direct requests are counted per run, at its start, and are not timed one by one: the Local median is the part lookups\\'.' | t }}
        {{ 'Buckets are hours for 24h and days otherwise, in the server\\'s time zone' | t }} ({{ v.tz }}).</p>
    } @else if (err()) {
      <p class="st-err">{{ err() }}</p>
    } @else {
      <div class="wb-sk-stack"><wb-skel kind="tiles" [count]="8" [min]="100" /><wb-skel kind="chart" [h]="170" /></div>
    }
  </div>
</section>`,
})
export class TrafficOverview {
  private http = inject(HttpClient);
  readonly period = inject(TrafficPeriod);
  /** The price per GB as it was typed, in its own currency (Settings > Costs). */
  private cash = inject(Money);
  readonly proxyPrice = computed(() => this.cash.costs()?.proxy ?? null);
  readonly usdTip = usdTip;
  readonly f = fmt;
  readonly ms = ms;
  readonly routes = ROUTES;
  readonly fusd = (v: number) => money(v);
  o = signal<Overview | null>(null);
  err = signal<string | null>(null);

  constructor() {
    effect(() => {
      const d = this.period.days();
      this.err.set(null);
      this.http.get<Overview>(`/api/proxy/overview?days=${d}`).subscribe({
        next: r => { if (this.period.days() === d) this.o.set(r); },
        error: e => this.err.set(t('The usage figures did not load') + ` (${e?.status ?? '?'}).`),
      });
    });
  }

  /** The consumers by their requests, the busiest first. */
  consumers = computed<Row[]>(() => (this.o()?.consumers ?? []).filter(c => c.requests)
    .map(c => ({ name: t(this.consumerName(c.id)), value: c.requests,
                 sub: `${t('Local')} ${c.local} · ${t('Proxy')} ${c.proxy} · Jina ${c.jina}` }))
    .sort((a, b) => b.value - a.value));

  /** The charts' series under their names on the page. */
  charts = computed(() => {
    const v = this.o();
    return v ? { requests: this.named(v.requests), usd: this.named(v.proxy_usd), tokens: this.named(v.jina_tokens) } : null;
  });

  consumerName(id: string) { return CONSUMER_NAMES[id] ?? id; }
  /** The series under their names on the page (local, proxy, jina, …). */
  named(d: TimeData): TimeData {
    const names: Record<string, string> = { local: 'Local', proxy: 'Proxy', jina: 'Jina', 'proxy_usd': 'Proxy' };
    return { ...d, series: d.series.map(s => ({ ...s, name: t(names[s.name] ?? s.name) })) };
  }
  usd(v: number) { return money(v); }
  tone(v: number | null | undefined) { return v == null ? 'dim' : v >= 0.9 ? 'ok' : v >= 0.5 ? 'warn' : 'danger'; }
  pct(v: number | null | undefined) { return v == null ? '–' : (100 * v).toFixed(v === 1 ? 0 : 1) + '%'; }
}
