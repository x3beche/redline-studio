import { Component } from '@angular/core';
import { ToolFrame } from '../frame';

/** Regex by Example: pick what should match in a text and get the regex, explained. The page itself is `public/tools/regex-example.html`. */
@Component({
  selector: 'app-regex-example',
  imports: [ToolFrame],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `<app-tool-frame src="tools/regex-example.html" hide=".brand" />`,
})
export class RegexExample {}
