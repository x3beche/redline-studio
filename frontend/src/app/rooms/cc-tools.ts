import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, input, output, signal } from '@angular/core';
import { T, t } from '../i18n';
import type { CcTool, ToolLevel } from './commandcode';

/** What a tool may do, in the order it is asked about: reads run on their
 *  own, changes always leave a step in the answer, deletes ask first. */
export const LEVELS: { id: ToolLevel; name: string; about: string }[] = [
  { id: 'read', name: 'Only reads', about: 'run freely' },
  { id: 'change', name: 'Changes', about: 'run, and always show a step' },
  { id: 'delete', name: 'Deletes', about: 'ask you first' },
];

const CHEVRON = 'M10 7l5 5-5 5';
const WRENCH = 'M14.5 4.5a4 4 0 0 0-5 5L4 15l2 2 2 2 5.5-5.5a4 4 0 0 0 5-5l-2.5 2.5-2.5-.5-.5-2.5z';
const DRAWER = 'M4 5h16v6H4z M4 11h16v8H4z M10 8h4 M10 15h4';
const SEARCH = 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14z M20 20l-4.2-4.2';
const SHEET = 'M6 3h8l4 4v14H6z M14 3v4h4 M9 12h6 M9 15.5h6 M9 9h2';

/** A tool's icon, here and on its steps in an answer: by what it touches. */
export const TOOL_ICON: Record<string, string> = {
  drawer_search: DRAWER, drawer_list: DRAWER, drawer_add: DRAWER, lcsc_search: SEARCH, datasheet_get: SHEET, datasheet_read: SHEET,
};
export function toolIcon(name: string) { return TOOL_ICON[name] ?? WRENCH; }

/** How each level behaves, said once on its card: the tone of its badge. */
const BEHAVES: Record<ToolLevel, { badge: string; tone: string; empty: string }> = {
  read: { badge: 'runs on its own', tone: 'ok', empty: 'No tool only reads yet.' },
  change: { badge: 'shows a step in the answer', tone: 'accent', empty: 'No tool changes anything yet.' },
  delete: { badge: 'asks you first', tone: 'warn',
            empty: 'No tool deletes anything yet. When one does, the answer stops and asks you before it runs.' },
};

/** One tool's page (GET /api/cc/tools/{name}): what the model is told and
 *  takes, and how it has been used in this workspace's conversations. */
interface ToolUse { at: string; chat: string; title: string; say: string; vars: Record<string, string | number>;
  status: string; ms?: number | null; by: string }
interface ToolPage extends CcTool {
  model_text: string; running: string; failed: string;
  params: { name: string; type: string; about: string; required: boolean }[];
  stats: { uses: number; week: number; mine: number; chats: number; outcomes: Record<string, number>;
    ms: { median: number | null; p90: number | null }; last: string | null;
    days: { day: string; n: number; bad: number }[]; people: { name: string; n: number }[]; recent: ToolUse[] };
}

/** Every tool's uses (GET /api/cc/tools-usage), for the top of the list. */
interface ToolsUsage {
  tools: Record<string, { uses: number; done: number; week: number }>; mine: number;
  days: { day: string; by: Record<string, number> }[];
}

/** The Chat tab's tools, where a conversation is shown (rooms/commandcode.ts),
 *  in Settings' own frame (settings.css): the slim head band, then one card
 *  per level with its tools as tiles - icon, name, the app's switch
 *  (.tcv-switch), what it does, its id and how often it was used. A tile
 *  opens the tool's page; its switch turns it on or off. */
