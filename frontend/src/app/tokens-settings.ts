import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { NgTemplateOutlet } from '@angular/common';
import { forkJoin } from 'rxjs';
import { Auth } from './auth';
import { LANG, T, t } from './i18n';
import { when } from './llm-settings';
import { BarList, Row, Spark, TimeChart, TimeData, fmt } from './rooms/charts';
import { money } from './money';
import { Agents, SeedOs, SeedRunner, seedLine, seedPref, seenAgo, setSeedPref } from './agent-status';
import { Confirm } from './confirm';
import { SelectOption, UiSelect } from './ui-select';
import { CountUp } from './count';
import { Skeleton } from './skeleton';

/** One agent's token as the server lists it - never the token, never its hash. */
export interface AgentToken {
  id: string; name: string; room: string | null; role?: string;
  created_by?: { name?: string }; created_at: string; last_used: string | null;
  revoked: boolean; revoked_at?: string | null; expires_at?: string | null;
  status: 'active' | 'revoked' | 'expired';
}
interface PerToken { series: number[]; today: number; d7: number; d30: number; read: number; write: number }
interface Usage {
  days: string[];
  totals: { active: number; tokens: number; today: number; d7: number; d30: number; read: number; write: number };
  top: { id: string; name: string; d30: number } | null;
  chart: TimeData;
  per_token: Record<string, PerToken>;
}
interface AuditLine { at: string; action: string; target: string; who?: string; method?: string | null }
interface Detail {
  id: string; name: string; series: number[]; chart: TimeData;
  totals: { n: number; read: number; write: number };
  acts: Record<string, number>;
  audit: { by_action: Record<string, number>; total: number; recent: AuditLine[] };
  llm: { calls: number; tokens: number; cost_usd: number; by_model: Record<string, number> };
}

/** Settings > Agent tokens: what they are, making one (shown once), the
 *  list with taking back and deleting, and what each one has been used
 *  for (backend/main.py, /api/agent-tokens*). */
