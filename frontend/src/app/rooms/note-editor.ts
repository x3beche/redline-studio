import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import Image from '@tiptap/extension-image';
import Suggestion, { SuggestionProps } from '@tiptap/suggestion';
import { EditorState, Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PmNode } from '@tiptap/pm/model';
import { t } from '../i18n';
import { Confirm } from '../confirm';

/** The note editor: TipTap (ProseMirror) reading and writing Markdown.
 *
 *  A note is stored as Markdown - the backend reads the title, #tags and
 *  `- [ ]` to-dos out of the text, and the Chat writes notes the same
 *  way - so the editor is only a better way to change that text. This
 *  file is loaded on first use (note-doc.ts imports it lazily), so the
 *  editor costs nothing until a note is opened.
 */

/** A block the "/" menu (and the toolbar) can put in. */
export interface SlashItem { id: string; label: string; hint: string; keys: string; run: (e: Editor) => void }

export const SLASH_ITEMS: SlashItem[] = [
  { id: 'p', label: 'Text', hint: 'Plain paragraph', keys: 'text paragraph metin', run: e => e.chain().focus().setParagraph().run() },
  { id: 'h1', label: 'Heading 1', hint: '#', keys: 'h1 heading title başlık', run: e => e.chain().focus().setHeading({ level: 1 }).run() },
  { id: 'h2', label: 'Heading 2', hint: '##', keys: 'h2 heading section başlık', run: e => e.chain().focus().setHeading({ level: 2 }).run() },
  { id: 'h3', label: 'Heading 3', hint: '###', keys: 'h3 heading subsection başlık', run: e => e.chain().focus().setHeading({ level: 3 }).run() },
  { id: 'todo', label: 'To-do list', hint: '- [ ]', keys: 'todo task checkbox yapılacak görev', run: e => e.chain().focus().toggleTaskList().run() },
  { id: 'ul', label: 'Bulleted list', hint: '-', keys: 'bullet list ul liste', run: e => e.chain().focus().toggleBulletList().run() },
  { id: 'ol', label: 'Numbered list', hint: '1.', keys: 'numbered ordered list ol liste', run: e => e.chain().focus().toggleOrderedList().run() },
  { id: 'table', label: 'Table', hint: '3 × 3', keys: 'table grid tablo', run: e => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { id: 'quote', label: 'Quote', hint: '>', keys: 'quote callout blockquote alıntı', run: e => e.chain().focus().toggleBlockquote().run() },
  { id: 'code', label: 'Code block', hint: '```', keys: 'code block pre kod', run: e => e.chain().focus().toggleCodeBlock().run() },
  { id: 'hr', label: 'Divider', hint: '---', keys: 'divider rule hr line ayırıcı çizgi', run: e => e.chain().focus().setHorizontalRule().run() },
  { id: 'img', label: 'Image', hint: 'from a link', keys: 'image picture resim görsel', run: e => {
    Confirm.input({ title: t('Image address (https://…)'), placeholder: 'https://', ok: t('Insert') }).then(src => {
      if (src && /^https?:\/\//.test(src)) e.chain().focus().setImage({ src }).run();
    });
  } },
];

/** What the "/" menu shows; the Angular side draws it. */
export interface SlashState { items: SlashItem[]; index: number; x: number; y: number; pick: (i: number) => void }

export interface NoteEditorOptions {
  element: HTMLElement;
  markdown: string;
  editable: boolean;
  placeholder: string;
  /** On an empty line of a note that has words. */
  slashHint: string;
  onChange: (markdown: string) => void;
  /** A to-do ticked while reading: its place among the note's to-dos. */
  onTick: (index: number) => void;
  onSlash: (s: SlashState | null) => void;
  onSelection: () => void;
}

/* #tags and @names, as the backend reads them (backend/notes.py). */
const TAG = /(?<![\p{L}\p{N}_#&/])#(\p{L}[\p{L}\p{N}_-]*)/gu;
const AT = /(?<![\p{L}\p{N}_@])@([\p{L}\p{N}_][\p{L}\p{N}_\-./]*[\p{L}\p{N}_])/gu;

function chips(doc: PmNode): DecorationSet {
  const out: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'table') { figures(node, pos, out); return true; }
    if (!node.isTextblock) return true;
    if (node.type.spec.code) return false;
    // The block's text, one character per position; code spans and
    // inline nodes blanked so nothing inside them is read.
    let s = '';
    node.forEach(ch => {
      s += ch.isText && !ch.marks.some(m => m.type.spec.code) ? ch.text! : '\u0000'.repeat(ch.nodeSize);
    });
    for (const m of s.matchAll(TAG)) {
      if (/^[0-9a-f]{3,8}$/i.test(m[1]) && /\d/.test(m[1])) continue;   // a colour, not a tag
      out.push(Decoration.inline(pos + 1 + m.index!, pos + 1 + m.index! + m[0].length, { class: 'tcv-note-tag', 'data-tag': m[1].toLowerCase() }));
    }
    for (const m of s.matchAll(AT)) {
      out.push(Decoration.inline(pos + 1 + m.index!, pos + 1 + m.index! + m[0].length, { class: 'tcv-note-at' }));
    }
    return false;
  });
  return DecorationSet.create(doc, out);
}

/** A cell that is a figure: 22,260 · $0.5082 · 37 (short) · 12 mm · 40%. */
const FIGURE = /^(about |approx\.? |ca\. |yaklaşık |[~≈])?[-+]?[$€£₺]?\d[\d.,]*\s*(%|[\p{L}µ°Ω]{1,4})?(\s*\([^)]*\))?$/u;

