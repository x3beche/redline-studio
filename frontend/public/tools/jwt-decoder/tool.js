// JWT & Base64 decoder.
//   JWT (RFC 7519) = base64url(header) . base64url(payload) . base64url(signature)
//   (JWS compact serialization, RFC 7515 §7.1). A 5-part token is a JWE
//   (RFC 7516): only its header is readable without the key.
//   Registered claims and their meaning: RFC 7519 §4.1; NumericDate = seconds
//   since 1970-01-01T00:00:00Z UTC (§2).
//   Signature sizes per alg: RFC 7518 §3 - HS256/384/512 = 32/48/64 bytes,
//   RS/PS = the RSA modulus (256 bytes for 2048-bit), ES256/384/512 = 64/96/132
//   bytes (raw R||S, §3.4), EdDSA (RFC 8037) = 64 bytes.
// With a key the signature is checked with WebCrypto (HMAC, RSASSA-PKCS1-v1_5,
// RSA-PSS, ECDSA, Ed25519): deterministic, and the key never leaves the page.
// Base64 (RFC 4648 §4) and base64url (§5) are decoded with or without padding.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** base64 or base64url -> bytes; {bytes} or {error}. */
export function b64decode(s) {
  const t = String(s).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const bad = /[^A-Za-z0-9+/]/.exec(t);
  if (bad) return { error: `"${bad[0]}" at character ${bad.index + 1} is not a base64 character` };
  if (t.length % 4 === 1) return { error: `${t.length} characters cannot be base64 (one character too many or too few)` };
  const out = new Uint8Array(Math.floor((t.length * 3) / 4));
  let bits = 0, acc = 0, o = 0;
  for (const ch of t) {
    acc = (acc << 6) | B64.indexOf(ch); bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 0xff; }
  }
  return { bytes: out.slice(0, o) };
}
const hex = (b, max = 64) => [...b.slice(0, max)].map((x) => x.toString(16).padStart(2, '0')).join('') + (b.length > max ? '…' : '');
function utf8(bytes) {
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }; } catch { return { text: null }; }
}
function hexdump(b, max = 512) {
  const lines = [];
  for (let i = 0; i < Math.min(b.length, max); i += 16) {
    const row = [...b.slice(i, i + 16)];
    lines.push(`${i.toString(16).padStart(8, '0')}  ${row.map((x) => x.toString(16).padStart(2, '0')).join(' ').padEnd(47)}  ${row.map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : '.')).join('')}`);
  }
  if (b.length > max) lines.push(`… ${b.length - max} more bytes`);
  return lines.join('\n');
}

const CLAIMS = {
  iss: 'Issuer: who made the token', sub: 'Subject: whom it is about (user id)', aud: 'Audience: who must accept it',
  exp: 'Expiration time: reject on or after', nbf: 'Not before: reject before', iat: 'Issued at', jti: 'JWT ID: unique, for replay checks',
  scope: 'OAuth scopes (RFC 8693)', scp: 'Scopes (Azure AD)', azp: 'Authorized party (OIDC)', nonce: 'OIDC nonce', auth_time: 'Time of authentication (OIDC)',
  client_id: 'OAuth client (RFC 9068)', roles: 'Roles', email: 'E-mail (OIDC)', name: 'Full name (OIDC)', sid: 'Session id',
};
const HEADERS = { alg: 'Signing algorithm', typ: 'Media type', kid: 'Key id: which key signed it', cty: 'Content type (nested JWT)', jku: 'URL of a JWK set', x5u: 'URL of an X.509 chain', jwk: 'Embedded public key', x5c: 'Embedded X.509 chain', crit: 'Extensions that must be understood', enc: 'Content encryption (JWE)', zip: 'Compression (JWE)' };
const SIGLEN = { HS256: 32, HS384: 48, HS512: 64, ES256: 64, ES384: 96, ES512: 132, EdDSA: 64, Ed25519: 64 };

