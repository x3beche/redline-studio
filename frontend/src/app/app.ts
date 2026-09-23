import { Component, signal } from '@angular/core';
import { Editor } from './editor/editor';
import { WORKSPACES, Workspace, currentWorkspace, rememberWorkspace } from './workspaces';

@Component({
  selector: 'app-root',
  imports: [Editor],
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
    @if (room(); as w) {
      @if (!w.ready) {
        <div class="absolute inset-0 z-50 overflow-y-auto rounded"
             style="background: var(--surface)">
          <div class="tcv-card mx-auto mt-10 max-w-xl p-5">
            <h1 class="brand-name mb-2">{{ w.label }}</h1>
            <p class="mb-4 text-[13px]" style="color: var(--ink)">{{ w.blurb }}</p>
            <p class="tcv-label mb-1.5">Not here yet. What it needs first</p>
            <ul class="mb-4 text-[12px] leading-relaxed" style="color: var(--ink-dim)">
              @for (n of w.needs ?? []; track n) {
                <li class="mb-1">— {{ n }}</li>
              }
            </ul>
            <button (click)="open('cad')" class="tcv-btn tcv-btn-accent px-3 py-1">
              back to 3D Drawing
            </button>
          </div>
        </div>
      }
    }
  </div>
</app-editor>`,
})
export class App {
  tabs = WORKSPACES;
  here = signal<Workspace['id']>(currentWorkspace());

  room(): Workspace | undefined {
    return this.tabs.find(w => w.id === this.here());
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
