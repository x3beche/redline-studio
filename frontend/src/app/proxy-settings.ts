import { SecretInput } from './secret-input';
import { Component, computed, effect, inject, signal } from '@angular/core';
import { Toast } from './toast';
import { NgTemplateOutlet } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Auth } from './auth';
import { T, t } from './i18n';
import { BarList, Row, TimeChart, TimeData, fmt } from './rooms/charts';
import { when } from './llm-settings';
import { Money, MoneyView, money as shown, usdTip } from './money';
import { Prefs } from './preferences';
import { JinaSettingsPanel, TrafficPeriod, foldKeep, foldLoad } from './jina-settings';
import { McMasterSettingsPanel } from './mcmaster-settings';
import { TrafficOverview } from './traffic-overview';
import { RouteOrder } from './route-order';
import { SelectOption, UiSelect } from './ui-select';
import { CountUp } from './count';
import { Skeleton } from './skeleton';

/** Settings > Proxy & Data: the order of routes each outside lookup
 *  tries (backend/netroutes.py) - the Product Catalog's crawler and the
 *  Drawer's LCSC / EasyEDA part lookups - and the proxy, a second way out
 *  for them (backend/netproxy.py). Only those go through it - the model
 *  providers and everything else stay direct. The password is kept on the server
 *  and never shown again. Under the settings: where the lookups came out
 *  in the world, how fast and how reliably, what the periodic health check
 *  saw, and how much went through the proxy - the traffic 2Captcha bills.
 *  Beside it, Jina AI (jina-settings.ts): its key, its balance and its calls. */
/** Each lookup's order of routes and which routes are set up (backend/netroutes.py). */
export interface RoutesState {
  routes: Record<string, { ready: boolean; why: string | null }>;
  consumers: Record<string, { routes: string[]; order: string[]; default: string[] }>;
}
interface ProxySettings {
  scheme: string; host: string; port: number | null;
  username: string; password_set: boolean; configured: boolean; active: boolean; routes: RoutesState;
  sticky?: boolean; identify_exit?: boolean; country?: string; price_per_gb?: number; health_minutes?: number;
}
interface Exit { ok: boolean; ip?: string; country?: string; city?: string; org?: string; error?: string; ms: number }
interface LastTest { at: number; exits: Exit[]; rotates: boolean }
interface Named { name: string; n: number }
interface Lat { asks: number; ok: number; success_rate: number | null; p50_ms: number | null; p95_ms: number | null; bytes: number }
type At = string | number;

interface ProxyUsage {
  days: number; step: number;
  totals: { lookups: number; direct: number; proxy: number; refused: number; failed: number; disk: number;
            bytes_direct: number; bytes_proxy: number };
  lookups: TimeData; bytes: TimeData;
  by_kind: Named[];
  recent: { at: At; who: string; kind: string; target: string; source: string; status: number | null;
            via: string | null; ms: number; bytes: number; error: string | null }[];
  state: { budget?: number; window_s?: number; asks_in_window?: number; used?: number; refused_until?: number | null;
           refused_why?: string | null; now?: number; last_ask?: number | null; gap_s?: number; cool_off_s?: number;
           [k: string]: unknown };
  exits?: { by_country: Named[]; by_org: Named[]; by_city: Named[]; distinct_ips: number; identified: number };
  latency?: { direct: Lat; proxy: Lat; series: TimeData };
  health?: { every_minutes: number; checks: number; ok: number; uptime: number | null; p50_ms: number | null;
             last: null | { at: At; ok: boolean; ip?: string; country?: string; city?: string; org?: string;
                            region?: string; timezone?: string; ms?: number } };
  cost?: { gb: number; bytes?: number; price_per_gb: number; usd: number; note: string };
  /** Bytes counted on the wire between this machine and the proxy - TLS,
   *  headers and CONNECT included: what the provider bills. */
  metered?: { up: number; down: number; total: number; conns: number; since?: string | null; payload_bytes: number;
              by_host: { name: string; up: number; down: number; conns: number }[]; series: TimeData };
  log?: { at: At; kind: string; target: string; via: string | null; status: number | null; ms: number; bytes: number;
          attempt: string; error: string | null; ip: string | null; country: string | null; city: string | null;
          org: string | null; exit_ms: number | null; wire_up?: number | null; wire_down?: number | null; exit_wire?: number | null }[];
}

/** The lookups with an order of routes, as the page names them. */
const CONSUMERS = [
  { id: 'catalog', label: 'Product Catalog', about: 'makers\' web pages; robots.txt and sitemaps never through Jina' },
  { id: 'parts', label: 'Drawer', about: 'LCSC / EasyEDA part lookups (JSON, so no Jina)' },
];
const LAST_TEST = 'redline.settings.proxy.lastTest';
const HEALTH = [0, 5, 15, 30, 60, 180, 1440];
const ms = (v: number) => v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1) + ' s' : Math.round(v) + ' ms';