@Component({
  selector: 'app-tokens-settings',
  imports: [Skeleton, CountUp, T, TimeChart, BarList, Spark, UiSelect, NgTemplateOutlet],
  styleUrls: ['./settings.css', './tokens-settings.css'],
  template: `
<div class="st-page">
  <p class="st-lead">{{ 'Programs such as AI agents sign in to Workbench with an agent token (rlat_…) instead of a password. A token is at most an editor, can be kept to one room and taken back at any time; everything the agent does is recorded under the name you give it.' | t }}
    {{ 'The token is shown once, when it is made - Workbench keeps only its SHA-256.' | t }}</p>

  <!-- Setting up an agent on one's own computer: the seed's one line. -->
  <div class="st-card tk-setup-card">
    <div class="st-card-head"><h3>{{ 'Set up your agent' | t }}</h3>
      @if (agents.status(); as st) {
        <span class="tk-state"><span class="tk-dot" [attr.data-on]="st.connected ? 1 : st.tokens ? 0 : null"></span>
          @if (st.connected) { {{ 'Connected' | t }} · {{ 'last seen' | t }} {{ seen(st.seen_s) }} }
          @else if (st.tokens) { {{ 'Token made, agent not connected' | t }}{{ st.last_seen ? ' · ' + ('last seen' | t) + ' ' + seen(st.seen_s) : '' }} }
          @else { {{ 'No agent token yet' | t }} }
        </span>
      }
      <a class="st-right st-sub" [href]="seed()" target="_blank" rel="noopener">{{ 'the seed, and its README' | t }}</a></div>
    <div class="st-card-body tk-setup">
      <section>
        <h4><span>1</span>{{ 'Make a token' | t }}</h4>
        <p>{{ 'Below, under New token: name it after the computer it will run on (e.g. laptop). It is shown once - the line with it comes up right there.' | t }}</p>
      </section>
      <section class="tk-setup-line">
        <h4><span>2</span>{{ 'Run the line on your computer' | t }}
          <span class="st-seg tk-os">
            <button type="button" [class.on]="os() === 'unix'" (click)="os.set('unix')">macOS · Linux</button>
            <button type="button" [class.on]="os() === 'windows'" (click)="os.set('windows')">Windows</button>
          </span></h4>
        <div class="tk-opts">
          <ng-container *ngTemplateOutlet="seedOpts" />
        </div>
        <code class="tk-code">{{ line(made()?.token) }}</code>
        <ng-container *ngTemplateOutlet="seedHints" />
        <p>{{ prereq() }}</p>
        <div class="st-row">
          <button class="tcv-btn" [class.tcv-btn-accent]="!!made()" (click)="copyLine()">{{ (copied() === 'line' ? 'Copied' : made() ? 'Copy the line, with the token' : 'Copy the line') | t }}</button>
        </div>
      </section>
      <section>
        <h4><span>3</span>{{ 'Keep it running' | t }}</h4>
        <p>{{ 'The agent is what does the work on the notes you queue: keep it running on your computer the whole time you develop. If it stops, notes wait in the queue until it is back.' | t }}</p>
        <p class="mono tk-cmds">./start.sh &nbsp;{{ 'start again, updated' | t }}<br>./start.sh attach &nbsp;{{ 'watch it' | t }}<br>./start.sh status &nbsp;{{ 'is it running' | t }}<br>./start.sh stop &nbsp;{{ 'stop it' | t }}</p>
      </section>
    </div>
  </div>

  @if (!may) {
    <div class="st-banner">{{ 'Read-only for you: handing out agent tokens takes an editor, an admin or an owner.' | t }}</div>
  } @else {
    <!-- Making one -->
    <div class="st-card">
      <div class="st-card-head"><h3>{{ 'New token' | t }}</h3>
        <span class="st-sub">{{ 'no higher than your own role' | t }} ({{ myRole }})</span></div>
      <div class="st-card-body">
        <form class="tk-new" (submit)="$event.preventDefault(); make()">
          <label class="st-f tk-name"><span>{{ 'Name' | t }}</span>
            <input class="st-in" [placeholder]="'e.g. pcb-builder' | t" maxlength="60" [value]="name()"
                   (input)="name.set($any($event.target).value)"></label>
          <label class="st-f"><span>{{ 'Role' | t }}</span>
            <wb-select class="st-sel" label="Role" [options]="roleOpts" [value]="role()" (pick)="role.set($any($event))" /></label>
          <label class="st-f"><span>{{ 'Room' | t }}</span>
            <wb-select class="st-sel" label="Room" [options]="roomOpts()" [value]="room()" (pick)="room.set($any($event))" /></label>
          <div class="st-f"><span>{{ 'Expires' | t }}</span>
            <div class="st-seg">
              @for (e of expiries; track e.days) {
                <button type="button" [class.on]="expiry() === e.days" (click)="expiry.set(e.days)">{{ e.label | t }}</button>
              }
            </div></div>
          <button class="tcv-btn tcv-btn-accent tk-make" type="submit" [disabled]="!name().trim() || busy()">{{ 'Make token' | t }}</button>
        </form>
        @if (made(); as m) {
          <div class="tk-once" role="status">
            <div class="tk-once-top">
              <b>{{ 'Token for' | t }} {{ m.name }}</b>
              <span class="st-badge" data-tone="warn">{{ 'shown once' | t }}</span>
              <span class="st-sub">{{ 'Copy it now - you will not see it again. Run this line on the computer the agent will work on, and keep it running:' | t }}</span>
            </div>
            <code class="tk-code">{{ line(m.token) }}</code>
            <ng-container *ngTemplateOutlet="seedHints" />
            <div class="st-row">
              <button class="tcv-btn tcv-btn-accent" (click)="copyLine()">{{ (copied() === 'line' ? 'Copied' : 'Copy the line') | t }}</button>
              <ng-container *ngTemplateOutlet="seedOpts" />
              <span class="st-seg">
                <button type="button" [class.on]="os() === 'unix'" (click)="os.set('unix')">macOS · Linux</button>
                <button type="button" [class.on]="os() === 'windows'" (click)="os.set('windows')">Windows</button>
              </span>
              <button class="tcv-btn" (click)="copy(m.token, true)" [title]="'for an agent you run yourself, in a full checkout' | t">{{ (copied() === 'lines' ? 'Copied' : 'Copy the lines') | t }}</button>
              <button class="tcv-btn" (click)="copy(m.token, false)">{{ (copied() === 'token' ? 'Copied' : 'Copy the token only') | t }}</button>
              <button class="tcv-btn tk-right" (click)="made.set(null)">{{ 'Done' | t }}</button>
            </div>
          </div>
        }
        @if (error(); as e) { <p class="st-err" role="alert">{{ e }}</p> }
      </div>
    </div>

    <!-- The list -->
    <div class="st-card">
      <div class="st-card-head"><h3>{{ 'Tokens' | t }}</h3>
        @if (list(); as l) { <span class="st-sub">{{ counts().active }} {{ 'active' | t }} · {{ l.length }} {{ 'in all' | t }}</span> }
        <span class="st-right st-sub">{{ 'click a row for its usage' | t }}</span></div>
      @if (list(); as l) {
        @if (l.length) {
          <div class="st-table-wrap tk-wrap">
            <table class="st-table tk-table">
              <thead><tr>
                <th>{{ 'Name' | t }}</th><th>{{ 'Created' | t }}</th><th>{{ 'Last used' | t }}</th>
                <th class="r">{{ 'Requests, 7 d' | t }}</th><th>{{ 'Status' | t }}</th><th></th>
              </tr></thead>
              <tbody>
                @for (x of l; track x.id) {
                  <tr class="tk-row" [attr.data-open]="open() === x.id ? 1 : null" [attr.data-off]="x.status !== 'active' ? 1 : null"
                      (click)="toggle(x)">
                    <td class="tk-two" [title]="x.name">
                      <span><span class="tk-caret" aria-hidden="true">▸</span><b class="tk-nm">{{ x.name }}</b></span>
                      <small>{{ x.role ?? 'editor' }} · {{ x.room ? x.room.toUpperCase() : ('any room' | t) }}</small></td>
                    <td class="tk-two" [title]="exact(x.created_at)">
                      <span>{{ ago(x.created_at) }}</span><small>{{ x.created_by?.name || ('someone' | t) }}</small></td>
                    <td [title]="x.last_used ? exact(x.last_used) : ''" [class.dim]="!x.last_used">
                      <span class="tk-dot" [attr.data-on]="live(x) ? 1 : null" [title]="(live(x) ? 'connected' : 'not connected') | t"></span>{{ x.last_used ? ago(x.last_used) : ('never' | t) }}</td>
                    <td class="r mono">
                      @if (per(x.id); as p) {
                        <span class="tk-spark"><app-spark [values]="p.series.slice(-14)" [width]="48" [height]="16" /></span>{{ p.d7 }}
                      } @else { <span class="dim">–</span> }
                    </td>
                    <td class="tk-two">
                      <span><span class="st-tag" [attr.data-tone]="x.status === 'active' ? 'ok' : x.status === 'expired' ? 'warn' : null">{{ x.status | t }}</span></span>
                      @if (x.status === 'active' && x.expires_at) { <small [title]="exact(x.expires_at)">{{ left(x.expires_at) }}</small> }
                      @else if (x.status === 'active') { <small>{{ 'no end date' | t }}</small> }
                      @else if (x.status === 'expired' && x.expires_at) { <small [title]="exact(x.expires_at)">{{ ago(x.expires_at) }}</small> }
                      @else if (x.revoked_at) { <small [title]="exact(x.revoked_at)">{{ ago(x.revoked_at) }}</small> }
                    </td>
                    <td class="r tk-acts" (click)="$event.stopPropagation()">
                      @if (x.status === 'active') { <button class="tcv-btn tk-btn" (click)="revoke(x)" [disabled]="busy()">{{ 'Revoke' | t }}</button> }
                      <button class="tcv-btn tk-btn tk-danger" (click)="remove(x)" [disabled]="busy()">{{ 'Delete' | t }}</button>
                    </td>
                  </tr>
                  @if (open() === x.id) {
                    <tr class="tk-detail-row"><td colspan="6">
                      @if (detail(); as d) {
                        <div class="tk-detail">
                          <div class="st-tiles six">
                            <div class="st-tile"><span>{{ 'Requests, 30 d' | t }}</span><b [wbCount]="d.totals.n"></b></div>
                            <div class="st-tile"><span>{{ 'Reads' | t }}</span><b [wbCount]="d.totals.read"></b><small>{{ pct(d.totals.read, d.totals.n) }}</small></div>
                            <div class="st-tile"><span>{{ 'Writes' | t }}</span><b [wbCount]="d.totals.write"></b><small>{{ pct(d.totals.write, d.totals.n) }}</small></div>
                            <div class="st-tile"><span>{{ 'Audit lines' | t }}</span><b [wbCount]="d.audit.total"></b></div>
                            <div class="st-tile" [title]="'LLM calls made for this agent (recorded since this page came)' | t"><span>{{ 'LLM calls' | t }}</span><b [wbCount]="d.llm.calls"></b>
                              <small>{{ d.llm.calls ? f.count(d.llm.tokens) + ' tok · ' + money(d.llm.cost_usd) : ('none recorded' | t) }}</small></div>
                          </div>
                          <div class="st-charts">
                            <section class="st-chart c8"><h4>{{ 'Requests per day' | t }}<em>{{ d.totals.n }}</em></h4>
                              <app-time-chart [data]="d.chart" kind="bar" [height]="120" /></section>
                            <section class="st-chart c4"><h4>{{ 'What the requests were' | t }}</h4>
                              <app-bar-list [rows]="actRows(d)" /></section>
                            <section class="st-chart c4"><h4>{{ 'In the audit trail' | t }}<em>{{ d.audit.total }}</em></h4>
                              <app-bar-list [rows]="rowsOf(d.audit.by_action)" /></section>
                            <section class="st-chart c8"><h4>{{ 'Last audit entries' | t }}<em>{{ d.audit.recent.length }}</em></h4>
                              @if (d.audit.recent.length) {
                                <div class="st-table-wrap"><table class="st-table">
                                  @for (a of d.audit.recent; track $index) {
                                    <tr><td class="dim" [title]="exact(a.at)">{{ ago(a.at) }}</td><td>{{ a.action }}</td>
                                      <td class="give mono" [title]="a.target">{{ a.target }}</td><td class="dim">{{ a.who }}</td></tr>
                                  }
                                </table></div>
                              } @else { <div class="st-empty">{{ 'Nothing in the audit trail under this token.' | t }}</div> }
                            </section>
                          </div>
                        </div>
                      } @else if (detailErr()) { <p class="st-err">{{ detailErr() }}</p>
                      } @else {
                        <div class="wb-sk-stack tk-detail"><wb-skel kind="tiles" [count]="5" [min]="92" /><wb-skel kind="chart" [h]="140" /></div>
                      }
                    </td></tr>
                  }
                }
              </tbody>
            </table>
          </div>
        } @else { <div class="st-empty">{{ 'No agent has a token yet.' | t }}</div> }
      } @else {
        <wb-skel kind="rows" [count]="3" [h]="36" />
      }
    </div>

    <!-- Usage, all tokens -->
    <div class="st-card">
      <div class="st-card-head"><h3>{{ 'Usage' | t }}</h3><span class="st-sub">{{ 'requests made with a token, last 30 days' | t }}</span></div>
      <div class="st-card-body">
        @if (usage(); as u) {
          <div class="st-tiles six wb-in">
            <div class="st-tile"><span>{{ 'Active tokens' | t }}</span><b [wbCount]="u.totals.active"></b><small>{{ u.totals.tokens }} {{ 'in all' | t }}</small></div>
            <div class="st-tile"><span>{{ 'Today' | t }}</span><b [wbCount]="f.count(u.totals.today)"></b></div>
            <div class="st-tile"><span>{{ '7 days' | t }}</span><b [wbCount]="f.count(u.totals.d7)"></b></div>
            <div class="st-tile"><span>{{ '30 days' | t }}</span><b [wbCount]="f.count(u.totals.d30)"></b>
              <small>{{ f.count(u.totals.read) }} {{ 'reads' | t }} · {{ f.count(u.totals.write) }} {{ 'writes' | t }}</small></div>
            <div class="st-tile"><span>{{ 'Most active' | t }}</span><b [title]="u.top?.name ?? ''">{{ u.top?.name ?? '–' }}</b>
              <small>{{ u.top ? f.count(u.top.d30) + ' ' + ('in 30 days' | t) : ('no requests yet' | t) }}</small></div>
          </div>
          @if (u.totals.d30) {
            <div class="st-charts">
              <section class="st-chart c8"><h4>{{ 'Requests per day' | t }}<em>{{ f.count(u.totals.d30) }}</em></h4>
                <app-time-chart [data]="u.chart" kind="bar" [height]="160" /></section>
              <section class="st-chart c4"><h4>{{ 'By token, 30 days' | t }}</h4>
                <app-bar-list [rows]="byToken()" /></section>
            </div>
          } @else { <div class="st-empty">{{ 'No token has been used in the last 30 days.' | t }}</div> }
        } @else {
          <div class="wb-sk-stack"><wb-skel kind="tiles" [count]="5" [min]="92" /><wb-skel kind="chart" [h]="160" /></div>
        }
      </div>
    </div>
  }
</div>

<!-- The seed's options, beside the platform: what runs the agent, and
     whether it starts by itself after a reboot. -->
<ng-template #seedOpts>
  <span class="st-seg">
    <button type="button" [class.on]="runner() === 'claude'" (click)="setRunner('claude')">Claude Code</button>
    <button type="button" [class.on]="runner() === 'opencode'" (click)="setRunner('opencode')">OpenCode</button>
  </span>
  <label class="tcv-check-row tk-svc"><input type="checkbox" class="tcv-check" [checked]="service()"
    (change)="setService($any($event.target).checked)">{{ 'Run as a service (start automatically after reboot)' | t }}</label>
</ng-template>
<ng-template #seedHints>
  @if (runner() === 'opencode') {
    <p class="tk-hint">{{ 'Install OpenCode (opencode.ai), run opencode auth login and pick a model that can read images: the red marks on notes are pictures.' | t }}</p>
  }
  @if (!service()) {
    <p class="tk-hint">{{ 'Without the service, run ./start.sh again after each reboot (it runs in tmux; ./start.sh attach to watch).' | t }}</p>
  }
</ng-template>`,
})
export class TokensSettingsPanel implements OnDestroy {
  private http = inject(HttpClient);
  private auth = inject(Auth);
  agents = inject(Agents);
  private unwatch = this.agents.watch();
  os = signal<SeedOs>(/Win/i.test(navigator.platform || navigator.userAgent) ? 'windows' : 'unix');
  seed = computed(() => this.agents.status()?.seed ?? 'https://github.com/x3beche/redline-agent-seed');
  runner = signal<SeedRunner>(seedPref('runner') === 'opencode' ? 'opencode' : 'claude');
  service = signal(seedPref('service') === '1');
  readonly may = this.auth.can('tokens');
  readonly myRole = this.auth.state()?.role ?? 'owner';
  /** The roles an agent may carry, no higher than one's own. */
  readonly roles = (() => {
    const s = this.auth.state(), all = s?.roles ?? ['owner', 'admin', 'editor', 'reviewer', 'viewer'];
    const mine = all.indexOf(this.myRole);
    return (s?.token_roles ?? ['editor', 'reviewer', 'viewer']).filter(r => all.indexOf(r) >= mine);
  })();
  readonly rooms = [{ id: '', label: 'Any room' }, { id: 'cad', label: 'CAD' }, { id: 'pcb', label: 'PCB' }];
  readonly roleOpts: SelectOption[] = this.roles.map(r => ({ value: r, label: r }));
  roomOpts = computed<SelectOption[]>(() => this.rooms.map(r => ({ value: r.id, label: t(r.label) })));
  readonly expiries: { days: number | null; label: string }[] = [
    { days: null, label: 'Never' }, { days: 7, label: '7 days' }, { days: 30, label: '30 days' }, { days: 90, label: '90 days' }];
  readonly origin = location.origin;
  readonly f = fmt;
  readonly money = money;

