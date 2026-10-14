import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { tap } from 'rxjs';

/** What the rest of the app needs of Taste (taste.ts) without the room: the
 *  palette and run types, the domain and strength lists, the API and the
 *  run watcher behind the tab's mark. The room is a chunk of its own. */
export type Domain = 'form' | 'mechanical' | 'pcb' | 'firmware' | 'general';
export type Strength = 'must' | 'prefer' | 'avoid';
export type Layer = 'language' | 'specific';
export interface ProjectRef { kind: 'folder' | 'model' | 'board' | 'firmware'; id: string; label: string; sub?: string }
export interface Attached extends ProjectRef { product?: string; specifics?: boolean; specifics_default?: boolean }
export interface TasteItem {
  id: string; text: string; domain: Domain; strength: Strength; why?: string;
  applies_to: string; exception?: string; example?: string; layer: Layer; seen?: { n: number; m: number };
  source: 'manual' | ProjectRef;
}
/** A reference render: the source photographed from one view (backend/taste.py). */
export interface RefShot { id: string; view: string; model?: string; label?: string; url: string; size?: number[] }
export interface Palette {
  id: string; name: string; description: string; items: TasteItem[]; attached: Attached[];
  pinned: boolean; by: { id?: string; name?: string }; created_at: string; updated_at: string;
  counts: Record<Domain, number>; priority: string; priority_default: boolean;
  references: RefShot[]; sources: (ProjectRef & { product: string })[]; measures?: string; notice?: string | null;
}
export type NewItem = { text: string; domain: Domain; strength: Strength; why?: string; source?: TasteItem['source'];
                 applies_to?: string; exception?: string; example?: string; layer?: Layer; seen?: TasteItem['seen'] };
export type JobStatus = 'queued' | 'reading' | 'looking' | 'asking' | 'parsing' | 'done' | 'failed' | 'cancelled';
export type StepState = 'running' | 'done' | 'skipped' | 'failed' | 'cancelled' | 'pending';
export interface JobStep {
  id: string; kind: 'read' | 'render' | 'measure' | 'ask' | 'parse' | 'done'; state: StepState;
  views?: string[]; shots?: number; parts?: number; measured?: number; images?: number;
  started_at?: string; finished_at?: string; seconds?: number; reason?: string;
  project?: ProjectRef; chars?: number; budget?: number; clipped?: boolean; revisions?: number; notes?: number; files?: number;
  provider?: string; provider_name?: string; model?: string; prompt_chars?: number; tokens_est?: number;
  max_tokens?: number; timeout?: number; sent_at?: string; tokens_in?: number | null; tokens_out?: number | null; cost?: number | null;
  raw_chars?: number; parsed?: number; rows?: number; invalid?: number; duplicates?: number; over?: number; proposals?: number;
}
export interface JobTotals {
  projects?: number; budget?: number; chars?: number; read?: number; prompt_chars?: number; tokens_in_est?: number;
  tokens_in?: number; tokens_out?: number; cost?: number | null; proposals?: number; images?: number;
}
/** One extraction run (backend/taste.py, `taste_jobs`): it goes on in the
 *  server whatever the page does, and says each step as it happens. */
export interface TasteJob {
  id: string; status: JobStatus; project: ProjectRef; by: { id?: string; name?: string };
  started_at: string; finished_at: string | null; seconds: number | null; now: string;
  provider?: string; provider_name?: string; model?: string;
  steps: JobStep[]; totals: JobTotals; error?: string | null; count: number;
  saved_to?: { id: string; name: string; count: number; at: string } | null;
  /** A Chat proposal's palette (chat_tools/taste_propose.py): offered first when they are saved. */
  target?: { id: string; name: string } | null;
  proposals?: TasteItem[];
  references?: RefShot[]; notice?: string; measures?: string; vision?: boolean;
}
export const ACTIVE: JobStatus[] = ['queued', 'reading', 'looking', 'asking', 'parsing'];
export const isActive = (j: { status: JobStatus } | null | undefined) => !!j && ACTIVE.includes(j.status);

export const DOMAINS: { id: Domain; label: string; short: string }[] = [
  { id: 'form', label: 'Form language', short: 'Form' }, { id: 'mechanical', label: 'Mechanical', short: 'Mech' }, { id: 'pcb', label: 'PCB', short: 'PCB' },
  { id: 'firmware', label: 'Firmware', short: 'FW' }, { id: 'general', label: 'General', short: 'Gen' },
];
/** Where an item holds; anything else is the person's own words. */
export const SCOPES: { id: string; label: string }[] = [
  { id: 'all', label: 'Everywhere' }, { id: 'visible', label: 'Visible surfaces' },
  { id: 'hidden', label: 'Hidden surfaces' }, { id: 'internal', label: 'Internal features' },
];
export const LAYERS: { id: Layer; label: string }[] = [
  { id: 'language', label: 'Design language' }, { id: 'specific', label: 'Project-specific' },
];
export const STRENGTHS: { id: Strength; label: string }[] = [
  { id: 'must', label: 'MUST' }, { id: 'prefer', label: 'PREFER' }, { id: 'avoid', label: 'AVOID' },
];
/** A colour per domain (the theme's chart series) and per strength (as the
 *  MUST / PREFER / AVOID labels are written), for the bars. */
