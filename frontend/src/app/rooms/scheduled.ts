import { Component, OnDestroy, computed, effect, inject, signal, untracked } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { LANG, T, t } from '../i18n';
import { SelectOption, UiSelect } from '../ui-select';
import { ContextMenu } from '../context-menu';
import { Confirm } from '../confirm';
import { Toast } from '../toast';
import { Skeleton } from '../skeleton';
import { EmptyState } from '../empty-state';
import { Markdown } from '../markdown';
import { Auth } from '../auth';
import { money } from '../money';
import { navGo, navParams, navUrl } from '../nav';

/** The Tasks tab: scheduled tasks (backend/sched) - built-in jobs that run
 *  on a schedule and send their result: "every Monday at 09:00, the stock
 *  report to Telegram", "every night, the prices read again".
 *
 *  A dense list on the left (name and type, the schedule in words, the next
 *  run, the last result, on/off) and the open task on the right: what it
 *  does (its inputs, drawn from the type's own list), when (the schedule
 *  editor with the next five times beside it), where its result goes, its
 *  limits, and its history with each run's report. /tasks/<id> is its
 *  address (nav-url.ts). Nothing here runs a task by itself: the server's
 *  scheduler does (backend/sched/core.py). */

interface Param {
  name: string; kind: 'int' | 'float' | 'bool' | 'str' | 'text' | 'enum' | 'list'; label: string; default: unknown;
  lo: number | null; hi: number | null; choices: string[]; of: string; about: string; max_len: number; max_items: number;
  required: boolean;
}
interface Kind {
  id: string; label: string; about: string; right: string; llm: boolean; rerun_safe: boolean; timeout_s: number;
  table: boolean; params: Param[]; allowed: boolean;
}
interface Types { types: Kind[]; tools: { name: string; label: string; package: string }[]; telegram: boolean; tz: string; digest_parts: string[] }
interface Schedule { kind: 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'hours' | 'cron'; at?: string; days?: number[]; day?: number;
                     every?: number; minute?: number; cron?: string }
interface Deliver { inapp: boolean; telegram: boolean; file: boolean; format: 'md' | 'csv' }
interface Run {
  id: string; task: string; trigger: 'schedule' | 'manual' | 'retry'; slot: string | null; status: string; attempt: number;
  at: string; started_at?: string; finished_at?: string; ms?: number; summary?: string | null; cost_usd?: number | null;
  error?: string | null; has_output?: boolean; output?: string | null; waiting?: string; doing?: string; missed?: number;
  delivered?: Record<string, unknown>;
}
interface Task {
  id: string; name: string; type: string; type_label: string; params: Record<string, unknown>; schedule: Schedule; cron: string;
  tz: string; deliver: Deliver; timeout_s: number; retries: number; grace_min: number; month_usd?: number; enabled: boolean;
  next_run: string | null; last: { run: string; status: string; at: string; summary: string | null } | null; fails: number;
  words: string; llm: boolean; open: Run | null; owner: { id: string; name: string }; paused_why?: string;
}
interface Settings { enabled: boolean; max_parallel: number; user_month_usd: number; env_off: boolean; on: boolean }
interface Template { id: string; name: string; type: string; params: Record<string, unknown>; schedule: Schedule; deliver: Deliver;
                     about: string; allowed: boolean }
interface Preview { cron: string; tz: string; words: string; next: { at: string; local: string; dow: number }[] }
type Draft = Omit<Task, 'id' | 'type_label' | 'words' | 'llm' | 'open' | 'owner' | 'next_run' | 'last' | 'fails' | 'cron'>
  & { id: string | null };

const API = '/api/scheduled';
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const KINDS: { id: Schedule['kind']; label: string }[] = [
  { id: 'daily', label: 'Daily' }, { id: 'weekdays', label: 'Weekdays' }, { id: 'weekly', label: 'Weekly' },
  { id: 'monthly', label: 'Monthly' }, { id: 'hours', label: 'Hourly' }, { id: 'cron', label: 'Cron' },
];
const ZONES = ['Europe/Istanbul', 'UTC', 'Europe/London', 'Europe/Berlin', 'Europe/Moscow', 'Asia/Dubai', 'Asia/Shanghai',
               'Asia/Tokyo', 'America/New_York', 'America/Los_Angeles'];
const STATUS_TONE: Record<string, string> = {
  done: 'ok', failed: 'danger', interrupted: 'warn', missed: 'warn', skipped: 'dim', cancelled: 'dim',
  queued: 'live', starting: 'live', running: 'live',
};
const I = {
  play: 'M7 5l12 7-12 7z',
  pause: 'M8 5v14 M16 5v14',
  plus: 'M12 5v14 M5 12h14',
  trash: 'M5 7h14 M10 7V4h4v3 M7 7l1 13h8l1-13',
  warn: 'M12 3.8L21.2 20H2.8z M12 10v4.2 M12 17.2v.1',
  tpl: 'M4 5h16v4H4z M4 11h7v8H4z M13 11h7v8h-7z',
};

