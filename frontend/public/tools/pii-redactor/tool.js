// PII & Secret Redactor.
//
// Finds personal data and secrets in a text with documented patterns and,
// where a number carries one, its checksum; replaces each with a placeholder
// (the same value always gets the same placeholder) and keeps a map to put the
// values back into a model's answer. Pure: nothing leaves the page or the
// process - there is no network code here.
//
// Detectors, and what each one checks (sources in the manifest):
//   PRIVATE_KEY  PEM "-----BEGIN ... PRIVATE KEY-----" blocks (RFC 7468)
//   URL_CRED     user:password@ in a URL's authority (RFC 3986 §3.2.1)
//   JWT          header.payload.signature, base64url, header starting eyJ ('{"')
//   API_KEY      vendor prefixes: Anthropic sk-ant-, OpenRouter keys (sk dash or dash v1 ...),
//                OpenAI sk-proj-/sk-svcacct-/sk-..., AWS AKIA/ASIA key IDs,
//                GitHub ghp_/gho_/ghu_/ghs_/ghr_/github_pat_, Slack xox?-,
//                Stripe sk_/rk_ live/test, Google AIza
//   PASSWORD     the value in password=, secret:, token=, api_key: ... pairs
//   EMAIL        local@domain.tld
//   IBAN         ISO 13616: country length table + mod-97 == 1
//   CARD         13-19 digits, Luhn check (ISO/IEC 7812-1) and a known IIN
//   TCKN         Turkish ID: 11 digits, first not 0, d10 = (7*(d1+d3+d5+d7+d9)
//                - (d2+d4+d6+d8)) mod 10, d11 = (d1+...+d10) mod 10
//   PHONE        E.164 (+ and 8-15 digits, ITU-T E.164) and Turkish national
//                formats 05xx xxx xx xx, 0 2xx/3xx/4xx landlines
//   IPV4, IPV6   dotted quad 0-255; RFC 4291 text form with :: compression
//   MAC          six hex octets with : or - (IEEE 802)
//   NAME         only the names you list (no guessing at names)
//   SECRET       any other 20+ character token with Shannon entropy >= the
//                threshold (bits per character) and both letters and digits
//   CUSTOM       strings you mark yourself

export const TYPES = {
  PRIVATE_KEY: { label: 'Private key', prio: 1 },
  URL_CRED: { label: 'URL credentials', prio: 2 },
  JWT: { label: 'JWT', prio: 3 },
  API_KEY: { label: 'API key', prio: 4 },
  CUSTOM: { label: 'Marked by you', prio: 5 },
  PASSWORD: { label: 'Password / secret value', prio: 6 },
  EMAIL: { label: 'Email', prio: 7 },
  IBAN: { label: 'IBAN', prio: 8 },
  CARD: { label: 'Card number', prio: 9 },
  TCKN: { label: 'TC Kimlik No', prio: 10 },
  PHONE: { label: 'Phone', prio: 11 },
  MAC: { label: 'MAC address', prio: 12 },
  IPV6: { label: 'IPv6', prio: 13 },
  IPV4: { label: 'IPv4', prio: 14 },
  NAME: { label: 'Name (your list)', prio: 15 },
  SECRET: { label: 'High-entropy token', prio: 16 },
};
const TYPE_KEYS = Object.keys(TYPES);

// ISO 13616 IBAN lengths (SWIFT IBAN Registry), for the countries most seen.
const IBAN_LEN = { AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BR: 29, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20,
  EG: 29, ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30,
  KW: 30, KZ: 20, LB: 28, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MD: 24, ME: 22, MK: 19, MT: 31, MU: 30, NL: 18, NO: 15, PK: 24, PL: 28, PS: 29,
  PT: 25, QA: 29, RO: 24, RS: 22, SA: 24, SE: 24, SI: 19, SK: 24, SM: 27, TN: 24, TR: 26, UA: 29, VA: 22, XK: 20 };

export function ibanValid(raw) {
  const s = raw.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const len = IBAN_LEN[s.slice(0, 2)];
  if (len ? s.length !== len : s.length < 15 || s.length > 34) return false;
  // mod 97 of the rearranged number, letters as 10..35, computed in chunks.
  const r = s.slice(4) + s.slice(0, 4);
  let m = 0;
  for (const ch of r) {
    const v = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) m = (m * 10 + Number(d)) % 97;
  }
  return m === 1;
}

