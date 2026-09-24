import { NgTemplateOutlet } from '@angular/common';
import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { InsightSeries, Insights, InsightsApi } from '../api';
import { BarList, Donut, Fmt, Row, TimeChart, fmt } from './charts';

type Section = 'overview' | 'llm' | 'machine' | 'work' | 'storage' | 'projects' | 'lcsc';

/** The Analytics room: everything the app has used, over a range.
 *
 *  A dashboard in the Grafana manner - a range and a refresh at the top,
 *  then rows of panels that fold away - reading one answer from
 *  /api/insights: LLM tokens and money, the machine and its energy, the
 *  work done in each room, what is stored, each project, and the part
 *  supplier. Money for LLMs is at API list prices: on a subscription it
 *  is what the same work would have cost, not what was paid.
 */
@Component({
  selector: 'app-room-analyze',
  imports: [BarList, Donut, NgTemplateOutlet, TimeChart],
  template: `
<div class="tcv-room tcv-dash absolute inset-0 flex min-h-0 flex-col">
  <header class="tcv-dash-bar">
    <span class="tcv-dash-title">Analytics</span>
    <div class="tcv-dash-seg" role="group" aria-label="range">
      @for (r of ranges; track r.id) {
        <button (click)="setRange(r.id)" [attr.data-on]="range() === r.id ? 1 : null">{{ r.label }}</button>
      }
    </div>
    <span class="flex-1"></span>
    @if (data(); as d) {
      <span class="tcv-dash-meta">{{ stepLabel(d.range.step) }} · updated {{ updated() }}</span>
    }
    <select class="tcv-field px-1.5 py-0.5 text-[11.5px]" [value]="every()"
            (change)="setEvery(+$any($event.target).value)" title="refresh on its own">
      @for (e of everys; track e.s) { <option [value]="e.s" [selected]="every() === e.s">{{ e.label }}</option> }
    </select>
    <button (click)="load()" class="tcv-btn px-2 py-0.5" [disabled]="loading()" title="read it again">
      {{ loading() ? '…' : '↻' }}
    </button>
  </header>

  <div class="tcv-dash-body tcv-scroll min-h-0 flex-1 overflow-y-auto">
    @if (error(); as e) { <p class="tcv-dash-note" style="color: var(--danger)">{{ e }}</p> }
    @if (data(); as d) {

    <!-- OVERVIEW -->
    <ng-container *ngTemplateOutlet="head; context: { id: 'overview', title: 'Overview', sub: rangeLabel() }" />
    @if (open('overview')) {
      <div class="tcv-dash-grid">
        <div class="tcv-stat c2"><span>LLM spend</span><b>{{ f.money(d.llm.cost_usd) }}</b>
          <em>at API list prices · {{ f.count(d.llm.calls) }} calls</em></div>
        <div class="tcv-stat c2"><span>Tokens</span><b>{{ f.count(tokTotal()) }}</b>
          <em>{{ f.count(d.llm.tokens['output'] || 0) }} written · {{ f.count(d.llm.tokens['cache_read'] || 0) }} cache reads</em></div>
        <div class="tcv-stat c2"><span>Compute</span><b>{{ f.hours(d.compute.cpu_s / 3600) }}</b>
          <em>CPU time over {{ d.compute.count }} jobs · {{ f.secs(d.compute.wall_s) }} wall</em></div>
        <div class="tcv-stat c2"><span>Energy</span><b>{{ f.wh((d.energy.machine_kwh || d.energy.jobs_kwh) * 1000) }}</b>
          <em>{{ d.energy.machine_kwh ? 'whole machine' : 'jobs only' }} · {{ d.energy.basis }}</em></div>
        <div class="tcv-stat c2"><span>Electricity</span>
          <b>{{ elecCost() == null ? '–' : f.money(elecCost()!) }}</b>
          <em>{{ d.energy.kwh_price == null ? 'set a price per kWh below' : '$' + d.energy.kwh_price + ' per kWh' }}</em></div>
        <div class="tcv-stat c2"><span>Notes</span><b>{{ notesIn() }}</b>
          <em>{{ d.work.status['applied'] || 0 }} applied · {{ d.work.status['queued'] || 0 }} queued</em></div>
        <div class="tcv-stat c2"><span>Database</span><b>{{ f.bytes(d.storage.db_bytes) }}</b>
          <em>{{ f.count(d.storage.objects) }} documents</em></div>
        <div class="tcv-stat c2"><span>Disk free</span><b>{{ f.bytes(d.storage.disk.free) }}</b>
          <em>of {{ f.bytes(d.storage.disk.total) }}</em></div>
        <div class="tcv-stat c2"><span>Projects</span><b>{{ d.catalog.projects.length }}</b>
          <em>{{ d.catalog.models }} models · {{ d.catalog.boards }} boards · {{ d.catalog.apps }} apps</em></div>
        <div class="tcv-stat c2"><span>Agent questions</span><b>{{ d.work.questions.asked }}</b>
          <em>answered in {{ d.work.questions.avg_wait_s == null ? '–' : f.secs(d.work.questions.avg_wait_s) }} on average</em></div>
        <div class="tcv-stat c2"><span>Runs</span><b>{{ runsTotal() }}</b>
          <em>{{ runsAvg() }} each on average</em></div>
        <div class="tcv-stat c2"><span>LCSC requests</span><b>{{ d.lcsc.totals['total'] || 0 }}</b>
          <em>{{ d.lcsc.totals['net'] || 0 }} sent · {{ d.lcsc.totals['refused'] || 0 }} refused</em></div>
      </div>
    }

    <!-- LLMS -->
    <ng-container *ngTemplateOutlet="head; context: { id: 'llm', title: 'LLMs', sub: 'every call the agents and the app made' }" />
    @if (open('llm')) {
      <div class="tcv-dash-grid">
        <section class="tcv-panel-d c8"><h3>Spend by model</h3>
          <app-time-chart [data]="d.llm.cost_by_model" kind="bar" [f]="f.money" [height]="200" /></section>
        <section class="tcv-panel-d c4"><h3>Spend by room <i title="calls made while a note's run was open belong to that room; the rest is work outside any note">ⓘ</i></h3>
          <app-donut [rows]="rows(d.llm.by_room, 'cost_usd', roomName)" [f]="f.money" /></section>
        <section class="tcv-panel-d c8"><h3>Tokens by type</h3>
          <app-time-chart [data]="d.llm.tokens_by_type" kind="area" [f]="f.count" [height]="180" /></section>
        <section class="tcv-panel-d c4"><h3>Spend by kind of work</h3>
          <app-bar-list [rows]="rows(d.llm.by_surface, 'cost_usd')" [f]="f.money" /></section>
        <section class="tcv-panel-d c4"><h3>By model</h3>
          <app-bar-list [rows]="rows(d.llm.by_model, 'cost_usd')" [f]="f.money" /></section>
        <section class="tcv-panel-d c4"><h3>By provider</h3>
          <app-bar-list [rows]="rows(d.llm.by_provider, 'cost_usd')" [f]="f.money" /></section>
        <section class="tcv-panel-d c4"><h3>By project</h3>
          <app-bar-list [rows]="rows(d.llm.by_project, 'cost_usd', roomName)" [f]="f.money" /></section>
        <section class="tcv-panel-d c12"><h3>Most expensive notes</h3>
          <table class="tcv-dash-table">
            <thead><tr><th>note</th><th>room</th><th>project</th><th class="r">calls</th><th class="r">tokens</th><th class="r">spend</th></tr></thead>
            <tbody>
              @for (t of d.llm.top_notes; track t.id) {
                <tr><td class="truncate" [title]="t.title">{{ t.title || t.id }}</td><td>{{ t.room }}</td><td>{{ t.project }}</td>
                  <td class="r mono">{{ t.calls }}</td><td class="r mono">{{ f.count(t.tokens) }}</td>
                  <td class="r mono">{{ f.money(t.cost_usd) }}</td></tr>
              } @empty { <tr><td colspan="6" class="tcv-dash-dim">no notes in this range</td></tr> }
            </tbody>
          </table></section>
      </div>
    }

    <!-- MACHINE AND ENERGY -->
    <ng-container *ngTemplateOutlet="head; context: { id: 'machine', title: 'Machine & energy', sub: machineSub() }" />
    @if (open('machine')) {
      <div class="tcv-dash-grid">
        <section class="tcv-panel-d c6"><h3>Load</h3>
          <app-time-chart [data]="load3()" kind="line" [stacked]="false" [sums]="false" [f]="f.pct" [height]="180" /></section>
        <section class="tcv-panel-d c6"><h3>Power <i [title]="powerNote()">ⓘ</i></h3>
          <app-time-chart [data]="d.machine.watts" kind="area" [stacked]="false" [sums]="false" [legend]="false" [f]="f.watts" [height]="180" /></section>
        <section class="tcv-panel-d c6"><h3>Energy per {{ stepWord(d.range.step) }}</h3>
          <app-time-chart [data]="d.machine.energy_wh" kind="bar" [legend]="false" [f]="f.wh" [height]="160" /></section>
        <section class="tcv-panel-d c6"><h3>Compute by job <span class="tcv-dash-dim">(CPU hours)</span></h3>
          <app-time-chart [data]="d.compute.cpu_hours_by_kind" kind="bar" [f]="f.hours" [height]="160" /></section>
        <section class="tcv-panel-d c8"><h3>Jobs</h3>
          <table class="tcv-dash-table">
            <thead><tr><th>job</th><th class="r">runs</th><th class="r">wall</th><th class="r">CPU</th><th class="r">energy</th><th class="r">peak memory</th></tr></thead>
            <tbody>
              @for (k of d.compute.by_kind; track k.name) {
                <tr><td>{{ k.name }}</td><td class="r mono">{{ k.jobs }}</td><td class="r mono">{{ f.secs(k.wall_s) }}</td>
                  <td class="r mono">{{ f.hours(k.cpu_s / 3600) }}</td><td class="r mono">{{ f.wh(k.wh) }}</td>
                  <td class="r mono">{{ f.bytes(k.peak_rss_mb * 1e6) }}</td></tr>
              } @empty { <tr><td colspan="6" class="tcv-dash-dim">no jobs in this range</td></tr> }
            </tbody>
          </table>
          @if (d.compute.failed) { <p class="tcv-dash-dim mt-1">{{ d.compute.failed }} of them failed</p> }
        </section>
        <section class="tcv-panel-d c4"><h3>Electricity price</h3>
          <div class="flex items-center gap-2">
            <span class="tcv-dash-dim">$</span>
            <input type="number" step="0.01" min="0" [value]="d.energy.kwh_price ?? ''" placeholder="e.g. 0.25"
                   (change)="setPrice($any($event.target).value)" class="tcv-field w-24 px-1.5 py-1 text-right mono">
            <span class="tcv-dash-dim">per kWh</span>
          </div>
          <p class="tcv-dash-dim mt-2 leading-snug">{{ powerNote() }}</p>
          <div class="mt-2 text-[12px]">Now: {{ d.machine.now.cpu.load.toFixed(0) }}% CPU ·
            {{ f.bytes(d.machine.now.ram.used_bytes) }} RAM
            @if (d.machine.now.gpu; as g) { · {{ g.util.toFixed(0) }}% GPU · {{ g.temp_c.toFixed(0) }}° }</div>
        </section>
      </div>
    }

    <!-- WORK -->
    <ng-container *ngTemplateOutlet="head; context: { id: 'work', title: 'Work', sub: 'notes, runs, the thread and the questions, per room' }" />
    @if (open('work')) {
      <div class="tcv-dash-grid">
        <section class="tcv-panel-d c6"><h3>Notes written</h3>
          <app-time-chart [data]="named(d.work.notes_by_room)" kind="bar" [height]="170" /></section>
        <section class="tcv-panel-d c6"><h3>Runs finished</h3>
          <app-time-chart [data]="named(d.work.runs_done_by_room)" kind="bar" [height]="170" /></section>
        <section class="tcv-panel-d c6"><h3>Runs by room</h3>
          <table class="tcv-dash-table">
            <thead><tr><th>room</th><th class="r">runs</th><th class="r">finished</th><th class="r">average</th><th class="r">total</th></tr></thead>
            <tbody>
              @for (r of d.work.runs_by_room; track r.room) {
                <tr><td>{{ roomName(r.room) }}</td><td class="r mono">{{ r.runs }}</td><td class="r mono">{{ r.done }}</td>
                  <td class="r mono">{{ r.avg_s == null ? '–' : f.secs(r.avg_s) }}</td><td class="r mono">{{ f.secs(r.seconds) }}</td></tr>
              } @empty { <tr><td colspan="5" class="tcv-dash-dim">no runs in this range</td></tr> }
            </tbody>
          </table></section>
        <section class="tcv-panel-d c6"><h3>The thread</h3>
          <app-time-chart [data]="d.work.chat" kind="bar" [height]="150" /></section>
      </div>
    }

    <!-- STORAGE -->
    <ng-container *ngTemplateOutlet="head; context: { id: 'storage', title: 'Storage', sub: f.bytes(d.storage.db_bytes) + ' in the database · ' + f.bytes(cacheTotal()) + ' cached on disk' }" />
    @if (open('storage')) {
      <div class="tcv-dash-grid">
        <section class="tcv-panel-d c6"><h3>Database, by collection</h3>
          <app-bar-list [rows]="collRows()" [f]="f.bytes" [mono]="true" /></section>
        <section class="tcv-panel-d c3"><h3>Caches on disk</h3>
          <app-bar-list [rows]="cacheRows()" [f]="f.bytes" /></section>
        <section class="tcv-panel-d c3"><h3>Disk</h3>
          <div class="tcv-gauge"><span [style.width.%]="100 * d.storage.disk.used / d.storage.disk.total"></span></div>
          <p class="mt-2 text-[12px]">{{ f.bytes(d.storage.disk.used) }} used of {{ f.bytes(d.storage.disk.total) }}</p>
          <p class="tcv-dash-dim">{{ f.bytes(d.storage.disk.free) }} free</p>
          <p class="tcv-dash-dim mt-2">indexes {{ f.bytes(d.storage.index_bytes) }} · on disk {{ f.bytes(d.storage.db_storage) }}</p>
        </section>
      </div>
    }

    <!-- PROJECTS -->
    <ng-container *ngTemplateOutlet="head; context: { id: 'projects', title: 'Projects', sub: d.catalog.folders + ' folders · ' + d.catalog.parts + ' parts in the drawer' }" />
    @if (open('projects')) {
      <div class="tcv-dash-grid">
        <section class="tcv-panel-d c12">
          <table class="tcv-dash-table">
            <thead><tr><th>project</th><th class="r">models</th><th class="r">boards</th><th class="r">apps</th><th class="r">notes</th><th class="r">LLM spend</th></tr></thead>
            <tbody>
              @for (p of d.catalog.projects; track p.name) {
                <tr><td>{{ roomName(p.name) }}</td><td class="r mono">{{ p.models }}</td><td class="r mono">{{ p.boards }}</td>
                  <td class="r mono">{{ p.apps }}</td><td class="r mono">{{ p.notes }}</td><td class="r mono">{{ f.money(p.cost_usd) }}</td></tr>
              }
            </tbody>
          </table></section>
      </div>
    }

    <!-- LCSC -->
    <ng-container *ngTemplateOutlet="head; context: { id: 'lcsc', title: 'Parts supplier (LCSC)', sub: 'how each request was answered' }" />
    @if (open('lcsc')) {
      <div class="tcv-dash-grid">
        <section class="tcv-panel-d c12"><h3>Requests</h3>
          <app-time-chart [data]="d.lcsc.by_source" kind="bar" [height]="150" /></section>
      </div>
    }
    } @else if (!error()) {
      <p class="tcv-dash-note">reading everything…</p>
    }
  </div>
</div>

<ng-template #head let-id="id" let-title="title" let-sub="sub">
  <button class="tcv-dash-row" (click)="fold(id)">
    <span class="tcv-dash-caret">{{ open(id) ? '▾' : '▸' }}</span>
    <span class="tcv-dash-rowtitle">{{ title }}</span>
    <span class="tcv-dash-dim truncate">{{ sub }}</span>
  </button>
</ng-template>`,
})
export class RoomAnalyze implements OnDestroy {
  private api = inject(InsightsApi);
  readonly f = fmt;
  readonly ranges = [
    { id: '1h', label: '1h' }, { id: '6h', label: '6h' }, { id: '24h', label: '24h' },
    { id: '7d', label: '7d' }, { id: '30d', label: '30d' }, { id: '90d', label: '90d' },
    { id: 'all', label: 'All' },
  ];
  readonly everys = [{ s: 0, label: 'no refresh' }, { s: 30, label: 'every 30 s' },
                     { s: 60, label: 'every 1 min' }, { s: 300, label: 'every 5 min' }];

