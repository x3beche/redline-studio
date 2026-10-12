import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { NgTemplateOutlet } from '@angular/common';
import { LANG, T, t } from './i18n';
import { Avatar, avatarColour } from './avatar';
import { CountUp } from './count';
import { Skeleton } from './skeleton';
import { SelectOption, UiSelect } from './ui-select';
import { BarList, Donut, Row, TimeChart, TimeData, fmt } from './rooms/charts';
import { DASH_EVERYS, DASH_RANGES, csvText, saveFile, seriesRows, stepLabel, stepWord } from './rooms/dash';
import type { AdminUser } from './admin-users';

/** Settings > Dashboard, for the owner and the admins: the server at a
 *  glance (GET /api/admin/overview, backend/admin.py), laid out as the
 *  Analytics room lays out its own (rooms/analyze.ts, the same classes):
 *  a range and a refresh at the top, then rows that fold away - Overview
 *  (what the people did against the period before, and what is kept),
 *  People, Projects, Models, and the trail's Latest lines. The server
 *  names people by id; their names and colours come from the accounts list
 *  (GET /api/admin/users). */
interface Person { id: string; sign_ins: number; changes: number; messages: number; tools: number;
  projects: number; models: number; files: number; last: string | null }
interface Ranked { name: string; calls: number; tokens: number; cost_usd: number; provider?: string }
type Sums = Record<'sign_ins' | 'changes' | 'messages' | 'tools' | 'agents' | 'llm_calls' | 'tokens' | 'cost_usd' | 'active', number>;
interface Overview {
  range: { id: string; since: string; until: string; step: number };
  totals: { users: number; projects: number; models: number; boards: number; files: number; chats: number; messages: number };
  sums: Sums;
  previous: Sums | null;
  change: Partial<Record<keyof Sums, number | null>>;
  activity: TimeData;
  people: Person[];
  projects: { name: string; user: string | null; models: number; boards: number; moves: number;
              versions: number; edits: number; last: string | null }[];
  llm: { calls: number; tokens: number; cost_usd: number; spend_by_model: TimeData; tokens_by_type: TimeData;
         calls_by_model: TimeData; by_model: Ranked[]; by_provider: Ranked[] };
  feed: { at: string; user: string; action: string; target: string }[];
}

/** The trail's actions as a line says them; any other is its own name. */
const DID: Record<string, string> = {
  'sign-in': 'logged in', 'switch': 'switched to their account', 'change': 'made a change to', 'delete': 'removed',
  'edit': 'made an edit to', 'settings': 'changed the settings of', 'user-add': 'added the account',
  'user-edit': 'edited the account', 'user-delete': 'deleted the account', 'password': 'changed the password',
  'token': 'made the token', 'token-delete': 'deleted the token', 'release': 'released', 'convert': 'converted',
  'queue-task': 'queued a task in', 'remember': 'stayed signed in on',
};
/** The chart's series as the page names them (the server's names are its own). */
const SERIES: Record<string, string> = { 'Changes': 'Changes made', 'Agents': 'Agent actions' };

