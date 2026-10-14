import { HttpClient } from '@angular/common/http';
import { Component, DestroyRef, computed, inject, input, output, signal } from '@angular/core';
import { MiniStack, StackCol, TimeChart, TimeData } from './charts';
import { LANG, T, t } from '../i18n';
import type { CcTool, ToolLevel } from './commandcode';
import { WORKSPACES } from '../workspaces';
import { CountUp } from '../count';
import { Skeleton } from '../skeleton';
import { onUsagePing } from '../cc-usage';

/** Tabs with no tool package: Settings, Analytics. */
const NO_PACKAGE = new Set(['settings', 'analyze', 'notifications']);

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

const CALC = 'M6 3h12v18H6z M9 6h6v3H9z M8.5 13h1 M11.5 13h1 M14.5 13h1 M8.5 17h1 M11.5 17h1 M14.5 17h1';
const BOARD = 'M5 5h14v14H5z M9 9h6v6H9z M9 2v3 M15 2v3 M9 19v3 M15 19v3 M2 9h3 M2 15h3 M19 9h3 M19 15h3';
const CUBE = 'M12 3l8 4.5v9L12 21l-8-4.5v-9z M12 12l8-4.5 M12 12v9 M12 12L4 7.5';
const TAG = 'M3 11V4h7l10 10-7 7z M7 7h1v1H7z';
const BUILD = 'M4 5h16v14H4z M7 9l3 3-3 3 M12 15h5';
const FILE = 'M6 3h8l4 4v14H6z M14 3v4h4';
const NOTE = 'M5 4h14v12l-4 4H5z M15 20v-4h4 M8 9h8 M8 12h5';
const FACTORY = 'M3 20V10l5 3V10l5 3V6h3l1 4h1l1-6h2v16z M7 16h2 M12 16h2 M17 16h1';
const SWATCH = 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z';
const QUEUE = 'M4 6h16 M4 12h16 M4 18h10 M17 16l3 2-3 2z';
const PEN = 'M4 20h4L19 9l-4-4L4 16z M13 7l4 4';
const CHECK = 'M5 4h14v16H5z M8 12l3 3 5-6';
const CHAT = 'M4 5h16v11H9l-5 4z M8 9h8 M8 12h5';
const BOX = 'M3 5h18v4H3z M5 9v10h14V9 M10 13h4';
const SHELF = 'M3 8l9-5 9 5v12H3z M3 8h18 M7 20v-7h10v7 M7 16.5h10';
const PLUSMINUS = 'M5 8h6 M8 5v6 M13 16h6 M17 4L7 20';
const PDFDOC = 'M6 3h8l4 4v14H6z M14 3v4h4 M9 12h6 M9 15h6 M9 18h3';
const CLOCK = 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M12 7v5l3.5 2';
const CHART = 'M4 20h16 M7 16v-5 M11 16V7 M15 16v-7 M19 16V4';
const CLIP = 'M15.5 6.5l-7 7a2 2 0 0 0 2.8 2.8l7.5-7.5a4 4 0 0 0-5.7-5.7L5.6 10.6a6 6 0 0 0 8.5 8.5L20 13.2';
const GLOBE = 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M3 12h18 M12 3c-3 3-3 15 0 18 M12 3c3 3 3 15 0 18';
const CART = 'M3 4h2l2.4 11h11L21 7H6.2 M9 18.5a1.2 1.2 0 1 0 0 2.4a1.2 1.2 0 1 0 0-2.4z M17 18.5a1.2 1.2 0 1 0 0 2.4a1.2 1.2 0 1 0 0-2.4z';
const CAMERA = 'M4 8h4l2-3h4l2 3h4v11H4z M12 10a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7z';