  range = signal(recall('range', '7d'));
  every = signal(+recall('every', '60'));
  shut = signal<Set<string>>(new Set(JSON.parse(recall('shut', '[]'))));
  data = signal<Insights | null>(null);
  loading = signal(false);
  error = signal('');
  private at = signal<Date | null>(null);
  private timer?: ReturnType<typeof setInterval>;

  constructor() {
    // The last dashboard for this range, from this browser, on screen at
    // once; the server's answer replaces it a moment later.
    this.data.set(kept(this.range()));
    this.load();
    this.arm();
  }
  ngOnDestroy() { clearInterval(this.timer); clearTimeout(this.again); }

  private again?: ReturnType<typeof setTimeout>;

  load() {
    this.loading.set(true);
    const range = this.range();
    this.api.get(range).subscribe({
      next: d => {
        if (range !== this.range()) return;
        this.data.set(d); this.loading.set(false); this.error.set('');
        this.at.set(d.computed_at ? new Date(d.computed_at) : new Date());
        keepData(range, d);
        // An answer the server kept while it works out a newer one: ask
        // again shortly for that.
        clearTimeout(this.again);
        if (d.stale) this.again = setTimeout(() => this.load(), 4000);
      },
      error: e => { this.loading.set(false); this.error.set('could not read the figures: ' + (e?.status ?? '')); },
    });
  }
  private arm() {
    clearInterval(this.timer);
    if (this.every()) this.timer = setInterval(() => this.load(), this.every() * 1000);
  }
  setRange(r: string) { this.range.set(r); keep('range', r); this.data.set(kept(r) ?? this.data()); this.load(); }
  setEvery(s: number) { this.every.set(s); keep('every', String(s)); this.arm(); }
  open(id: Section | string) { return !this.shut().has(id); }
  fold(id: string) {
    const s = new Set(this.shut());
    if (s.has(id)) s.delete(id); else s.add(id);
    this.shut.set(s); keep('shut', JSON.stringify([...s]));
  }
  setPrice(v: string) {
    const price = v === '' ? null : Math.max(0, +v);
    this.api.setKwhPrice(price).subscribe({ next: () => this.load() });
  }

