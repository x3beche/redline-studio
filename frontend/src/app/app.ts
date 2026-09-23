import { Component, inject } from '@angular/core';
import { Editor } from './editor/editor';
import { Selection } from './selection';
import { RoomAnalyze } from './rooms/analyze';
import { RoomCoding } from './rooms/coding';
import { RoomPcb } from './rooms/pcb';
import { WORKSPACES, Workspace, currentWorkspace, rememberWorkspace } from './workspaces';

@Component({
  selector: 'app-root',
  imports: [Editor, RoomPcb, RoomCoding, RoomAnalyze],
  template: `
<!-- The shell. Each tab is a room with the same loop in it: source in the
     database, built into something you can look at, marked up, picked up,
     rebuilt, checked. Only the first room is built.

     The tabs and the room are handed to the editor rather than wrapped
     around it: they belong over the two right-hand columns, and the
     catalog on the left keeps its full height beside them. -->
<app-editor>
  <header tabs class="flex shrink-0 items-center gap-1">
    @for (w of tabs; track w.id) {
      <button (click)="open(w.id)" class="tcv-tab"
              [attr.data-on]="here() === w.id ? 1 : null"
              [attr.aria-current]="here() === w.id ? 'page' : null"
              [title]="w.blurb">
        {{ w.label }}
        @if (!w.ready) { <span class="tcv-tab-soon">soon</span> }
      </button>
    }
  </header>

  <!-- The 3D room stays mounted whichever tab is on. Its viewer holds a
       WebGL context and tens of megabytes of geometry; unmounting it would
       throw both away and rebuild them on the way back. An unbuilt room
       covers it instead. -->
  <div room>
    @switch (here()) {
      @case ('pcb') { <app-room-pcb (leave)="open('cad')" /> }
      @case ('code') { <app-room-coding (leave)="open('cad')" /> }
      @case ('analyze') { <app-room-analyze (leave)="open('cad')" /> }
    }
  </div>
</app-editor>`,
})
export class App {
  private picked = inject(Selection);
  tabs = WORKSPACES;
  /** Shared, because the catalog changes rooms by opening a file. */
  here = this.picked.room;

  constructor() {
    this.here.set(currentWorkspace());
  }

  open(id: Workspace['id']) {
    this.here.set(id);
    rememberWorkspace(id);
    // The address bar follows, so a room can be linked to and a reload
    // comes back to the same one.
    const url = new URL(location.href);
    if (id === 'cad') url.searchParams.delete('ws');
    else url.searchParams.set('ws', id);
    history.replaceState(null, '', url);
  }
}