/** Columns of figures are set to the right, header included. */
function figures(table: PmNode, pos: number, out: Decoration[]) {
  const cells: { col: number; from: number; to: number; text: string; head: boolean }[] = [];
  table.forEach((row, rowOff) => {
    let col = 0;
    row.forEach((cell, cellOff) => {
      const from = pos + 1 + rowOff + 1 + cellOff;
      cells.push({ col, from, to: from + cell.nodeSize, text: cell.textContent.trim(), head: cell.type.name === 'tableHeader' });
      col += cell.attrs['colspan'] ?? 1;
    });
  });
  const cols = new Set(cells.map(c => c.col));
  for (const col of cols) {
    const body = cells.filter(c => c.col === col && !c.head && c.text);
    // Mostly figures: a "Total" label in a column of prices goes with them.
    if (body.length && body.filter(c => FIGURE.test(c.text)).length >= Math.max(1, body.length * .75)) {
      for (const c of cells.filter(c => c.col === col)) out.push(Decoration.node(c.from, c.to, { class: 'tcv-num' }));
    }
  }
}

const Chips = Extension.create({
  name: 'noteChips',
  addProseMirrorPlugins() {
    const key = new PluginKey('noteChips');
    return [new Plugin({
      key,
      state: {
        init: (_, st) => chips(st.doc),
        apply: (tr, old) => tr.docChanged ? chips(tr.doc) : old,
      },
      props: { decorations: st => key.getState(st) },
    })];
  },
});

function slash(onSlash: (s: SlashState | null) => void) {
  return Extension.create({
    name: 'noteSlash',
    addProseMirrorPlugins() {
      let props: SuggestionProps<SlashItem> | null = null;
      let index = 0;
      const show = () => {
        if (!props || !props.items.length) { onSlash(null); return; }
        const r = props.clientRect?.();
        const p = props;
        onSlash({ items: p.items, index, x: r?.left ?? 0, y: r?.bottom ?? 0, pick: i => p.command(p.items[i]) });
      };
      return [Suggestion<SlashItem>({
        editor: this.editor,
        char: '/',
        startOfLine: false,
        allowSpaces: false,
        pluginKey: new PluginKey('noteSlash'),
        // Only where a block starts, or after a space: a path like a/b is left alone.
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          if ($from.parent.type.spec.code) return false;
          const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
          return before === '' || /\s$/.test(before);
        },
        items: ({ query }) => {
          const q = query.toLowerCase();
          if (!q) return SLASH_ITEMS;
          // A name that starts with what was typed first, then one that has it, then a keyword.
          const rank = (i: SlashItem) => { const l = t(i.label).toLowerCase(), e = i.label.toLowerCase();
            return l.startsWith(q) || e.startsWith(q) ? 0 : l.includes(q) || e.includes(q) ? 1 : i.keys.includes(q) ? 2 : 9; };
          return SLASH_ITEMS.filter(i => rank(i) < 9).sort((a, b) => rank(a) - rank(b));
        },
        command: ({ editor, range, props: item }) => {
          editor.chain().focus().deleteRange(range).run();
          item.run(editor);
        },
        render: () => ({
          onStart: p => { props = p; index = 0; show(); },
          onUpdate: p => { props = p; index = Math.min(index, Math.max(0, p.items.length - 1)); show(); },
          onKeyDown: ({ event }) => {
            if (!props || !props.items.length) return false;
            const n = props.items.length;
            if (event.key === 'ArrowDown') { index = (index + 1) % n; show(); return true; }
            if (event.key === 'ArrowUp') { index = (index + n - 1) % n; show(); return true; }
            if (event.key === 'Enter' || event.key === 'Tab') { props.command(props.items[index]); return true; }
            if (event.key === 'Escape') { props = null; onSlash(null); return true; }
            return false;
          },
          onExit: () => { props = null; onSlash(null); },
        }),
      })];
    },
  });
}