const iso = (sec) => new Date(sec * 1000).toISOString().replace('.000Z', 'Z');
function span(sec) {
  const a = Math.abs(sec);
  if (a < 90) return `${Math.round(a)} s`;
  if (a < 5400) return `${Math.round(a / 60)} min`;
  if (a < 172800) return `${Math.floor(a / 3600)} h ${Math.round((a % 3600) / 60)} min`;
  return `${Math.round(a / 86400)} days`;
}
function readTime(t) {
  const s = String(t ?? '').trim();
  if (!s) return null;
  if (/^\d{9,10}$/.test(s)) return Number(s);
  if (/^\d{12,13}$/.test(s)) return Math.floor(Number(s) / 1000);
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : NaN;
}

async function verify(alg, key, keyEnc, signingInput, sig) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return { error: 'WebCrypto is not available here (the page must be served over https or from localhost).' };
  const hash = { 256: 'SHA-256', 384: 'SHA-384', 512: 'SHA-512' }[String(alg).slice(2)] || 'SHA-256';
  const data = new TextEncoder().encode(signingInput);
  const k = String(key).trim();
  try {
    if (alg.startsWith('HS')) {
      let raw;
      if (keyEnc === 'base64') { const d = b64decode(k); if (d.error) return { error: `Secret: ${d.error}.` }; raw = d.bytes; } else raw = new TextEncoder().encode(k);
      const ck = await subtle.importKey('raw', raw, { name: 'HMAC', hash }, false, ['verify']);
      return { ok: await subtle.verify('HMAC', ck, sig, data), how: `HMAC-${hash}` };
    }
    let algo;
    if (alg.startsWith('RS')) algo = { name: 'RSASSA-PKCS1-v1_5', hash };
    else if (alg.startsWith('PS')) algo = { name: 'RSA-PSS', hash, saltLength: Number(alg.slice(2)) / 8 };
    else if (alg.startsWith('ES')) algo = { name: 'ECDSA', namedCurve: { ES256: 'P-256', ES384: 'P-384', ES512: 'P-521' }[alg], hash };
    else if (alg === 'EdDSA' || alg === 'Ed25519') algo = { name: 'Ed25519' };
    else return { error: `Checking ${alg} signatures is not supported.` };
    let ck;
    if (k.startsWith('{')) ck = await subtle.importKey('jwk', JSON.parse(k), algo, false, ['verify']);
    else {
      const m = /-----BEGIN PUBLIC KEY-----([\s\S]+?)-----END PUBLIC KEY-----/.exec(k);
      if (!m) return { error: 'For RS/PS/ES/EdDSA give the public key as PEM (-----BEGIN PUBLIC KEY-----) or as a JWK JSON object. An RSA PUBLIC KEY or a certificate must be converted to SPKI first.' };
      const d = b64decode(m[1]);
      if (d.error) return { error: `Public key: ${d.error}.` };
      ck = await subtle.importKey('spki', d.bytes, algo, false, ['verify']);
    }
    return { ok: await subtle.verify(algo, ck, sig, data), how: algo.name };
  } catch (e) {
    return { error: `The key could not be used for ${alg}: ${e.message || e}.` };
  }
}

