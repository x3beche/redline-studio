import { Component, ElementRef, Injector, afterNextRender, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { Editor } from './editor/editor';
import { Selection } from './selection';
// The rooms are each a chunk of their own, loaded when their tab is first
// opened (the @defer blocks below): only what is on screen is downloaded.
import { RoomAnalyze } from './rooms/analyze';
import { RoomPcb } from './rooms/pcb';
import { RoomFirmware } from './rooms/firmware';
import { RoomTools } from './tools/room';
import { QuickNote, RoomNotes } from './rooms/notes';
import { RoomTaste } from './rooms/taste';
import { RoomMfr } from './rooms/manufacturers';
import { RoomFiles } from './rooms/files';
import { RoomCommandCode } from './rooms/commandcode';
import { TasteRuns } from './rooms/taste-api';
import type { MfrRuns } from './rooms/manufacturers';
import { Palette } from './palette';
import { Prefs } from './preferences';
import { RoomSettings } from './settings-room';
import { T } from './i18n';
import { BudgetStatus, Money, money, moneyShort } from './money';
import { budgetTip } from './budget-bars';
import { Auth, UserChip } from './auth';
import { Landing } from './landing';
import { WORKSPACES, Workspace, currentWorkspace, rememberWorkspace } from './workspaces';
import { TopBar, TopbarFit } from './topbar';
import { TopbarMore } from './topbar-more';
import { AgentThreads } from './rooms/agent-thread';
import { CcTabUsage } from './cc-usage';
import { ConfirmHost } from './confirm';
import { Toasts } from './toast';
import { DmSend, DmStore } from './dm';
import { DmViewer } from './rooms/dm-viewer';
import { Avatar } from './avatar';
import { navHold, navHref, navParams, navPopped, navSet, navTitle } from './nav';
import { ROOM_KEYS, RoomId, roomOf } from './nav-url';

/** The sections of Settings an address may name (/settings/<section>; PrefsTab). */
const SECTIONS = ['profile', 'appearance', 'language', 'llm', 'proxy', 'costs', 'telegram', 'tokens', 'shortcuts', 'topbar',
                  'dashboard', 'admin', 'rustdesk', 'backups'];

@Component({
  selector: 'app-root',
  imports: [Editor, RoomPcb, RoomFirmware, RoomAnalyze, RoomTools, RoomNotes, RoomTaste, RoomMfr, RoomCommandCode, RoomFiles, QuickNote, Palette, RoomSettings, Landing, T, UserChip, TopbarFit, TopbarMore, CcTabUsage, ConfirmHost, Toasts, DmSend, DmViewer, Avatar],
  template: `
<!-- The shell. Each tab is a room with the same loop in it: source in the
     database, built into something you can look at, marked up, picked up,
     rebuilt, checked. The tabs marked soon are not finished.

     The tabs and the room are handed to the editor rather than wrapped
     around it: they belong over the two right-hand columns, and the
     catalog on the left keeps its full height beside them. -->
<!-- Signed in, or in local mode (sign-in off): the app. Otherwise the
     sign-in card - and nothing of the app until the server has said which. -->
@if (auth.refused(); as m) { <div class="tcv-refused" role="alert">{{ m }}</div> }
@if (auth.signedIn()) {
<app-editor>
  <header tabs topbarFit class="relative flex shrink-0 items-center gap-1">
    <!-- The tabs in the order chosen in Settings > Top bar (topbar.ts): by
         default the rooms you work in, then - pushed right by the gap -
         Notes, Chat, Files and Basic Tools, closing the middle
         column. What is hidden, or does not fit, is under More. Analytics is
         in the menu under your name (auth.ts). -->
    @for (b of bar.inBar(); track b.id) {
      @if (b.more) {
      <!-- More, where Settings > Top bar put it: drawn only when a tab is
           hidden or does not fit (topbar-more.ts). -->
      <app-topbar-more [push]="b.push" />
      } @else {
      <!-- A link, so a middle click or Ctrl+click opens the room in a tab of its own (nav.ts). -->
      <a [href]="href(b.ws.id)" (click)="tab($event, b.ws.id)" class="tcv-tab" [class.tb-push]="b.push" [class.tb-iconic]="!bar.text(b.ws)"
              [attr.data-tb]="b.id"
              [attr.data-on]="here() === b.id ? 1 : null"
              [attr.aria-current]="here() === b.id ? 'page' : null"
              [attr.aria-label]="bar.text(b.ws) ? null : (b.ws.label | t)"
              [title]="bar.text(b.ws) ? bar.title(b.ws) : (b.ws.label | t) + ' - ' + bar.title(b.ws)">
        @if (bar.showIcon()) { <svg class="tb-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="bar.icon(b.id)"/></svg> }
        {{ bar.text(b.ws) | t }}
        @if (!b.ws.ready) { <span class="tcv-tab-soon">soon</span> }
        <!-- How many tools there are, quietly, beside the name. -->
        @if (b.id === 'tools' && bar.text(b.ws)) { @if (toolCount(); as n) { <span class="tcv-tab-count">{{ n }}</span> } }
        <!-- Chat: what the rooms' agents wrote, or ask, that has not been read here. -->
        @if (b.id === 'commandcode') { @if (threads.total(); as n) {
          <span class="tcv-tab-unread" [title]="n + ' ' + ('unread in the agent threads' | t)">{{ n }}</span> } }
        <!-- And what people wrote to me (dm.ts): the senders' faces, the latest on top, and how many. -->
        @if (b.id === 'commandcode') { @if (dms.total(); as n) {
          <span class="tcv-dm-badge" data-dm-badge="1" [title]="n + ' ' + ('unread direct messages' | t) + ': ' + dms.sendersTip()">
            <span class="tcv-dm-faces">
              @for (s of dms.senders(); track s.id) {
                <app-avatar [name]="s.name" [userId]="s.id" [hasPicture]="s.has_avatar" [v]="s.avatar_v" [colour]="s.avatar_colour" [size]="18" />
              }
            </span>
            <b>{{ n }}</b>
          </span> } }
        <!-- And the Command Code account's usage, in the tab itself (cc-usage.ts;
             Settings > Top bar says how): a click on it is a click on the tab. -->
        @if (b.id === 'commandcode') { <app-cc-tab-usage /> }
        <!-- Taste: an extraction running in the server, or one that finished
             while you were elsewhere (rooms/taste.ts, TasteRuns). -->
        @if (b.id === 'taste') {
          @if (tasteRuns.running(); as n) {
            <span class="tcv-tab-run" [title]="n + ' ' + ('extraction running' | t)"><i></i>{{ n }}</span>
          } @else if (tasteRuns.unseen(); as n) {
            <span class="tcv-tab-run" data-done="1" [title]="n + ' ' + ('extraction finished' | t)"><i></i>{{ n }}</span>
          }
        }
        <!-- Manufacturers: an exploration running in the server (after a
             reload too), or one that finished elsewhere (rooms/manufacturers.ts). -->
        @if (b.id === 'mfr') {
          @if (mfrRuns.running(); as n) {
            <span class="tcv-tab-run" [title]="n + ' ' + ('exploration running' | t)"><i></i>{{ n }}</span>
          } @else if (mfrRuns.unseen(); as n) {
            <span class="tcv-tab-run" data-done="1" [title]="n + ' ' + ('exploration finished' | t)"><i></i>{{ n }}</span>
          }
        }
      </a>
      }
    }
    <!-- Settings: the theme and the language for this browser, the LLM
         keys and the proxy for the server - a tab, not a menu item. -->
    @if (settingsTab; as w) {
      <a [href]="href(w.id)" (click)="tab($event, w.id)" class="tcv-tab tcv-tab-settings tcv-tab-end" [class.tb-tight]="bar.tight()"
              [class.tb-iconic]="bar.display() === 'icon'"
              [attr.data-on]="here() === w.id ? 1 : null"
              [attr.aria-current]="here() === w.id ? 'page' : null"
              [attr.aria-label]="w.label | t"
              [title]="w.blurb">⚙@if (bar.display() !== 'icon') { <span class="tb-settings-name"> {{ w.label | t }}</span>}</a>
    }
    <!-- Who is signed in, over the right-hand column; nothing in local mode.
         Its width is measured (--layout-user-w) so the tabs keep clear of it
         when that column is folded to a rail. -->
    <!-- Analytics is the first thing in its menu, with the week in a few words. -->
    <app-user-chip #chip class="tcv-user-end" [brief]="brief()" [spend]="spend()" [inAnalytics]="here() === 'analyze'"
                   (analytics)="open('analyze')" />
  </header>

  <!-- The 3D room stays mounted whichever tab is on. Its viewer holds a
       WebGL context and tens of megabytes of geometry; unmounting it would
       throw both away and rebuild them on the way back. An unbuilt room
       covers it instead. -->
  <!-- Empty in the 3D room, and out of the layout with it: left in, an
       empty flex child took half the column. -->
  <div room class="tcv-room-slot" [class.hidden]="here() === 'cad'">
    <!-- Made again when Back or Forward lands on another place in the same room (mount). -->
    @for (k of [mount()]; track k) {
    @switch (here()) {
      @case ('pcb') { @defer { <app-room-pcb /> } }
      @case ('firmware') { @defer { <app-room-firmware /> } }
      @case ('notes') { @defer { <app-room-notes /> } }
      @case ('taste') { @defer { <app-room-taste /> } }
      @case ('mfr') { @defer { <app-room-mfr /> } }
      @case ('commandcode') { @defer { <app-room-commandcode /> } }
      @case ('files') { @defer { <app-room-files /> } }
      @case ('tools') { @defer { <app-room-tools /> } }
      @case ('settings') { @defer { <app-room-settings /> } }
      @case ('analyze') { @defer { <app-room-analyze /> } }
    }
    }
  </div>
</app-editor>
<!-- Alt+N anywhere: a note, without leaving the room. -->
<app-quick-note />
<!-- Ctrl+K anywhere: go to anything, do anything, search everything. -->
<app-palette />
<!-- "Send to...": a thing of any tab, to people in Chat (dm.ts). -->
<app-dm-send />
<!-- Loaded the first time something sent is opened: it draws every kind of thing. -->
@defer (when dms.viewing()) { <app-dm-viewer /> }
} @else if (auth.state()) {
  @defer { <app-landing /> }
}
<!-- The one question box (confirm.ts): every "Delete …?" and name-asking
     in the app awaits it, signed in or not. -->
<app-confirm />
<!-- The one toast stack (toast.ts): every "Saved.", "Could not..." and "Undo". -->
<app-toasts />`,
})
export class App {
  private picked = inject(Selection);
  /** The user chip's width, handed to the header as --layout-user-w: with
   *  the right column folded, Analytics has to stop short of the chip
   *  rather than of the rail, or the two print over each other. */
  private chip = viewChild('chip', { read: ElementRef });
  private chipWidth = effect(onCleanup => {
    const el = this.chip()?.nativeElement as HTMLElement | undefined;
    const header = el?.parentElement;
    if (!el || !header) return;
    const ro = new ResizeObserver(() =>
      header.style.setProperty('--layout-user-w', `${Math.ceil(el.getBoundingClientRect().width)}px`));
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  });
  /** Whether sign-in is on, and who is signed in (auth.ts). */
  auth = inject(Auth);
  /** The exchange rates and the costs, read from the start (money.ts). */
  private fxAndCosts = inject(Money);
  tabs = WORKSPACES;
  /** The top bar's tabs, in the order and the look chosen (topbar.ts). */
  bar = inject(TopBar);
  private injector = inject(Injector);
  /** The Taste extractions running in the server, for the tab's mark. */
  tasteRuns = inject(TasteRuns);
  /** The manufacturers' explorations, for the Parts tab's mark. They live in
   *  the Parts room's module, so they are taken once the page is up (watchRuns). */
  private mfrSvc = signal<MfrRuns | null>(null);
  mfrRuns = { running: computed(() => this.mfrSvc()?.running() ?? 0), unseen: computed(() => this.mfrSvc()?.unseen() ?? 0) };
  /** The rooms you work in, left; Notes, Chat, Files and Basic Tools at the right end. */
  rooms = WORKSPACES.filter(w => w.id !== 'analyze' && w.id !== 'tools' && w.id !== 'notes' && w.id !== 'taste' && w.id !== 'mfr' && w.id !== 'files' && w.id !== 'commandcode' && w.id !== 'settings');
  notesTab = WORKSPACES.find(w => w.id === 'notes');
  tasteTab = WORKSPACES.find(w => w.id === 'taste');
  ccTab = WORKSPACES.find(w => w.id === 'commandcode');
  filesTab = WORKSPACES.find(w => w.id === 'files');
  toolsTab = WORKSPACES.find(w => w.id === 'tools');
  settingsTab = WORKSPACES.find(w => w.id === 'settings');
  /** A few words from Analytics for its menu entry: the last seven days' LLM
   *  spend and notes, and how long ago the figures were worked out. The
   *  server keeps them cached, so asking once a minute costs nothing. */
  private briefData = signal<{ usd: number; notes: number; runs: number; mins: number | null;
                               took: number | null } | null>(null);
  /** In the display currency, so it follows a change of currency at once. */
  brief = computed(() => {
    const b = this.briefData();
    if (!b) return null;
    const ago = b.mins === null ? '' : b.mins < 1 ? ' · now' : b.mins < 60 ? ` · ${b.mins}m` : ` · ${Math.round(b.mins / 60)}h`;
    return {
      text: `${moneyShort(b.usd)} · ${b.notes} rev${ago}`,
      title: `Last 7 days: ${money(b.usd)} of LLM work, ${b.notes} revisions, ${b.runs} runs`
           + (b.took != null ? ` - worked out in ${b.took} ms` : ''),
    };
  });
  /** The month's budgets (backend/budgets.py), from the same answer. */
  private budgets = signal<BudgetStatus | null>(null);
  /** The spend chip beside your name: the month so far against the total
   *  budget (or the budget closest to its limit), in the warning colour from
   *  its threshold and the danger colour past 100%. Only with a budget set. */
  spend = computed(() => {
    const b = this.budgets();
    const items = (b?.items ?? []).filter(i => !i.error);
    if (!b || !items.length) return null;
    // The worst one: over, then near its limit; the total first among equals.
    const rank = (i: { state: string; kind: string; ratio: number | null }) =>
      (i.state === 'over' ? 2 : i.state === 'warn' ? 1 : 0) * 10 + (i.kind === 'total' ? 1 : 0) + Math.min(i.ratio ?? 0, 9) / 10;
    const one = [...items].sort((x, y) => rank(y) - rank(x))[0];
    const state = one.state;
    return {
      text: `${moneyShort(one.spent_usd)} / ${moneyShort(one.budget_usd)}`, state,
      title: `${b.month} (UTC), ${Math.max(0, Math.round(b.days_left))} days left\n` + items.map(budgetTip).join('\n'),
    };
  });
  private briefTimer?: ReturnType<typeof setInterval>;
  private readBrief = effect(() => {
    clearInterval(this.briefTimer);
    if (!this.auth.signedIn()) return;
    const read = () => fetch('/api/insights?range=7d', { credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : null)
      .then((d: { now_totals?: { llm_usd?: number; notes?: number; runs?: number }; computed_at?: string;
                  took_ms?: number; budget_status?: BudgetStatus } | null) => {
        if (d) this.budgets.set(d.budget_status ?? null);
        const t = d?.now_totals;
        if (!t) return;
        const mins = d?.computed_at ? Math.round((Date.now() - Date.parse(d.computed_at)) / 60000) : null;
        this.briefData.set({ usd: t.llm_usd ?? 0, notes: t.notes ?? 0, runs: t.runs ?? 0, mins,
                             took: d?.took_ms ?? null });
      })
      .catch(() => { /* the tab is still the tab without its figures */ });
    untracked(() => { void read(); this.briefTimer = setInterval(read, 60_000); });
  });

  /** The number of tools in the Tools tab's catalog, for its label. */
  toolCount = signal<number | null>(null);
  private countTools = effect(() => {
    if (!this.auth.signedIn()) return;
    untracked(() => fetch('/api/tools/catalog', { credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : null)
      .then((d: { tools?: unknown[] } | null) => this.toolCount.set(d?.tools?.length ?? null))
      .catch(() => { /* the tab is still the tab without its number */ }));
  });
  /** The rooms' agent threads (Chat tab): unread counts, polled while signed in. */
  threads = inject(AgentThreads);
  private pollThreads = effect(() => { if (this.auth.signedIn()) untracked(() => this.threads.start()); });
  /** Direct messages (dm.ts): only with sign-in on, as a person - the live stream and the badge. */
  dms = inject(DmStore);
  private liveDms = effect(() => {
    const st = this.auth.state();
    const person = this.auth.signedIn() && st?.mode === 'on' && st.user?.type === 'user';
    untracked(() => (person ? this.dms.start() : this.dms.stop()));
  });
  /** Shared, because the catalog changes rooms by opening a file. */
  here = this.picked.room;

  private prefs = inject(Prefs);
  /** A section of Settings asked for (the user menu, Ctrl+K, "?"): the
   *  Settings tab, open on it. */
  private toSettings = effect(() => {
    const want = this.prefs.open();
    if (!want) return;
    untracked(() => {
      this.prefs.tab.set(want);
      this.here.set('settings');
      this.prefs.open.set(null);
    });
  });

  constructor() {
    this.auth.load();
    // Once someone is signed in: whether an extraction is running (it is
    // asked again only while one is).
    effect(() => { if (this.auth.signedIn()) untracked(() => { this.tasteRuns.watch(); this.watchRuns(); }); });
    this.here.set(currentWorkspace());
    // Whoever changed it - a tab up here, a file clicked in the catalog, Back - the address
    // follows (nav.ts): a room can be linked to, a reload comes back to the one you were in,
    // and opening another room is a step the browser's Back goes back over.
    effect(() => {
      const id = this.here();
      // Not from inside a frame: when this application is shown in an
      // iframe the two share one localStorage, and the one in the frame,
      // opening on its own room, wrote over the room the outer page was
      // left in.
      if (window === window.top) rememberWorkspace(id);
      // Signed out, the address stays the landing page's own (/, ?signin, ?reset=).
      if (!this.auth.signedIn()) return;
      untracked(() => navSet(id, this.placeIn(id), { fill: true }));
    });
    // What is open in a room is in the address too - /3d/<model>, /notes/<note> - and
    // opening another is a step of its own. The rooms that keep it in Selection are followed
    // here; the others write it themselves (navGo).
    this.follow('cad', 'model', () => this.picked.model());
    this.follow('pcb', 'board', () => this.picked.board());
    this.follow('firmware', 'fw', () => this.picked.firmware());
    this.follow('notes', 'note', () => this.picked.note()?.id ?? null);
    this.follow('taste', 'palette', () => this.picked.taste()?.id ?? null);
    this.follow('settings', 'section', () => this.prefs.tab());
    // The tab's title: the room, and what is open in it.
    effect(() => {
      const id = this.here(), p = this.picked;
      const what = id === 'cad' ? p.model()?.split('/').pop() : id === 'pcb' ? p.board() : id === 'firmware' ? p.firmware()
        : id === 'notes' ? p.note()?.label : id === 'taste' ? p.taste()?.label : id === 'mfr' ? p.mfr()?.label
        : id === 'files' ? p.file()?.label : null;
      untracked(() => navTitle(id, what || null));
    });
    // What the address names that the rooms do not read from it themselves.
    this.restore(null, navParams());
    // Back and Forward: the room, and what was open in it, as the address now has it.
    effect(() => {
      const p = navPopped();
      if (p) untracked(() => this.restore(p.prev, p.next));
    });
  }

  /** What a room has open, kept in Selection: its values in the address when it is opened. */
  private placeIn(id: Workspace['id']): Record<string, string | null> {
    const p = this.picked;
    switch (id) {
      case 'cad': return { model: p.model() };
      case 'pcb': return { board: p.board() };
      case 'firmware': return { fw: p.firmware() };
      case 'notes': return { note: p.note()?.id ?? null };
      case 'taste': return navParams().get('run') ? {} : { palette: p.taste()?.id ?? null };
      case 'settings': return { section: this.prefs.tab() };
      default: return {};
    }
  }

  /** `key` in the address follows `read` while `room` is on screen; only a change is written. */
  private follow(room: Workspace['id'], key: string, read: () => string | null) {
    let was = untracked(read);
    effect(() => {
      const v = read();
      if (v === was) return;
      was = v;
      untracked(() => { if (this.here() === room) navSet(room, { [key]: v }); });
    });
  }

  /** Bumped to make the room again as an address has it, when Back lands on another place in
   *  the same room (another manufacturer, another folder): it reads the address as on a load. */
  mount = signal(0);
  /** The rooms put back that way, by the values that make them again; the others are told what to
   *  open (restore). Taste is told its palette, and made again only for an extraction run. */
  private static REMAKE: Partial<Record<RoomId, string[]>> = { mfr: ROOM_KEYS.mfr, files: ROOM_KEYS.files, taste: ['run'] };

  /** The address's values put on screen: at the start (`prev` null) what the rooms that do not read
   *  the address themselves are to open; after Back or Forward, the room and all of it. */
  private restore(prev: URLSearchParams | null, next: URLSearchParams) {
    const room = roomOf(next.get('ws'));
    if (!room) return;
    const p = this.picked, v = (k: string) => next.get(k), was = (k: string) => prev?.get(k) ?? null;
    const section = v('section');
    if (room === 'settings' && section && SECTIONS.includes(section)) this.prefs.tab.set(section as never);
    if (room === 'notes' && v('note') && v('note') !== p.note()?.id) p.ask('note', v('note')!);
    if (room === 'taste' && v('palette') && !v('run') && v('palette') !== p.taste()?.id) p.ask('taste', v('palette')!);
    if (room === 'tools' && v('tool') && (!prev || v('tool') !== was('tool'))) p.ask('tool', v('tool')!);
    if (!prev) return;
    // The rest the rooms read from the address when they are made; after Back they are told.
    if (room === 'cad' && v('model') && v('model') !== p.model()) p.ask('model', v('model')!);
    if (room === 'pcb' && v('board') && v('board') !== p.board()) p.board.set(v('board'));
    if (room === 'firmware' && v('fw') && v('fw') !== p.firmware()) p.firmware.set(v('fw'));
    if (room === 'commandcode') {
      if (v('dm') !== was('dm')) this.dms.show(v('dm'));
      if (!v('dm')) {
        if (v('thread') && v('thread') !== p.thread()) p.openThread(v('thread')!);
        else if (!v('thread') && p.thread()) p.thread.set(null);
        if (!v('thread') && v('chat') && v('chat') !== was('chat')) p.askCc({ action: 'open', chat: v('chat')! });
      }
    }
    const same = roomOf(prev.get('ws')) === room;
    if (same && App.REMAKE[room]?.some(k => v(k) !== was(k))) {
      // The room leaving must not write over the address the new one reads.
      navHold(true);
      this.mount.update(n => n + 1);
      afterNextRender(() => navHold(false), { injector: this.injector });
    }
    this.here.set(room);
  }

  /** A tab's address, for its link. */
  href(id: Workspace['id']) { return navHref({ ws: id }); }
  /** A plain click opens the room here; a middle click, Ctrl or Shift is the browser's (a new tab). */
  tab(e: MouseEvent, id: Workspace['id']) {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    this.open(id);
  }

  open(id: Workspace['id']) { this.here.set(id); }

  /** The Parts room's run watcher, once the first paint is done: its module
   *  (the biggest room) comes after the shell rather than before it. */
  private watchRuns() {
    setTimeout(() => void import('./rooms/manufacturers').then(m => {
      const runs = this.injector.get(m.MfrRuns);
      runs.watch();
      this.mfrSvc.set(runs);
    }), 1500);
  }
}
