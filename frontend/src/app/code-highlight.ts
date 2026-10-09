/** Colour for the code blocks in an answer (markdown.ts keeps a fence's
 *  language as `language-x` on its <code>). highlight.js, its core and the
 *  languages this app's work is written in, loaded the first time a block
 *  is on screen; a block without a language is guessed among the same few.
 *  The colours are the theme's own (styles.css, `.hljs-*` on the series
 *  palette), so every theme has them. */
import type { HLJSApi } from 'highlight.js';

let api: Promise<HLJSApi> | null = null;

const SUBSET = ['c', 'cpp', 'python', 'javascript', 'typescript', 'json', 'bash', 'yaml', 'ini', 'xml', 'rust',
                'go', 'java', 'csharp', 'sql', 'makefile', 'cmake', 'diff', 'arduino', 'markdown', 'plaintext'];

function load(): Promise<HLJSApi> {
  api ??= (async () => {
    const hljs = (await import('highlight.js/lib/core')).default;
    const langs = await Promise.all([
      import('highlight.js/lib/languages/c'), import('highlight.js/lib/languages/cpp'),
      import('highlight.js/lib/languages/python'), import('highlight.js/lib/languages/javascript'),
      import('highlight.js/lib/languages/typescript'), import('highlight.js/lib/languages/json'),
      import('highlight.js/lib/languages/bash'), import('highlight.js/lib/languages/yaml'),
      import('highlight.js/lib/languages/ini'), import('highlight.js/lib/languages/xml'),
      import('highlight.js/lib/languages/rust'), import('highlight.js/lib/languages/go'),
      import('highlight.js/lib/languages/java'), import('highlight.js/lib/languages/csharp'),
      import('highlight.js/lib/languages/sql'), import('highlight.js/lib/languages/makefile'),
      import('highlight.js/lib/languages/cmake'), import('highlight.js/lib/languages/diff'),
      import('highlight.js/lib/languages/arduino'), import('highlight.js/lib/languages/markdown'),
      import('highlight.js/lib/languages/plaintext'),
    ]);
    SUBSET.forEach((name, i) => hljs.registerLanguage(name, langs[i].default));
    hljs.registerAliases(['sh', 'shell', 'zsh', 'console'], { languageName: 'bash' });
    hljs.registerAliases(['py'], { languageName: 'python' });
    hljs.registerAliases(['ts'], { languageName: 'typescript' });
    hljs.registerAliases(['js'], { languageName: 'javascript' });
    hljs.registerAliases(['h', 'hpp', 'cc', 'ino'], { languageName: 'cpp' });
    hljs.registerAliases(['toml', 'conf'], { languageName: 'ini' });
    hljs.registerAliases(['html', 'svg'], { languageName: 'xml' });
    hljs.registerAliases(['text', 'txt'], { languageName: 'plaintext' });
    return hljs;
  })();
  return api;
}

/** Colour every code block under `root` not yet coloured. An answer being
 *  written is coloured again once its block closes (the <pre> is new then). */
export function highlightIn(root: HTMLElement): void {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>('pre > code:not([data-hl])'));
  if (!blocks.length) return;
  load().then(hljs => {
    for (const code of blocks) {
      if (code.dataset['hl'] || !code.isConnected) continue;
      code.dataset['hl'] = '1';
      const lang = /language-([\w+#-]+)/.exec(code.className)?.[1];
      const text = code.textContent ?? '';
      if (!text.trim() || text.length > 60_000) continue;
      try {
        const out = lang && hljs.getLanguage(lang)
          ? hljs.highlight(text, { language: lang, ignoreIllegals: true })
          : hljs.highlightAuto(text, SUBSET);
        code.innerHTML = out.value;
        code.classList.add('hljs');
      } catch { /* left plain */ }
    }
  }).catch(() => { /* plain code is fine */ });
}
