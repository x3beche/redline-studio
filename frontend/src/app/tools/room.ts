import { Component, Type, computed, effect, signal } from '@angular/core';
import { NgComponentOutlet } from '@angular/common';
import { TOOLS, ToolDef } from './registry';

const KEY = 'x3.tool';

function recall(): string {
  try { return localStorage.getItem(KEY) ?? TOOLS[0].id; } catch { return TOOLS[0].id; }
}

/** The Tools tab: every tool in a list on the left, the chosen one filling
 *  the room. A tab rather than a dropdown, because the list keeps growing
 *  and a tool is worked in, not glanced at. */
@Component({
  selector: 'app-room-tools',
  imports: [NgComponentOutlet],
  styleUrl: './room.css',
  template: `
<div class="tcv-room absolute inset-0 flex min-h-0">
  <nav class="tcv-tools-list">
    <div class="tcv-label" style="padding: 10px 12px 6px">Tools</div>
    @for (t of tools; track t.id) {
      <button class="tcv-tools-item" [attr.data-on]="t.id === here().id ? 1 : null"
              (click)="pick(t)">
        <span class="tcv-menu-name">{{ t.name }}</span>
        <span class="tcv-menu-blurb">{{ t.blurb }}</span>
      </button>
    }
  </nav>
  <section class="tcv-tools-body">
    <header class="tcv-tools-head">
      <span class="tcv-label" style="color: var(--ink)">{{ here().name }}</span>
      <span class="truncate text-[11px]" style="color: var(--ink-dim)">{{ here().blurb }}</span>
    </header>
    <div class="tcv-tools-stage" [attr.data-size]="here().size">
      @if (body(); as c) {
        <ng-container *ngComponentOutlet="c" />
      } @else {
        <div class="p-4 text-[12px]" style="color: var(--ink-dim)">opening…</div>
      }
    </div>
  </section>
</div>`,
})
export class RoomTools {
  readonly tools = TOOLS;
  private id = signal(recall());
  here = computed(() => TOOLS.find(t => t.id === this.id()) ?? TOOLS[0]);
  body = signal<Type<unknown> | null>(null);

  constructor() {
    effect(() => {
      const t = this.here();
      this.body.set(null);
      t.load().then(c => { if (this.here() === t) this.body.set(c); });
    });
  }

  pick(t: ToolDef) {
    this.id.set(t.id);
    try { localStorage.setItem(KEY, t.id); } catch { /* private window */ }
  }
}
