import { Component, signal } from '@angular/core';
import { Editor } from './editor/editor';
import { WORKSPACES, Workspace, currentWorkspace, rememberWorkspace } from './workspaces';

@Component({
  selector: 'app-root',
  imports: [Editor],
  template: `
<div class="flex h-screen flex-col">
  <!-- The shell. Each tab is a room with the same loop in it: source in
       the database, built into something you can look at, marked up,
       picked up, rebuilt, checked. Only the first room is built. -->
  <header class="flex shrink-0 items-center gap-1 px-2 pt-2">
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
       throw both away and rebuild them on the way back. The other rooms
       cover it instead. -->
  <div class="relative min-h-0 flex-1">
    <app-editor />
    @if (room(); as w) {
      @if (!w.ready) {
        <div class="absolute inset-0 z-50 overflow-y-auto p-2"
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
</div>`,
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
