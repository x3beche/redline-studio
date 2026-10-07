import { Component, Injectable, computed, inject, signal } from '@angular/core';
import { CustomTheme, LIGHT_THEMES, THEMES, THEME_NAMES, Theme, ThemeId, cachedCustom, currentTheme, isCustom, isLightTheme, setTheme } from '../theme';
import { LANG, LANGS, Lang, T, setLang, t } from './i18n';
import { Auth } from './auth';
import { PALETTE } from './rooms/charts';
import { redlineTheme } from './rooms/code-view';
import { LlmSettingsPanel } from './llm-settings';
import { ProxySettingsPanel } from './proxy-settings';
import { CostsSettingsPanel } from './costs-settings';
import { TelegramSettingsPanel } from './telegram-settings';
import { TopbarSettingsPanel } from './topbar-settings';
import { TopBar } from './topbar';
import { CURRENCY } from './money';
import { CustomThemesPanel } from './custom-themes';
import { ProfileSettingsPanel } from './profile-settings';
import { TokensSettingsPanel } from './tokens-settings';
import { AdminUsersPanel } from './admin-users';

/** Settings, a tab of its own: the theme, the language and the keyboard
 *  shortcuts - per browser, about the person at this screen - and the
 *  server's: the LLM keys and models (llm-settings.ts) and the proxy for
 *  the part lookups (proxy-settings.ts), and what things cost and in which
 *  currency (costs-settings.ts). Opened from
 *  the user menu, from Ctrl+K, and with "?" (the shortcuts page). The owner
 *  and the admins also get the admin panel: the accounts (admin-users.ts).
 */
export type PrefsTab = 'profile' | 'appearance' | 'language' | 'llm' | 'proxy' | 'costs' | 'telegram' | 'tokens' | 'shortcuts' | 'topbar' | 'admin';

@Injectable({ providedIn: 'root' })
export class Prefs {
  /** Ask for a section: the shell (app.ts) opens the Settings tab on it and
   *  sets this back to null. How the user menu, the palette and "?" get there. */
  open = signal<PrefsTab | null>(null);
  /** The section on screen in the Settings tab. */
  tab = signal<PrefsTab>('profile');
  theme = signal<ThemeId>(currentTheme());

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

  /** Wear a theme; a custom one comes whole (custom-themes.ts). */
  wear(t: ThemeId, custom?: CustomTheme) {
    this.theme.set(setTheme(t, custom));
    // An open code editor takes the new colours at once.
    const m = (window as unknown as { monaco?: Parameters<typeof redlineTheme>[0] }).monaco;
    if (m) m.editor.setTheme(redlineTheme(m));
  }

  /** What a theme is called where it is shown. */
  nameOf(t: ThemeId): string {
    if (!isCustom(t)) return THEME_NAMES[t];
    const c = cachedCustom();
    return c && 'custom:' + c.id === t ? c.name : t.slice(7);
  }
}

/** What each theme looks like, for its swatch: page, panel, ink, accent.
 *  Each theme's own colours whichever is on - so they are pigment here,
 *  like the pens: the picture of a theme, not the chrome around it. */
