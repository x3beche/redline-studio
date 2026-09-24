import { Type } from '@angular/core';

/** The tools in the Tools tab, one line each.
 *
 *  Every tool is a component in a folder of its own under `tools/`, loaded
 *  only when it is first opened, so a long list costs the first screen
 *  nothing. A new tool is a folder there and an entry here.
 */
export type ToolGroup = 'electronics' | 'design' | 'code';

/** The list's headings, in order. */
export const GROUPS: { id: ToolGroup; label: string }[] = [
  { id: 'electronics', label: 'Electronics' },
  { id: 'design', label: 'Design & UI' },
  { id: 'code', label: 'Code, data & prompts' },
];

export interface ToolDef {
  id: string;
  name: string;
  /** One line, for the list and the tool's head. */
  blurb: string;
  /** `wide` fills the room (a drawing surface); `narrow` keeps a form's width. */
  size: 'wide' | 'narrow';
  /** Which heading it is listed under. */
  group: ToolGroup;
  load: () => Promise<Type<unknown>>;
}

export const TOOLS: ToolDef[] = [
  {
    id: 'grid-sketch',
    name: 'Grid Sketch',
    blurb: 'draw a layout on a grid, copy it as a prompt, CSS or JSON',
    size: 'wide',
    group: 'design',
    load: () => import('./grid-sketch/grid-sketch').then(m => m.GridSketch),
  },
  {
    id: 'units',
    name: 'Units & Numbers',
    blurb: 'mm, mil and inch; hex, decimal and binary; UART baud and timer periods',
    size: 'narrow',
    group: 'electronics',
    load: () => import('./units/units').then(m => m.UnitsTool),
  },
  {
    id: 'trace-width',
    name: 'Trace Width',
    blurb: 'how wide a track must be for a current, by IPC-2221, and what it drops',
    size: 'narrow',
    group: 'electronics',
    load: () => import('./trace-width/trace-width').then(m => m.TraceWidthTool),
  },
  {
    id: 'resistor',
    name: 'Resistor & LED',
    blurb: "Ohm's law, an LED's series resistor, a divider from standard values",
    size: 'narrow',
    group: 'electronics',
    load: () => import('./resistor/resistor').then(m => m.ResistorTool),
  },
  {
    id: 'screenshot-annotator',
    name: 'Screenshot Annotator',
    blurb: 'mark up a screenshot and turn the marks into a fix list',
    size: 'wide',
    group: 'design',
    load: () => import('./screenshot-annotator/screenshot-annotator').then(m => m.ScreenshotAnnotator),
  },
  {
    id: 'palette-forge',
    name: 'Palette Forge',
    blurb: 'one colour into an accessible palette and light/dark tokens',
    size: 'wide',
    group: 'design',
    load: () => import('./palette-forge/palette-forge').then(m => m.PaletteForge),
  },
  {
    id: 'motion-lab',
    name: 'Motion Lab',
    blurb: 'shape an easing curve and timing, take it as CSS or JS',
    size: 'wide',
    group: 'design',
    load: () => import('./motion-lab/motion-lab').then(m => m.MotionLab),
  },
  {
    id: 'schema-sketch',
    name: 'Schema Sketch',
    blurb: 'draw tables and relations, get SQL, Prisma and Mermaid',
    size: 'wide',
    group: 'code',
    load: () => import('./schema-sketch/schema-sketch').then(m => m.SchemaSketch),
  },
  {
    id: 'flow-mermaid',
    name: 'Flow to Mermaid',
    blurb: 'draw a flowchart with boxes and arrows, get Mermaid code',
    size: 'wide',
    group: 'code',
    load: () => import('./flow-mermaid/flow-mermaid').then(m => m.FlowMermaid),
  },
  {
    id: 'api-sketch',
    name: 'API Sketch',
    blurb: 'define endpoints, get OpenAPI, curl and a TypeScript client',
    size: 'wide',
    group: 'code',
    load: () => import('./api-sketch/api-sketch').then(m => m.ApiSketch),
  },
  {
    id: 'cron-studio',
    name: 'Cron Studio',
    blurb: 'build a cron expression, see when it next runs',
    size: 'wide',
    group: 'code',
    load: () => import('./cron-studio/cron-studio').then(m => m.CronStudio),
  },
  {
    id: 'data-digest',
    name: 'Data Digest',
    blurb: 'profile a large CSV or JSON into a compact brief for an LLM',
    size: 'wide',
    group: 'code',
    load: () => import('./data-digest/data-digest').then(m => m.DataDigest),
  },
  {
    id: 'context-packer',
    name: 'Context Packer',
    blurb: 'pack code, logs and notes into one well-built prompt',
    size: 'wide',
    group: 'code',
    load: () => import('./context-packer/context-packer').then(m => m.ContextPacker),
  },
  {
    id: 'form-builder',
    name: 'Form Builder',
    blurb: 'build a form with its rules, get Zod, types and a React component',
    size: 'wide',
    group: 'design',
    load: () => import('./form-builder/form-builder').then(m => m.FormBuilder),
  },
  {
    id: 'regex-example',
    name: 'Regex by Example',
    blurb: 'pick what should match in a text and get the regex, explained',
    size: 'wide',
    group: 'code',
    load: () => import('./regex-example/regex-example').then(m => m.RegexExample),
  },
];