@Component({
  selector: 'app-cc-tools',
  imports: [T],
  styleUrls: ['../settings.css', './cc-tools.css'],
  template: `
<header class="st-head ct-head">
  <button class="ct-ib ct-burger" type="button" (click)="menu.emit()" [title]="'Conversations' | t">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16 M4 12h16 M4 18h16" /></svg></button>
  @if (page(); as p) {
    <button class="ct-ib" type="button" (click)="back()" [title]="'All tools' | t">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 7l-5 5 5 5" /></svg></button>
    <button class="ct-crumb st-head-name" type="button" (click)="back()">{{ 'Tools' | t }}</button>
    <span class="ct-sep">/</span>
    <svg class="ct-head-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="icon(p.name)" /></svg>
    <span class="ct-title">{{ p.label | t }}</span>
    <code class="ct-id">{{ p.name }}</code>
  } @else {
    <svg class="ct-head-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="wrench" /></svg>
    <span class="st-head-name">{{ 'Tools' | t }}</span>
    <span class="st-head-blurb">{{ 'what the model may use while it answers you' | t }}</span>
  }
  <span class="st-head-meta">
    @if (!canEdit()) { <span class="st-badge" data-tone="warn">{{ 'read-only for you' | t }}</span> }
    @if (!page()) { <span class="mono">{{ on() }} / {{ tools().length }} {{ 'on' | t }}</span> }
  </span>
  <button class="ct-ib" type="button" (click)="done.emit()" [title]="('Close' | t) + ' (Esc)'">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12 M18 6L6 18" /></svg></button>
</header>
<div class="st-stage">
  @if (page(); as p) {
    <div class="st-page ct-page">
      @let st = p.stats;
      @let live = current(p.name);
      <div class="st-tiles six">
        <div class="st-tile hero"><span>{{ 'Uses' | t }}</span><b>{{ st.uses }}</b>
          <small>{{ st.chats }} {{ 'conversations' | t }} · {{ st.mine }} {{ 'by you' | t }}</small></div>
        <div class="st-tile"><span>{{ 'Last 7 days' | t }}</span><b>{{ st.week }}</b></div>
        <div class="st-tile" [attr.data-tone]="okRate(p) == null ? 'dim' : okRate(p)! < 90 ? 'warn' : 'ok'">
          <span>{{ 'Worked' | t }}</span><b>{{ okRate(p) == null ? '–' : okRate(p) + '%' }}</b>
          <small>{{ fails(p) }} {{ 'failed or refused' | t }}</small></div>
        <div class="st-tile" [attr.data-tone]="st.ms.median == null ? 'dim' : null"><span>{{ 'Median time' | t }}</span>
          <b>{{ dur(st.ms.median) }}</b><small>p90 {{ dur(st.ms.p90) }}</small></div>
        <div class="st-tile" [attr.data-tone]="st.last ? null : 'dim'"><span>{{ 'Last used' | t }}</span>
          <b>{{ st.last ? ago(st.last) : ('never' | t) }}</b></div>
      </div>

      <div class="ct-cols">
        <section class="st-card">
          <div class="st-card-head"><h3>{{ 'What it does' | t }}</h3>
            <span class="st-badge" [attr.data-tone]="behaves(p.level).tone">{{ behaves(p.level).badge | t }}</span>
            <span class="st-right">
              <button class="ct-onoff" type="button" role="switch" [attr.aria-checked]="live?.on" [disabled]="!canEdit()"
                      (click)="live && flip(live)">
                <span>{{ (live?.on ? 'On for you' : 'Off for you') | t }}</span>
                <span class="tcv-switch" [attr.data-on]="live?.on ? 1 : null" aria-hidden="true"></span>
              </button>
            </span>
          </div>
          <div class="st-card-body">
            <p class="ct-lead">{{ p.description | t }}</p>
            <div class="st-sec-title">{{ 'What the model is told' | t }}</div>
            <p class="ct-told">{{ p.model_text }}</p>
            <div class="st-sec-title">{{ 'What it takes' | t }}</div>
            @if (p.params.length) {
              <table class="ct-params">
                @for (a of p.params; track a.name) {
                  <tr><td><code>{{ a.name }}</code>@if (a.required) {<i>*</i>}</td><td class="mono">{{ a.type }}</td><td>{{ a.about }}</td></tr>
                }
              </table>
            } @else { <p class="st-hint">{{ 'Nothing - it runs as it is.' | t }}</p> }
            <div class="st-sec-title">{{ 'In an answer' | t }}</div>
            <div class="ct-steps">
              <div class="ct-step"><svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="icon(p.name)" /></svg>
                <span>{{ example(p.running) }}</span><em>{{ 'while it runs' | t }}</em></div>
              <div class="ct-step" data-state="error"><svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="icon(p.name)" /></svg>
                <span>{{ p.failed | t }}</span><em>{{ 'when it fails' | t }}</em></div>
            </div>
          </div>
        </section>

        <div class="ct-side">
          <section class="st-card">
            <div class="st-card-head"><h3>{{ 'Last 14 days' | t }}</h3>
              <span class="st-right st-sub mono">{{ sum(st.days) }} {{ 'uses' | t }}</span></div>
            <div class="st-card-body">
              <div class="ct-bars" role="img" [attr.aria-label]="sum(st.days) + ' ' + ('uses' | t)">
                @for (d of st.days; track d.day) {
                  <span class="ct-bar" [title]="d.day + ' · ' + d.n + (d.bad ? ' · ' + d.bad + ' ' + ('failed' | t) : '')">
                    <span class="ct-stack" [style.height.%]="d.n ? 8 + 92 * d.n / peak(st.days) : 0">
                      @if (d.bad) { <i class="bad" [style.flex-grow]="d.bad"></i> }
                      @if (d.n - d.bad) { <i [style.flex-grow]="d.n - d.bad" [style.background]="color(p.name)"></i> }
                    </span></span>
                }
              </div>
              <div class="ct-bars-axis mono"><span>{{ st.days[0].day.slice(5) }}</span><span>{{ 'today' | t }}</span></div>
              <div class="ct-legend"><span><i [style.background]="color(p.name)"></i>{{ 'worked' | t }} {{ st.outcomes['done'] ?? 0 }}</span>
                <span><i class="bad"></i>{{ 'failed or refused' | t }} {{ fails(p) }}</span></div>
            </div>
          </section>
          <section class="st-card">
            <div class="st-card-head"><h3>{{ 'Who used it' | t }}</h3></div>
            <div class="st-card-body">
              @for (w of st.people; track w.name; let i = $index) {
                <div class="ct-who"><span>{{ w.name }}</span><span class="st-meter"><i [style.width.%]="100 * w.n / st.uses"
                  [style.background]="'var(--series-' + (i % 8 + 1) + ')'"></i></span>
                  <b class="mono">{{ w.n }}</b></div>
              } @empty { <p class="st-hint">{{ 'Nobody yet.' | t }}</p> }
            </div>
          </section>
        </div>
      </div>

      <section class="st-card">
        <div class="st-card-head"><h3>{{ 'Latest uses' | t }}</h3>
          <span class="st-sub">{{ 'open one to see the answer it was used in' | t }}</span></div>
        @if (st.recent.length) {
          <ul class="ct-uses">
            @for (u of st.recent; track u.at + u.chat) {
              <li><button type="button" class="ct-use" (click)="openChat.emit(u.chat)">
                <span class="ct-use-when mono">{{ ago(u.at) }}</span>
                <span class="ct-use-say">{{ say(u) }}</span>
                <span class="ct-use-chat">{{ u.title || ('Untitled' | t) }} · {{ u.by }}</span>
                <span class="st-badge" [attr.data-tone]="u.status === 'done' ? 'ok' : u.status === 'error' ? 'danger' : 'warn'">{{ u.status | t }}</span>
                <span class="ct-use-ms mono">{{ dur(u.ms ?? null) }}</span>
              </button></li>
            }
          </ul>
        } @else { <div class="ct-empty">{{ 'The model has not used it yet.' | t }}</div> }
      </section>
    </div>
  } @else {
  <div class="st-page ct-page">
    @if (usage(); as u) {
      <div class="st-tiles six">
        <div class="st-tile"><span>{{ 'On for you' | t }}</span><b>{{ on() }} / {{ tools().length }}</b></div>
        <div class="st-tile"><span>{{ 'Uses' | t }}</span><b>{{ total(u) }}</b><small>{{ u.mine }} {{ 'by you' | t }}</small></div>
        <div class="st-tile"><span>{{ 'Last 7 days' | t }}</span><b>{{ week(u) }}</b></div>
        <div class="st-tile" [attr.data-tone]="worked(u) == null ? 'dim' : worked(u)! < 90 ? 'warn' : 'ok'">
          <span>{{ 'Worked' | t }}</span><b>{{ worked(u) == null ? '–' : worked(u) + '%' }}</b></div>
      </div>
      <div class="ct-cols">
        <section class="st-card">
          <div class="st-card-head"><h3>{{ 'Uses by tool' | t }}</h3><span class="st-sub">{{ 'last 14 days' | t }}</span>
            <span class="st-right st-sub mono">{{ sum14(u) }}</span></div>
          <div class="st-card-body">
            <div class="ct-bars tall">
              @for (d of u.days; track d.day) {
                <span class="ct-bar" [title]="d.day + ' · ' + dayTotal(d)">
                  <span class="ct-stack" [style.height.%]="dayTotal(d) ? 6 + 94 * dayTotal(d) / peak14(u) : 0">
                    @for (tl of tools(); track tl.name) {
                      @if (d.by[tl.name]) { <i [style.flex-grow]="d.by[tl.name]" [style.background]="color(tl.name)"></i> }
                    }
                  </span></span>
              }
            </div>
            <div class="ct-bars-axis mono"><span>{{ u.days[0].day.slice(5) }}</span><span>{{ 'today' | t }}</span></div>
            <div class="ct-legend">
              @for (tl of tools(); track tl.name) {
                <span><i [style.background]="color(tl.name)"></i>{{ tl.label | t }} <b class="mono">{{ u.tools[tl.name]?.uses ?? 0 }}</b></span>
              }
            </div>
          </div>
        </section>
        <section class="st-card">
          <div class="st-card-head"><h3>{{ 'By tool' | t }}</h3></div>
          <div class="st-card-body ct-by">
            @for (tl of byUse(u); track tl.name) {
              <button type="button" class="ct-who ct-who-btn" (click)="show(tl.name)">
                <span>{{ tl.label | t }}</span>
                <span class="st-meter"><i [style.width.%]="100 * (u.tools[tl.name]?.uses ?? 0) / peakTool(u)" [style.background]="color(tl.name)"></i></span>
                <b class="mono">{{ u.tools[tl.name]?.uses ?? 0 }}</b></button>
            }
          </div>
        </section>
      </div>
    }
    @if (!ready()) {
      <section class="st-card"><div class="ct-empty">{{ 'Loading…' | t }}</div></section>
    } @else {
      @for (g of groups(); track g.id) {
        <section class="st-card" [attr.data-level]="g.id">
          <div class="st-card-head">
            <h3>{{ g.name | t }}</h3>
            <span class="st-badge" [attr.data-tone]="g.tone">{{ g.badge | t }}</span>
            @if (g.tools.length) {
              <span class="st-right">
                <span class="st-sub mono">{{ g.on }} / {{ g.tools.length }}</span>
                <span class="st-seg">
                  <button type="button" [class.on]="g.on === g.tools.length" [disabled]="!canEdit()"
                          (click)="setAll(g.tools, true)">{{ 'all on' | t }}</button>
                  <button type="button" [class.on]="g.on === 0" [disabled]="!canEdit()"
                          (click)="setAll(g.tools, false)">{{ 'all off' | t }}</button>
                </span>
              </span>
            }
          </div>
          @if (g.tools.length) {
            <div class="ct-tiles" [style.--cols]="g.tools.length" [attr.data-odd]="g.tools.length % 2 ? 1 : null">
              @for (tl of g.tools; track tl.name) {
                <div class="ct-tile" [attr.data-on]="tl.on ? 1 : null" role="button" tabindex="0"
                     (click)="show(tl.name)" (keydown.enter)="show(tl.name)" [title]="'Open its page' | t">
                  <span class="ct-top">
                    <svg class="ct-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="icon(tl.name)" /></svg>
                    <span class="ct-name">{{ tl.label | t }}</span>
                    <button class="tcv-switch" type="button" role="switch" [attr.aria-checked]="tl.on" [attr.data-on]="tl.on ? 1 : null"
                            [disabled]="!canEdit()" [attr.aria-label]="tl.label | t" (click)="$event.stopPropagation(); flip(tl)"></button>
                  </span>
                  <span class="ct-about">{{ tl.description | t }}</span>
                  <span class="ct-foot-row">
                    <code class="ct-id">{{ tl.name }}</code>
                    <span class="ct-uses-n mono">{{ tl.uses ?? 0 }} {{ (tl.uses === 1 ? 'use' : 'uses') | t }}</span>
                    <svg class="ct-go" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 7l5 5-5 5" /></svg>
                  </span>
                </div>
              }
            </div>
          } @else {
            <div class="ct-empty">{{ g.empty | t }}</div>
          }
        </section>
      }
    }
    <p class="st-hint">{{ 'A model that cannot use tools answers without them. Turning a tool off takes effect from your next message.' | t }}</p>
  </div>
  }
</div>`,
})
export class CcToolsView {
  private http = inject(HttpClient);
  tools = input.required<CcTool[]>();
  ready = input(true);
  canEdit = input(true);
  /** Tools to turn on or off, by name. */
  set = output<Record<string, boolean>>();
  done = output<void>();
  menu = output<void>();
  /** A conversation a use was in, to open it. */
  openChat = output<string>();

