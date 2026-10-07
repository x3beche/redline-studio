import { Component, Injectable, OnDestroy, computed, inject, input, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import {
  CUSTOM_PREFIX, CustomTheme, LIGHT_THEMES, THEMES, THEME_NAMES, Theme, ThemeId,
  applyTheme, cachedCustom, isCustom, parseColour, setTheme, themeTokens, toHex, wearCustom,
} from '../theme';
import { T, t } from './i18n';
import { Prefs } from './preferences';

/** Themes people make, under the built-in ones in Settings > Appearance.
 *
 *  A custom theme is a built-in base with some tokens changed (theme.ts
 *  wears the base, then sets the changed tokens on the root, then what
 *  follows from them). They are kept per workspace on the server
 *  (backend/themes.py), so teammates can wear each other's, and travel as
 *  JSON. The one worn is also kept whole in this browser, so the first
 *  paint has it without asking the server.
 */

/** The tokens the editor offers, in the order it shows them. Anything else
 *  comes from the base (or from an imported file). */
export const EDITABLE: { token: string; label: string }[] = [
  { token: '--surface', label: 'Background' },
  { token: '--surface-2', label: 'Panel' },
  { token: '--hover', label: 'Hover' },
  { token: '--line', label: 'Lines' },
  { token: '--ink', label: 'Text' },
  { token: '--ink-dim', label: 'Dim text' },
  { token: '--accent', label: 'Accent' },
  { token: '--warn', label: 'Warning' },
  { token: '--danger', label: 'Danger' },
  { token: '--ok', label: 'Success' },
  { token: '--pen', label: 'Pen' },
];
const EDIT_TOKENS = EDITABLE.map(e => e.token);
const SWATCH_TOKENS = ['--surface', '--surface-2', '--ink', '--accent'];
const FILE_KIND = 'redline-theme';

@Injectable({ providedIn: 'root' })
export class CustomThemes {
  private http = inject(HttpClient);
  private prefs = inject(Prefs);
  list = signal<CustomTheme[]>([]);
  loaded = signal(false);
  error = signal('');

  constructor() { this.load(); }

  load() {
    this.http.get<CustomTheme[]>('/api/themes').subscribe({
      next: rows => {
        this.list.set(rows);
        this.loaded.set(true);
        // What this browser keeps of the worn one follows what its maker
        // changed since.
        const worn = this.prefs.theme();
        const fresh = isCustom(worn) && rows.find(r => CUSTOM_PREFIX + r.id === worn);
        const kept = cachedCustom();
        if (fresh && kept && JSON.stringify([kept.name, kept.base, kept.light, kept.vars])
            !== JSON.stringify([fresh.name, fresh.base, fresh.light, fresh.vars])) this.prefs.wear(worn, fresh);
      },
      error: () => this.loaded.set(true),
    });
  }

  find(id: ThemeId): CustomTheme | null {
    if (!isCustom(id)) return null;
    return this.list().find(c => CUSTOM_PREFIX + c.id === id)
      ?? (cachedCustom()?.id === id.slice(CUSTOM_PREFIX.length) ? cachedCustom() : null);
  }

  save(c: Draft) {
    const body = { name: c.name.trim(), base: c.base, light: c.light, vars: c.vars };
    return c.id ? this.http.put<CustomTheme>(`/api/themes/${c.id}`, body)
                : this.http.post<CustomTheme>('/api/themes', body);
  }

  remove(id: string) { return this.http.delete(`/api/themes/${id}`); }
}

/** A theme in the editor: what will be saved. `vars` holds every token the
 *  theme sets; the editor shows the main ones, an imported file may bring
 *  more. */
export interface Draft { id: string | null; name: string; base: Theme; light: boolean; vars: Record<string, string> }

/** The four colours of a theme's picture: page, panel, ink, accent. */
const baseCache = new Map<Theme, Record<string, string>>();
function baseValues(base: Theme): Record<string, string> {
  let v = baseCache.get(base);
  if (!v) { v = themeTokens(base, EDIT_TOKENS); baseCache.set(base, v); }
  return v;
}

export function swatchOf(c: Pick<CustomTheme, 'base' | 'vars'>): string[] {
  const b = baseValues(c.base);
  return SWATCH_TOKENS.map(k => c.vars[k] ?? b[k]);
}

function errText(e: HttpErrorResponse): string {
  const d = e.error?.detail;
  return typeof d === 'string' ? d : Array.isArray(d) ? d.map(x => x.msg).join('; ') : e.message;
}

@Component({
  selector: 'app-custom-themes',
  imports: [T],
  styleUrls: ['./settings.css', './custom-themes.css'],
  template: `
<div class="st-card ct">
  <div class="st-card-head">
    <h3>{{ 'Custom themes' | t }}</h3>
    <span class="st-sub">{{ shown().length }} {{ 'in this workspace' | t }}</span>
    <div class="st-right">
      <button class="tcv-btn tcv-files-btn" [class.on]="importing()" (click)="importing.set(!importing()); importErr.set('')">{{ 'Import' | t }}</button>
      <button class="tcv-btn tcv-files-btn tcv-btn-accent" [disabled]="!!draft()" (click)="start()">+ {{ 'New theme' | t }}</button>
    </div>
  </div>
  <div class="st-card-body">
    @if (importing()) {
      <div class="ct-import">
        <textarea class="st-in ct-paste" rows="4" spellcheck="false" [placeholder]="'Paste a theme\\'s JSON here' | t"
                  [value]="paste()" (input)="paste.set($any($event.target).value)"></textarea>
        <div class="st-row">
          <label class="tcv-btn tcv-files-btn ct-file">{{ 'Choose file' | t }}…
            <input type="file" accept=".json,application/json" (change)="fromFile($event)"></label>
          <button class="tcv-btn tcv-files-btn" [disabled]="!paste().trim()" (click)="fromText(paste())">{{ 'Open in editor' | t }}</button>
          @if (importErr()) { <span class="st-err">{{ importErr() }}</span> }
          <span class="st-sub ct-push">{{ 'Nothing is saved until you press Save.' | t }}</span>
        </div>
      </div>
    }

    @if (draft(); as d) {
      <div class="ct-editor">
        <div class="ct-editor-head">
          <span class="st-sec-title">{{ (d.id ? 'Edit theme' : 'New theme') | t }}</span>
          <span class="st-sub">{{ 'Previewing on the whole window' | t }}</span>
        </div>
        <div class="ct-meta">
          <label class="st-f ct-name"><span>{{ 'Name' | t }}</span>
            <input class="st-in" maxlength="40" [value]="d.name" (input)="patch({ name: $any($event.target).value })"></label>
          <label class="st-f"><span>{{ 'Based on' | t }}</span>
            <select class="st-in" [value]="d.base" (change)="rebase($any($event.target).value)">
              @for (b of themes; track b) { <option [value]="b" [selected]="b === d.base">{{ names[b] }}</option> }
            </select></label>
          <div class="st-f"><span>{{ 'Kind' | t }}</span>
            <div class="st-seg">
              <button [class.on]="!d.light" (click)="patch({ light: false })">{{ 'Dark' | t }}</button>
              <button [class.on]="d.light" (click)="patch({ light: true })">{{ 'Light' | t }}</button>
            </div></div>
        </div>
        <div class="ct-colours">
          @for (e of editable; track e.token) {
            <div class="ct-colour" [attr.data-changed]="changed(e.token) ? 1 : null">
              <input type="color" [value]="pickerValue(e.token)" [attr.aria-label]="e.label | t"
                     (input)="setColour(e.token, $any($event.target).value)">
              <span class="ct-colour-text">
                <span class="ct-colour-label">{{ e.label | t }}@if (changed(e.token)) { <button class="ct-undo" [title]="'Back to the base colour' | t" (click)="resetToken(e.token)">↺</button> }</span>
                <input class="st-in ct-hex" spellcheck="false" [value]="valueOf(e.token)"
                       [attr.data-bad]="bad()[e.token] ? 1 : null"
                       (input)="typed(e.token, $any($event.target).value)">
              </span>
            </div>
          }
        </div>
        @if (extra(); as n) { <p class="st-hint">{{ n }} {{ 'more colours set by the imported file are kept.' | t }}</p> }
        <div class="ct-actions">
          <button class="tcv-btn tcv-files-btn tcv-btn-accent" [disabled]="busy() || !d.name.trim() || hasBad()" (click)="save()">{{ busy() ? '…' : ('Save' | t) }}</button>
          <button class="tcv-btn tcv-files-btn" (click)="cancel()">{{ 'Cancel' | t }}</button>
          @if (d.id && canEditDraft()) {
            <button class="tcv-btn tcv-files-btn ct-danger" [disabled]="busy()" (click)="remove(d.id)">{{ confirmDel() === d.id ? ('Really delete?' | t) : ('Delete' | t) }}</button>
          }
          @if (err()) { <span class="st-err">{{ err() }}</span> }
          <span class="ct-push"></span>
          <button class="tcv-btn tcv-files-btn" (click)="exportDraft()">{{ 'Export' | t }}</button>
        </div>
      </div>
    }

    @if (shown().length) {
      <div class="st-themes">
        @for (c of shown(); track c.id) {
          <div class="st-theme ct-tile" [attr.data-on]="prefs.theme() === 'custom:' + c.id ? 1 : null">
            <button class="ct-wear" (click)="wear(c)">
              <span class="st-swatch">@for (s of swatch(c); track $index) { <i [style.background]="s"></i> }</span>
              <span class="st-theme-name"><span class="ct-ellipsis">{{ c.name }}</span>@if (prefs.theme() === 'custom:' + c.id) { <em>● {{ 'on' | t }}</em> }</span>
            </button>
            <span class="ct-by">{{ c.mine ? ('by you' | t) : ('by' | t) + ' ' + (c.by?.name ?? '?') }} · {{ (c.light ? 'Light' : 'Dark') | t }}</span>
            <span class="ct-acts">
              @if (c.can_edit) { <button (click)="edit(c)" [disabled]="!!draft()">{{ 'Edit' | t }}</button> }
              <button (click)="duplicate(c)" [disabled]="!!draft()">{{ 'Duplicate' | t }}</button>
              <button (click)="exportTheme(c)">{{ 'Export' | t }}</button>
            </span>
          </div>
        }
      </div>
    } @else if (!draft()) {
      <p class="st-hint">{{ loaded() ? ('No custom themes yet. Start one from any theme above with + New theme, or import one a teammate shared.' | t) : '…' }}</p>
    }
  </div>
</div>`,
})
export class CustomThemesPanel implements OnDestroy {
  prefs = inject(Prefs);
  store = inject(CustomThemes);
  /** 'All', 'Dark' or 'Light', as the theme list above is filtered. */
  filter = input('All');
  readonly themes = THEMES;
  readonly names = THEME_NAMES;
  readonly editable = EDITABLE;
  loaded = this.store.loaded;
  shown = computed(() => this.store.list().filter(c =>
    this.filter() === 'All' || (this.filter() === 'Light') === c.light));

  draft = signal<Draft | null>(null);
  /** What the draft's base says, to tell a changed colour from an inherited one. */
  private base = signal<Record<string, string>>({});
  /** What is typed into a hex box that is not a colour (yet). */
  typing = signal<Record<string, string>>({});
  bad = computed(() => Object.fromEntries(Object.entries(this.typing()).filter(([, v]) => !parseColour(v)).map(([k]) => [k, true])));
  hasBad = computed(() => Object.keys(this.bad()).length > 0);
  extra = computed(() => Object.keys(this.draft()?.vars ?? {}).filter(k => !EDIT_TOKENS.includes(k)).length);
  canEditDraft = computed(() => { const id = this.draft()?.id; return !id || !!this.store.list().find(c => c.id === id)?.can_edit; });
  busy = signal(false);
  err = signal('');
  confirmDel = signal<string | null>(null);
  importing = signal(false);
  paste = signal('');
  importErr = signal('');

  swatch(c: CustomTheme) { return swatchOf(c); }

  /** Leaving Settings with the editor open ends the preview. */
  ngOnDestroy() { if (this.draft()) applyTheme(this.prefs.theme()); }

  wear(c: CustomTheme) {
    if (this.draft()) this.cancel();
    this.prefs.wear(`custom:${c.id}`, c);
  }

  // ---- the editor ----
  private open(d: Draft) {
    this.err.set('');
    this.typing.set({});
    this.confirmDel.set(null);
    this.base.set(baseValues(d.base));
    this.draft.set(d);
    this.preview();
  }

  /** A new theme, from what is worn now. */
  start() {
    const now = this.prefs.theme();
    const c = this.store.find(now);
    if (c) { this.open({ id: null, name: c.name + ' ' + t('(copy)'), base: c.base, light: c.light, vars: { ...c.vars } }); return; }
    const base = isCustom(now) ? 'default' : now;
    this.open({ id: null, name: t('My theme'), base, light: LIGHT_THEMES.has(base), vars: {} });
  }
  edit(c: CustomTheme) { this.open({ id: c.id, name: c.name, base: c.base, light: c.light, vars: { ...c.vars } }); }
  duplicate(c: CustomTheme) {
    this.open({ id: null, name: (c.name + ' ' + t('(copy)')).slice(0, 40), base: c.base, light: c.light, vars: { ...c.vars } });
  }

  patch(p: Partial<Draft>) {
    const d = this.draft();
    if (!d) return;
    this.draft.set({ ...d, ...p });
    this.preview();
  }

  /** Another base: the colours not changed follow it, and so does its kind. */
  rebase(base: Theme) {
    const d = this.draft();
    if (!d) return;
    this.base.set(baseValues(base));
    this.patch({ base, light: LIGHT_THEMES.has(base) });
  }

  valueOf(token: string) { return this.typing()[token] ?? this.draft()?.vars[token] ?? this.base()[token] ?? ''; }
  pickerValue(token: string) {
    const v = this.draft()?.vars[token] ?? this.base()[token] ?? '';
    return toHex(v).slice(0, 7);
  }
  changed(token: string) { return token in (this.draft()?.vars ?? {}); }

  /** From the picker: an opaque colour, keeping what see-through it was. */
  setColour(token: string, hex: string) {
    const old = toHex(this.draft()?.vars[token] ?? this.base()[token] ?? '');
    const alpha = old.length === 9 ? old.slice(7) : '';
    this.typed(token, hex + alpha);
  }

  typed(token: string, v: string) {
    const d = this.draft();
    if (!d) return;
    const val = v.trim();
    if (!parseColour(val)) { this.typing.update(x => ({ ...x, [token]: v })); return; }
    this.typing.update(x => { const { [token]: _, ...rest } = x; return rest; });
    const vars = { ...d.vars };
    if (toHex(val) === toHex(this.base()[token] ?? '')) delete vars[token]; else vars[token] = val;
    this.patch({ vars });
  }

  resetToken(token: string) {
    const d = this.draft();
    if (!d) return;
    const { [token]: _, ...vars } = d.vars;
    this.typing.update(x => { const { [token]: __, ...rest } = x; return rest; });
    this.patch({ vars });
  }

  private preview() {
    const d = this.draft();
    if (d) wearCustom(d);
  }

  cancel() {
    this.draft.set(null);
    this.typing.set({});
    this.err.set('');
    applyTheme(this.prefs.theme());
  }

  save() {
    const d = this.draft();
    if (!d) return;
    // A theme changes at least one colour; one that changes none is its
    // base under another name, and says so with the base's background.
    const vars = Object.keys(d.vars).length ? d.vars : { '--surface': this.base()['--surface'] };
    this.busy.set(true);
    this.err.set('');
    this.store.save({ ...d, vars }).subscribe({
      next: saved => {
        this.busy.set(false);
        this.store.list.update(l => l.some(c => c.id === saved.id) ? l.map(c => c.id === saved.id ? saved : c) : [...l, saved]);
        this.draft.set(null);
        this.prefs.wear(`custom:${saved.id}`, saved);
      },
      error: (e: HttpErrorResponse) => { this.busy.set(false); this.err.set(errText(e)); },
    });
  }

  remove(id: string) {
    if (this.confirmDel() !== id) { this.confirmDel.set(id); return; }
    this.busy.set(true);
    this.store.remove(id).subscribe({
      next: () => {
        this.busy.set(false);
        this.store.list.update(l => l.filter(c => c.id !== id));
        const wearing = this.prefs.theme() === CUSTOM_PREFIX + id;
        const base = this.draft()?.base ?? 'default';
        this.draft.set(null);
        if (wearing) this.prefs.wear(base); else applyTheme(this.prefs.theme());
      },
      error: (e: HttpErrorResponse) => { this.busy.set(false); this.err.set(errText(e)); },
    });
  }

  // ---- sharing ----
  private download(c: Pick<Draft, 'name' | 'base' | 'light' | 'vars'>) {
    const body = JSON.stringify({ kind: FILE_KIND, version: 1, name: c.name.trim(), base: c.base, light: c.light, vars: c.vars }, null, 2);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
    a.download = (c.name.trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').toLowerCase() || 'theme') + '.redline-theme.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    navigator.clipboard?.writeText(body).catch(() => { /* not allowed here: the file is enough */ });
  }
  exportTheme(c: CustomTheme) { this.download(c); }
  exportDraft() { const d = this.draft(); if (d) this.download(d); }

  fromFile(ev: Event) {
    const f = (ev.target as HTMLInputElement).files?.[0];
    if (!f) return;
    f.text().then(txt => { this.paste.set(txt); this.fromText(txt); });
    (ev.target as HTMLInputElement).value = '';
  }

  /** A shared theme, into the editor as a new one: checked here the way
   *  the server will check it, so what is wrong is said before saving. */
  fromText(txt: string) {
    this.importErr.set('');
    let j: Record<string, unknown>;
    try { j = JSON.parse(txt); } catch { this.importErr.set(t('That is not JSON.')); return; }
    if (!j || typeof j !== 'object' || typeof j['vars'] !== 'object' || !j['vars']) {
      this.importErr.set(t('That is not a Redline theme.')); return;
    }
    const vars: Record<string, string> = {};
    const skipped: string[] = [];
    for (const [k, v] of Object.entries(j['vars'] as Record<string, unknown>)) {
      // A token Redline knows is one the stylesheet defines on the root.
      if (/^--[a-z0-9-]+$/.test(k) && typeof v === 'string' && parseColour(v)
          && getComputedStyle(document.documentElement).getPropertyValue(k).trim() !== '') vars[k] = v.trim();
      else skipped.push(k);
    }
    if (!Object.keys(vars).length) { this.importErr.set(t('That theme sets no colour Redline knows.')); return; }
    const base = (THEMES as readonly string[]).includes(String(j['base'])) ? j['base'] as Theme : 'default';
    const name = (typeof j['name'] === 'string' && j['name'].trim() ? j['name'].trim() : t('Imported theme')).slice(0, 40);
    this.importing.set(false);
    this.paste.set('');
    this.open({ id: null, name, base, light: typeof j['light'] === 'boolean' ? j['light'] : LIGHT_THEMES.has(base), vars });
    if (skipped.length) this.err.set(t('Left out') + ': ' + skipped.slice(0, 5).join(', '));
  }
}
