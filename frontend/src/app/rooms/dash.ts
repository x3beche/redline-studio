import type { TimeData } from './charts';

/** What the dashboards share - Analytics (rooms/analyze.ts) and the admins'
 *  Dashboard (admin-overview.ts): the ranges at the top, the auto refresh,
 *  a bucket's name, and a panel's rows downloaded as CSV. The look is in
 *  styles.css under "Analytics" (.tcv-dash-*, .tcv-stat, .tcv-panel-d). */

export const DASH_RANGES = [
  { id: '1h', label: '1h' }, { id: '6h', label: '6h' }, { id: '24h', label: '24h' },
  { id: '7d', label: '7d' }, { id: '30d', label: '30d' }, { id: '90d', label: '90d' },
  { id: 'all', label: 'All' },
];
export const DASH_EVERYS = [{ s: 0, label: 'no refresh' }, { s: 30, label: 'every 30 s' },
                            { s: 60, label: 'every 1 min' }, { s: 300, label: 'every 5 min' }];

/** A bucket's length as the bar says it: "5-minute buckets", "hourly"... */
export function stepLabel(s: number) { return s < 3600 ? `${s / 60}-minute buckets` : s < 86400 ? 'hourly' : s < 604800 ? 'daily' : 'weekly'; }
/** ...and as a panel says it: "per hour". */
export function stepWord(s: number) { return s < 3600 ? `${s / 60} min` : s < 86400 ? 'hour' : s < 604800 ? 'day' : 'week'; }

/** A time series as rows: one per bucket, a column per series. */
export function seriesRows(d: TimeData): Record<string, unknown>[] {
  return Array.from({ length: d.n }, (_, i) => ({
    time: new Date((d.t0 + i * d.step) * 1000).toISOString(),
    ...Object.fromEntries(d.series.map(s => [s.name, s.values[i]])),
  }));
}

/** Rows as CSV text: a column for every key any row has. */
export function csvText(rows: object[]): string {
  const flat = rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) =>
    [k, v !== null && typeof v === 'object' ? JSON.stringify(v) : v])));
  const cols = [...new Set(flat.flatMap(r => Object.keys(r)))];
  const cell = (v: unknown) => {
    const t = v == null ? '' : String(v);
    return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };
  return [cols.join(','), ...flat.map(r => cols.map(c => cell((r as Record<string, unknown>)[c])).join(','))].join('\n');
}

/** Text handed to the browser as a file to save. */
export function saveFile(file: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = file; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