  list = signal<AgentToken[] | null>(null);
  usage = signal<Usage | null>(null);
  name = signal('');
  role = signal(this.roles[0] ?? 'viewer');
  room = signal('');
  expiry = signal<number | null>(null);
  made = signal<{ name: string; token: string } | null>(null);
  copied = signal<'lines' | 'token' | 'line' | null>(null);
  error = signal('');
  busy = signal(false);
  open = signal<string | null>(null);
  detail = signal<Detail | null>(null);
  detailErr = signal('');

  counts = computed(() => ({ active: (this.list() ?? []).filter(x => x.status === 'active').length }));
  byToken = computed<Row[]>(() => {
    const u = this.usage(), names = new Map((this.list() ?? []).map(x => [x.id, x.name]));
    if (!u) return [];
    return Object.entries(u.per_token).filter(([, p]) => p.d30)
      .map(([id, p]) => ({ name: names.get(id) ?? id, value: p.d30 }))
      .sort((a, b) => b.value - a.value).slice(0, 8);
  });

  constructor() { if (this.may) this.load(); }

  ngOnDestroy() { this.unwatch(); }

  /** The seed's one line for this server, with the token when there is one. */
  line(token?: string | null) {
    return seedLine(this.seed(), this.origin, this.os(), token, { runner: this.runner(), service: this.service() });
  }

