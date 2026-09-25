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
  id: 'cad' | 'pcb' | 'web' | 'embedded' | 'mobile' | 'notes' | 'tools' | 'analyze';
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
    id: 'embedded',
    label: 'Embedded Programming',
    blurb: 'Firmware: what the build makes of the source - memory per region, '
         + 'the largest functions and tables with their files - the change as '
         + 'a diff, and the build as the check.',
    ready: true,
  },
  {
    id: 'web',
    label: 'Web Programming',
    blurb: 'Redlining a running page: draw on what is on screen, the change '
         + 'arrives as a diff, and the tests are the check.',
    ready: true,
  },
  {
    id: 'mobile',
    label: 'Mobile Programming',
    blurb: 'A phone app on an emulated phone: draw on its screen, the change '
         + 'arrives as a diff, the tests are the check.',
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
    id: 'tools',
    label: 'Tools',
    blurb: 'Small calculators and sketch pads for any room: units, track '
         + 'widths, resistors, a layout grid.',
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