const SWATCH: Record<Theme, string[]> = { // theme:pigment
  default: ['#444', '#333', '#ddd', '#53a0e3'], // theme:pigment
  light: ['#eceef1', '#f6f7f9', '#232a31', '#1d6fb8'], // theme:pigment
  oled: ['#000', '#0a0c0e', '#d8dde3', '#4a9be0'], // theme:pigment
  'vercel-dark': ['#000', '#0a0a0a', '#ededed', '#0070f3'], // theme:pigment
  'spartan-dark': ['#09090b', '#18181b', '#fafafa', '#2662d9'], // theme:pigment
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
/** `ico` is an SVG path on a 24 px grid, drawn as a 1.75 px line (lucide's shapes). */
interface NavItem { id: PrefsTab; label: string; about: string; ico: string; blurb: string }

@Component({
  selector: 'app-room-settings',
  imports: [T, ProfileSettingsPanel, CustomThemesPanel, LlmSettingsPanel, ProxySettingsPanel, CostsSettingsPanel, TelegramSettingsPanel, TopbarSettingsPanel, TokensSettingsPanel, AdminUsersPanel],
  styleUrl: './settings.css',
  template: `
<div class="tcv-room absolute inset-0 flex min-h-0">
  <nav class="st-list" [attr.aria-label]="'Settings' | t">
    <div class="st-list-head">
      <b>{{ 'Settings' | t }}</b>
      <span>{{ 'How Redline looks here, and what the server uses' | t }}</span>
    </div>
    <div class="st-list-scroll">
      @for (g of shownNav(); track g.group) {
        <div class="st-group"><span>{{ g.group | t }}</span><span>{{ g.items.length }}</span></div>
        @for (x of g.items; track x.id) {
          <button class="st-item" [attr.data-on]="prefs.tab() === x.id ? 1 : null" (click)="prefs.tab.set(x.id)">
            <svg class="st-ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path [attr.d]="x.ico"/></svg>
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
        <span class="st-badge" [attr.data-tone]="server(x.id) || x.id === 'profile' || x.id === 'admin' ? 'accent' : null">{{ (x.id === 'profile' ? 'your account' : x.id === 'admin' ? 'accounts' : server(x.id) ? 'server' : 'this browser') | t }}</span>
        <span class="st-head-blurb">{{ x.blurb | t }}</span>
        <span class="st-head-meta">
          @if (x.id === 'profile') {
            <span>{{ 'only you can change these' | t }}</span>
          } @else if (x.id === 'admin') {
            <span>{{ (auth.state()?.role === 'owner' ? 'owner: everything here' : 'admin: manages user accounts') | t }}</span>
          } @else if (server(x.id)) {
            <span class="st-badge" [attr.data-tone]="mayEdit(x.id) ? 'ok' : 'warn'">{{ (mayEdit(x.id) ? 'you can change these' : 'read-only for you') | t }}</span>
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
                    <div class="st-tile wide"><span>{{ 'Theme' | t }}</span><b>{{ prefs.nameOf(prefs.theme()) }}</b></div>
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
            <app-custom-themes [filter]="themeFilter()" />
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
        @case ('profile') { <app-profile-settings /> }
        @case ('llm') { <app-llm-settings /> }
        @case ('proxy') { <app-proxy-settings /> }
        @case ('costs') { <app-costs-settings /> }
        @case ('telegram') { <app-telegram-settings /> }
        @case ('tokens') { <app-tokens-settings /> }
        @case ('admin') { @if (auth.admin()) { <app-admin-users /> } }
        @case ('topbar') { <app-topbar-settings /> }
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
  auth = inject(Auth);
  readonly canEdit = this.auth.can('settings');
  private topbar = inject(TopBar);
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
    { group: 'You', items: [
      { id: 'profile', label: 'Profile', about: 'name, picture, password, sessions', ico: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 3a4 4 0 1 0 0 8a4 4 0 1 0 0-8',
        blurb: 'Who you are here: your name and picture, your password, and where you are signed in.' },
    ] },
    { group: 'This browser', items: [
      { id: 'appearance', label: 'Appearance', about: 'theme', ico: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 3v18M12 8h6M12 12h9M12 16h6',
        blurb: 'Pick a theme; the whole window follows it.' },
      { id: 'language', label: 'Language', about: 'English or Türkçe', ico: 'M5 8l6 6M4 14l6-6 2-3M2 5h12M7 2h1M22 22l-5-10-5 10M14 18h6',
        blurb: 'Which language the interface speaks.' },
      { id: 'topbar', label: 'Top bar', about: 'order, hidden tabs, compact', ico: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM3 9h18',
        blurb: 'Which tabs the top bar shows, in what order, and how.' },
      { id: 'shortcuts', label: 'Keyboard shortcuts', about: 'Ctrl+K, Alt+N, ?', ico: 'M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zM6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10',
        blurb: 'Every key that does something, by where it works.' },
    ] },
    { group: 'The server', items: [
      { id: 'llm', label: 'LLM settings', about: 'API keys, and which model does what', ico: 'M7 7h10v10H7zM10 10h4v4h-4zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4',
        blurb: 'Keys, which model does each job, and what they used.' },
      { id: 'proxy', label: 'Proxy', about: 'a second way out for EasyEDA lookups', ico: 'M8 3L4 7l4 4M4 7h16M16 21l4-4-4-4M20 17H4',
        blurb: 'A second way out for the part lookups, and the traffic it carried.' },
      { id: 'costs', label: 'Costs & currency', about: 'subscriptions, electricity, exchange rates', ico: 'M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zM12 9.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5M6 12h.01M18 12h.01',
        blurb: 'What Redline costs to run, and the currency money is shown in.' },
      { id: 'telegram', label: 'Telegram', about: 'notifications, questions and notes from your phone', ico: 'M22 2L11 13M22 2l-7 20-4-9-9-4z',
        blurb: 'A bot for the server: notifications, the agents\' questions, and notes from Telegram.' },
      { id: 'tokens', label: 'Agent tokens', about: 'let agents work here, and what they did', ico: 'M15.5 7.5l2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4M21 2l-9.6 9.6M7.5 10a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11',
        blurb: 'Tokens for agents and scripts: make, revoke, delete, and see what each one did.' },
    ] },
    { group: 'Administration', items: [
      { id: 'admin', label: 'Admin panel', about: 'accounts, roles, passwords', ico: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 3a4 4 0 1 0 0 8a4 4 0 1 0 0-8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
        blurb: 'The accounts on this server: add people, change roles, reset passwords, disable or delete.' },
    ] },
  ];
  /** The admin panel is listed only for the owner and the admins. */
  shownNav = computed(() => this.nav.filter(g => g.group !== 'Administration' || this.auth.admin()));
  item = computed(() => this.shownNav().flatMap(g => g.items).find(x => x.id === this.prefs.tab()) ?? null);
  label(id: PrefsTab) { return this.nav.flatMap(g => g.items).find(x => x.id === id)?.label ?? id; }
  server(id: PrefsTab) { return id === 'llm' || id === 'proxy' || id === 'costs' || id === 'telegram' || id === 'tokens'; }
  /** Agent tokens take the "tokens" permission (editors up); the rest of the server's, "settings". */
  mayEdit(id: PrefsTab) { return id === 'tokens' ? this.auth.can('tokens') : this.canEdit; }
  isLight(t: ThemeId) { return isLightTheme(t); }
  langName = computed(() => LANGS.find(l => l.id === this.lang())?.name ?? this.lang());
  /** The figure beside each section in the list. */
  meta(id: PrefsTab): string | null {
    if (id === 'profile') return this.auth.state()?.role ?? null;
    if (id === 'appearance') return this.prefs.nameOf(this.prefs.theme());
    if (id === 'language') return this.lang().toUpperCase();
    if (id === 'shortcuts') return String(this.shortcutCount());
    if (id === 'costs') return CURRENCY();
    if (id === 'topbar') { const e = this.topbar.entries().filter(x => x.id !== 'gap'); return `${e.filter(x => !x.hidden).length}/${e.length}`; }
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
    { group: 'In Chat', items: [
      { keys: ['Ctrl', 'Shift', 'O'], what: 'A new conversation (⌘+Shift+O on a Mac)' },
      { keys: ['Enter'], what: 'Send' },
      { keys: ['Shift', 'Enter'], what: 'A new line' },
      { keys: ['↑'], what: 'In an empty box: edit your last message' },
      { keys: ['Esc'], what: 'Stop the answer / cancel an edit' },
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