  setRunner(r: SeedRunner) { this.runner.set(r); setSeedPref('runner', r); }
  setService(on: boolean) { this.service.set(on); setSeedPref('service', on ? '1' : '0'); }

  /** What has to be installed, named after the runner chosen above. */
  prereq() {
    return t('Needs git, Python 3.12 or newer and {r}, signed in. On Windows the line runs the agent in WSL. The token is kept in .env in that folder, readable only by you - never commit it or paste it anywhere else.')
      .replace('{r}', this.runner() === 'opencode' ? 'OpenCode' : 'Claude Code');
  }

  copyLine() {
    navigator.clipboard?.writeText(this.line(this.made()?.token)).then(() => this.copied.set('line'),
      () => this.error.set(t('The browser would not copy - select the line instead.')));
  }

  seen(s: number | null) { return seenAgo(s); }

  /** Used within the connected window (backend/agent_kit.py CONNECTED_S). */
  live(x: AgentToken): boolean {
    const w = this.agents.status()?.window_s ?? 600;
    return x.status === 'active' && !!x.last_used && (Date.now() - this.ms(x.last_used)) / 1000 <= w;
  }

  load() {
    forkJoin({ list: this.http.get<AgentToken[]>('/api/agent-tokens'),
               usage: this.http.get<Usage>('/api/agent-tokens/usage') }).subscribe({
      next: r => { this.list.set(r.list); this.usage.set(r.usage); },
      error: e => { this.list.set(this.list() ?? []); this.error.set(this.say(e)); },
    });
  }

