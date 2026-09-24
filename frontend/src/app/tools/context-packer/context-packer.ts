import { Component } from '@angular/core';
import { ToolFrame } from '../frame';

/** Context Packer: pack code, logs and notes into one well-built prompt. The page itself is `public/tools/context-packer.html`. */
@Component({
  selector: 'app-context-packer',
  imports: [ToolFrame],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `<app-tool-frame src="tools/context-packer.html" hide=".brand" />`,
})
export class ContextPacker {}