@Component({
  selector: 'app-admin-overview',
  imports: [T, Avatar, CountUp, Skeleton, TimeChart, BarList, Donut, UiSelect, NgTemplateOutlet],
  styles: [`
    /* On the room's own ground, as Analytics is (.tcv-panel), so its tiles and
       panels stand out from it the same way rather than sink into the stage. */
    :host { display: block; min-width: 0; min-height: 100%; background: var(--surface); }
    /* Tiles and panels a step lighter than that ground in every dark theme
       (surface-2 is darker than surface in many of them); a light theme keeps
       its paler well. */
    :host { --tcv-raised: color-mix(in srgb, var(--surface) 92%, var(--ink-bright)); }
    :host-context([data-theme="light"], [data-theme="github-light"], [data-theme="gruvbox-light"], [data-theme="solarized-light"],
                  [data-theme="vscode-light"], [data-theme="catppuccin-latte"]) { --tcv-raised: var(--surface-2); }
    .tcv-panel-d, .tcv-stat { background: var(--tcv-raised); }
    /* The range bar stays at the top of the stage as it scrolls. */
    .tcv-dash-bar { position: sticky; top: 0; z-index: 2; }
    @media (max-width: 768px) { .tcv-dash-bar { position: static; } }
    .ao-who { display: flex; align-items: center; gap: 7px; min-width: 0; }
    .ao-who > b { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-weight: 500; color: var(--ink-bright); }
    .ao-who > app-avatar { flex: none; }
    /* The people's and the trail's tables: the name needs less than Analytics' 40%. */
    .ao-people th:first-child, .ao-people td:first-child { width: 22%; }
    .ao-projects th:first-child, .ao-projects td:first-child { width: 24%; }
    .ao-projects th:nth-child(2), .ao-projects td:nth-child(2) { width: 24%; }
    .ao-h3 { margin-top: 14px !important; }
    /* A tile's change stays on one line, as narrow as the tile is. */
    .tcv-stat .tcv-delta { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ao-feed th:first-child, .ao-feed td:first-child { width: 12%; }
    .ao-feed th:nth-child(2), .ao-feed td:nth-child(2) { width: 20%; }
    .ao-feed th:nth-child(3), .ao-feed td:nth-child(3) { width: 20%; }
    .ao-feed tbody td:first-child { color: var(--ink-dim); }
    .ao-sk { display: contents; }
  `],
  template: `
<header class="tcv-dash-bar">
  <div class="tcv-dash-seg" role="group" [attr.aria-label]="'Range' | t">
    @for (r of ranges; track r.id) {
      <button type="button" (click)="setRange(r.id)" [attr.data-on]="range() === r.id ? 1 : null" [attr.aria-pressed]="range() === r.id">{{ r.label | t }}</button>
    }
  </div>
  <span class="flex-1"></span>
  @if (data(); as d) {
    <!-- How the range is cut, when it was read, and when the next reading is due. -->
    <span class="tcv-dash-meta">{{ stepLabel(d.range.step) | t }} · {{ 'updated' | t }} {{ updated() }}
      · {{ nextIn() === null ? ('no auto refresh' | t) : loading() ? ('refreshing…' | t) : ('next in' | t) + ' ' + nextIn() + ' s' }}</span>
  }
  <wb-select class="tcv-dash-sel" [label]="'Refresh' | t" [tip]="'refresh on its own' | t" [options]="everyOpts()" [value]="'' + every()" (pick)="setEvery(+$event)" />
  <button type="button" (click)="exportAll()" class="tcv-btn px-2 py-0.5" [disabled]="!data()" [title]="'everything in this range, as JSON' | t">{{ 'Export' | t }}</button>
  <button type="button" (click)="load()" class="tcv-btn px-2 py-0.5" [disabled]="loading()" [title]="'read it again' | t">{{ loading() ? '…' : '↻' }}</button>
</header>

<div class="tcv-dash-body">
@if (data(); as d) {
  <!-- OVERVIEW: what the people did against the period before, then what is kept -->
  <ng-container *ngTemplateOutlet="head; context: { id: 'overview', title: 'Overview', sub: rangeLabel() }" />
  @if (open('overview')) {
    <div class="tcv-dash-grid wb-in">
      <div class="tcv-stat c2"><span>{{ 'Active people' | t }}</span><b [wbCount]="d.sums.active"></b>
        <em>{{ 'of' | t }} {{ d.totals.users }} {{ 'accounts' | t }}</em>
        <ng-container *ngTemplateOutlet="change; context: { k: 'active' }" /></div>
      <div class="tcv-stat c2"><span>{{ 'Sign-ins' | t }}</span><b [wbCount]="f.count(d.sums.sign_ins)"></b>
        <em>{{ 'by' | t }} {{ doers('sign_ins') }} {{ 'people' | t }}</em>
        <ng-container *ngTemplateOutlet="change; context: { k: 'sign_ins' }" /></div>
      <div class="tcv-stat c2"><span>{{ 'Changes made' | t }}</span><b [wbCount]="f.count(d.sums.changes)"></b>
        <em>{{ 'by' | t }} {{ doers('changes') }} {{ 'people' | t }}</em>
        <ng-container *ngTemplateOutlet="change; context: { k: 'changes' }" /></div>
      <div class="tcv-stat c2"><span>{{ 'Messages' | t }}</span><b [wbCount]="f.count(d.sums.messages)"></b>
        <em>{{ 'in the Chat and to each other' | t }}</em>
        <ng-container *ngTemplateOutlet="change; context: { k: 'messages' }" /></div>
      <div class="tcv-stat c2"><span>{{ 'Tool uses' | t }}</span><b [wbCount]="f.count(d.sums.tools)"></b>
        <em>{{ 'by' | t }} {{ doers('tools') }} {{ 'people' | t }}</em>
        <ng-container *ngTemplateOutlet="change; context: { k: 'tools' }" /></div>
      <div class="tcv-stat c2"><span>{{ 'Agent actions' | t }}</span><b [wbCount]="f.count(d.sums.agents)"></b>
        <em>{{ 'changes and tool uses by agents' | t }}</em>
        <ng-container *ngTemplateOutlet="change; context: { k: 'agents' }" /></div>
      <div class="tcv-stat c3"><span>{{ 'Model spend' | t }}</span><b [wbCount]="f.money(d.sums.cost_usd)"></b>
        <em>{{ 'at API list prices' | t }} · {{ f.count(d.sums.llm_calls) }} {{ 'calls' | t }}</em>
        <ng-container *ngTemplateOutlet="change; context: { k: 'cost_usd' }" /></div>
      <div class="tcv-stat c3"><span>{{ 'Model tokens' | t }}</span><b [wbCount]="f.count(d.sums.tokens)"></b>
        <em>{{ f.count(tokSum('output')) }} {{ 'written' | t }} · {{ f.count(tokSum('cache_read')) }} {{ 'cache reads' | t }}</em>
        <ng-container *ngTemplateOutlet="change; context: { k: 'tokens' }" /></div>
      <div class="tcv-stat c3"><span>{{ 'Projects' | t }}</span><b [wbCount]="d.totals.projects"></b>
        <em>{{ d.totals.models }} {{ 'models' | t }} · {{ d.totals.boards }} {{ 'boards' | t }} · {{ moved() }} {{ 'moved in the range' | t }}</em></div>
      <div class="tcv-stat c3"><span>{{ 'Files' | t }}</span><b [wbCount]="d.totals.files"></b>
        <em>{{ d.totals.chats }} {{ 'chats' | t }} · {{ f.count(d.totals.messages) }} {{ 'messages kept' | t }}</em></div>
      <section class="tcv-panel-d c12"><h3>{{ 'Activity' | t }} <span class="tcv-dash-dim">{{ 'per' | t }} {{ stepWord(d.range.step) | t }}</span>
          <button class="tcv-dl" (click)="dl('activity', rowsOf(d.activity))">CSV</button></h3>
        <app-time-chart [data]="chart()" kind="bar" [height]="190" /></section>
    </div>
  }

  <!-- PEOPLE -->
  <ng-container *ngTemplateOutlet="head; context: { id: 'people', title: 'People', sub: d.sums.active + ' ' + t('of') + ' ' + d.totals.users + ' ' + t('accounts active in the range') }" />
  @if (open('people')) {
    <div class="tcv-dash-grid">
      <section class="tcv-panel-d c4"><h3>{{ 'By person' | t }} <span class="tcv-dash-dim">{{ 'sign-ins, changes, messages, tool uses' | t }}</span></h3>
        <app-bar-list [rows]="byPerson()" /></section>
      <section class="tcv-panel-d c4"><h3>{{ 'Sign-ins by person' | t }}</h3>
        <app-bar-list [rows]="signIns()" /></section>
      <section class="tcv-panel-d c4"><h3>{{ 'What was done' | t }}</h3>
        <app-donut [rows]="kinds()" /></section>
      <section class="tcv-panel-d c12"><h3>{{ 'Every account' | t }}
          <button class="tcv-dl" (click)="dl('people', peopleCsv())">CSV</button></h3>
        <table class="tcv-dash-table ao-people">
          <thead><tr><th>{{ 'person' | t }}</th><th>{{ 'role' | t }}</th><th class="r">{{ 'last seen' | t }}</th>
            <th class="r">{{ 'sign-ins' | t }}</th><th class="r">{{ 'changes' | t }}</th><th class="r">{{ 'messages' | t }}</th>
            <th class="r">{{ 'tool uses' | t }}</th><th class="r">{{ 'projects' | t }}</th><th class="r">{{ 'models' | t }}</th><th class="r">{{ 'files' | t }}</th></tr></thead>
          <tbody>
            @for (p of people(); track p.id) {
              <tr><td><ng-container *ngTemplateOutlet="person; context: { id: p.id }" /></td>
                <td>{{ (who(p.id)?.role ?? '') | t }}</td>
                <td class="r mono" [title]="p.last ? when(p.last) : ''">{{ p.last ? ago(p.last) : '–' }}</td>
                <td class="r mono">{{ p.sign_ins }}</td><td class="r mono">{{ p.changes }}</td><td class="r mono">{{ p.messages }}</td>
                <td class="r mono">{{ p.tools }}</td><td class="r mono">{{ p.projects }}</td><td class="r mono">{{ p.models }}</td>
                <td class="r mono">{{ p.files }}</td></tr>
            }
          </tbody>
        </table></section>
    </div>
  }

  <!-- PROJECTS -->
  <ng-container *ngTemplateOutlet="head; context: { id: 'projects', title: 'Projects', sub: d.totals.projects + ' ' + t('projects') + ' · ' + t('versions asked for and items edited') }" />
  @if (open('projects')) {
    <div class="tcv-dash-grid">
      <section class="tcv-panel-d c4"><h3>{{ 'Most active projects' | t }}</h3>
        <app-bar-list [rows]="byProject()" />
        @if (!byProject().length) { <p class="tcv-dash-dim">{{ 'Nothing moved in this range.' | t }}</p> }</section>
      <section class="tcv-panel-d c8"><h3>{{ 'Per project' | t }}
          <button class="tcv-dl" (click)="dl('projects', d.projects)">CSV</button></h3>
        <table class="tcv-dash-table ao-projects">
          <thead><tr><th>{{ 'project' | t }}</th><th>{{ 'owner' | t }}</th><th class="r">{{ 'models' | t }}</th><th class="r">{{ 'boards' | t }}</th>
            <th class="r">{{ 'versions' | t }}</th><th class="r">{{ 'edits' | t }}</th><th class="r">{{ 'last moved' | t }}</th></tr></thead>
          <tbody>
            @for (p of d.projects; track p.name + p.user) {
              <tr><td [title]="p.name">{{ p.name }}</td><td><ng-container *ngTemplateOutlet="person; context: { id: p.user }" /></td>
                <td class="r mono">{{ p.models }}</td><td class="r mono">{{ p.boards }}</td>
                <td class="r mono">{{ p.versions }}</td><td class="r mono">{{ p.edits }}</td>
                <td class="r mono" [title]="p.last ? when(p.last) : ''">{{ p.last ? ago(p.last) : '–' }}</td></tr>
            } @empty { <tr><td colspan="7" class="tcv-dash-dim">{{ 'No projects yet.' | t }}</td></tr> }
          </tbody>
        </table></section>
    </div>
  }

  <!-- MODELS -->
  <ng-container *ngTemplateOutlet="head; context: { id: 'models', title: 'Models', sub: f.count(d.llm.calls) + ' ' + t('calls') + ' · ' + f.count(d.llm.tokens) + ' ' + t('model tokens') + ' · ' + f.money(d.llm.cost_usd) }" />
  @if (open('models')) {
    <div class="tcv-dash-grid">
      <section class="tcv-panel-d c8"><h3>{{ 'Spend by model' | t }}
          <button class="tcv-dl" (click)="dl('spend-by-model', rowsOf(d.llm.spend_by_model))">CSV</button></h3>
        <app-time-chart [data]="d.llm.spend_by_model" kind="bar" [f]="f.money" [height]="200" /></section>
      <!-- By model, and under it by provider: one column beside the spend. -->
      <section class="tcv-panel-d c4"><h3>{{ 'By model' | t }}
          <button class="tcv-dl" (click)="dl('models', d.llm.by_model)">CSV</button></h3>
        <app-bar-list [rows]="ranked(d.llm.by_model)" [f]="byCost() ? f.money : f.count" />
        @if (!d.llm.by_model.length) { <p class="tcv-dash-dim">{{ 'No model calls in this range.' | t }}</p> }
        <h3 class="ao-h3">{{ 'By provider' | t }}</h3>
        <app-bar-list [rows]="ranked(d.llm.by_provider)" [f]="byCost() ? f.money : f.count" /></section>
      <section class="tcv-panel-d c6"><h3>{{ 'Tokens by type' | t }}
          <button class="tcv-dl" (click)="dl('tokens-by-type', rowsOf(d.llm.tokens_by_type))">CSV</button></h3>
        <app-time-chart [data]="tokenChart()" kind="area" [f]="f.count" [height]="160" /></section>
      <section class="tcv-panel-d c6"><h3>{{ 'Calls by model' | t }}
          <button class="tcv-dl" (click)="dl('calls-by-model', rowsOf(d.llm.calls_by_model))">CSV</button></h3>
        <app-time-chart [data]="d.llm.calls_by_model" kind="bar" [f]="f.count" [height]="160" /></section>
    </div>
  }

  <!-- LATEST: the trail's latest lines -->
  <ng-container *ngTemplateOutlet="head; context: { id: 'latest', title: 'Latest', sub: t('what the people did, newest first') }" />
  @if (open('latest')) {
    <div class="tcv-dash-grid">
      <section class="tcv-panel-d c12"><h3>{{ 'The trail' | t }}
          <button class="tcv-dl" (click)="dl('latest', d.feed)">CSV</button></h3>
        <table class="tcv-dash-table ao-feed">
          <thead><tr><th>{{ 'when' | t }}</th><th>{{ 'who' | t }}</th><th>{{ 'did' | t }}</th><th>{{ 'what' | t }}</th></tr></thead>
          <tbody>
            @for (e of d.feed; track $index) {
              <tr><td class="mono" [title]="when(e.at)">{{ ago(e.at) }}</td>
                <td><ng-container *ngTemplateOutlet="person; context: { id: e.user }" /></td>
                <td>{{ did(e.action) }}</td>
                <td class="mono" [title]="e.target">{{ quiet(e.action) ? '' : e.target }}</td></tr>
            } @empty { <tr><td colspan="4" class="tcv-dash-dim">{{ 'Nothing in this period.' | t }}</td></tr> }
          </tbody>
        </table></section>
    </div>
  }
} @else if (err(); as e) {
  <p class="tcv-dash-note" style="color: var(--danger)">{{ e }}</p>
} @else {
  <div class="tcv-dash-grid">
    <wb-skel class="c12" kind="tiles" [count]="10" [min]="150" [h]="72" />
    <section class="tcv-panel-d c12"><wb-skel kind="chart" [h]="190" /></section>
    @for (i of [1, 2, 3]; track i) { <section class="tcv-panel-d c4"><wb-skel kind="rows" [count]="5" [h]="20" /></section> }
  </div>
}
</div>

<ng-template #head let-id="id" let-title="title" let-sub="sub">
  <button type="button" class="tcv-dash-row" (click)="fold(id)" [attr.aria-expanded]="open(id)">
    <span class="tcv-dash-caret">{{ open(id) ? '▾' : '▸' }}</span>
    <span class="tcv-dash-rowtitle">{{ title | t }}</span>
    <span class="tcv-dash-dim truncate">{{ sub }}</span>
  </button>
</ng-template>
<ng-template #change let-k="k">
  @if (delta(k); as dl) { <i class="tcv-delta" [attr.data-up]="dl.up ? 1 : null">{{ dl.text }}</i> }
</ng-template>
<ng-template #person let-id="id">
  @if (who(id); as u) {
    <span class="ao-who"><app-avatar [name]="u.name" [userId]="u.id" [hasPicture]="u.has_avatar" [v]="u.avatar_v" [colour]="u.avatar_colour" [size]="18" />
      <b>{{ u.name }}</b></span>
  } @else { <span class="tcv-dash-dim">{{ id ? ('someone' | t) : '–' }}</span> }
</ng-template>`,
})
export class AdminOverview implements OnDestroy {
  private http = inject(HttpClient);
  /** The accounts (GET /api/admin/users): names, pictures and colours. */
  users = signal<AdminUser[]>([]);

