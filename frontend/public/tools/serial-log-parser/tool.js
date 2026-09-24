// Serial log parser: NMEA 0183 sentences (checksum = XOR of every character
// between '$' and '*', two hex digits; NMEA 0183 v4.11 §5.2.1, field layouts
// of GGA/RMC/GSA/GSV/VTG/GLL/ZDA/TXT per NMEA 0183 and the u-blox M8 protocol
// description §31), or generic CSV and key=value lines.
import { fmtNum } from '../kit/eng.js';

const MAXROWS = 200;

// ddmm.mmmm + hemisphere -> signed decimal degrees
function latlon(v, hemi) {
  if (!v) return null;
  const x = Number(v);
  if (!Number.isFinite(x)) return null;
  const deg = Math.floor(x / 100), min = x - deg * 100;
  if (min >= 60) return null;
  const d = deg + min / 60;
  return /[SW]/i.test(hemi) ? -d : d;
}
const time = (t) => (t && /^\d{6}/.test(t) ? `${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4)}` : t || '');
const n = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const deg = (v) => (v == null ? '' : v.toFixed(6));
const FIXQ = { 0: 'no fix', 1: 'GPS', 2: 'DGPS', 3: 'PPS', 4: 'RTK fixed', 5: 'RTK float', 6: 'dead reckoning', 7: 'manual', 8: 'simulator' };

const TYPES = {
  GGA: { cols: ['Line', 'Talker', 'UTC', 'Lat', 'Lon', 'Fix', 'Sats', 'HDOP', 'Alt m', 'Geoid sep m', 'Diff age'],
    row: (f) => [time(f[0]), deg(latlon(f[1], f[2])), deg(latlon(f[3], f[4])), FIXQ[f[5]] ?? f[5], f[6], f[7], f[8], f[10], f[12]] },
  RMC: { cols: ['Line', 'Talker', 'UTC', 'Status', 'Lat', 'Lon', 'Speed kn', 'Speed km/h', 'Course °', 'Date', 'Mag var', 'Mode'],
    row: (f) => [time(f[0]), f[1] === 'A' ? 'valid' : f[1] === 'V' ? 'void' : f[1], deg(latlon(f[2], f[3])), deg(latlon(f[4], f[5])), f[6],
      n(f[6]) != null ? fmtNum(n(f[6]) * 1.852, 4) : '', f[7], f[8] && f[8].length === 6 ? `${Number(f[8].slice(4)) < 80 ? '20' : '19'}${f[8].slice(4)}-${f[8].slice(2, 4)}-${f[8].slice(0, 2)}` : f[8], f[9] ? `${f[9]} ${f[10] || ''}` : '', f[11] || ''] },
  GSA: { cols: ['Line', 'Talker', 'Mode', 'Fix', 'Satellites used', 'PDOP', 'HDOP', 'VDOP'],
    row: (f) => [f[0] === 'A' ? 'auto' : 'manual', { 1: 'none', 2: '2D', 3: '3D' }[f[1]] ?? f[1], f.slice(2, 14).filter(Boolean).join(' '), f[14], f[15], f[16]] },
  GSV: { cols: ['Line', 'Talker', 'Msg', 'Sats in view', 'Satellites (id elev° az° C/N0 dB-Hz)'],
    row: (f) => {
      const sats = [];
      for (let i = 3; i + 3 < f.length + 1 && i < 19; i += 4) if (f[i]) sats.push(`${f[i]}:${f[i + 1] || '-'}/${f[i + 2] || '-'}/${f[i + 3] || '-'}`);
      return [`${f[1]}/${f[0]}`, f[2], sats.join('  ')];
    } },
  VTG: { cols: ['Line', 'Talker', 'Course true °', 'Course mag °', 'Speed kn', 'Speed km/h', 'Mode'],
    row: (f) => [f[0], f[2], f[4], f[6], f[8] || ''] },
  GLL: { cols: ['Line', 'Talker', 'Lat', 'Lon', 'UTC', 'Status', 'Mode'],
    row: (f) => [deg(latlon(f[0], f[1])), deg(latlon(f[2], f[3])), time(f[4]), f[5] === 'A' ? 'valid' : 'void', f[6] || ''] },
  ZDA: { cols: ['Line', 'Talker', 'UTC', 'Date', 'Local zone'],
    row: (f) => [time(f[0]), f[3] ? `${f[3]}-${f[2]}-${f[1]}` : '', f[4] ? `${f[4]}:${f[5] || '00'}` : ''] },
  TXT: { cols: ['Line', 'Talker', 'Msg', 'Type', 'Text'],
    row: (f) => [`${f[1]}/${f[0]}`, { '00': 'error', '01': 'warning', '02': 'notice', '07': 'user' }[f[2]] ?? f[2], f.slice(3).join(',')] },
};

