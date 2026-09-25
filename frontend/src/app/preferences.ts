import { Component, Injectable, inject, signal } from '@angular/core';
import { LIGHT_THEMES, THEMES, THEME_NAMES, Theme, currentTheme, setTheme } from '../theme';
import { LANG, LANGS, Lang, T, setLang } from './i18n';
import { redlineTheme } from './rooms/code-view';

/** Preferences: the theme, the language, and the keyboard shortcuts.
 *  Per browser - they are about the person at this screen. Opened from
 *  the user menu, from Ctrl+K, and with "?" (the shortcuts page).
 */
export type PrefsTab = 'appearance' | 'language' | 'shortcuts';

@Injectable({ providedIn: 'root' })
export class Prefs {
  open = signal<PrefsTab | null>(null);
  theme = signal<Theme>(currentTheme());

  wear(t: Theme) {
    this.theme.set(setTheme(t));
    // An open code editor takes the new colours at once.
    const m = (window as unknown as { monaco?: Parameters<typeof redlineTheme>[0] }).monaco;
    if (m) m.editor.setTheme(redlineTheme(m));
  }
}

/** What each theme looks like, for its swatch: page, panel, ink, accent.
 *  Each theme's own colours whichever is on - so they are pigment here,
 *  like the pens: the picture of a theme, not the chrome around it. */
const SWATCH: Record<Theme, string[]> = { // theme:pigment
  default: ['#444', '#333', '#ddd', '#53a0e3'], // theme:pigment
  light: ['#eceef1', '#f6f7f9', '#232a31', '#1d6fb8'], // theme:pigment
  oled: ['#000', '#0a0c0e', '#d8dde3', '#4a9be0'], // theme:pigment
  'github-dark': ['#0d1117', '#161b22', '#e6edf3', '#2f81f7'], // theme:pigment
  'atom-one-dark': ['#282c34', '#21252b', '#abb2bf', '#c678dd'], // theme:pigment
  'one-dark-pro': ['#282c34', '#21252b', '#abb2bf', '#4d78cc'], // theme:pigment
  'vscode-dark': ['#1f1f1f', '#181818', '#cccccc', '#0078d4'], // theme:pigment
  'dracula': ['#282a36', '#21222c', '#f8f8f2', '#bd93f9'], // theme:pigment
  'tokyo-night': ['#1a1b26', '#16161e', '#c0caf5', '#7aa2f7'], // theme:pigment
  'catppuccin-mocha': ['#1e1e2e', '#181825', '#cdd6f4', '#89b4fa'], // theme:pigment
  'nord': ['#2e3440', '#272c36', '#d8dee9', '#88c0d0'], // theme:pigment
  'monokai': ['#272822', '#1e1f1c', '#f8f8f2', '#66d9ef'], // theme:pigment
  'gruvbox-dark': ['#282828', '#1d2021', '#ebdbb2', '#83a598'], // theme:pigment
  'solarized-dark': ['#002b36', '#00212b', '#93a1a1', '#268bd2'], // theme:pigment
  'material-palenight': ['#292d3e', '#232635', '#a6accd', '#82aaff'], // theme:pigment
  'night-owl': ['#011627', '#01111d', '#d6deeb', '#82aaff'], // theme:pigment
  'ayu-mirage': ['#1f2430', '#1a1f29', '#cccac2', '#ffcc66'], // theme:pigment
  'rose-pine': ['#191724', '#1f1d2e', '#e0def4', '#c4a7e7'], // theme:pigment
  'kanagawa': ['#1f1f28', '#16161d', '#dcd7ba', '#7e9cd8'], // theme:pigment
  'synthwave-84': ['#262335', '#1e1a2b', '#ececf2', '#ff7edb'], // theme:pigment
  'github-light': ['#ffffff', '#f6f8fa', '#1f2328', '#0969da'], // theme:pigment
  'vscode-light': ['#ffffff', '#f8f8f8', '#3b3b3b', '#005fb8'], // theme:pigment
  'solarized-light': ['#fdf6e3', '#eee8d5', '#586e75', '#268bd2'], // theme:pigment
  'catppuccin-latte': ['#eff1f5', '#e6e9ef', '#4c4f69', '#1e66f5'], // theme:pigment
  'gruvbox-light': ['#fbf1c7', '#f2e5bc', '#3c3836', '#076678'], // theme:pigment
  'high-contrast': ['#000000', '#000000', '#ffffff', '#f38518'], // theme:pigment
};

interface Shortcut { keys: string[]; what: string }

