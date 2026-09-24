import { Component } from '@angular/core';
import { ToolFrame } from '../frame';

/** Screenshot Annotator: mark up a screenshot and turn the marks into a fix list. The page itself is `public/tools/screenshot-annotator.html`. */
@Component({
  selector: 'app-screenshot-annotator',
  imports: [ToolFrame],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `<app-tool-frame src="tools/screenshot-annotator.html" hide=".brand" />`,
})
export class ScreenshotAnnotator {}
