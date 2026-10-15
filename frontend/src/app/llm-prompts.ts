import { Component, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Auth } from './auth';
import { T, t } from './i18n';
import { Toast } from './toast';
import { Confirm } from './confirm';
import { SelectOption, UiSelect } from './ui-select';
import { Skeleton } from './skeleton';

/** Settings > LLM settings > Prompts: every instruction Workbench sends a
 *  model (backend/prompts.py) - the Chat's system line and the parts the
 *  code adds to it, the titles, the suggestions, the summaries and
 *  translations, Taste, the catalog, voice to text. Each shows the code's
 *  own text, and the owner or an admin may word it otherwise: the override
 *  is kept on the server for the whole machine, and counts from the next
 *  call. A hole the code fills ({lang}) must stay. "What is sent" builds
 *  the Chat's whole system line as an answer would get it now - no model
 *  is asked. */
interface Slot { name: string; about: string; required: boolean }
interface PromptRow {
  id: string; name: string; group: string; job: string; job_label: string; where: string; role: string;
  source: string; editable: boolean; slots: Slot[]; runtime: string[]; default: string;
  default_chars: number; default_tokens: number; override: string | null; at: string | null;
  by: { name?: string } | null; state: 'default' | 'override' | 'fallback'; missing: string[];
  chars: number; tokens: number; warnings?: string[];
}
interface PromptList { prompts: PromptRow[]; max_chars: number; chars_per_token: number }
interface Part { kind: 'prompt' | 'runtime'; id: string; text: string; chars: number; tokens: number }
interface Preview {
  text: string; chars: number; tokens: number; parts: Part[]; tools: string[]; tools_on: number;
  packages: string[]; all: boolean; tools_chars: number; tools_tokens: number;
  chat: string | null; title: string | null; provider: string; model: string; session: string | null;
}
type View = 'default' | 'edit' | 'diff' | 'sent';
/** The Chat's own prompts: theirs is the "What is sent" view. */
const CHAT = ['chat_system', 'chat_steps', 'chat_tools'];
/** The run-time parts of the Chat's system line, named. */
const PART: Record<string, string> = {
  memory: 'Workspace memory', tool_list: 'The tools sent', packages: 'Tool packages left out',
};

/** A word-level difference: the default's words, the override's words,
 *  and which were dropped or added. A long pair goes by lines instead. */
export function diff(a: string, b: string): { t: string; k: 0 | 1 | -1 }[] {
  let x = a.split(/(\s+)/), y = b.split(/(\s+)/);
  if (x.length * y.length > 4_000_000) { x = a.split(/(\n)/); y = b.split(/(\n)/); }
  const n = x.length, m = y.length;
  const w = m + 1, L = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i * w + j] = x[i] === y[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
  const out: { t: string; k: 0 | 1 | -1 }[] = [];
  const push = (s: string, k: 0 | 1 | -1) => {
    const last = out[out.length - 1];
    if (last && last.k === k) last.t += s; else out.push({ t: s, k });
  };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { push(x[i], 0); i++; j++; }
    else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) push(x[i++], -1);
    else push(y[j++], 1);
  }
  while (i < n) push(x[i++], -1);
  while (j < m) push(y[j++], 1);
  return out;
}