export const DOMAIN_COLOR: Record<Domain, string> = {
  form: 'var(--series-2)', mechanical: 'var(--series-1)', pcb: 'var(--series-3)', firmware: 'var(--series-4)', general: 'var(--series-7)',
};
export const STRENGTH_COLOR: Record<Strength, string> = { must: 'var(--accent)', prefer: 'var(--ink-dim)', avoid: 'var(--danger)' };
@Injectable({ providedIn: 'root' })
export class TasteApi {
  private http = inject(HttpClient);
  /** Bumped whenever a palette is written, so lists read again. */
  changed = signal(0);

  list(q = '') { return this.http.get<Palette[]>(`/api/taste?q=${encodeURIComponent(q)}`); }
  create(name: string, items: NewItem[] = [], description = '') {
    return this.http.post<Palette>('/api/taste', { name, description, items });
  }
  patch(id: string, p: { name?: string; description?: string; pinned?: boolean; priority?: string }) {
    return this.http.patch<Palette>(`/api/taste/${id}`, p);
  }
  remove(id: string) { return this.http.delete(`/api/taste/${id}`); }
  add(id: string, items: NewItem[]) { return this.http.post<Palette>(`/api/taste/${id}/items`, { items }); }
  edit(id: string, iid: string, p: Partial<NewItem>) { return this.http.patch<Palette>(`/api/taste/${id}/items/${iid}`, p); }
  drop(id: string, iid: string) { return this.http.delete<Palette>(`/api/taste/${id}/items/${iid}`); }
  order(id: string, ids: string[]) { return this.http.put<Palette>(`/api/taste/${id}/order`, { ids }); }
  /** A palette as a file for someone else, and such a file made a palette here (backend/taste.py). */
  exportFile(id: string) { return this.http.get<unknown>(`/api/taste/${id}/export`); }
  importFile(data: unknown) { return this.http.post<Palette>('/api/taste/import', data); }
  /** Bumps `changed`: what applies to a project is read again where it is shown (taste-strip.ts). */
  attach(id: string, attached: { kind: string; id: string; specifics?: boolean }[]) {
    return this.http.put<Palette>(`/api/taste/${id}/attached`, { attached })
      .pipe(tap(() => this.changed.update(n => n + 1)));
  }
  /** Models, boards and firmware; with `folders`, the folders too (extraction reads a folder whole). */
  projects(q = '', folders = false) {
    return this.http.get<ProjectRef[]>(`/api/taste/projects?q=${encodeURIComponent(q)}${folders ? '&folders=1' : ''}`);
  }
  /** Start a run: it goes on in the server, read back with job(). */
  extract(kind: string, id: string) { return this.http.post<TasteJob>('/api/taste/extract', { kind, id }); }
  jobs(limit = 20) { return this.http.get<TasteJob[]>(`/api/taste/jobs?limit=${limit}`); }
  job(id: string) { return this.http.get<TasteJob>(`/api/taste/jobs/${id}`); }
  cancelJob(id: string) { return this.http.post<TasteJob>(`/api/taste/jobs/${id}/cancel`, {}); }
  savedTo(id: string, to: { id: string; name: string; count: number }) {
    return this.http.patch<TasteJob>(`/api/taste/jobs/${id}`, { saved_to: to });
  }
}

/** The workspace's extraction runs, kept for the whole page: the Taste tab
 *  shows a running one beside its name, and a finished one until Taste is
 *  opened, whichever room is in front. Asked for every few seconds only
 *  while a run is going. */
@Injectable({ providedIn: 'root' })
export class TasteRuns {
  private api = inject(TasteApi);
  jobs = signal<TasteJob[]>([]);
  running = computed(() => this.jobs().filter(isActive).length);
  /** Runs that finished while Taste was not open. */
  unseen = signal(0);
  /** Whether the Taste room is open (it clears `unseen`). */
  here = false;
  private watching = false;
  private timer?: ReturnType<typeof setTimeout>;

  watch() { if (!this.watching) { this.watching = true; this.refresh(); } }

  refresh(): Promise<TasteJob[]> {
    return new Promise(done => this.api.jobs().subscribe({
      next: rows => { this.take(rows); done(rows); },
      error: () => { this.again(); done(this.jobs()); },
    }));
  }

  /** A run as the room just read it, into the list. */
  put(j: TasteJob) {
    const { proposals: _, ...light } = j;
    const have = this.jobs();
    this.take(have.some(x => x.id === j.id) ? have.map(x => x.id === j.id ? light : x) : [light, ...have]);
  }

  seen() { this.unseen.set(0); }

  private take(rows: TasteJob[]) {
    const before = new Map(this.jobs().map(j => [j.id, j.status]));
    const ended = rows.filter(j => !isActive(j) && before.has(j.id) && ACTIVE.includes(before.get(j.id)!)).length;
    if (ended && !this.here) this.unseen.update(n => n + ended);
    this.jobs.set(rows);
    this.again();
  }

  private again() {
    clearTimeout(this.timer);
    if (this.jobs().some(isActive)) this.timer = setTimeout(() => this.refresh(), 5000);
  }
}
