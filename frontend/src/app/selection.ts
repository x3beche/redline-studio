import { Injectable, signal } from '@angular/core';
import { Workspace } from './workspaces';

/** What the command palette asks of the Command Code room. */
export interface CcWant {
  n: number;
  action: 'new' | 'last';
  /** Attached to the new conversation's first line, as an @-mention. */
  mention?: { kind: 'model' | 'board' | 'file' | 'note'; id: string; label?: string };
  /** Sent at once when given; otherwise the composer waits, focused. */
  text?: string;
}

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

  /** Something asked of whichever room can do it - the command palette's
   *  way in (app/palette.ts): open a model, show its code at a line, pack
   *  a release, look up a part. `n` makes the same ask twice count. */
  want = signal<{ what: string; arg?: string; n: number } | null>(null);
  private asks = 0;
  ask(what: string, arg?: string) { this.want.set({ what, arg, n: ++this.asks }); }

  /** The model open in the 3D room, by id - so a quick note knows it. */
  model = signal<string | null>(null);

  /** The board the PCB room should show, by id. */
  board = signal<string | null>(null);

  /** The note open in the Notes room, and the file picked in the Files
   *  room, by id - so the command palette can offer "Ask Command Code
   *  about this note / file". */
  note = signal<{ id: string; label: string } | null>(null);
  file = signal<{ id: string; label: string } | null>(null);

  /** Something the Command Code room is asked to do when it is on screen
   *  (app/palette.ts): a new conversation, with something of the workspace
   *  attached and perhaps the question already typed, or the last one
   *  opened. The room takes it (sets it back to null). */
  cc = signal<CcWant | null>(null);
  private ccAsks = 0;
  askCc(w: Omit<CcWant, 'n'>) {
    this.cc.set({ ...w, n: ++this.ccAsks });
    this.room.set('commandcode');
  }

  /** What the open board is made of, as `U1 · C368196` - so the note
   *  panel beside the room can offer them where it offers a model's
   *  parts. It is the same question there: which bit of this is this
   *  about? */
  boardParts = signal<string[]>([]);

  /** The board view, frozen and marked up, as the PNG a board note
   *  carries. Null while nothing is frozen. */
  boardDraft = signal<(() => Promise<string | null>) | null>(null);

  /** Bumped when a board note has been filed, so the room lets go. */
  boardFiled = signal(0);

  /** Where the running note's card docks in the room on screen - the foot
   *  of its frame's tab column - set by the frame the moment it exists,
   *  so the card goes straight there instead of via the queue. */
  taskSlot = signal<HTMLElement | null>(null);

  /** Open a board: the room follows from the kind of file it is. */
  openBoard(id: string) {
    this.board.set(id);
    this.room.set('pcb');
  }
}