@Component({
  selector: 'app-llm-prompts',
  imports: [T, UiSelect, Skeleton],
  styleUrls: ['./settings.css', './llm-prompts.css'],
  template: `
<div class="st-card">
  <div class="st-card-head">
    <h3>{{ 'Prompts' | t }}</h3>
    <span class="st-sub">{{ 'every instruction Workbench sends to a model: read the default, word it your way' | t }}</span>
    <div class="st-right">
      @if (list(); as l) { <span class="lp-meta">{{ changed() }} {{ 'of' | t }} {{ l.prompts.length }} {{ 'changed' | t }}</span> }
      @if (!canEdit) { <span class="lp-meta">{{ 'only the owner and the admins can change a prompt' | t }}</span> }
    </div>
  </div>
  @if (list(); as l) {
    <div class="lp">
      <nav class="lp-list" [attr.aria-label]="'Prompts' | t">
        @for (g of groups(); track g.name) {
          <div class="lp-group">{{ g.name | t }}</div>
          @for (p of g.rows; track p.id) {
            <button type="button" class="lp-row" [attr.data-on]="p.id === pick() ? 1 : null" (click)="choose(p.id)"
                    [attr.aria-current]="p.id === pick() ? 'true' : null">
              <b>{{ p.name | t }}</b>
              <span class="lp-state" [attr.data-s]="p.state">{{ stateWord(p) | t }}</span>
              <small>{{ (p.job_label || '-') | t }}{{ p.at ? ' · ' + when(p.at) + (p.by?.name ? ' · ' + p.by!.name : '') : '' }}</small>
            </button>
          }
        }
      </nav>
      @if (chosen(); as p) {
        <section class="lp-main">
          <div class="lp-head">
            <h4>{{ p.name | t }}</h4>
            <span class="lp-meta">{{ 'job' | t }}: {{ (p.job_label || '-') | t }}</span>
            <span class="lp-meta">{{ (p.role === 'system' ? 'sent as the system line' : 'sent in the person\\'s line') | t }}</span>
            <span class="lp-meta mono" [title]="'Where the default is kept in the code' | t">backend/{{ p.source }}</span>
          </div>
          <p class="lp-where">{{ p.where | t }}</p>
          @if (p.slots.length || p.runtime.length || p.state === 'fallback') {
            <div class="lp-facts">
              @if (p.slots.length) {
                <span>{{ 'Filled in by the code' | t }}</span>
                <span>@for (s of p.slots; track s.name) {
                  <span><span class="lp-slot" [attr.data-req]="s.required ? 1 : null" [attr.data-gone]="gone(p, s) ? 1 : null"
                              [title]="(s.required ? 'required' : 'optional') | t">{{ '{' + s.name + '}' }}</span>
                    <span class="lp-note"> {{ s.about | t }}{{ s.required ? ' · ' + ('required' | t) : '' }}</span></span>
                }</span>
              }
              @if (p.runtime.length) {
                <span>{{ 'Added as it runs' | t }}</span>
                <span>@for (r of p.runtime; track r) { <span>{{ r | t }}</span> }</span>
              }
              @if (p.state === 'fallback') {
                <span>{{ 'Falling back' | t }}</span>
                <span class="lp-note" data-tone="warn">{{ 'the saved wording lacks' | t }} {{ braces(p.missing) }} - {{ 'the default is sent until it is fixed' | t }}</span>
              }
            </div>
          }
          <div class="lp-bar">
            <div class="st-seg" role="tablist">
              <button [class.on]="view() === 'default'" (click)="view.set('default')">{{ 'Default' | t }}</button>
              @if (p.editable) {
                <button [class.on]="view() === 'edit'" (click)="view.set('edit')">{{ (canEdit ? 'Your wording' : 'Override') | t }}</button>
                <button [class.on]="view() === 'diff'" [disabled]="!differs(p)" (click)="view.set('diff')">{{ 'Difference' | t }}</button>
              }
              @if (isChat(p)) {
                <button [class.on]="view() === 'sent'" (click)="openSent()">{{ 'What is sent' | t }}</button>
              }
            </div>
            @switch (view()) {
              @case ('edit') { <span class="lp-meta">{{ count(draft()) }}</span> }
              @case ('sent') { @if (sent(); as s) { <span class="lp-meta">≈ {{ s.tokens }} {{ 'model tokens' | t }} · {{ s.chars }} {{ 'characters' | t }}</span> } }
              @case ('diff') { <span class="lp-meta">{{ count(dirty() ? draft() : p.override ?? p.default) }}</span> }
              @default { <span class="lp-meta">{{ count(p.default) }}</span> }
            }
          </div>

          @switch (view()) {
            @case ('default') {
              <pre class="lp-text">@for (s of pieces(p.default, p); track $index) {@if (s.slot) {<span class="lp-slot">{{ s.t }}</span>} @else {{{ s.t }}}}</pre>
            }
            @case ('edit') {
              <textarea class="lp-text" spellcheck="false" [value]="draft()" [disabled]="!canEdit || busy()" rows="18"
                        [attr.aria-label]="p.name | t" (input)="draft.set($any($event.target).value)"></textarea>
              @if (p.slots.length) {
                <div class="lp-acts">
                  @for (s of p.slots; track s.name) {
                    <span class="lp-slot" [attr.data-req]="s.required ? 1 : null" [attr.data-gone]="s.required && !draft().includes('{' + s.name + '}') ? 1 : null">{{ '{' + s.name + '}' }}</span>
                  }
                  @if (lacking().length) { <span class="lp-note" data-tone="warn">{{ 'must keep' | t }} {{ braces(lacking()) }}</span> }
                </div>
              }
              @if (canEdit) {
                <div class="lp-acts">
                  <button class="tcv-btn tcv-files-btn" [disabled]="busy() || !dirty() || !draft().trim() || lacking().length > 0" (click)="save()">{{ 'Save' | t }}</button>
                  <button class="tcv-btn tcv-files-btn" [disabled]="busy() || !dirty()" (click)="draft.set(p.override ?? p.default)">{{ 'Undo changes' | t }}</button>
                  <button class="tcv-btn tcv-files-btn" [disabled]="busy() || p.state === 'default'" (click)="reset()">{{ 'Back to the default' | t }}</button>
                  <span class="lp-note">{{ (p.state === 'default' ? 'Using the default: what you save here is sent from the next call.' : 'Your wording is sent; the default is kept in the code.') | t }}</span>
                  @for (w of p.warnings || []; track w) { <span class="lp-note" data-tone="warn">{{ w }}</span> }
                </div>
              }
            }
            @case ('diff') {
              <pre class="lp-text">@for (d of changes(); track $index) {@if (d.k === 1) {<ins>{{ d.t }}</ins>} @else if (d.k === -1) {<del>{{ d.t }}</del>} @else {{{ d.t }}}}</pre>
              <span class="lp-note">{{ 'Struck through: in the default, not in your wording. Bold: yours only.' | t }}</span>
            }
            @case ('sent') {
              <div class="lp-acts">
                <wb-select class="lp-line" label="Conversation" size="sm" [options]="chatOpts()" [value]="chat()" (pick)="setChat($event)" />
                <div class="st-seg">
                  @for (m of modes; track m.id) {
                    <button [class.on]="mode() === m.id" (click)="setMode(m.id)" [title]="m.tip | t">{{ m.label | t }}</button>
                  }
                </div>
                <input class="st-in lp-line" [placeholder]="'Next line (optional): which tools it would get' | t" [value]="line()"
                       (change)="setLine($any($event.target).value)" (keydown.enter)="$any($event.target).blur()">
                <button class="tcv-btn tcv-files-btn" [disabled]="!sent()" (click)="copy()">{{ 'Copy' | t }}</button>
              </div>
              @if (sent(); as s) {
                <span class="lp-note">{{ s.model ? s.provider + ' · ' + s.model + ' · ' : '' }}{{ s.tools.length }} {{ 'tools sent' | t }}{{ s.tools_on ? ' ' + ('of' | t) + ' ' + s.tools_on + ' ' + ('on' | t) : '' }}{{ s.packages.length && !s.all ? ' (' + s.packages.join(', ') + ')' : '' }}{{ s.tools.length ? ' · ' + ('their schemas' | t) + ' ≈ ' + s.tools_tokens + ' ' + ('model tokens' | t) + ' ' + ('more' | t) : '' }} · {{ 'nothing is sent to a model to show this' | t }}</span>
                <div class="lp-text lp-sent">
                  @for (x of s.parts; track $index) {
                    <div class="lp-part" [attr.data-k]="x.kind">
                      <div><b>{{ partName(x) | t }}</b><span>{{ (x.kind === 'prompt' ? (overridden(x.id) ? 'your wording' : 'the default') : 'filled in as it runs') | t }}</span>
                        <span>≈ {{ x.tokens }} {{ 'model tokens' | t }}</span></div>
                      <p>{{ x.text.replace(lead, '') }}</p>
                    </div>
                  }
                </div>
              } @else if (sentErr()) {
                <p class="st-err">{{ sentErr() }}</p>
              } @else {
                <wb-skel kind="rows" [count]="8" />
              }
            }
          }
        </section>
      }
    </div>
  } @else if (err()) {
    <div class="st-card-body"><p class="st-err">{{ err() }}</p></div>
  } @else {
    <div class="st-card-body"><wb-skel kind="rows" [count]="8" /></div>
  }
</div>`,
})
export class LlmPromptsPanel {
  private http = inject(HttpClient);
  readonly canEdit = inject(Auth).can('settings');
  readonly when = when;
  readonly lead = /^\n+/;
  list = signal<PromptList | null>(null);
  err = signal<string | null>(null);
  pick = signal<string>(load('redline.settings.llm.prompt', 'chat_system'));
  view = signal<View>('default');
  draft = signal('');
  busy = signal(false);

