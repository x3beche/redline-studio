import { Component, computed, inject, input, output, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { T, t } from './i18n';
import { Langs, TgLangPicker } from './telegram-langs';

/** The bot's profile, set from here rather than @BotFather (backend/tgbot/
 *  profile.py): its name, description, short description and picture, per
 *  language - the default, and any ISO 639-1 language - read back live from
 *  Telegram.
 *
 *  Redline's own defaults (English, Turkish) fill a field Telegram has
 *  empty, and each field can go back to its default. A language added here
 *  can be translated from the default by the Reading translation job; the
 *  text is marked machine-translated until it is edited or saved. Each field
 *  says whether what is shown is what Telegram has, or only typed here;
 *  saving sends only the fields that changed and says how each one went.
 *  The picture is cut to a centred square and sent as a JPG - the preview
 *  shows that square. */
type Field = 'name' | 'description' | 'short_description';
interface LangProfile { name: string; description: string; short_description: string; commands: { command: string; about: string }[] }
interface Profile {
  langs: Record<string, LangProfile>; with_text: string[];
  limits: Record<Field, number>; defaults: Record<string, Record<Field, string>>;
  has_photo: boolean; min_side: number;
  state: { name: boolean; description: boolean; short_description: boolean; photo: boolean };
  results?: Record<string, { ok: boolean; error?: string }>;
}
interface Translated { lang: string; fields: Record<Field, string>; cut: Partial<Record<Field, boolean>>; model?: string }

@Component({
  selector: 'app-telegram-profile',
  imports: [T, TgLangPicker],
  styleUrls: ['./settings.css', './telegram-settings.css'],
  template: `
@if (p(); as d) {
  <div class="tg-prof">
    <div class="tg-chips">
      <span class="st-sec-title">{{ 'Languages' | t }}</span>
      @for (l of tabs(); track l) {
        <span class="tg-chip" [attr.data-on]="lang() === l ? 1 : null">
          <button (click)="lang.set(l)">{{ l === 'default' ? ('Default (all languages)' | t) : langs.label(l) }}@if (dirtyIn(l)) { <i class="tg-dot" [title]="'changed here, not saved' | t"></i> }
            @if (l !== 'default' && !d.with_text.includes(l)) { <small>{{ 'new' | t }}</small> }</button>
          @if (l !== 'default' && canEdit()) { <button class="tg-chip-x" [title]="'Remove this language' | t" (click)="removeLang(l)">×</button> }
        </span>
      }
      @if (canEdit()) {
        <app-tg-lang-picker [exclude]="tabs()" (picked)="addLang($event)" />
      }
    </div>
    <p class="st-hint">{{ 'People whose Telegram is set to a language listed here see its texts; everyone else sees the default.' | t }}</p>

    <div class="tg-prof-grid">
      <div class="tg-photo">
        <div class="tg-photo-box">
          @if (preview()) { <img [src]="preview()" alt=""> }
          @else if (d.has_photo) { <img [src]="'/api/telegram/avatar?v=' + stamp()" alt=""> }
          @else { <span class="tg-photo-none">{{ 'no picture' | t }}</span> }
        </div>
        <span class="st-badge" [attr.data-tone]="preview() ? 'warn' : d.has_photo ? 'ok' : null">{{ (preview() ? 'chosen, not saved' : d.has_photo ? 'saved on Telegram' : 'not set') | t }}</span>
        @if (canEdit()) {
          <label class="tcv-btn tcv-files-btn tg-file">{{ 'Choose a picture' | t }}
            <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" (change)="pick($event)"></label>
          @if (!preview()) {
            <button class="tcv-btn tcv-files-btn" (click)="useDefault()">{{ 'Use the default picture' | t }}</button>
          }
          @if (preview()) {
            <button class="tcv-btn tcv-files-btn" (click)="clearPick()">{{ 'Keep the current picture' | t }}</button>
          } @else if (d.has_photo) {
            <button class="tcv-btn tcv-files-btn tg-photo-rm" [disabled]="!!busy()" (click)="removePhoto()">{{ 'Remove picture' | t }}</button>
          }
        }
        <span class="st-hint">{{ 'Cut to the square shown, sent as a JPG. At least' | t }} {{ d.min_side }}×{{ d.min_side }} px.</span>
        @if (photoErr()) { <span class="st-err">{{ photoErr() }}</span> }
      </div>

      <div class="tg-fields">
        @if (lang() !== 'default' && canEdit()) {
          <div class="tg-tr">
            <span>{{ 'Translate the default texts into' | t }} <b>{{ langs.label(lang()) }}</b> {{ 'with the Reading translation job.' | t }}</span>
            <button class="tcv-btn tcv-files-btn" [disabled]="!!busy()" (click)="translate()">{{ busy() === 'tr' ? '…' : ('Translate from default' | t) }}</button>
          </div>
        }
        @for (f of fields; track f.id) {
          <label class="tg-field">
            <span class="tg-field-top"><b>{{ f.label | t }}</b><span class="st-sub">{{ f.about | t }}</span>
              @if (mt()[lang() + ':' + f.id]) { <span class="st-badge" data-tone="accent" [title]="mtModel()">{{ 'machine translated' | t }}</span> }
              <span class="st-badge" [attr.data-tone]="dirty(f.id) ? 'warn' : live(f.id) ? 'ok' : null">{{ state(f.id) | t }}</span>
              @if (canEdit() && def(f.id) && value(f.id) !== def(f.id)) {
                <button type="button" class="tg-reset" (click)="$event.preventDefault(); set(f.id, def(f.id)!)">↺ {{ 'reset to default' | t }}</button>
              }
              <span class="tg-count mono" [attr.data-over]="value(f.id).length > d.limits[f.id] ? 1 : null">{{ value(f.id).length }} / {{ d.limits[f.id] }}</span></span>
            @if (f.id === 'description') {
              <textarea class="st-in" rows="5" [disabled]="!canEdit()" [value]="value(f.id)" (input)="set(f.id, $any($event.target).value)"></textarea>
            } @else {
              <input class="st-in" [disabled]="!canEdit()" [value]="value(f.id)" (input)="set(f.id, $any($event.target).value)">
            }
            <span class="tg-field-foot">
              @if (result()[lang() + ':' + f.id]; as r) {
                <span [class.st-ok]="r.ok" [class.st-err]="!r.ok" class="tg-result">{{ r.ok ? '✓ ' + ('saved' | t) : '✕ ' + r.error }}</span>
              }
              @if (cut()[lang() + ':' + f.id]) { <span class="st-sub">{{ 'shortened to fit' | t }}</span> }
            </span>
          </label>
        }
        @if (err()) { <p class="st-err">{{ err() }}</p> }
      </div>

      <div class="tg-menu">
        <span class="st-sec-title">{{ 'Command menu' | t }}</span>
        @for (c of (d.langs[lang()]?.commands?.length ? d.langs[lang()].commands : d.langs['default'].commands); track c.command) {
          <div class="tg-menu-row"><code>/{{ c.command }}</code><span>{{ c.about }}</span></div>
        } @empty { <span class="st-sub">{{ 'none set' | t }}</span> }
        <span class="st-hint">{{ 'Set by Redline when the token is saved, in English and Turkish.' | t }}</span>
      </div>
    </div>
    <!-- One Save for the whole step: every language's changed texts, the
         chosen picture, then the step marked done. -->
    @if (canEdit()) {
      <div class="tg-prof-foot">
        @if (savedNote()) { <span class="st-ok">✓ {{ savedNote()! | t }}</span> }
        @else { <span class="st-sub">{{ pendingNote() }}</span> }
        @if (anyDirty() || preview()) { <button class="tcv-btn tcv-files-btn" [disabled]="!!busy()" (click)="revertAll()">{{ 'Undo' | t }}</button> }
        <button class="tcv-btn tcv-btn-accent tg-save" [disabled]="overAny() || !!busy()" (click)="saveAll()">{{ busy() === 'save' ? ('Saving…' | t) : ('Save' | t) }}</button>
      </div>
    }
  </div>
} @else if (err()) {
  <p class="st-err">{{ err() }}</p>
} @else {
  <!-- While Telegram answers: the form's shape, its lines pulsing, so
       the texts land where they will be read. -->
  <div class="tg-prof tg-skel" [attr.aria-label]="'Asking Telegram…' | t" aria-busy="true">
    <div class="tg-chips"><i class="sk" style="width: 70px"></i><i class="sk sk-pill" style="width: 150px"></i><i class="sk sk-pill" style="width: 90px"></i></div>
    <i class="sk" style="width: 55%"></i>
    <div class="tg-prof-grid">
      <div class="tg-photo"><i class="sk sk-photo"></i><i class="sk sk-btn"></i><i class="sk sk-btn"></i></div>
      <div class="tg-fields">
        @for (w of [1, 3, 1]; track $index) {
          <div class="tg-field">
            <span class="tg-field-top"><i class="sk" style="width: 90px"></i><i class="sk" style="width: 180px"></i><i class="sk tg-count" style="width: 40px"></i></span>
            <i class="sk sk-in" [style.height.px]="w === 3 ? 92 : 30"></i>
          </div>
        }
      </div>
      <div class="tg-menu">
        @for (r of [1, 2, 3, 4, 5]; track r) { <i class="sk" [style.width.%]="50 + r * 8"></i> }
      </div>
    </div>
  </div>
}`,
})
export class TelegramProfilePanel {
  private http = inject(HttpClient);
  readonly langs = inject(Langs);
  canEdit = input(false);
  changed = output<void>();
  /** The step's Save went through: the parent marks step 3 done. */
  saved = output<void>();
  savedNote = signal<string | null>(null);
  readonly fields: { id: Field; label: string; about: string }[] = [
    { id: 'name', label: 'Name', about: 'shown in chats and the contact list' },
    { id: 'description', label: 'Description', about: 'what people read before they press Start' },
    { id: 'short_description', label: 'Short description', about: 'the "about" line on the bot\'s profile' },
  ];
  p = signal<Profile | null>(null);
  lang = signal('default');
  /** Languages added here and not yet on Telegram. */
  added = signal<string[]>([]);
  /** What was typed, per "lang:field"; absent means as on Telegram. */
  draft = signal<Record<string, string>>({});
  /** "lang:field" filled by the translation job and not touched since. */
  mt = signal<Record<string, boolean>>({});
  mtModel = signal('');
  cut = signal<Record<string, boolean>>({});
  result = signal<Record<string, { ok: boolean; error?: string }>>({});
  busy = signal<string | null>(null);
  err = signal<string | null>(null);
  photoErr = signal<string | null>(null);
  preview = signal<string | null>(null);
  stamp = signal(Date.now());
  private file: File | Blob | null = null;

  tabs = computed(() => {
    const d = this.p();
    const out = ['default', ...(d?.with_text ?? []).filter(x => x !== 'default')];
    for (const a of this.added()) if (!out.includes(a)) out.push(a);
    return out;
  });

  constructor() { this.load(); }

  load(extra: string[] = []) {
    const q = extra.length ? `?extra=${extra.join(',')}` : '';
    this.http.get<Profile>('/api/telegram/profile' + q).subscribe({
      next: d => { this.p.set(d); this.prefill(d); },
      error: e => this.err.set(this.text(e)),
    });
  }

  /** Redline's defaults into fields Telegram has empty, as unsaved drafts. */
  private prefill(d: Profile) {
    if (!this.canEdit()) return;
    const add: Record<string, string> = {};
    for (const [l, defs] of Object.entries(d.defaults)) {
      if (l !== 'default' && !this.tabs().includes(l)) continue;
      for (const f of this.fields) {
        const k = `${l}:${f.id}`;
        if (!(k in this.draft()) && !(d.langs[l]?.[f.id] ?? '') && defs[f.id]) add[k] = defs[f.id];
      }
    }
    if (Object.keys(add).length) this.draft.update(x => ({ ...add, ...x }));
  }

  live(f: Field, l = this.lang()) { return this.p()?.langs[l]?.[f] ?? ''; }
  def(f: Field): string | null { return this.p()?.defaults[this.lang()]?.[f] ?? null; }
  value(f: Field) { const k = this.lang() + ':' + f; return k in this.draft() ? this.draft()[k] : this.live(f); }
  dirty(f: Field, l = this.lang()) { const k = l + ':' + f; return k in this.draft() && this.draft()[k] !== this.live(f, l); }
  dirtyIn(l: string) { return this.fields.some(f => this.dirty(f.id, l)); }
  state(f: Field) {
    if (this.dirty(f)) return this.value(f) === this.def(f) && !this.live(f) ? 'default, not saved' : 'changed here, not saved';
    return this.live(f) ? 'saved on Telegram' : 'empty';
  }
  set(f: Field, v: string) {
    const k = this.lang() + ':' + f;
    this.draft.update(d => ({ ...d, [k]: v }));
    this.mt.update(({ [k]: _, ...rest }) => rest);
    this.cut.update(({ [k]: _, ...rest }) => rest);
  }
  addLang(code: string) {
    if (!this.added().includes(code)) this.added.update(a => [...a, code]);
    this.lang.set(code);
    this.load([...this.added()]);
  }
  removeLang(l: string) {
    const d = this.p()!;
    if (!d.with_text.includes(l)) {           // only added here: nothing on Telegram yet
      this.added.update(a => a.filter(x => x !== l));
      this.dropDrafts(l);
      if (this.lang() === l) this.lang.set('default');
      return;
    }
    if (!confirm(t('Take this language\'s texts off Telegram? Its speakers will see the default.') + ' ' + this.langs.label(l))) return;
    this.busy.set('lang');
    this.http.delete<Profile>(`/api/telegram/profile/lang/${l}`).subscribe({
      next: p => { this.busy.set(null); this.added.update(a => a.filter(x => x !== l)); this.dropDrafts(l); this.p.set(p);
        if (this.lang() === l) this.lang.set('default'); this.changed.emit(); },
      error: e => { this.busy.set(null); this.err.set(this.text(e)); },
    });
  }
  private dropDrafts(l: string) {
    this.draft.update(d => Object.fromEntries(Object.entries(d).filter(([k]) => !k.startsWith(l + ':'))));
    this.mt.update(d => Object.fromEntries(Object.entries(d).filter(([k]) => !k.startsWith(l + ':'))));
  }

  /** The default's texts as they stand on the page, translated. */
  translate() {
    const l = this.lang();
    const src: Record<string, string> = { lang: l };
    for (const f of this.fields) {
      const k = 'default:' + f.id;
      src[f.id] = k in this.draft() ? this.draft()[k] : this.live(f.id, 'default');
    }
    this.busy.set('tr');
    this.err.set(null);
    this.http.post<Translated>('/api/telegram/profile/translate', src).subscribe({
      next: r => {
        this.busy.set(null);
        const set: Record<string, string> = {}, mark: Record<string, boolean> = {}, cut: Record<string, boolean> = {};
        for (const f of this.fields) {
          if (!r.fields[f.id]) continue;
          set[`${l}:${f.id}`] = r.fields[f.id];
          if (f.id !== 'name') mark[`${l}:${f.id}`] = true;
          if (r.cut[f.id]) cut[`${l}:${f.id}`] = true;
        }
        this.draft.update(d => ({ ...d, ...set }));
        this.mt.update(d => ({ ...d, ...mark }));
        this.cut.update(d => ({ ...d, ...cut }));
        this.mtModel.set(r.model ?? '');
      },
      error: e => { this.busy.set(null); this.err.set(this.text(e)); },
    });
  }

  /** One language's changed texts; true when every one went through. */
  private async saveLang(l: string): Promise<boolean> {
    const body: Record<string, string> = { lang: l };
    for (const f of this.fields) if (this.dirty(f.id, l)) body[f.id] = this.draft()[l + ':' + f.id];
    const d = await firstValueFrom(this.http.put<Profile>('/api/telegram/profile', body));
    this.p.set(d);
    const res = d.results ?? {};
    this.result.update(r => ({ ...r, ...Object.fromEntries(Object.entries(res).map(([k, v]) => [l + ':' + k, v])) }));
    const ok = (k: string) => k.startsWith(l + ':') && res[k.slice(l.length + 1)]?.ok;
    // What went through is now Telegram's - and no longer a machine's; what did not stays typed.
    this.draft.update(dr => Object.fromEntries(Object.entries(dr).filter(([k]) => !ok(k))));
    this.mt.update(m => Object.fromEntries(Object.entries(m).filter(([k]) => !ok(k))));
    if (d.with_text.includes(l)) this.added.update(a => a.filter(x => x !== l));
    return Object.values(res).every(r => r.ok);
  }

  anyDirty() { return this.tabs().some(l => this.dirtyIn(l)); }
  overAny() {
    const d = this.p();
    if (!d) return false;
    return Object.entries(this.draft()).some(([k, v]) => v.length > (d.limits[k.split(':')[1] as Field] ?? Infinity));
  }
  pendingNote(): string {
    const n = this.tabs().filter(l => this.dirtyIn(l)).length;
    const bits = [];
    if (n) bits.push(n === 1 ? t('texts changed in 1 language') : `${t('texts changed in')} ${n} ${t('languages')}`);
    if (this.preview()) bits.push(t('a new picture'));
    return bits.length ? bits.join(' · ') + ' - ' + t('sent on Save') : t('nothing changed - Save marks this step done');
  }
  revertAll() {
    this.draft.set({}); this.mt.set({}); this.clearPick();
  }

  /** Everything the step holds, in one go: each language's changed texts,
   *  the chosen picture, then step 3 marked done - only if all went through. */
  async saveAll() {
    this.busy.set('save');
    this.err.set(null);
    this.photoErr.set(null);
    this.savedNote.set(null);
    let ok = true;
    try {
      for (const l of this.tabs().filter(x => this.dirtyIn(x))) ok = (await this.saveLang(l)) && ok;
      if (this.preview()) {
        const d = this.file
          ? await firstValueFrom(this.http.put<Profile>('/api/telegram/profile/photo', this.form(this.file)))
          : await firstValueFrom(this.http.put<Profile>('/api/telegram/profile/photo/default', {}));
        this.p.set(d); this.clearPick(); this.stamp.set(Date.now());
      }
      if (ok) {
        await firstValueFrom(this.http.post('/api/telegram/profile/done', {}));
        this.savedNote.set('saved on Telegram - step done');
        this.saved.emit();
      } else {
        this.err.set(t('Some fields were not saved - see the marks under them.'));
      }
    } catch (e) {
      this.err.set(this.text(e));
    } finally {
      this.busy.set(null);
      setTimeout(() => this.result.set({}), 6000);
      this.changed.emit();
    }
  }
  private form(f: File | Blob) { const fd = new FormData(); fd.append('file', f); return fd; }

  pick(ev: Event) {
    const f = (ev.target as HTMLInputElement).files?.[0];
    this.photoErr.set(null);
    if (!f) return;
    if (!/^image\//.test(f.type)) { this.photoErr.set(t('That is not a picture.')); return; }
    if (f.size > 10 * 1024 * 1024) { this.photoErr.set(t('The picture is over 10 MB.')); return; }
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
      const min = this.p()?.min_side ?? 160;
      if (Math.min(img.width, img.height) < min) { this.photoErr.set(t('The picture is too small.') + ` ${img.width}×${img.height}`); URL.revokeObjectURL(url); return; }
      this.file = f;
      this.preview.set(url);
    };
    img.onerror = () => this.photoErr.set(t('That picture could not be read.'));
    img.src = url;
  }
  /** Redline's mark: shown first, sent with the step's Save. */
  useDefault() { this.clearPick(); this.file = null; this.preview.set('/api/telegram/profile/photo/default'); }
  clearPick() { const p = this.preview(); if (p?.startsWith('blob:')) URL.revokeObjectURL(p); this.preview.set(null); this.file = null; }

  removePhoto() {
    if (!confirm(t('Remove the bot\'s picture?'))) return;
    this.busy.set('photo');
    this.http.delete<Profile>('/api/telegram/profile/photo').subscribe({
      next: d => { this.busy.set(null); this.p.set(d); this.stamp.set(Date.now()); this.changed.emit(); },
      error: e => { this.busy.set(null); this.photoErr.set(this.text(e)); },
    });
  }

  private text(e: unknown): string {
    const err = e as { error?: { detail?: unknown }; message?: string };
    return typeof err?.error?.detail === 'string' ? err.error.detail : (err?.message ?? t('Something went wrong.'));
  }
}