/** Text is written back as it was typed: the library would put a
 *  backslash before every `_`, `*` or `[` and turn `&` into `&amp;`, and a
 *  note is read by people and by the Chat as plain text. A mark is
 *  escaped only where it could pair up with another and change the
 *  meaning when the note is read again. */
function plain(text: string): string {
  const pairs = (ch: string) => text.split(ch).length > 2;
  let out = text;
  if (pairs('*')) out = out.replace(/\*/g, '\\*');
  if (pairs('`')) out = out.replace(/`/g, '\\`');
  if (out.includes('~~')) out = out.replace(/~/g, '\\~');
  // _ is emphasis only at a word's edge (snake_case is left alone).
  if ((text.match(/(^|[^\p{L}\p{N}])_|_($|[^\p{L}\p{N}])/gu) ?? []).length > 1) {
    out = out.replace(/(^|[^\p{L}\p{N}\\])_|_(?=$|[^\p{L}\p{N}])/gu, (m, pre) => pre !== undefined ? `${pre}\\_` : '\\_');
  }
  out = out.replace(/\[([^\]]*)\](?=[(\[:])/g, '\\[$1\\]');   // would read as a link
  return out;
}

/** The library leaves blank lines around tables and spaces on blank
 *  lines in lists, and writes a bare address as [address](address);
 *  outside code, none of these. */
function tidy(md: string): string {
  return md.split(/(^```[\s\S]*?^```)/m)
    .map((part, i) => i % 2 ? part : part.replace(/^[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n')
      .replace(/\[((?:https?:\/\/|mailto:)[^\]\s]+)\]\(\1\)/g, '$1'))
    .join('').replace(/\s+$/, '');
}

/** Markdown in, with what the parser keeps that Markdown does not mean
 *  (spaces before a paragraph inside a list item, which would grow by one
 *  every time the note is written back) left out. */
function parse(editor: Editor, md: string): any {
  const doc = editor.markdown!.parse(md);
  const walk = (n: any) => {
    if ((n.type === 'paragraph' || n.type === 'heading') && n.content?.[0]?.type === 'text') {
      n.content[0].text = n.content[0].text.replace(/^[ \t]+/, '');
      if (!n.content[0].text) n.content.shift();
    }
    n.content?.forEach(walk);
  };
  walk(doc);
  return doc;
}

export function createNoteEditor(o: NoteEditorOptions): Editor {
  let editor!: Editor;
  editor = new Editor({
    element: o.element,
    editable: o.editable,
    extensions: [
      StarterKit.configure({
        link: { openOnClick: false, autolink: true, HTMLAttributes: { target: '_blank', rel: 'noreferrer' } },
      }),
      Markdown.configure({ indentation: { style: 'space', size: 2 } }),
      TaskList,
      TaskItem.configure({
        nested: true,
        onReadOnlyChecked: node => {
          let i = -1, at = -1;
          editor.state.doc.descendants(n => { if (n.type.name === 'taskItem') { i++; if (n === node) at = i; } return at < 0; });
          if (at >= 0) o.onTick(at);
          return false;   // the note's text is rewritten, and the editor reads it again
        },
      }),
      TableKit.configure({ table: { resizable: false } }),
      Image,
      Placeholder.configure({
        placeholder: ({ editor: e, node }) => e.isEmpty ? o.placeholder : node.type.name === 'paragraph' ? o.slashHint : '',
      }),
      Chips,
      slash(o.onSlash),
    ],
    content: '',
    editorProps: { attributes: { class: 'tcv-doc', spellcheck: 'false' } },
    onUpdate: () => o.onChange(markdownOf(editor)),
    onSelectionUpdate: () => o.onSelection(),
    onTransaction: () => o.onSelection(),
  });
  setMarkdown(editor, o.markdown);
  (editor.markdown as any).encodeTextForMarkdown = function (this: any, text: string, node: any, parent: any) {
    const code = (parent?.type && this.codeTypes.has(parent.type))
      || (node.marks || []).some((m: any) => this.codeTypes.has(typeof m === 'string' ? m : m.type));
    return code ? text : plain(text);
  };
  return editor;
}

export function markdownOf(editor: Editor): string { return tidy(editor.getMarkdown()); }

/** Another text: a fresh start, with nothing to undo back into the last one. */
export function setMarkdown(editor: Editor, md: string) {
  const doc = editor.schema.nodeFromJSON(parse(editor, md));
  editor.view.updateState(EditorState.create({ doc, plugins: editor.state.plugins }));
}