  updated = computed(() => this.at()?.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) ?? '');
  rangeLabel = computed(() => {
    const d = this.data();
    if (!d) return '';
    const a = new Date(d.range.since), b = new Date(d.range.until);
    const o: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
    return `${a.toLocaleString('en-GB', o)} → ${b.toLocaleString('en-GB', o)}`;
  });
  tokTotal = computed(() => Object.values(this.data()?.llm.tokens ?? {}).reduce((a, v) => a + v, 0));
  notesIn = computed(() => Object.values(this.data()?.work.status ?? {}).reduce((a, v) => a + v, 0));
  runsTotal = computed(() => (this.data()?.work.runs_by_room ?? []).reduce((a, r) => a + r.runs, 0));
  runsAvg = computed(() => {
    const rs = this.data()?.work.runs_by_room ?? [];
    const done = rs.reduce((a, r) => a + r.done, 0), secs = rs.reduce((a, r) => a + r.seconds, 0);
    return done ? fmt.secs(secs / done) : '–';
  });
  elecCost = computed(() => {
    const e = this.data()?.energy;
    if (!e || e.kwh_price == null) return null;
    return (e.machine_kwh || e.jobs_kwh) * e.kwh_price;
  });
  cacheTotal = computed(() => (this.data()?.storage.caches ?? []).reduce((a, c) => a + c.bytes, 0));
  collRows = computed<Row[]>(() => (this.data()?.storage.collections ?? []).slice(0, 12)
    .map(c => ({ name: c.name, value: c.bytes, sub: c.docs + ' documents' })));
  cacheRows = computed<Row[]>(() => (this.data()?.storage.caches ?? []).map(c => ({ name: c.name, value: c.bytes })));
  load3 = computed(() => {
    const m = this.data()?.machine;
    if (!m) return { t0: 0, step: 1, n: 0, series: [] };
    return { ...m.cpu, series: [...m.cpu.series, ...m.ram.series, ...m.gpu.series] };
  });
  machineSub = computed(() => {
    const e = this.data()?.energy;
    if (!e) return '';
    return e.samples ? `sampled once a minute since ${new Date(e.sampled_since!).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
      : 'the machine is sampled once a minute from now on';
  });
  powerNote = computed(() => {
    const e = this.data()?.energy;
    if (!e) return '';
    return e.basis === 'measured' ? 'Measured from the CPU package counter.'
      : `Estimated: busy CPU time at ${e.watts_per_core} W per core, plus the GPU at its power limit while busy. `
        + 'Allowing this user to read /sys/class/powercap/intel-rapl:0/energy_uj makes it measured.';
  });

  /** A series per room, called by the room's name rather than its id. */
  named(d: InsightSeries): InsightSeries {
    return { ...d, series: d.series.map(x => ({ ...x, name: this.roomName(x.name) })) };
  }

  rows(list: { name: string; [k: string]: unknown }[], key: string, name?: (n: string) => string): Row[] {
    return list.map(r => ({ name: name ? name(r.name) : r.name, value: Number(r[key] ?? 0) }))
      .filter(r => r.value > 0);
  }
  readonly roomName = (n: string) => ({ cad: '3D Drawing', pcb: 'PCB Design', web: 'Web', embedded: 'Embedded',
    mobile: 'Mobile', '(no run)': 'outside any note', '(no note)': 'outside any note' } as Record<string, string>)[n] ?? n;
  stepLabel(s: number) { return s < 3600 ? `${s / 60}-minute buckets` : s < 86400 ? 'hourly' : s < 604800 ? 'daily' : 'weekly'; }
  stepWord(s: number) { return s < 3600 ? `${s / 60} min` : s < 86400 ? 'hour' : s < 604800 ? 'day' : 'week'; }
  readonly money: Fmt = fmt.money;
}

function recall(key: string, fallback: string): string {
  try { return localStorage.getItem('x3.analytics.' + key) ?? fallback; } catch { return fallback; }
}
function keep(key: string, value: string) {
  try { localStorage.setItem('x3.analytics.' + key, value); } catch { /* private window */ }
}

function kept(range: string): Insights | null {
  try { return JSON.parse(localStorage.getItem('x3.analytics.data.' + range) ?? 'null'); }
  catch { return null; }
}
function keepData(range: string, d: Insights) {
  try { localStorage.setItem('x3.analytics.data.' + range, JSON.stringify(d)); } catch { /* full or private */ }
}