/** A tool's icon, here and on its steps in an answer: by what it touches. */
export const TOOL_ICON: Record<string, string> = {
  drawer_search: DRAWER, drawer_list: DRAWER, drawer_add: DRAWER, lcsc_search: SEARCH, datasheet_get: SHEET, datasheet_read: SHEET, datasheet_search: SHEET,
  basic_tool: CALC, board_read: BOARD, model_read: CUBE, taste_read: SWATCH, manufacturer_search: FACTORY, bom_cost: TAG, firmware_build: BUILD, file_read: FILE,
  pdf_make: PDFDOC,
  room_note: NOTE, queue_list: QUEUE, queue_read: QUEUE, rename_chat: PEN,
  notes_search: SEARCH, note_read: NOTE, note_write: PEN, note_todo: CHECK, note_edit: PEN,
  chat_list: SEARCH, chat_read: CHAT, chat_archive: BOX,
  inventory_search: SEARCH, inventory_read: SHELF, inventory_add: SHELF, inventory_adjust: PLUSMINUS, inventory_edit: PEN,
  inventory_remove: BOX,
  catalog_read_page: FACTORY, catalog_add_product: FACTORY, catalog_edit_product: PEN, catalog_remove_product: BOX,
  catalog_add_maker: FACTORY,
  product_find: SEARCH, product_files_read: FILE, product_file_attach: CLIP, product_file_detach: BOX, product_set_main: PEN,
  product_to_model: CUBE, product_files_missing: SEARCH, product_to_my_items: SHELF,
  build_count: CALC, shopping_list: CART, stock_consume: PLUSMINUS, model_render: CAMERA,
  clock: CLOCK, web_search: SEARCH, web_read: GLOBE,
  wiki_search: SEARCH, wiki_read: NOTE, wiki_write: PEN,
  analytics_read: CHART, memory_read: NOTE, memory_write: PEN,
  price_history: CHART, stock_low: SHELF, files_search: SEARCH, files_restore: FILE, taste_propose: SWATCH,
  manufacturer_explore: FACTORY, dm_read: CHAT, dm_send: CHAT, settings_read: WRENCH,
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
  status: string; ms?: number | null; by: string; trashed?: boolean }
interface ToolPage extends CcTool {
  model_text: string; running: string; failed: string;
  params: { name: string; type: string; about: string; required: boolean }[];
  stats: { uses: number; week: number; mine: number; chats: number; outcomes: Record<string, number>;
    ms: { median: number | null; p90: number | null }; last: string | null;
    days: { day: string; n: number; bad: number }[]; people: { name: string; n: number }[]; recent: ToolUse[] };
}

/** Every tool's uses (GET /api/cc/tools-usage), for the top of the list. */
interface ToolsUsage {
  tools: Record<string, { uses: number; done: number; week: number; week_done?: number }>; mine: number;
  days: { day: string; by: Record<string, number> }[];
  /** The period these buckets are (day, week, month, year): the axis says it, not the choice still loading. */
  span?: string;
}

/** The Chat tab's tools, where a conversation is shown (rooms/commandcode.ts),
 *  in Settings' own frame (settings.css): the slim head band, then one card
 *  per level with its tools as tiles - icon, name, the app's switch
 *  (.tcv-switch), what it does, its id and how often it was used. A tile
 *  opens the tool's page; its switch turns it on or off. */
/** The chart palette, written out so every token is named in full. */
const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)',
  'var(--series-5)', 'var(--series-6)', 'var(--series-7)', 'var(--series-8)'];

