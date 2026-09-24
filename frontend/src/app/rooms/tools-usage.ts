import { Component, computed, effect, input, signal } from '@angular/core';
import { BarList, Donut, Row, TimeChart, TimeData, fmt } from './charts';

/** GET /api/tools/usage/summary */
interface UsageSummary {
  days: number;
  total: number;
  tools_available: number;
  tools_used: number;
  tools: { id: string; name: string; group: string | null; total: number; [event: string]: string | number | null }[];
  by_day: { day: string; n: number }[];
  by_surface: Record<string, number>;
  by_event: Record<string, number>;
  unused: string[];
}

const SURFACE: Record<string, string> = { ui: 'people, in the app', mcp: 'agents, over MCP', api: 'the API' };

/** The Analytics tab's Tools section: which tools are used, how, and by
 *  whom - people in the Tools tab, or agents through the MCP server. Its own
 *  component, reading its own endpoint, so the dashboard stays one file's
 *  business and this one another's. */
@Component({
  selector: 'app-tools-usage',
  imports: [BarList, Donut, TimeChart],
  template: `
@if (data(); as d) {
  <div class="tcv-dash-grid">
    <div class="tcv-stat c2"><span>Uses</span><b>{{ d.total }}</b><em>opens, runs, copies, finds</em></div>
    <div class="tcv-stat c2"><span>Tools used</span><b>{{ d.tools_used }}</b><em>of {{ d.tools_available }}</em></div>
    <div class="tcv-stat c2"><span>By agents</span><b>{{ d.by_surface['mcp'] || 0 }}</b><em>through MCP</em></div>
    <div class="tcv-stat c2"><span>Runs</span><b>{{ d.by_event['run'] || 0 }}</b><em>a tool computed</em></div>
    <div class="tcv-stat c2"><span>Finds</span><b>{{ d.by_event['find'] || 0 }}</b><em>picked for an agent</em></div>
    <div class="tcv-stat c2"><span>Favourites</span><b>{{ (d.by_event['favourite'] || 0) - (d.by_event['unfavourite'] || 0) }}</b><em>starred, net</em></div>

    <section class="tcv-panel-d c8"><h3>Uses by day
      <button class="tcv-dl" (click)="csv()">CSV</button></h3>
      @if (series(); as s) { <app-time-chart [data]="s" kind="bar" [legend]="false" [f]="f.count" [height]="170" /> }
    </section>
    <section class="tcv-panel-d c4"><h3>Who uses them</h3>
      <app-donut [rows]="surfaces()" [f]="f.count" /></section>

    <section class="tcv-panel-d c6"><h3>Most used</h3>
      <app-bar-list [rows]="top()" [f]="f.count" /></section>
    <section class="tcv-panel-d c6"><h3>Most used by agents</h3>
      @if (agents().length) { <app-bar-list [rows]="agents()" [f]="f.count" /> }
      @else { <p class="text-[12px]" style="color: var(--ink-dim)">No agent has used a tool in this period.</p> }</section>

    <section class="tcv-panel-d c12"><h3>Never used in {{ d.days }} days · {{ d.unused.length }}</h3>
      <p class="text-[12px]" style="color: var(--ink-dim); line-height: 1.6">{{ d.unused.join(', ') || 'every tool was used' }}</p></section>
  </div>
} @else if (error()) {
  <p class="text-[12px]" style="color: var(--ink-dim)">{{ error() }}</p>
} @else {
  <p class="text-[12px]" style="color: var(--ink-dim)">Reading tool usage…</p>
}`,
})
export class ToolsUsage {
  /** The dashboard's range, as days. */
  days = input(30);
  readonly f = fmt;
  data = signal<UsageSummary | null>(null);
  error = signal('');

  constructor() {
    effect(() => {
      const days = this.days();
      fetch(`/api/tools/usage/summary?days=${days}`)
        .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d: UsageSummary) => { if (days === this.days()) this.data.set(d); })
        .catch(e => this.error.set(`Tool usage did not load: ${e.message}`));
    });
  }

  /** One bar a day across the whole range, empty days included. */
  series = computed((): TimeData | null => {
    const d = this.data();
    if (!d) return null;
    const day = 86400;
    const end = Math.floor(Date.now() / 1000 / day) * day;
    const t0 = end - (d.days - 1) * day;
    const values = Array.from({ length: d.days }, () => 0);
    for (const r of d.by_day) {
      const i = Math.round((Date.parse(r.day + 'T00:00:00Z') / 1000 - t0) / day);
      if (i >= 0 && i < d.days) values[i] += r.n;
    }
    return { t0, step: day, n: d.days, series: [{ name: 'uses', values }] };
  });

  surfaces = computed((): Row[] => Object.entries(this.data()?.by_surface ?? {})
    .map(([k, v]) => ({ name: SURFACE[k] ?? k, value: v })));

  top = computed((): Row[] => (this.data()?.tools ?? []).slice(0, 12)
    .map(t => ({ name: t.name, value: t.total, sub: this.split(t) })));

  agents = computed((): Row[] => (this.data()?.tools ?? [])
    .map(t => ({ name: t.name, value: Number(t['run'] ?? 0) + Number(t['find'] ?? 0) + Number(t['manual'] ?? 0) }))
    .filter(r => r.value > 0).sort((a, b) => b.value - a.value).slice(0, 10));

  private split(t: Record<string, unknown>): string {
    return ['open', 'run', 'copy', 'find'].filter(k => t[k]).map(k => `${t[k]} ${k}`).join(' · ');
  }

  csv() {
    const d = this.data();
    if (!d) return;
    const events = ['open', 'run', 'copy', 'check', 'find', 'manual', 'favourite', 'unfavourite'];
    const lines = [['tool', 'name', 'group', 'total', ...events].join(',')];
    for (const t of d.tools) {
      lines.push([t.id, `"${String(t.name).replace(/"/g, '""')}"`, t.group ?? '', t.total,
        ...events.map(e => t[e] ?? 0)].join(','));
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'text/csv' }));
    a.download = `tools-usage-${d.days}d.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}
