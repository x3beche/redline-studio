import {
  Component, ElementRef, OnDestroy, effect, inject, input, output, signal, untracked, viewChild,
} from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import type * as Monaco from 'monaco-editor';
import { Auth } from '../auth';

/** The source behind what is on screen, in VS Code's editor (Monaco): the
 *  3D room's models are build123d (Python), the PCB room's boards atopile.
 *
 *  Editing writes the source straight back - Ctrl+S or Save - and marks
 *  the model or board changed; Build rebuilds it. A save carries the
 *  version it started from, so if an agent saved in between the server
 *  refuses rather than laying one over the other, and the person chooses.
 *  Changes that come in while nothing is typed here are simply shown.
 *
 *  Monaco is large, so it is loaded the first time a code view opens and
 *  not before (served as-is from /monaco/vs, angular.json).
 */
export type CodeKind = 'model' | 'board';

type MonacoApi = typeof Monaco;
let loading: Promise<MonacoApi> | null = null;

function loadMonaco(): Promise<MonacoApi> {
  const w = window as unknown as { monaco?: MonacoApi; require?: any };
  if (w.monaco) return Promise.resolve(w.monaco);
  loading ??= new Promise<MonacoApi>((ok, fail) => {
    const base = new URL('monaco/vs', document.baseURI).href;
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = `${base}/editor/editor.main.css`;
    document.head.appendChild(css);
    const script = document.createElement('script');
    script.src = `${base}/loader.js`;
    script.onload = () => {
      w.require.config({ paths: { vs: base } });
      w.require(['vs/editor/editor.main'], () => { atopile(w.monaco!); ok(w.monaco!); }, fail);
    };
    script.onerror = () => { loading = null; fail(new Error('the editor could not be loaded')); };
    document.body.appendChild(script);
  });
  return loading;
}

/** atopile, for Monaco: Python's shape, with its own words and the units
 *  it writes on numbers (10kohm, 3.3V +/- 5%). */
function atopile(m: MonacoApi) {
  if (m.languages.getLanguages().some(l => l.id === 'atopile')) return;
  m.languages.register({ id: 'atopile', extensions: ['.ato'] });
  m.languages.setLanguageConfiguration('atopile', {
    comments: { lineComment: '#' },
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [{ open: '(', close: ')' }, { open: '[', close: ']' }, { open: '"', close: '"' }],
    indentationRules: { increaseIndentPattern: /:\s*(#.*)?$/, decreaseIndentPattern: /^\s*pass\b/ },
  });
  m.languages.setMonarchTokensProvider('atopile', {
    keywords: ['component', 'module', 'interface', 'pin', 'signal', 'new', 'import', 'from', 'assert',
               'within', 'to', 'trait', 'is', 'and', 'or', 'not', 'if', 'else', 'for', 'in', 'pass'],
    tokenizer: {
      root: [
        [/#.*$/, 'comment'],
        [/"""/, 'string', '@doc'],
        [/"([^"\\]|\\.)*"/, 'string'],
        [/'([^'\\]|\\.)*'/, 'string'],
        [/(component|module|interface)(\s+)([A-Za-z_]\w*)/, ['keyword', '', 'type']],
        [/\d[\d_.]*(?:e[+-]?\d+)?[A-Za-zµΩ%]*/, 'number'],
        [/[A-Z]\w*/, 'type'],
        [/[A-Za-z_]\w*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
        [/~|->|\+\/-|[=:<>+\-*\/]/, 'operator'],
      ],
      doc: [[/"""/, 'string', '@pop'], [/./, 'string']],
    },
  } as Monaco.languages.IMonarchLanguage);
}

/** Any CSS colour as #rrggbb, so Monaco can take the theme's tokens. */
function hex(css: string): string {
  const probe = document.createElement('span');
  probe.style.color = css;
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).color.match(/\d+(\.\d+)?/g) ?? ['0', '0', '0'];
  probe.remove();
  return '#' + rgb.slice(0, 3).map(n => Math.round(+n).toString(16).padStart(2, '0')).join('');
}

/** Redline's theme, as a Monaco theme: the same tokens as the rest of the app. */
function redlineTheme(m: MonacoApi): string {
  // The page resolves each var() for us: the probe in hex() is styled with it.
  const v = (color: string) => hex(color);
  const light = document.documentElement.dataset['theme'] === 'light';
  const fg = (color: string) => v(color).slice(1);
  m.editor.defineTheme('redline', {
    base: light ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: fg('var(--code-kw)') },
      { token: 'string', foreground: fg('var(--code-str)') },
      { token: 'number', foreground: fg('var(--code-num)') },
      { token: 'comment', foreground: fg('var(--code-com)'), fontStyle: 'italic' },
      { token: 'type', foreground: fg('var(--code-type)') },
      { token: 'tag', foreground: fg('var(--code-fn)') },
      { token: 'operator', foreground: fg('var(--ink-dim)') },
    ],
    colors: {
      'editor.background': v('var(--surface)'),
      'editor.foreground': v('var(--ink)'),
      'editorGutter.background': v('var(--surface)'),
      'editorLineNumber.foreground': v('var(--ink-dim)'),
      'editorLineNumber.activeForeground': v('var(--ink)'),
      'editor.lineHighlightBackground': v('var(--surface-2)'),
      'editor.selectionBackground': v('var(--accent-deep)'),
      'editorCursor.foreground': v('var(--accent)'),
      'editorWidget.background': v('var(--surface-2)'),
      'editorWidget.border': v('var(--line)'),
      'minimap.background': v('var(--surface)'),
    },
  });
  return 'redline';
}