// Where each top-level member of a JSON object sits in its base64url text:
// [{key, c0, c1}] as character offsets into the encoded part (4 characters
// carry 3 bytes, so a member's bytes b0..b1 are characters b0/3*4..b1/3*4).
// Only for the page, which lights up a claim's characters in the token.
function memberRanges(text, encLen) {
  const out = [];
  let i = 0;
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i++; };
  const str = () => { i++; while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; } i++; };
  const skip = () => {
    ws();
    if (text[i] === '"') return str();
    if (text[i] === '{' || text[i] === '[') {
      let depth = 0;
      while (i < text.length) {
        const c = text[i];
        if (c === '"') { str(); continue; }
        if (c === '{' || c === '[') depth++;
        if (c === '}' || c === ']') { depth--; if (depth === 0) { i++; return; } }
        i++;
      }
      return;
    }
    while (i < text.length && !',}] \t\n\r'.includes(text[i])) i++;
  };
  const bytes = (n) => new TextEncoder().encode(text.slice(0, n)).length;
  ws();
  if (text[i] !== '{') return out;
  i++;
  for (let guard = 0; guard < 500; guard++) {
    ws();
    if (text[i] !== '"') break;
    const s0 = i; str();
    let key = '';
    try { key = JSON.parse(text.slice(s0, i)); } catch { break; }
    ws(); if (text[i] !== ':') break; i++;
    skip();
    const b0 = bytes(s0), b1 = bytes(i);
    out.push({ key, c0: Math.floor(b0 / 3) * 4, c1: Math.min(encLen, Math.ceil(b1 / 3) * 4) });
    ws();
    if (text[i] === ',') { i++; continue; }
    break;
  }
  return out;
}
function segment(name, enc) {
  const d = b64decode(enc);
  const text = d.bytes ? utf8(d.bytes).text : null;
  return { name, enc, text, ranges: text != null ? memberRanges(text, enc.length) : [] };
}

