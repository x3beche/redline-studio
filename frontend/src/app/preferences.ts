import { Component, Injectable, computed, inject, signal } from '@angular/core';
import { LIGHT_THEMES, THEMES, THEME_NAMES, Theme, currentTheme, setTheme } from '../theme';
import { LANG, LANGS, Lang, T, setLang, t } from './i18n';
import { Auth } from './auth';
import { PALETTE } from './rooms/charts';
import { redlineTheme } from './rooms/code-view';
import { LlmSettingsPanel } from './llm-settings';
import { ProxySettingsPanel } from './proxy-settings';

/** Settings, a tab of its own: the theme, the language and the keyboard
 *  shortcuts - per browser, about the person at this screen - and the
 *  server's: the LLM keys and models (llm-settings.ts) and the proxy for
 *  the part lookups (proxy-settings.ts). Opened from
 *  the user menu, from Ctrl+K, and with "?" (the shortcuts page).
 */
export type PrefsTab = 'appearance' | 'language' | 'llm' | 'proxy' | 'shortcuts';

@Injectable({ providedIn: 'root' })
export class Prefs {
  /** Ask for a section: the shell (app.ts) opens the Settings tab on it and
   *  sets this back to null. How the user menu, the palette and "?" get there. */
  open = signal<PrefsTab | null>(null);
  /** The section on screen in the Settings tab. */
  tab = signal<PrefsTab>('appearance');
  theme = signal<Theme>(currentTheme());