interface Read { source: string; rev: string; stale?: boolean }

@Component({
  selector: 'app-code-view',
  host: { class: 'tcv-code' },
  template: `
<div class="tcv-code-bar">
  <span class="tcv-code-title">{{ title() || id() }}</span>
  <span class="tcv-code-sub">{{ status() }}</span>
  <span class="grow"></span>
  <span class="tcv-code-sub">{{ kind() === 'board' ? 'atopile' : 'build123d · Python' }}</span>
  @if (canEdit()) {
    <button class="tcv-btn tcv-code-btn" [class.tcv-code-save]="dirty()" [disabled]="!dirty() || saving()"
            (click)="save()" title="Save (Ctrl+S)">{{ saving() ? 'Saving…' : 'Save' }}</button>
  }
  <button class="tcv-btn tcv-code-btn" (click)="copy()">{{ copied() ? 'Copied' : 'Copy' }}</button>
  <button class="tcv-btn tcv-code-btn" (click)="close()" title="Back to the view">✕</button>
</div>
@if (clash(); as c) {
  <div class="tcv-code-clash" role="alert">
    <span>{{ c }}</span>
    <button class="tcv-btn tcv-code-btn" (click)="takeTheirs()">Load theirs (drop my edits)</button>
    <button class="tcv-btn tcv-code-btn" (click)="save(true)">Save mine over it</button>
  </div>
}
@if (error(); as e) { <p class="tcv-code-empty">{{ e }}</p> }
<div #host class="tcv-code-editor" [hidden]="!!error()"></div>`,
})
export class CodeView implements OnDestroy {
  private http = inject(HttpClient);
  private auth = inject(Auth);
  kind = input.required<CodeKind>();
  /** The model's or board's id. */
  id = input.required<string>();
  title = input('');
  closed = output<void>();
  /** Saved: the room may want to show the build is out of date. */
  saved = output<void>();

  private host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private m: MonacoApi | null = null;
  private editor: Monaco.editor.IStandaloneCodeEditor | null = null;
  /** The version the text in the editor started from, and the model
   *  version it was at then - what "unsaved" is measured against. */
  private rev = '';
  private savedAt = 0;
  private poll?: ReturnType<typeof setInterval>;

  status = signal('reading…');
  error = signal<string | null>(null);
  dirty = signal(false);
  saving = signal(false);
  copied = signal(false);
  clash = signal<string | null>(null);
  private theirs: Read | null = null;
  canEdit = () => this.auth.can('edit');

  constructor() {
    effect(() => {
      const id = this.id(), kind = this.kind();
      untracked(() => void this.open(kind, id));
    });
  }

  private url() {
    return this.kind() === 'board' ? `/api/boards/${this.id()}` : `/api/models/${this.id()}`;
  }

  private read() {
    const path = this.kind() === 'board' ? this.url() : `${this.url()}/source`;
    return this.http.get<Read>(path);
  }