@Component({
  selector: 'app-cc-tools',
  imports: [Skeleton, CountUp, T],
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
        <div class="st-tile hero"><span>{{ 'Uses' | t }}</span><b [wbCount]="st.uses"></b>
          <small>{{ st.chats }} {{ 'conversations' | t }} · {{ st.mine }} {{ 'by you' | t }}</small></div>
        <div class="st-tile"><span>{{ 'Last 7 days' | t }}</span><b [wbCount]="st.week"></b></div>
        <div class="st-tile" [attr.data-tone]="okRate(p) == null ? 'dim' : okRate(p)! < 90 ? 'warn' : 'ok'">
          <span>{{ 'Worked' | t }}</span><b [wbCount]="okRate(p) == null ? '–' : okRate(p) + '%'"></b>
          <small>{{ fails(p) }} {{ 'failed or refused' | t }}</small></div>
        <div class="st-tile" [attr.data-tone]="st.ms.median == null ? 'dim' : null"><span>{{ 'Median time' | t }}</span>
          <b [wbCount]="dur(st.ms.median)"></b><small>p90 {{ dur(st.ms.p90) }}</small></div>
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
                  [style.background]="series[i % 8]"></i></span>
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
              <li><button type="button" class="ct-use" [disabled]="u.trashed" (click)="!u.trashed && openChat.emit(u.chat)"
                          [title]="(u.trashed ? 'In the Trash - restore it from the Chat list to open it' : '') | t">
                <span class="ct-use-when mono">{{ ago(u.at) }}</span>
                <span class="ct-use-say">{{ say(u) }}</span>
                <span class="ct-use-chat">{{ u.title || ('Untitled' | t) }} · {{ u.by }}@if (u.trashed) { · {{ 'in the Trash' | t }} }</span>
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
      <div class="st-tiles six wb-in">
        <div class="st-tile"><span>{{ 'On for you' | t }}</span><b>{{ on() }} / {{ tools().length }}</b></div>
        <div class="st-tile"><span>{{ 'Uses' | t }}</span><b [wbCount]="total(u)"></b><small>{{ u.mine }} {{ 'by you' | t }}</small></div>
        <div class="st-tile"><span>{{ 'Last 7 days' | t }}</span><b [wbCount]="week(u)"></b></div>
        <div class="st-tile" [attr.data-tone]="worked(u) == null ? 'dim' : worked(u)! < 90 ? 'warn' : 'ok'">
          <span>{{ 'Worked' | t }}</span><b [wbCount]="worked(u) == null ? '–' : worked(u) + '%'"></b></div>
      </div>
      <div class="ct-cols ct-over">
        <section class="st-card">
          <div class="st-card-head"><h3>{{ 'Uses by package' | t }}</h3>
            <span class="st-sub mono">{{ sum14(u) }}</span>
            <div class="st-right"><div class="st-seg" role="group" [attr.aria-label]="'Period' | t">
              @for (sp of spans; track sp.id) {
                <button type="button" [class.on]="period() === sp.id" [attr.aria-pressed]="period() === sp.id" (click)="setSpan(sp.id)">{{ sp.label | t }}</button>
              }
            </div></div></div>
          <div class="st-card-body ct-uses" [class.ct-loading]="usageLoading()">
            @if (usageLoading()) { <div class="ct-loader" role="status" [attr.aria-label]="'Loading' | t"><span class="ct-spin" aria-hidden="true"></span></div> }
            <div class="ct-bars tall">
              @for (d of u.days; track d.day; let i = $index) {
                <span class="ct-bar" [title]="when(d.day) + ' · ' + dayTotal(d)" [style.--tcv-i]="i">
                  <span class="ct-stack" [style.height.%]="dayTotal(d) ? 6 + 94 * dayTotal(d) / peak14(u) : 0">
                    @for (s of stack(u, d); track s.name) {
                      @if (s.n) { <i [style.flex-grow]="s.n" [style.background]="s.color"></i> }
                    }
                  </span></span>
              }
            </div>
            <div class="ct-bars-axis mono"><span>{{ when(u.days[0].day) }}</span><span>{{ when(u.days[mid(u)].day) }}</span><span>{{ (u.span === 'day' ? 'now' : u.span === 'year' ? 'this month' : 'today') | t }}</span></div>
            <!-- By package, not by tool: forty colours read as none. A package's tools are in its tooltip. -->
            <div class="ct-legend">
              @for (s of top14(u); track s.name) {
                <span [title]="s.names"><i [style.background]="s.color"></i>{{ s.label | t }} <b class="mono">{{ s.n }}</b></span>
              }
            </div>
          </div>
        </section>
        <section class="st-card">
          <div class="st-card-head"><h3>{{ 'By package' | t }}</h3></div>
          <!-- The chart's packages in its colours, over its period; a package opens to its tools. -->
          <div class="st-card-body ct-by" [class.ct-loading]="usageLoading()">
            @for (g of byPkg(u); track g.id) {
              <button type="button" class="ct-pk" [class.dim]="!g.n" [attr.aria-expanded]="opened().has(g.id)" (click)="togglePkg(g.id)">
                <svg class="ct-pk-chev" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="chevron" /></svg>
                <i [style.background]="g.color"></i><span>{{ g.label | t }}</span>
                <span class="st-meter"><i [style.width.%]="100 * g.n / g.peak" [style.background]="g.color"></i></span>
                <b class="mono" [wbCount]="g.n"></b><small class="mono">{{ g.share }}</small></button>
              @if (opened().has(g.id)) {
                @for (tl of g.tools; track tl.name) {
                  <button type="button" class="ct-pk ct-pk-tool ct-who-btn" [class.dim]="!tl.n" (click)="show(tl.name)">
                    <span>{{ tl.label | t }}</span>
                    <span class="st-meter"><i [style.width.%]="100 * tl.n / g.peak" [style.background]="g.color"></i></span>
                    <b class="mono">{{ tl.n }}</b><small class="mono">{{ tl.share }}</small></button>
                }
              }
            } @empty { <div class="ct-empty">{{ 'No tool uses in this period' | t }}</div> }
          </div>
        </section>
      </div>
    } @else if (usageLoading()) {
      <div class="wb-sk-stack"><wb-skel kind="tiles" [count]="3" [min]="92" />
        <div class="ct-cols ct-over"><section class="st-card"><div class="st-card-body"><wb-skel kind="chart" [h]="190" /></div></section>
          <section class="st-card"><div class="st-card-body"><wb-skel kind="rows" [count]="7" [h]="24" /></div></section></div></div>
    }
    @if (!ready()) {
      <section class="st-card"><div class="st-card-head"><h3>{{ 'Tools' | t }}</h3></div>
        <div class="st-card-body"><wb-skel kind="tiles" [count]="8" [min]="240" /></div></section>
    } @else {
      <!-- The packages, one tile each: the drawer's tools, a room's... Its switch
           turns all of them on or off; a click opens them, each with its own. -->
      <section class="st-card">
        <div class="st-card-head"><h3>{{ 'Tools' | t }}</h3>
          <span class="st-sub">{{ 'in packages: open one to switch its tools one by one' | t }}</span>
          <span class="st-right st-sub mono">{{ groups().length }} {{ 'packages' | t }}</span></div>
        <div class="ct-tiles">
          @for (g of groups(); track g.id; let i = $index) {
            <div class="ct-tile ct-pack" [attr.data-on]="g.on ? 1 : null" role="button" tabindex="0"
                 [style.--sw]="span(i, groups().length, 4)" [style.--sn]="span(i, groups().length, 2)"
                 [attr.data-empty]="g.tools.length ? null : 1"
                 (click)="g.tools.length && openPack(g.id)" (keydown.enter)="g.tools.length && openPack(g.id)"
                 [title]="(g.tools.length ? 'Open the package' : 'No tools yet') | t">
              <span class="ct-top">
                <svg class="ct-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="g.tools.length ? icon(g.tools[0].name) : wrench" /></svg>
                <span class="ct-name">{{ g.name | t }}</span>
                @if (g.tools.length) {
                <button class="tcv-switch" type="button" role="switch" [attr.aria-checked]="g.on === g.tools.length"
                        [attr.data-on]="g.on ? 1 : null" [attr.data-part]="g.on && g.on < g.tools.length ? 1 : null"
                        [disabled]="!canEdit()" [attr.aria-label]="g.name | t"
                        (click)="$event.stopPropagation(); setAll(g.tools, g.on < g.tools.length)"></button>
                }
              </span>
              <span class="ct-about">{{ g.about | t }}</span>
              <span class="ct-foot-row">
                @if (g.tools.length) {
                  <span class="ct-uses-n mono">{{ g.on }} / {{ g.tools.length }} {{ 'on' | t }} · {{ g.uses }} {{ (g.uses === 1 ? 'use' : 'uses') | t }}</span>
                  <svg class="ct-go" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 7l5 5-5 5" /></svg>
                } @else { <span class="ct-uses-n">{{ 'No tools yet' | t }}</span> }
              </span>
            </div>
          }
        </div>
      </section>
      @if (packOpen(); as g) {
        <div class="ct-scrim" animate.leave="tcv-leave" (click)="pack.set(null)"></div>
        <section class="st-card ct-modal" animate.leave="tcv-leave" role="dialog" aria-modal="true" [attr.aria-label]="g.name | t" (keydown.escape)="pack.set(null)">
          <div class="st-card-head">
            <svg class="ct-head-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="icon(g.tools[0].name)" /></svg>
            <h3>{{ g.name | t }}</h3>
            <span class="st-sub">{{ g.about | t }}</span>
            <span class="st-right">
              <span class="st-sub mono">{{ g.on }} / {{ g.tools.length }}</span>
              <span class="st-seg">
                <button type="button" [class.on]="g.on === g.tools.length" [disabled]="!canEdit()"
                        (click)="setAll(g.tools, true)">{{ 'all on' | t }}</button>
                <button type="button" [class.on]="g.on === 0" [disabled]="!canEdit()"
                        (click)="setAll(g.tools, false)">{{ 'all off' | t }}</button>
              </span>
              <button class="ct-ib" type="button" (click)="pack.set(null)" [title]="('Close' | t) + ' (Esc)'">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12 M18 6L6 18" /></svg></button>
            </span>
          </div>
          <div class="ct-msearch">
            <input class="tcv-field" type="search" [value]="packQ()" (input)="packQ.set($any($event.target).value)"
                   [placeholder]="'Search the tools in this package' | t" autocomplete="off" spellcheck="false">
            <span class="st-sub mono">{{ packTools().length }} / {{ g.tools.length }}</span>
          </div>
          <div class="ct-tiles">
            @for (tl of packTools(); track tl.name; let i = $index) {
              <div class="ct-tile" [attr.data-on]="tl.on ? 1 : null" role="button" tabindex="0"
                   [style.--sw]="span(i, packTools().length, 3)" [style.--sn]="span(i, packTools().length, 2)"
                   (click)="pack.set(null); show(tl.name)" (keydown.enter)="pack.set(null); show(tl.name)" [title]="'Open its page' | t">
                <span class="ct-top">
                  <svg class="ct-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="icon(tl.name)" /></svg>
                  <span class="ct-name">{{ tl.label | t }}</span>
                  <span class="st-badge" [attr.data-tone]="behaves(tl.level).tone">{{ levelName(tl.level) | t }}</span>
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
            } @empty { <div class="ct-empty">{{ 'No tool here matches.' | t }}</div> }
          </div>
        </section>
      }
    }
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
  /** The tools in their packages (the drawer's, a room's...), in the server's
   *  order: one card each, a switch for the whole package and one per tool,
   *  so reading can stay on while writing is off. */
  groups = computed(() => {
    // General first, then a package for every tab of the top bar in its order
    // (workspaces.ts) - a new tab has its card here at once, empty until a
    // tool names it as its package. Chat itself, Settings and Analytics have none.
    const tabs = [{ id: 'general', name: 'General', about: 'What belongs to no one tab: notes left in a room\'s queue.' },
                  ...WORKSPACES.filter(w => !NO_PACKAGE.has(w.id)).map(w => ({ id: w.id as string, name: w.label, about: w.blurb }))];
    const known = new Set(tabs.map(x => x.id));
    const extra = [...new Set(this.tools().map(x => x.package || 'other'))].filter(id => !known.has(id))
      .map(id => ({ id, name: this.tools().find(x => x.package === id)?.package_label || id, about: '' }));
    return [...tabs, ...extra].map(p => {
      const tools = this.tools().filter(x => (x.package || 'other') === p.id);
      const about = tools[0]?.package_about || p.about;
      return { ...p, about, tools, on: tools.filter(x => x.on).length, uses: tools.reduce((n, x) => n + (x.uses ?? 0), 0) };
    });
  });
  /** The package open in the modal. */
  pack = signal<string | null>(null);
  packOpen = computed(() => this.groups().find(g => g.id === this.pack()) ?? null);
  /** The package modal's search: words of a tool's name, id or line. */
  packQ = signal('');
  packTools = computed(() => {
    const g = this.packOpen(), words = this.packQ().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!g) return [];
    return words.length ? g.tools.filter(x => {
      const hay = `${t(x.label)} ${x.label} ${x.name} ${t(x.description)} ${x.description}`.toLocaleLowerCase();
      return words.every(w => hay.includes(w));
    }) : g.tools;
  });
  openPack(id: string) { this.packQ.set(''); this.pack.set(id); }
  levelName(l: ToolLevel) { return LEVELS.find(x => x.id === l)?.name ?? l; }
  flip(tl: CcTool) { this.set.emit({ [tl.name]: !tl.on }); }
  setAll(tools: CcTool[], on: boolean) {
    const change = tools.filter(x => x.on !== on);
    if (change.length) this.set.emit(Object.fromEntries(change.map(x => [x.name, on])));
  }

  usage = signal<ToolsUsage | null>(null);
  /** The uses chart's period: a day by hour, a week or a month by day, a year by month - kept in this browser. */
  readonly chevron = CHEVRON;
  readonly spans = [{ id: 'day', label: 'Day' }, { id: 'week', label: 'Week' }, { id: 'month', label: 'Month' }, { id: 'year', label: 'Year' }];
  period = signal<string>((() => { try { return localStorage.getItem('redline.tools.span') || 'week'; } catch { return 'week'; } })());
  setSpan(s: string) {
    this.period.set(s);
    try { localStorage.setItem('redline.tools.span', s); } catch { /* private window */ }
    this.loadUsage();
  }
  /** While another period loads: the old chart faded under a "Loading…"; the new one rises in. */
  usageLoading = signal(false);
  private loadUsage() {
    this.usageLoading.set(true);
    this.http.get<ToolsUsage>('/api/cc/tools-usage', { params: { span: this.period() } }).subscribe({
      next: u => { this.usage.set(u); this.usageLoading.set(false); },
      error: () => this.usageLoading.set(false),
    });
  }
  mid(u: ToolsUsage) { return Math.floor(u.days.length / 2); }
  /** A bucket's key as the axis says it: "14:00", "12 Oct", "Oct 2026". */
  when(k: string) {
    const lang = LANG() === 'tr' ? 'tr-TR' : 'en-GB';
    if (k.length === 13) return k.slice(11) + ':00';
    if (k.length === 7) return new Date(k + '-01T12:00:00').toLocaleDateString(lang, { month: 'short', year: 'numeric' });
    return new Date(k + 'T12:00:00').toLocaleDateString(lang, { day: 'numeric', month: 'short' });
  }
  constructor() { this.loadUsage(); }
  /** A tool's colour in the charts (its page and the top of the list): the series palette, in the list's order. */
  readonly series = SERIES;
  color(name: string) {
    const i = this.tools().findIndex(x => x.name === name);
    return SERIES[i < 0 ? 7 : i % 8];
  }
  total(u: ToolsUsage) { return Object.values(u.tools).reduce((a, x) => a + x.uses, 0); }
  week(u: ToolsUsage) { return Object.values(u.tools).reduce((a, x) => a + x.week, 0); }
  worked(u: ToolsUsage) {
    const n = this.total(u);
    return n ? Math.round(100 * Object.values(u.tools).reduce((a, x) => a + x.done, 0) / n) : null;
  }
  /** The uses chart by package (General, PCB, Notes...), not by tool: a
   *  dozen colours at most, each with its count over the fourteen days. */
  private pkgOf(name: string) { const t = this.tools().find(x => x.name === name); return t?.package || 'other'; }
  top14(u: ToolsUsage): { name: string; label: string; n: number; color: string; names: string }[] {
    const sum: Record<string, number> = {}, who: Record<string, Set<string>> = {};
    for (const d of u.days) for (const [k, n] of Object.entries(d.by)) {
      if (!n) continue;
      const p = this.pkgOf(k);
      sum[p] = (sum[p] ?? 0) + n;
      (who[p] ??= new Set()).add(this.tools().find(x => x.name === k)?.label ?? k);
    }
    const label = (p: string) => this.groups().find(g => g.id === p)?.name ?? this.tools().find(x => x.package === p)?.package_label ?? p;
    return Object.entries(sum).sort((a, b) => b[1] - a[1])
      .map(([name, n]) => ({ name, n, color: this.pkgColor(name), label: label(name), names: [...who[name]].map(x => t(x)).join(', ') }));
  }
  /** A package's colour, the same in every period: by its place among the packages. */
  pkgColor(p: string) { return pkgColorAt(this.groups().findIndex(g => g.id === p)); }
  stack(u: ToolsUsage, d: { by: Record<string, number> }) {
    const by: Record<string, number> = {};
    for (const [k, n] of Object.entries(d.by)) by[this.pkgOf(k)] = (by[this.pkgOf(k)] ?? 0) + n;
    return this.top14(u).map(x => ({ name: x.name, n: by[x.name] ?? 0, color: x.color }));
  }
  dayTotal(d: { by: Record<string, number> }) { return Object.values(d.by).reduce((a, x) => a + x, 0); }
  sum14(u: ToolsUsage) { return u.days.reduce((a, d) => a + this.dayTotal(d), 0); }
  peak14(u: ToolsUsage) { return Math.max(1, ...u.days.map(d => this.dayTotal(d))); }
  /** The list beside the chart: its packages over its period, most used
   *  first, then the ones with a tool on but no use; each with its share and
   *  its tools (those on or used in the period), most used first. */
  byPkg(u: ToolsUsage) {
    const by: Record<string, number> = {};
    for (const d of u.days) for (const [k, n] of Object.entries(d.by)) by[k] = (by[k] ?? 0) + n;
    const all = this.sum14(u), pct = (n: number) => all ? (n && n < all / 200 ? '<1' : Math.round(100 * n / all)) + '%' : '';
    const rows = this.groups().map(g => {
      const tools = g.tools.filter(x => x.on || by[x.name]).map(x => ({ name: x.name, label: x.label, n: by[x.name] ?? 0 }))
        .sort((a, b) => b.n - a.n).map(x => ({ ...x, share: pct(x.n) }));
      const n = tools.reduce((a, x) => a + x.n, 0);
      return { id: g.id, label: g.name, color: this.pkgColor(g.id), n, share: pct(n), tools, peak: 1 };
    }).filter(g => g.tools.length).sort((a, b) => b.n - a.n);
    const peak = Math.max(1, ...rows.map(g => g.n));
    return rows.map(g => ({ ...g, peak }));
  }
  /** The packages opened in that list: none at first, kept while the period changes. */
  opened = signal<Set<string>>(new Set());
  togglePkg(id: string) {
    const s = new Set(this.opened());
    if (!s.delete(id)) s.add(id);
    this.opened.set(s);
  }

  /** A tile's width in a 12-column grid: up to `most` to a row, and the
   *  last row's tiles share the whole row - never an empty cell. */
  span(i: number, n: number, most: number) {
    const cols = Math.min(n, most), rest = n % cols;
    return 12 / (rest && i >= n - rest ? rest : cols);
  }

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

