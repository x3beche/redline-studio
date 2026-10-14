import { Injectable, signal } from '@angular/core';
import { CustomTheme, Font, THEME_NAMES, ThemeId, cachedCustom, currentFont, currentTheme, isCustom, setFont, setTheme } from '../theme';
import { redlineTheme } from './rooms/code-view';
import { ModelSwitch, currentSwitch, setSwitch } from './editor/switch-pref';
import { IconPack, IconSize, currentIconSize, currentIcons, setIconSize, setIcons } from './icon-packs';

/** Settings, a tab of its own: the theme, the language and the keyboard
 *  shortcuts - per browser, about the person at this screen - and the
 *  server's: the LLM keys and models (llm-settings.ts) and the proxy for
 *  the part lookups with Jina AI beside it (proxy-settings.ts, "Proxy & Data"), and what things cost and in which
 *  currency (costs-settings.ts). Opened from
 *  the user menu, from Ctrl+K, and with "?" (the shortcuts page). The owner
 *  and the admins also get the admin panel: the accounts (admin-users.ts).
 */
export type PrefsTab = 'profile' | 'appearance' | 'language' | 'llm' | 'proxy' | 'costs' | 'telegram' | 'tokens' | 'shortcuts' | 'topbar' | 'dashboard' | 'admin' | 'rustdesk' | 'backups';

@Injectable({ providedIn: 'root' })
export class Prefs {
  /** Ask for a section: the shell (app.ts) opens the Settings tab on it and
   *  sets this back to null. How the user menu, the palette and "?" get there. */
  open = signal<PrefsTab | null>(null);
  /** The section on screen in the Settings tab. */
  tab = signal<PrefsTab>('profile');
  theme = signal<ThemeId>(currentTheme());
  font = signal<Font>(currentFont());
  /** How the 3D room goes from one model to the next (editor/model-switch.ts). */
  modelSwitch = signal<ModelSwitch>(currentSwitch());
  /** The toolbars' icons in the 3D, PCB and Firmware rooms (icon-packs.ts). */
  icons = signal<IconPack>(currentIcons());
  iconSize = signal<IconSize>(currentIconSize());

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

  /** Wear a typeface (theme.ts). */
  wearFont(f: Font) { this.font.set(setFont(f)); }

  /** Pick the model switch; the next switch uses it. */
  pickSwitch(m: ModelSwitch) { this.modelSwitch.set(setSwitch(m)); }

  /** Pick the toolbars' icon pack; every room wears it at once. */
  pickIcons(p: IconPack) { this.icons.set(setIcons(p)); }
  pickIconSize(px: IconSize) { this.iconSize.set(setIconSize(px)); }

  /** What a theme is called where it is shown. */
  nameOf(t: ThemeId): string {
    if (!isCustom(t)) return THEME_NAMES[t];
    const c = cachedCustom();
    return c && 'custom:' + c.id === t ? c.name : t.slice(7);
  }
}

// The Settings tab itself is settings-room.ts: a chunk of its own, loaded when it is opened.