  per(id: string): PerToken | null { return this.usage()?.per_token[id] ?? null; }

  make() {
    this.busy.set(true);
    this.error.set('');
    this.http.post<AgentToken & { token: string }>('/api/agent-tokens', {
      name: this.name().trim(), role: this.role(), room: this.room() || null, expires_days: this.expiry(),
    }).subscribe({
      next: x => { this.busy.set(false); this.made.set({ name: x.name, token: x.token }); this.copied.set(null);
                   this.name.set(''); this.load(); this.agents.refresh(); },
      error: e => { this.busy.set(false); this.error.set(this.say(e)); },
    });
  }

  async revoke(x: AgentToken) {
    if (!await Confirm.ask({ title: t('Revoke "{x}"?').replace('{x}', x.name),
      text: t('The agent using it is stopped at once; the token stays listed.'), ok: t('Revoke'), danger: true })) return;
    this.act(this.http.delete(`/api/agent-tokens/${encodeURIComponent(x.id)}`), x);
  }

  async remove(x: AgentToken) {
    const text = (x.status === 'active' ? t('It is still active: it is revoked first, and the agent using it is stopped at once.') + '\n' : '')
      + t('Its usage counts go with it; the audit trail keeps what it did.');
    if (!await Confirm.ask({ title: t('Delete "{x}" for good?').replace('{x}', x.name), text, ok: t('Delete'), danger: true })) return;
    this.act(this.http.delete(`/api/agent-tokens/${encodeURIComponent(x.id)}?purge=1`), x);
  }

