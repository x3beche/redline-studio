import { Component, output } from '@angular/core';
import { RoomShell } from './shell';

/** The code room.
 *
 *  This one already happens by hand: somebody screenshots the running
 *  interface, draws on it and says "this gap", "centre that". The room is
 *  that loop with the screenshot taken for you and the change arriving as
 *  a diff.
 */
@Component({
  selector: 'app-room-coding',
  imports: [RoomShell],
  template: `
<app-room-shell title="Coding" [blurb]="blurb" [needs]="needs"
                (leave)="leave.emit()" />`,
})
export class RoomCoding {
  leave = output<void>();
  blurb = 'Redlining a running interface: draw on what is on screen and let '
        + 'the change arrive as a diff.';
  needs = [
    'A screenshot of the running app as the artefact, with the route and '
    + 'the state that produced it',
    'The mark mapped back to the element under it, not just to a pixel',
    'The test suite as the check, and the same screen afterwards as the '
    + '"after"',
  ];
}