  private async open(kind: CodeKind, id: string) {
    this.error.set(null);
    this.clash.set(null);
    this.status.set('reading…');
    let m: MonacoApi;
    try { m = this.m = await loadMonaco(); } catch (e) { this.error.set((e as Error).message); return; }
    this.read().subscribe({
      next: d => {
        if (this.id() !== id) return;
        this.show(m, kind, d);
        clearInterval(this.poll);
        this.poll = setInterval(() => this.check(), 10_000);
      },
      error: (e: HttpErrorResponse) => this.error.set(
        typeof e.error?.detail === 'string' ? e.error.detail : 'the source could not be read'),
    });
  }

  private show(m: MonacoApi, kind: CodeKind, d: Read) {
    const lang = kind === 'board' ? 'atopile' : 'python';
    if (!this.editor) {
      this.editor = m.editor.create(this.host().nativeElement, {
        value: d.source, language: lang, theme: redlineTheme(m),
        readOnly: !this.canEdit(), automaticLayout: true, minimap: { enabled: true },
        fontFamily: 'ui-monospace, "JetBrains Mono", "Fira Code", Menlo, Consolas, monospace',
        fontSize: 13, tabSize: 4, insertSpaces: true, scrollBeyondLastLine: false,
        renderWhitespace: 'selection', bracketPairColorization: { enabled: true },
      });
      this.editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => this.save());
      this.editor.onDidChangeModelContent(() => this.markDirty());
    } else {
      const model = this.editor.getModel()!;
      m.editor.setModelLanguage(model, lang);
      const view = this.editor.saveViewState();
      model.setValue(d.source);
      if (view) this.editor.restoreViewState(view);
    }
    this.rev = d.rev;
    this.savedAt = this.editor.getModel()!.getAlternativeVersionId();
    this.markDirty();
    this.status.set(this.canEdit()
      ? (d.stale ? 'changed since the last build - Build to see it' : 'up to date with the build')
      : `read-only - ${this.auth.why('edit') ?? ''}`);
  }

  private markDirty() {
    const model = this.editor?.getModel();
    this.dirty.set(!!model && model.getAlternativeVersionId() !== this.savedAt);
  }

  /** Every ten seconds: has an agent saved a newer version? Shown at once
   *  if nothing is being typed here; otherwise the person decides. */
  private check() {
    if (document.hidden || this.saving() || !this.m) return;
    this.read().subscribe({
      next: d => {
        if (d.rev === this.rev) return;
        if (!this.dirty()) { this.show(this.m!, this.kind(), d); return; }
        this.theirs = d;
        this.clash.set('Someone else - an agent, most likely - saved a newer version while you were editing.');
      },
    });
  }

  save(force = false) {
    const text = this.editor?.getValue();
    if (text === undefined || this.saving() || (!this.dirty() && !force)) return;
    this.saving.set(true);
    const body = { source: text, if_match: force && this.theirs ? this.theirs.rev : this.rev };
    this.http.put<{ rev: string }>(this.url(), body).subscribe({
      next: r => {
        this.saving.set(false);
        this.clash.set(null);
        this.theirs = null;
        this.rev = r.rev;
        this.savedAt = this.editor!.getModel()!.getAlternativeVersionId();
        this.markDirty();
        this.status.set('saved - Build to see it');
        this.saved.emit();
      },
      error: (e: HttpErrorResponse) => {
        this.saving.set(false);
        if (e.status === 409) {
          this.read().subscribe(d => {
            this.theirs = d;
            this.clash.set('Not saved: someone else saved a newer version while you were editing.');
          });
          return;
        }
        const d = e.error?.detail;
        this.status.set('not saved - ' + (typeof d === 'string' ? d : 'that did not work'));
      },
    });
  }

  takeTheirs() {
    if (this.theirs && this.m) this.show(this.m, this.kind(), this.theirs);
    this.theirs = null;
    this.clash.set(null);
  }

  copy() {
    navigator.clipboard?.writeText(this.editor?.getValue() ?? '').then(() => {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1500);
    });
  }

  close() {
    if (this.dirty() && !confirm('You have unsaved changes. Close without saving?')) return;
    this.closed.emit();
  }

  ngOnDestroy() {
    clearInterval(this.poll);
    this.editor?.getModel()?.dispose();
    this.editor?.dispose();
  }
}
