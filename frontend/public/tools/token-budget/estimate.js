// Token estimator (no vocabulary bundled). Shared shape with the sibling tools.
//
// How it works: the text is first split exactly the way OpenAI's o200k_base
// pre-tokenizer splits it (the split regex is published with tiktoken, MIT),
// so every word, number group, punctuation run and whitespace run is a
// "piece" with the same boundaries a real BPE would see. A piece is then
// classed (lower-case ASCII word, Capitalised, UPPER, with a leading space
// or punctuation, Latin with diacritics, Cyrillic/Greek, CJK, digits,
// punctuation, spaces, newlines) and costed from a table of the average
// number of tokens pieces of that class and length (1..24 characters) take.
//
// The table was fitted on 2026-09-29 against the real o200k_base and
// cl100k_base vocabularies (exact BPE counts) over ~420 kB of text: English
// prose and man pages, C/JS/Python/Rust/DTS source, JSON, system logs, and
// man pages in de, es, fr, pl, tr, ru, ja, ko, zh. Leave-one-file-out error:
// English and logs within ±7 %, code within ±13 %, other Latin languages
// within ±17 %, CJK/Cyrillic within ±18 %. A text in another script (Arabic,
// Devanagari, Thai...) is not calibrated: it is costed at 0.45 token per
// character for o200k_base and 0.9 for cl100k_base, with a band up to ±50 %.
//
// Latin-script languages other than English also cost more per ASCII word
// (Turkish, Polish): the ASCII word cost is raised by 0.8 x the share of
// words that carry diacritics (fitted on the same corpus).

