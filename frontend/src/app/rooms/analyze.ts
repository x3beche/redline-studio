import { Component, output } from '@angular/core';
import { RoomShell } from './shell';

/** The figures room.
 *
 *  The one with the least left to invent: every revision already stores
 *  what it cost in tokens, money, CPU, GPU and energy. What is missing is
 *  the view that reads across them instead of one card at a time.
 */
@Component({
  selector: 'app-room-analyze',
  imports: [RoomShell],
  template: `
<app-room-shell title="Analyze" [blurb]="blurb" [needs]="needs"
                (leave)="leave.emit()" />`,
})
export class RoomAnalyze {
  leave = output<void>();
  blurb = 'What all of it cost and where the time went, across every '
        + 'revision rather than one card at a time.';
  needs = [
    'The per-revision figures already stored — tokens, money, CPU, GPU, '
    + 'energy — rolled up over a period',
    'Spend by kind of work and by model, over time rather than per card',
    'Build times per model, so a model that is getting slower says so',
  ];
}
