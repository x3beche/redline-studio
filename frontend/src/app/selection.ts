import { Injectable, signal } from '@angular/core';
import { Workspace } from './workspaces';

/** What the command palette asks of the Chat room (id 'commandcode'). */
export interface CcWant {
  n: number;
  action: 'new' | 'last' | 'open';
  /** For 'open': the conversation, and the line in it to show. */
  chat?: string;
  message?: string;
  /** Attached to the new conversation's first line, as an @-mention. */
  mention?: { kind: 'model' | 'board' | 'file' | 'note'; id: string; label?: string };
  /** Sent at once when given; otherwise the composer waits, focused. */
  text?: string;
}

/** What a firmware note is about (backend/fwnotes.py): a pin or a net of
 *  the MCU, or lines of a file. The server fills in the rest. */
export interface FwAnchor {
  kind: 'pin' | 'net' | 'code';
  pin?: string; name?: string; net?: string | null; macro?: string | null; gpio?: number | null;
  parts?: string[]; file?: string; lines?: [number, number]; version?: number; excerpt?: string;
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

  /** The firmware the Firmware room should show, by id. */
  firmware = signal<string | null>(null);

  /** The note open in the Notes room, and the file picked in the Files
   *  room, by id - so the command palette can offer "Ask Chat about this
   *  note / file". */
  note = signal<{ id: string; label: string } | null>(null);
  file = signal<{ id: string; label: string } | null>(null);

  /** Something the Chat room is asked to do when it is on screen
   *  (app/palette.ts): a new conversation, with something of the workspace
   *  attached and perhaps the question already typed, or the last one
   *  opened. The room takes it (sets it back to null). */
  cc = signal<CcWant | null>(null);
  private ccAsks = 0;
  askCc(w: Omit<CcWant, 'n'>) {
    this.cc.set({ ...w, n: ++this.ccAsks });
    this.room.set('commandcode');
  }

  /** A room's agent thread to show in the Chat tab (rooms/agent-thread.ts):
   *  'cad' or 'pcb', or null for the AI conversations. Whatever used to
   *  open the "ask the agent" box under the queue opens this instead. */
  thread = signal<string | null>(new URLSearchParams(location.search).get('thread'));
  /** Bumped each time a thread is asked for, so an already open one still
   *  takes the cursor (Ctrl+K on the room you are in). */
  threadAsked = signal(0);
  openThread(room: string, at?: string) {
    this.thread.set(room);
    this.threadAsked.update(n => n + 1);
    if (at) this.threadAt.set(at);
    this.room.set('commandcode');
  }
  /** A line of a room's thread to scroll to once it is on screen (a queued
   *  note's "from chat" link); the thread sets it back to null. */
  threadAt = signal<string | null>(null);

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

  /** What a firmware note is about, as the Firmware room picked it: a pin
   *  (a row of Pins, or a net label on the sheet) or lines of a file in
   *  the Code view. Sent with the note; the server checks it. */
  fwAnchor = signal<FwAnchor | null>(null);
  /** The Firmware room's picture for the note: the sheet or the code as
   *  on screen, with the marks when the pen is down. */
  fwDraft = signal<(() => Promise<string | null>) | null>(null);
  /** Bumped when a firmware note has been filed, so the room lets go. */
  fwFiled = signal(0);
  /** The pins.h macros of the open firmware, for the note's Part field. */
  fwParts = signal<string[]>([]);
  /** "Open in Firmware" from a card: the room opens the file at the line,
   *  or picks the pin. */
  fwJump = signal<{ firmware: string; anchor: FwAnchor | null; file?: string; line?: number; n: number } | null>(null);
  private fwJumps = 0;
  jumpToFirmware(firmware: string, anchor: FwAnchor | null, file?: string, line?: number) {
    this.firmware.set(firmware);
    this.fwJump.set({ firmware, anchor, file, line, n: ++this.fwJumps });
    this.room.set('firmware');
  }

  /** Where the running note's card docks in the room on screen - the foot
   *  of its frame's tab column - set by the frame the moment it exists,
   *  so the card goes straight there instead of via the queue. */
  taskSlot = signal<HTMLElement | null>(null);

  /** Open a board: the room follows from the kind of file it is. */
  openBoard(id: string) {
    this.board.set(id);
    this.room.set('pcb');
  }

  /** Open a firmware (a .fw): the Firmware room, on it. */
  openFirmware(id: string) {
    this.firmware.set(id);
    this.room.set('firmware');
  }
}

