import { Injectable, signal } from '@angular/core';
import { Workspace } from './workspaces';

/** What is open, and where.
 *
 *  The catalog is one tree of files and it lives in the left column,
 *  beside every room rather than inside one. So clicking a .pcb has to
 *  reach the board room and clicking a .3d the model viewer, and neither
 *  of those is the catalog's parent. They meet here instead.
 */
@Injectable({ providedIn: 'root' })
export class Selection {
  /** Which room is on screen. The shell owns the tabs; this is how the
   *  catalog can change rooms by opening something. */
  room = signal<Workspace['id']>('cad');

  /** The board the PCB room should show, by id. */
  board = signal<string | null>(null);

  /** What the open board is made of, as `U1 · C368196` - so the note
   *  panel beside the room can offer them where it offers a model's
   *  parts. It is the same question there: which bit of this is this
   *  about? */
  boardParts = signal<string[]>([]);

  /** Open a board: the room follows from the kind of file it is. */
  openBoard(id: string) {
    this.board.set(id);
    this.room.set('pcb');
  }
}
