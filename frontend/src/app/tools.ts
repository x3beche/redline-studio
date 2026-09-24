import {
  Component, ElementRef, HostListener, computed, inject, input, output, viewChild,
} from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';

/** Small standalone tools, opened from the menu on the wordmark.
 *
 *  A tool is a page of its own under `public/tools/`, kept exactly as it
 *  was written so it can be updated by dropping in a new copy. It opens in
 *  a modal over whatever room is on screen, and takes the app's colours on
 *  the way in, so it looks like part of Redline in any theme. A new tool is
 *  a file there and a line here.
 */
export interface ToolPage {
  id: string;
  name: string;
  /** One line, for the menu. */
  blurb: string;
  src: string;
  /** Things the tool draws that the modal already says - its own title. */
  hide?: string;
}

export const TOOL_PAGES: ToolPage[] = [
  {
    id: 'grid-sketch',
    name: 'Grid Sketch',
    blurb: 'draw a layout on a grid, copy it as a prompt, CSS or JSON',
    src: 'tools/grid-sketch.html',
    hide: '.brand',
  },
];

/** The tool's own colour names, and which of the app's tokens each takes. */
const TOKENS: [string, string][] = [
  ['--paper', '--surface'],
  ['--surface', '--surface-2'],
  ['--sunken', '--surface'],
  ['--ink', '--ink'],
  ['--ink-soft', '--ink-dim'],
  ['--line', '--line'],
  ['--line-soft', '--line'],
  ['--accent', '--accent'],
  ['--accent-ink', '--ink-bright'],
  ['--danger', '--danger'],
];

@Component({
  selector: 'app-tool-modal',
  template: `
<div class="fixed inset-0 flex items-center justify-center p-6"
     style="background: var(--scrim); z-index: 1100" (click)="close.emit()">
  <div class="tcv-card flex h-[88vh] w-[min(78rem,94vw)] flex-col overflow-hidden"
       (click)="$event.stopPropagation()">
    <div class="flex shrink-0 items-center gap-2 px-4 py-2"
         style="border-bottom: 1px solid var(--line)">
      <span class="tcv-label" style="color: var(--ink)">{{ tool().name }}</span>
      <span class="truncate text-[11px]" style="color: var(--ink-dim)">{{ tool().blurb }}</span>
      <button (click)="close.emit()" class="tcv-chip ml-auto" title="close (Esc)">×</button>
    </div>
    <iframe #frame [src]="url()" [title]="tool().name" (load)="dress()"
            class="min-h-0 w-full flex-1" style="border: 0; background: var(--surface)"></iframe>
  </div>
</div>`,
})
export class ToolModal {
  tool = input.required<ToolPage>();
  close = output<void>();
  private frame = viewChild.required<ElementRef<HTMLIFrameElement>>('frame');
  private sanitizer = inject(DomSanitizer);
  /** Only ever a path from TOOL_PAGES above - the app's own files - so it
   *  is trusted as a frame source. */
  url = computed(() => this.sanitizer.bypassSecurityTrustResourceUrl(this.tool().src));

  @HostListener('document:keydown.escape')
  onEsc() { this.close.emit(); }

  /** The app's colours onto the tool's own names, and its duplicate title
   *  hidden. Same origin, so this is a style on its root and nothing more. */
  dress() {
    const doc = this.frame().nativeElement.contentDocument;
    if (!doc) return;
    const app = getComputedStyle(document.documentElement);
    const root = doc.documentElement;
    const light = document.documentElement.dataset['theme'] === 'light';
    root.setAttribute('data-theme', light ? 'light' : 'dark');
    for (const [theirs, ours] of TOKENS) {
      const v = app.getPropertyValue(ours).trim();
      if (v) root.style.setProperty(theirs, v);
    }
    root.style.setProperty('--fill-alpha', light ? '0.16' : '0.30');
    const style = doc.createElement('style');
    style.textContent = (this.tool().hide ? `${this.tool().hide}{display:none!important}` : '')
      + 'body{background:var(--paper)}'
      // The app's thin scrollbars, not the browser's.
      + `*{scrollbar-width:thin;scrollbar-color:${app.getPropertyValue('--scroll-thumb').trim()} transparent}`;
    doc.head.appendChild(style);
    // Esc closes the modal from inside the tool too - the keyboard is
    // there once somebody has clicked into it.
    doc.addEventListener('keydown', ev => { if (ev.key === 'Escape') this.close.emit(); });
    // Its grid lines read a colour once when drawn; draw again in ours.
    this.frame().nativeElement.contentWindow?.dispatchEvent(new Event('resize'));
  }
}
