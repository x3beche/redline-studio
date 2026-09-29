import { Component, input } from '@angular/core';
import { AppEntry } from '../api';

/** The Embedded room's view of a real board: its port, flashing it, its serial monitor. Lives in the room frame's view
 *  area (rooms/coding.ts), like the 3D and PCB rooms' views. */
@Component({
  selector: 'app-fw-device',
  host: { class: 'block h-full w-full' },
  template: `<p class="p-3 text-[12px]" style="color: var(--ink-dim)">fw-device</p>`,
})
export class FwDevice {
  app = input.required<AppEntry>();
}
