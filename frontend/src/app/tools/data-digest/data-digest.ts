import { Component } from '@angular/core';
import { ToolFrame } from '../frame';

/** Data Digest: profile a large CSV or JSON into a compact brief for an LLM. The page itself is `public/tools/data-digest.html`. */
@Component({
  selector: 'app-data-digest',
  imports: [ToolFrame],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `<app-tool-frame src="tools/data-digest.html" hide=".brand" />`,
})
export class DataDigest {}