  private act(call: ReturnType<HttpClient['delete']>, x: AgentToken) {
    this.busy.set(true);
    this.error.set('');
    call.subscribe({
      next: () => { this.busy.set(false); if (this.made()?.name === x.name) this.made.set(null);
                    if (this.open() === x.id) this.open.set(null); this.load(); this.agents.refresh(); },
      error: e => { this.busy.set(false); this.error.set(this.say(e)); },
    });
  }

  toggle(x: AgentToken) {
    if (this.open() === x.id) { this.open.set(null); return; }
    this.open.set(x.id);
    this.detail.set(null);
    this.detailErr.set('');
    this.http.get<Detail>(`/api/agent-tokens/${encodeURIComponent(x.id)}/usage`).subscribe({
      next: d => { if (this.open() === x.id) this.detail.set(d); },
      error: e => this.detailErr.set(this.say(e)),
    });
  }

  copy(token: string, lines: boolean) {
    const text = lines ? `REDLINE_TRANSPORT=api\nREDLINE_API=${this.origin}\nREDLINE_TOKEN=${token}\n` : token;
    navigator.clipboard?.writeText(text).then(() => this.copied.set(lines ? 'lines' : 'token'),
      () => this.error.set(t('The browser would not copy - select the lines instead.')));
  }

  /** What the requests were, in the words of access.py's actions. */
  actRows(d: Detail): Row[] {
    const words: Record<string, string> = { view: 'looked', draw: 'notes, drafts, chat', run: 'runs and builds',
      edit: 'changes', delete: 'deletes', settings: 'server settings', tokens: 'tokens', space: 'own settings', users: 'accounts', none: 'open routes' };
    return this.rowsOf(d.acts, words);
  }

