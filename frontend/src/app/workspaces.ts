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
  /** What this room is for, in one line. */
  blurb: string;
  ready: boolean;
  /** What has to exist before it opens - shown while it does not. */
  needs?: string[];
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
    needs: [
      'A source that is text and parametric, so a change is an edit rather '
      + 'than a redraw',
      'A headless render of the board, per layer, from a view that can be '
      + 'stored and returned to',
      'DRC and ERC as the check that fails the build — the board’s '
      + 'answer to an interference volume',
    ],
  },
  {
    id: 'code',
    label: 'Coding',
    blurb: 'Redlining a running interface: draw on what is on screen and '
         + 'let the change arrive as a diff.',
    ready: false,
    needs: [
      'A screenshot of the running app as the artefact, with the route and '
      + 'the state that produced it',
      'The mark mapped back to the element under it, not just to a pixel',
      'The test suite as the check, and the same screen afterwards as the '
      + '"after"',
    ],
  },
  {
    id: 'analyze',
    label: 'Analyze',
    blurb: 'What all of it cost and where the time went, across every '
         + 'revision rather than one card at a time.',
    ready: false,
    needs: [
      'The per-revision figures already stored — tokens, money, CPU, GPU, '
      + 'energy — rolled up over a period',
      'Spend by kind of work and by model, over time rather than per card',
      'Build times per model, so a model that is getting slower says so',
    ],
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
