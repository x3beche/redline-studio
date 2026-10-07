import { Pipe, PipeTransform } from '@angular/core';

/** Markdown, in about a hundred lines.
 *
 *  The agent's questions are written in Markdown - a question worth
 *  stopping for usually carries a measurement, two options and the
 *  reasoning between them, and that reads as a list or a table or it does
 *  not read at all. Rendering it needs a subset: headings, emphasis,
 *  code, lists, quotes, tables, links.
 *
 *  A library would be a third of the size of the whole application for
 *  the footnote syntax nobody writing a question will use, so this is
 *  hand-written. Everything is escaped before a single mark is read, so
 *  the only tags in the output are the ones made here - and Angular
 *  sanitises what goes through [innerHTML] on top of that.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

function escape(text: string): string {
  return text.replace(/[&<>"']/g, ch => ESCAPES[ch]);
}

/** Marks that live inside a line, applied to text that is already escaped.
 *
 *  Code spans are lifted out first and put back last: `**` inside one is
 *  two asterisks, not an instruction. */
function inline(text: string): string {
  const spans: string[] = [];
  let out = text.replace(/`([^`]+)`/g, (_, body: string) => {
    spans.push(`<code>${body}</code>`);
    return `\u0000${spans.length - 1}\u0000`;
  });
  out = out
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
             '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>')
    .replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_(?=\S)([^_]*?\S)_/g, '$1<em>$2</em>');
  return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => spans[+i]);
}

const FENCE = /^\s*```/;
const HEAD = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
// A quote marker has been escaped by the time this sees it.
const QUOTE = /^\s*&gt;\s?(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBER = /^\s*\d+[.)]\s+(.*)$/;
const ROW = /^\s*\|(.+)\|\s*$/;
const DIVIDER = /^\s*\|?[\s:-]*-[\s|:-]*$/;

function cells(line: string): string[] {
  const m = ROW.exec(line);
  return (m ? m[1] : line).split('|').map(c => c.trim());
}

/** Maths, lifted out before anything else reads the text.
 *
 *  Models write TeX: \\( \\) and $ $ inline, \\[ \\] and $$ $$ on lines of their
 *  own. Each is swapped for a mark before the Markdown is read (so `_` and
 *  `*` in a formula stay maths) and comes back as a span holding the escaped
 *  TeX; typesetMath() turns those into KaTeX once they are on the page.
 *  Code - fenced or inline - is passed over, so a `$` in a shell line is
 *  only a dollar. A lone `$` (a price) is left alone: an inline $...$ must
 *  hug its contents and not be followed by a digit. */