  readonly wrench = WRENCH;
  icon = toolIcon;
  page = signal<ToolPage | null>(null);
  on = computed(() => this.tools().filter(x => x.on).length);
  groups = computed(() => LEVELS.map(l => {
    const tools = this.tools().filter(x => x.level === l.id);
    return { ...l, ...BEHAVES[l.id], tools, on: tools.filter(x => x.on).length };
  }));
  flip(tl: CcTool) { this.set.emit({ [tl.name]: !tl.on }); }
  setAll(tools: CcTool[], on: boolean) {
    const change = tools.filter(x => x.on !== on);
    if (change.length) this.set.emit(Object.fromEntries(change.map(x => [x.name, on])));
  }

  usage = signal<ToolsUsage | null>(null);
  constructor() { this.http.get<ToolsUsage>('/api/cc/tools-usage').subscribe({ next: u => this.usage.set(u), error: () => {} }); }
  /** A tool's colour in the charts (its page and the top of the list): the series palette, in the list's order. */
  color(name: string) {
    const i = this.tools().findIndex(x => x.name === name);
    return `var(--series-${(i < 0 ? 7 : i % 8) + 1})`;
  }
  total(u: ToolsUsage) { return Object.values(u.tools).reduce((a, x) => a + x.uses, 0); }
  week(u: ToolsUsage) { return Object.values(u.tools).reduce((a, x) => a + x.week, 0); }
  worked(u: ToolsUsage) {
    const n = this.total(u);
    return n ? Math.round(100 * Object.values(u.tools).reduce((a, x) => a + x.done, 0) / n) : null;
  }
  dayTotal(d: { by: Record<string, number> }) { return Object.values(d.by).reduce((a, x) => a + x, 0); }
  sum14(u: ToolsUsage) { return u.days.reduce((a, d) => a + this.dayTotal(d), 0); }
  peak14(u: ToolsUsage) { return Math.max(1, ...u.days.map(d => this.dayTotal(d))); }
  peakTool(u: ToolsUsage) { return Math.max(1, ...Object.values(u.tools).map(x => x.uses)); }
  byUse(u: ToolsUsage) { return [...this.tools()].sort((a, b) => (u.tools[b.name]?.uses ?? 0) - (u.tools[a.name]?.uses ?? 0)); }