@Component({
  selector: 'app-room-tasks',
  imports: [T, UiSelect, Skeleton, EmptyState, Markdown],
  styleUrls: ['./scheduled.css'],
  template: `
<div class="tcv-room absolute inset-0 flex min-h-0 gap-1 p-1">
  <!-- LEFT, as in Parts: find, make, the tasks, and the templates to start from. -->
  <aside class="tcv-notes-side">
    <div class="tcv-notes-find">
      <input class="tcv-notes-search" [placeholder]="'Search tasks' | t" [value]="q()"
             (input)="q.set($any($event.target).value)" (keydown.escape)="q.set(''); $any($event.target).blur()">
    </div>
    @if (canMake()) {
      <div class="sk-side-acts">
        <button type="button" class="tcv-btn" (click)="newMenu($event)">{{ 'New task' | t }}</button>
        <button type="button" class="tcv-btn" (click)="templateMenu($event)">{{ 'Templates' | t }}</button>
      </div>
    }
    <div class="tcv-notes-list">
      <button type="button" class="tcv-notes-item" [attr.data-on]="draft() ? null : 1" (click)="home()">
        <span class="tcv-notes-item-top">
          <span class="tcv-notes-item-title">{{ 'Overview' | t }}</span>
          <span class="tcv-notes-item-when">{{ tasks()?.length ?? 0 }} · {{ count('on') }} {{ 'on' | t }}</span>
        </span>
      </button>
      @if (found().length) {
        <div class="tcv-notes-group">{{ 'Tasks' | t }}</div>
        @for (x of found(); track x.id) {
          <button type="button" class="tcv-notes-item" [attr.data-on]="draft()?.id === x.id ? 1 : null" (click)="open(x.id)">
            <span class="tcv-notes-item-top">
              <span class="tcv-notes-item-title" [class.sk-dimname]="!x.enabled">{{ x.name }}</span>
              <span class="tcv-notes-item-when">{{ x.enabled ? inn(x.next_run) : ('paused' | t) }}</span>
            </span>
            <span class="tcv-notes-item-snip">{{ words(x.schedule) }}
              @if (x.last; as l) { · <span class="sk-tone" [attr.data-tone]="tone(l.status)">{{ statusWord(l.status) | t }}</span> }</span>
          </button>
        }
      } @else if (q()) { <wb-empty compact icon="search" text="Nothing matches." /> }
      @if (templates().length) {
        <div class="tcv-notes-group">{{ 'Start from a template' | t }}</div>
        @for (tp of templates(); track tp.id) {
          <button type="button" class="tcv-notes-item" [disabled]="!tp.allowed || !canMake()" (click)="fromTemplate(tp)"
                  [title]="(tp.allowed ? tp.about : 'Your role may not make this one') | t">
            <span class="tcv-notes-item-top"><span class="tcv-notes-item-title">{{ tp.name | t }}</span></span>
            <span class="tcv-notes-item-snip">{{ tp.about | t }}</span>
          </button>
        }
      }
    </div>
  </aside>

  <!-- RIGHT, as in Parts: the overview (head row, filters, the table), or the open task. -->
  <section class="tcv-notes-main sk-main">
    @if (!draft()) {
      <div class="sk-bar">
      <span class="sk-title">{{ 'Scheduled tasks' | t }}@if (tasks(); as ts) {<small>{{ ts.length }}</small>}</span>
      <div class="sk-seg" role="group" [attr.aria-label]="'Show' | t">
        @for (f of filters; track f.id) {
          <button type="button" [attr.data-on]="filter() === f.id ? 1 : null" (click)="filter.set(f.id)">{{ f.label | t }}<em>{{ count(f.id) }}</em></button>
        }
      </div>
      <span class="sk-fill"></span>
      @if (settings(); as s) {
        <button type="button" class="sk-switchrow" [disabled]="!canSettings()" (click)="toggleScheduler()"
                [title]="(canSettings() ? (s.on ? 'Switch every scheduled task off, at once' : 'Let the scheduled tasks run again') : 'Only an owner or admin switches the scheduler') | t">
          <span class="tcv-switch" [attr.data-on]="s.on ? 1 : null" aria-hidden="true"></span>
          @if (s.on) { {{ 'Scheduler on' | t }} · {{ s.max_parallel }} {{ 'at once' | t }} }
          @else { <span class="sk-off">{{ (s.env_off ? 'Scheduler off (server setting)' : 'Scheduler off') | t }}</span> }
        </button>
      }
      <button type="button" class="sk-btn" (click)="templateMenu($event)" [disabled]="!canMake()" [title]="'Start from a template' | t">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.tpl"/></svg>{{ 'Templates' | t }}</button>
      <button type="button" class="sk-btn" data-tone="accent" (click)="newMenu($event)" [disabled]="!canMake()"
              [title]="(canMake() ? 'A new scheduled task' : 'Viewers cannot make tasks') | t">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.plus"/></svg>{{ 'New' | t }}</button>
    </div>
      <div class="sk-table" [attr.aria-label]="'Scheduled tasks' | t">
        @if (tasks(); as ts) {
          <div class="sk-thead" aria-hidden="true">
            <span>{{ 'Task' | t }}</span><span>{{ 'Schedule' | t }}</span><span class="sk-hide-sm">{{ 'Next' | t }}</span>
            <span class="sk-hide-sm">{{ 'Last run' | t }}</span><span></span>
          </div>
          @if (ts.length) {
            @for (x of shown(); track x.id) {
              <div class="sk-row" role="button" tabindex="0" [attr.data-on]="x.id === sel() ? 1 : null" [attr.data-off]="x.enabled ? null : 1"
                   [attr.aria-current]="x.id === sel() ? 'true' : null" (click)="open(x.id)" (keydown.enter)="open(x.id)">
                <div class="sk-cell"><span class="sk-name">{{ x.name }}</span><span class="sk-sub">{{ x.type_label | t }}</span></div>
                <div class="sk-cell"><span>{{ words(x.schedule) }}</span><span class="sk-sub">{{ x.tz }}</span></div>
                <div class="sk-cell sk-hide-sm"><span class="sk-when" [title]="exact(x.next_run)">{{ x.enabled ? inn(x.next_run) : ('paused' | t) }}</span>
                  <span class="sk-sub">{{ x.enabled ? short(x.next_run, x.tz) : '' }}</span></div>
                <div class="sk-cell sk-hide-sm">
                  @if (x.open; as o) {
                    <span class="sk-tone" data-tone="live">{{ statusWord(o.status) | t }}</span><span class="sk-sub">{{ o.waiting || o.doing || '' }}</span>
                  } @else if (x.last; as l) {
                    <span class="sk-tone" [attr.data-tone]="tone(l.status)" [title]="l.summary || ''">{{ statusWord(l.status) | t }} · {{ ago(l.at) }}</span>
                    <span class="sk-sub" [title]="l.summary || ''">{{ l.summary || '' }}</span>
                  } @else { <span class="sk-tone" data-tone="dim">{{ 'never run' | t }}</span> }
                </div>
                <div class="sk-sw">
                  <button type="button" [disabled]="!mayChange(x)" (click)="$event.stopPropagation(); flip(x)"
                          [title]="(x.enabled ? 'On - click to pause' : 'Paused - click to switch on') | t" [attr.aria-pressed]="x.enabled">
                    <span class="tcv-switch" [attr.data-on]="x.enabled ? 1 : null" aria-hidden="true"></span></button>
                </div>
              </div>
            } @empty {
              <wb-empty compact icon="doc" heading="Nothing here" text="No task matches this filter." />
            }
          } @else {
            <wb-empty icon="doc" heading="No scheduled tasks yet"
                      text="A task runs a report or a refresh by itself, on a schedule, and sends you the result. Start from a template, or press New.">
              @if (canMake()) { <button type="button" class="tcv-btn" (click)="newMenu($event)">{{ 'New task' | t }}</button> }
            </wb-empty>
          }
        } @else if (err()) { <p class="sk-err" style="padding: 12px">{{ err() }}</p> }
        @else { <wb-skel kind="rows" [count]="8" [h]="40" /> }
  </div>
    } @else {
        @if (draft(); as d) {
          @if (kindOf(d.type); as k) {
          <div class="sk-head">
            <input class="sk-headname" [value]="d.name" maxlength="80" [attr.aria-label]="'Name' | t" [disabled]="!editable()"
                   (input)="patch({ name: $any($event.target).value })">
            <span class="sk-headtype">{{ k.label | t }}</span>
            @if (dirty()) { <span class="sk-dirty">{{ (d.id ? 'Not saved' : 'New - not made yet') | t }}</span> }
            @if (dirty() || !d.id) {
              @if (d.id) { <button type="button" class="sk-btn" (click)="revert()">{{ 'Revert' | t }}</button> }
              @else { <button type="button" class="sk-btn" (click)="cancelNew()">{{ 'Cancel' | t }}</button> }
              <button type="button" class="sk-btn" data-tone="accent" (click)="save()" [disabled]="saving() || !editable()">
                {{ (d.id ? 'Save' : 'Make the task') | t }}</button>
            }
            @if (cur(); as c) {
              <div class="sk-joined">
                <button type="button" class="sk-btn" (click)="runNow(c)" [disabled]="!!c.open || !mayChange(c) || !settings()?.on || (c.llm && !d.params['accept_cost'])"
                        [title]="(c.open ? 'A run is waiting or going' : 'Run it now, outside its schedule') | t">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.play"/></svg>{{ 'Run now' | t }}</button>
                <button type="button" class="sk-btn" (click)="flip(c)" [disabled]="!mayChange(c)">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="c.enabled ? I.pause : I.play"/></svg>{{ (c.enabled ? 'Pause' : 'Resume') | t }}</button>
                <button type="button" class="sk-btn" data-tone="danger" (click)="remove(c)" [disabled]="!mayChange(c) || !auth.can('delete')"
                        [title]="'Delete the task and its history' | t">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.trash"/></svg>{{ 'Delete' | t }}</button>
              </div>
            }
          </div>
          @if (saveErr()) { <p class="sk-err" style="padding: 0 14px">{{ saveErr() }}</p> }
  
          <!-- When: the schedule editor, and the next five times beside it. -->
          <div class="sk-sec sk-whensec">
              <h3>{{ 'When' | t }}<span class="sk-aside">{{ d.tz }}</span></h3>
              <div class="sk-when-grid">
                <div>
                  <div class="sk-seg" role="group" [attr.aria-label]="'Schedule' | t" style="margin-bottom: 10px">
                    @for (o of kinds; track o.id) {
                      <button type="button" [attr.data-on]="d.schedule.kind === o.id ? 1 : null" [disabled]="!editable()" (click)="setKind(o.id)">{{ o.label | t }}</button>
                    }
                  </div>
                  <div class="sk-fields">
                    @switch (d.schedule.kind) {
                      @case ('weekly') {
                        <div class="sk-f" data-wide="1"><span class="sk-lab">{{ 'Days' | t }}</span>
                          <div class="sk-days">
                            @for (n of [1, 2, 3, 4, 5, 6, 7]; track n) {
                              <button type="button" [attr.data-on]="(d.schedule.days || []).includes(n) ? 1 : null" [disabled]="!editable()"
                                      [title]="dayName(n) | t" (click)="toggleDay(n)">{{ dayShort(n) | t }}</button>
                            }
                          </div></div>
                      }
                      @case ('monthly') {
                        <div class="sk-f"><span class="sk-lab">{{ 'Day of the month' | t }}</span>
                          <wb-select size="sm" label="Day of the month" [options]="monthDays()" [value]="'' + (d.schedule.day ?? 1)" [disabled]="!editable()"
                                     (pick)="setSched({ day: +$event })" /></div>
                      }
                      @case ('hours') {
                        <div class="sk-f"><span class="sk-lab">{{ 'Every' | t }}</span>
                          <wb-select size="sm" label="Every" [options]="everyOpts()" [value]="'' + (d.schedule.every ?? 1)" [disabled]="!editable()"
                                     (pick)="setSched({ every: +$event })" /></div>
                        <div class="sk-f"><label for="sk-min">{{ 'At minute' | t }}</label>
                          <input id="sk-min" class="sk-in" inputmode="numeric" [value]="'' + (d.schedule.minute ?? 0)" [disabled]="!editable()"
                                 (input)="setSched({ minute: +$any($event.target).value || 0 })"></div>
                      }
                      @case ('cron') {
                        <div class="sk-f" data-wide="1"><label for="sk-cron">{{ 'Cron (minute hour day month weekday)' | t }}</label>
                          <input id="sk-cron" class="sk-in" [value]="d.schedule.cron || ''" placeholder="0 9 * * 1" [disabled]="!editable()"
                                 [attr.data-bad]="previewErr() ? 1 : null" (input)="setSched({ cron: $any($event.target).value })"></div>
                      }
                    }
                    @if (d.schedule.kind !== 'hours' && d.schedule.kind !== 'cron') {
                      <div class="sk-f"><label for="sk-at">{{ 'At' | t }}</label>
                        <input id="sk-at" class="sk-in" [value]="d.schedule.at || '09:00'" placeholder="09:00" maxlength="5" [disabled]="!editable()"
                               [attr.data-bad]="previewErr() ? 1 : null" (input)="setSched({ at: $any($event.target).value })"></div>
                    }
                    <div class="sk-f"><span class="sk-lab">{{ 'Time zone' | t }}</span>
                      <wb-select size="sm" label="Time zone" [options]="zoneOpts()" [value]="d.tz" [disabled]="!editable()" (pick)="patch({ tz: $event })" /></div>
                  </div>
                  @if (preview(); as pv) {
                    <p class="sk-words">{{ words(d.schedule) }}@if (d.schedule.kind !== 'cron') {<small>{{ pv.cron }}</small>}</p>
                  }
                  @if (previewErr(); as e) { <p class="sk-err">{{ e | t }}</p> }
                </div>
                <div>
                  <div class="sk-next-head">{{ 'Next runs' | t }}</div>
                  @if (preview(); as pv) {
                    <ul class="sk-next">
                      @for (n of pv.next; track n.at) { <li>{{ dayShort(n.dow) | t }} {{ n.local }}<span>{{ inn(n.at) }}</span></li> }
                    </ul>
                  } @else if (!previewErr()) { <wb-skel kind="rows" [count]="5" [h]="22" /> }
                </div>
              </div>
            </div>
  
  
          <div class="sk-two">
            <!-- What it does: the type's own inputs. -->
            <div class="sk-sec">
              <h3>{{ 'What it does' | t }}</h3>
              <p class="sk-about">{{ k.about | t }}</p>
              @if (k.params.length) {
                <div class="sk-fields">
                  @for (p of k.params; track p.name) {
                    <div class="sk-f" [attr.data-wide]="p.kind === 'text' || p.kind === 'list' ? 1 : null">
                      @if (p.kind !== 'bool') { <label [attr.for]="'sk-p-' + p.name">{{ p.label | t }}</label> }
                      @switch (p.kind) {
                        @case ('bool') {
                          <span class="sk-lab">&nbsp;</span>
                          <div class="sk-checks"><label><input type="checkbox" class="tcv-check" [checked]="!!d.params[p.name]" [disabled]="!editable()"
                                 (change)="setParam(p.name, $any($event.target).checked)"> {{ p.label | t }}</label></div>
                        }
                        @case ('enum') {
                          <wb-select size="sm" [label]="p.label" [options]="enumOpts(p)" [value]="'' + (d.params[p.name] ?? '')" [disabled]="!editable()"
                                     (pick)="setParam(p.name, $event)" />
                        }
                        @case ('text') {
                          <textarea class="sk-in" [id]="'sk-p-' + p.name" [value]="'' + (d.params[p.name] ?? '')" [attr.maxlength]="p.max_len"
                                    [disabled]="!editable()" (input)="setParam(p.name, $any($event.target).value)"></textarea>
                        }
                        @case ('list') {
                          @if (p.choices.length) {
                            <div class="sk-checks">
                              @for (c of p.choices; track c) {
                                <label><input type="checkbox" class="tcv-check" [checked]="listOf(p.name).includes(c)" [disabled]="!editable()"
                                       (change)="toggleItem(p.name, c)"> {{ kindLabel(c) | t }}</label>
                              }
                            </div>
                          } @else {
                            <div class="sk-chips">
                              @for (v of listOf(p.name); track v) {
                                <span class="sk-chip"><span [title]="v">{{ itemLabel(p, v) }}</span>
                                  @if (editable()) { <button type="button" (click)="toggleItem(p.name, v)" [attr.aria-label]="'Remove' | t">×</button> }</span>
                              }
                              @if (editable() && listOf(p.name).length < p.max_items) {
                                <wb-select size="sm" [label]="p.label" placeholder="Add" [options]="itemOpts(p)" value=""
                                           (opened)="loadItems(p.of)" (pick)="toggleItem(p.name, $event)" />
                              }
                            </div>
                          }
                        }
                        @default {
                          <input class="sk-in" [id]="'sk-p-' + p.name" [value]="'' + (d.params[p.name] ?? '')" [disabled]="!editable()"
                                 [attr.inputmode]="p.kind === 'str' ? null : 'decimal'" [attr.maxlength]="p.max_len"
                                 (input)="setParam(p.name, $any($event.target).value, p.kind)">
                        }
                      }
                      @if (p.about && p.kind !== 'bool') { <small>{{ p.about | t }}@if (p.lo !== null && p.hi !== null) { · {{ p.lo }}-{{ p.hi }}}</small> }
                    </div>
                  }
                </div>
              } @else { <p class="sk-about">{{ 'It takes no inputs.' | t }}</p> }
              @if (k.llm) {
                <p class="sk-warn"><svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.warn"/></svg>
                  <span>{{ 'Every run of this task spends money on a model. It is made paused; it runs only with the cost accepted, stops when a run passes its cap, and is held to a monthly cap of its own and one for all your tasks.' | t }}
                    @if (settings(); as s) { {{ 'Your monthly cap' | t }}: {{ money(s.user_month_usd) }}. }</span></p>
              }
              @if (!k.allowed) { <p class="sk-err">{{ 'Your role may not run this type of task.' | t }}</p> }
            </div>
  
            <div class="sk-col">
            <!-- Where the result goes. -->
            <div class="sk-sec">
              <h3>{{ 'Where the result goes' | t }}</h3>
              <div class="sk-checks">
                <label><input type="checkbox" class="tcv-check" [checked]="d.deliver.inapp" [disabled]="!editable()" (change)="setDeliver({ inapp: !d.deliver.inapp })">
                  {{ 'In the app' | t }}</label>
                <label [attr.data-off]="!types()?.telegram ? 1 : null"
                       [title]="(types()?.telegram ? 'To your linked Telegram chat' : 'Link your Telegram in Settings > Telegram first') | t">
                  <input type="checkbox" class="tcv-check" [checked]="d.deliver.telegram" [disabled]="!editable() || (!types()?.telegram && !d.deliver.telegram)"
                         (change)="setDeliver({ telegram: !d.deliver.telegram })"> Telegram</label>
                <label [title]="'Into Files > In the app > Agents > Scheduled tasks' | t">
                  <input type="checkbox" class="tcv-check" [checked]="d.deliver.file" [disabled]="!editable()" (change)="setDeliver({ file: !d.deliver.file })">
                  {{ 'A file' | t }}</label>
                @if (d.deliver.file && k.table) {
                  <div class="sk-seg">
                    <button type="button" [attr.data-on]="d.deliver.format === 'md' ? 1 : null" (click)="setDeliver({ format: 'md' })">Markdown</button>
                    <button type="button" [attr.data-on]="d.deliver.format === 'csv' ? 1 : null" (click)="setDeliver({ format: 'csv' })">CSV</button>
                  </div>
                }
              </div>
              <p class="sk-about" style="margin: 8px 0 0">{{ 'Every run is also kept in the history below. There is no e-mail.' | t }}</p>
            </div>
            <!-- Its limits. -->
            <div class="sk-sec">
              <h3>{{ 'Limits' | t }}</h3>
              <div class="sk-fields">
                <div class="sk-f"><label for="sk-to">{{ 'Time limit (s)' | t }}</label>
                  <input id="sk-to" class="sk-in" inputmode="numeric" [value]="'' + d.timeout_s" [disabled]="!editable()" (input)="patch({ timeout_s: +$any($event.target).value || 0 })"></div>
                <div class="sk-f"><span class="sk-lab">{{ 'Retries' | t }}</span>
                  <wb-select size="sm" label="Retries" [options]="retryOpts" [value]="'' + d.retries" [disabled]="!editable() || !k.rerun_safe"
                             [tip]="(k.rerun_safe ? 'After 1, 5 and 15 minutes' : 'Not re-run by itself: it costs money') | t" (pick)="patch({ retries: +$event })" /></div>
                <div class="sk-f"><label for="sk-gr">{{ 'Late start allowed (min)' | t }}</label>
                  <input id="sk-gr" class="sk-in" inputmode="numeric" [value]="'' + d.grace_min" [disabled]="!editable()"
                         [title]="'A run the server was down for is still made if it is late by less than this; otherwise it is recorded as missed' | t"
                         (input)="patch({ grace_min: +$any($event.target).value || 0 })"></div>
                @if (k.llm) {
                  <div class="sk-f"><label for="sk-mc">{{ 'Monthly cap (USD)' | t }}</label>
                    <input id="sk-mc" class="sk-in" inputmode="decimal" [value]="'' + (d.month_usd ?? 1)" [disabled]="!editable()"
                           (input)="patch({ month_usd: +$any($event.target).value || 0 })"></div>
                }
              </div>
            </div>
          </div>
          </div>
  
          <!-- The history. -->
          @if (cur(); as c) {
            <div class="sk-sec" style="border-bottom: 0">
              <h3>{{ 'History' | t }}<span class="sk-aside">{{ 'kept 90 days' | t }}</span></h3>
              @if (runs(); as rs) {
                @if (rs.length) {
                  <table class="sk-hist">
                    <colgroup><col style="width: 178px"><col style="width: 84px"><col style="width: 104px"><col style="width: 64px"><col>
                      @if (c.llm) { <col style="width: 70px"> }</colgroup>
                    <thead><tr><th>{{ 'When' | t }}</th><th>{{ 'Started by' | t }}</th><th>{{ 'Result' | t }}</th><th class="r">{{ 'Took' | t }}</th>
                      <th>{{ 'Summary' | t }}</th>@if (c.llm) { <th class="r">{{ 'Cost' | t }}</th> }</tr></thead>
                    <tbody>
                      @for (r of rs; track r.id) {
                        <tr class="sk-hrow" [attr.data-open]="openRun() === r.id ? 1 : null" (click)="toggleRun(r)">
                          <td class="mono" [title]="exact(r.slot || r.at)"><span class="sk-caret">›</span>{{ short(r.started_at || r.slot || r.at, c.tz) }}</td>
                          <td>{{ trigger(r) }}</td>
                          <td><span class="sk-tone" [attr.data-tone]="tone(r.status)">{{ statusWord(r.status) | t }}</span></td>
                          <td class="r mono">{{ took(r.ms) }}</td>
                          <td class="sk-hsum" [title]="r.summary || r.error || ''">{{ r.summary || r.error || r.waiting || r.doing || '' }}</td>
                          @if (c.llm) { <td class="r mono">{{ r.cost_usd != null ? money(r.cost_usd) : '–' }}</td> }
                        </tr>
                        @if (openRun() === r.id) {
                          <tr><td [attr.colspan]="c.llm ? 6 : 5" class="sk-out">
                            @if (outputs()[r.id]; as o) {
                              <p class="sk-outmeta">{{ meta(r) }}</p>
                              <div class="md" [innerHTML]="o | md"></div>
                            } @else if (r.has_output) { <wb-skel kind="text" /> }
                            @else { <p class="sk-outmeta">{{ (r.error || r.summary || 'Nothing was written for this run.') | t }}</p> }
                          </td></tr>
                        }
                      }
                    </tbody>
                  </table>
                  @if (rs.length >= limit()) { <button type="button" class="sk-btn sk-more" (click)="more()">{{ 'Older runs' | t }}</button> }
                } @else { <p class="sk-about">{{ (c.enabled ? 'Not run yet. The first run is' : 'Not run yet, and paused.') | t }} @if (c.enabled) { {{ short(c.next_run, c.tz) }} ({{ inn(c.next_run) }}). } </p> }
              } @else { <wb-skel kind="rows" [count]="4" [h]="28" /> }
            </div>
          }
          }
        }
      }
  </section>
</div>`,
})
export class RoomTasks implements OnDestroy {
  private http = inject(HttpClient);
  auth = inject(Auth);
  I = I;
  kinds = KINDS;
  money = money;
  filters = [{ id: 'all', label: 'All' }, { id: 'on', label: 'On' }, { id: 'paused', label: 'Paused' }, { id: 'failing', label: 'Failing' }] as const;
  retryOpts: SelectOption[] = [0, 1, 2, 3].map(n => ({ value: '' + n, label: '' + n }));

