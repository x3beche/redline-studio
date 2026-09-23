/** The four sides of the application, and which one is on screen.
 *
 *  Redline started as one room - a parametric model, a drawing over it, a
 *  note. The loop under that room is not about geometry: source in a
 *  database, built into something you can look at, marked up, picked up by
 *  an agent, rebuilt, checked against a measurement, photographed from the
 *  same angle. A board and a running interface both fit it.
 *
 *  So the shell holds the tabs and each room is a workspace inside it. One
 *  is built; the other three say what they will be rather than pretending.
 */
export interface Workspace {
  id: 'cad' | 'pcb' | 'code' | 'analyze';
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
    blurb: 'The same loop over a board. Mark a trace or a footprint on the '
         + 'render and leave the note there.',
    ready: false,
  },
  {
    id: 'code',
    label: 'Coding',
    blurb: 'Redlining a running interface: draw on what is on screen and '
         + 'let the change arrive as a diff.',
    ready: false,
  },
  {
    id: 'analyze',
    label: 'Analyze',
    blurb: 'What all of it cost and where the time went, across every '
         + 'revision rather than one card at a time.',
    ready: false,
  },
];

const KEY = 'x3.workspace';

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