  groups = computed(() => {
    const out: { name: string; rows: PromptRow[] }[] = [];
    for (const p of this.list()?.prompts ?? []) {
      const g = out.find(x => x.name === p.group);
      if (g) g.rows.push(p); else out.push({ name: p.group, rows: [p] });
    }
    return out;
  });
  chosen = computed(() => this.list()?.prompts.find(p => p.id === this.pick()) ?? this.list()?.prompts[0] ?? null);
  changed = computed(() => (this.list()?.prompts ?? []).filter(p => p.state !== 'default').length);
  dirty = computed(() => { const p = this.chosen(); return !!p && this.draft() !== (p.override ?? p.default); });
  lacking = computed(() => (this.chosen()?.slots ?? []).filter(s => s.required && !this.draft().includes('{' + s.name + '}')).map(s => s.name));
  changes = computed(() => { const p = this.chosen(); return p ? diff(p.default, this.view() === 'diff' && this.dirty() ? this.draft() : p.override ?? p.default) : []; });

  constructor() { this.load(); }

  private load() {
    this.http.get<PromptList>('/api/llm/prompts').subscribe({
      next: l => { this.list.set(l); this.fillDraft(); },
      error: e => this.err.set(text(e)),
    });
  }
  private fillDraft() { const p = this.chosen(); this.draft.set(p ? p.override ?? p.default : ''); }

