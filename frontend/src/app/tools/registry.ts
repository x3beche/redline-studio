import { Type } from '@angular/core';

/** The tools in the Tools tab.
 *
 *  The list itself is the catalog the API builds from every tool's
 *  `manifest.json` (public/tools/<id>/manifest.json): name, blurb, group,
 *  rooms, keywords. Most tools are kit tools - a folder with the manifest,
 *  a pure tool.js and a small page - and need nothing here. The tools that
 *  are Angular components or hand-written pages are loaded through the
 *  components below, only when first opened.
 */
export type ToolGroup = 'pcb' | 'embedded' | 'mechanical' | 'web' | 'mobile' | 'code' | 'project';

/** The list's headings, in order. */
export const GROUPS: { id: ToolGroup; label: string }[] = [
  { id: 'pcb', label: 'PCB & electronics' },
  { id: 'embedded', label: 'Embedded' },
  { id: 'mechanical', label: 'Mechanical & 3D' },
  { id: 'web', label: 'Web & design' },
  { id: 'mobile', label: 'Mobile' },
  { id: 'code', label: 'Code, data & prompts' },
  { id: 'project', label: 'Project' },
];

/** The rooms a tool can say it serves, for the filter chips. */
export const ROOMS: { id: string; label: string }[] = [
  { id: 'pcb', label: 'PCB' },
  { id: 'embedded', label: 'Embedded' },
  { id: 'cad', label: '3D' },
  { id: 'web', label: 'Web' },
  { id: 'mobile', label: 'Mobile' },
  { id: 'analyze', label: 'Analytics' },
];

/** One entry of the catalog (GET /api/tools/catalog). */
export interface ToolInfo {
  id: string;
  name: string;
  blurb: string;
  group: ToolGroup;
  rooms: string[];
  keywords: string[];
  /** The page to frame; null for an Angular calculator. */
  src: string | null;
  native: boolean;
  runnable: boolean;
  /** The date and time its newest file changed, e.g. 2026.09.25-14.32. */
  version?: string;
  uses: number;
}

/** `wide` fills the room (a drawing surface); `narrow` keeps a form's width. */
export const NARROW = new Set(['units', 'trace-width', 'resistor']);

/** Tools with a component of their own, by id. */
export const COMPONENTS: Record<string, () => Promise<Type<unknown>>> = {
  'grid-sketch': () => import('./grid-sketch/grid-sketch').then(m => m.GridSketch),
  'units': () => import('./units/units').then(m => m.UnitsTool),
  'trace-width': () => import('./trace-width/trace-width').then(m => m.TraceWidthTool),
  'resistor': () => import('./resistor/resistor').then(m => m.ResistorTool),
  'screenshot-annotator': () => import('./screenshot-annotator/screenshot-annotator').then(m => m.ScreenshotAnnotator),
  'palette-forge': () => import('./palette-forge/palette-forge').then(m => m.PaletteForge),
  'motion-lab': () => import('./motion-lab/motion-lab').then(m => m.MotionLab),
  'schema-sketch': () => import('./schema-sketch/schema-sketch').then(m => m.SchemaSketch),
  'flow-mermaid': () => import('./flow-mermaid/flow-mermaid').then(m => m.FlowMermaid),
  'api-sketch': () => import('./api-sketch/api-sketch').then(m => m.ApiSketch),
  'cron-studio': () => import('./cron-studio/cron-studio').then(m => m.CronStudio),
  'data-digest': () => import('./data-digest/data-digest').then(m => m.DataDigest),
  'context-packer': () => import('./context-packer/context-packer').then(m => m.ContextPacker),
  'form-builder': () => import('./form-builder/form-builder').then(m => m.FormBuilder),
  'regex-example': () => import('./regex-example/regex-example').then(m => m.RegexExample),
};