const QUOTE = "(?:'[sS]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD])";
// o200k_base pre-tokenizer pattern (tiktoken, openai_public.py), inline (?i:)
// expanded because JavaScript has no inline flags.
const SPLIT = new RegExp(`[^\\r\\n\\p{L}\\p{N}]?[\\p{Lu}\\p{Lt}\\p{Lm}\\p{Lo}\\p{M}]*[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}]+${QUOTE}?|[^\\r\\n\\p{L}\\p{N}]?[\\p{Lu}\\p{Lt}\\p{Lm}\\p{Lo}\\p{M}]+[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}]*${QUOTE}?|\\p{N}{1,3}| ?[^\\s\\p{L}\\p{N}]+[\\r\\n/]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+`, 'gu');
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CYR = /[\p{Script=Cyrillic}\p{Script=Greek}]/u;
const LAT = /^[\p{Script=Latin}\p{M}']+$/u;
const ASCII_WORD = /^(lo|cap|up|mix)/;
const K_DIACRITIC = 0.8;
const MAXL = 24;

// Average tokens per piece by class and length 1..24 (o = o200k_base,
// c = cl100k_base); ro/rc = tokens per character beyond 24.
const T = {
  cap: { o: [1,1.02,1.02,1.04,1.03,1.12,1.1,1.29,1.34,2.03,1.97,2.39,3.09,3.33,3.57,3.8,4.04,4.28,4.52,4.75,4.99,5.23,5.47,5.7], c: [1,1.16,1.02,1.1,1.04,1.15,1.13,1.37,1.47,2.07,2.01,2.45,3.18,3.42,3.67,3.91,4.15,4.4,4.64,4.89,5.13,5.38,5.62,5.87], ro: 0.24, rc: 0.24 },
  capp: { o: [1,1.22,1.02,1.39,2,1.83,2,2.19,2.97,2.74,3.63,3.96,4.29,4.62,4.95,5.28,5.61,5.94,6.27,6.6,6.93,7.26,7.59,7.92], c: [1,1.22,1.02,1.5,2,1.83,2,2.2,2.98,2.74,3.64,3.97,4.3,4.63,4.96,5.29,5.62,5.95,6.28,6.61,6.94,7.28,7.61,7.94], ro: 0.33, rc: 0.33 },
  caps: { o: [1,1.01,1,1.01,1.05,1.13,1.09,1.37,1.49,1.42,1.77,2.25,1.99,3.2,3.42,3.65,3.88,4.11,4.34,4.57,4.79,5.02,5.25,5.48], c: [1,1.01,1,1.01,1.09,1.14,1.12,1.38,1.53,1.47,1.91,2.37,1.86,3.24,3.47,3.7,3.93,4.16,4.39,4.62,4.85,5.08,5.32,5.55], ro: 0.23, rc: 0.23 },
  cjk: { o: [1.13,1.8,2.41,2.74,3.67,4.85,5.51,5.87,7.15,7.7,8.65,8.79,9.31,10.21,11.35,11.49,13.28,13.24,13.58,14.96,15.29,16.31,17.28,20.62], c: [1.44,2.59,3.51,4.24,5.32,6.62,7.47,8.09,9.4,10.4,11.39,12.13,13.07,13.98,14.89,15.95,17.1,17.94,19.43,20.48,21.41,22.34,22.78,28.25], ro: 0.76, rc: 1.05 },
  cyr: { o: [1.06,1.11,1.08,1.34,1.37,1.68,1.97,1.99,2.26,2.41,2.57,2.17,2.48,2.67,3.51,3.13,5.33,5.29,5.34,5.62,5.9,6.18,6.46,6.74], c: [1.14,1.43,1.35,1.98,2.24,2.77,3.21,3.3,3.95,4.34,4.59,4.46,4.65,5.05,6.68,5.53,8.04,8.63,8.63,9.08,9.53,9.99,10.44,10.9], ro: 0.28, rc: 0.45 },
  lo: { o: [1,1.01,1.11,1.07,1.3,1.23,1.54,1.36,1.96,2.16,2.07,2.35,3.75,4.58,4.43,5.24,5.57,5.89,6.22,6.55,6.87,7.2,7.53,7.86], c: [1,1.01,1.1,1.07,1.3,1.21,1.56,1.32,1.96,2.16,2.07,2.34,4.14,4.57,4.42,5.22,5.54,5.87,6.2,6.52,6.85,7.17,7.5,7.83], ro: 0.33, rc: 0.33 },
  lop: { o: [1,1.1,1.44,1.35,1.36,1.24,1.54,1.78,1.95,2.1,2.5,2.9,2.39,4.08,4.76,5.08,5.39,5.71,6.03,6.34,6.66,6.98,7.3,7.61], c: [1.01,1.1,1.44,1.33,1.29,1.24,1.53,1.76,2.11,2.1,2.5,3.06,2.38,4.06,4.73,5.04,5.36,5.67,5.99,6.3,6.62,6.93,7.25,7.56], ro: 0.32, rc: 0.32 },
  los: { o: [1,1,1.1,1.08,1.07,1.06,1.1,1.29,1.12,1.38,1.22,1.65,1.85,1.5,2.95,3.84,3.81,4.32,4.56,4.8,5.04,5.28,5.52,5.76], c: [1,1,1.01,1.08,1.08,1.06,1.1,1.29,1.11,1.39,1.2,1.6,1.89,1.55,2.9,3.77,3.76,4.24,4.48,4.72,4.95,5.19,5.42,5.66], ro: 0.24, rc: 0.24 },
  lx: { o: [1,1.29,1.75,2.53,2.76,3.05,3.71,4.2,3.64,3.91,4.54,4.83,5.89,6.66,7.14,7.61,8.09,8.57,9.04,9.52,9.99,10.47,10.95,11.42], c: [1,1.45,1.81,2.75,2.82,3.28,4.06,4.71,3.95,4.58,5.45,5.16,6.34,7.31,7.83,8.36,8.88,9.4,9.92,10.44,10.97,11.49,12.01,12.53], ro: 0.48, rc: 0.52 },
  lxs: { o: [1.08,1.14,1.13,1.32,1.67,1.87,2.13,2.47,2.75,2.75,2.92,2.97,3.23,3.36,3.86,4.05,4.21,4.53,5.41,5.5,5.85,5.82,6.71,6.75], c: [1.08,1.38,1.46,1.81,2.3,2.8,2.86,3.31,3.78,3.93,4.33,4.32,4.89,5.02,5.72,6.51,6.89,6.92,7.37,8.54,8.49,8.55,9.48,8.92], ro: 0.29, rc: 0.41 },
  mix: { o: [1,1,1.29,1.79,2.09,2.43,3,3.57,3.86,4.29,4.71,5.14,5.57,6,6.43,6.86,7.29,7.71,8.14,8.57,9,9.43,9.86,10.29], c: [1,1,1.39,1.89,2.19,2.59,3.25,4.04,4.18,4.64,5.11,5.57,6.04,6.5,6.96,7.43,7.89,8.36,8.82,9.29,9.75,10.21,10.68,11.14], ro: 0.43, rc: 0.46 },
  mixp: { o: [1,1.5,2.25,3,3.75,4.5,5.25,6,6.75,7.5,8.25,9,9.75,10.5,11.25,12,12.75,13.5,14.25,15,15.75,16.5,17.25,18], ro: 0.75, rc: 0.75 },
  mixs: { o: [1,1,1,1.33,1.84,1.09,1.76,1.94,2.15,2.39,2.63,2.87,3.11,3.35,3.59,3.83,4.07,4.31,4.55,4.79,5.03,5.27,5.51,5.75], c: [1,1,1,1.5,1.85,1.09,1.78,1.96,2.2,2.44,2.69,2.93,3.17,3.42,3.66,3.91,4.15,4.39,4.64,4.88,5.13,5.37,5.62,5.86], ro: 0.24, rc: 0.24 },
  nl: { o: [1,1.01,2.08,3.73,3.74,4.44,6.52,7.45,6.54,7.24,10.25,11.18,12.11,13.05,13.98,14.91,15.84,16.77,17.7,18.64,19.57,20.5,21.43,22.36], ro: 0.93, rc: 0.93 },
  num: { o: [1,1,1,2.53,3.17,3.8,4.43,5.07,5.7,6.33,6.97,7.6,8.23,8.87,9.5,10.13,10.76,11.4,12.03,12.66,13.3,13.93,14.56,15.2], ro: 0.63, rc: 0.63 },
  pun: { o: [1,1.03,1.05,1.19,1.59,1.85,2.68,3.01,3.59,5.03,4.17,6.16,7.09,6.88,8.18,8.73,4.1,5.91,8.52,8.68,11.46,12,12.55,9.66], c: [1,1.03,1.05,1.22,1.62,1.91,2.75,3.11,3.6,5.03,4.17,6.17,7.11,6.77,8.2,8.75,4.11,5.92,8.54,8.95,11.49,12.03,12.58,10.08], ro: 0.55, rc: 0.55 },
  sp: { o: [1,1,1,1.02,1.04,1.02,1.04,1.92,1.88,2.85,1.13,5.65,4.07,4.35,1.34,4.92,3.1,8.47,2.4,9.41,9.88,8.02,5.91,4.43], ro: 0.47, rc: 0.47 },
  up: { o: [1,1,1.39,1.27,1.76,1.93,2.41,2.93,3.74,4.03,4.15,6.09,6.6,7.11,7.62,8.13,8.63,9.14,9.65,10.16,10.66,11.17,11.68,12.19], c: [1,1.01,1.21,1.24,1.69,1.96,2.21,2.9,3.69,3.87,4.09,5.98,6.47,6.97,7.47,7.97,8.47,8.96,9.46,9.96,10.46,10.96,11.46,11.95], ro: 0.51, rc: 0.5 },
  upp: { o: [1.05,1.49,1.69,1.17,2.15,2.73,1.88,2.59,2.35,2.33,3.81,4.75,4.53,6.9,7.39,7.88,8.37,8.87,9.36,9.85,10.34,10.84,11.33,11.82], c: [1.04,1.81,1.66,1.16,2.15,2.26,1.83,2.3,2.36,2.3,3.51,4.81,4.26,7.03,7.53,8.03,8.53,9.04,9.54,10.04,10.54,11.04,11.55,12.05], ro: 0.49, rc: 0.5 },
  ups: { o: [1,1,1.22,1.29,1.57,1.26,1.82,2.11,2.99,2.73,2.44,3.98,3.73,4.64,3.98,5.3,5.63,5.96,6.29,6.63,6.96,7.29,7.62,7.95], c: [1,1,1.23,1.29,1.38,1.3,1.7,2.05,2.98,2.72,2.54,3.94,3.7,4.59,3.94,5.25,5.58,5.91,6.24,6.56,6.89,7.22,7.55,7.88], ro: 0.33, rc: 0.33 },
};
for (const t of Object.values(T)) if (!t.c) t.c = t.o;

function classify(p) {
  let lead = 0, w = p;
  if (/^[^\p{L}\p{N}]/u.test(p) && /\p{L}/u.test(p)) { lead = 1; w = p.slice(1); }
  if (/\p{L}/u.test(w)) {
    const n = [...w].length;
    if (CJK.test(w)) return ['cjk', n];
    if (CYR.test(w)) return ['cyr', n];
    if (/^[A-Za-z']+$/.test(w)) {
      const k = /^[a-z']+$/.test(w) ? 'lo' : /^[A-Z][a-z']+$/.test(w) ? 'cap' : /^[A-Z']+$/.test(w) ? 'up' : 'mix';
      return [k + (lead ? (p[0] === ' ' ? 's' : 'p') : ''), n];
    }
    if (LAT.test(w)) return ['lx' + (lead ? 's' : ''), n];
    return ['oth', n];
  }
  if (/^\p{N}+$/u.test(p)) return ['num', [...p].length];
  if (/^\s+$/.test(p)) return [/[\r\n]/.test(p) ? 'nl' : 'sp', p.length];
  return ['pun', [...p].length];
}

/**
 * Estimate tokens of a text for o200k_base and cl100k_base.
 * Returns {o200k, cl100k, chars, band (fraction, e.g. 0.15), mix: {latin, code, other...}}.
 */
export function estimate(text) {
  const s = String(text ?? '');
  const pieces = [];
  let latin = 0, lx = 0, cjk = 0, cyr = 0, oth = 0, astral = 0, sym = 0;
  for (const m of s.matchAll(SPLIT)) {
    const [k, n] = classify(m[0]);
    pieces.push([k, n, m[0]]);
    if (ASCII_WORD.test(k)) latin++;
    else if (k.startsWith('lx')) { latin++; lx++; }
    else if (k === 'cjk') cjk += n;
    else if (k === 'cyr') cyr += n;
    else if (k === 'oth') oth += n;
    else if (k === 'pun') sym += n;
  }
  const fx = latin ? lx / latin : 0;
  let o = 0, c = 0;
  for (const [k, n, str] of pieces) {
    if (k === 'oth') { o += 0.45 * n; c += 0.9 * n; continue; }
    const t = T[k];
    // Characters outside the BMP (emoji, rare CJK) are 4 UTF-8 bytes: ~2 tokens each.
    const extra = /[\u{10000}-\u{10FFFF}]/u.test(str) ? [...str].filter((ch) => ch.codePointAt(0) > 0xffff).length : 0;
    astral += extra;
    const f = ASCII_WORD.test(k) ? 1 + K_DIACRITIC * fx : 1;
    const at = (arr, rate) => (n <= MAXL ? arr[n - 1] : arr[MAXL - 1] + (n - MAXL) * rate);
    o += at(t.o, t.ro) * f + extra;
    c += at(t.c, t.rc) * f + extra;
  }
  const chars = s.length;
  const total = Math.max(1, chars);
  const shareOther = oth / total;
  const codeLike = sym / total;
  // Band from the leave-one-out errors above.
  let band = fx > 0.05 || cjk + cyr > 0.1 * total ? 0.18 : codeLike > 0.08 ? 0.13 : 0.08;
  band = Math.min(0.5, band + 0.5 * shareOther);
  return {
    o200k: Math.round(o), cl100k: Math.round(c), chars, band: Math.round(band * 100) / 100, pieces: pieces.length,
    script: shareOther > 0.1 ? 'other script (not calibrated)' : cjk > 0.1 * total ? 'CJK' : cyr > 0.1 * total ? 'Cyrillic/Greek'
      : fx > 0.05 ? 'Latin, non-English' : codeLike > 0.08 ? 'code / markup' : 'English-like',
  };
}