  rowsOf(m: Record<string, number>, words: Record<string, string> = {}): Row[] {
    return Object.entries(m).map(([k, v]) => ({ name: t(words[k] ?? k), value: v })).sort((a, b) => b.value - a.value);
  }

  pct(a: number, b: number) { return b ? Math.round(100 * a / b) + '%' : '–'; }
  exact(iso: string | null | undefined) { return when(iso); }

  private ms(iso: string) { return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z').getTime(); }

  ago(iso: string) {
    LANG();
    const s = (Date.now() - this.ms(iso)) / 1000;
    if (s < 90) return t('just now');
    if (s < 5400) return t('{n} min ago').replace('{n}', String(Math.round(s / 60)));
    if (s < 129600) return t('{n} h ago').replace('{n}', String(Math.round(s / 3600)));
    return t('{n} days ago').replace('{n}', String(Math.round(s / 86400)));
  }

  left(iso: string) {
    const d = (this.ms(iso) - Date.now()) / 86400000;
    return d < 1 ? t('{n} h left').replace('{n}', String(Math.max(1, Math.round(d * 24))))
      : t('{n} d left').replace('{n}', String(Math.round(d)));
  }

  private say(e: HttpErrorResponse) { return typeof e.error?.detail === 'string' ? e.error.detail : t('that did not work'); }
}
