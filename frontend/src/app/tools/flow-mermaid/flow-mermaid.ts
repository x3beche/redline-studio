import { Component } from '@angular/core';
import { ToolFrame } from '../frame';

/** Flow to Mermaid: draw a flowchart with boxes and arrows, get Mermaid code. The page itself is `public/tools/flow-mermaid.html`. */
@Component({
  selector: 'app-flow-mermaid',
  imports: [ToolFrame],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `<app-tool-frame src="tools/flow-mermaid.html" hide=".brand" />`,
})
export class FlowMermaid {}
