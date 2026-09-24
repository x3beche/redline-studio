import { Component } from '@angular/core';
import { ToolFrame } from '../frame';

/** Grid Sketch: draw a layout on a grid, and take it away as a prompt,
 *  CSS or JSON. The page itself is `public/tools/grid-sketch.html`. */
@Component({
  selector: 'app-grid-sketch',
  imports: [ToolFrame],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `<app-tool-frame src="tools/grid-sketch.html" hide=".brand" />`,
})
export class GridSketch {}