  tasks = signal<Task[] | null>(null);
  settings = signal<Settings | null>(null);
  types = signal<Types | null>(null);
  templates = signal<Template[]>([]);
  err = signal<string | null>(null);
  q = signal('');
  /** The side list: every task, matched by name, type or schedule words. */
  found = computed(() => {
    const q = this.q().trim().toLowerCase(), ts = this.tasks() ?? [];
    return q ? ts.filter(x => (x.name + ' ' + x.type_label + ' ' + this.words(x.schedule)).toLowerCase().includes(q)) : ts;
  });
  filter = signal<'all' | 'on' | 'paused' | 'failing'>('all');
  /** The open task's id (the address's /tasks/<id>). */
  sel = signal<string | null>(navParams().get('task'));
  /** What the right side edits: the open task's copy, or a new one. */
  draft = signal<Draft | null>(null);
  private base = signal<string>('');
  saving = signal(false);
  saveErr = signal<string | null>(null);
  preview = signal<Preview | null>(null);
  previewErr = signal<string | null>(null);
  runs = signal<Run[] | null>(null);
  limit = signal(50);
  openRun = signal<string | null>(null);
  outputs = signal<Record<string, string>>({});
  private items = signal<Record<string, SelectOption[]>>({});
  private timer?: ReturnType<typeof setInterval>;
  private previewTimer?: ReturnType<typeof setTimeout>;
  private ticks = 0;

