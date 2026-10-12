import { Component, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { LANG, T, t } from './i18n';
import { Avatar, avatarColour } from './avatar';
import { CountUp } from './count';
import { Skeleton } from './skeleton';
import { money, moneyShort } from './money';
import { BarList, Donut, Row, TimeChart, TimeData, fmt } from './rooms/charts';
import type { AdminUser } from './admin-users';

/** Settings > Dashboard, for the owner and the admins: the server at a glance
 *  (GET /api/admin/overview, backend/admin.py) - what is kept in every
 *  space, and what the people did over a day, a week or a month: by
 *  bucket, by person in their own colour, the projects that moved most,
 *  the models' calls and what they cost, and the latest lines of the trail.
 *  The server names people by id; their names and colours come from the
 *  accounts list (GET /api/admin/users). The charts take the width, the
 *  trail's lines a column beside them. */
interface Person { id: string; sign_ins: number; changes: number; messages: number; tools: number;
  projects: number; models: number; files: number }
interface Overview {
  span: string;
  totals: { users: number; projects: number; models: number; boards: number; files: number; chats: number; messages: number };
  activity: TimeData;
  people: Person[];
  projects: { name: string; user: string | null; models: number; boards: number; moves: number }[];
  llm: { calls: number; tokens: number; cost_usd: number; cost: number[]; by_model: { name: string; cost_usd: number; calls: number }[] };
  feed: { at: string; user: string; action: string; target: string }[];
}

/** The trail's actions as a line says them; any other is its own name. */
const DID: Record<string, string> = {
  'sign-in': 'logged in', 'switch': 'switched to their account', 'change': 'made a change to', 'delete': 'removed',
  'edit': 'made an edit to', 'settings': 'changed the settings of', 'user-add': 'added the account',
  'user-edit': 'edited the account', 'user-delete': 'deleted the account', 'password': 'changed the password',
  'token': 'made the token', 'token-delete': 'deleted the token', 'release': 'released', 'convert': 'converted',
  'queue-task': 'queued a task in',
};
/** The chart's series as the page names them (the server's names are its own). */
const SERIES: Record<string, string> = { 'Changes': 'Changes made', 'Agents': 'Agent actions' };

@Component({
  selector: 'app-admin-overview',
  imports: [T, Avatar, CountUp, Skeleton, TimeChart, BarList, Donut],
  styleUrls: ['./settings.css'],
  styles: [`
    /* Two columns over the whole width: the figures and the charts, and
       beside them the trail's latest lines; one under the other when the
       stage is narrow. */
    :host { display: block; min-width: 0; container-type: inline-size; }
    .st-page.ao-page { max-width: none; }
    .ao-cols { display: grid; grid-template-columns: minmax(0, 5fr) minmax(340px, 2fr); gap: 12px; align-items: start; }
    .ao-main, .ao-side, .ao-sk { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
    .ao-main { container-type: inline-size; }
    .ao-tiles { grid-template-columns: repeat(6, minmax(0, 1fr)); }
    .ao-three { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .ao-three > .ao-wide { grid-column: 1 / -1; }
    @container (min-width: 900px) { .ao-three { grid-template-columns: repeat(3, minmax(0, 1fr)); } .ao-three > .ao-wide { grid-column: auto; } }
    @container (max-width: 560px) { .ao-tiles { grid-template-columns: repeat(3, minmax(0, 1fr)); } .ao-three { grid-template-columns: minmax(0, 1fr); } }
    @container (max-width: 900px) { .ao-cols { grid-template-columns: minmax(0, 1fr); } }
    /* The trail's latest lines: who, what, on what, how long ago - one line each. */
    .ao-feed { display: flex; flex-direction: column; padding: 4px 0; }
    .ao-line { display: flex; align-items: center; gap: 7px; min-width: 0; padding: 4px 10px; font-size: 11.5px; white-space: nowrap; }
    .ao-line > app-avatar { flex: none; }
    .ao-line > b, .ao-line > span, .ao-line > small { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .ao-line > b { flex: 0 1 auto; font-weight: 500; color: var(--ink-bright); }
    .ao-line > span { flex: 0 1 auto; color: var(--ink); }
    .ao-line > small { flex: 1 1 0; color: var(--ink-dim); }
    .ao-line > em { flex: none; font-style: normal; font-size: 10.5px; color: var(--ink-dim); }
    .mono { font-family: 'IBM Plex Mono', ui-monospace, monospace; }
  `],
  template: `
<div class="st-page ao-page">
<div class="ao-cols">
<div class="ao-main">
@if (data(); as d) {
  <div class="st-card">
    <div class="st-card-head"><h3>{{ 'Overview' | t }}</h3>
      <span class="st-sub">{{ 'every account\\'s space' | t }}</span>
      <div class="st-right"><div class="st-seg" role="group" [attr.aria-label]="'Period' | t">
        @for (sp of spans; track sp.id) {
          <button type="button" [class.on]="span() === sp.id" [attr.aria-pressed]="span() === sp.id" (click)="setSpan(sp.id)">{{ sp.label | t }}</button>
        }
      </div></div></div>
    <div class="st-card-body">
      <!-- What is kept, then what the period held: one row each. -->
      <div class="st-tiles ao-tiles">
        <div class="st-tile"><span>{{ 'Projects' | t }}</span><b [wbCount]="d.totals.projects"></b></div>
        <div class="st-tile"><span>{{ 'Models' | t }}</span><b [wbCount]="d.totals.models"></b></div>
        <div class="st-tile"><span>{{ 'Boards' | t }}</span><b [wbCount]="d.totals.boards"></b></div>
        <div class="st-tile"><span>{{ 'Files' | t }}</span><b [wbCount]="d.totals.files"></b></div>
        <div class="st-tile"><span>{{ 'Chats' | t }}</span><b [wbCount]="d.totals.chats"></b></div>
        <div class="st-tile"><span>{{ 'Messages' | t }}</span><b [wbCount]="f.count(d.totals.messages)"></b></div>
      </div>
      <div class="st-tiles ao-tiles">
        <div class="st-tile"><span>{{ 'Active people' | t }}</span><b [wbCount]="active()"></b><small>{{ 'of' | t }} {{ d.totals.users }}</small></div>
        <div class="st-tile"><span>{{ 'Sign-ins' | t }}</span><b [wbCount]="sum('Sign-ins')"></b></div>
        <div class="st-tile"><span>{{ 'Changes made' | t }}</span><b [wbCount]="sum('Changes')"></b></div>
        <div class="st-tile"><span>{{ 'Model calls' | t }}</span><b [wbCount]="f.count(d.llm.calls)"></b><small>{{ f.count(d.llm.tokens) }} {{ 'model tokens' | t }}</small></div>
        <div class="st-tile" [title]="money(d.llm.cost_usd)"><span>{{ 'Model spend' | t }}</span><b [wbCount]="moneyShort(d.llm.cost_usd)"></b></div>
        <div class="st-tile"><span>{{ 'Agent actions' | t }}</span><b [wbCount]="sum('Agents')"></b></div>
      </div>
      <app-time-chart [data]="chart()" kind="bar" [height]="190" />
    </div>
  </div>

  <div class="ao-three">
    <div class="st-card">
      <div class="st-card-head"><h3>{{ 'By person' | t }}</h3><span class="st-sub">{{ 'sign-ins, changes, messages, tool uses' | t }}</span></div>
      <div class="st-card-body"><app-bar-list [rows]="byPerson()" /></div>
    </div>
    <div class="st-card">
      <div class="st-card-head"><h3>{{ 'Most active projects' | t }}</h3><span class="st-sub">{{ 'versions and builds' | t }}</span></div>
      <div class="st-card-body"><app-bar-list [rows]="byProject()" /></div>
    </div>
    <div class="st-card ao-wide">
      <div class="st-card-head"><h3>{{ (llmByCost() ? 'Model spend by model' : 'Model calls by model') | t }}</h3></div>
      <div class="st-card-body"><app-donut [rows]="byModel()" [f]="llmByCost() ? f.money : f.count" /></div>
    </div>
  </div>
} @else if (err(); as e) {
  <p class="st-err">{{ e }}</p>
} @else {
  <wb-skel kind="custom"><div class="ao-sk">
    <div class="st-card"><div class="st-card-body">
      <wb-skel kind="tiles" [count]="6" [min]="92" /><wb-skel kind="tiles" [count]="6" [min]="92" /><wb-skel kind="chart" [h]="190" />
    </div></div>
    <div class="ao-three">
      @for (i of [1, 2, 3]; track i) { <div class="st-card" [class.ao-wide]="i === 3"><div class="st-card-body"><wb-skel kind="rows" [count]="5" [h]="20" /></div></div> }
    </div>
  </div></wb-skel>
}
</div>
<div class="ao-side">
  <div class="st-card">
    <div class="st-card-head"><h3>{{ 'Latest' | t }}</h3><span class="st-sub">{{ 'what the people did' | t }}</span></div>
    @if (data(); as d) {
      <div class="ao-feed">
        @for (e of d.feed; track $index) {
          <div class="ao-line" [title]="when(e.at) + ' · ' + e.action + (e.target ? ' · ' + e.target : '')">
            @if (who(e.user); as u) {
              <app-avatar [name]="u.name" [userId]="u.id" [hasPicture]="u.has_avatar" [v]="u.avatar_v" [colour]="u.avatar_colour" [size]="20" />
              <b>{{ u.name }}</b>
            } @else { <b>{{ 'someone' | t }}</b> }
            <span>{{ did(e.action) }}</span>
            <small>{{ quiet(e.action) ? '' : e.target }}</small>
            <em class="mono">{{ ago(e.at) }}</em>
          </div>
        } @empty { <div class="st-empty">{{ 'Nothing in this period.' | t }}</div> }
      </div>
    } @else if (!err()) {
      <div class="st-card-body"><wb-skel kind="rows" [count]="8" [h]="20" /></div>
    }
  </div>
</div>
</div>
</div>`,
})
export class AdminOverview {
  private http = inject(HttpClient);
  /** The accounts (GET /api/admin/users): names, pictures and colours. */
  users = signal<AdminUser[]>([]);

  readonly f = fmt;
  readonly money = money;
  readonly moneyShort = moneyShort;
  readonly spans = [{ id: 'day', label: 'Day' }, { id: 'week', label: 'Week' }, { id: 'month', label: 'Month' }];
  span = signal<string>((() => { try { return localStorage.getItem('redline.admin.span') || 'week'; } catch { return 'week'; } })());
  data = signal<Overview | null>(null);
  err = signal('');

  constructor() {
    this.load();
    this.http.get<{ users: AdminUser[] }>('/api/admin/users').subscribe({ next: d => this.users.set(d.users), error: () => {} });
  }

  setSpan(s: string) {
    if (s === this.span()) return;
    this.span.set(s);
    try { localStorage.setItem('redline.admin.span', s); } catch { /* private window */ }
    this.load();
  }

  private load() {
    this.http.get<Overview>('/api/admin/overview', { params: { span: this.span() } }).subscribe({
      next: d => { this.data.set(d); this.err.set(''); },
      error: () => { if (!this.data()) this.err.set(t('The overview did not load.')); },
    });
  }

  /** The chart's series in the page's language. */
  chart = computed<TimeData>(() => {
    const a = this.data()!.activity;
    return { ...a, series: a.series.map(s => ({ ...s, name: t(SERIES[s.name] ?? s.name) })) };
  });
  sum(name: string) {
    return (this.data()?.activity.series.find(s => s.name === name)?.values ?? []).reduce<number>((a, v) => a + (v ?? 0), 0);
  }
  private did4(p: Person) { return p.sign_ins + p.changes + p.messages + p.tools; }
  active = computed(() => (this.data()?.people ?? []).filter(p => this.did4(p) > 0).length);

  who(id: string | null | undefined) { return this.users().find(u => u.id === id) ?? null; }
  private colour(id: string | null | undefined) {
    const u = this.who(id);
    return u ? avatarColour(u.name, u.avatar_colour) : 'var(--ink-dim)';
  }

  /** Each person's doings in the period, in their own colour, most first. */
  byPerson = computed<Row[]>(() => (this.data()?.people ?? [])
    .map(p => ({ name: this.who(p.id)?.name ?? p.id, value: this.did4(p), color: this.colour(p.id),
                 sub: `${p.sign_ins} ${t('sign-ins')}, ${p.changes} ${t('changes made')}, ${p.messages} ${t('messages')}, ${p.tools} ${t('tool uses')}` +
                      ` · ${p.projects} ${t('projects')}, ${p.models} ${t('models')}, ${p.files} ${t('files')}` }))
    .sort((a, b) => b.value - a.value));
  /** The projects that moved, in their owner's colour. */
  byProject = computed<Row[]>(() => (this.data()?.projects ?? []).filter(p => p.moves > 0)
    .map(p => ({ name: p.name, value: p.moves, color: this.colour(p.user),
                 sub: `${this.who(p.user)?.name ?? ''} · ${p.models} ${t('models')}, ${p.boards} ${t('boards')}` })));
  /** By what it cost - or, when nothing was billed, by calls. */
  llmByCost = computed(() => (this.data()?.llm.cost_usd ?? 0) > 0);
  byModel = computed<Row[]>(() => (this.data()?.llm.by_model ?? [])
    .map(m => ({ name: m.name, value: this.llmByCost() ? m.cost_usd : m.calls })));

  /** A sign-in's target is the person's own address: not said again. */
  quiet(a: string) { return a === 'sign-in' || a === 'switch'; }
  did(a: string) { return t(DID[a] ?? a.replace(/-/g, ' ')); }
  when(iso: string) {
    const d = new Date(iso);
    return d.toLocaleString(LANG() === 'tr' ? 'tr-TR' : 'en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  ago(iso: string) {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    return s < 60 ? t('just now') : s < 3600 ? `${Math.floor(s / 60)} ${t('min ago')}` : s < 86400 ? `${Math.floor(s / 3600)} ${t('h ago')}` : `${Math.floor(s / 86400)} ${t('d ago')}`;
  }
}