  show(name: string) {
    this.http.get<ToolPage>(`/api/cc/tools/${encodeURIComponent(name)}`).subscribe({ next: p => this.page.set(p), error: () => {} });
  }
  back() { this.page.set(null); }
  /** The tool as the list has it now (its switch follows the list, not the page). */
  current(name: string) { return this.tools().find(x => x.name === name); }
  behaves(l: ToolLevel) { return BEHAVES[l]; }
  fails(p: ToolPage) { return p.stats.uses - (p.stats.outcomes['done'] ?? 0); }
  okRate(p: ToolPage) { return p.stats.uses ? Math.round(100 * (p.stats.outcomes['done'] ?? 0) / p.stats.uses) : null; }
  sum(days: { n: number }[]) { return days.reduce((a, d) => a + d.n, 0); }
  peak(days: { n: number }[]) { return Math.max(1, ...days.map(d => d.n)); }
  dur(ms: number | null) { return ms == null ? '–' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`; }
  ago(iso: string) {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    return s < 60 ? t('just now') : s < 3600 ? `${Math.floor(s / 60)} ${t('min ago')}` : s < 86400 ? `${Math.floor(s / 3600)} ${t('h ago')}` : `${Math.floor(s / 86400)} ${t('d ago')}`;
  }
  /** A step's sentence, translated and filled, as the answer shows it. */
  say(u: ToolUse) {
    return t(u.say || '').replace(/\{(\w+)\}/g, (m, k) => u.vars[k] != null && u.vars[k] !== '' ? String(u.vars[k]) : '…');
  }
  example(tpl: string) { return t(tpl).replace(/\{(\w+)\}/g, '…'); }
}

/** Under the usage card in the conversation list: opens the tools above in
 *  the conversation's place. Same width, border and type as the card. */
@Component({
  selector: 'app-cc-tools-line',
  imports: [T],
  styles: [`
    :host { display: block; flex: none; }
    .ctl { display: flex; align-items: center; gap: 6px; width: 100%; min-height: 28px; padding: 5px 8px; text-align: left;
      font-size: 11px; color: var(--ink-dim); border: 1px solid var(--line); border-radius: 5px; background: var(--surface);
      cursor: pointer; }
    .ctl:hover, .ctl:focus-visible { background: var(--hover); outline: none; }
    .ctl[aria-pressed="true"] { background: var(--surface-2); border-color: var(--accent); }
    .ctl b { color: var(--ink); font-weight: 600; }
    .ctl em { margin-left: auto; font: normal 10.5px 'IBM Plex Mono', ui-monospace, monospace; color: var(--ink-dim); }
    svg { flex: none; width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.7;
      stroke-linecap: round; stroke-linejoin: round; }
    .ctl[aria-pressed="true"] svg:first-child { color: var(--accent); }
    svg:last-child { width: 12px; height: 12px; }
    @media (max-width: 768px) { .ctl { min-height: 36px; } }
  `],
  template: `
<button class="ctl" type="button" (click)="toggle.emit()" [attr.aria-pressed]="open()"
        [title]="'Which tools the model may use with your lines' | t">
  <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="wrench" /></svg>
  <b>{{ 'Tools' | t }}</b>
  <em>{{ on() }}/{{ total() }}</em>
  <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="chevron" /></svg>
</button>`,
})
export class CcToolsLine {
  on = input(0);
  total = input(0);
  open = input(false);
  toggle = output<void>();
  readonly wrench = WRENCH;
  readonly chevron = CHEVRON;
}