  cur = computed(() => { const id = this.draft()?.id; return id ? this.tasks()?.find(x => x.id === id) ?? null : null; });
  dirty = computed(() => { const d = this.draft(); return !!d && (!d.id || JSON.stringify(this.editable_(d)) !== this.base()); });
  canMake = computed(() => this.auth.can('draw'));
  canSettings = computed(() => this.auth.can('settings'));
  editable = computed(() => { const d = this.draft(); if (!d) return false; const c = this.cur(); return this.canMake() && (!c || this.mayChange(c)); });
  shown = computed(() => {
    const f = this.filter(), ts = this.tasks() ?? [];
    return ts.filter(x => f === 'all' || (f === 'on' && x.enabled) || (f === 'paused' && !x.enabled) || (f === 'failing' && this.failing(x)));
  });

  constructor() {
    void this.load(true);
    this.timer = setInterval(() => this.poll(), 5000);
    // The schedule's words and next five times, a moment after each change.
    effect(() => {
      const d = this.draft();
      if (!d) { this.preview.set(null); return; }
      const key = JSON.stringify([d.schedule, d.tz]);
      untracked(() => {
        clearTimeout(this.previewTimer);
        this.previewTimer = setTimeout(() => void this.ask(key, d.schedule, d.tz), 180);
      });
    });
    // The open task, from the list, when it changes (not while it is being edited).
    effect(() => {
      const id = this.sel(), ts = this.tasks();
      untracked(() => {
        if (!ts) return;
        const d = this.draft();
        if (d && (!d.id || d.id === id && this.dirty())) return;          // a new one being made, or changes not saved
        if (!id) { if (d && d.id) this.draft.set(null); return; }
        const x = ts.find(t => t.id === id);
        if (!x) { if (d?.id === id) this.draft.set(null); return; }
        if (!d || d.id !== id || !this.dirty()) this.take(x);
      });
    });
  }