function nmeaChecksum(body) { let c = 0; for (let i = 0; i < body.length; i++) c ^= body.charCodeAt(i); return c; }

function parseNmea(lines) {
  const byType = {}, problems = [], other = [];
  let ok = 0, badCs = 0, noCs = 0;
  const stats = { lat: null, lon: null, alt: null, sats: null, hdop: null, fix: null, t0: null, t1: null, maxKn: null, talkers: new Set() };
  lines.forEach((raw, i) => {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) return;
    const at = line.search(/[$!][A-Z]{2}[A-Z0-9]{2,4},/);
    if (at < 0) { other.push([i + 1, line.slice(0, 80), 'not an NMEA sentence']); return; }
    let s = line.slice(at);
    // a second '$' on the line means two sentences ran together (lost CR LF)
    const again = s.indexOf('$', 1);
    if (again > 0) { problems.push([i + 1, s.slice(0, 80), 'two sentences on one line; only the first is read']); s = s.slice(0, again); }
    const star = s.lastIndexOf('*');
    let body = s.slice(1);
    if (star > 0) {
      body = s.slice(1, star);
      const want = s.slice(star + 1, star + 3);
      const got = nmeaChecksum(body);
      if (!/^[0-9A-F]{2}$/i.test(want) || parseInt(want, 16) !== got) {
        badCs++;
        problems.push([i + 1, s.slice(0, 80), `checksum ${want || '(none)'} ≠ computed ${got.toString(16).toUpperCase().padStart(2, '0')}`]);
        return;
      }
    } else { noCs++; problems.push([i + 1, s.slice(0, 80), 'no checksum (accepted, unverified)']); }
    const f = body.split(',');
    const addr = f.shift();
    const talker = addr.startsWith('P') ? addr.slice(0, 1) : addr.slice(0, 2);
    const type = addr.startsWith('P') ? addr : addr.slice(2);
    stats.talkers.add(talker);
    ok++;
    const T = TYPES[type];
    if (!byType[type]) byType[type] = { rows: [], count: 0, generic: !T };
    const g = byType[type];
    g.count++;
    if (g.rows.length < MAXROWS) g.rows.push([i + 1, talker, ...(T ? T.row(f) : [f.join(', ')])]);
    if (type === 'GGA') {
      const la = latlon(f[1], f[2]), lo = latlon(f[3], f[4]);
      if (la != null && lo != null && f[5] !== '0') { stats.lat = la; stats.lon = lo; stats.alt = n(f[8]); }
      stats.sats = n(f[6]); stats.hdop = n(f[7]); stats.fix = FIXQ[f[5]] ?? f[5];
    }
    if (type === 'RMC' && f[1] === 'A') {
      const la = latlon(f[2], f[3]), lo = latlon(f[4], f[5]);
      if (la != null && lo != null) { stats.lat = la; stats.lon = lo; }
      if (n(f[6]) != null) stats.maxKn = Math.max(stats.maxKn ?? 0, n(f[6]));
    }
    const t = ['GGA', 'RMC', 'ZDA'].includes(type) ? f[0] : type === 'GLL' ? f[4] : null;
    if (t && /^\d{6}/.test(t)) { stats.t0 ??= time(t); stats.t1 = time(t); }
  });
  return { byType, problems, other, ok, badCs, noCs, stats };
}

