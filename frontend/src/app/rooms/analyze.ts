import { ToolsUsage } from './tools-usage';
import { DecimalPipe, NgTemplateOutlet } from '@angular/common';
import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { AuditRow, BoardRunRow, InsightSeries, Insights, InsightsApi, ProjectDetail, ProjectItem } from '../api';
import { Markdown } from '../markdown';
import { BarList, Donut, Fmt, Row, Spark, TimeChart, fmt } from './charts';

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
  imports: [BarList, DecimalPipe, Donut, Markdown, NgTemplateOutlet, Spark, TimeChart, ToolsUsage],
  template: `
<div class="tcv-room tcv-dash absolute inset-0 flex min-h-0 flex-col">
  <header class="tcv-dash-bar">
    <span class="tcv-dash-title">Analytics</span>
    <div class="tcv-dash-seg" role="group" aria-label="range">
      @for (r of ranges; track r.id) {
        <button (click)="setRange(r.id)" [attr.data-on]="range() === r.id ? 1 : null">{{ r.label }}</button>
      }
    </div>
    <!-- One project on its own, or everything the app has used. -->
    <select class="tcv-field px-1.5 py-0.5 text-[11.5px]" (change)="setProject($any($event.target).value)"
            title="one project's items and figures, or all of the app">
      <option value="" [selected]="!project()">All projects</option>
      @for (p of projectNames(); track p) {
        <option [value]="p" [selected]="project() === p">{{ p }}</option>
      }
    </select>
    <span class="flex-1"></span>
    @if (data(); as d) {
      <!-- When the figures were worked out, how long that took, and when the
           next reading is due. -->
      <span class="tcv-dash-meta">{{ stepLabel(d.range.step) }} · updated {{ updated() }}
        @if (d.took_ms != null) { · took {{ d.took_ms | number }} ms }
        · {{ nextIn() === null ? 'no auto refresh' : loading() ? 'refreshing…' : 'next in ' + nextIn() + ' s' }}</span>
    }
    <select class="tcv-field px-1.5 py-0.5 text-[11.5px]" [value]="every()"
            (change)="setEvery(+$any($event.target).value)" title="refresh on its own">
      @for (e of everys; track e.s) { <option [value]="e.s" [selected]="every() === e.s">{{ e.label }}</option> }
    </select>
    <button (click)="exportAll()" class="tcv-btn px-2 py-0.5" [disabled]="!data()"
            title="everything in this range, as JSON">Export</button>
    <button (click)="load()" class="tcv-btn px-2 py-0.5" [disabled]="loading()" title="read it again">
      {{ loading() ? '…' : '↻' }}
    </button>
  </header>

  <div class="tcv-dash-body tcv-scroll min-h-0 flex-1 overflow-y-auto">
    @if (error(); as e) { <p class="tcv-dash-note" style="color: var(--danger)">{{ e }}</p> }
    @if (data(); as d) {
    @if (project() && d.project_detail[project()]; as pd) {

    <!-- ONE PROJECT: its items matched by id, each with its own figures -->
    <ng-container *ngTemplateOutlet="head; context: { id: 'p-overview', title: pd.name, sub: pd.items.length + ' items · ' + rangeLabel() }" />
    @if (open('p-overview')) {
      <div class="tcv-dash-grid">
        <div class="tcv-stat c2"><span>LLM spend</span><b>{{ f.money(pd.spend_usd) }}</b><em>on this project's notes</em></div>
        <div class="tcv-stat c2"><span>Notes</span><b>{{ pd.notes }}</b><em>all time</em></div>
        <div class="tcv-stat c2"><span>Runs</span><b>{{ pd.runs }}</b><em>by the agents</em></div>
        <div class="tcv-stat c2"><span>Jobs</span><b>{{ pd.jobs }}</b><em>builds, renders, layouts, tests</em></div>
        <div class="tcv-stat c2"><span>Failed</span><b>{{ pd.failed }}</b><em>{{ pd.jobs ? (100 * pd.failed / pd.jobs).toFixed(1) + '% of jobs' : '–' }}</em></div>
        <div class="tcv-stat c2"><span>Items</span><b>{{ pd.items.length }}</b><em>{{ kindsLine(pd) }}</em></div>
        @if (pd.spend_series; as ss) {
          <section class="tcv-panel-d c12"><h3>Spend by item
              <button class="tcv-dl" (click)="dl(pd.name + '-spend', seriesRows(ss))">CSV</button></h3>
            <app-time-chart [data]="ss" kind="bar" [f]="f.money" [height]="180" /></section>
        }
      </div>
    }
    <ng-container *ngTemplateOutlet="head; context: { id: 'p-items', title: 'Items', sub: 'every model, board and app in ' + pd.name + ', by id' }" />
    @if (open('p-items')) {
      <div class="tcv-items">
        @for (it of pd.items; track it.id) {
          <article class="tcv-item">
            <div class="tcv-item-pic">
              @if (it.picture) { <img [src]="it.picture" [alt]="it.title" loading="lazy"> }
              @else { <span>{{ it.kind }}</span> }
            </div>
            <div class="tcv-item-body">
              <div class="flex items-baseline gap-2">
                <b class="truncate">{{ it.title }}</b><span class="tcv-kind">{{ it.kind }}</span>
              </div>
              <div class="tcv-dash-dim mono truncate" [title]="it.id">{{ it.id }}</div>
              <dl class="tcv-item-facts">
                <dt>notes</dt><dd>{{ it.notes }} <span class="tcv-dash-dim">({{ it.applied }} applied)</span></dd>
                <dt>LLM spend</dt><dd>{{ f.money(it.spend_usd) }}</dd>
                <dt>runs</dt><dd>{{ it.runs }} @if (it.run_median_s != null) { <span class="tcv-dash-dim">· {{ f.secs(it.run_median_s) }} median</span> }</dd>
                <dt>jobs</dt><dd>{{ it.jobs }} @if (it.failed) { <span style="color: var(--danger)">· {{ it.failed }} failed</span> }
                  @if (it.job_median_s != null) { <span class="tcv-dash-dim">· {{ f.secs(it.job_median_s) }}</span> }</dd>
                @if (it.kind === 'model') {
                  <dt>built size</dt><dd>{{ it.size_bytes == null ? '–' : f.bytes(it.size_bytes) }}</dd>
                  <dt>last build</dt><dd>{{ it.build_secs == null ? '–' : f.secs(it.build_secs) }}
                    @if (walls(it).length > 1) { <app-spark [values]="walls(it)" title="build time, oldest to newest" /> }</dd>
                }
                @if (it.kind === 'board') {
                  <dt>routing</dt><dd [style.color]="it.unrouted ? 'var(--danger)' : 'var(--ok)'">{{ it.unrouted == null ? '–' : it.unrouted + ' unrouted' }}
                    · DRC {{ it.drc_errors ?? '–' }}</dd>
                  <dt>size</dt><dd>{{ it.size_mm ? it.size_mm[0] + ' × ' + it.size_mm[1] + ' mm' : '–' }}</dd>
                  <dt>pipeline runs</dt><dd>{{ it.board_runs?.length || 0 }}
                    @if ((it.board_runs?.length || 0) > 1) { <app-spark [values]="boardSeries(it)" title="unrouted, run by run" /> }</dd>
                }
                @if (it.kind === 'app') {
                  <dt>platform</dt><dd>{{ it.platform }}</dd>
                  <dt>tests</dt><dd>{{ it.tests ?? 0 }} runs
                    @if (it.test_pass_rate != null) { · {{ (it.test_pass_rate * 100).toFixed(0) }}% pass }
                    @if (it.last_test_ok != null) { · last <span [style.color]="it.last_test_ok ? 'var(--ok)' : 'var(--danger)'">{{ it.last_test_ok ? 'passed' : 'failed' }}</span> }</dd>
                  @if (it.firmware; as fw) {
                    <dt>firmware</dt><dd>{{ f.bytes(fw.flash_bytes) }} flash · {{ f.bytes(fw.ram_bytes) }} RAM</dd>
                  }
                }
                @if (it.history.length) {
                  <dt>history</dt><dd class="tcv-dash-dim">{{ it.history.length }} snapshots
                    <button class="tcv-dl" (click)="dl(it.id + '-history', it.history)">CSV</button></dd>
                }
              </dl>
            </div>
          </article>
        }
      </div>
    }
    <ng-container *ngTemplateOutlet="head; context: { id: 'p-notes', title: 'Notes and questions', sub: 'this project only' }" />
    @if (open('p-notes')) {
      <div class="tcv-dash-grid">
        <section class="tcv-panel-d c6"><h3>Slowest notes to finish</h3>
          <table class="tcv-dash-table">
            <thead><tr><th>note</th><th class="r">agent</th><th class="r">total</th></tr></thead>
            <tbody>
              @for (r of pd.lead; track r.id) {
                <tr><td [title]="r.title">{{ r.title || r.id }}</td><td class="r mono">{{ dur(r.working) }}</td><td class="r mono">{{ dur(r.total) }}</td></tr>
              } @empty { <tr><td colspan="3" class="tcv-dash-dim">none in this range</td></tr> }
            </tbody>
          </table></section>
        <section class="tcv-panel-d c6"><h3>What the agents asked</h3>
          <table class="tcv-dash-table">
            <thead><tr><th>question</th><th>answer</th><th class="r">waited</th></tr></thead>
            <tbody>
              @for (q of pd.questions; track q.at) {
                <tr><td [title]="q.text">{{ q.question }}</td><td [title]="q.answer">{{ q.answer || q.status }}</td><td class="r mono">{{ dur(q.wait_s) }}</td></tr>
              } @empty { <tr><td colspan="3" class="tcv-dash-dim">no questions on this project's notes</td></tr> }
            </tbody>
          </table></section>
      </div>
    }

    } @else {

    <!-- OVERVIEW -->
    <ng-container *ngTemplateOutlet="head; context: { id: 'overview', title: 'Overview', sub: rangeLabel() }" />
    @if (open('overview')) {
      <div class="tcv-dash-grid">
        <div class="tcv-stat c2"><span>LLM spend</span><b>{{ f.money(d.llm.cost_usd) }}</b>
          <em>at API list prices · {{ f.count(d.llm.calls) }} calls</em>
          @if (delta(d, 'llm_usd'); as dl) { <i class="tcv-delta" [attr.data-up]="dl.up ? 1 : null">{{ dl.text }}</i> }</div>
        <div class="tcv-stat c2"><span>Tokens</span><b>{{ f.count(tokTotal()) }}</b>
          <em>{{ f.count(d.llm.tokens['output'] || 0) }} written · {{ f.count(d.llm.tokens['cache_read'] || 0) }} cache reads</em></div>
        <div class="tcv-stat c2"><span>Compute</span><b>{{ f.hours(d.compute.cpu_s / 3600) }}</b>
          <em>CPU time over {{ d.compute.count }} jobs · {{ f.secs(d.compute.wall_s) }} wall</em>
          @if (delta(d, 'cpu_s'); as dl) { <i class="tcv-delta" [attr.data-up]="dl.up ? 1 : null">{{ dl.text }}</i> }</div>
        <div class="tcv-stat c2"><span>Energy</span><b>{{ f.wh((d.energy.machine_kwh || d.energy.jobs_kwh) * 1000) }}</b>
          <em>{{ d.energy.machine_kwh ? 'whole machine' : 'jobs only' }} · {{ d.energy.basis }}</em></div>
        <div class="tcv-stat c2"><span>Electricity</span>
          <b>{{ elecCost() == null ? '–' : f.money(elecCost()!) }}</b>
          <em>{{ d.energy.kwh_price == null ? 'set a price per kWh below' : '$' + d.energy.kwh_price + ' per kWh' }}</em></div>
        <div class="tcv-stat c2"><span>Notes</span><b>{{ notesIn() }}</b>
          <em>{{ d.work.status['applied'] || 0 }} applied · {{ d.work.status['queued'] || 0 }} queued</em>
          @if (delta(d, 'notes'); as dl) { <i class="tcv-delta" [attr.data-up]="dl.up ? 1 : null">{{ dl.text }}</i> }</div>
        <div class="tcv-stat c2"><span>Database</span><b>{{ f.bytes(d.storage.db_bytes) }}</b>
          <em>{{ f.count(d.storage.objects) }} documents</em></div>
        <div class="tcv-stat c2"><span>Disk free</span><b>{{ f.bytes(d.storage.disk.free) }}</b>
          <em>of {{ f.bytes(d.storage.disk.total) }}</em></div>
        <div class="tcv-stat c2"><span>Projects</span><b>{{ d.catalog.projects.length }}</b>
          <em>{{ d.catalog.models }} models · {{ d.catalog.boards }} boards · {{ d.catalog.apps }} apps</em></div>
        <div class="tcv-stat c2"><span>Agent questions</span><b>{{ d.work.questions.asked }}</b>
          <em>answered in {{ d.work.questions.avg_wait_s == null ? '–' : f.secs(d.work.questions.avg_wait_s) }} on average</em></div>
        <div class="tcv-stat c2"><span>Runs</span><b>{{ runsTotal() }}</b>
          <em>{{ runsAvg() }} each on average</em>
          @if (delta(d, 'runs'); as dl) { <i class="tcv-delta" [attr.data-up]="dl.up ? 1 : null">{{ dl.text }}</i> }</div>
        <div class="tcv-stat c2"><span>LCSC requests</span><b>{{ d.lcsc.totals['total'] || 0 }}</b>
          <em>{{ d.lcsc.totals['net'] || 0 }} sent · {{ d.lcsc.totals['refused'] || 0 }} refused</em></div>
        <div class="tcv-stat c3"><span>Subscription saved</span>
          <b>{{ d.subscription.saved_usd == null ? '–' : f.money(d.subscription.saved_usd) }}</b>
          <em>{{ d.subscription.plan_usd == null ? 'set your plan under Costs & savings'
                 : f.money(d.subscription.plan_usd) + ' paid for ' + f.money(d.subscription.list_usd) + ' of work' }}</em></div>
        <div class="tcv-stat c3"><span>Cache</span>
          <b>{{ d.cache.hit_ratio == null ? '–' : (d.cache.hit_ratio * 100).toFixed(1) + '%' }}</b>
          <em>of prompt tokens read from cache · saved {{ f.money(d.cache.saved_usd) }}</em></div>
        <div class="tcv-stat c3"><span>Cost per finished note</span>
          <b>{{ d.note_costs.median == null ? '–' : f.money(d.note_costs.median) }}</b>
          <em>median of {{ d.note_costs.notes }} · average {{ d.note_costs.mean == null ? '–' : f.money(d.note_costs.mean) }}</em></div>
        <div class="tcv-stat c3"><span>API</span><b>{{ f.count(d.api.requests) }}</b>
          <em>requests · {{ d.api.errors }} errors · slowest {{ d.api.routes[0]?.route ?? '–' }}</em></div>
      </div>
    }

    <!-- LLMS -->
    <ng-container *ngTemplateOutlet="head; context: { id: 'llm', title: 'LLMs', sub: 'every call the agents and the app made' }" />
    @if (open('llm')) {
      <div class="tcv-dash-grid">
        <section class="tcv-panel-d c8"><h3>Spend by model
            <button class="tcv-dl" (click)="dl('spend-by-model', seriesRows(d.llm.cost_by_model))">CSV</button></h3>
          <app-time-chart [data]="d.llm.cost_by_model" kind="bar" [f]="f.money" [height]="200" [marks]="d.anomalies.buckets" /></section>
        <section class="tcv-panel-d c4"><h3>Spend by room <i title="calls made while a note's run was open belong to that room; the rest is work outside any note">ⓘ</i></h3>
          <app-donut [rows]="rows(d.llm.by_room, 'cost_usd', roomName)" [f]="f.money" /></section>
        <section class="tcv-panel-d c8"><h3>Tokens by type
            <button class="tcv-dl" (click)="dl('tokens-by-type', seriesRows(d.llm.tokens_by_type))">CSV</button></h3>
          <app-time-chart [data]="d.llm.tokens_by_type" kind="area" [f]="f.count" [height]="180" /></section>
        <section class="tcv-panel-d c4"><h3>Spend by kind of work</h3>
          <app-bar-list [rows]="rows(d.llm.by_surface, 'cost_usd')" [f]="f.money" /></section>
        <section class="tcv-panel-d c4"><h3>By model</h3>
          <app-bar-list [rows]="rows(d.llm.by_model, 'cost_usd')" [f]="f.money" /></section>
        <section class="tcv-panel-d c4"><h3>By provider</h3>
          <app-bar-list [rows]="rows(d.llm.by_provider, 'cost_usd')" [f]="f.money" /></section>
        <section class="tcv-panel-d c4"><h3>By project</h3>
          <app-bar-list [rows]="rows(d.llm.by_project, 'cost_usd', roomName)" [f]="f.money" /></section>
        <section class="tcv-panel-d c12"><h3>Most expensive notes
            <button class="tcv-dl" (click)="dl('top-notes', d.llm.top_notes)">CSV</button></h3>
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

    <!-- COSTS AND SAVINGS -->
    <ng-container *ngTemplateOutlet="head; context: { id: 'costs', title: 'Costs & savings', sub: 'the subscription against list prices, what the cache saves, what a note costs' }" />
    @if (open('costs')) {
      <div class="tcv-dash-grid">
        <section class="tcv-panel-d c4"><h3>Subscription</h3>
          <div class="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1.5 text-[12px]">
            <span class="tcv-dash-dim">plan</span>
            <input [value]="d.subscription.plan_name ?? ''" placeholder="e.g. Claude Max" (change)="setPlanName($any($event.target).value)"
                   class="tcv-field px-1.5 py-1">
            <span class="tcv-dash-dim">$ a month</span>
            <input type="number" min="0" step="1" [value]="d.subscription.plan_usd_month ?? ''" placeholder="e.g. 200"
                   (change)="setPlan($any($event.target).value)" class="tcv-field px-1.5 py-1 text-right mono">
          </div>
          @if (d.subscription.plan_usd != null) {
            <app-bar-list class="mt-3 block" [rows]="[{ name: 'at API list prices', value: d.subscription.list_usd },
                                                   { name: 'paid for this range', value: d.subscription.plan_usd }]" [f]="f.money" />
            <p class="mt-2 text-[12px]">Saved <b class="mono">{{ f.money(d.subscription.saved_usd ?? 0) }}</b>
              @if (d.subscription.ratio) { - the work would have cost {{ d.subscription.ratio }}× the plan. }</p>
            <p class="tcv-dash-dim mt-1">The plan is prorated over the range ({{ d.subscription.months.toFixed(2) }} months).</p>
          } @else {
            <p class="tcv-dash-dim mt-3 leading-snug">Enter what you pay each month and this compares it with what the same
              work would have cost on the API.</p>
          }
        </section>
        <section class="tcv-panel-d c4"><h3>Cache by model
            <button class="tcv-dl" (click)="dl('cache-by-model', d.cache.by_model)">CSV</button></h3>
          <table class="tcv-dash-table">
            <thead><tr><th>model</th><th class="r">hit</th><th class="r">saved</th></tr></thead>
            <tbody>
              @for (m of d.cache.by_model; track m.name) {
                <tr><td [title]="m.name">{{ m.name }}</td>
                  <td class="r mono">{{ m.hit_ratio == null ? '–' : (m.hit_ratio * 100).toFixed(1) + '%' }}</td>
                  <td class="r mono">{{ m.saved_usd == null ? 'unpriced' : f.money(m.saved_usd) }}</td></tr>
              }
            </tbody>
          </table>
          <p class="tcv-dash-dim mt-2 leading-snug">Saved = cache reads × (input price − cache-read price), at list prices.
            {{ f.count(d.cache.read) }} tokens read from cache, {{ f.count(d.cache.write) }} written to it,
            {{ f.count(d.cache.fresh) }} sent fresh.</p>
        </section>
        <section class="tcv-panel-d c4"><h3>Cache hit rate
            <button class="tcv-dl" (click)="dl('cache-hit-rate', seriesRows(d.cache.hit_series))">CSV</button></h3>
          <app-time-chart [data]="d.cache.hit_series" kind="line" [stacked]="false" [sums]="false" [legend]="false" [f]="f.pct" [height]="170" /></section>
        <section class="tcv-panel-d c12"><h3>Cost of a finished note
            <span class="tcv-dash-dim">median and average of the notes finished each {{ stepWord(d.range.step) }}</span>
            <button class="tcv-dl" (click)="dl('note-cost', seriesRows(d.note_costs.series))">CSV</button></h3>
          <app-time-chart [data]="d.note_costs.series" kind="line" [stacked]="false" [sums]="false" [f]="f.money" [height]="180" /></section>
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
        <section class="tcv-panel-d c8"><h3>Jobs
            <button class="tcv-dl" (click)="dl('jobs', d.compute.by_kind)">CSV</button></h3>
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

    <!-- BUILDS -->
    <ng-container *ngTemplateOutlet="head; context: { id: 'builds', title: 'Builds', sub: 'which kinds of job fail, and which models are slow to build' }" />
    @if (open('builds')) {
      <div class="tcv-dash-grid">
        <section class="tcv-panel-d c6"><h3>Health by kind of job
            <button class="tcv-dl" (click)="dl('build-health', d.builds.by_kind)">CSV</button></h3>
          <table class="tcv-dash-table">
            <thead><tr><th>job</th><th class="r">runs</th><th class="r">failed</th><th class="r">fail rate</th><th class="r">median</th><th class="r">slowest</th></tr></thead>
            <tbody>
              @for (k of d.builds.by_kind; track k.name) {
                <tr><td>{{ k.name }}</td><td class="r mono">{{ k.jobs }}</td><td class="r mono">{{ k.failed }}</td>
                  <td class="r mono" [style.color]="(k.fail_rate ?? 0) > 0.1 ? 'var(--danger)' : (k.fail_rate ?? 0) > 0 ? 'var(--warn)' : null">
                    {{ k.fail_rate == null ? '–' : (k.fail_rate * 100).toFixed(1) + '%' }}</td>
                  <td class="r mono">{{ k.median_s == null ? '–' : f.secs(k.median_s) }}</td>
                  <td class="r mono">{{ k.max_s == null ? '–' : f.secs(k.max_s) }}</td></tr>
              } @empty { <tr><td colspan="6" class="tcv-dash-dim">no jobs in this range</td></tr> }
            </tbody>
          </table></section>
        <section class="tcv-panel-d c6"><h3>Slowest models to build
            <button class="tcv-dl" (click)="dl('slowest-models', d.builds.by_model)">CSV</button></h3>
          <table class="tcv-dash-table">
            <thead><tr><th>model</th><th class="r">builds</th><th class="r">median</th><th class="r">slowest</th></tr></thead>
            <tbody>
              @for (m of d.builds.by_model; track m.name) {
                <tr><td [title]="m.name">{{ m.name }}</td><td class="r mono">{{ m.builds }}</td>
                  <td class="r mono">{{ m.median_s == null ? '–' : f.secs(m.median_s) }}</td><td class="r mono">{{ f.secs(m.max_s) }}</td></tr>
              } @empty { <tr><td colspan="4" class="tcv-dash-dim">no builds in this range</td></tr> }
            </tbody>
          </table></section>
        <section class="tcv-panel-d c12"><h3>Build time per model <span class="tcv-dash-dim">(average per {{ stepWord(d.range.step) }})</span>
            <button class="tcv-dl" (click)="dl('build-time', seriesRows(d.builds.model_trend))">CSV</button></h3>
          <app-time-chart [data]="d.builds.model_trend" kind="line" [stacked]="false" [sums]="false" [f]="f.secs" [height]="180" /></section>
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
        <section class="tcv-panel-d c6"><h3>Runs by room
            <button class="tcv-dl" (click)="dl('runs-by-room', d.work.runs_by_room)">CSV</button></h3>
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
        <section class="tcv-panel-d c6"><h3>From note to done <i title="median per note: writing it (created → queued), waiting for the agent (queued → run starts), the agent's work (run starts → finishes), and all of it">ⓘ</i>
            <button class="tcv-dl" (click)="dl('note-lead-times', d.lead_times.by_room)">CSV</button></h3>
          <table class="tcv-dash-table">
            <thead><tr><th>room</th><th class="r">notes</th><th class="r">writing</th><th class="r">waiting</th><th class="r">agent</th><th class="r">total</th></tr></thead>
            <tbody>
              @for (r of d.lead_times.by_room; track r.room) {
                <tr><td>{{ roomName(r.room) }}</td><td class="r mono">{{ r.notes }}</td>
                  <td class="r mono">{{ dur(r.writing) }}</td><td class="r mono">{{ dur(r.waiting) }}</td>
                  <td class="r mono">{{ dur(r.working) }}</td><td class="r mono">{{ dur(r.total) }}</td></tr>
              } @empty { <tr><td colspan="6" class="tcv-dash-dim">no notes written in this range</td></tr> }
            </tbody>
          </table></section>
        <section class="tcv-panel-d c6"><h3>Slowest notes to finish
            <button class="tcv-dl" (click)="dl('slowest-notes', d.lead_times.slowest)">CSV</button></h3>
          <table class="tcv-dash-table">
            <thead><tr><th>note</th><th>room</th><th class="r">agent</th><th class="r">total</th></tr></thead>
            <tbody>
              @for (r of d.lead_times.slowest; track r.id) {
                <tr><td [title]="r.title">{{ r.title || r.id }}</td><td>{{ roomName(r.room) }}</td>
                  <td class="r mono">{{ dur(r.working) }}</td><td class="r mono">{{ dur(r.total) }}</td></tr>
              } @empty { <tr><td colspan="4" class="tcv-dash-dim">nothing finished in this range</td></tr> }
            </tbody>
          </table></section>
        <section class="tcv-panel-d c12"><h3>What the agents asked <span class="tcv-dash-dim">click one to read it in full</span>
            <button class="tcv-dl" (click)="dl('agent-questions', d.questions)">CSV</button></h3>
          <table class="tcv-dash-table tcv-dash-qs">
            <thead><tr><th>question</th><th>answer</th><th>room</th><th class="r">asked</th><th class="r">waited</th></tr></thead>
            <tbody>
              @for (q of d.questions; track q.at) {
                <tr (click)="openQ.set(openQ() === q.at ? null : q.at)" class="cursor-pointer">
                  <td [title]="q.question">{{ q.question }}</td>
                  <td [title]="q.answer" [style.color]="q.answer ? null : 'var(--warn)'">{{ q.answer || q.status }}</td>
                  <td>{{ q.room ? roomName(q.room) : '–' }}</td>
                  <td class="r mono">{{ when(q.at) }}</td><td class="r mono">{{ dur(q.wait_s) }}</td></tr>
                @if (openQ() === q.at) {
                  <tr class="tcv-dash-open"><td colspan="5">
                    <div class="whitespace-pre-wrap text-[12px] leading-relaxed">{{ q.text }}</div>
                    @if (q.answer) { <div class="mt-2 text-[12px]"><b>Answer:</b> {{ q.answer }}</div> }
                  </td></tr>
                }
              } @empty { <tr><td colspan="5" class="tcv-dash-dim">no questions in this range</td></tr> }
            </tbody>
          </table></section>
      </div>
    }

    <!-- BOARDS -->
    <ng-container *ngTemplateOutlet="head; context: { id: 'boards', title: 'Boards', sub: 'how each board comes out of the pipeline, run by run' }" />
    @if (open('boards')) {
      <div class="tcv-dash-grid">
        @for (b of d.board_quality; track b.board) {
          <section class="tcv-panel-d c12"><h3>{{ b.board }}
              <span class="tcv-dash-dim">{{ b.runs.length }} runs · first {{ quality(b.first) }} → last {{ quality(b.last) }}</span>
              <button class="tcv-dl" (click)="dl('board-' + b.board, b.runs)">CSV</button></h3>
            <table class="tcv-dash-table">
              <thead><tr><th>run</th><th class="r">unrouted</th><th class="r">DRC errors</th><th class="r">DRC warnings</th>
                <th class="r">ERC errors</th><th class="r">area</th><th class="r">tracks</th><th class="r">vias</th><th class="r">copper</th><th class="r">took</th></tr></thead>
              <tbody>
                @for (r of b.runs.slice().reverse(); track r.at) {
                  <tr><td class="mono">{{ when(r.at) }}</td>
                    <td class="r mono" [style.color]="r.unrouted ? 'var(--danger)' : 'var(--ok)'">{{ r.unrouted ?? '–' }}</td>
                    <td class="r mono" [style.color]="r.drc_errors ? 'var(--danger)' : null">{{ r.drc_errors ?? '–' }}</td>
                    <td class="r mono">{{ r.drc_warnings ?? '–' }}</td>
                    <td class="r mono" [style.color]="r.erc_errors ? 'var(--danger)' : null">{{ r.erc_errors ?? '–' }}</td>
                    <td class="r mono">{{ r.area_cm2 == null ? '–' : r.area_cm2 + ' cm²' }}</td>
                    <td class="r mono">{{ r.tracks ?? '–' }}</td><td class="r mono">{{ r.vias ?? '–' }}</td>
                    <td class="r mono">{{ r.length_mm == null ? '–' : r.length_mm + ' mm' }}</td>
                    <td class="r mono">{{ r.seconds == null ? '–' : f.secs(r.seconds) }}</td></tr>
                }
              </tbody>
            </table></section>
        } @empty {
          <section class="tcv-panel-d c12"><p class="tcv-dash-dim">No board runs in this range. Every run of the board
            pipeline is recorded from now on - unrouted connections, DRC and ERC, size, copper - so a board's quality
            can be followed over time.</p></section>
        }
      </div>
    }

    <!-- STORAGE -->
    <ng-container *ngTemplateOutlet="head; context: { id: 'storage', title: 'Storage', sub: f.bytes(d.storage.db_bytes) + ' in the database · ' + f.bytes(cacheTotal()) + ' cached on disk' }" />
    @if (open('storage')) {
      <div class="tcv-dash-grid">
        <section class="tcv-panel-d c6"><h3>Database, by collection
            <button class="tcv-dl" (click)="dl('collections', d.storage.collections)">CSV</button></h3>
          <app-bar-list [rows]="collRows()" [f]="f.bytes" [mono]="true" /></section>
        <section class="tcv-panel-d c3"><h3>Caches on disk</h3>
          <app-bar-list [rows]="cacheRows()" [f]="f.bytes" /></section>
        <section class="tcv-panel-d c3"><h3>Disk</h3>
          <div class="tcv-gauge"><span [style.width.%]="100 * d.storage.disk.used / d.storage.disk.total"></span></div>
          <p class="mt-2 text-[12px]">{{ f.bytes(d.storage.disk.used) }} used of {{ f.bytes(d.storage.disk.total) }}</p>
          <p class="tcv-dash-dim">{{ f.bytes(d.storage.disk.free) }} free</p>
          <p class="tcv-dash-dim mt-2">indexes {{ f.bytes(d.storage.index_bytes) }} · on disk {{ f.bytes(d.storage.db_storage) }}</p>
        </section>
        <section class="tcv-panel-d c8"><h3>Files stored <span class="tcv-dash-dim">(models, CAD, pictures)</span>
            <button class="tcv-dl" (click)="dl('files-stored', seriesRows(d.growth.added))">CSV</button></h3>
          <app-time-chart [data]="d.growth.added" kind="bar" [f]="f.bytes" [height]="160" /></section>
        <section class="tcv-panel-d c4"><h3>When it runs out</h3>
          <p class="text-[12px]">Growing about <b class="mono">{{ f.bytes(d.growth.per_day_bytes) }}</b> a day (files, last 14 days).</p>
          <p class="mt-2 text-[12px]">Database quota ({{ f.bytes(d.growth.quota_bytes) }}):
            <b>{{ d.growth.quota_days == null ? (d.growth.db_storage == null ? 'measuring' : 'not at this pace') : 'about ' + d.growth.quota_days + ' days' }}</b></p>
          <p class="mt-1 text-[12px]">Disk ({{ d.growth.disk_free == null ? '–' : f.bytes(d.growth.disk_free) + ' free' }}):
            <b>{{ d.growth.disk_days == null ? 'measuring - needs six hours of samples' : 'about ' + d.growth.disk_days + ' days' }}</b></p>
        </section>
      </div>
    }

    <!-- PROJECTS -->
    <ng-container *ngTemplateOutlet="head; context: { id: 'projects', title: 'Projects', sub: d.catalog.folders + ' folders · ' + d.catalog.parts + ' parts in the drawer' }" />
    @if (open('projects')) {
      <div class="tcv-dash-grid">
        <section class="tcv-panel-d c12"><h3>Per project
            <button class="tcv-dl" (click)="dl('projects', d.catalog.projects)">CSV</button></h3>
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

    <!-- API -->
    <ng-container *ngTemplateOutlet="head; context: { id: 'api', title: 'API', sub: 'how long the server takes to answer, route by route' }" />
    @if (open('api')) {
      <div class="tcv-dash-grid">
        <section class="tcv-panel-d c6"><h3>Requests
            <button class="tcv-dl" (click)="dl('api-requests', seriesRows(d.api.per_bucket))">CSV</button></h3>
          <app-time-chart [data]="d.api.per_bucket" kind="bar" [legend]="false" [height]="160" /></section>
        <section class="tcv-panel-d c6"><h3>Average response time
            <button class="tcv-dl" (click)="dl('api-latency', seriesRows(d.api.latency))">CSV</button></h3>
          <app-time-chart [data]="d.api.latency" kind="line" [stacked]="false" [sums]="false" [legend]="false" [f]="ms" [height]="160" /></section>
        <section class="tcv-panel-d c12"><h3>Slowest routes
            <button class="tcv-dl" (click)="dl('api-routes', d.api.routes)">CSV</button></h3>
          <table class="tcv-dash-table">
            <thead><tr><th>route</th><th class="r">requests</th><th class="r">average</th><th class="r">p95</th><th class="r">slowest</th><th class="r">errors</th></tr></thead>
            <tbody>
              @for (r of d.api.routes; track r.route) {
                <tr><td class="mono" [title]="r.route">{{ r.route }}</td><td class="r mono">{{ r.count }}</td>
                  <td class="r mono">{{ ms(r.avg_ms) }}</td>
                  <td class="r mono">{{ r.p95_ms == null ? '–' : r.p95_ms > 10000 ? '> 10 s' : '≤ ' + ms(r.p95_ms) }}</td>
                  <td class="r mono">{{ ms(r.max_ms) }}</td>
                  <td class="r mono" [style.color]="r.errors ? 'var(--danger)' : null">{{ r.errors }}</td></tr>
              } @empty { <tr><td colspan="6" class="tcv-dash-dim">recorded from now on - once a minute, per route</td></tr> }
            </tbody>
          </table></section>
      </div>
    }

    <!-- RETRIES AND WASTE -->
    <ng-container *ngTemplateOutlet="head; context: { id: 'waste', title: 'Retries & waste', sub: 'work that went round in circles, or produced nothing kept' }" />
    @if (open('waste')) {
      <div class="tcv-dash-grid">
        <div class="tcv-stat c3"><span>Spent on re-runs</span><b>{{ f.money(d.waste.rerun_usd) }}</b>
          <em>{{ d.waste.rerun_runs }} runs of a note that was run again</em></div>
        <div class="tcv-stat c3"><span>Rejected notes</span><b>{{ f.money(d.waste.rejected_usd) }}</b>
          <em>{{ d.waste.rejected_notes }} notes</em></div>
        <div class="tcv-stat c3"><span>Failed jobs</span><b>{{ d.waste.failed_jobs }}</b>
          <em>{{ failedKinds(d) }}</em></div>
        <div class="tcv-stat c3"><span>Compute on failures</span><b>{{ f.hours(d.waste.failed_cpu_h) }}</b>
          <em>{{ f.wh(d.waste.failed_wh) }}</em></div>
        <section class="tcv-panel-d c8"><h3>Loops <i title="the same kind of job run five or more times for one note, or failing twice">ⓘ</i>
            <button class="tcv-dl" (click)="dl('loops', d.loops.jobs)">CSV</button></h3>
          <table class="tcv-dash-table">
            <thead><tr><th>note</th><th>job</th><th class="r">times</th><th class="r">failed</th><th class="r">time</th></tr></thead>
            <tbody>
              @for (l of d.loops.jobs; track l.id + l.kind) {
                <tr><td [title]="l.title">{{ l.title || l.id }}</td><td>{{ l.kind }}</td><td class="r mono">{{ l.runs }}</td>
                  <td class="r mono" [style.color]="l.failed ? 'var(--danger)' : null">{{ l.failed }}</td><td class="r mono">{{ f.secs(l.wall_s) }}</td></tr>
              } @empty { <tr><td colspan="5" class="tcv-dash-dim">no loops in this range</td></tr> }
            </tbody>
          </table></section>
        <section class="tcv-panel-d c4"><h3>Notes run more than once</h3>
          <table class="tcv-dash-table">
            <thead><tr><th>note</th><th class="r">runs</th></tr></thead>
            <tbody>
              @for (r of d.loops.reruns; track r.id) {
                <tr><td [title]="r.title">{{ r.title || r.id }}</td><td class="r mono">{{ r.runs }}</td></tr>
              } @empty { <tr><td colspan="2" class="tcv-dash-dim">every note ran once</td></tr> }
            </tbody>
          </table></section>
      </div>
    }

    <!-- UNUSUAL -->
    <ng-container *ngTemplateOutlet="head; context: { id: 'unusual', title: 'Unusual', sub: 'far above the usual - three times the median and well past the typical spread' }" />
    @if (open('unusual')) {
      <div class="tcv-dash-grid">
        <section class="tcv-panel-d c12">
          <table class="tcv-dash-table">
            <thead><tr><th>what</th><th>kind</th><th class="r">value</th><th class="r">usual</th><th class="r">×</th></tr></thead>
            <tbody>
              @for (a of d.anomalies.items; track $index) {
                <tr><td [title]="a.what">{{ a.kind === 'spend' ? when(a.what) : a.what }}</td><td>{{ a.kind }}</td>
                  <td class="r mono">{{ a.unit === 'usd' ? f.money(a.value) : f.secs(a.value) }}</td>
                  <td class="r mono">{{ a.unit === 'usd' ? f.money(a.typical) : f.secs(a.typical) }}</td>
                  <td class="r mono" style="color: var(--warn)">{{ a.typical ? (a.value / a.typical).toFixed(1) + '×' : '–' }}</td></tr>
              } @empty { <tr><td colspan="5" class="tcv-dash-dim">nothing out of the ordinary in this range</td></tr> }
            </tbody>
          </table></section>
      </div>
    }

    <!-- UPTIME AND DATABASE -->
    <ng-container *ngTemplateOutlet="head; context: { id: 'uptime', title: 'Uptime & database', sub: 'restarts, gaps, errors, and how long the database takes to answer' }" />
    @if (open('uptime')) {
      <div class="tcv-dash-grid">
        <div class="tcv-stat c3"><span>Up</span><b>{{ d.uptime.up_pct == null ? '–' : d.uptime.up_pct + '%' }}</b>
          <em>of {{ d.uptime.watched_hours }} h watched · {{ d.uptime.down_minutes }} min down</em></div>
        <div class="tcv-stat c3"><span>Server starts</span><b>{{ d.uptime.starts.length }}</b>
          <em>{{ d.uptime.starts.length ? 'last ' + when(d.uptime.starts[d.uptime.starts.length - 1].at) : 'none in this range' }}</em></div>
        <div class="tcv-stat c3"><span>Server errors</span><b>{{ d.uptime.errors_5xx }}</b>
          <em>{{ d.uptime.error_routes[0]?.route ?? 'no 5xx answers' }}</em></div>
        <div class="tcv-stat c3"><span>Database</span><b>{{ d.db_latency.median_ms == null ? '–' : ms(d.db_latency.median_ms) }}</b>
          <em>median round trip · p95 {{ d.db_latency.p95_ms == null ? '–' : ms(d.db_latency.p95_ms) }}</em></div>
        <section class="tcv-panel-d c8"><h3>Database round trip
            <button class="tcv-dl" (click)="dl('db-latency', seriesRows(d.db_latency.series))">CSV</button></h3>
          <app-time-chart [data]="d.db_latency.series" kind="line" [stacked]="false" [sums]="false" [legend]="false" [f]="ms" [height]="160" /></section>
        <section class="tcv-panel-d c4"><h3>Gaps <span class="tcv-dash-dim">(nobody sampling)</span></h3>
          <table class="tcv-dash-table">
            <thead><tr><th>from</th><th class="r">minutes</th></tr></thead>
            <tbody>
              @for (g of d.uptime.gaps; track g.from) {
                <tr><td class="mono">{{ when(g.from) }}</td><td class="r mono">{{ g.minutes }}</td></tr>
              } @empty { <tr><td colspan="2" class="tcv-dash-dim">no gaps</td></tr> }
            </tbody>
          </table></section>
      </div>
    }

    <!-- RECENT CHANGES -->
    <ng-container *ngTemplateOutlet="head; context: { id: 'audit', title: 'Recent changes', sub: 'every delete, change of state and settings change, and who made it' }" />
    @if (open('audit')) {
      <div class="tcv-dash-grid">
        <section class="tcv-panel-d c12"><h3>Audit trail
            <button class="tcv-dl" (click)="dl('audit', auditRows())">CSV</button></h3>
          <table class="tcv-dash-table">
            <thead><tr><th>what</th><th>who</th><th>kind</th><th class="r">when</th></tr></thead>
            <tbody>
              @for (a of auditRows(); track $index) {
                <tr><td class="mono" [title]="auditWhat(a)">{{ auditWhat(a) }}</td>
                  <td [style.color]="a.actor.type === 'agent' ? 'var(--accent)' : null">{{ a.actor.name }}</td>
                  <td>{{ a.action }}</td><td class="r mono">{{ when(a.at) }}</td></tr>
              } @empty { <tr><td colspan="4" class="tcv-dash-dim">nothing deleted or changed since the trail began</td></tr> }
            </tbody>
          </table></section>
      </div>
    }

    <!-- TOOLS -->
    <ng-container *ngTemplateOutlet="head; context: { id: 'tools', title: 'Tools', sub: 'which tools people and agents use, and which nobody does' }" />
    @if (open('tools')) { <app-tools-usage [days]="rangeDays()" /> }

    <!-- DOCKER -->
    <ng-container *ngTemplateOutlet="head; context: { id: 'docker', title: 'Docker', sub: 'the sandboxes and the KiCad image: what they hold on disk' }" />
    @if (open('docker')) {
      <div class="tcv-dash-grid">
        @if (d.docker.available) {
          <section class="tcv-panel-d c5"><h3>Summary</h3>
            <table class="tcv-dash-table">
              <thead><tr><th>kind</th><th class="r">total</th><th class="r">active</th><th class="r">size</th><th class="r">reclaimable</th></tr></thead>
              <tbody>
                @for (x of d.docker.summary ?? []; track x.type) {
                  <tr><td>{{ x.type }}</td><td class="r mono">{{ x.total }}</td><td class="r mono">{{ x.active }}</td>
                    <td class="r mono">{{ x.size }}</td><td class="r mono">{{ x.reclaimable }}</td></tr>
                }
              </tbody>
            </table>
            <p class="tcv-dash-dim mt-2">Reclaimable space is freed with <code>docker image prune</code> and <code>docker builder prune</code> - not done from here.</p>
            <h3 class="mt-3">Containers</h3>
            <table class="tcv-dash-table">
              <tbody>
                @for (c of d.docker.containers ?? []; track c.name) {
                  <tr><td [title]="c.image">{{ c.name }}</td><td [style.color]="c.state === 'running' ? 'var(--ok)' : null">{{ c.status }}</td></tr>
                }
              </tbody>
            </table></section>
          <section class="tcv-panel-d c7"><h3>Images
              <button class="tcv-dl" (click)="dl('docker-images', d.docker.images ?? [])">CSV</button></h3>
            <table class="tcv-dash-table">
              <thead><tr><th>image</th><th class="r">size</th><th class="r">made</th></tr></thead>
              <tbody>
                @for (i of d.docker.images ?? []; track i.name) {
                  <tr><td [title]="i.name" [style.font-weight]="i.redline ? 600 : null">{{ i.name }}</td>
                    <td class="r mono">{{ i.size }}</td><td class="r">{{ i.created }}</td></tr>
                }
              </tbody>
            </table></section>
        } @else {
          <section class="tcv-panel-d c12"><p class="tcv-dash-dim">Docker did not answer on this machine.</p></section>
        }
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

    <!-- WEEK IN SHORT: last, a summing-up of everything above -->
    <ng-container *ngTemplateOutlet="head; context: { id: 'weekly', title: 'The week in short', sub: 'the last seven days, and a write-up kept each Monday' }" />
    @if (open('weekly')) {
      <div class="tcv-dash-grid">
        <section class="tcv-panel-d c8"><h3>Last 7 days
            <button class="tcv-dl" (click)="copyWeek()">{{ copied() ? 'copied' : 'copy' }}</button></h3>
          @if (weekly(); as w) { <div class="md text-[12.5px]" [innerHTML]="w.now | md"></div> }
          @else { <p class="tcv-dash-dim">writing it up…</p> }
        </section>
        <section class="tcv-panel-d c4"><h3>Earlier weeks</h3>
          @for (k of weekly()?.kept ?? []; track k.week) {
            <details class="tcv-week"><summary>{{ k.week }}</summary><div class="md text-[12px]" [innerHTML]="k.text | md"></div></details>
          } @empty { <p class="tcv-dash-dim">The first is written next Monday, of the week before.</p> }
        </section>
      </div>
    }
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
    this.readWeekly();
    this.api.audit(100).subscribe({ next: a => this.auditRows.set(a) });
    this.arm();
  }
  /** A clock for the "next in" countdown, and when the next reading is due. */
  private now = signal(Date.now());
  private nextAt = signal(0);
  private tick = setInterval(() => this.now.set(Date.now()), 1000);
  nextIn = computed(() => this.every() ? Math.max(0, Math.round((this.nextAt() - this.now()) / 1000)) : null);

  ngOnDestroy() { clearInterval(this.timer); clearTimeout(this.again); clearInterval(this.tick); }

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
    this.nextAt.set(Date.now() + this.every() * 1000);
    if (this.every()) this.timer = setInterval(() => {
      this.nextAt.set(Date.now() + this.every() * 1000);
      this.load();
    }, this.every() * 1000);
  }
  /** The range as whole days, for panels that count by day (1 for the short ones). */
  rangeDays(): number {
    const r = this.range();
    return r === 'all' ? 365 : r.endsWith('d') ? Number(r.slice(0, -1)) : 1;
  }

  setRange(r: string) { this.range.set(r); keep('range', r); this.data.set(kept(r) ?? this.data()); this.load(); }
  setEvery(s: number) { this.every.set(s); keep('every', String(s)); this.arm(); }
  open(id: Section | string) { return !this.shut().has(id); }
  fold(id: string) {
    const s = new Set(this.shut());
    if (s.has(id)) s.delete(id); else s.add(id);
    this.shut.set(s); keep('shut', JSON.stringify([...s]));
  }
  openQ = signal<string | null>(null);

  // ---- one project ----
  project = signal(recall('project', ''));
  projectNames = computed(() => Object.keys(this.data()?.project_detail ?? {}).sort());
  setProject(p: string) { this.project.set(p); keep('project', p); }
  kindsLine(pd: ProjectDetail): string {
    const n = (k: string) => pd.items.filter(i => i.kind === k).length;
    return [`${n('model')} models`, `${n('board')} boards`, `${n('app')} apps`].join(' · ');
  }
  walls(it: ProjectItem): number[] { return (it.build_walls ?? []).filter(w => w.ok).map(w => w.wall_s ?? 0); }
  boardSeries(it: ProjectItem): (number | null)[] { return (it.board_runs ?? []).map(r => r.unrouted); }

  // ---- change against the period before ----
  delta(d: Insights, key: string): { text: string; up: boolean } | null {
    const c = d.change?.[key];
    if (c == null) return null;
    return { text: `${c >= 0 ? '▲' : '▼'} ${Math.abs(c).toFixed(0)}% vs the ${this.range()} before`, up: c >= 0 };
  }

  auditRows = signal<AuditRow[]>([]);
  auditWhat(a: AuditRow): string {
    const q = a.detail?.query;
    return `${a.detail?.method ?? ''} ${a.target}${q ? '?' + q : ''}`.trim();
  }

  // ---- the week in short ----
  weekly = signal<{ now: string; kept: { at: string; week: string; text: string }[] } | null>(null);
  copied = signal(false);
  private readWeekly() { this.api.weekly().subscribe({ next: w => this.weekly.set(w) }); }
  copyWeek() {
    const t = this.weekly()?.now;
    if (!t) return;
    navigator.clipboard?.writeText(t).then(() => { this.copied.set(true); setTimeout(() => this.copied.set(false), 1500); });
  }
  failedKinds(d: Insights): string {
    const k = Object.entries(d.waste.failed_by_kind ?? {});
    return k.length ? k.map(([n, c]) => `${c} ${n}`).join(' · ') : 'none';
  }

  setPrice(v: string) { this.save({ kwh_price: v === '' ? null : Math.max(0, +v) }); }
  setPlan(v: string) { this.save({ plan_usd_month: v === '' ? null : Math.max(0, +v) }); }
  setPlanName(v: string) { this.save({ plan_name: v.trim() || null }); }
  private save(patch: Parameters<InsightsApi['setSettings']>[0]) {
    this.api.setSettings(patch).subscribe({ next: () => this.load() });
  }

  readonly ms = (v: number) => v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1) + ' s' : Math.round(v) + ' ms';
  dur(s: number | null | undefined): string { return s == null ? '–' : fmt.secs(s); }
  when(iso: string): string {
    return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  quality(r: BoardRunRow): string {
    return `${r.unrouted ?? '?'} unrouted, DRC ${r.drc_errors ?? '?'}` + (r.area_cm2 ? `, ${r.area_cm2} cm²` : '');
  }

  // ---- export ----

  /** A time series as rows: one per bucket, a column per series. */
  seriesRows(d: InsightSeries): Record<string, unknown>[] {
    return Array.from({ length: d.n }, (_, i) => ({
      time: new Date((d.t0 + i * d.step) * 1000).toISOString(),
      ...Object.fromEntries(d.series.map(s => [s.name, s.values[i]])),
    }));
  }

  /** Any panel's rows, downloaded as CSV. */
  dl(name: string, rows: object[]) {
    const flat = rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) =>
      [k, v !== null && typeof v === 'object' ? JSON.stringify(v) : v])));
    const cols = [...new Set(flat.flatMap(r => Object.keys(r)))];
    const cell = (v: unknown) => {
      const t = v == null ? '' : String(v);
      return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
    };
    const text = [cols.join(','), ...flat.map(r => cols.map(c => cell((r as Record<string, unknown>)[c])).join(','))].join('\n');
    this.save_(`redline-${name}-${this.range()}.csv`, text, 'text/csv');
  }

  /** The whole answer for the range, as JSON. */
  exportAll() {
    const d = this.data();
    if (d) this.save_(`redline-analytics-${this.range()}.json`, JSON.stringify(d, null, 1), 'application/json');
  }

  private save_(file: string, text: string, type: string) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url; a.download = file; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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

/** The shape of the answer this page reads; one kept in another shape is
 *  not shown (backend/insights.py SHAPE). */
const SHAPE = 3;

function kept(range: string): Insights | null {
  try {
    const d = JSON.parse(localStorage.getItem('x3.analytics.data.' + range) ?? 'null');
    return d?.shape === SHAPE ? d : null;
  } catch { return null; }
}
function keepData(range: string, d: Insights) {
  try { localStorage.setItem('x3.analytics.data.' + range, JSON.stringify(d)); } catch { /* full or private */ }
}
