import { navParams } from './nav';

/** The four sides of the application, and which one is on screen.
 *
 *  Workbench started as one room - a parametric model, a drawing over it, a
 *  note. The loop under that room is not about geometry: source in a
 *  database, built into something you can look at, marked up, picked up by
 *  an agent, rebuilt, checked against a measurement, photographed from the
 *  same angle. A board fits it too.
 *
 *  So the shell holds the tabs and each room is a workspace inside it. The
 *  ones not finished say what they will be rather than pretending.
 */
export interface Workspace {
  id: 'cad' | 'pcb' | 'firmware' | 'notes' | 'taste' | 'mfr' | 'commandcode' | 'files' | 'tools' | 'settings' | 'analyze';
  label: string;
  /** What this room is for, in one line. The tab's tooltip. */
  blurb: string;
  ready: boolean;
}

export const WORKSPACES: Workspace[] = [
  {
    id: 'cad',
    label: '3D Drawing',
    blurb: 'Parametric solids: freeze an angle, mark it, and the change '
         + 'comes back measured.',
    ready: true,
  },
  {
    id: 'pcb',
    label: 'PCB Design',
    blurb: 'A circuit written as text, the parts fetched by part number, '
         + 'and the board placed and drawn from it.',
    ready: true,
  },
  {
    id: 'firmware',
    label: 'Firmware',
    blurb: 'The code on a board\'s chip: its schematic sheet, the pins as nets, '
         + 'built with PlatformIO and checked before it is flashed.',
    ready: true,
  },
  {
    id: 'notes',
    label: 'Notes',
    blurb: 'What you jot down while working: Enter keeps it, Alt+N from anywhere; '
         + '#tags, @boards, to-dos to tick, and a note can go to an agent.',
    ready: true,
  },
  {
    id: 'taste',
    label: 'Taste',
    blurb: 'Taste palettes: what makes a design good, as statements the AI follows - attached to a '
         + 'project or mentioned in Chat, written by hand or extracted from a finished one.',
    ready: true,
  },
  {
    // The parts you buy and keep: the makers' catalogs, the LCSC drawer, McMaster-Carr, GrabCAD and
    // your My Items - and how many of each are on hand (the stock, a part of this page). Its name is
    // this label, here only: the tab, the page's title and the palette read it (PARTS_LABEL).
    id: 'mfr',
    label: 'Parts',
    blurb: 'The parts you buy and keep - from makers\' sites, the LCSC drawer, McMaster-Carr, GrabCAD or '
         + 'typed in by hand - and how many of each are on hand, where, and when they run low.',
    ready: true,
  },
  {
    id: 'commandcode',
    // Shown as "Chat"; the id stays, so old links (?ws=commandcode) and
    // saved tab orders keep working.
    label: 'Chat',
    blurb: 'Talk with a model - or with a room\'s agent. Your conversations are yours alone.',
    ready: true,
  },
  {
    id: 'files',
    label: 'Files',
    blurb: 'What the work needs that is not a model or a board: a BOM, a pick-and-place '
         + 'file, a datasheet, a photo - kept as it came, and handed to a room\'s agent.',
    ready: true,
  },
  {
    id: 'tools',
    label: 'Basic Tools',
    blurb: 'Small calculators and sketch pads for any room: units, track '
         + 'widths, resistors, a layout grid.',
    ready: true,
  },
  {
    id: 'settings',
    label: 'Settings',
    blurb: 'The theme, the language and the shortcuts for this browser; the LLM keys and '
         + 'models and the proxy for the server.',
    ready: true,
  },
  {
    id: 'analyze',
    label: 'Analytics',
    blurb: 'Everything the app has used: LLM tokens and money, the machine '
         + 'and its energy, the work in each room, storage, projects.',
    ready: true,
  },
];

const KEY = 'redline.workspace';

/** The Parts page's name, the one place it is written (the tab, the page's title, the palette). */
export const PARTS_LABEL = WORKSPACES.find(w => w.id === 'mfr')!.label;

/** Whether the page was opened by an old link to the stock's own tab (?ws=inventory): the Parts page
 *  opens at its stock then, an item's product open when the link named one (?item=). Read once. */
export const STOCK_ASKED = new URLSearchParams(location.search).get('ws') === 'inventory'
  || (() => { try { return localStorage.getItem(KEY) === 'inventory'; } catch { return false; } })();

export function currentWorkspace(): Workspace['id'] {
  // The room the address names (/pcb/…, or an old ?ws=pcb / ?ws=chat / ?ws=catalog: nav-url.ts).
  const asked = navParams().get('ws');
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch { /* private window */ }
  const want = asked ?? (saved === 'inventory' ? 'mfr' : saved);
  return WORKSPACES.some(w => w.id === want)
    ? (want as Workspace['id']) : 'cad';
}

export function rememberWorkspace(id: Workspace['id']): void {
  try {
    localStorage.setItem(KEY, id);
  } catch { /* private window */ }
}
