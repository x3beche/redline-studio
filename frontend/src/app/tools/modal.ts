import {
  Component, HostListener, Injector, Type, effect, inject, input, output, signal,
} from '@angular/core';
import { NgComponentOutlet } from '@angular/common';
import { CLOSE_TOOL, ToolDef } from './registry';

/** One tool, open over whatever room is on screen. */
@Component({
  selector: 'app-tool-modal',
  imports: [NgComponentOutlet],
  template: `
<div class="fixed inset-0 flex items-center justify-center p-6"
     style="background: var(--scrim); z-index: 1100" (click)="close.emit()">
  <div class="tcv-card flex flex-col overflow-hidden"
       [class]="tool().size === 'wide' ? 'h-[88vh] w-[min(78rem,94vw)]' : 'max-h-[88vh] w-[min(46rem,94vw)]'"
       (click)="$event.stopPropagation()">
    <div class="flex shrink-0 items-center gap-2 px-4 py-2"
         style="border-bottom: 1px solid var(--line)">
      <span class="tcv-label" style="color: var(--ink)">{{ tool().name }}</span>
      <span class="truncate text-[11px]" style="color: var(--ink-dim)">{{ tool().blurb }}</span>
      <button (click)="close.emit()" class="tcv-chip ml-auto" title="close (Esc)">×</button>
    </div>
    @if (body(); as c) {
      <ng-container *ngComponentOutlet="c; injector: inner" />
    } @else {
      <div class="p-4 text-[12px]" style="color: var(--ink-dim)">opening…</div>
    }
  </div>
</div>`,
})
export class ToolModal {
  tool = input.required<ToolDef>();
  close = output<void>();
  body = signal<Type<unknown> | null>(null);
  inner = Injector.create({
    providers: [{ provide: CLOSE_TOOL, useValue: () => this.close.emit() }],
    parent: inject(Injector),
  });

  constructor() {
    effect(() => {
      const t = this.tool();
      this.body.set(null);
      t.load().then(c => { if (this.tool() === t) this.body.set(c); });
    });
  }

  @HostListener('document:keydown.escape')
  onEsc() { this.close.emit(); }
}
