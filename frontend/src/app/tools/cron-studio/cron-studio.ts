import { Component } from '@angular/core';
import { ToolFrame } from '../frame';

/** Cron Studio: build a cron expression, see when it next runs. The page itself is `public/tools/cron-studio.html`. */
@Component({
  selector: 'app-cron-studio',
  imports: [ToolFrame],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `<app-tool-frame src="tools/cron-studio.html" hide=".brand" />`,
})
export class CronStudio {}