const MATH = /(```[\s\S]*?(?:```|$)|`[^`\n]+`)|\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$(?=[^\s$])([^$\n]*?[^\s$\\])\$(?!\d)/g;

function liftMath(src: string): { text: string; math: string[] } {
  const math: string[] = [];
  const text = src.replace(MATH, (all, code: string, dd: string, bd: string, bi: string, di: string) => {
    if (code) return all;
    const display = dd ?? bd;
    const tex = (display ?? bi ?? di).trim();
    math.push(`<span class="md-math${display !== undefined ? ' md-math-d' : ''}">${escape(tex)}</span>`);
    const mark = `\u0001${math.length - 1}\u0001`;
    return display !== undefined ? `\n\n${mark}\n\n` : mark;
  });
  return { text, math };
}

/** Markdown to HTML. */
export function toHtml(src: string): string {
  const lifted = liftMath((src ?? '').replace(/\r\n?/g, '\n'));
  return lifted.math.length
    ? markdown(lifted.text)
        .replace(/<p>\u0001(\d+)\u0001<\/p>/g, (_, i: string) => lifted.math[+i])
        .replace(/\u0001(\d+)\u0001/g, (_, i: string) => lifted.math[+i])
    : markdown(lifted.text);
}

function markdown(src: string): string {
  const lines = escape(src).split('\n');
  const out: string[] = [];

  let para: string[] = [];
  let quote: string[] = [];
  let items: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let fence: string[] | null = null;

  const closeParagraph = () => {
    if (para.length) out.push(`<p>${inline(para.join('<br>'))}</p>`);
    para = [];
  };
  const closeList = () => {
    if (list) {
      out.push(`<${list}>`
        + items.map(i => `<li>${inline(i)}</li>`).join('')
        + `</${list}>`);
    }
    list = null;
    items = [];
  };
  const closeQuote = () => {
    if (quote.length) out.push(`<blockquote>${inline(quote.join('<br>'))}</blockquote>`);
    quote = [];
  };
  const close = () => { closeParagraph(); closeList(); closeQuote(); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (fence) {
      if (FENCE.test(line)) {
        out.push(`<pre><code>${fence.join('\n')}</code></pre>`);
        fence = null;
      } else {
        fence.push(line);
      }
      continue;
    }
    if (FENCE.test(line)) { close(); fence = []; continue; }

    if (!line.trim()) { close(); continue; }

    if (RULE.test(line)) { close(); out.push('<hr>'); continue; }

    const head = HEAD.exec(line);
    if (head) {
      close();
      const level = Math.min(head[1].length + 2, 6);
      out.push(`<h${level}>${inline(head[2])}</h${level}>`);
      continue;
    }

    // A table is a header row, a row of dashes, and the body. Without the
    // dashes it is just a line with pipes in it.
    if (ROW.test(line) && i + 1 < lines.length && DIVIDER.test(lines[i + 1])
        && lines[i + 1].includes('-')) {
      close();
      const head_cells = cells(line);
      const body: string[] = [];
      let j = i + 2;
      for (; j < lines.length && ROW.test(lines[j]); j++) {
        body.push(`<tr>${cells(lines[j]).map(c => `<td>${inline(c)}</td>`).join('')}</tr>`);
      }
      out.push('<table><thead><tr>'
        + head_cells.map(c => `<th>${inline(c)}</th>`).join('')
        + `</tr></thead><tbody>${body.join('')}</tbody></table>`);
      i = j - 1;
      continue;
    }

    const quoted = QUOTE.exec(line);
    if (quoted) { closeParagraph(); closeList(); quote.push(quoted[1]); continue; }
    closeQuote();

    const bullet = BULLET.exec(line);
    const numbered = NUMBER.exec(line);
    if (bullet || numbered) {
      closeParagraph();
      const want = bullet ? 'ul' : 'ol';
      if (list && list !== want) closeList();
      list = want;
      items.push((bullet ?? numbered)![1]);
      continue;
    }
    // An unmarked line under a list belongs to the item above it.
    if (list && /^\s/.test(line)) {
      items[items.length - 1] += ' ' + line.trim();
      continue;
    }
    closeList();
    para.push(line.trim());
  }

  if (fence) out.push(`<pre><code>${fence.join('\n')}</code></pre>`);
  close();
  return out.join('');
}

/** The same text with the marks taken off, for somewhere one line fits. */
export function plain(src: string): string {
  return (src ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    // maths: the TeX without its fences or commands, for one line
    .replace(/\\[()[\]]|\$\$/g, ' ')
    .replace(/\\(?:text|mathrm|mathbf|operatorname)\{([^}]*)\}/g, '$1')
    .replace(/\\(?:frac)\{([^}]*)\}\{([^}]*)\}/g, '$1/$2')
    .replace(/\\(cdot|times)/g, '·')
    .replace(/\\(?:left|right|[,;!]|quad)/g, '')
    .replace(/\\([a-zA-Z]+)/g, '$1')
    .replace(/[{}]/g, '')
    .replace(/^\s*[#>*+-]+\s*/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** KaTeX for the maths spans toHtml leaves, wherever they land on the page.
 *
 *  Angular strips the inline styles KaTeX needs from anything going
 *  through [innerHTML], so the spans go in as plain escaped TeX and are
 *  typeset here, after the fact: one watcher on the whole page, KaTeX
 *  loaded the first time a formula shows up. A streaming answer re-renders
 *  the same formulas many times, so each one's HTML is kept. */
type Katex = typeof import('katex').default;
let katex: Katex | null = null;
let loading: Promise<void> | null = null;
const typeset = new Map<string, string>();

function render(root: ParentNode) {
  const todo = root.querySelectorAll<HTMLElement>('.md-math:not(.md-done)');
  if (!todo.length) return;
  if (!katex) {
    loading ??= import('katex').then(m => { katex = m.default; }).finally(() => render(document));
    return;
  }
  for (const el of Array.from(todo)) {
    const display = el.classList.contains('md-math-d');
    const tex = el.textContent ?? '';
    const key = (display ? 'd:' : 'i:') + tex;
    let html = typeset.get(key);
    if (html === undefined) {
      html = katex.renderToString(tex, { displayMode: display, throwOnError: false, trust: false, strict: 'ignore' });
      if (typeset.size > 2000) typeset.clear();
      typeset.set(key, html);
    }
    el.innerHTML = html;
    el.title = tex;
    el.classList.add('md-done');
  }
}

if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; render(document); });
  }).observe(document.documentElement, { childList: true, subtree: true });
}

@Pipe({ name: 'md' })
export class Markdown implements PipeTransform {
  transform(src: string | null | undefined): string { return toHtml(src ?? ''); }
}
