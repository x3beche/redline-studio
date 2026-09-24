// Glossary & Acronym Book: a project's terms in one list, one entry per
// concept (the ISO 704 idea: one term, one meaning), checked for duplicates
// and conflicting expansions - and a scan of pasted text for acronyms that
// are used but not in the list.
//
// Acronym detection is a rule of thumb: a word of 2-10 letters/digits with
// at least two capitals and no lowercase run longer than the capitals
// (PCB, I2C, SoC, MOSFETs -> MOSFET), minus plain English words written in
// capitals (NOTE, TODO, AND...). It finds candidates; a person decides.

const DOMAINS = ['all', 'project', 'cad', 'pcb', 'web', 'embedded', 'mobile'];
const norm = (s) => String(s ?? '').trim();

// Capitalised words that are not acronyms, and units/marks that look like them.
const STOP = new Set(['A', 'I', 'OK', 'NO', 'YES', 'AND', 'OR', 'NOT', 'THE', 'TO', 'OF', 'IN', 'ON', 'AT', 'IS', 'IT', 'BE', 'IF', 'BY',
  'FOR', 'ALL', 'ANY', 'NEW', 'OLD', 'OFF', 'OUT', 'UP', 'DO', 'DONT', 'NOTE', 'NOTES', 'TODO', 'FIXME', 'XXX', 'WARNING', 'CAUTION', 'DANGER',
  'ERROR', 'INFO', 'DEBUG', 'TBD', 'NB', 'PS', 'VS', 'ETC', 'EG', 'IE', 'MUST', 'SHALL', 'SHOULD', 'MAY', 'NEVER', 'ALWAYS', 'ONLY', 'NOW',
  'MAX', 'MIN', 'TYP', 'MHZ', 'KHZ', 'GHZ', 'HZ', 'MA', 'UA', 'MV', 'KV', 'MW', 'MM', 'CM', 'KB', 'MB', 'GB', 'TB', 'AM', 'PM', 'ID',
  'HIGH', 'LOW', 'SET', 'GET', 'PUT', 'POST', 'DELETE', 'PATCH', 'TRUE', 'FALSE', 'NULL', 'NONE']);

/** Acronym candidates in text -> Map(term -> {count, first context}). */
function scan(text) {
  const found = new Map();
  const re = /(?<![A-Za-z0-9_])([A-Za-z0-9][A-Za-z0-9/&-]{0,11})(?![A-Za-z0-9_])/g;
  let m;
  while ((m = re.exec(text))) {
    let w = m[1].replace(/[-/&]+$/, '');
    // A plural "s" on an acronym (PCBs, LDOs) is not part of it.
    if (/^[A-Z0-9]{2,}s$/.test(w)) w = w.slice(0, -1);
    const caps = (w.match(/[A-Z]/g) || []).length;
    const lower = (w.match(/[a-z]/g) || []).length;
    if (w.length < 2 || w.length > 10 || caps < 2 || lower > caps || /^\d/.test(w) && caps < 2) continue;
    if (/^[0-9.,]+[A-Za-z]{0,3}$/.test(w)) continue;           // 100MHz, 3V3 style values
    if (/^\d+[VAWR]\d*$/.test(w)) continue;                     // 3V3, 1V8, 4R7
    if (/-\d+$/.test(w) || (w.match(/\d/g) || []).length >= 3) continue;   // REQ-01, ESP32-C3: IDs and part numbers
    const up = w.toUpperCase();
    if (STOP.has(up)) continue;
    const at = m.index;
    const ctx = text.slice(Math.max(0, at - 30), at + w.length + 30).replace(/\s+/g, ' ').trim();
    const f = found.get(w);
    if (f) f.count++; else found.set(w, { count: 1, ctx });
  }
  return found;
}

