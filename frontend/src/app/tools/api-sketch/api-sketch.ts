import { Component } from '@angular/core';
import { ToolFrame } from '../frame';

/** API Sketch: define endpoints, get OpenAPI, curl and a TypeScript client. The page itself is `public/tools/api-sketch.html`. */
@Component({
  selector: 'app-api-sketch',
  imports: [ToolFrame],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `<app-tool-frame src="tools/api-sketch.html" hide=".brand" />`,
})
export class ApiSketch {}