/** The packages in the Tools panel's order: General, a tab's own in the top
 *  bar's order, then any other a tool names (CcTools.groups). */
function pkgOrder(tools: CcTool[]): string[] {
  const tabs = ['general', ...WORKSPACES.filter(w => !NO_PACKAGE.has(w.id)).map(w => w.id as string)];
  return [...tabs, ...[...new Set(tools.map(x => x.package || 'other'))].filter(id => !tabs.includes(id))];
}
/** A package's colour by its place among them, the same in every chart. */
function pkgColorAt(i: number) {
  // Eight series colours; past them, the same eight paler, so no two packages share one.
  return i < 0 ? 'var(--ink-dim)' : i < 8 ? SERIES[i] : `color-mix(in srgb, ${SERIES[(i * 3 + 1) % 8]} 45%, var(--ink))`;
}

/** The last part of the usage card in the conversation list: how many tools
 *  are on, how they were used today and this week, how often they worked,
 *  the week's most used one, and the week by day (GET /api/cc/tools-usage).
 *  Opens the tools above in the conversation's place. The card draws the frame. */
@Component({
  selector: 'app-cc-tools-line',
  imports: [CountUp, MiniStack, Skeleton, T],
  styles: [`
    :host { display: block; flex: none; }
    :host { height: 100%; min-width: 0; }
    .ctl { display: flex; flex-direction: column; gap: 4px; width: 100%; height: 100%; min-width: 0; padding: 7px 8px 8px; text-align: left;
      font: inherit; font-size: 11px; color: var(--ink-dim); border: 0; border-radius: 0; background: none; cursor: pointer; }
    .ctl:hover, .ctl:focus-visible { background: var(--hover); outline: none; }
    /* Open or not, the card looks the same: no colour or edge mark for the open one (the panel itself says it). */
    .ctl-head { display: flex; align-items: center; gap: 5px; width: 100%; min-width: 0; }
    .ctl b { color: var(--ink); font-weight: 600; }
    .ctl-head em { margin-left: auto; font: normal 10.5px 'IBM Plex Mono', ui-monospace, monospace; white-space: nowrap; }
    svg { flex: none; width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.7;
      stroke-linecap: round; stroke-linejoin: round; }
    .ctl-head svg:last-child { width: 12px; height: 12px; }
    /* The two figures that matter: the week's uses, large, and how many worked. */
    .ctl-fig { display: flex; align-items: baseline; gap: 4px; width: 100%; min-width: 0; font-size: 10.5px; white-space: nowrap; }
    .ctl-fig > b { font: 600 15px 'IBM Plex Mono', ui-monospace, monospace; }
    .ctl-fig > em { margin-left: auto; font: normal 10.5px 'IBM Plex Mono', ui-monospace, monospace; }
    .ctl-fig > em b { font-weight: 600; }
    .ctl-chart { width: 100%; margin-top: auto; }
    @media (max-width: 768px) { .ctl { padding: 9px 10px 10px; } }
  `],
  template: `
<button class="ctl" type="button" (click)="toggle.emit()" [attr.aria-pressed]="open()"
        [title]="'Which tools the model may use with your lines' | t">
  <div class="ctl-head">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="wrench" /></svg>
    <b>{{ 'Tools' | t }}</b>
    <em><b>{{ on() }}</b>/{{ total() }}</em>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="chevron" /></svg>
  </div>
  @if (stats(); as s) {
    <div class="ctl-fig" [title]="s.top ? ('Most used' | t) + ': ' + (s.top.label | t) + ' (' + s.top.week + '×)' : ''">
      <b [wbCount]="s.week"></b><span>{{ 'this week' | t }}</span>
      <em [title]="'Uses this week that worked' | t"><b [wbCount]="s.ok == null ? '–' : s.ok + '%'"></b></em>
    </div>
    <app-mini-stack class="ctl-chart" [data]="s.cols" [height]="34" />
  } @else if (!failed()) { <wb-skel kind="mini" /> }
</button>`,
})
export class CcToolsLine {
  on = input(0);
  total = input(0);
  open = input(false);
  /** The tools, for their names. */
  tools = input<CcTool[]>([]);
  toggle = output<void>();
  readonly wrench = WRENCH;
  readonly chevron = CHEVRON;
  private http = inject(HttpClient);
  private usage = signal<ToolsUsage | null>(null);
  /** The first reading did not come: no placeholder then, as before. */
  failed = signal(false);
  private timer = (() => { const go = () => this.load(); go(); return setInterval(go, 120_000); })();
  private live = onUsagePing(() => this.load());
  constructor() { inject(DestroyRef).onDestroy(() => clearInterval(this.timer)); }
  private load() {
    this.http.get<ToolsUsage>('/api/cc/tools-usage', { params: { span: 'week' } })
      .subscribe({ next: u => this.usage.set(u), error: () => this.failed.set(true) });
  }
  stats = computed(() => {
    const u = this.usage();
    if (!u) return null;
    const per = Object.entries(u.tools);
    const total = (d: { by: Record<string, number> }) => Object.values(d.by).reduce((a, n) => a + n, 0);
    const week = per.reduce((a, [, x]) => a + x.week, 0), worked = per.reduce((a, [, x]) => a + (x.week_done ?? 0), 0);
    const best = per.filter(([, x]) => x.week > 0).sort((a, b) => b[1].week - a[1].week)[0];
    const label = (n: string) => this.tools().find(x => x.name === n)?.label || n;
    const days = u.days;
    // Each day by package, in the Tools panel's colours.
    const order = pkgOrder(this.tools()), pkg = (n: string) => this.tools().find(x => x.name === n)?.package || 'other';
    const pkgName = (p: string) => t(WORKSPACES.find(w => w.id === p)?.label ?? this.tools().find(x => x.package === p)?.package_label ?? (p === 'general' ? 'General' : p));
    const lang = LANG() === 'tr' ? 'tr-TR' : 'en-GB';
    const cols: StackCol[] = days.map(d => {
      const by: Record<string, number> = {};
      for (const [k, n] of Object.entries(d.by)) by[pkg(k)] = (by[pkg(k)] ?? 0) + n;
      return { label: new Date(d.day + 'T12:00:00').toLocaleDateString(lang, { weekday: 'short', day: 'numeric', month: 'short' }),
               parts: order.filter(p => by[p]).map(p => ({ name: pkgName(p), n: by[p], color: pkgColorAt(order.indexOf(p)) })) };
    });
    return { today: days.length ? total(days[days.length - 1]) : 0, week, cols,
             ok: week ? Math.round(100 * worked / week) : null,
             top: best ? { label: label(best[0]), week: best[1].week } : null };
  });
}
