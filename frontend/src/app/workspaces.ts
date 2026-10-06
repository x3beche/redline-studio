/** The four sides of the application, and which one is on screen.
 *
 *  Redline started as one room - a parametric model, a drawing over it, a
 *  note. The loop under that room is not about geometry: source in a
 *  database, built into something you can look at, marked up, picked up by
 *  an agent, rebuilt, checked against a measurement, photographed from the
 *  same angle. A board fits it too.
 *
 *  So the shell holds the tabs and each room is a workspace inside it. The
 *  ones not finished say what they will be rather than pretending.
 */
export interface Workspace {
  id: 'cad' | 'pcb' | 'notes' | 'commandcode' | 'files' | 'tools' | 'settings' | 'analyze';
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
    id: 'notes',
    label: 'Notes',
    blurb: 'What you jot down while working: Enter keeps it, Alt+N from anywhere; '
         + '#tags, @boards, to-dos to tick, and a note can go to an agent.',
    ready: true,
  },
  {
    id: 'commandcode',
    label: 'Command Code',
    blurb: 'Talk with a model, together: every conversation is shared with the workspace, '
         + 'and each one keeps its own model.',
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

export function currentWorkspace(): Workspace['id'] {
  const asked = new URLSearchParams(location.search).get('ws');
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch { /* private window */ }
  const want = asked ?? saved;
  return WORKSPACES.some(w => w.id === want)
    ? (want as Workspace['id']) : 'cad';
}

export function rememberWorkspace(id: Workspace['id']): void {
  try {
    localStorage.setItem(KEY, id);
  } catch { /* private window */ }
}