  ngOnDestroy() { clearInterval(this.timer); clearTimeout(this.previewTimer); }

  // ---- reading ---------------------------------------------------------------
  private async get<X>(url: string): Promise<X> { return firstValueFrom(this.http.get<X>(url)); }

  private async load(first = false) {
    try {
      const [list, types, tpls] = await Promise.all([
        this.get<{ tasks: Task[]; settings: Settings }>(API),
        first || !this.types() ? this.get<Types>(API + '/types') : Promise.resolve(this.types()!),
        first ? this.get<Template[]>(API + '/templates') : Promise.resolve(this.templates()),
      ]);
      this.types.set(types);
      this.templates.set(tpls);
      this.settings.set(list.settings);
      this.tasks.set(list.tasks);
      this.err.set(null);
      if (first && this.sel()) void this.loadRuns();
    } catch (e) {
      this.err.set(this.why(e));
    }
  }

  private poll() {
    if (document.hidden) return;
    this.ticks++;
    const live = (this.tasks() ?? []).some(x => x.open) || (this.runs() ?? []).some(r => ['queued', 'starting', 'running'].includes(r.status));
    if (live || this.ticks % 6 === 0) {
      void this.load();
      if (this.cur()) void this.loadRuns();
    }
  }

  private async loadRuns() {
    const id = this.sel();
    if (!id) { this.runs.set(null); return; }
    try {
      const rs = await this.get<Run[]>(`${API}/${encodeURIComponent(id)}/runs?limit=${this.limit()}`);
      if (this.sel() === id) this.runs.set(rs);
    } catch { /* the list says what is wrong */ }
  }

