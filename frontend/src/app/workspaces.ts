/** The four sides of the application, and which one is on screen.
 *
 *  Redline started as one room - a parametric model, a drawing over it, a
 *  note. The loop under that room is not about geometry: source in a
 *  database, built into something you can look at, marked up, picked up by
 *  an agent, rebuilt, checked against a measurement, photographed from the
 *  same angle. A board and a running interface both fit it.
 *
 *  So the shell holds the tabs and each room is a workspace inside it. The
 *  ones not finished say what they will be rather than pretending.
 */
export interface Workspace {
  id: 'cad' | 'pcb' | 'web' | 'embedded' | 'mobile' | 'analyze';
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
  // Three coding rooms, not one. A web page, a firmware image and a phone
  // app are the same loop - look at what runs, mark it, get a diff back,
  // let the tests say whether it still works - over different things on
  // screen. One component serves all three; the tab says which.
  {
    id: 'web',
    label: 'Web Programming',
    blurb: 'Redlining a running page: draw on what is on screen, the change '
         + 'arrives as a diff, and the tests are the check.',
    ready: true,
  },
  {
    id: 'embedded',
    label: 'Embedded Programming',
    blurb: 'Firmware: the same notes, diffs and tests. What it shows on '
         + 'screen - a serial console, a display - is not wired yet.',
    ready: false,
  },
  {
    id: 'mobile',
    label: 'Mobile Programming',
    blurb: 'A phone app: the same loop at a phone\'s size. Served on the '
         + 'web it can be drawn on today; on a device, not yet.',
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