  readonly f = fmt;
  readonly t = t;
  readonly ranges = DASH_RANGES;
  readonly stepLabel = stepLabel;
  readonly stepWord = stepWord;
  everyOpts = computed<SelectOption[]>(() => { LANG(); return DASH_EVERYS.map(e => ({ value: '' + e.s, label: t(e.label) })); });

  range = signal(recall('range', '7d'));
  every = signal(+recall('every', '60'));
  shut = signal<Set<string>>(new Set(JSON.parse(recall('shut', '[]'))));
  data = signal<Overview | null>(null);
  loading = signal(false);
  err = signal('');
  private at = signal<Date | null>(null);
  private timer?: ReturnType<typeof setInterval>;
  /** A clock for the "next in" countdown, and when the next reading is due. */
  private now = signal(Date.now());
  private nextAt = signal(0);
  private tick = setInterval(() => this.now.set(Date.now()), 1000);
  nextIn = computed(() => this.every() ? Math.max(0, Math.round((this.nextAt() - this.now()) / 1000)) : null);

  constructor() {
    this.load();
    this.http.get<{ users: AdminUser[] }>('/api/admin/users').subscribe({ next: d => this.users.set(d.users), error: () => {} });
    this.arm();
  }
  ngOnDestroy() { clearInterval(this.timer); clearInterval(this.tick); }