@Component({
  selector: 'app-proxy-settings',
  imports: [SecretInput, CountUp, Skeleton, MoneyView, T, TimeChart, BarList, NgTemplateOutlet, JinaSettingsPanel, McMasterSettingsPanel, RouteOrder, UiSelect, TrafficOverview],
  styleUrl: './settings.css',
  template: `
<ng-template #periodSeg>
  <div class="st-seg">
    @for (x of period.periods; track x.days) { <button [class.on]="period.days() === x.days" (click)="period.set(x.days)">{{ x.label }}</button> }
  </div>
</ng-template>

@if (data(); as d) {
<div class="st-page wb-in">
  <p class="st-lead">{{ 'EasyEDA turns a burst of part lookups away for a while, and some sites turn a crawler away. The route order says which way each lookup tries first - directly, through the proxy or through Jina - and which next. The model providers and everything else always go out directly.' | t }}
    {{ 'Jina AI reads web pages and searches the web for the Product Catalog and the Chat.' | t }}</p>
  @if (!canEdit) { <div class="st-banner">{{ 'These are the server\\'s settings: only the owner and the admins can change them.' | t }}</div> }

  <!-- Which way each lookup tries first, and next -->
  <section class="st-card">
    <div class="st-card-head"><h3>{{ 'Route order' | t }}</h3>
      <span class="st-sub">{{ 'each lookup tries the first route that is on; when it is refused or cannot reach the site, the next' | t }}</span>
      @if (st()) {
        <span class="st-right ro-state" [title]="st()?.refused_why || ''">EasyEDA
          <span class="st-tag" [attr.data-tone]="refusedNow() ? 'warn' : 'ok'">{{ (refusedNow() ? 'refusing' : 'answering') | t }}</span>
          <span class="st-sub">{{ refusedNow() ? ('until' | t) + ' ' + when(st()?.refused_until) : budgetText() }}</span></span>
      }</div>
    <div class="st-card-body ro-rows">
      @for (c of consumers; track c.id) {
        @if (d.routes.consumers[c.id]; as rc) {
          <div class="ro-row">
            <div class="ro-who"><b>{{ c.label | t }}</b><small>{{ c.about | t }}</small></div>
            <app-route-order [routes]="rc.routes" [order]="rc.order" [ready]="whyNot()" [editable]="canEdit && !busy()"
                             (changed)="saveOrder(c.id, $event)" />
          </div>
        }
      }
      @if (orderErr(); as e) { <p class="st-err">{{ e }}</p> }
    </div>
  </section>

  <!-- The settings, folded like an LLM provider's card: open while a proxy is set up -->
  <section class="st-card pv" [attr.data-open]="open() ? 1 : null">
    <div class="pv-head">
    <button type="button" class="pv-toggle" (click)="toggle()" [attr.aria-expanded]="open()"
            [attr.aria-label]="(open() ? 'Collapse' : 'Expand') | t">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="open() ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6'" /></svg>
      <h3>{{ 'Proxy' | t }}</h3>
    </button>
      <span class="pv-meta" [attr.data-tone]="d.active ? null : 'warn'">{{ d.active ? proxyUse() : ((d.configured ? 'in no route order' : 'Not set up') | t) }}{{ d.host ? ' · ' + d.host : '' }}</span>
      @if (traffic(); as tr) {
        <span class="pv-right pv-meta" [title]="('through the proxy in this period, measured on the wire, and what it costs' | t) + (tr.usd != null && usdTip(tr.usd) ? ' · ' + usdTip(tr.usd) : '')">
          <b class="mono" [wbCount]="f.bytes(tr.bytes)"></b><span [wbCount]="tr.usd != null ? ' · ' + money(tr.usd) : ''"></span> · {{ period.label() }}</span>
      }
    </div>
    @if (open()) {
    <div class="st-card-body">
      <div class="st-sec-title">{{ 'Connection' | t }}</div>
      <div class="st-grid">
        <label class="st-f" style="grid-column: span 2"><span>{{ 'Host' | t }}</span>
          <input class="st-in" [value]="host()" [disabled]="!canEdit" placeholder="ap.proxy.2captcha.com" (input)="host.set($any($event.target).value)"></label>
        <label class="st-f"><span>{{ 'Port' | t }}</span>
          <input class="st-in" type="number" [value]="port()" [disabled]="!canEdit" placeholder="2334" (input)="port.set($any($event.target).value)"></label>
        <label class="st-f" style="grid-column: span 2"><span>{{ 'Username' | t }}</span>
          <input class="st-in" [value]="user()" [disabled]="!canEdit" autocomplete="off" (input)="user.set($any($event.target).value)"></label>
        <label class="st-f"><span>{{ 'Password' | t }}</span>
          <input class="st-in" type="password" wbSecret [value]="pass()" [disabled]="!canEdit"
                 [placeholder]="(d.password_set ? 'kept - type to replace' : '') | t" (input)="pass.set($any($event.target).value)"></label>
      </div>

      <div class="st-sec-title">{{ 'Where it comes out' | t }}</div>
      <div class="st-grid">
        <div class="st-f"><span>{{ 'Exit address' | t }}</span>
          <div class="st-seg">
            <button [class.on]="d.sticky !== false" [disabled]="!canEdit" (click)="save({ sticky: true })"
                    [title]="'every lookup gets its own session: a new address, held for that lookup' | t">{{ 'One per lookup' | t }}</button>
            <button [class.on]="d.sticky === false" [disabled]="!canEdit" (click)="save({ sticky: false })"
                    [title]="'the provider may change the address on every request' | t">{{ 'Every request' | t }}</button>
          </div></div>
        <div class="st-f"><span>{{ 'Identify the exit' | t }}</span>
          <div class="st-seg">
            <button [class.on]="d.identify_exit !== false" [disabled]="!canEdit" (click)="save({ identify_exit: true })"
                    [title]="'after a proxied lookup, one ~1 kB look at where it came out' | t">{{ 'On' | t }}</button>
            <button [class.on]="d.identify_exit === false" [disabled]="!canEdit" (click)="save({ identify_exit: false })">{{ 'Off' | t }}</button>
          </div></div>
        <label class="st-f"><span>{{ 'Country' | t }} <span class="st-dim">· {{ '2 letters, empty = anywhere' | t }}</span></span>
          <input class="st-in" maxlength="2" [value]="country()" [disabled]="!canEdit" [placeholder]="'Anywhere' | t"
                 (input)="country.set($any($event.target).value)"></label>
        <div class="st-f"><span>{{ 'Price per GB' | t }}</span>
          <span class="st-readout">
            @if (proxyPrice(); as pp) {
              <wb-money class="mono" [amount]="pp.amount" [cur]="pp.currency" />
            } @else { <span class="st-dim">{{ 'not set' | t }}</span> }
            <button class="st-more" (click)="prefs.tab.set('costs')">{{ 'Edit in Settings > Costs' | t }} →</button>
          </span></div>
        <label class="st-f"><span>{{ 'Health check' | t }}</span>
          <wb-select class="st-sel" label="Health check" [options]="healthOpts()" [value]="'' + (d.health_minutes ?? 30)" [disabled]="!canEdit"
                     (pick)="save({ health_minutes: +$event })" /></label>
      </div>
      <p class="st-hint">{{ 'A rotating residential proxy with no country in the username comes out somewhere new in the world on each lookup (2Captcha: the -zone-custom username, no region).' | t }}</p>
      @if (canEdit) {
        <div class="st-row">
          <button class="tcv-btn tcv-files-btn" [disabled]="busy()" (click)="saveConnection()">{{ 'Save' | t }}</button>
          <button class="tcv-btn tcv-files-btn" [disabled]="testing() || !d.host" (click)="test()">{{ testing() ? '…' : ('Test' | t) }}</button>
          @if (err(); as e) { <p class="st-err">{{ e }}</p> }
        </div>
      }
      @if (exits(); as ex) {
        <div class="st-tiles">
          @for (e of ex.exits; track $index) {
            @if (e.ok) {
              <div class="st-tile" data-tone="ok"><span>{{ 'Exit' | t }} {{ $index + 1 }} · {{ e.ms }} ms</span><b>{{ e.ip }}</b>
                <small>{{ e.country }}{{ e.city ? ', ' + e.city : '' }} · {{ e.org }}</small></div>
            } @else {
              <div class="st-tile" data-tone="danger"><span>{{ 'Exit' | t }} {{ $index + 1 }}</span><b>{{ 'failed' | t }}</b>
                <small [title]="e.error || ''">{{ e.error }}</small></div>
            }
          }
          @if (ex.exits[0]?.ok) {
            <div class="st-tile"><span>{{ 'Rotation' | t }}</span><b>{{ (ex.rotates ? 'rotates' : 'sticky') | t }}</b>
              <small>{{ (ex.rotates ? 'A new address each time.' : 'The same address both times.') | t }}</small></div>
          }
        </div>
      }

      <!-- Where the proxied lookups came out, and how fast -->
      <div class="st-sec-head"><span class="st-sec-title">{{ 'Exits' | t }}</span>
        <span class="st-sub">{{ 'where the proxied lookups came out, and how fast' | t }}</span>
        <div class="st-right"><ng-container [ngTemplateOutlet]="periodSeg" /></div></div>
      @if (u(); as us) {
        <div class="st-tiles six wb-in">
          <div class="st-tile"><span>{{ 'Exit addresses' | t }}</span><b [wbCount]="us.exits?.distinct_ips ?? 0"></b>
            <small>{{ us.exits?.identified ?? 0 }} {{ 'identified' | t }}</small></div>
          <div class="st-tile"><span>{{ 'Countries' | t }}</span><b [wbCount]="us.exits?.by_country?.length ?? 0"></b>
            <small>{{ us.exits?.by_org?.length ?? 0 }} {{ 'networks' | t }}</small></div>
          <div class="st-tile" [attr.data-tone]="rateTone(us.latency?.proxy?.success_rate)"><span>{{ 'Success via proxy' | t }}</span>
            <b [wbCount]="pct1(us.latency?.proxy?.success_rate)"></b>
            <small>{{ us.latency?.proxy?.ok ?? 0 }} / {{ us.latency?.proxy?.asks ?? 0 }} {{ 'asks' | t }}</small></div>
          <div class="st-tile" [attr.data-tone]="rateTone(us.latency?.direct?.success_rate)"><span>{{ 'Success direct' | t }}</span>
            <b [wbCount]="pct1(us.latency?.direct?.success_rate)"></b>
            <small>{{ us.latency?.direct?.ok ?? 0 }} / {{ us.latency?.direct?.asks ?? 0 }} {{ 'asks' | t }}</small></div>
          <div class="st-tile"><span>{{ 'Latency via proxy' | t }}</span><b [wbCount]="msOr(us.latency?.proxy?.p50_ms)"></b>
            <small>p95 {{ msOr(us.latency?.proxy?.p95_ms) }}</small></div>
          <div class="st-tile"><span>{{ 'Latency direct' | t }}</span><b [wbCount]="msOr(us.latency?.direct?.p50_ms)"></b>
            <small>p95 {{ msOr(us.latency?.direct?.p95_ms) }}</small></div>
          @if (us.health; as h) {
            <div class="st-tile" [attr.data-tone]="h.last ? (h.last.ok ? 'ok' : 'danger') : 'dim'"><span>{{ 'Exit health' | t }}</span>
              <b [wbCount]="h.uptime == null ? (h.every_minutes ? ('waiting' | t) : ('off' | t)) : pct1(h.uptime)"></b>
              <small>{{ h.checks }} {{ 'checks' | t }}{{ h.every_minutes ? ' · ' + ('every' | t) + ' ' + h.every_minutes + ' min' : '' }}</small></div>
          } @else {
            <div class="st-tile" [attr.data-tone]="lastTest() ? (lastTest()!.exits[0]?.ok ? 'ok' : 'danger') : 'dim'"><span>{{ 'Last test' | t }}</span>
              @if (lastTest(); as lt) {
                <b>{{ lt.exits[0]?.ok ? lt.exits[0].ip : ('failed' | t) }}</b><small>{{ when(lt.at) }}</small>
              } @else { <b>{{ 'not tested' | t }}</b><small>{{ 'in this browser' | t }}</small> }
            </div>
          }
        </div>
        @if (us.exits?.identified) {
          <div class="st-charts">
            <!-- The top ten of each, the rest on asking: a hundred cities
                 made this card longer than the page. -->
            <section class="st-chart c4"><h4>{{ 'Countries' | t }}</h4>
              <app-bar-list [rows]="top(named(us.exits!.by_country))" [f]="f.count" /></section>
            <section class="st-chart c4"><h4>{{ 'Cities' | t }}</h4>
              <app-bar-list [rows]="top(named(us.exits!.by_city))" [f]="f.count" /></section>
            <section class="st-chart c4"><h4>{{ 'Networks (ISP)' | t }}</h4>
              <app-bar-list [rows]="top(named(us.exits!.by_org))" [f]="f.count" /></section>
          </div>
          @if (longest(us.exits!.by_country, us.exits!.by_city, us.exits!.by_org) > TOP) {
            <button class="st-more" (click)="exitsAll.set(!exitsAll())">
              {{ exitsAll() ? ('Show the top 10' | t) : ('Show all' | t) }}
              @if (!exitsAll()) { <span class="st-sub">· {{ us.exits!.by_country?.length ?? 0 }} {{ 'countries' | t }},
                {{ us.exits!.by_city?.length ?? 0 }} {{ 'cities' | t }}, {{ us.exits!.by_org?.length ?? 0 }} {{ 'networks' | t }}</span> }
            </button>
          }
        }
        @if (us.latency?.series; as ls) {
          <div class="st-charts">
            <section class="st-chart"><h4>{{ 'Latency' | t }} · {{ 'average per bucket, direct and through the proxy' | t }}</h4>
              <app-time-chart [data]="ls" kind="line" [stacked]="false" [sums]="false" [f]="fms" [height]="140" /></section>
          </div>
        }
        @if (us.health?.last; as hl) {
          <p class="st-hint">{{ 'Last health check' | t }} {{ when(hl.at) }}:
            @if (hl.ok) {
              <span class="st-ok">✓</span> <span class="mono">{{ hl.ip }}</span> · {{ hl.city }}{{ hl.region ? ', ' + hl.region : '' }} ({{ hl.country }}) · {{ hl.org }} · {{ msOr(hl.ms) }}
            } @else { <span class="st-err">✕ {{ 'failed' | t }}</span> }
            · {{ 'median' | t }} {{ msOr(us.health!.p50_ms) }}
          </p>
        }
      } @else if (usageErr()) { <p class="st-err">{{ usageErr() }}</p> } @else { <wb-skel kind="tiles" [count]="6" [min]="92" /> }

      <!-- The EasyEDA / LCSC lookups and what the proxy carried -->
      <div class="st-sec-head"><span class="st-sec-title">{{ 'Lookups' | t }}</span>
        <span class="st-sub">{{ 'EasyEDA / LCSC, from the request journal' | t }}</span></div>
      @if (u(); as us) {
        <div class="st-tiles six wb-in">
          <div class="st-tile"><span>{{ 'Lookups' | t }}</span><b [wbCount]="f.count(us.totals.lookups)"></b>
            <small>{{ f.count(us.totals.disk) }} {{ 'more answered from disk' | t }}</small></div>
          <div class="st-tile"><span>{{ 'Direct' | t }}</span><b [wbCount]="f.count(us.totals.direct)"></b><small>{{ pct(us.totals.direct, us.totals.lookups) }}</small></div>
          <div class="st-tile"><span>{{ 'Via proxy' | t }}</span><b [wbCount]="f.count(us.totals.proxy)"></b><small>{{ pct(us.totals.proxy, us.totals.lookups) }}</small></div>
          <div class="st-tile" [attr.data-tone]="us.totals.refused ? 'warn' : null"><span>{{ 'Refused' | t }}</span><b [wbCount]="f.count(us.totals.refused)"></b>
            <small>{{ pct(us.totals.refused, us.totals.lookups) }}</small></div>
          <div class="st-tile" [attr.data-tone]="us.totals.failed ? 'danger' : null"><span>{{ 'Failed' | t }}</span><b [wbCount]="f.count(us.totals.failed)"></b>
            <small>{{ pct(us.totals.failed, us.totals.lookups) }}</small></div>
          @if (us.cost; as c) {
            <div class="st-tile" [title]="c.note + (usdTip(c.usd) ? ' · ' + usdTip(c.usd) : '')"><span>{{ 'Estimated cost' | t }}</span><b [wbCount]="money(c.usd)"></b>
              <small>{{ c.bytes != null ? f.bytes(c.bytes) : gb(c.gb) }} · @if (proxyPrice(); as pp) {<wb-money [amount]="pp.amount" [cur]="pp.currency" alt="tip" />} @else {<span>{{ money(c.price_per_gb) }}</span>}/GB</small></div>
          }
        </div>
        @if (us.totals.lookups) {
          <div class="st-charts">
            <section class="st-chart c8"><h4>{{ 'Lookups over time' | t }}<em>{{ us.totals.lookups }}</em></h4>
              <app-time-chart [data]="us.lookups" kind="bar" [f]="f.count" [height]="170" /></section>
            <section class="st-chart c4"><h4>{{ 'By kind' | t }}</h4>
              <app-bar-list [rows]="named(us.by_kind)" [f]="f.count" /></section>
            @if (us.metered; as m) {
              <section class="st-chart c8"><h4>{{ 'Proxy traffic on the wire' | t }} · {{ 'sent and received' | t }}
                  <em>{{ f.bytes(m.total) }}</em></h4>
                <app-time-chart [data]="m.series" kind="bar" [f]="f.bytes" [height]="150" /></section>
              <section class="st-chart c4"><h4>{{ 'By host' | t }}<em>{{ m.conns }} {{ 'connections' | t }}</em></h4>
                <app-bar-list [rows]="hostRows(m.by_host)" [f]="f.bytes" />
                <div class="st-tiles" style="margin-top: 8px">
                  <div class="st-tile"><span>{{ 'sent' | t }}</span><b [wbCount]="f.bytes(m.up)"></b></div>
                  <div class="st-tile"><span>{{ 'received' | t }}</span><b [wbCount]="f.bytes(m.down)"></b></div>
                </div></section>
            }
            <section class="st-chart"><h4>{{ 'App payload' | t }} · {{ 'direct and through the proxy' | t }}
                <em>{{ f.bytes(us.totals.bytes_proxy) }} {{ 'via proxy' | t }}</em></h4>
              <app-time-chart [data]="us.bytes" kind="area" [f]="f.bytes" [height]="130" /></section>
          </div>
        } @else {
          <div class="st-empty">{{ 'No lookups in this period.' | t }}</div>
        }

        <section class="st-chart">
          <h4>{{ (table() === 'proxy' ? 'Proxy log' : 'Latest lookups') | t }}
            <em>{{ table() === 'proxy' ? (us.log?.length ?? 0) : us.recent.length }}</em></h4>
          <div class="st-row" style="margin-bottom: 6px">
            <div class="st-seg">
              <button [class.on]="table() === 'proxy'" (click)="table.set('proxy')">{{ 'Through the proxy' | t }}</button>
              <button [class.on]="table() === 'all'" (click)="table.set('all')">{{ 'All lookups' | t }}</button>
            </div>
          </div>
          <div class="st-table-wrap">
            @if (table() === 'proxy') {
              <table class="st-table">
                <thead><tr><th>{{ 'when' | t }}</th><th>{{ 'attempt' | t }}</th><th>{{ 'target' | t }}</th>
                  <th>{{ 'exit' | t }}</th><th>{{ 'result' | t }}</th>
                  <th class="r">ms</th><th class="r">{{ 'on the wire' | t }}</th></tr></thead>
                <tbody>
                  @for (r of more() ? (us.log ?? []) : (us.log ?? []).slice(0, 12); track $index) {
                    <tr [title]="r.error || ''">
                      <td class="dim mono">{{ when(r.at) }}</td>
                      <td><span class="st-tag" [attr.data-tone]="r.attempt === 'fallback' ? 'warn' : r.attempt === 'first' ? 'accent' : null">{{ r.attempt }}</span></td>
                      <td class="give-s mono" [title]="r.kind + ': ' + r.target">{{ r.attempt === 'health' || r.attempt === 'test' ? r.kind : r.target }}</td>
                      <td class="give st-exit" [title]="(r.org || '') + (r.exit_ms ? ' · ' + msOr(r.exit_ms) : '')">
                        @if (r.ip) {
                          <span class="mono">{{ r.ip }}</span>
                          <small>@if (r.country) { <b class="mono">{{ r.country }}</b> } {{ r.city || '' }}{{ r.org ? ' · ' + r.org : '' }}</small>
                        } @else { <span class="dim">–</span> }
                      </td>
                      <td><span class="st-tag" [attr.data-tone]="r.error ? 'danger' : 'ok'">{{ r.error ? ('error' | t) : (r.status ?? 'ok') }}</span></td>
                      <td class="r mono dim">{{ r.ms ? msOr(r.ms) : '–' }}</td>
                      <td class="r mono" [title]="wireTip(r)">{{ wire(r) }}</td>
                    </tr>
                  } @empty {
                    <tr><td colspan="7" class="dim">{{ 'Nothing has gone through the proxy in this period.' | t }}</td></tr>
                  }
                </tbody>
              </table>
            } @else {
              <table class="st-table">
                <thead><tr><th>{{ 'when' | t }}</th><th>{{ 'who' | t }}</th><th>{{ 'kind' | t }}</th><th>{{ 'target' | t }}</th>
                  <th>{{ 'result' | t }}</th><th>{{ 'via' | t }}</th><th class="r">ms</th><th class="r">{{ 'size' | t }}</th></tr></thead>
                <tbody>
                  @for (r of more() ? us.recent : us.recent.slice(0, 12); track $index) {
                    <tr [title]="r.error || ''">
                      <td class="dim mono">{{ when(r.at) }}</td><td class="dim">{{ r.who }}</td><td>{{ r.kind }}</td>
                      <td class="mono give" [title]="r.target">{{ r.target }}</td>
                      <td><span class="st-tag" [attr.data-tone]="tone(r.source)">{{ r.source }}{{ r.status ? ' ' + r.status : '' }}</span></td>
                      <td>@if (r.source === 'refused' || r.source === 'disk') { <span class="dim">–</span> }
                          @else { <span class="st-tag" [attr.data-tone]="r.via === 'proxy' ? 'accent' : null">{{ r.via || 'direct' }}</span> }</td>
                      <td class="r mono dim">{{ r.ms ? msOr(r.ms) : '–' }}</td><td class="r mono">{{ r.bytes ? f.bytes(r.bytes) : '–' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            }
          </div>
          @if ((table() === 'proxy' ? (us.log?.length ?? 0) : us.recent.length) > 12) {
            <button class="st-more" (click)="more.set(!more())">{{ (more() ? 'Show fewer' : 'Show all') | t }}</button>
          }
        </section>
      } @else if (usageErr()) {
        <p class="st-err">{{ usageErr() }}</p>
      } @else {
        <div class="wb-sk-stack"><wb-skel kind="tiles" [count]="6" [min]="92" /><wb-skel kind="chart" [h]="170" /><wb-skel kind="rows" [count]="6" /></div>
      }
      <p class="st-hint">{{ 'The cost is an estimate from the bytes Workbench sent and received through the proxy; the provider\\'s own meter is the bill.' | t }}
        {{ '2Captcha bills the traffic that goes through the proxy. Its balance is on 2Captcha\\'s own dashboard - Workbench keeps no 2Captcha API key.' | t }}
        <a href="https://2captcha.com/enterpage" target="_blank" rel="noopener">2captcha.com ↗</a></p>
    </div>
    }
  </section>

  <!-- Jina AI: reading web pages and searching, its key and its calls -->
  <app-jina-settings />

  <!-- McMaster-Carr's API: access pending; its credentials kept, nothing called yet (mcmaster-settings.ts) -->
  <app-mcmaster-settings />

  <!-- Jina AI's and the proxy's traffic together, always in sight -->
  <app-traffic-overview />
  @if (!canEdit) {
    @if (err(); as e) { <p class="st-err">{{ e }}</p> }
  }
</div>
} @else {
  <div class="st-page">@if (err()) { <p class="st-lead">{{ err() }}</p> } @else { <wb-skel kind="page" [count]="2" /> }</div>
}`,
})
export class ProxySettingsPanel {
  private http = inject(HttpClient);
  private auth = inject(Auth);
  readonly canEdit = this.auth.can('settings');
  readonly f = fmt;
  readonly fms = ms;
  readonly when = when;
  readonly health = HEALTH;
  healthOpts = computed<SelectOption[]>(() => this.health.map(m => ({ value: '' + m,
    label: m ? t('every') + ' ' + (m >= 60 ? m / 60 + ' h' : m + ' min') : t('Off') })));
  readonly consumers = CONSUMERS;
  data = signal<ProxySettings | null>(null);
  /** The proxy card opened or closed by hand in this browser; otherwise open while a proxy is set up. */
  private opened = signal<boolean | null>(foldLoad('redline.settings.proxy.open'));
  open = computed(() => this.opened() ?? !!(this.data()?.active || this.data()?.host));
  toggle() { const v = !this.open(); this.opened.set(v); foldKeep('redline.settings.proxy.open', v); }
  host = signal('');
  port = signal<string | number>('');
  user = signal('');
  pass = signal('');
  country = signal('');
  /** The price of proxy traffic is one of the costs now (Settings > Costs & currency). */
  private moneyState = inject(Money);
  readonly prefs = inject(Prefs);
  proxyPrice = computed(() => this.moneyState.costs()?.proxy ?? null);
  readonly usdTip = usdTip;
  busy = signal(false);
  testing = signal(false);
  exits = signal<{ exits: Exit[]; rotates: boolean } | null>(null);
  lastTest = signal<LastTest | null>(this.readLast());
  err = signal<string | null>(null);
  /** The period of every figure on the page, one for all (jina-settings.ts). */
  readonly period = inject(TrafficPeriod);
  u = signal<ProxyUsage | null>(null);
  usageErr = signal<string | null>(null);
  table = signal<'proxy' | 'all'>('proxy');
  more = signal(false);