// ---------- generic ----------
const isNum = (v) => v !== '' && Number.isFinite(Number(v));
function statsTable(columns, rows) {
  const out = [];
  columns.forEach((c, k) => {
    const vals = rows.map((r) => r[k]).filter(isNum).map(Number);
    if (vals.length < 1) return;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    out.push([c, vals.length, fmtNum(Math.min(...vals), 5), fmtNum(Math.max(...vals), 5), fmtNum(mean, 5)]);
  });
  return out;
}
function parseCsv(lines) {
  const ls = lines.filter((l) => l.trim());
  if (!ls.length) return null;
  const first = ls[0];
  const delim = [',', ';', '\t', '|'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const split = (l) => l.split(delim).map((x) => x.trim().replace(/^"(.*)"$/, '$1'));
  const r0 = split(first);
  const header = r0.some((x) => x && !isNum(x)) && ls.length > 1 && split(ls[1]).some(isNum);
  const columns = header ? r0 : r0.map((_, k) => `col${k + 1}`);
  const rows = [], problems = [];
  ls.slice(header ? 1 : 0).forEach((l, k) => {
    const r = split(l);
    if (r.length !== columns.length) problems.push([k + (header ? 2 : 1), l.slice(0, 80), `${r.length} fields, header has ${columns.length}`]);
    rows.push(columns.map((_, j) => r[j] ?? ''));
  });
  return { columns, rows, problems, delim };
}
function parseKv(lines) {
  const cols = [], rows = [], problems = [];
  lines.forEach((l, i) => {
    if (!l.trim()) return;
    const rec = {};
    const re = /([A-Za-z_][\w.\-]*)\s*[=:]\s*("[^"]*"|[^\s,;]+)/g;
    let m, any = false;
    while ((m = re.exec(l))) { any = true; rec[m[1]] = m[2].replace(/^"|"$/g, ''); if (!cols.includes(m[1])) cols.push(m[1]); }
    if (!any) { problems.push([i + 1, l.slice(0, 80), 'no key=value pairs']); return; }
    rows.push({ line: i + 1, rec });
  });
  const columns = ['Line', ...cols.slice(0, 16)];
  if (cols.length > 16) problems.push(['–', '', `${cols.length} keys; the table shows the first 16`]);
  return { columns, rows: rows.map((r) => [r.line, ...cols.slice(0, 16).map((c) => r.rec[c] ?? '')]), problems };
}
const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

export function run({ log, mode }) {
  const text = String(log || '');
  const lines = text.split(/\r?\n/);
  const warnings = [], notes = [];
  if (!text.trim()) return { warnings: ['Paste a serial log: NMEA sentences ($GPGGA,…*47), CSV lines, or key=value lines.'] };
  let m = mode;
  if (m === 'auto') {
    const nmea = lines.filter((l) => /[$!][A-Z]{2}[A-Z0-9]{2,4},/.test(l)).length;
    const kv = lines.filter((l) => /[A-Za-z_]\w*\s*[=:]\s*\S/.test(l)).length;
    m = nmea > 0 ? 'nmea' : kv > lines.filter((l) => l.trim()).length / 2 ? 'kv' : 'csv';
    notes.push(`Read as ${{ nmea: 'NMEA 0183', kv: 'key=value', csv: 'CSV' }[m]} (auto).`);
  }

  if (m === 'nmea') {
    const r = parseNmea(lines);
    const s = r.stats;
    if (r.badCs) warnings.push(`${r.badCs} sentence(s) fail the checksum and were dropped: usually bytes lost to a UART overrun, a wrong baud rate or two writers on one port.`);
    if (!r.ok) warnings.push('No valid NMEA sentence found. Check the baud rate (GNSS modules default to 9600 or 38400) and that the log is text.');
    if (r.other.length) notes.push(`${r.other.length} line(s) are not NMEA (debug prints, prompts); they are listed under Problems.`);
    const values = [
      { label: 'Sentences OK', value: r.ok, tone: r.ok ? 'ok' : 'bad' },
      { label: 'Checksum errors', value: r.badCs, tone: r.badCs ? 'bad' : 'ok' },
      { label: 'Other lines', value: r.other.length },
      { label: 'Talkers', value: [...s.talkers].join(', ') || '–', hint: 'GP GPS, GL GLONASS, GA Galileo, GB/BD BeiDou, GN multi' },
      { label: 'Last latitude', value: s.lat != null ? s.lat.toFixed(6) : 'no fix', unit: s.lat != null ? '°' : '', tone: s.lat != null ? 'ok' : 'warn' },
      { label: 'Last longitude', value: s.lon != null ? s.lon.toFixed(6) : 'no fix', unit: s.lon != null ? '°' : '', tone: s.lon != null ? 'ok' : 'warn' },
      { label: 'Fix / sats / HDOP', value: `${s.fix ?? '–'} / ${s.sats ?? '–'} / ${s.hdop ?? '–'}` },
    ];
    if (s.alt != null) values.push({ label: 'Altitude (MSL)', value: fmtNum(s.alt, 5), unit: 'm' });
    if (s.maxKn != null) values.push({ label: 'Max speed', value: fmtNum(s.maxKn * 1.852, 4), unit: 'km/h', hint: `${fmtNum(s.maxKn, 4)} kn` });
    if (s.t0) values.push({ label: 'UTC span', value: s.t0 === s.t1 ? s.t0 : `${s.t0} → ${s.t1}` });
    const tables = Object.entries(r.byType).sort((a, b) => b[1].count - a[1].count).map(([type, g]) => ({
      title: `${type} (${g.count})${g.count > g.rows.length ? `, first ${g.rows.length}` : ''}`,
      columns: g.generic ? ['Line', 'Talker', 'Fields'] : TYPES[type].cols, rows: g.rows,
    }));
    const probs = [...r.problems, ...r.other].sort((a, b) => a[0] - b[0]);
    if (probs.length) tables.push({ title: `Problems (${probs.length})`, columns: ['Line', 'Text', 'Why'], rows: probs.slice(0, MAXROWS) });
    const gga = r.byType.GGA;
    const texts = gga ? [{ title: 'Track CSV', body: ['line,utc,lat,lon,fix,sats,hdop,alt_m', ...gga.rows.map((x) => [x[0], x[2], x[3], x[4], x[5], x[6], x[7], x[8]].map(csvCell).join(','))].join('\n') + '\n' }] : [];
    notes.push('Positions are decimal degrees from ddmm.mmmm; south and west are negative. Sentences without a checksum are accepted but counted as problems.');
    return { values, warnings, tables, texts, notes };
  }

  const r = m === 'kv' ? parseKv(lines) : parseCsv(lines);
  if (!r || !r.rows.length) return { warnings: ['No rows could be read. Try another format.'], notes };
  if (r.problems.length) warnings.push(`${r.problems.length} line(s) did not fit (see Problems).`);
  const statCols = m === 'kv' ? r.columns.slice(1) : r.columns;
  const statRows = m === 'kv' ? r.rows.map((x) => x.slice(1)) : r.rows;
  const st = statsTable(statCols, statRows);
  const tables = [{ title: `Rows (${r.rows.length})${r.rows.length > MAXROWS ? `, first ${MAXROWS}` : ''}`, columns: r.columns, rows: r.rows.slice(0, MAXROWS) }];
  if (st.length) tables.push({ title: 'Numeric fields', columns: ['Field', 'Count', 'Min', 'Max', 'Mean'], rows: st });
  if (r.problems.length) tables.push({ title: 'Problems', columns: ['Line', 'Text', 'Why'], rows: r.problems.slice(0, MAXROWS) });
  if (m === 'csv') notes.push(`Delimiter "${r.delim === '\t' ? 'tab' : r.delim}", ${r.columns.length} columns${r.columns[0] === 'col1' ? ', no header row' : ''}.`);
  return {
    values: [{ label: 'Rows', value: r.rows.length, tone: 'ok' }, { label: 'Fields', value: r.columns.length }, { label: 'Numeric fields', value: st.length }, { label: 'Problem lines', value: r.problems.length, tone: r.problems.length ? 'warn' : 'ok' }],
    warnings, tables,
    texts: [{ title: 'CSV', body: [r.columns.map(csvCell).join(','), ...r.rows.map((x) => x.map(csvCell).join(','))].join('\n') + '\n' }],
    notes,
  };
}