export function run({ terms, filter, domain, text }) {
  const rows = (Array.isArray(terms) ? terms : []).filter((r) => norm(r.term) || norm(r.expansion) || norm(r.definition));
  const warnings = [];
  const notes = [];

  // ---- the list, checked ----
  const byKey = new Map();
  const entries = [];
  rows.forEach((r, i) => {
    const term = norm(r.term);
    if (!term) { warnings.push(`Row ${i + 1} ("${(norm(r.expansion) || norm(r.definition)).slice(0, 40)}") has no term.`); return; }
    const e = { term, expansion: norm(r.expansion), definition: norm(r.definition), domain: DOMAINS.includes(norm(r.domain)) ? norm(r.domain) : 'all', see: norm(r.see) };
    if (!e.expansion && !e.definition) warnings.push(`${term} has neither an expansion nor a definition: say what it stands for or what it means.`);
    const k = term.toLowerCase();
    const same = byKey.get(k) || [];
    for (const o of same) {
      if (o.domain !== e.domain && o.domain !== 'all' && e.domain !== 'all') continue;   // one term, two rooms, two meanings: allowed
      if (o.expansion.toLowerCase() === e.expansion.toLowerCase()) warnings.push(`${term} is listed twice with the same expansion: delete one.`);
      else warnings.push(`${term} has two meanings in the same scope: "${o.expansion || o.definition}" and "${e.expansion || e.definition}". Keep one, or give each its room in Domain.`);
    }
    same.push(e); byKey.set(k, same);
    entries.push(e);
  });
  // "See also" pointing nowhere.
  for (const e of entries) {
    for (const s of e.see.split(/[,;]+/).map(norm).filter(Boolean)) {
      if (!byKey.has(s.toLowerCase())) warnings.push(`${e.term}: "see also ${s}" is not in the glossary - add ${s} or remove the reference.`);
    }
  }

  const f = norm(filter).toLowerCase();
  const d = domain || 'any';
  const shown = entries.filter((e) => (d === 'any' || e.domain === d || e.domain === 'all')
    && (!f || [e.term, e.expansion, e.definition, e.see].some((x) => x.toLowerCase().includes(f))))
    .sort((a, b) => a.term.localeCompare(b.term, 'en', { sensitivity: 'base' }));

  const tables = [{
    title: `Glossary (${shown.length}${shown.length !== entries.length ? ` of ${entries.length}` : ''})`,
    columns: ['Term', 'Stands for', 'Meaning', 'Domain', 'See also'],
    rows: shown.map((e) => [e.term, e.expansion || '–', e.definition || '–', e.domain, e.see || '–']),
  }];
  if (!shown.length && entries.length) notes.push(f ? `No term matches "${filter}".` : `No terms in ${d}.`);

  // ---- the scan ----
  const values = [
    { label: 'Terms', value: entries.length },
    { label: 'Shown', value: shown.length },
  ];
  const body = String(text ?? '');
  if (body.trim()) {
    const found = scan(body);
    const known = new Set(entries.map((e) => e.term.toLowerCase()));
    const used = [...found.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));
    const missing = used.filter(([w]) => !known.has(w.toLowerCase()));
    const hit = used.filter(([w]) => known.has(w.toLowerCase()));
    values.push(
      { label: 'Acronyms in text', value: used.length },
      { label: 'Not in glossary', value: missing.length, tone: missing.length ? 'warn' : 'ok', hint: missing.length ? 'add them or spell them out' : 'all defined' },
    );
    if (missing.length) {
      tables.unshift({ title: 'Used in the text but not in the glossary', columns: ['Term', 'Times', 'First seen in'], rows: missing.map(([w, x]) => [w, x.count, `…${x.ctx}…`]) });
    }
    if (hit.length) {
      const byTerm = new Map(entries.map((e) => [e.term.toLowerCase(), e]));
      tables.push({ title: 'Used in the text and defined', columns: ['Term', 'Times', 'Stands for'], rows: hit.map(([w, x]) => [w, x.count, byTerm.get(w.toLowerCase())?.expansion || '–']) });
    }
    notes.push('Acronyms in the text are found by a rule of thumb (2-10 characters, at least two capitals); check the list - part numbers and pin names can look like acronyms.');
  }

  const md = ['| Term | Stands for | Meaning |', '|---|---|---|',
    ...shown.map((e) => `| ${e.term} | ${e.expansion.replace(/\|/g, '\\|')} | ${e.definition.replace(/\|/g, '\\|')}${e.see ? ` (see also ${e.see})` : ''} |`)];
  const csvCell = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const csv = ['term,expansion,definition,domain,see', ...entries.map((e) => [e.term, e.expansion, e.definition, e.domain, e.see].map(csvCell).join(','))];

  if (!entries.length) warnings.push('The glossary is empty: add a row per term (term, what it stands for, what it means).');
  return {
    values,
    tables,
    texts: [
      { title: 'Glossary (Markdown)', body: md.join('\n') + '\n', lang: 'markdown' },
      { title: 'CSV', body: csv.join('\n') + '\n', lang: 'csv' },
    ],
    warnings,
    notes,
  };
}
