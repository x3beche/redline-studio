import { Component, effect, inject } from '@angular/core';
import { Editor } from './editor/editor';
import { Selection } from './selection';
import { RoomAnalyze } from './rooms/analyze';
import { RoomCoding } from './rooms/coding';
import { RoomPcb } from './rooms/pcb';
import { ToolsMenu } from './tools/menu';
import { WORKSPACES, Workspace, currentWorkspace, rememberWorkspace } from './workspaces';

@Component({
  selector: 'app-root',
  imports: [Editor, RoomPcb, RoomCoding, RoomAnalyze, ToolsMenu],
  template: `
<!-- The shell. Each tab is a room with the same loop in it: source in the
     database, built into something you can look at, marked up, picked up,
     rebuilt, checked. The tabs marked soon are not finished.

     The tabs and the room are handed to the editor rather than wrapped
     around it: they belong over the two right-hand columns, and the
     catalog on the left keeps its full height beside them. -->
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
         the right-hand column, which it follows when that folds. Tools sits
         over the right-hand column, at the far end. -->
    @if (analytics; as w) {
      <button (click)="open(w.id)" class="tcv-tab tcv-tab-end"
              [attr.data-on]="here() === w.id ? 1 : null"
              [attr.aria-current]="here() === w.id ? 'page' : null"
              [title]="w.blurb">{{ w.label }}</button>
    }
    <app-tools-menu class="tcv-tools-end" />
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
      @case ('analyze') { <app-room-analyze /> }
    }
  </div>
</app-editor>`,
})
export class App {
  private picked = inject(Selection);
  tabs = WORKSPACES;
  /** The rooms you work in, left; Analytics sits at the right end. */
  rooms = WORKSPACES.filter(w => w.id !== 'analyze');
  analytics = WORKSPACES.find(w => w.id === 'analyze');
  /** Shared, because the catalog changes rooms by opening a file. */
  here = this.picked.room;

  constructor() {
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
