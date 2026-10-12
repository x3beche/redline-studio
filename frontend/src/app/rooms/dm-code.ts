import { Component, ViewEncapsulation, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { T } from '../i18n';
import { highlightLines } from '../code-highlight';
import { Skeleton } from '../skeleton';

/** One file of source for DmCode: its tab's name, a line under it, the text and its language. */
export interface CodeFile { name: string; sub?: string; text: string; lang?: string }

/** The language highlight.js knows a file by, from its name. */
export function langOf(name: string): string {
  const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();
  const map: Record<string, string> = {
    py: 'python', '3d': 'python', c: 'c', h: 'cpp', hpp: 'cpp', cpp: 'cpp', cc: 'cpp', ino: 'cpp', ts: 'typescript',
    js: 'javascript', json: 'json', yml: 'yaml', yaml: 'yaml', ini: 'ini', toml: 'ini', md: 'markdown', sh: 'bash',
    xml: 'xml', svg: 'xml', html: 'xml', rs: 'rust', go: 'go', java: 'java', cs: 'csharp', sql: 'sql', cmake: 'cmake',
    csv: 'plaintext', tsv: 'plaintext', txt: 'plaintext', ato: 'python',
  };
  if (/^makefile$/i.test(name)) return 'makefile';
  if (/platformio\.ini$/i.test(name)) return 'ini';
  return map[ext] ?? '';
}

/** One row of the file tree: a folder (open or shut) or a file. */
interface TreeRow { key: string; name: string; depth: number; dir: boolean; open?: boolean; file?: number; kind?: string; count?: number }

/** What a file's icon says it is, from its name. */
function kindOf(name: string): string {
  const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();
  if (ext === '3d' || ext === 'py') return 'model';
  if (ext === 'ato') return 'board';
  if (['c', 'cpp', 'cc', 'ino'].includes(ext)) return 'c';
  if (['h', 'hpp'].includes(ext)) return 'h';
  if (['ini', 'toml', 'json', 'yml', 'yaml'].includes(ext) || /platformio\.ini$/i.test(name)) return 'conf';
  if (['md', 'txt'].includes(ext)) return 'text';
  return 'file';
}

/** Source, read-only, laid out as an editor is: the files as a folder tree
 *  on the left (by their paths, a filter over it, the main file first and
 *  marked), the open file on the right - its path as a breadcrumb, the
 *  files opened as tabs, coloured as the app colours code elsewhere
 *  (code-highlight.ts, the theme's `.hljs-*`), line numbers, wrap, copy.
 *  The panel keeps its size whatever is open; each side scrolls itself. */
@Component({
  selector: 'app-dm-code',
  imports: [Skeleton, T],
  encapsulation: ViewEncapsulation.None,
  host: { class: 'dmc', '[attr.data-wrap]': 'wrap() ? 1 : null', '[style.height]': 'height()', '[style.--layout-dmc-tree]': 'treeW() + "px"', '[attr.data-single]': 'files().length < 2 ? 1 : null' },
  styles: [`
    .dmc { display: grid; grid-template-columns: var(--layout-dmc-tree, 240px) 5px minmax(0, 1fr); min-width: 0; min-height: 0;
           border: 1px solid var(--line); border-radius: 6px; background: var(--surface-2); overflow: hidden; }
    .dmc[data-single] { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); }
    .dmc[data-single] .dmc-side, .dmc[data-single] .dmc-grip { display: none; }
    .dmc-side { display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--surface); }
    .dmc-find { flex: none; margin: 8px; height: 26px; padding: 0 8px; font-size: 12px; color: var(--ink); background: var(--surface-2);
                border: 1px solid var(--line); border-radius: 4px; outline: none; }
    .dmc-find:focus { border-color: var(--accent); }
    .dmc-head { flex: none; padding: 0 10px 4px; font-size: 10px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-dim); }
    .dmc-tree { flex: 1; min-height: 0; overflow: auto; padding-bottom: 8px; scrollbar-width: thin; }
    .dmc-row { display: flex; align-items: center; gap: 6px; width: 100%; min-width: 0; padding: 3px 8px 3px calc(8px + var(--layout-depth, 0) * 12px);
               font: inherit; font-size: 12px; color: var(--ink); text-align: left; background: none; border: 0; cursor: pointer; }
    .dmc-row:hover { background: var(--hover); }
    .dmc-row[data-on] { color: var(--ink-bright); background: var(--accent-deep); }
    .dmc-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .dmc-row > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dmc-row svg { flex: none; width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
    .dmc-row[data-dir] { color: var(--ink-dim); font-weight: 500; }
    .dmc-row[data-dir] svg { color: var(--ink-dim); }
    .dmc-row[data-kind="model"] svg { color: var(--series-1); }
    .dmc-row[data-kind="board"] svg { color: var(--series-3); }
    .dmc-row[data-kind="c"] svg { color: var(--series-5); }
    .dmc-row[data-kind="h"] svg { color: var(--series-4); }
    .dmc-row[data-kind="conf"] svg { color: var(--series-2); }
    .dmc-main { flex: none; margin-left: auto; padding: 0 5px; font-size: 9.5px; letter-spacing: .04em; text-transform: uppercase; color: var(--accent);
                border: 1px solid var(--accent); border-radius: 8px; }
    .dmc-count { flex: none; margin-left: auto; font: 10px 'IBM Plex Mono', ui-monospace, monospace; color: var(--ink-dim); }
    .dmc-grip { cursor: col-resize; background: var(--surface); border-left: 1px solid var(--line); border-right: 1px solid var(--line); }
    .dmc-grip:hover, .dmc-grip[data-drag] { background: var(--accent-deep); }
    .dmc-ed { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
    .dmc-open { flex: none; display: flex; min-width: 0; overflow-x: auto; scrollbar-width: thin; background: var(--surface); border-bottom: 1px solid var(--line); }
    .dmc-tab { flex: none; display: inline-flex; align-items: center; gap: 6px; max-width: 220px; padding: 0 6px 0 12px; height: 32px; font-size: 12px;
               color: var(--ink-dim); background: none; border: 0; border-right: 1px solid var(--line); border-top: 2px solid transparent; cursor: pointer; }
    .dmc-tab > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dmc-tab:hover { color: var(--ink); background: var(--hover); }
    .dmc-tab[data-on] { color: var(--ink-bright); background: var(--surface-2); border-top-color: var(--accent); }
    .dmc-x { width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; border-radius: 3px; color: var(--ink-dim); }
    .dmc-x:hover { color: var(--ink); background: var(--pressed); }
    .dmc-bar { flex: none; display: flex; align-items: center; gap: 6px; min-width: 0; padding: 4px 8px 4px 12px; border-bottom: 1px solid var(--line); }
    .dmc-crumbs { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 11.5px 'IBM Plex Mono', ui-monospace, monospace; color: var(--ink-dim); }
    .dmc-crumbs b { font-weight: 500; color: var(--ink); }
    .dmc-sep { margin: 0 5px; opacity: .6; }
    .dmc-info { flex: none; font: 10.5px 'IBM Plex Mono', ui-monospace, monospace; color: var(--ink-dim); white-space: nowrap; }
    .dmc-act { flex: none; height: 24px; padding: 0 8px; font-size: 11.5px; color: var(--ink-dim); background: none; border: 1px solid var(--line);
               border-radius: 4px; cursor: pointer; white-space: nowrap; }
    .dmc-act:hover { color: var(--ink); background: var(--hover); }
    .dmc-act[data-on] { color: var(--accent); border-color: var(--accent); }
    .dmc-act:focus-visible, .dmc-tab:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .dmc-body { flex: 1; min-height: 0; overflow: auto; scrollbar-width: thin; }
    .dmc-lines { min-width: 100%; width: max-content; padding: 6px 0; font: 12px/1.55 'IBM Plex Mono', ui-monospace, monospace; color: var(--ink); }
    .dmc[data-wrap] .dmc-lines { width: auto; }
    .dmc-ln { display: grid; grid-template-columns: var(--layout-dmc-gutter, 3.5em) minmax(0, 1fr); }
    .dmc-ln:hover { background: var(--hover); }
    .dmc-no { position: sticky; left: 0; padding: 0 12px 0 8px; text-align: right; color: var(--ink-dim); opacity: .7;
              background: var(--surface-2); user-select: none; border-right: 1px solid var(--line); }
    .dmc-ln:hover .dmc-no { background: var(--hover); opacity: 1; }
    .dmc-tx { padding: 0 14px 0 12px; white-space: pre; }
    .dmc[data-wrap] .dmc-tx { white-space: pre-wrap; overflow-wrap: anywhere; }
    .dmc-empty { padding: 14px; font-size: 12px; color: var(--ink-dim); }
    @media (max-width: 760px) {
      .dmc { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 32%) minmax(0, 1fr); }
      .dmc-grip, .dmc-open, .dmc-info { display: none; }
      .dmc-side { border-bottom: 1px solid var(--line); }
    }
  `],
  template: `
<div class="dmc-side">
  <input class="dmc-find" type="search" [placeholder]="'Filter files' | t" [value]="q()" (input)="q.set($any($event.target).value)"
         [attr.aria-label]="'Filter files' | t">
  <div class="dmc-head">{{ 'Files' | t }} · {{ files().length }}</div>
  <div class="dmc-tree" role="tree">
    @for (r of rows(); track r.key) {
      @if (r.dir) {
        <button class="dmc-row" data-dir="1" role="treeitem" [attr.aria-expanded]="r.open" [style.--layout-depth]="r.depth" (click)="toggle(r.key)" [title]="r.key">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="r.open ? I.open : I.shut" /></svg><span>{{ r.name }}</span>
          <em class="dmc-count">{{ r.count }}</em>
        </button>
      } @else {
        <button class="dmc-row" role="treeitem" [attr.data-kind]="r.kind" [attr.data-on]="r.file === at() ? 1 : null" [attr.aria-selected]="r.file === at()"
                [style.--layout-depth]="r.depth" (click)="openFile(r.file!)" [title]="pathOf(r.file!)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="I.file" /></svg><span>{{ r.name }}</span>
          @if (r.file === 0 && files().length > 1) { <em class="dmc-main">{{ 'main' | t }}</em> }
        </button>
      }
    } @empty { <p class="dmc-empty">{{ 'Nothing matches.' | t }}</p> }
  </div>
</div>
<div class="dmc-grip" [attr.data-drag]="dragging() ? 1 : null" (pointerdown)="grab($event)" role="separator" aria-orientation="vertical"></div>
<div class="dmc-ed">
  @if (opened().length > 1) {
    <div class="dmc-open" role="tablist">
      @for (i of opened(); track i) {
        <button class="dmc-tab" role="tab" [attr.data-on]="i === at() ? 1 : null" [attr.aria-selected]="i === at()" (click)="at.set(i)" [title]="pathOf(i)">
          <span>{{ pathOf(i).split('/').pop() }}</span>
          <i class="dmc-x" role="button" [attr.aria-label]="'Close' | t" (click)="closeFile(i); $event.stopPropagation()">×</i></button>
      }
    </div>
  }
  <div class="dmc-bar">
    <span class="dmc-crumbs">@for (c of crumbs(); track $index; let last = $last) { @if (last) { <b>{{ c }}</b> } @else { {{ c }}<span class="dmc-sep">›</span> } }</span>
    @if (cur()) { <span class="dmc-info">{{ lineCount() }} {{ 'lines' | t }}</span> }
    <button class="dmc-act" [attr.data-on]="wrap() ? 1 : null" (click)="wrap.set(!wrap())" [attr.aria-pressed]="wrap()">{{ 'Wrap' | t }}</button>
    <button class="dmc-act" (click)="copy()">{{ (copied() ? 'Copied' : 'Copy') | t }}</button>
  </div>
  <div class="dmc-body" role="region" [attr.aria-label]="pathOf(at())">
    @if (html(); as h) {
      <div class="dmc-lines" [style.--layout-dmc-gutter]="gutter()" [innerHTML]="h"></div>
    } @else if (cur()) {
      <wb-skel kind="text" [count]="14" style="padding: 10px 14px" />
    } @else {
      <div class="dmc-empty">{{ 'No source was sent with it.' | t }}</div>
    }
  </div>
</div>`,
})
export class DmCode {
  private san = inject(DomSanitizer);
  files = input.required<CodeFile[]>();
  /** The panel's height, CSS: it stays the same whatever is open. */
  height = input('420px');
  readonly I = {
    file: 'M6 3h8l4 4v14H6z M14 3v4h4',
    shut: 'M9 6l6 6-6 6',
    open: 'M6 9l6 6 6-6',
  };
  at = signal(0);
  opened = signal<number[]>([0]);
  shut = signal<Set<string>>(new Set());
  q = signal('');
  wrap = signal(false);
  copied = signal(false);
  html = signal<SafeHtml | null>(null);
  lineCount = signal(0);
  treeW = signal(240);
  dragging = signal(false);
  cur = computed(() => this.files()[Math.min(this.at(), this.files().length - 1)] ?? null);
  gutter = computed(() => `${Math.max(2, String(this.lineCount()).length) + 2.2}ch`);
  pathOf(i: number) { const f = this.files()[i]; return f ? f.sub || f.name : ''; }
  crumbs = computed(() => this.pathOf(this.at()).split('/').filter(x => x));
  /** The tree, folders first, as rows: what the filter keeps, folders shut where they were shut. */
  rows = computed<TreeRow[]>(() => {
    type Node = { dirs: Map<string, Node>; files: number[]; count: number };
    const root: Node = { dirs: new Map(), files: [], count: 0 };
    const w = this.q().trim().toLowerCase();
    this.files().forEach((f, i) => {
      const path = this.pathOf(i);
      if (w && !path.toLowerCase().includes(w)) return;
      const parts = path.split('/').filter(x => x);
      let n = root;
      n.count++;
      for (const dir of parts.slice(0, -1)) {
        if (!n.dirs.has(dir)) n.dirs.set(dir, { dirs: new Map(), files: [], count: 0 });
        n = n.dirs.get(dir)!;
        n.count++;
      }
      n.files.push(i);
    });
    const out: TreeRow[] = [], shut = this.shut();
    const walk = (n: Node, depth: number, key: string) => {
      for (const [name, sub] of [...n.dirs].sort((a, b) => a[0].localeCompare(b[0]))) {
        const k = key + '/' + name, open = !!w || !shut.has(k);
        out.push({ key: k, name, depth, dir: true, open, count: sub.count });
        if (open) walk(sub, depth + 1, k);
      }
      for (const i of [...n.files].sort((a, b) => (a === 0 ? -1 : b === 0 ? 1 : this.files()[a].name.localeCompare(this.files()[b].name)))) {
        out.push({ key: key + '#' + i, name: this.pathOf(i).split('/').pop() || this.files()[i].name, depth, dir: false, file: i, kind: kindOf(this.pathOf(i)) });
      }
    };
    walk(root, 0, '');
    return out;
  });
  private seq = 0;

  constructor() {
    effect(() => {
      const f = this.cur();
      untracked(() => void this.paint(f));
    });
    effect(() => { this.files(); untracked(() => { this.at.set(0); this.opened.set([0]); this.q.set(''); }); });
  }

  toggle(key: string) { this.shut.update(s => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; }); }
  openFile(i: number) {
    this.at.set(i);
    if (!this.opened().includes(i)) this.opened.update(o => [...o, i].slice(-8));
  }
  closeFile(i: number) {
    const o = this.opened().filter(x => x !== i);
    this.opened.set(o.length ? o : [0]);
    if (this.at() === i) this.at.set(this.opened()[this.opened().length - 1]);
  }
  grab(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement, x0 = e.clientX, w0 = this.treeW();
    el.setPointerCapture(e.pointerId);
    this.dragging.set(true);
    const move = (m: PointerEvent) => this.treeW.set(Math.max(160, Math.min(520, w0 + m.clientX - x0)));
    const up = () => { this.dragging.set(false); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  }

  private async paint(f: CodeFile | null) {
    const n = ++this.seq;
    if (!f) { this.html.set(null); this.lineCount.set(0); return; }
    const text = f.text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
    const lines = await highlightLines(text, f.lang ?? langOf(f.sub || f.name));
    if (n !== this.seq) return;
    this.lineCount.set(lines.length);
    // highlight.js escapes the text; the markup is its own spans and ours.
    const rows = lines.map((l, i) => `<div class="dmc-ln"><span class="dmc-no">${i + 1}</span><span class="dmc-tx">${l || ' '}</span></div>`);
    this.html.set(this.san.bypassSecurityTrustHtml(rows.join('')));
  }

  copy() {
    const f = this.cur();
    if (!f) return;
    void navigator.clipboard?.writeText(f.text).then(() => {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1500);
    }).catch(() => {});
  }
}
