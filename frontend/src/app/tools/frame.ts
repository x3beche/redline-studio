import { Component, ElementRef, computed, inject, input, viewChild } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { CLOSE_TOOL } from './registry';

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

/** A tool that is a page of its own under `public/tools/`, self-contained
 *  so it can be updated by dropping in a new copy. It is framed, and takes
 *  the app's colours on the way in, so it looks like part of Redline in
 *  any theme. */
@Component({
  selector: 'app-tool-frame',
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `
<iframe #frame [src]="url()" [title]="src()" (load)="dress()"
        class="min-h-0 w-full flex-1" style="border: 0; background: var(--surface)"></iframe>`,
})
export class ToolFrame {
  /** A path under `public/` - the app's own files, never a user's. */
  src = input.required<string>();
  /** Things the page draws that the modal already says - its own title. */
  hide = input<string>();
  private frame = viewChild.required<ElementRef<HTMLIFrameElement>>('frame');
  private sanitizer = inject(DomSanitizer);
  private close = inject(CLOSE_TOOL, { optional: true });
  url = computed(() => this.sanitizer.bypassSecurityTrustResourceUrl(this.src()));

  /** The app's colours onto the page's own names, and its duplicate title
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
    style.textContent = (this.hide() ? `${this.hide()}{display:none!important}` : '')
      + `body{background:${app.getPropertyValue('--surface').trim()}}`
      // The app's thin scrollbars, not the browser's.
      + `*{scrollbar-width:thin;scrollbar-color:${app.getPropertyValue('--scroll-thumb').trim()} transparent}`;
    doc.head.appendChild(style);
    // Esc closes the modal from inside the page too - the keyboard is
    // there once somebody has clicked into it.
    doc.addEventListener('keydown', ev => { if (ev.key === 'Escape') this.close?.(); });
    // Its grid lines read a colour once when drawn; draw again in ours.
    this.frame().nativeElement.contentWindow?.dispatchEvent(new Event('resize'));
  }
}
