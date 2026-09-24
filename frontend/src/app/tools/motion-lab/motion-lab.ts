import { Component } from '@angular/core';
import { ToolFrame } from '../frame';

/** Motion Lab: shape an easing curve and timing, take it as CSS or JS. The page itself is `public/tools/motion-lab.html`. */
@Component({
  selector: 'app-motion-lab',
  imports: [ToolFrame],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `<app-tool-frame src="tools/motion-lab.html" hide=".brand" />`,
})
export class MotionLab {}