export async function run({ token, mode, at, key, keyEnc }) {
  const warnings = [];
  let t = String(token ?? '').trim().replace(/^(authorization:\s*)?bearer\s+/i, '').replace(/^["']|["']$/g, '');
  if (!t) return { warnings: ['Paste a JWT (xxxxx.yyyyy.zzzzz) or a base64 string.'] };
  const parts = t.split('.');
  const asJwt = mode === 'jwt' || (mode !== 'base64' && (parts.length === 3 || parts.length === 5) && parts[0].length > 8);

  if (!asJwt) {
    const d = b64decode(t);
    if (d.error) return { warnings: [`Not base64: ${d.error}.${parts.length > 1 ? ' It has dots: choose JWT.' : ''}`] };
    const { text } = utf8(d.bytes);
    let json = null;
    if (text != null) { try { json = JSON.parse(text); } catch { /* not JSON */ } }
    const printable = text != null && !/[\x00-\x08\x0e-\x1f]/.test(text);
    const texts = [];
    if (json != null) texts.push({ title: 'JSON', body: JSON.stringify(json, null, 2), lang: 'json' });
    if (printable) texts.push({ title: 'Text', body: text, lang: 'text' });
    texts.push({ title: 'Hex dump', body: hexdump(d.bytes), lang: 'text' });
    const variant = /[-_]/.test(t) ? 'base64url' : /[+/]/.test(t) ? 'base64' : 'either alphabet';
    return {
      segments: { kind: 'base64', enc: t.replace(/\s+/g, ''), hex: hex(d.bytes, 384), bytes: d.bytes.length },
      values: [
        { label: 'Decoded', value: `${d.bytes.length} bytes`, hint: variant },
        { label: 'Content', value: json != null ? 'JSON' : printable ? 'UTF-8 text' : 'binary', tone: 'ok' },
        { label: 'Padding', value: /=$/.test(t) ? 'padded' : t.replace(/\s/g, '').length % 4 ? 'unpadded' : 'none needed' },
      ],
      texts,
      warnings,
      notes: ['Base64 and base64url (- and _ instead of + and /) are both read, with or without = padding (RFC 4648 §4-5).'],
    };
  }

  if (parts.length !== 3 && parts.length !== 5) return { warnings: [`A JWT has 3 parts (signed) or 5 (encrypted) separated by dots; this has ${parts.length}.`] };
  const part = (i, name) => {
    const d = b64decode(parts[i]);
    if (d.error) { warnings.push(`${name}: ${d.error}.`); return null; }
    const { text } = utf8(d.bytes);
    if (text == null) { warnings.push(`${name} is not UTF-8 text.`); return null; }
    try { return JSON.parse(text); } catch { warnings.push(`${name} is not JSON: ${text.slice(0, 60)}`); return null; }
  };
  const header = part(0, 'Header');
  if (!header) return { warnings };
  const alg = String(header.alg ?? '');
  const values = [{ label: 'Algorithm', value: alg || '–', tone: alg === 'none' || !alg ? 'bad' : 'ok', hint: header.typ ? `typ ${header.typ}` : null }];
  const tables = [];
  const texts = [{ title: 'Header', body: JSON.stringify(header, null, 2), lang: 'json' }];
  tables.push({ title: 'Header', columns: ['Field', 'Value', 'Meaning'], rows: Object.entries(header).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v), HEADERS[k] || '–']) });
  if (parts.length === 5) {
    warnings.push('This is an encrypted JWE: the payload cannot be read without the recipient\'s private key.');
    values.push({ label: 'Type', value: 'JWE (encrypted)', hint: `enc ${header.enc || '?'}` });
    return { values, tables, texts, warnings, segments: { kind: 'jwe', parts: [segment('header', parts[0]), ...parts.slice(1).map((p, i) => ({ name: ['key', 'iv', 'ciphertext', 'tag'][i], enc: p, text: null, ranges: [] }))] } };
  }
  if (alg === 'none') warnings.push('alg "none": the token is unsigned and anyone can forge it. A server must reject it.');
  if (header.jku || header.x5u) warnings.push('The header points to a key URL (jku/x5u): a server must only fetch keys from URLs it trusts, or an attacker picks the key.');
  if (header.jwk) warnings.push('The header embeds its own key (jwk): never verify with a key the token brings along.');
  if (header.crit) warnings.push(`Critical extensions ${JSON.stringify(header.crit)}: a receiver that does not understand them must reject the token.`);

  const payload = part(1, 'Payload');
  const now = readTime(at);
  if (Number.isNaN(now)) warnings.push(`Check time "${at}" is not a date: write 2026-09-24T12:00:00Z or Unix seconds.`);
  if (payload && typeof payload === 'object') {
    texts.push({ title: 'Payload', body: JSON.stringify(payload, null, 2), lang: 'json' });
    const timeRow = (k) => {
      const v = payload[k];
      if (typeof v !== 'number') return typeof v === 'string' ? `${v} (should be a number)` : JSON.stringify(v);
      return `${v} = ${iso(v)}`;
    };
    tables.push({ title: 'Claims', columns: ['Claim', 'Value', 'Meaning'], rows: Object.entries(payload).map(([k, v]) => [k, ['exp', 'nbf', 'iat', 'auth_time'].includes(k) ? timeRow(k) : typeof v === 'string' ? v : JSON.stringify(v), CLAIMS[k] || 'custom claim']) });
    const { exp, nbf, iat } = payload;
    for (const k of ['exp', 'nbf', 'iat']) if (payload[k] != null && typeof payload[k] !== 'number') warnings.push(`${k} must be a NumericDate (seconds since 1970), not ${typeof payload[k]}.`);
    if (typeof exp === 'number' && exp > 1e11) warnings.push('exp looks like milliseconds: JWT times are in seconds, so this token would expire thousands of years from now.');
    if (typeof exp === 'number') {
      values.push({ label: 'Expires', value: iso(exp).slice(11), hint: `on ${iso(exp).slice(0, 10)}${typeof iat === 'number' ? ` · lifetime ${span(exp - iat)}` : ''}` });
      if (typeof iat === 'number' && exp - iat > 86400) warnings.push(`Lifetime ${span(exp - iat)}: access tokens usually live minutes to an hour; a long-lived token cannot be revoked easily.`);
      if (typeof iat === 'number' && exp <= iat) warnings.push('exp is not after iat: the token was born expired.');
    } else {
      values.push({ label: 'Expires', value: 'never', tone: 'warn' });
      warnings.push('No exp claim: the token never expires unless the server tracks it.');
    }
    if (now != null && Number.isFinite(now)) {
      let state = 'valid', tone = 'ok', hint = '';
      if (typeof exp === 'number' && now >= exp) { state = 'expired'; tone = 'bad'; hint = `${span(now - exp)} ago`; }
      else if (typeof nbf === 'number' && now < nbf) { state = 'not yet valid'; tone = 'warn'; hint = `starts in ${span(nbf - now)}`; }
      else if (typeof exp === 'number') hint = `expires in ${span(exp - now)}`;
      values.push({ label: `At ${iso(now)}`, value: state, tone, hint });
      if (typeof iat === 'number' && iat > now + 60) warnings.push('iat is in the future at the check time: the issuer\'s clock is ahead, or the check time is wrong.');
    }
    if (payload.aud != null) values.push({ label: 'Audience', value: Array.isArray(payload.aud) ? payload.aud.join(', ') : String(payload.aud) });
  } else if (payload != null) warnings.push('The payload is JSON but not an object; JWT claims must be an object.');

  const sd = b64decode(parts[2]);
  const sig = sd.bytes || new Uint8Array();
  const want = SIGLEN[alg] ?? null; // RSA: depends on the key size
  const sigHint = /^(RS|PS)/.test(alg) ? (sig.length ? `${sig.length * 8}-bit RSA key` : null) : want ? `${alg} needs ${want}` : null;
  values.push({ label: 'Signature', value: sig.length ? `${sig.length} bytes` : 'empty', tone: want && sig.length !== want ? 'bad' : sig.length || alg === 'none' ? 'ok' : 'warn', hint: sigHint });
  if (want && sig.length && sig.length !== want) warnings.push(`${alg} signatures are ${want} bytes, this one is ${sig.length}: the token is damaged or the alg header was changed.${alg.startsWith('ES') && sig.length > 66 && sig.length < want + 10 ? ' (It may be DER-encoded; JWS needs raw R||S.)' : ''}`);
  if (/^(RS|PS)/.test(alg) && sig.length && sig.length < 256) warnings.push(`A ${sig.length * 8}-bit RSA key is below the 2048 bits NIST SP 800-131A requires.`);
  if (!sig.length && alg !== 'none') warnings.push('The signature part is empty.');
  tables.push({ title: 'Signature', columns: ['Part', 'Value'], rows: [['bytes', sig.length], ['hex', sig.length ? hex(sig) : '–'], ['signed input', `${parts[0].length + parts[1].length + 1} characters (header.payload)`]] });

  const k = String(key ?? '').trim();
  if (k && sig.length && alg && alg !== 'none') {
    const r = await verify(alg, k, keyEnc, `${parts[0]}.${parts[1]}`, sig);
    if (r.error) warnings.push(r.error);
    else {
      values.push({ label: 'Signature check', value: r.ok ? 'valid' : 'INVALID', tone: r.ok ? 'ok' : 'bad', hint: r.how });
      if (!r.ok) warnings.push('The signature does not match this key: wrong key or secret, or the token was altered.');
    }
  } else values.push({ label: 'Signature check', value: 'not checked', hint: 'give a key or secret to verify' });

  return {
    values,
    tables,
    texts,
    warnings,
    notes: [
      'Decoding is not verifying: anyone can read and re-encode a JWT. Trust claims only after the signature checks out with the issuer\'s key.',
      now == null ? 'Give a check time to see whether the token is expired then; the drawing marks your clock\'s now.' : 'Times are compared without clock-skew leeway; servers usually allow 30-120 s.',
    ],
    segments: { kind: 'jwt', parts: [segment('header', parts[0]), segment('payload', parts[1]), { name: 'signature', enc: parts[2], text: null, ranges: [], bytes: sig.length, want, hex: sig.length ? hex(sig, 132) : '' }] },
    times: payload && typeof payload === 'object' ? { iat: payload.iat ?? null, nbf: payload.nbf ?? null, exp: payload.exp ?? null, check: Number.isFinite(now) ? now : null } : null,
  };
}