  /** Why each route cannot be used now, for the route order's chips. */
  whyNot = computed(() => {
    const r = this.data()?.routes.routes ?? {};
    return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.ready ? null : t(v.why ?? 'not set up')]));
  });
  /** Where the proxy comes in each lookup's order: "Drawer #1 · Product Catalog #2". */
  proxyUse = computed(() => {
    const c = this.data()?.routes.consumers ?? {};
    return CONSUMERS.filter(x => c[x.id]?.order.includes('proxy'))
      .map(x => `${t(x.label)} #${c[x.id].order.indexOf('proxy') + 1}`).join(' · ');
  });
  st = computed(() => this.u()?.state ?? null);
  refusedNow = computed(() => {
    const s = this.st();
    return !!s?.refused_until && s.refused_until > (s.now ?? Date.now() / 1000);
  });
  budgetText = computed(() => {
    const s = this.st();
    if (!s || s.budget == null) return '';
    const used = s.asks_in_window ?? s.used ?? 0;
    return `${used} / ${s.budget} ${t('asks')} · ${fmt.secs(s.window_s ?? 0)}`;
  });
  /** The proxy's traffic in the period, for the folded card's line: on the wire when metered. */
  traffic = computed(() => {
    const us = this.u();
    if (!us) return null;
    return { bytes: us.metered ? us.metered.total : us.totals.bytes_proxy, usd: us.cost ? us.cost.usd : null };
  });

  constructor() {
    this.http.get<ProxySettings>('/api/proxy/settings').subscribe({
      next: d => this.take(d), error: e => this.err.set(this.text(e)),
    });
    effect(() => {
      const d = this.period.days();
      this.usageErr.set(null);
      this.http.get<ProxyUsage>(`/api/proxy/usage?days=${d}`).subscribe({
        next: r => { if (this.period.days() === d) this.u.set(r); },
        error: e => this.usageErr.set(t('The usage figures did not load') + ` (${e?.status ?? '?'}).`),
      });
    });
  }

  private readLast(): LastTest | null {
    try { return JSON.parse(localStorage.getItem(LAST_TEST) ?? 'null'); } catch { return null; }
  }

  pct(n: number, of: number) { return of ? Math.round(100 * n / of) + '%' : '–'; }
  pct1(v: number | null | undefined) { return v == null ? '–' : (100 * v).toFixed(v === 1 ? 0 : 1) + '%'; }
  rateTone(v: number | null | undefined) { return v == null ? 'dim' : v >= 0.9 ? 'ok' : v >= 0.5 ? 'warn' : 'danger'; }
  msOr(v: number | null | undefined) { return v == null ? '–' : ms(v); }
  /** Dollars from the server, in the display currency (money.ts). */
  money(v: number) { return shown(v); }
  gb(v: number) { return v >= 0.1 ? v.toFixed(2) + ' GB' : fmt.bytes(Math.round(v * 1e9)); }
  tone(source: string) {
    return source === 'refused' ? 'warn' : source === 'failed' || source === 'error' ? 'danger'
      : source === 'proxy' ? 'accent' : source === 'disk' ? null : 'ok';
  }
  hostRows(list: { name: string; up: number; down: number; conns: number }[]): Row[] {
    return list.map(h => ({ name: h.name, value: h.up + h.down, sub: `${h.conns} conns` })).sort((a, b) => b.value - a.value);
  }
  /** A log row's bytes on the wire (sent + received + the exit look), or its payload when not metered. */
  wire(r: NonNullable<ProxyUsage['log']>[number]): string {
    const w = (r.wire_up ?? 0) + (r.wire_down ?? 0) + (r.exit_wire ?? 0);
    if (r.wire_up != null || r.wire_down != null || r.exit_wire != null) return w ? fmt.bytes(w) : '–';
    return r.bytes ? fmt.bytes(r.bytes) + '*' : '–';
  }
  wireTip(r: NonNullable<ProxyUsage['log']>[number]): string {
    if (r.wire_up == null && r.wire_down == null && r.exit_wire == null) return r.bytes ? t('payload only, not metered') : '';
    return `${t('sent')} ${fmt.bytes(r.wire_up ?? 0)} · ${t('received')} ${fmt.bytes(r.wire_down ?? 0)}`
      + (r.exit_wire ? ` · ${t('exit look')} ${fmt.bytes(r.exit_wire)}` : '');
  }
  /** Exits lists: the top ten until asked for all. */
  readonly TOP = 10;
  exitsAll = signal(false);
  top<T>(rows: T[]): T[] { return this.exitsAll() ? rows : rows.slice(0, this.TOP); }
  longest(...lists: (unknown[] | null | undefined)[]): number { return Math.max(0, ...lists.map(l => l?.length ?? 0)); }

  named(list: Named[]): Row[] {
    return list.map(k => ({ name: k.name, value: k.n })).sort((a, b) => b.value - a.value);
  }

  private take(d: ProxySettings) {
    this.data.set(d);
    this.host.set(d.host);
    this.port.set(d.port ?? '');
    this.user.set(d.username);
    this.pass.set('');
    this.country.set(d.country ?? '');
  }

  orderErr = signal<string | null>(null);
  saveOrder(consumer: string, order: string[]) {
    this.busy.set(true);
    this.orderErr.set(null);
    this.http.put<RoutesState>('/api/proxy/routes', { consumer, order }).subscribe({
      next: routes => {
        const d = this.data();
        if (d) this.data.set({ ...d, routes, active: !!d.configured && Object.values(routes.consumers).some(c => c.order.includes('proxy')) });
        this.busy.set(false);
      },
      error: e => { this.busy.set(false); this.orderErr.set(this.text(e)); },
    });
  }

  saveConnection() {
    const body: Record<string, unknown> = { host: this.host().trim(), username: this.user().trim() };
    const port = Number(this.port());
    if (port) body['port'] = port;
    if (this.pass()) body['password'] = this.pass();
    const d = this.data();
    if (d && 'country' in d) body['country'] = this.country().trim().toUpperCase();
    this.save(body);
  }

  save(body: Record<string, unknown>) {
    this.busy.set(true);
    this.err.set(null);
    this.http.put<ProxySettings>('/api/proxy/settings', body).subscribe({
      next: d => {
        this.take(d);
        this.busy.set(false);
        Toast.show(t('Saved.'), { tone: 'ok' });
      },
      error: e => { this.busy.set(false); this.err.set(this.text(e)); },
    });
  }

  test() {
    this.testing.set(true);
    this.exits.set(null);
    this.http.post<{ exits: Exit[]; rotates: boolean }>('/api/proxy/test', {}).subscribe({
      next: r => {
        this.exits.set(r);
        this.testing.set(false);
        const last: LastTest = { at: Date.now(), ...r };
        this.lastTest.set(last);
        try { localStorage.setItem(LAST_TEST, JSON.stringify(last)); } catch { /* private window */ }
      },
      error: e => { this.err.set(this.text(e)); this.testing.set(false); },
    });
  }

  private text(e: unknown): string {
    const err = e as { error?: { detail?: unknown }; message?: string };
    return typeof err?.error?.detail === 'string' ? err.error.detail : (err?.message ?? t('Something went wrong.'));
  }
}