  more() { this.limit.update(n => n + 50); void this.loadRuns(); }

  private async ask(key: string, s: Schedule, tz: string) {
    try {
      const pv = await this.get<Preview>(`${API}/preview?schedule=${encodeURIComponent(JSON.stringify(s))}&tz=${encodeURIComponent(tz)}`);
      const d = this.draft();
      if (d && JSON.stringify([d.schedule, d.tz]) === key) { this.preview.set(pv); this.previewErr.set(null); }
    } catch (e) {
      this.preview.set(null);
      this.previewErr.set(this.why(e));
    }
  }

  // ---- opening and editing ---------------------------------------------------
  open(id: string) {
    if (this.sel() === id) return;
    if (this.dirty() && !confirmLeave()) return;
    this.sel.set(id);
    this.openRun.set(null);
    this.limit.set(50);
    this.runs.set(null);
    this.saveErr.set(null);
    const x = this.tasks()?.find(t => t.id === id);
    if (x) this.take(x);
    const u = navUrl();
    u.searchParams.set('task', id);
    navGo(u, { push: true });
    void this.loadRuns();
  }

  private take(x: Task) {
    const d: Draft = { id: x.id, name: x.name, type: x.type, params: { ...x.params }, schedule: { ...x.schedule }, tz: x.tz,
                       deliver: { ...x.deliver }, timeout_s: x.timeout_s, retries: x.retries, grace_min: x.grace_min,
                       month_usd: x.month_usd, enabled: x.enabled, paused_why: x.paused_why };
    this.draft.set(d);
    this.base.set(JSON.stringify(this.editable_(d)));
  }

  private editable_(d: Draft) {
    return [d.name, d.params, d.schedule, d.tz, d.deliver, d.timeout_s, d.retries, d.grace_min, d.month_usd ?? null];
  }

  patch(p: Partial<Draft>) { this.draft.update(d => d ? { ...d, ...p } : d); }
  setParam(name: string, v: unknown, kind?: string) {
    const val = (kind === 'int' || kind === 'float') && v !== '' && !isNaN(+(v as string)) ? +(v as string) : v;
    this.draft.update(d => d ? { ...d, params: { ...d.params, [name]: val } } : d);
  }
  setSched(p: Partial<Schedule>) { this.draft.update(d => d ? { ...d, schedule: { ...d.schedule, ...p } } : d); }
  setDeliver(p: Partial<Deliver>) { this.draft.update(d => d ? { ...d, deliver: { ...d.deliver, ...p } } : d); }
  setKind(k: Schedule['kind']) {
    const s = this.draft()?.schedule;
    const at = s?.at || '09:00';
    const next: Schedule = k === 'weekly' ? { kind: k, days: s?.days?.length ? s.days : [1], at }
      : k === 'monthly' ? { kind: k, day: s?.day ?? 1, at }
      : k === 'hours' ? { kind: k, every: s?.every ?? 6, minute: s?.minute ?? 0 }
      : k === 'cron' ? { kind: k, cron: this.preview()?.cron || '0 9 * * 1' }
      : { kind: k, at };
    this.patch({ schedule: next });
  }
  toggleDay(n: number) {
    const days = new Set(this.draft()?.schedule.days ?? []);
    if (days.has(n)) days.delete(n); else days.add(n);
    this.setSched({ days: [...days].sort() });
  }
  listOf(name: string): string[] { const v = this.draft()?.params[name]; return Array.isArray(v) ? v as string[] : []; }
  toggleItem(name: string, v: string) {
    if (!v) return;
    const l = this.listOf(name);
    this.setParam(name, l.includes(v) ? l.filter(x => x !== v) : [...l, v]);
  }

  revert() { const c = this.cur(); if (c) this.take(c); this.saveErr.set(null); }
  /** Back to the overview: nothing open. */
  home() {
    if (this.dirty() && !confirmLeave()) return;
    this.draft.set(null);
    this.sel.set(null);
    this.saveErr.set(null);
    const u = navUrl();
    u.searchParams.delete('task');
    navGo(u, { push: true });
  }

  cancelNew() {
    this.draft.set(null);
    this.saveErr.set(null);
    const id = this.sel();
    const x = id ? this.tasks()?.find(t => t.id === id) : null;
    if (x) this.take(x);
  }