  load() {
    this.loading.set(true);
    const range = this.range();
    this.http.get<Overview>('/api/admin/overview', { params: { range } }).subscribe({
      next: d => {
        if (range !== this.range()) return;
        this.data.set(d); this.err.set(''); this.loading.set(false); this.at.set(new Date());
      },
      error: () => { this.loading.set(false); if (!this.data()) this.err.set(t('The overview did not load.')); },
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
  setRange(r: string) { if (r === this.range()) return; this.range.set(r); keep('range', r); this.load(); }
  setEvery(s: number) { this.every.set(s); keep('every', String(s)); this.arm(); }
  open(id: string) { return !this.shut().has(id); }
  fold(id: string) {
    const s = new Set(this.shut());
    if (s.has(id)) s.delete(id); else s.add(id);
    this.shut.set(s); keep('shut', JSON.stringify([...s]));
  }

  /** The change against the period before, as Analytics words it. */
  delta(k: keyof Sums): { text: string; up: boolean } | null {
    const d = this.data(), c = d?.change?.[k];
    if (c == null) return null;
    const r = d!.range.id;
    return { text: `${c >= 0 ? '▲' : '▼'} ${Math.abs(c).toFixed(0)}% ` + (LANG() === 'tr' ? `önceki ${r}'den` : `vs the ${r} before`), up: c >= 0 };
  }

  updated = computed(() => this.at()?.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) ?? '');
  rangeLabel = computed(() => {
    const d = this.data();
    if (!d) return '';
    const o: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
    const loc = LANG() === 'tr' ? 'tr-TR' : 'en-GB';
    return `${new Date(d.range.since).toLocaleString(loc, o)} → ${new Date(d.range.until).toLocaleString(loc, o)}`;
  });

  /** The chart's series in the page's language. */
  chart = computed<TimeData>(() => {
    const a = this.data()!.activity;
    return { ...a, series: a.series.map(s => ({ ...s, name: t(SERIES[s.name] ?? s.name) })) };
  });
  tokenChart = computed<TimeData>(() => {
    const a = this.data()!.llm.tokens_by_type;
    return { ...a, series: a.series.map(s => ({ ...s, name: s.name.replace(/_/g, ' ') })) };
  });
  tokSum(kind: string) {
    return (this.data()?.llm.tokens_by_type.series.find(s => s.name === kind)?.values ?? []).reduce<number>((a, v) => a + (v ?? 0), 0);
  }
  /** How many people did this in the range. */
  doers(k: 'sign_ins' | 'changes' | 'messages' | 'tools') { return (this.data()?.people ?? []).filter(p => p[k] > 0).length; }
  moved = computed(() => (this.data()?.projects ?? []).filter(p => p.moves > 0).length);

  who(id: string | null | undefined) { return this.users().find(u => u.id === id) ?? null; }
  private name(id: string | null | undefined) { return this.who(id)?.name ?? id ?? ''; }
  private colour(id: string | null | undefined) {
    const u = this.who(id);
    return u ? avatarColour(u.name, u.avatar_colour) : 'var(--ink-dim)';
  }
  private did4(p: Person) { return p.sign_ins + p.changes + p.messages + p.tools; }

  /** Everyone, the busiest first, then the last seen. */
  people = computed(() => [...(this.data()?.people ?? [])]
    .sort((a, b) => this.did4(b) - this.did4(a) || (b.last ?? '').localeCompare(a.last ?? '')));
  /** Each person's doings in the range, in their own colour, most first. */
  byPerson = computed<Row[]>(() => this.people().filter(p => this.did4(p) > 0)
    .map(p => ({ name: this.name(p.id), value: this.did4(p), color: this.colour(p.id),
                 sub: `${p.sign_ins} ${t('sign-ins')}, ${p.changes} ${t('changes made')}, ${p.messages} ${t('messages')}, ${p.tools} ${t('tool uses')}` })));
  signIns = computed<Row[]>(() => this.people().filter(p => p.sign_ins > 0)
    .map(p => ({ name: this.name(p.id), value: p.sign_ins, color: this.colour(p.id) }))
    .sort((a, b) => b.value - a.value));
  /** The range's doings by kind. */
  kinds = computed<Row[]>(() => {
    const s = this.data()?.sums;
    if (!s) return [];
    return ([['Sign-ins', s.sign_ins], ['Changes made', s.changes], ['Messages', s.messages], ['Tool uses', s.tools],
             ['Agent actions', s.agents]] as [string, number][])
      .map(([n, v]) => ({ name: t(n), value: v })).filter(r => r.value > 0);
  });
  /** The projects that moved, in their owner's colour. */
  byProject = computed<Row[]>(() => (this.data()?.projects ?? []).filter(p => p.moves > 0)
    .map(p => ({ name: p.name, value: p.moves, color: this.colour(p.user),
                 sub: `${this.name(p.user)} · ${p.versions} ${t('versions')}, ${p.edits} ${t('edits')}` })));
  /** By what it cost - or, when nothing was billed, by calls. */
  byCost = computed(() => (this.data()?.llm.cost_usd ?? 0) > 0);
  ranked(rows: Ranked[]): Row[] {
    return rows.map(r => ({ name: r.name, value: this.byCost() ? r.cost_usd : r.calls,
                            sub: `${fmt.count(r.calls)} ${t('calls')} · ${fmt.count(r.tokens)} ${t('model tokens')}` }))
      .filter(r => r.value > 0);
  }

  /** A sign-in's target is the person's own address: not said again. */
  quiet(a: string) { return a === 'sign-in' || a === 'switch'; }
  did(a: string) { return t(DID[a] ?? a.replace(/-/g, ' ')); }
  when(iso: string) {
    return new Date(iso).toLocaleString(LANG() === 'tr' ? 'tr-TR' : 'en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  ago(iso: string) {
    const s = Math.max(0, (this.now() - Date.parse(iso)) / 1000);
    return s < 60 ? t('just now') : s < 3600 ? `${Math.floor(s / 60)} ${t('min ago')}` : s < 86400 ? `${Math.floor(s / 3600)} ${t('h ago')}` : `${Math.floor(s / 86400)} ${t('d ago')}`;
  }

  // ---- export, as Analytics does it (rooms/dash.ts) ----
  readonly rowsOf = seriesRows;
  peopleCsv() {
    return this.people().map(p => ({ person: this.name(p.id), role: this.who(p.id)?.role ?? '', ...p }));
  }
  dl(name: string, rows: object[]) { saveFile(`redline-admin-${name}-${this.range()}.csv`, csvText(rows), 'text/csv'); }
  exportAll() {
    const d = this.data();
    if (d) saveFile(`redline-admin-${this.range()}.json`, JSON.stringify(d, null, 1), 'application/json');
  }
}

function recall(key: string, fallback: string): string {
  try { return localStorage.getItem('redline.admin.' + key) ?? fallback; } catch { return fallback; }
}
function keep(key: string, value: string) {
  try { localStorage.setItem('redline.admin.' + key, value); } catch { /* private window */ }
}