@Component({
  selector: 'app-preferences',
  imports: [T],
  host: { '(document:keydown)': 'key($event)' },
  template: `
@if (prefs.open(); as tab) {
  <div class="tcv-tokens-back" (click)="prefs.open.set(null)">
    <div class="tcv-tokens tcv-prefs" (click)="$event.stopPropagation()" role="dialog" [attr.aria-label]="'Preferences' | t">
      <h2>{{ 'Preferences' | t }}</h2>
      <div class="tcv-prefs-tabs" role="tablist">
        @for (x of tabs; track x.id) {
          <button class="tcv-notes-chip" role="tab" [attr.data-on]="tab === x.id ? 1 : null"
                  (click)="prefs.open.set(x.id)">{{ x.label | t }}</button>
        }
      </div>

      @switch (tab) {
        @case ('appearance') {
          <p>{{ 'The whole window, the 3D backdrop and the code editor follow it.' | t }}</p>
          @for (grp of groups; track grp.name) {
          <div class="tcv-prefs-group">{{ grp.name | t }}</div>
          <div class="tcv-prefs-themes">
            @for (th of grp.themes; track th) {
              <button class="tcv-prefs-theme" [attr.data-on]="prefs.theme() === th ? 1 : null" (click)="prefs.wear(th)">
                <span class="tcv-prefs-swatch">
                  @for (c of swatch[th]; track $index) { <i [style.background]="c"></i> }
                </span>
                <span>{{ names[th] }}</span>
              </button>
            }
          </div>
          }
        }
        @case ('language') {
          <p>{{ 'The words Redline says. Names of models, boards, parts and code stay as they are.' | t }}</p>
          <div class="tcv-prefs-themes">
            @for (l of langs; track l.id) {
              <button class="tcv-prefs-theme" [attr.data-on]="lang() === l.id ? 1 : null" (click)="setLang(l.id)">
                <span class="tcv-prefs-flag">{{ l.id.toUpperCase() }}</span><span>{{ l.name }}</span>
              </button>
            }
          </div>
        }
        @case ('shortcuts') {
          @for (g of shortcuts; track g.group) {
            <div class="tcv-prefs-group">{{ g.group | t }}</div>
            @for (s of g.items; track s.what) {
              <div class="tcv-prefs-key">
                <span>{{ s.what | t }}</span>
                <span class="tcv-prefs-keys">@for (k of s.keys; track $index) { <kbd>{{ k }}</kbd> }</span>
              </div>
            }
          }
        }
      }
      <div class="tcv-tokens-end"><button class="tcv-btn" (click)="prefs.open.set(null)">{{ 'Close' | t }}</button></div>
    </div>
  </div>
}`,
})
export class Preferences {
  prefs = inject(Prefs);
  readonly themes = THEMES;
  /** Dark ones first, then the light ones. */
  readonly groups = [{ name: 'Dark', themes: THEMES.filter(t => !LIGHT_THEMES.has(t)) },
                     { name: 'Light', themes: THEMES.filter(t => LIGHT_THEMES.has(t)) }];
  readonly names = THEME_NAMES;
  readonly swatch = SWATCH;
  readonly langs = LANGS;
  readonly lang = LANG;
  readonly tabs: { id: PrefsTab; label: string }[] = [
    { id: 'appearance', label: 'Appearance' }, { id: 'language', label: 'Language' },
    { id: 'shortcuts', label: 'Keyboard shortcuts' }];
  readonly shortcuts: { group: string; items: Shortcut[] }[] = [
    { group: 'Anywhere', items: [
      { keys: ['Ctrl', 'K'], what: 'Open the command palette: go anywhere, do anything, search everything' },
      { keys: ['Alt', 'N'], what: 'A quick note, from any room' },
      { keys: ['?'], what: 'This page of shortcuts' },
      { keys: ['Esc'], what: 'Close a dialog, the palette or the quick note' },
      { keys: ['↑', '↓', 'Enter'], what: 'Move in the palette, then open' },
    ] },
    { group: 'In the code', items: [
      { keys: ['Ctrl', 'S'], what: 'Save the open file' },
      { keys: ['Ctrl', 'F'], what: 'Search in the file / replace' },
      { keys: ['Ctrl', 'click'], what: 'Go to a file named in an import (Ctrl+click)' },
    ] },
    { group: 'In Notes', items: [
      { keys: ['Enter'], what: 'Keep the note' },
      { keys: ['Shift', 'Enter'], what: 'A new line' },
      { keys: ['/'], what: 'Search notes' },
      { keys: ['↑', '↓'], what: 'Previous / next note' },
      { keys: ['Esc'], what: 'Finish editing' },
    ] },
  ];
  setLang(l: Lang) { setLang(l); }

  constructor() {
    // "?" opens the shortcuts wherever you are - unless you are typing it.
    window.addEventListener('keydown', e => {
      const el = e.target as HTMLElement;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable
        || !!el.closest?.('.monaco-editor');
      if (e.key === '?' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        this.prefs.open.set(this.prefs.open() === 'shortcuts' ? null : 'shortcuts');
      }
    }, true);
  }

  key(e: KeyboardEvent) { if (e.key === 'Escape' && this.prefs.open()) this.prefs.open.set(null); }
}
