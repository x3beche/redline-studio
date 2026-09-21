import { Component } from '@angular/core';
import { Editor } from './editor/editor';

@Component({
  selector: 'app-root',
  imports: [Editor],
  template: '<app-editor />',
})
export class App {}