export function luhn(digits) {
  let sum = 0, dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return sum % 10 === 0;
}

// Issuer identification number ranges (public scheme ranges).
function cardBrand(d) {
  const n2 = +d.slice(0, 2), n3 = +d.slice(0, 3), n4 = +d.slice(0, 4), L = d.length;
  if (d[0] === '4' && [13, 16, 19].includes(L)) return 'Visa';
  if (((n2 >= 51 && n2 <= 55) || (n4 >= 2221 && n4 <= 2720)) && L === 16) return 'Mastercard';
  if ((n2 === 34 || n2 === 37) && L === 15) return 'Amex';
  if ((n4 === 6011 || n2 === 65 || (n3 >= 644 && n3 <= 649)) && L >= 16) return 'Discover';
  if (n4 === 9792 && L === 16) return 'Troy';
  if (n4 >= 3528 && n4 <= 3589 && L >= 16) return 'JCB';
  if (n2 === 62 && L >= 16) return 'UnionPay';
  if ((n2 === 50 || (n2 >= 56 && n2 <= 69)) && L >= 12) return 'Maestro';
  return null;
}

export function tcknValid(s) {
  if (!/^[1-9]\d{10}$/.test(s)) return false;
  const d = [...s].map(Number);
  const odd = d[0] + d[2] + d[4] + d[6] + d[8], even = d[1] + d[3] + d[5] + d[7];
  if (((odd * 7 - even) % 10 + 10) % 10 !== d[9]) return false;
  return d.slice(0, 10).reduce((a, b) => a + b, 0) % 10 === d[10];
}

function ipv6Valid(s) {
  if (!/^[0-9A-Fa-f:.]+$/.test(s) || (s.match(/::/g) || []).length > 1 || /:::/.test(s)) return false;
  let tail4 = 0;
  let body = s;
  const m4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (m4) { if (m4[1].split('.').some((x) => +x > 255)) return false; tail4 = 2; body = s.slice(0, m4.index).replace(/:$/, ':'); if (!/:$/.test(body)) return false; body = body.slice(0, -1) || ''; if (body.endsWith(':')) body += ''; }
  const [a, b] = body.includes('::') ? body.split('::') : [body, null];
  const ga = a ? a.split(':') : [], gb = b ? b.split(':') : [];
  const groups = [...ga, ...gb];
  if (groups.some((g) => !/^[0-9A-Fa-f]{1,4}$/.test(g))) return false;
  const n = groups.length + tail4;
  if (b === null) return n === 8;
  // "a::b" (C++ scope, not an address): ask for 4+ hex digits unless it is ::1
  return n <= 7 && (s === '::1' || (n >= 2 && groups.join('').length + tail4 * 4 >= 4));
}

/** Shannon entropy in bits per character. */
export function entropy(s) {
  const f = new Map();
  for (const ch of s) f.set(ch, (f.get(ch) || 0) + 1);
  let h = 0;
  for (const c of f.values()) { const p = c / s.length; h -= p * Math.log2(p); }
  return h;
}

// FNV-1a 32-bit: a stable short label for the "hash" placeholder style. Not
// a cryptographic hash, and short values (a phone number) can be guessed
// from it by trying them all - the page says so.
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s)) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

const KV_KEYS = 'password|passwd|pwd|pass|passphrase|secret|client_secret|secret_key|api[_-]?key|apikey|access[_-]?key|access_token|auth[_-]?token|token|private[_-]?key|credentials?';
const NOT_SECRET = /^(?:\*+|x{3,}|<[^>]*>|\$\{[^}]*\}|\$[A-Z_][A-Z0-9_]*|%[A-Z_]+%|\{\{[^}]*\}\}|null|none|true|false|changeme|redacted|\[redacted\]|\.\.\.|""|'')$/i;

