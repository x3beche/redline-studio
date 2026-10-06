import { Component, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { Editor } from './editor/editor';
import { Selection } from './selection';
import { RoomAnalyze } from './rooms/analyze';
import { RoomCoding } from './rooms/coding';
import { RoomPcb } from './rooms/pcb';
import { RoomTools } from './tools/room';
import { QuickNote, RoomNotes } from './rooms/notes';
import { RoomFiles } from './rooms/files';
import { RoomCommandCode } from './rooms/commandcode';
import { Palette } from './palette';
import { Prefs, RoomSettings } from './preferences';
import { T } from './i18n';
import { Money, money, moneyShort } from './money';
import { Auth, SignIn, UserChip } from './auth';
import { WORKSPACES, Workspace, currentWorkspace, rememberWorkspace } from './workspaces';
import { TopBar, TopbarFit } from './topbar';
import { TopbarMore } from './topbar-more';

@Component({
  selector: 'app-root',
  imports: [Editor, RoomPcb, RoomCoding, RoomAnalyze, RoomTools, RoomNotes, RoomCommandCode, RoomFiles, QuickNote, Palette, RoomSettings, SignIn, T, UserChip, TopbarFit, TopbarMore],
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
         Notes, Command Code, Files and Basic Tools, closing the middle
         column. What is hidden, or does not fit, is under More. Analytics is
         in the menu under your name (auth.ts). -->
    @for (b of bar.inBar(); track b.id) {
      <button (click)="open(b.ws.id)" class="tcv-tab" [class.tb-push]="b.push" [class.tb-iconic]="!bar.text(b.ws)"
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
      </button>
    }
    <app-topbar-more />
    <!-- Settings: the theme and the language for this browser, the LLM
         keys and the proxy for the server - a tab, not a menu item. -->
    @if (settingsTab; as w) {
      <button (click)="open(w.id)" class="tcv-tab tcv-tab-settings tcv-tab-end" [class.tb-tight]="bar.tight()"
              [class.tb-iconic]="bar.display() === 'icon'"
              [attr.data-on]="here() === w.id ? 1 : null"
              [attr.aria-current]="here() === w.id ? 'page' : null"
              [attr.aria-label]="w.label | t"
              [title]="w.blurb">⚙@if (bar.display() !== 'icon') { <span class="tb-settings-name"> {{ w.label | t }}</span>}</button>
    }
    <!-- Who is signed in, over the right-hand column; nothing in local mode.
         Its width is measured (--layout-user-w) so the tabs keep clear of it
         when that column is folded to a rail. -->
    <!-- Analytics is the first thing in its menu, with the week in a few words. -->
    <app-user-chip #chip class="tcv-user-end" [brief]="brief()" [inAnalytics]="here() === 'analyze'"
                   (analytics)="open('analyze')" />
  </header>

  <!-- The 3D room stays mounted whichever tab is on. Its viewer holds a
       WebGL context and tens of megabytes of geometry; unmounting it would
       throw both away and rebuild them on the way back. An unbuilt room
       covers it instead. -->
  <!-- Empty in the 3D room, and out of the layout with it: left in, an
       empty flex child took half the column. -->
  <div room class="tcv-room-slot" [class.hidden]="here() === 'cad'">
    @switch (here()) {
      @case ('pcb') { <app-room-pcb /> }
      @case ('web') { <app-room-coding platform="web" /> }
      @case ('embedded') { <app-room-coding platform="embedded" /> }
      @case ('mobile') { <app-room-coding platform="mobile" /> }
      @case ('notes') { <app-room-notes /> }
      @case ('commandcode') { <app-room-commandcode /> }
      @case ('files') { <app-room-files /> }
      @case ('tools') { <app-room-tools /> }
      @case ('settings') { <app-room-settings /> }
      @case ('analyze') { <app-room-analyze /> }
    }
  </div>
</app-editor>
<!-- Alt+N anywhere: a note, without leaving the room. -->
<app-quick-note />
<!-- Ctrl+K anywhere: go to anything, do anything, search everything. -->
<app-palette />
} @else if (auth.state()) {
  <app-sign-in />
}`,
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
  /** The rooms you work in, left; Notes, Command Code, Files and Basic Tools at the right end. */
  rooms = WORKSPACES.filter(w => w.id !== 'analyze' && w.id !== 'tools' && w.id !== 'notes' && w.id !== 'files' && w.id !== 'commandcode' && w.id !== 'settings');
  notesTab = WORKSPACES.find(w => w.id === 'notes');
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
  private briefTimer?: ReturnType<typeof setInterval>;
  private readBrief = effect(() => {
    clearInterval(this.briefTimer);
    if (!this.auth.signedIn()) return;
    const read = () => fetch('/api/insights?range=7d', { credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : null)
      .then((d: { now_totals?: { llm_usd?: number; notes?: number; runs?: number }; computed_at?: string;
                  took_ms?: number } | null) => {
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
    this.here.set(currentWorkspace());
    // Whoever changed it - a tab up here, or a file clicked in the catalog
    // - the address bar and the memory follow, so a room can be linked to
    // and a reload comes back to the one you were in.
    effect(() => {
      const id = this.here();
      // Not from inside a frame. The Web room shows a running page in an
      // iframe, and when that page is this application the two share one
      // localStorage: the one in the frame, opening on its own room, wrote
      // over the room the outer page was left in.
      if (window === window.top) rememberWorkspace(id);
      const url = new URL(location.href);
      if (id === 'cad') url.searchParams.delete('ws');
      else url.searchParams.set('ws', id);
      history.replaceState(null, '', url);
    });
  }

  open(id: Workspace['id']) { this.here.set(id); }
}
