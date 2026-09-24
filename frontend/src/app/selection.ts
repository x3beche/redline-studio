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

  /** The board view, frozen and marked up, as the PNG a board note
   *  carries. Null while nothing is frozen - the same hand-off as the
   *  coding rooms' `codeDraft`. */
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

  // ---- the coding rooms ----

  /** The project the coding room on screen shows, by id. */
  app = signal<string | null>(null);

  /** What is under the marks on a frozen page, as the Part field offers
   *  it: `button.tcv-btn "build" · rooms/pcb.ts`. */
  codeParts = signal<string[]>([]);

  /** Something picked in a coding room's view to be the note's Part - a
   *  function in the firmware view, say. The form beside the room takes
   *  it, the way a click on a model's part fills the field in 3D. */
  codePick = signal<{ label: string } | null>(null);

  /** The frozen page, marked up, ready to be filed. The room owns the
   *  picture and the marks; the note form is in the column beside it, so
   *  the form asks the room through this rather than reaching into it.
   *  Null while nothing is frozen. */
  codeDraft = signal<(() => Promise<CodeDraft>) | null>(null);

  /** Bumped when a code note has been filed, so the room lets go of the
   *  frozen page the way the 3D room lets go of its view. */
  codeFiled = signal(0);

  /** Open a project: web, embedded and mobile each have their own room. */
  openApp(id: string, platform: 'web' | 'embedded' | 'mobile') {
    this.app.set(id);
    this.room.set(platform);
  }
}

/** A note on a running interface, as the room hands it to the form. */
export interface CodeDraft {
  image_png: string | null;
  code: {
    route: string;
    viewport: [number, number];
    base: string | null;
    shot: string | null;
    dom: unknown[];
  };
}
