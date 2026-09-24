import { Component } from '@angular/core';
import { ToolFrame } from '../frame';

/** Form Builder: build a form with its rules, get Zod, types and a React component. The page itself is `public/tools/form-builder.html`. */
@Component({
  selector: 'app-form-builder',
  imports: [ToolFrame],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `<app-tool-frame src="tools/form-builder.html" hide=".brand" />`,
})
export class FormBuilder {}
