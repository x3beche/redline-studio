import { Component } from '@angular/core';
import { ToolFrame } from '../frame';

/** Palette Forge: one colour into an accessible palette and light/dark tokens. The page itself is `public/tools/palette-forge.html`. */
@Component({
  selector: 'app-palette-forge',
  imports: [ToolFrame],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `<app-tool-frame src="tools/palette-forge.html" hide=".brand" />`,
})
export class PaletteForge {}
