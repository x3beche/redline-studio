import { Component } from '@angular/core';
import { ToolFrame } from '../frame';

/** Schema Sketch: draw tables and relations, get SQL, Prisma and Mermaid. The page itself is `public/tools/schema-sketch.html`. */
@Component({
  selector: 'app-schema-sketch',
  imports: [ToolFrame],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `<app-tool-frame src="tools/schema-sketch.html" hide=".brand" />`,
})
export class SchemaSketch {}
