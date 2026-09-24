import { InjectionToken, Type } from '@angular/core';

/** The tools in the Tools menu, one line each.
 *
 *  Every tool is a component in a folder of its own under `tools/`, loaded
 *  only when it is first opened, so a long list costs the first screen
 *  nothing. A new tool is a folder there and an entry here.
 */
export interface ToolDef {
  id: string;
  name: string;
  /** One line, for the menu and the modal's head. */
  blurb: string;
  /** `wide` for a drawing surface, `narrow` for a form of figures. */
  size: 'wide' | 'narrow';
  load: () => Promise<Type<unknown>>;
}

export const TOOLS: ToolDef[] = [
  {
    id: 'grid-sketch',
    name: 'Grid Sketch',
    blurb: 'draw a layout on a grid, copy it as a prompt, CSS or JSON',
    size: 'wide',
    load: () => import('./grid-sketch/grid-sketch').then(m => m.GridSketch),
  },
  {
    id: 'units',
    name: 'Units & Numbers',
    blurb: 'mm, mil and inch; hex, decimal and binary; UART baud and timer periods',
    size: 'narrow',
    load: () => import('./units/units').then(m => m.UnitsTool),
  },
  {
    id: 'trace-width',
    name: 'Trace Width',
    blurb: 'how wide a track must be for a current, by IPC-2221, and what it drops',
    size: 'narrow',
    load: () => import('./trace-width/trace-width').then(m => m.TraceWidthTool),
  },
  {
    id: 'resistor',
    name: 'Resistor & LED',
    blurb: "Ohm's law, an LED's series resistor, a divider from standard values",
    size: 'narrow',
    load: () => import('./resistor/resistor').then(m => m.ResistorTool),
  },
];

/** Closes the modal a tool is open in - for a tool that catches the
 *  keyboard itself, as a framed page does. */
export const CLOSE_TOOL = new InjectionToken<() => void>('close the tool');
