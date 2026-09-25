import {
  Component, ElementRef, OnDestroy, computed, effect, inject, input, output, signal, untracked, viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import type * as Monaco from 'monaco-editor';
import { Auth } from '../auth';
import { Catalog, FolderNode } from '../api';

/** The source behind what is on screen, in VS Code's editor (Monaco): the
 *  3D room's models are build123d (Python), the PCB room's boards atopile.
 *
 *  Each item in the catalog is one file, but a project is many: an
 *  assembly imports its parts (`from stand import ...`). So, as in an IDE,
 *  the project's folder tree is on the left - the files the open one uses
 *  are marked - and each file opens in a tab of its own; Ctrl+click on an
 *  import opens the file it names.
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

export function loadMonaco(): Promise<MonacoApi> {
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
export function redlineTheme(m: MonacoApi): string {
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

/** One open file. Mutable: `touch()` tells the template it changed. */
interface Tab {
  kind: CodeKind; id: string; name: string;
  model: Monaco.editor.ITextModel;
  rev: string; savedAt: number; stale: boolean; dirty: boolean;
  view: Monaco.editor.ICodeEditorViewState | null;
  theirs: Read | null; clash: string | null; status: string;
}

/** A file in the project tree. */
interface TreeFile { kind: CodeKind; id: string; label: string }
interface TreeDir { name: string; path: string; dirs: TreeDir[]; files: TreeFile[] }

const key = (kind: CodeKind, id: string) => `${kind}:${id}`;

@Component({
  selector: 'app-code-view',
  imports: [NgTemplateOutlet],
  host: { class: 'tcv-code' },
  template: `
<div class="tcv-code-bar">
  <span class="tcv-code-title">{{ project()?.path ? project()!.name : (title() || id()) }}</span>
  <span class="tcv-code-sub">{{ current()?.status }}</span>
  <span class="grow"></span>
  <span class="tcv-code-sub">{{ current()?.kind === 'board' ? 'atopile' : 'build123d · Python' }}</span>
  @if (canEdit()) {
    <button class="tcv-btn tcv-code-btn" [class.tcv-code-save]="current()?.dirty" [disabled]="!current()?.dirty || saving()"
            (click)="save()" title="Save (Ctrl+S)">{{ saving() ? 'Saving…' : 'Save' }}</button>
  }
  <button class="tcv-btn tcv-code-btn" (click)="copy()">{{ copied() ? 'Copied' : 'Copy' }}</button>
  <button class="tcv-btn tcv-code-btn" (click)="close()" title="Back to the view">✕</button>
</div>
<div class="tcv-code-main">
  <!-- EXPLORER: the project's folders and files; a dot marks what the open file uses. -->
  <nav class="tcv-code-tree" aria-label="Project files">
    <div class="tcv-code-tree-head">Explorer</div>
    @if (project(); as root) {
      <ng-container *ngTemplateOutlet="dir; context: { $implicit: root, depth: 0 }" />
    } @else {
      <p class="tcv-code-tree-empty">reading the project…</p>
    }
  </nav>
  <div class="tcv-code-pane">
    <div class="tcv-code-tabs" role="tablist">
      @for (t of tabs(); track t.kind + t.id) {
        <div class="tcv-code-tab" role="tab" [attr.data-on]="t === current() ? 1 : null"
             [attr.aria-selected]="t === current()" (click)="activate(t)" (auxclick)="closeTab(t, $event)" [title]="t.id">
          <span>{{ t.name }}</span>
          @if (t.dirty) { <span class="tcv-code-dot" title="unsaved"></span> }
          <button class="tcv-code-x" (click)="closeTab(t, $event)" aria-label="Close">×</button>
        </div>
      }
    </div>
    @if (current()?.clash; as c) {
      <div class="tcv-code-clash" role="alert">
        <span>{{ c }}</span>
        <button class="tcv-btn tcv-code-btn" (click)="takeTheirs()">Load theirs (drop my edits)</button>
        <button class="tcv-btn tcv-code-btn" (click)="save(true)">Save mine over it</button>
      </div>
    }
    @if (error(); as e) { <p class="tcv-code-empty">{{ e }}</p> }
    <div #host class="tcv-code-editor" [hidden]="!!error() && !tabs().length"></div>
  </div>
</div>

<ng-template #dir let-d let-depth="depth">
  @if (depth > 0) {
    <button class="tcv-code-node tcv-code-folder" [style.padding-left.px]="4 + (depth - 1) * 12"
            (click)="toggle(d.path)">
      <span class="tcv-code-caret">{{ shut().has(d.path) ? '▸' : '▾' }}</span>{{ d.name }}
    </button>
  }
  @if (!shut().has(d.path)) {
    @for (sub of d.dirs; track sub.path) {
      <ng-container *ngTemplateOutlet="dir; context: { $implicit: sub, depth: depth + 1 }" />
    }
    @for (f of d.files; track f.kind + f.id) {
      <button class="tcv-code-node tcv-code-file" [style.padding-left.px]="16 + depth * 12"
              [attr.data-on]="current()?.id === f.id && current()?.kind === f.kind ? 1 : null"
              [attr.data-used]="uses().has(f.id) ? 1 : null"
              [title]="uses().has(f.id) ? f.id + ' - used by ' + current()?.name : f.id"
              (click)="openFile(f.kind, f.id)">
        <span class="tcv-code-ext" [attr.data-kind]="f.kind">{{ f.kind === 'board' ? 'ato' : 'py' }}</span><span class="tcv-code-label">{{ f.label }}</span>
        @if (uses().has(f.id)) { <span class="tcv-code-used"></span> }
      </button>
    }
  }
</ng-template>`,
})
export class CodeView implements OnDestroy {
  private http = inject(HttpClient);
  private auth = inject(Auth);
  private catalog = inject(Catalog);
  kind = input.required<CodeKind>();
  /** The model's or board's id: opened in a tab, with its project on the left. */
  id = input.required<string>();
  title = input('');
  /** A line to go to once the file is open (from a search). */
  line = input<number | null>(null);
  closed = output<void>();
  /** Saved: the room may want to show the build is out of date. */
  saved = output<void>();

  private host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private m: MonacoApi | null = null;
  private editor: Monaco.editor.IStandaloneCodeEditor | null = null;
  private poll?: ReturnType<typeof setInterval>;

  tabs = signal<Tab[]>([]);
  current = signal<Tab | null>(null);
  error = signal<string | null>(null);
  saving = signal(false);
  copied = signal(false);
  project = signal<TreeDir | null>(null);
  /** Folders folded shut in the tree. */
  shut = signal(new Set<string>());
  /** Model name (the last part of its id) -> id, for imports. */
  private byName = new Map<string, string>();
  canEdit = () => this.auth.can('edit');

  /** What the open file imports, as model ids: marked in the tree. */
  uses = computed(() => {
    const t = this.current();
    this.tabs();                            // re-read after an edit
    const out = new Set<string>();
    if (!t || t.kind !== 'model') return out;
    for (const name of imports(t.model.getValue())) {
      const id = this.byName.get(name);
      if (id && id !== t.id) out.add(id);
    }
    return out;
  });

  constructor() {
    effect(() => {
      const id = this.id(), kind = this.kind();
      untracked(() => void this.start(kind, id));
    });
  }

  private touch() { this.tabs.set([...this.tabs()]); }

  private async start(kind: CodeKind, id: string) {
    this.error.set(null);
    try { this.m = await loadMonaco(); } catch (e) { this.error.set((e as Error).message); return; }
    if (!this.editor) {
      this.editor = this.m.editor.create(this.host().nativeElement, {
        model: null, theme: redlineTheme(this.m), readOnly: !this.canEdit(), automaticLayout: true,
        minimap: { enabled: true }, fontSize: 13, tabSize: 4, insertSpaces: true,
        fontFamily: 'ui-monospace, "JetBrains Mono", "Fira Code", Menlo, Consolas, monospace',
        scrollBeyondLastLine: false, renderWhitespace: 'selection', bracketPairColorization: { enabled: true },
      });
      this.editor.addCommand(this.m.KeyMod.CtrlCmd | this.m.KeyCode.KeyS, () => this.save());
      // Ctrl+click on an import opens the file it names.
      this.editor.onMouseDown(e => {
        if (!(e.event.ctrlKey || e.event.metaKey) || !e.target.position) return;
        const model = this.editor!.getModel();
        const word = model?.getWordAtPosition(e.target.position)?.word;
        const line = model?.getLineContent(e.target.position.lineNumber) ?? '';
        const target = word && /^\s*(from|import)\s/.test(line) ? this.byName.get(word) : undefined;
        if (target) { e.event.preventDefault(); void this.openFile('model', target); }
      });
      this.poll = setInterval(() => this.check(), 10_000);
    }
    this.readTree(kind, id);
    await this.openFile(kind, id);
  }

  /** The catalog, cut down to the project the file is in. */
  private readTree(kind: CodeKind, id: string) {
    this.catalog.tree().subscribe({
      next: root => {
        const top = root as FolderNode & { boards?: { id: string; name?: string }[] };
        this.byName.clear();
        const build = (n: typeof top): TreeDir => {
          for (const mm of n.models) this.byName.set(mm.name, mm.id);
          return {
            name: n.name, path: n.path,
            dirs: (n.folders as (typeof top)[]).map(build),
            files: [
              ...n.models.map(mm => ({ kind: 'model' as const, id: mm.id, label: `${mm.name}.py` })),
              ...(n.boards ?? []).map(b => ({ kind: 'board' as const, id: b.id, label: `${b.id}.ato` })),
            ],
          };
        };
        const all = build(top);
        const holds = (d: TreeDir): boolean =>
          d.files.some(f => f.kind === kind && f.id === id) || d.dirs.some(holds);
        this.project.set(all.dirs.find(holds) ?? all);
        this.touch();
      },
    });
  }

  private url(kind: CodeKind, id: string) {
    return kind === 'board' ? `/api/boards/${id}` : `/api/models/${id}`;
  }

  private read(kind: CodeKind, id: string) {
    return this.http.get<Read>(kind === 'board' ? this.url(kind, id) : `${this.url(kind, id)}/source`);
  }

  async openFile(kind: CodeKind, id: string) {
    const open = this.tabs().find(t => t.kind === kind && t.id === id);
    if (open) { this.activate(open); return; }
    this.read(kind, id).subscribe({
      next: d => {
        if (!this.m || this.tabs().some(t => t.kind === kind && t.id === id)) return;
        const model = this.m.editor.createModel(d.source, kind === 'board' ? 'atopile' : 'python',
                                                this.m.Uri.parse(`redline:///${key(kind, id)}`));
        const tab: Tab = {
          kind, id, name: `${id.split('/').pop()}.${kind === 'board' ? 'ato' : 'py'}`, model,
          rev: d.rev, savedAt: model.getAlternativeVersionId(), stale: !!d.stale, dirty: false,
          view: null, theirs: null, clash: null, status: '',
        };
        tab.status = this.describe(tab);
        model.onDidChangeContent(() => {
          const dirty = model.getAlternativeVersionId() !== tab.savedAt;
          if (dirty !== tab.dirty) { tab.dirty = dirty; this.touch(); }
        });
        this.tabs.set([...this.tabs(), tab]);
        this.activate(tab);
      },
      error: (e: HttpErrorResponse) => this.error.set(
        typeof e.error?.detail === 'string' ? e.error.detail : 'the source could not be read'),
    });
  }

  private describe(t: Tab): string {
    if (!this.canEdit()) return `read-only - ${this.auth.why('edit') ?? ''}`;
    return t.stale ? 'changed since the last build - Build to see it' : 'up to date with the build';
  }

  activate(t: Tab) {
    const was = this.current();
    if (was === t || !this.editor) return;
    if (was) was.view = this.editor.saveViewState();
    this.error.set(null);
    this.editor.setModel(t.model);
    if (t.view) this.editor.restoreViewState(t.view);
    const line = this.line();
    if (line && t.id === this.id() && !was) {
      this.editor.revealLineInCenter(line);
      this.editor.setSelection({ startLineNumber: line, startColumn: 1, endLineNumber: line,
                                 endColumn: t.model.getLineMaxColumn(line) });
    }
    this.editor.focus();
    this.current.set(t);
  }

  closeTab(t: Tab, ev?: Event) {
    ev?.stopPropagation();
    if (t.dirty && !confirm(`${t.name} has unsaved changes. Close it anyway?`)) return;
    const rest = this.tabs().filter(x => x !== t);
    if (this.current() === t) {
      const i = this.tabs().indexOf(t);
      const next = rest[Math.min(i, rest.length - 1)] ?? null;
      this.current.set(null);
      if (next) this.activate(next); else this.editor?.setModel(null);
    }
    this.tabs.set(rest);
    t.model.dispose();
    if (!rest.length) this.closed.emit();
  }

  toggle(path: string) {
    const s = new Set(this.shut());
    if (s.has(path)) s.delete(path); else s.add(path);
    this.shut.set(s);
  }

  /** Every ten seconds, each open file: has someone saved a newer version?
   *  Shown at once where nothing is being typed; otherwise asked. */
  private check() {
    if (document.hidden || this.saving()) return;
    for (const t of this.tabs()) {
      this.read(t.kind, t.id).subscribe({
        next: d => {
          if (d.rev === t.rev || t.model.isDisposed()) return;
          if (!t.dirty) { this.load(t, d); return; }
          t.theirs = d;
          t.clash = 'Someone else - an agent, most likely - saved a newer version while you were editing.';
          this.touch();
        },
      });
    }
  }

  private load(t: Tab, d: Read) {
    const view = this.current() === t ? this.editor?.saveViewState() : null;
    t.model.setValue(d.source);
    if (view) this.editor?.restoreViewState(view);
    t.rev = d.rev; t.stale = !!d.stale;
    t.savedAt = t.model.getAlternativeVersionId(); t.dirty = false;
    t.theirs = null; t.clash = null;
    t.status = this.describe(t);
    this.touch();
  }

  save(force = false) {
    const t = this.current();
    if (!t || this.saving() || (!t.dirty && !force)) return;
    this.saving.set(true);
    const body = { source: t.model.getValue(), if_match: force && t.theirs ? t.theirs.rev : t.rev };
    this.http.put<{ rev: string }>(this.url(t.kind, t.id), body).subscribe({
      next: r => {
        this.saving.set(false);
        t.rev = r.rev; t.stale = true; t.theirs = null; t.clash = null;
        t.savedAt = t.model.getAlternativeVersionId(); t.dirty = false;
        t.status = 'saved - Build to see it';
        this.touch();
        this.saved.emit();
      },
      error: (e: HttpErrorResponse) => {
        this.saving.set(false);
        if (e.status === 409) {
          this.read(t.kind, t.id).subscribe(d => {
            t.theirs = d;
            t.clash = 'Not saved: someone else saved a newer version while you were editing.';
            this.touch();
          });
          return;
        }
        const d = e.error?.detail;
        t.status = 'not saved - ' + (typeof d === 'string' ? d : 'that did not work');
        this.touch();
      },
    });
  }

  takeTheirs() {
    const t = this.current();
    if (t?.theirs) this.load(t, t.theirs);
  }

  copy() {
    navigator.clipboard?.writeText(this.current()?.model.getValue() ?? '').then(() => {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1500);
    });
  }

  close() {
    const dirty = this.tabs().filter(t => t.dirty).map(t => t.name);
    if (dirty.length && !confirm(`Unsaved changes in ${dirty.join(', ')}. Close without saving?`)) return;
    this.closed.emit();
  }

  ngOnDestroy() {
    clearInterval(this.poll);
    for (const t of this.tabs()) t.model.dispose();
    this.editor?.dispose();
  }
}

/** The module names a Python file imports: `import stand`, `from stand import X`. */
function imports(source: string): string[] {
  const out: string[] = [];
  // One line at a time ([ \t], not \s): `import a as A` must not run on into the next line.
  for (const m of source.matchAll(/^[ \t]*(?:from[ \t]+([\w.]+)[ \t]+import|import[ \t]+([\w., \t]+))/gm)) {
    for (const name of (m[1] ?? m[2] ?? '').split(',')) {
      const n = name.trim().split(/\s+/)[0]?.split('.').pop();
      if (n) out.push(n);
    }
  }
  return out;
}
