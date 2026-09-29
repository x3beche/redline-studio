import { Component, input, output } from '@angular/core';
import { AppEntry, FwSymbol } from '../api';

/** The Embedded room's view of what the build made: memory, what fills flash, what changed. Lives in the room frame's view
 *  area (rooms/coding.ts), like the 3D and PCB rooms' views. */
@Component({
  selector: 'app-fw-build',
  host: { class: 'block h-full w-full' },
  template: `<p class="p-3 text-[12px]" style="color: var(--ink-dim)">fw-build</p>`,
})
export class FwBuild {
  app = input.required<AppEntry>();
  /** A function or table picked: it becomes the note's Part. */
  picked = output<FwSymbol>();
}