  /** A new task of a type, with its defaults: shown on the right until it is made. */
  private start(type: string, from?: Partial<Draft>) {
    if (this.dirty() && !confirmLeave()) return;
    const k = this.kindOf(type);
    if (!k) return;
    const params: Record<string, unknown> = {};
    for (const p of k.params) params[p.name] = Array.isArray(p.default) ? [...p.default] : p.default;
    this.draft.set({ id: null, name: t(k.label), type, params: { ...params, ...(from?.params ?? {}) },
                     schedule: from?.schedule ?? { kind: 'weekly', days: [1], at: '09:00' }, tz: this.types()?.tz || 'Europe/Istanbul',
                     deliver: from?.deliver ?? { inapp: true, telegram: false, file: false, format: 'md' },
                     timeout_s: k.timeout_s, retries: k.rerun_safe ? 1 : 0, grace_min: 60, month_usd: k.llm ? 1 : undefined,
                     enabled: !k.llm, ...(from?.name ? { name: t(from.name) } : {}) });
    this.base.set('');
    this.runs.set(null);
    this.saveErr.set(null);
  }

  newMenu(e: MouseEvent) {
    const ts = this.types()?.types ?? [];
    ContextMenu.open(e, ts.map(k => ({ label: k.label, disabled: !k.allowed, run: () => this.start(k.id) })));
  }
  templateMenu(e: MouseEvent) {
    ContextMenu.open(e, this.templates().map(tp => ({ label: tp.name, disabled: !tp.allowed, run: () => this.fromTemplate(tp) })));
  }
  fromTemplate(tp: Template) { this.start(tp.type, { name: tp.name, params: tp.params, schedule: tp.schedule, deliver: tp.deliver }); }

  async save() {
    const d = this.draft();
    if (!d) return;
    this.saving.set(true);
    this.saveErr.set(null);
    const body = { name: d.name, type: d.type, params: d.params, schedule: d.schedule, tz: d.tz, deliver: d.deliver,
                   timeout_s: d.timeout_s, retries: d.retries, grace_min: d.grace_min, month_usd: d.month_usd ?? null };
    try {
      const got = d.id ? await firstValueFrom(this.http.patch<Task>(`${API}/${encodeURIComponent(d.id)}`, body))
                       : await firstValueFrom(this.http.post<Task>(API, body));
      Toast.show(t(d.id ? 'Saved.' : 'Task made.'), { tone: 'ok' });
      this.tasks.update(ts => [...(ts ?? []).filter(x => x.id !== got.id), got]);
      this.take(got);
      if (!d.id) { this.sel.set(null); this.open(got.id); }
      void this.load();
    } catch (e) {
      this.saveErr.set(this.why(e));
    } finally {
      this.saving.set(false);
    }
  }

  async flip(x: Task) {
    if (!x.enabled && x.llm && !await Confirm.ask({ title: t('Switch on a task that spends money?'),
        text: t('Every run calls a model and costs money, up to its caps. Check its cost cap first.'), ok: t('Switch on') })) return;
    try {
      const got = await firstValueFrom(this.http.post<Task>(`${API}/${encodeURIComponent(x.id)}/${x.enabled ? 'pause' : 'resume'}`, {}));
      this.tasks.update(ts => (ts ?? []).map(y => y.id === got.id ? got : y));
      if (this.draft()?.id === got.id && !this.dirty()) this.take(got);
    } catch (e) { Toast.show(this.why(e), { tone: 'danger' }); }
  }

  async runNow(x: Task) {
    if (x.llm && !await Confirm.ask({ title: t('Run it now?'), text: t('This run calls a model and costs money.'), ok: t('Run now') })) return;
    try {
      await firstValueFrom(this.http.post<Run>(`${API}/${encodeURIComponent(x.id)}/run`, {}));
      Toast.show(t('Started. The result comes here and where the task sends it.'));
      await Promise.all([this.load(), this.loadRuns()]);
    } catch (e) { Toast.show(this.why(e), { tone: 'danger' }); }
  }

  async remove(x: Task) {
    if (!await Confirm.ask({ title: t('Delete "{x}"?').replace('{x}', x.name), text: t('The task and its history go. Nothing it made is deleted.'),
                             ok: t('Delete'), danger: true })) return;
    try {
      await firstValueFrom(this.http.delete(`${API}/${encodeURIComponent(x.id)}`));
      this.tasks.update(ts => (ts ?? []).filter(y => y.id !== x.id));
      this.draft.set(null);
      this.sel.set(null);
      const u = navUrl();
      u.searchParams.delete('task');
      navGo(u, { push: true });
      Toast.show(t('Deleted.'));
    } catch (e) { Toast.show(this.why(e), { tone: 'danger' }); }
  }

  async toggleScheduler() {
    const s = this.settings();
    if (!s || !this.canSettings()) return;
    if (s.on && !await Confirm.ask({ title: t('Switch the scheduler off?'),
        text: t('No scheduled task starts until it is on again; the runs due meanwhile are recorded as skipped.'), ok: t('Switch off'), danger: true })) return;
    try {
      const got = await firstValueFrom(this.http.put<Settings>(API + '/settings', { enabled: !s.enabled }));
      this.settings.set(got);
    } catch (e) { Toast.show(this.why(e), { tone: 'danger' }); }
  }

  async toggleRun(r: Run) {
    if (this.openRun() === r.id) { this.openRun.set(null); return; }
    this.openRun.set(r.id);
    if (r.has_output && !this.outputs()[r.id]) {
      try {
        const full = await this.get<Run>(`${API}/runs/${encodeURIComponent(r.id)}`);
        this.outputs.update(o => ({ ...o, [r.id]: full.output || '' }));
      } catch (e) { this.outputs.update(o => ({ ...o, [r.id]: this.why(e) })); }
    }
  }

  // ---- what the list and the form offer -----------------------------------------
  kindOf(id: string): Kind | null { return this.types()?.types.find(k => k.id === id) ?? null; }
  kindLabel(id: string): string { return this.kindOf(id)?.label ?? id; }
  enumOpts(p: Param): SelectOption[] { LANG(); return p.choices.map(c => ({ value: c, label: t(ENUM_WORDS[c] ?? c) })); }
  zoneOpts = computed<SelectOption[]>(() => {
    const cur = this.draft()?.tz;
    const all = cur && !ZONES.includes(cur) ? [cur, ...ZONES] : ZONES;
    return all.map(z => ({ value: z, label: z }));
  });
  monthDays = computed<SelectOption[]>(() => {
    LANG();
    return [...Array.from({ length: 31 }, (_, i) => ({ value: '' + (i + 1), label: '' + (i + 1) })), { value: '-1', label: t('Last day') }];
  });
  everyOpts = computed<SelectOption[]>(() => { LANG(); return [1, 2, 3, 4, 6, 8, 12, 24].map(n => ({ value: '' + n, label: n === 1 ? t('hour') : `${n} ${t('hours')}` })); });