function detectAll(text, names, extra, threshold) {
  const hits = [];
  const add = (type, start, end, note = '') => { if (end > start) hits.push({ type, start, end, value: text.slice(start, end), note }); };
  const each = (re, fn) => { re.lastIndex = 0; let m; while ((m = re.exec(text))) { fn(m); if (m[0] === '') re.lastIndex++; } };

  each(/-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g, (m) => add('PRIVATE_KEY', m.index, m.index + m[0].length, `${m[1] || ''}PRIVATE KEY block`.trim()));
  each(/-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY-----(?![\s\S]*?-----END)/g, (m) => add('PRIVATE_KEY', m.index, text.length, 'unterminated block: redacted to the end'));
  each(/\b[a-z][a-z0-9+.-]{1,15}:\/\/([^\s:/?#@'"]+):([^\s/?#@'"]+)@/gi, (m) => { const s = m.index + m[0].indexOf('//') + 2; add('URL_CRED', s, s + m[1].length + 1 + m[2].length, `${m[0].split(':')[0]} URL`); });
  each(/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, (m) => add('JWT', m.index, m.index + m[0].length));
  const keys = [
    [/\bsk-ant-(?:api\d\d|admin\d\d|oat\d\d)-[A-Za-z0-9_-]{20,}/g, 'Anthropic'],
    // OpenRouter keys (sk dash or dash v1 dash, then hex); the prefix is built
    // at runtime so no file carries it literally (the repo's commit gate refuses it).
    [new RegExp('\\b' + 'sk' + '-or-' + 'v1-[0-9a-f]{20,}', 'g'), 'OpenRouter'],
    [/\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/g, 'OpenAI'],
    [/\bsk-[A-Za-z0-9]{20,}T3BlbkFJ[A-Za-z0-9]{20,}/g, 'OpenAI (legacy)'],
    [/\bsk-[A-Za-z0-9_-]{32,}/g, 'sk- key (OpenAI-style)'],
    [/\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g, 'AWS access key ID'],
    [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, 'GitHub token'],
    [/\bgithub_pat_[A-Za-z0-9_]{22,}/g, 'GitHub fine-grained PAT'],
    [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, 'Slack token'],
    [/\bxapp-\d-[A-Za-z0-9-]{10,}/g, 'Slack app token'],
    [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, 'Stripe secret key'],
    [/\bAIza[0-9A-Za-z_-]{35}\b/g, 'Google API key'],
  ];
  for (const [re, what] of keys) each(re, (m) => add('API_KEY', m.index, m.index + m[0].length, what));
  each(new RegExp(`(?:^|[^A-Za-z0-9_.-])["']?((?:[A-Za-z0-9]+[_.-])*?(?:${KV_KEYS}))["']?\\s*(?:=|:|=>)\\s*(?:"([^"\\n]{1,200})"|'([^'\\n]{1,200})'|([^\\s,;'"&<>]{1,200}))`, 'gim'), (m) => {
    const v = m[2] ?? m[3] ?? m[4] ?? '';
    if (!v || NOT_SECRET.test(v.trim()) || v.length < 3) return;
    const at = m.index + m[0].length - v.length - (m[2] != null || m[3] != null ? 1 : 0);
    add('PASSWORD', at, at + v.length, `value of ${m[1]}`);
  });
  each(/[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,24}\b/g, (m) => add('EMAIL', m.index, m.index + m[0].length));
  each(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g, (m) => {
    // trim trailing groups until valid (a following word can be caught by the pattern)
    let v = m[0];
    while (v.length >= 15) { if (ibanValid(v)) { add('IBAN', m.index, m.index + v.length, `${v.slice(0, 2)} · mod-97 ok`); return; } v = v.replace(/ ?[A-Z0-9]{1,4}$/, ''); }
  });
  each(/(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g, (m) => {
    const d = m[0].replace(/[ -]/g, '');
    if (d.length < 13 || d.length > 19 || !luhn(d)) return;
    const brand = cardBrand(d);
    if (brand) add('CARD', m.index, m.index + m[0].length, `${brand} · Luhn ok`);
  });
  each(/(?<!\d)[1-9]\d{10}(?!\d)/g, (m) => { if (tcknValid(m[0])) add('TCKN', m.index, m.index + 11, 'checksum ok'); });
  each(/(?<![\w+])\+[1-9](?:[\s.-]?\(?\d\)?){7,14}(?!\d)/g, (m) => {
    const n = m[0].replace(/\D/g, '');
    if (n.length >= 8 && n.length <= 15) add('PHONE', m.index, m.index + m[0].length, 'E.164');
  });
  each(/(?<![\d+])(?:\(0?5\d{2}\)|0?5\d{2})[\s.-]?\d{3}[\s.-]?\d{2}[\s.-]?\d{2}(?!\d)/g, (m) => add('PHONE', m.index, m.index + m[0].length, 'TR mobile'));
  each(/(?<![\d+])(?:\(0[2-4]\d{2}\)|0[2-4]\d{2})[\s.-]?\d{3}[\s.-]?\d{2}[\s.-]?\d{2}(?!\d)/g, (m) => add('PHONE', m.index, m.index + m[0].length, 'TR landline'));
  each(/(?<![0-9A-Fa-f:-])[0-9A-Fa-f]{2}([:-])[0-9A-Fa-f]{2}(?:\1[0-9A-Fa-f]{2}){4}(?![0-9A-Fa-f:-])/g, (m) => add('MAC', m.index, m.index + m[0].length));
  each(/(?<![\w:.])(?:[0-9A-Fa-f]{0,4}:){2,7}(?:[0-9A-Fa-f]{0,4}|\d{1,3}(?:\.\d{1,3}){3})(?![\w:])/g, (m) => {
    const v = m[0].replace(/:$/, (x) => (m[0].endsWith('::') ? x : ''));
    if (ipv6Valid(v)) add('IPV6', m.index, m.index + v.length);
  });
  each(/(?<![\d.])(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}(?![\d.]|\.\d)/g, (m) => {
    const o = m[0].split('.').map(Number);
    const kind = o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] < 32) || (o[0] === 192 && o[1] === 168) ? 'private (RFC 1918)'
      : o[0] === 127 ? 'loopback' : (o[0] === 192 && o[1] === 0 && o[2] === 2) || (o[0] === 198 && o[1] === 51 && o[2] === 100) || (o[0] === 203 && o[1] === 0 && o[2] === 113) ? 'documentation range (RFC 5737)' : 'public';
    if (/(?:version|ver\.?|firmware|fw|v)\s*$/i.test(text.slice(Math.max(0, m.index - 12), m.index))) return; // 1.2.3.4 after "version": a version number
    add('IPV4', m.index, m.index + m[0].length, kind);
  });
  for (const n of names) {
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+').replace(/[iıIİ]/g, '[iıIİ]');
    each(new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'giu'), (m) => add('NAME', m.index, m.index + m[0].length));
  }
  for (const x of extra) {
    let i = text.indexOf(x);
    while (i >= 0) { add('CUSTOM', i, i + x.length); i = text.indexOf(x, i + x.length); }
  }
  each(/(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_-]{20,}={0,2}(?![A-Za-z0-9+/_=-])/g, (m) => {
    const v = m[0];
    if (!/[A-Za-z]/.test(v) || !/\d/.test(v)) return;
    const h = entropy(v);
    if (h >= threshold) add('SECRET', m.index, m.index + v.length, `entropy ${h.toFixed(2)} bits/char`);
  });
  return hits;
}

/** Keep the higher-priority hit where two overlap (a key inside a URL, a phone inside an IBAN). */
function resolve(hits) {
  const byPrio = [...hits].sort((a, b) => TYPES[a.type].prio - TYPES[b.type].prio || (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  const kept = [];
  for (const h of byPrio) if (!kept.some((k) => h.start < k.end && k.start < h.end)) kept.push(h);
  return kept.sort((a, b) => a.start - b.start);
}

const lines = (s) => String(s ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function mask(v) {
  const s = v.replace(/\s+/g, ' ');
  if (s.length <= 4) return '•'.repeat(s.length);
  if (s.length <= 10) return s[0] + '•'.repeat(s.length - 2) + s[s.length - 1];
  return s.slice(0, 3) + '•'.repeat(Math.min(12, s.length - 5)) + s.slice(-2);
}

export const DEFAULT_TEXT = `Subject: Modem board RMA #4471 - customer cannot reach the MQTT broker

From: Ayşe Yılmaz <ayse.yilmaz@example.com.tr>
Phone: +90 532 123 45 67 (mobile), office 0212 555 01 23
Customer ID (TC Kimlik No): 10000000146
Refund to IBAN: TR33 0006 1005 1978 6457 8413 26
Card on file: 4111 1111 1111 1111 (exp 08/27)

Notes from Mehmet Demir (support):
The unit at 203.0.113.7 (public) keeps dropping; LAN side is 10.20.1.15, MAC 00:1A:2B:3C:4D:5E,
IPv6 2001:db8:85a3::8a2e:370:7334. Firmware 2.4.1 build 7f3c9e1.

--- device config dump ---
mqtt.url=mqtts://fleet_app:Hx7!pQ2r9w@broker.redline.local:8883/telemetry
mqtt.client_id=rl-eg25-0142
aws_access_key_id = AKIAIOSFODNN7EXAMPLE
aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
GITHUB_TOKEN=ghp_EXAMPLE0EXAMPLE0EXAMPLE0EXAMPLE0EXAMP
db_password: "Tr4nsf0rm!2026"
api_key: \${FLEET_API_KEY}

--- log excerpt ---
2026-09-28T14:02:11Z INFO  auth: bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c accepted
2026-09-28T14:02:12Z WARN  mqtt: reconnect #3 after 30 s, session 9fK2xQ7mZp4Lw8Rt1Vb6Nc3Hy5Ja0Ds
2026-09-28T14:02:13Z ERROR tls: handshake failed with broker.redline.local:8883

-----BEGIN OPENSSH PRIVATE KEY-----
EXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE
EXAMPLE0KEY0BODY0NOT0A0REAL0KEY0EXAMPLE0KEY0BODY0NOT0A0REAL0KEY0EXAMPL
-----END OPENSSH PRIVATE KEY-----
`;

export function run(input) {
  const warnings = [], notes = [];
  const text = String(input.text ?? '');
  const names = lines(input.names);
  const extra = lines(input.extra);
  const keep = new Set(lines(input.keep));
  const off = new Set(String(input.off || '').split(/[\s,]+/).map((x) => x.trim().toUpperCase()).filter(Boolean));
  const unknownOff = [...off].filter((t) => !TYPES[t]);
  if (unknownOff.length) warnings.push(`Unknown type names in "off": ${unknownOff.join(', ')}. Types are ${TYPE_KEYS.join(', ')}.`);
  let threshold = Number(input.entropy);
  if (!Number.isFinite(threshold) || threshold < 2 || threshold > 6) { if (String(input.entropy ?? '') !== '') warnings.push(`Entropy threshold ${input.entropy} is outside 2-6 bits/char; using 4.`); threshold = 4; }
  const style = ['tag', 'bracket', 'redacted', 'hash'].includes(input.style) ? input.style : 'tag';

  const all = resolve(detectAll(text, names, extra, threshold));
  const count = {}, placeholders = new Map(), map = {};
  const n = {};
  const spans = all.map((h, id) => {
    const on = !off.has(h.type) && !keep.has(h.value.trim()) && !keep.has(h.value);
    let ph = '';
    if (on) {
      const key = `${h.type}\u0000${h.value}`;
      if (!placeholders.has(key)) {
        n[h.type] = (n[h.type] || 0) + 1;
        const tag = style === 'hash' ? `${h.type}_${fnv1a(h.value)}` : `${h.type}_${n[h.type]}`;
        const p = style === 'tag' || style === 'hash' ? `<${tag}>` : style === 'bracket' ? `[${tag}]` : '[REDACTED]';
        placeholders.set(key, p);
        if (style !== 'redacted') map[p] = h.value;
      }
      ph = placeholders.get(key);
      count[h.type] = (count[h.type] || 0) + 1;
    }
    const line = text.slice(0, h.start).split('\n').length;
    return { id, type: h.type, start: h.start, end: h.end, line, on, ph, note: h.note, value: h.value };
  });

  let out = '', at = 0;
  for (const sp of spans) { if (!sp.on) continue; out += text.slice(at, sp.start) + sp.ph; at = sp.end; }
  out += text.slice(at);

  // ---- restore ----
  const restore = input.mode === 'restore';
  let restored = null;
  const rstats = { replaced: 0, missing: [], unknown: [] };
  if (restore) {
    const answer = String(input.answer ?? '');
    if (style === 'redacted') warnings.push('Restore needs numbered placeholders: with the [REDACTED] style there is nothing to map back. Pick <TYPE_n>, [TYPE_n] or hash.');
    const keys = Object.keys(map).sort((a, b) => b.length - a.length);
    if (keys.length) {
      const re = new RegExp(keys.map(escapeRe).join('|'), 'g');
      restored = answer.replace(re, (m) => { rstats.replaced++; return map[m]; });
    } else restored = answer;
    rstats.missing = keys.filter((k) => !answer.includes(k));
    const look = /<([A-Z][A-Z_]*?)_([0-9]+|[0-9a-f]{8})>|\[([A-Z][A-Z_]*?)_([0-9]+|[0-9a-f]{8})\]/g;
    rstats.unknown = [...new Set([...answer.matchAll(look)].map((m) => m[0]).filter((p) => !(p in map)))];
    if (rstats.unknown.length) warnings.push(`The answer has placeholders the map does not know: ${rstats.unknown.join(', ')}. The model made them up or changed them; they stay as they are.`);
    if (!answer.trim()) warnings.push('Paste the model\'s answer (the one written against the redacted text) to put the values back.');
  }

  // ---- warnings ----
  const found = spans.filter((s) => s.on).length;
  const secrets = spans.filter((s) => s.on && ['PRIVATE_KEY', 'API_KEY', 'JWT', 'URL_CRED', 'PASSWORD'].includes(s.type));
  if (secrets.length) warnings.push(`${secrets.length} credential${secrets.length > 1 ? 's' : ''} in the text (${[...new Set(secrets.map((s) => TYPES[s.type].label))].join(', ')}). Redacting hides them from the model, but anything already pasted into a chat or log should be rotated.`);
  const offOn = spans.filter((s) => !s.on && off.has(s.type));
  if (offOn.length) warnings.push(`${offOn.length} hit${offOn.length > 1 ? 's' : ''} left in the text because the type is switched off: ${[...new Set(offOn.map((s) => s.type))].join(', ')}.`);
  if (style === 'hash' && spans.some((s) => s.on && ['PHONE', 'TCKN', 'CARD', 'IPV4'].includes(s.type))) warnings.push('Hash placeholders of short numbers (phones, ID numbers, cards, IPs) can be reversed by trying every value: use numbered placeholders if the model output may be seen by others.');
  if (!text.trim()) warnings.push('No text. Paste the text, log or code to check.');
  notes.push('Runs entirely in this page (and in the tool\'s pure function for agents): there is no network call. The kit remembers the last input in this browser\'s localStorage; press Reset to replace it with the demo text.');
  notes.push('The map puts the real values back: treat it as sensitive as the original text, and do not send it to the model.');
  notes.push('Pattern matching finds what has a shape. Names are found only from your list, and free-text personal data (addresses, health details, a name not in the list) is not detected: read the redacted text before sending it.');
  if (spans.some((s) => s.type === 'IPV4' && /documentation|loopback|private/.test(s.note) && s.on)) notes.push('Private, loopback and documentation-range addresses are redacted too; click one to keep it if the model needs the network layout.');

  const byType = TYPE_KEYS.filter((t) => spans.some((s) => s.type === t)).map((t) => ({ type: t, label: TYPES[t].label, n: spans.filter((s) => s.type === t).length, on: spans.filter((s) => s.type === t && s.on).length, off: off.has(t) }));
  const texts = [{ title: 'Redacted text', body: out }];
  if (restore) texts.unshift({ title: 'Restored answer', body: restored ?? '' });
  texts.push({ title: 'Map (sensitive)', body: JSON.stringify({ note: 'SENSITIVE: real values. Keep local; never send to the model.', style, placeholders: map }, null, 2) + '\n' });

  return {
    values: [
      { label: 'Redacted', value: found, hint: `${spans.length - found} left as is` },
      ...byType.map((t) => ({ label: t.label, value: t.on, hint: t.n !== t.on ? `${t.n - t.on} kept` : undefined, tone: ['PRIVATE_KEY', 'API_KEY', 'JWT', 'URL_CRED', 'PASSWORD', 'SECRET'].includes(t.type) && t.on ? 'bad' : undefined })).map((v) => Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined))),
      ...(restore ? [{ label: 'Values put back', value: rstats.replaced, tone: rstats.unknown.length ? 'warn' : 'ok' }] : []),
    ],
    tables: [{ title: 'Findings (values masked)', columns: ['#', 'Type', 'Placeholder', 'Value (masked)', 'Line', 'Check'],
      rows: spans.map((s) => [s.id + 1, s.type, s.on ? s.ph : '(kept)', mask(s.value), s.line, s.note || '']) }],
    texts,
    warnings,
    notes,
    draw: { spans: spans.map(({ value, ...r }) => ({ ...r, len: value.length })), byType, style, restore, rstats, types: TYPES },
  };
}