  choose(id: string) {
    if (id === this.pick()) return;
    this.pick.set(id);
    keep('redline.settings.llm.prompt', id);
    this.fillDraft();
    const p = this.chosen();
    if (this.view() === 'sent' && !(p && this.isChat(p))) this.view.set('default');
    if (this.view() === 'diff' && !(p && this.differs(p))) this.view.set('default');
    if (this.view() === 'edit' && !p?.editable) this.view.set('default');
  }

  isChat(p: PromptRow) { return CHAT.includes(p.id); }
  differs(p: PromptRow) { return p.override != null || (this.view() === 'edit' && this.dirty()); }
  overridden(id: string) { return this.list()?.prompts.find(p => p.id === id)?.state === 'override'; }
  stateWord(p: PromptRow) { return p.state === 'override' ? 'changed' : p.state === 'fallback' ? 'falls back' : p.editable ? 'default' : 'fixed'; }
  gone(p: PromptRow, s: Slot) { return p.missing.includes(s.name); }
  braces(names: string[]) { return names.map(n => '{' + n + '}').join(', '); }
  count(s: string) {
    const per = this.list()?.chars_per_token ?? 3.6;
    const lines = s ? s.split('\n').length : 0;
    return `${lines} ${t(lines === 1 ? 'line' : 'lines')} · ${s.length} ${t('characters')} · ≈ ${Math.ceil(s.length / per)} ${t('model tokens')}`;
  }
  /** The text with its slots apart, to be shown as named holes. */
  pieces(s: string, p: PromptRow): { t: string; slot: boolean }[] {
    if (!p.slots.length) return [{ t: s, slot: false }];
    const names = new Set(p.slots.map(x => x.name)), out: { t: string; slot: boolean }[] = [];
    let at = 0;
    for (const m of s.matchAll(/\{([A-Za-z_]\w*)\}/g)) {
      if (!names.has(m[1])) continue;
      if (m.index! > at) out.push({ t: s.slice(at, m.index), slot: false });
      out.push({ t: m[0], slot: true });
      at = m.index! + m[0].length;
    }
    if (at < s.length) out.push({ t: s.slice(at), slot: false });
    return out;
  }
  partName(x: Part) { return x.kind === 'prompt' ? this.list()?.prompts.find(p => p.id === x.id)?.name ?? x.id : PART[x.id] ?? x.id; }