  itemOpts(p: Param): SelectOption[] {
    const have = new Set(this.listOf(p.name));
    if (p.of === 'tool') return (this.types()?.tools ?? []).filter(x => !have.has(x.name)).map(x => ({ value: x.name, label: x.label, note: x.name }));
    return (this.items()[p.of] ?? []).filter(o => !have.has(o.value));
  }
  itemLabel(p: Param, v: string): string {
    if (p.of === 'tool') return this.types()?.tools.find(x => x.name === v)?.label ?? v;
    return v;
  }
  async loadItems(of: string) {
    if (of === 'tool' || this.items()[of]) return;
    try {
      if (of === 'model') {
        interface Folder { folders: Folder[]; models: { id: string; title?: string }[] }
        const tree = await this.get<Folder>('/api/catalog');
        const out: SelectOption[] = [];
        const walk = (f: Folder) => { for (const m of f.models ?? []) out.push({ value: m.id, label: m.id, note: m.title }); (f.folders ?? []).forEach(walk); };
        walk(tree);
        this.items.update(x => ({ ...x, model: out }));
      } else if (of === 'board') {
        const bs = await this.get<{ _id: string; title?: string }[]>('/api/boards');
        this.items.update(x => ({ ...x, board: bs.map(b => ({ value: b._id, label: b._id, note: b.title })) }));
      }
    } catch { /* the list stays empty */ }
  }

  mayChange(x: Task): boolean {
    const me = this.auth.state()?.user?.id;
    return this.canMake() && (!me || x.owner?.id === me || this.auth.admin() || this.auth.state()?.mode !== 'on');
  }
  failing(x: Task): boolean { return !!x.last && ['failed', 'interrupted'].includes(x.last.status) || x.fails > 0; }
  count(f: string): number {
    const ts = this.tasks() ?? [];
    return f === 'all' ? ts.length : f === 'on' ? ts.filter(x => x.enabled).length : f === 'paused' ? ts.filter(x => !x.enabled).length
      : ts.filter(x => this.failing(x)).length;
  }

  // ---- words -----------------------------------------------------------------------
  /** The schedule in words, in the page's language: "Every Monday 09:00". */
  words(s: Schedule): string {
    LANG();
    switch (s.kind) {
      case 'daily': return `${t('Every day')} ${s.at}`;
      case 'weekdays': return `${t('Weekdays')} ${s.at}`;
      case 'weekly': {
        const d = [...(s.days ?? [])].sort();
        if (d.length === 1) return t('Every {d}').replace('{d}', t(DAY_NAMES[d[0] - 1])) + ` ${s.at}`;
        if (d.join() === '6,7') return `${t('Weekends')} ${s.at}`;
        return d.map(n => t(DAYS[n - 1])).join(', ') + ` ${s.at}`;
      }
      case 'monthly': return (s.day === -1 ? t('Monthly on the last day') : t('Monthly on day {n}').replace('{n}', '' + s.day)) + ` ${s.at}`;
      case 'hours': return (s.every === 1 ? t('Every hour at :{m}') : t('Every {n} hours at :{m}').replace('{n}', '' + s.every))
        .replace('{m}', String(s.minute ?? 0).padStart(2, '0'));
      default: return `cron ${s.cron ?? ''}`;
    }
  }
  dayShort(n: number) { return DAYS[(n - 1 + 7) % 7]; }
  dayName(n: number) { return DAY_NAMES[(n - 1 + 7) % 7]; }
  statusWord(s: string): string { return STATUS_WORDS[s] ?? s; }
  tone(s: string): string { return STATUS_TONE[s] ?? 'dim'; }
  trigger(r: Run): string {
    LANG();
    return r.trigger === 'manual' ? t('by hand') : r.trigger === 'retry' ? t('retry {n}').replace('{n}', '' + (r.attempt - 1)) : t('schedule');
  }
  meta(r: Run): string {
    LANG();
    const bits = [this.exact(r.started_at || r.at)];
    if (r.ms != null) bits.push(this.took(r.ms));
    const sent = Object.entries(r.delivered ?? {}).filter(([k, v]) => v && !k.endsWith('_error')).map(([k]) => k === 'inapp' ? t('in the app') : k === 'file' ? t('a file') : 'Telegram');
    if (sent.length) bits.push(t('sent to') + ' ' + sent.join(', '));
    if (r.cost_usd != null) bits.push(money(r.cost_usd));
    return bits.join(' · ');
  }
  took(ms?: number | null): string {
    if (ms == null) return '–';
    return ms < 1000 ? `${ms} ms` : ms < 60000 ? `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s` : `${Math.round(ms / 60000)} min`;
  }
  short(iso: string | null | undefined, tz?: string): string {
    if (!iso) return '–';
    const loc = LANG() === 'tr' ? 'tr-TR' : 'en-GB';
    try {
      return new Date(iso).toLocaleString(loc, { timeZone: tz || undefined, weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    } catch { return iso; }
  }
  exact(iso: string | null | undefined): string { return iso ? new Date(iso).toLocaleString(LANG() === 'tr' ? 'tr-TR' : 'en-GB') : ''; }
  inn(iso: string | null | undefined): string {
    if (!iso) return '–';
    LANG();
    const s = (Date.parse(iso) - Date.now()) / 1000;
    if (s < 0) return t('due');
    if (s < 3600) return t('in {n} min').replace('{n}', '' + Math.max(1, Math.round(s / 60)));
    if (s < 86400 * 2) return t('in {n} h').replace('{n}', '' + Math.round(s / 3600));
    return t('in {n} days').replace('{n}', '' + Math.round(s / 86400));
  }
  ago(iso: string | null | undefined): string {
    if (!iso) return '';
    LANG();
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 90) return t('just now');
    if (s < 3600) return t('{n} min ago').replace('{n}', '' + Math.round(s / 60));
    if (s < 86400 * 2) return t('{n} h ago').replace('{n}', '' + Math.round(s / 3600));
    return t('{n} days ago').replace('{n}', '' + Math.round(s / 86400));
  }

  private why(e: unknown): string {
    if (e instanceof HttpErrorResponse) {
      const d = e.error?.detail;
      return typeof d === 'string' ? d : d?.detail ?? e.message;
    }
    return String(e);
  }
}

/** Leaving a task with changes not saved. */
function confirmLeave(): boolean {
  // A plain question would be the browser's own box: the changes are simply kept
  // on screen instead - the first click is ignored and says so.
  Toast.show(t('Save or revert the changes first.'), { tone: 'warn' });
  return false;
}

const STATUS_WORDS: Record<string, string> = {
  done: 'done', failed: 'failed', interrupted: 'interrupted', missed: 'missed', skipped: 'skipped', cancelled: 'cancelled',
  queued: 'waiting', starting: 'starting', running: 'running',
};
/** The words of an input's choices. */
const ENUM_WORDS: Record<string, string> = { low: 'Low and out only', all: 'All lines' };
