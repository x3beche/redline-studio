import { Component, effect, inject, signal, untracked } from '@angular/core';
import { Editor } from './editor/editor';
import { Selection } from './selection';
import { RoomAnalyze } from './rooms/analyze';
import { RoomCoding } from './rooms/coding';
import { RoomPcb } from './rooms/pcb';
import { RoomTools } from './tools/room';
import { Auth, SignIn, UserChip } from './auth';
import { WORKSPACES, Workspace, currentWorkspace, rememberWorkspace } from './workspaces';

@Component({
  selector: 'app-root',
  imports: [Editor, RoomPcb, RoomCoding, RoomAnalyze, RoomTools, SignIn, UserChip],
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
  <header tabs class="relative flex shrink-0 items-center gap-1">
    @for (w of rooms; track w.id) {
      <button (click)="open(w.id)" class="tcv-tab"
              [attr.data-on]="here() === w.id ? 1 : null"
              [attr.aria-current]="here() === w.id ? 'page' : null"
              [title]="w.blurb">
        {{ w.label }}
        @if (!w.ready) { <span class="tcv-tab-soon">soon</span> }
      </button>
    }
    <!-- Apart from the rooms you work in. Analytics, which reads across all
         of them, closes the middle column - its right edge on the edge of
         the right-hand column, which it follows when that folds. Tools
         stands just before it. -->
    @if (toolsTab; as w) {
      <button (click)="open(w.id)" class="tcv-tab tcv-tab-tools"
              [attr.data-on]="here() === w.id ? 1 : null"
              [attr.aria-current]="here() === w.id ? 'page' : null"
              [title]="w.blurb">{{ w.label }}
        <!-- How many tools there are, quietly, beside the name. -->
        @if (toolCount(); as n) { <span class="tcv-tab-count">{{ n }}</span> }
      </button>
    }
    @if (analytics; as w) {
      <button (click)="open(w.id)" class="tcv-tab tcv-tab-end"
              [attr.data-on]="here() === w.id ? 1 : null"
              [attr.aria-current]="here() === w.id ? 'page' : null"
              [title]="brief()?.title ?? w.blurb">{{ w.label }}
        <!-- The week in a few words, quietly: spend, notes, how fresh. -->
        @if (brief(); as b) { <span class="tcv-tab-count">{{ b.text }}</span> }
      </button>
    }
    <!-- Who is signed in, over the right-hand column; nothing in local mode. -->
    <app-user-chip class="tcv-user-end" />
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
      @case ('tools') { <app-room-tools /> }
      @case ('analyze') { <app-room-analyze /> }
    }
  </div>
</app-editor>
} @else if (auth.state()) {
  <app-sign-in />
}`,
})
export class App {
  private picked = inject(Selection);
  /** Whether sign-in is on, and who is signed in (auth.ts). */
  auth = inject(Auth);
  tabs = WORKSPACES;
  /** The rooms you work in, left; Tools and Analytics at the right end. */
  rooms = WORKSPACES.filter(w => w.id !== 'analyze' && w.id !== 'tools');
  toolsTab = WORKSPACES.find(w => w.id === 'tools');
  /** A few words from Analytics for its tab: the last seven days' LLM
   *  spend and notes, and how long ago the figures were worked out. The
   *  server keeps them cached, so asking once a minute costs nothing. */
  brief = signal<{ text: string; title: string } | null>(null);
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
        const usd = t.llm_usd ?? 0;
        const money = usd >= 1000 ? `$${(usd / 1000).toFixed(1)}k` : `$${Math.round(usd)}`;
        const mins = d?.computed_at ? Math.round((Date.now() - Date.parse(d.computed_at)) / 60000) : null;
        const ago = mins === null ? '' : mins < 1 ? ' · just now' : mins < 60 ? ` · ${mins} min ago` : ` · ${Math.round(mins / 60)} h ago`;
        this.brief.set({
          text: `${money} · ${t.notes ?? 0} notes${ago}`,
          title: `Last 7 days: $${usd.toFixed(2)} of LLM work, ${t.notes ?? 0} notes, ${t.runs ?? 0} runs`
               + (d?.took_ms != null ? ` - worked out in ${d.took_ms} ms` : ''),
        });
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
  analytics = WORKSPACES.find(w => w.id === 'analyze');
  /** Shared, because the catalog changes rooms by opening a file. */
  here = this.picked.room;

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