  save() {
    const p = this.chosen();
    if (!p || !this.canEdit) return;
    this.busy.set(true);
    this.http.put<PromptRow>(`/api/llm/prompts/${p.id}`, { text: this.draft() }).subscribe({
      next: r => { this.put(r); this.busy.set(false); Toast.show(t(r.state === 'default' ? 'Same as the default: nothing to keep.' : 'Saved.'), { tone: 'ok' }); },
      error: e => { this.busy.set(false); Toast.show(text(e), { tone: 'danger' }); },
    });
  }

  async reset() {
    const p = this.chosen();
    if (!p || !this.canEdit) return;
    if (!await Confirm.ask({ title: t('Back to the default?'), text: t('Your wording of this prompt is dropped; the code\'s own text is sent from the next call.'),
      ok: t('Back to the default') })) return;
    this.busy.set(true);
    this.http.delete<PromptRow>(`/api/llm/prompts/${p.id}`).subscribe({
      next: r => { this.put(r); this.busy.set(false); Toast.show(t('Back to the default.'), { tone: 'ok' }); },
      error: e => { this.busy.set(false); Toast.show(text(e), { tone: 'danger' }); },
    });
  }

  private put(r: PromptRow) {
    const l = this.list();
    if (!l) return;
    this.list.set({ ...l, prompts: l.prompts.map(p => p.id === r.id ? r : p) });
    this.fillDraft();
    if (this.view() === 'diff' && r.override == null) this.view.set('edit');
    if (this.sent()) this.preview();
  }

  // ---- what is sent (the Chat)
  readonly modes = [
    { id: 'auto', label: 'As picked', tip: 'The tool packages the next line and the conversation point to, as an answer picks them' },
    { id: 'all', label: 'Every tool', tip: 'Every tool that is on for you' },
    { id: 'none', label: 'No tools', tip: 'A model that takes no tools gets the system line alone' },
  ];
  chats = signal<{ id: string; title: string }[]>([]);
  chat = signal('');
  mode = signal('auto');
  line = signal('');
  sent = signal<Preview | null>(null);
  sentErr = signal<string | null>(null);
  chatOpts = computed<SelectOption[]>(() => [{ value: '', label: t('A new conversation') },
    ...this.chats().map(c => ({ value: c.id, label: c.title || c.id }))]);
  private chatsRead = false;

  openSent() {
    this.view.set('sent');
    if (!this.chatsRead) {
      this.chatsRead = true;
      this.http.get<{ id: string; title: string }[]>('/api/cc/chats').subscribe({ next: r => this.chats.set(r.slice(0, 60)), error: () => {} });
    }
    this.preview();
  }
  setChat(id: string) { this.chat.set(id); this.preview(); }
  setMode(m: string) { this.mode.set(m); this.preview(); }
  setLine(v: string) { if (v !== this.line()) { this.line.set(v); this.preview(); } }

  private preview() {
    this.sent.set(null);
    this.sentErr.set(null);
    const q = new URLSearchParams({ chat: this.chat(), tools: this.mode(), line: this.line() });
    this.http.get<Preview>('/api/llm/prompts/preview?' + q.toString()).subscribe({
      next: r => this.sent.set(r),
      error: e => this.sentErr.set(text(e)),
    });
  }

  copy() {
    const s = this.sent();
    if (!s) return;
    navigator.clipboard?.writeText(s.text).then(() => Toast.show(t('Copied.'), { tone: 'ok' }), () => {});
  }
}

/** When an override was saved, short: "6 Oct 14:22". */
function when(at: string | null | undefined): string {
  if (!at) return '';
  const d = new Date(at);
  return isNaN(d.getTime()) ? at : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function load<V>(key: string, fallback: V): V {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback; } catch { return fallback; }
}
function keep(key: string, v: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private window */ }
}
function text(e: unknown): string {
  const err = e as { error?: { detail?: unknown }; message?: string };
  return typeof err?.error?.detail === 'string' ? err.error.detail : (err?.message ?? t('Something went wrong.'));
}
