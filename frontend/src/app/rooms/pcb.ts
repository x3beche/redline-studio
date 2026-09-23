import { Component, output } from '@angular/core';
import { RoomShell } from './shell';

/** The board room.
 *
 *  Empty on purpose. When it is built, the frame stays and what goes
 *  inside it is a board render with its layers, the queue beside it, and
 *  the same freeze-and-mark over the top - the loop does not change, only
 *  what is being looked at.
 */
@Component({
  selector: 'app-room-pcb',
  imports: [RoomShell],
  template: `
<app-room-shell title="PCB Design" [blurb]="blurb" [needs]="needs"
                (leave)="leave.emit()" />`,
})
export class RoomPcb {
  leave = output<void>();
  blurb = 'The same loop over a board. Mark a trace or a footprint on the '
        + 'render and leave the note there.';
  needs = [
    'A source that is text and parametric, so a change is an edit rather '
    + 'than a redraw',
    'A headless render of the board, per layer, from a view that can be '
    + 'stored and returned to',
    'DRC and ERC as the check that fails the build — the board’s '
    + 'answer to an interference volume',
  ];
}