  constructor() {
    // "?" opens the shortcuts wherever you are - unless you are typing it.
    window.addEventListener('keydown', e => {
      const el = e.target as HTMLElement;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable
        || !!el.closest?.('.monaco-editor');
      if (e.key === '?' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        this.open.set('shortcuts');
      }
    }, true);
  }

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
interface NavItem { id: PrefsTab; label: string; about: string; ico: string; blurb: string }

@Component({
  selector: 'app-room-settings',
  imports: [T, LlmSettingsPanel, ProxySettingsPanel],
  styleUrl: './settings.css',
  template: `
<div class="tcv-room absolute inset-0 flex min-h-0">
  <nav class="st-list" [attr.aria-label]="'Settings' | t">
    <div class="st-list-head">
      <b>{{ 'Settings' | t }}</b>
      <span>{{ 'How Redline looks here, and what the server uses' | t }}</span>
    </div>
    <div class="st-list-scroll">
      @for (g of nav; track g.group) {
        <div class="st-group"><span>{{ g.group | t }}</span><span>{{ g.items.length }}</span></div>
        @for (x of g.items; track x.id) {
          <button class="st-item" [attr.data-on]="prefs.tab() === x.id ? 1 : null" (click)="prefs.tab.set(x.id)">
            <span class="st-ico" aria-hidden="true">{{ x.ico }}</span>
            <span class="st-item-text">
              <span class="st-item-top">
                <span class="st-item-title">{{ x.label | t }}</span>
                @if (meta(x.id); as m) { <span class="st-item-meta">{{ m }}</span> }
              </span>
              <span class="st-item-blurb">{{ x.about | t }}</span>
            </span>
          </button>
        }
      }
    </div>
  </nav>

  <section class="st-body">
    @if (item(); as x) {
      <header class="st-head">
        <span class="st-head-name">{{ x.label | t }}</span>
        <span class="st-badge" [attr.data-tone]="server(x.id) ? 'accent' : null">{{ (server(x.id) ? 'server' : 'this browser') | t }}</span>
        <span class="st-head-blurb">{{ x.blurb | t }}</span>
        <span class="st-head-meta">
          @if (server(x.id)) {
            <span class="st-badge" [attr.data-tone]="canEdit ? 'ok' : 'warn'">{{ (canEdit ? 'you can change these' : 'read-only for you') | t }}</span>
          } @else {
            <span>{{ 'kept in this browser only' | t }}</span>
          }
        </span>
      </header>
    }
    <div class="st-stage">
      @switch (prefs.tab()) {
        @case ('appearance') {
          <div class="st-page">
            <div class="st-now">
              <div class="st-mock" aria-hidden="true">
                <div class="st-mock-bar"><i></i><i></i><i></i><span></span></div>
                <div class="st-mock-body">
                  <div class="st-mock-side"><i></i><i></i><i></i><i></i></div>
                  <div class="st-mock-main">
                    <div class="l1"></div><div class="l2"></div><div class="l2" style="width: 60%"></div>
                    <div class="st-mock-series">@for (c of seriesVars; track c) { <i [style.background]="c"></i> }</div>
                    <div class="st-mock-row">
                      <span class="st-mock-btn"></span>
                      <span class="st-mock-dot" style="background: var(--ok)"></span>
                      <span class="st-mock-dot" style="background: var(--warn)"></span>
                      <span class="st-mock-dot" style="background: var(--danger)"></span>
                    </div>
                  </div>
                </div>
              </div>
              <div class="st-card">
                <div class="st-card-head"><h3>{{ 'Now wearing' | t }}</h3>
                  <span class="st-sub">{{ 'The whole window, the 3D backdrop and the code editor follow it.' | t }}</span></div>
                <div class="st-card-body">
                  <div class="st-tiles">
                    <div class="st-tile wide"><span>{{ 'Theme' | t }}</span><b>{{ names[prefs.theme()] }}</b></div>
                    <div class="st-tile"><span>{{ 'Kind' | t }}</span><b>{{ (isLight(prefs.theme()) ? 'Light' : 'Dark') | t }}</b></div>
                    <div class="st-tile"><span>{{ 'Available' | t }}</span><b>{{ themes.length }}</b>
                      <small>{{ groups[0].themes.length }} {{ 'dark' | t }} · {{ groups[1].themes.length }} {{ 'light' | t }}</small></div>
                  </div>
                  <div class="st-row">
                    <span class="st-sec-title">{{ 'Show' | t }}</span>
                    <div class="st-seg">
                      @for (f of themeFilters; track f) {
                        <button [class.on]="themeFilter() === f" (click)="themeFilter.set(f)">{{ f | t }}</button>
                      }
                    </div>
                  </div>
                </div>
              </div>
            </div>
            @for (grp of groups; track grp.name) {
              @if (themeFilter() === 'All' || themeFilter() === grp.name) {
                <div class="st-card">
                  <div class="st-card-head"><h3>{{ grp.name | t }}</h3><span class="st-sub">{{ grp.themes.length }} {{ 'themes' | t }}</span></div>
                  <div class="st-card-body">
                    <div class="st-themes">
                      @for (th of grp.themes; track th) {
                        <button class="st-theme" [attr.data-on]="prefs.theme() === th ? 1 : null" (click)="prefs.wear(th)">
                          <span class="st-swatch">@for (c of swatch[th]; track $index) { <i [style.background]="c"></i> }</span>
                          <span class="st-theme-name">{{ names[th] }}@if (prefs.theme() === th) { <em>● {{ 'on' | t }}</em> }</span>
                        </button>
                      }
                    </div>
                  </div>
                </div>
              }
            }
          </div>
        }
        @case ('language') {
          <div class="st-page">
            <p class="st-lead">{{ 'The words Redline says. Names of models, boards, parts and code stay as they are.' | t }}</p>
            <div class="st-card">
              <div class="st-card-head"><h3>{{ 'Language' | t }}</h3>
                <div class="st-right"><div class="st-seg">
                  @for (l of langs; track l.id) { <button [class.on]="lang() === l.id" (click)="setLang(l.id)">{{ l.id.toUpperCase() }}</button> }
                </div></div></div>
              <div class="st-card-body">
                <div class="st-langs">
                  @for (l of langs; track l.id) {
                    <button class="st-lang" [attr.data-on]="lang() === l.id ? 1 : null" (click)="setLang(l.id)">
                      <span class="st-lang-code">{{ l.id.toUpperCase() }}</span>
                      <span class="st-lang-text"><b>{{ l.name }}</b><span>{{ sample[l.id] }}</span></span>
                    </button>
                  }
                </div>
                <div class="st-tiles">
                  <div class="st-tile"><span>{{ 'Speaking' | t }}</span><b>{{ langName() }}</b></div>
                  <div class="st-tile"><span>{{ 'Kept' | t }}</span><b>{{ 'this browser' | t }}</b></div>
                  <div class="st-tile"><span>{{ 'Never translated' | t }}</span><b>{{ 'names, code' | t }}</b></div>
                </div>
              </div>
            </div>
          </div>
        }
        @case ('llm') { <app-llm-settings /> }
        @case ('proxy') { <app-proxy-settings /> }
        @case ('shortcuts') {
          <div class="st-page">
            <div class="st-row">
              <input class="st-in" style="width: 280px" type="search" [placeholder]="'Find a shortcut' | t"
                     [value]="keyQuery()" (input)="keyQuery.set($any($event.target).value)">
              <span class="st-sub">{{ shortcutCount() }} {{ 'shortcuts' | t }} · {{ 'press ? anywhere to come back here' | t }}</span>
            </div>
            <div class="st-keys-grid">
              @for (g of shownShortcuts(); track g.group) {
                <div class="st-card">
                  <div class="st-card-head"><h3>{{ g.group | t }}</h3><span class="st-right st-sub">{{ g.items.length }}</span></div>
                  <div class="st-list-body">
                    @for (s of g.items; track s.what) {
                      <div class="st-short">
                        <span>{{ s.what | t }}</span>
                        <span class="st-kbd">@for (k of s.keys; track $index) { <kbd>{{ k }}</kbd> }</span>
                      </div>
                    }
                  </div>
                </div>
              } @empty {
                <div class="st-empty">{{ 'No shortcut matches.' | t }}</div>
              }
            </div>
          </div>
        }
      }
    </div>
  </section>
</div>`,
})
export class RoomSettings {
  prefs = inject(Prefs);
  readonly canEdit = inject(Auth).can('settings');
  readonly themes = THEMES;
  /** Dark ones first, then the light ones. */
  readonly groups = [{ name: 'Dark', themes: THEMES.filter(t => !LIGHT_THEMES.has(t)) },
                     { name: 'Light', themes: THEMES.filter(t => LIGHT_THEMES.has(t)) }];
  readonly themeFilters = ['All', 'Dark', 'Light'];
  themeFilter = signal('All');
  readonly names = THEME_NAMES;
  readonly swatch = SWATCH;
  readonly seriesVars = PALETTE;
  readonly langs = LANGS;
  readonly lang = LANG;
  /** A few of the app's words in each language, as each one's sample. */
  readonly sample: Record<Lang, string> = { en: 'Save · Notes · Analytics', tr: 'Kaydet · Notlar · Analitik' };
  readonly nav: { group: string; items: NavItem[] }[] = [
    { group: 'This browser', items: [
      { id: 'appearance', label: 'Appearance', about: 'theme', ico: '◐',
        blurb: 'Pick a theme; the whole window follows it.' },
      { id: 'language', label: 'Language', about: 'English or Türkçe', ico: 'Aa',
        blurb: 'Which language the interface speaks.' },
      { id: 'shortcuts', label: 'Keyboard shortcuts', about: 'Ctrl+K, Alt+N, ?', ico: '⌘',
        blurb: 'Every key that does something, by where it works.' },
    ] },
    { group: 'The server', items: [
      { id: 'llm', label: 'LLM settings', about: 'API keys, and which model does what', ico: '✦',
        blurb: 'Keys, which model does each job, and what they used.' },
      { id: 'proxy', label: 'Proxy', about: 'a second way out for EasyEDA lookups', ico: '⇄',
        blurb: 'A second way out for the part lookups, and the traffic it carried.' },
    ] },
  ];
  item = computed(() => this.nav.flatMap(g => g.items).find(x => x.id === this.prefs.tab()) ?? null);
  label(id: PrefsTab) { return this.nav.flatMap(g => g.items).find(x => x.id === id)?.label ?? id; }
  server(id: PrefsTab) { return id === 'llm' || id === 'proxy'; }
  isLight(t: Theme) { return LIGHT_THEMES.has(t); }
  langName = computed(() => LANGS.find(l => l.id === this.lang())?.name ?? this.lang());
  /** The figure beside each section in the list. */
  meta(id: PrefsTab): string | null {
    if (id === 'appearance') return this.names[this.prefs.theme()];
    if (id === 'language') return this.lang().toUpperCase();
    if (id === 'shortcuts') return String(this.shortcutCount());
    return null;
  }
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
  shortcutCount() { return this.shortcuts.reduce((a, g) => a + g.items.length, 0); }
  keyQuery = signal('');
  /** The shortcuts whose words or keys hold every word typed, in either language. */
  shownShortcuts = computed(() => {
    const words = this.keyQuery().toLowerCase().split(/\s+/).filter(Boolean);
    this.lang();
    if (!words.length) return this.shortcuts;
    return this.shortcuts
      .map(g => ({ group: g.group, items: g.items.filter(s => {
        const hay = (s.what + ' ' + t(s.what) + ' ' + s.keys.join(' ')).toLowerCase();
        return words.every(w => hay.includes(w));
      }) }))
      .filter(g => g.items.length);
  });
  setLang(l: Lang) { setLang(l); }
}
