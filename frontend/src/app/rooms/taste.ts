import { Component, ElementRef, Injectable, OnDestroy, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { NgTemplateOutlet } from '@angular/common';
import { Selection } from '../selection';
import { Auth } from '../auth';
import { LANG, T, t } from '../i18n';

/** Taste ("Tadım"): what makes a design good, kept as statements an agent
 *  can follow (backend/taste.py).
 *
 *  A palette is a named list of short statements - each MUST, PREFER or
 *  AVOID, for mechanical, PCB, firmware or anything - laid out here in one
 *  column per domain. A palette goes to the AI two ways: @-mentioned in
 *  Chat like a note, or attached to a model, board or firmware, after
 *  which every agent working on that project gets it by itself.
 *
 *  "Extract from project…" asks a model to read a finished project and
 *  propose statements; each one is accepted, edited or rejected here, and
 *  only the accepted ones are saved - into a new palette or an existing one.
 */
export type Domain = 'mechanical' | 'pcb' | 'firmware' | 'general';
export type Strength = 'must' | 'prefer' | 'avoid';
export interface ProjectRef { kind: 'folder' | 'model' | 'board' | 'firmware'; id: string; label: string; sub?: string }
export interface TasteItem {
  id: string; text: string; domain: Domain; strength: Strength; why?: string;
  source: 'manual' | ProjectRef;
}
export interface Palette {
  id: string; name: string; description: string; items: TasteItem[]; attached: ProjectRef[];
  pinned: boolean; by: { id?: string; name?: string }; created_at: string; updated_at: string;
  counts: Record<Domain, number>;
}
type Proposal = TasteItem & { keep: boolean };
type NewItem = { text: string; domain: Domain; strength: Strength; why?: string; source?: TasteItem['source'] };
export type JobStatus = 'queued' | 'reading' | 'asking' | 'parsing' | 'done' | 'failed' | 'cancelled';
export type StepState = 'running' | 'done' | 'skipped' | 'failed' | 'cancelled' | 'pending';
export interface JobStep {
  id: string; kind: 'read' | 'ask' | 'parse' | 'done'; state: StepState;
  started_at?: string; finished_at?: string; seconds?: number; reason?: string;
  project?: ProjectRef; chars?: number; budget?: number; clipped?: boolean; revisions?: number; notes?: number; files?: number;
  provider?: string; provider_name?: string; model?: string; prompt_chars?: number; tokens_est?: number;
  max_tokens?: number; timeout?: number; sent_at?: string; tokens_in?: number | null; tokens_out?: number | null; cost?: number | null;
  raw_chars?: number; parsed?: number; rows?: number; invalid?: number; duplicates?: number; over?: number; proposals?: number;
}
export interface JobTotals {
  projects?: number; budget?: number; chars?: number; read?: number; prompt_chars?: number; tokens_in_est?: number;
  tokens_in?: number; tokens_out?: number; cost?: number | null; proposals?: number;
}
/** One extraction run (backend/taste.py, `taste_jobs`): it goes on in the
 *  server whatever the page does, and says each step as it happens. */
export interface TasteJob {
  id: string; status: JobStatus; project: ProjectRef; by: { id?: string; name?: string };
  started_at: string; finished_at: string | null; seconds: number | null; now: string;
  provider?: string; provider_name?: string; model?: string;
  steps: JobStep[]; totals: JobTotals; error?: string | null; count: number;
  saved_to?: { id: string; name: string; count: number; at: string } | null;
  proposals?: TasteItem[];
}
export const ACTIVE: JobStatus[] = ['queued', 'reading', 'asking', 'parsing'];
export const isActive = (j: { status: JobStatus } | null | undefined) => !!j && ACTIVE.includes(j.status);

export const DOMAINS: { id: Domain; label: string; short: string }[] = [
  { id: 'mechanical', label: 'Mechanical', short: 'Mech' }, { id: 'pcb', label: 'PCB', short: 'PCB' },
  { id: 'firmware', label: 'Firmware', short: 'FW' }, { id: 'general', label: 'General', short: 'Gen' },
];
export const STRENGTHS: { id: Strength; label: string }[] = [
  { id: 'must', label: 'MUST' }, { id: 'prefer', label: 'PREFER' }, { id: 'avoid', label: 'AVOID' },
];
const KIND_NAME: Record<string, string> = { folder: 'Folder', model: '3D model', board: 'Board', firmware: 'Firmware' };
/** A colour per domain (the theme's chart series) and per strength (as the
 *  MUST / PREFER / AVOID labels are written), for the bars. */
export const DOMAIN_COLOR: Record<Domain, string> = {
  mechanical: 'var(--series-1)', pcb: 'var(--series-3)', firmware: 'var(--series-4)', general: 'var(--series-7)',
};
export const STRENGTH_COLOR: Record<Strength, string> = { must: 'var(--accent)', prefer: 'var(--ink-dim)', avoid: 'var(--danger)' };
type Tally = Record<Strength, number>;
const tally = (items: TasteItem[]): Tally => {
  const n: Tally = { must: 0, prefer: 0, avoid: 0 };
  for (const i of items) n[i.strength] = (n[i.strength] ?? 0) + 1;
  return n;
};

@Injectable({ providedIn: 'root' })
export class TasteApi {
  private http = inject(HttpClient);
  /** Bumped whenever a palette is written, so lists read again. */
  changed = signal(0);

  list(q = '') { return this.http.get<Palette[]>(`/api/taste?q=${encodeURIComponent(q)}`); }
  create(name: string, items: NewItem[] = [], description = '') {
    return this.http.post<Palette>('/api/taste', { name, description, items });
  }
  patch(id: string, p: { name?: string; description?: string; pinned?: boolean }) {
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
  attach(id: string, attached: { kind: string; id: string }[]) {
    return this.http.put<Palette>(`/api/taste/${id}/attached`, { attached });
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

function when(iso: string): string {
  const d = new Date(iso), now = new Date(), loc = LANG() === 'tr' ? 'tr-TR' : [];
  const days = Math.floor((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86400000);
  if (days === 0) return d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
  if (days < 7) return d.toLocaleDateString(loc, { weekday: 'short' });
  return d.toLocaleDateString(loc, { day: 'numeric', month: 'short' });
}

function why(e: HttpErrorResponse, fallback: string): string {
  return typeof e.error?.detail === 'string' ? e.error.detail : t(fallback);
}

/** The Taste room. */
@Component({
  selector: 'app-room-taste',
  imports: [T, NgTemplateOutlet],
  styleUrls: ['../settings.css', './taste.css'],
  host: { '(document:keydown)': 'key($event)', '(document:click)': 'closePicker()' },
  template: `
<div class="tcv-room absolute inset-0 flex min-h-0 gap-1 p-1">
  <!-- LEFT: the palettes -->
  <aside class="tcv-notes-side">
    <div class="tcv-notes-find">
      <input #search class="tcv-notes-search" [placeholder]="'Search palettes   /' | t" [value]="q()"
             (input)="q.set($any($event.target).value)" (keydown.escape)="q.set(''); $any($event.target).blur()">
    </div>
    @if (can()) {
      <div class="tst-side-acts">
        <button class="tcv-btn" (click)="newPalette()">{{ 'New palette' | t }}</button>
        <button class="tcv-btn" (click)="startExtract(); $event.stopPropagation()">{{ 'Extract from project…' | t }}</button>
        <button class="tcv-btn" (click)="importIn.click()" [title]="'Make a palette from a file someone sent you' | t">{{ 'Import…' | t }}</button>
        <input #importIn type="file" accept=".json,application/json" hidden (change)="importPalette($any($event.target))">
      </div>
    }
    <div class="tcv-notes-list">
      @if (!q()) {
        <button class="tcv-notes-item tsh-ov" [attr.data-on]="home() ? 1 : null" (click)="goHome()">
          <span class="tcv-notes-item-top">
            <span class="tcv-notes-item-title">{{ 'Overview' | t }}</span>
            <span class="tcv-notes-item-when">{{ fmt('{n} palettes · {m} items', { n: overall().palettes, m: overall().items }) }}</span>
          </span>
          <span class="tsh-stack" aria-hidden="true">
            @for (s of overall().bySeg; track s.id) { <i [style.flex-grow]="s.n" [style.background]="s.c"></i> }
          </span>
        </button>
      }
      @for (p of palettes(); track p.id) {
        <button class="tcv-notes-item" [attr.data-on]="p.id === openId() && mode() === 'palette' ? 1 : null" (click)="openPalette(p.id)"
                [title]="p.attached.length ? fmt('on {p}', { p: attachedLine(p) }) : ''">
          <span class="tcv-notes-item-top">
            @if (p.pinned) { <span class="tcv-notes-pin" [title]="'Pinned' | t">●</span> }
            <span class="tcv-notes-item-title">{{ p.name }}</span>
            <span class="tcv-notes-item-when">{{ p.items.length }} {{ (p.items.length === 1 ? 'item' : 'items') | t }}</span>
          </span>
          <span class="tsh-stack" aria-hidden="true">
            @for (d of domains; track d.id) { @if (p.counts[d.id]) { <i [style.flex-grow]="p.counts[d.id]" [style.background]="dc(d.id)"></i> } }
          </span>
          <span class="tcv-notes-item-meta tst-counts">
            @for (d of domains; track d.id) {
              @if (p.counts[d.id]) { <span><i class="tsh-dot" [style.background]="dc(d.id)"></i>{{ d.short | t }} <b>{{ p.counts[d.id] }}</b></span> }
            }
            <span class="tsh-att" [attr.data-on]="p.attached.length ? 1 : null">{{ p.attached.length ? fmt('{n} attached', { n: p.attached.length }) : ('not attached' | t) }}</span>
          </span>
        </button>
      } @empty {
        <p class="tcv-notes-empty">{{ (q() ? 'Nothing matches.' : 'No palettes yet.') | t }}</p>
      }
    </div>
  </aside>

  <!-- RIGHT: one palette, or proposals from a project -->
  <section class="tcv-notes-main tst">
    @if (flash(); as f) { <p class="tcv-note-flash">{{ f }}</p> }

    @if (mode() === 'extract') {
      <header class="tst-head">
        <div class="tst-title">
          <h2>{{ 'Extract taste from a project' | t }}</h2>
          <span class="st-sub">{{ 'A model reads the project and proposes statements; nothing is kept until you save it. The run goes on if you leave or reload this page.' | t }}</span>
        </div>
        <div class="tst-acts">
          <span class="tst-pickwrap" (click)="$event.stopPropagation()">
            <button class="tcv-btn" (click)="openPicker('extract')" [disabled]="running()">
              {{ exProject() ? (kindName(exProject()!.kind) | t) + ': ' + exProject()!.label : ('Choose a project…' | t) }}</button>
            @if (picker() === 'extract') {
              <div class="tst-pop" role="listbox">
                <input #pickq class="tcv-notes-search" [placeholder]="'Find a folder, model, board or firmware' | t" [value]="pickQ()"
                       (input)="findProjects($any($event.target).value)" (keydown)="pickKey($event)">
                <div class="tst-pop-list">
                  @for (r of projects(); track r.kind + r.id; let k = $index) {
                    <button [attr.data-on]="k === pickIdx() ? 1 : null" (mouseenter)="pickIdx.set(k)" (click)="pickProject(r)">
                      <span class="tst-pop-kind">{{ kindName(r.kind) | t }}</span><span class="tst-pop-label">{{ r.label }}</span>
                      <span class="tst-pop-sub">{{ r.sub }}</span>
                    </button>
                  } @empty { <p class="st-hint tst-pad">{{ 'Nothing matches.' | t }}</p> }
                </div>
              </div>
            }
          </span>
          @if (running()) {
            <button class="tcv-btn tst-del" (click)="cancelRun()" [disabled]="cancelling() || !can()">{{ (cancelling() ? 'Cancelling…' : 'Cancel the run') | t }}</button>
          } @else if (can()) {
            <button class="tcv-btn tcv-btn-accent" (click)="runExtract()" [disabled]="!exProject() || starting()">
              {{ (starting() ? 'Starting…' : job() ? 'Run again' : 'Run') | t }}</button>
          }
          <button class="tcv-btn" (click)="leaveExtract()">{{ 'Close' | t }}</button>
        </div>
      </header>

      @if (job()?.status === 'failed') {
        <div class="st-banner tst-banner tsx-banner" role="alert">
          <span class="tsx-banner-text"><b>{{ 'The extraction failed' | t }}:</b> {{ job()!.error }}</span>
          @if (can()) { <button class="tcv-btn" (click)="runExtract()" [disabled]="starting()">{{ 'Try again' | t }}</button> }
        </div>
      } @else if (exError(); as e) {
        <div class="st-banner tst-banner tsx-banner" role="alert"><span class="tsx-banner-text">{{ e }}</span></div>
      }

      @if (job(); as j) {
        <!-- the run in figures, as the Settings pages show theirs -->
        <div class="st-tiles tsx-tiles">
          <div class="st-tile" [attr.data-tone]="statusTone(j.status)"><span>{{ 'Status' | t }}</span><b>{{ statusName(j.status) | t }}</b>
            <small [title]="j.by.name || ''">{{ fmt('since {w}', { w: when(j.started_at) }) }}</small></div>
          <div class="st-tile"><span>{{ 'Elapsed' | t }}</span><b>{{ dur(elapsed()) }}</b>
            <small>{{ nowLine() }}</small></div>
          <div class="st-tile"><span>{{ 'Projects read' | t }}</span><b>{{ readCount() }} / {{ j.totals.projects ?? '–' }}</b>
            <small>{{ skippedCount() ? fmt('{n} skipped', { n: skippedCount() }) : (kindName(j.project.kind) | t) + ' · ' + j.project.label }}</small></div>
          <div class="st-tile"><span>{{ 'Sent to the model' | t }}</span><b>{{ j.totals.prompt_chars != null ? num(j.totals.prompt_chars) : num(charsRead()) }}</b>
            <small>{{ fmt('~{n} tokens', { n: num(j.totals.tokens_in_est ?? round(charsRead() / 4)) }) }}</small></div>
          <div class="st-tile tsx-model"><span>{{ 'Model' | t }}</span><b [title]="j.model || ''">{{ j.model || '–' }}</b><small>{{ j.provider_name || j.provider || '' }}</small></div>
          <div class="st-tile" [attr.data-tone]="j.totals.tokens_in == null ? 'dim' : null"><span>{{ 'Tokens in / out' | t }}</span>
            <b>{{ j.totals.tokens_in == null ? '–' : num(j.totals.tokens_in) + ' / ' + num(j.totals.tokens_out ?? 0) }}</b>
            <small>{{ (j.totals.tokens_in != null ? 'as counted' : running() ? 'after the answer' : 'no answer') | t }}</small></div>
          <div class="st-tile" [attr.data-tone]="j.totals.cost == null ? 'dim' : null"><span>{{ 'Cost' | t }}</span><b>{{ money(j.totals.cost) }}</b>
            <small>{{ (j.totals.cost != null ? 'this run' : j.totals.tokens_in != null ? 'not priced' : '') | t }}&nbsp;</small></div>
          <div class="st-tile" [attr.data-tone]="j.status === 'done' ? 'ok' : 'dim'"><span>{{ 'Proposals' | t }}</span><b>{{ j.status === 'done' ? j.count : '–' }}</b>
            <small>{{ droppedLine() }}&nbsp;</small></div>
        </div>

        @if (j.status === 'done' && proposals().length) {
          @if (j.saved_to; as s) { <p class="st-hint">{{ fmt('Saved to {p} {w}; you can save them again or into another palette.', { p: s.name, w: when(s.at) }) }}</p> }
        <div class="tst-cols" [style.--n]="propCols().length">
          @for (c of propCols(); track c.id) {
            <div class="tst-col">
              <div class="tst-col-head"><h3>{{ c.label | t }}</h3><span class="st-sub">{{ c.kept }} / {{ c.items.length }}</span></div>
              @for (it of c.items; track it.id) {
                <div class="tst-item" [attr.data-drop]="it.keep ? null : 1">
                  <span class="tst-str" [attr.data-s]="it.strength">{{ strengthLabel(it.strength) | t }}</span>
                  <div class="tst-item-main">
                    @if (editId() === it.id) {
                      <textarea class="tst-edit" rows="2" [value]="draft().text" (input)="setDraft('text', $any($event.target).value)"
                                (keydown.enter)="$event.preventDefault(); saveProposal(it)" (keydown.escape)="editId.set(null)"></textarea>
                      <div class="tst-edit-row">
                        <select class="tst-sel" [value]="draft().strength" (change)="setDraft('strength', $any($event.target).value)">
                          @for (s of strengths; track s.id) { <option [value]="s.id">{{ s.label | t }}</option> }</select>
                        <select class="tst-sel" [value]="draft().domain" (change)="setDraft('domain', $any($event.target).value)">
                          @for (d of domains; track d.id) { <option [value]="d.id">{{ d.label | t }}</option> }</select>
                        <input class="tst-in" [placeholder]="'Why (optional)' | t" [value]="draft().why ?? ''"
                               (input)="setDraft('why', $any($event.target).value)" (keydown.enter)="saveProposal(it)">
                        <button class="tcv-btn" (click)="saveProposal(it)">{{ 'Done' | t }}</button>
                      </div>
                    } @else {
                      <span class="tst-text" (dblclick)="editProposal(it)">{{ it.text }}</span>
                      @if (it.why) { <span class="tst-why">{{ it.why }}</span> }
                    }
                  </div>
                  @if (editId() !== it.id) {
                    <span class="tst-item-acts tst-review">
                      <button class="tst-ib" [attr.data-on]="it.keep ? 1 : null" (click)="setKeep(it, true)" [title]="'Accept' | t">{{ 'Accept' | t }}</button>
                      <button class="tst-ib" (click)="editProposal(it)" [title]="'Edit' | t">{{ 'Edit' | t }}</button>
                      <button class="tst-ib" [attr.data-on]="!it.keep ? 1 : null" (click)="setKeep(it, false)" [title]="'Reject' | t">{{ 'Reject' | t }}</button>
                    </span>
                  }
                </div>
              }
            </div>
          }
        </div>
        @if (can()) {
          <footer class="tst-save">
            <span class="st-sub">{{ fmt('{n} of {m} accepted · from {p}', { n: keptCount(), m: proposals().length, p: exFrom() }) }}</span>
            <span class="grow"></span>
            <label class="st-sub">{{ 'Save to' | t }}</label>
            <select class="tst-sel" [value]="saveTo()" (change)="saveTo.set($any($event.target).value)">
              <option value="">{{ 'A new palette' | t }}</option>
              @for (p of allPalettes(); track p.id) { <option [value]="p.id">{{ p.name }}</option> }
            </select>
            @if (!saveTo()) {
              <input class="tst-in tst-newname" [placeholder]="'Palette name' | t" [value]="newName()" (input)="newName.set($any($event.target).value)">
            }
            <button class="tcv-btn tcv-btn-accent" (click)="saveProposals()" [disabled]="!keptCount() || saving() || (!saveTo() && !newName().trim())">
              {{ fmt('Save {n} to the palette', { n: keptCount() }) }}</button>
          </footer>
        }
        }

        <!-- the run, step by step - and how much of the reading each project took -->
        <div class="tsx-grid">
          <section class="st-card tsx-steps">
            <div class="st-card-head"><h3>{{ 'Steps' | t }}</h3>
              <span class="st-sub">{{ fmt('{n} of {m} done', { n: doneSteps(), m: allSteps() }) }}</span>
              @if (running()) { <span class="st-right st-sub">{{ fmt('every {s} s while it runs', { s: '1.5' }) }}</span> }</div>
            <ol class="tsx-line">
              @for (r of timeline(); track r.id) {
                <li class="tsx-step" [attr.data-state]="r.state">
                  <i class="tsx-mark" aria-hidden="true"></i>
                  <span class="tsx-kind">{{ r.kind | t }}</span>
                  <span class="tsx-main">
                    <b>{{ r.title }}</b>
                    @if (r.detail) { <small>{{ r.detail }}</small> }
                    @if (r.reason) { <em>{{ r.reason }}</em> }
                  </span>
                  <span class="tsx-fig">{{ r.fig }}</span>
                  <span class="tsx-state">{{ stateName(r.state) | t }}</span>
                  <span class="tsx-time">{{ r.time }}</span>
                </li>
              }
            </ol>
          </section>
          <section class="st-card tsx-budget">
            <div class="st-card-head"><h3>{{ 'Reading budget' | t }}</h3>
              <span class="st-sub">{{ fmt('{n} of {m} characters', { n: num(charsRead()), m: num(j.totals.budget ?? 0) }) }}</span></div>
            <div class="st-card-body">
              <div class="tsx-total">
                <div class="st-meter" [attr.data-tone]="budgetPct() > 95 ? 'warn' : null"><i [style.width.%]="budgetPct()"></i></div>
                <span class="st-sub">{{ fmt('{p}% of what one run reads; each project gets its share, and what is over its share is clipped.', { p: budgetPct() }) }}</span>
              </div>
              <div class="tsx-bars">
                @for (b of bars(); track b.id) {
                  <div class="tsx-bar" [attr.data-tone]="b.tone" [title]="b.tip">
                    <span class="tsx-bar-name">{{ b.label }}</span>
                    <span class="ccl-bar tsx-track"><i [style.width.%]="b.pct"></i></span>
                    <span class="tsx-bar-fig">{{ b.fig }}</span>
                  </div>
                } @empty { <p class="st-hint">{{ 'Nothing read yet.' | t }}</p> }
              </div>
              <p class="st-hint">{{ 'A bar is how much of its share a project used; amber: it had more, and the rest was left out.' | t }}</p>
            </div>
          </section>
        </div>
      } @else {
        <p class="st-hint">{{ 'Choose a finished model, board, firmware or a whole folder and run. You can leave this page while it runs; its steps and proposals are here when you come back.' | t }}</p>
      }

      @if (recent().length) { <ng-container [ngTemplateOutlet]="recentCard" [ngTemplateOutletContext]="{ rows: recent() }" /> }

    } @else if (open(); as p) {
      <header class="tst-head">
        <div class="tst-title">
          <input class="tst-name" [value]="p.name" [readonly]="!can()" (change)="rename(p, $any($event.target).value)"
                 (keydown.enter)="$any($event.target).blur()" [attr.aria-label]="'Palette name' | t">
          <input class="tst-desc" [value]="p.description" [readonly]="!can()" [placeholder]="can() ? ('Add a description' | t) : ''"
                 (change)="describe(p, $any($event.target).value)" (keydown.enter)="$any($event.target).blur()">
        </div>
        <div class="tst-acts">
          <span class="st-sub">{{ p.by.name || ('someone' | t) }} · {{ when(p.updated_at) }}</span>
          @if (can()) {
            <span class="tst-pickwrap" (click)="$event.stopPropagation()">
              <button class="tcv-btn" (click)="openPicker('attach')">{{ 'Attach to…' | t }}</button>
              @if (picker() === 'attach') {
                <div class="tst-pop" role="listbox">
                  <input #pickq class="tcv-notes-search" [placeholder]="'Find a model, board or firmware' | t" [value]="pickQ()"
                         (input)="findProjects($any($event.target).value)" (keydown)="pickKey($event)">
                  <div class="tst-pop-list">
                    @for (r of projects(); track r.kind + r.id; let k = $index) {
                      <button [attr.data-on]="k === pickIdx() ? 1 : null" (mouseenter)="pickIdx.set(k)" (click)="pickProject(r)"
                              [attr.aria-selected]="isAttached(p, r)">
                        <span class="tst-check" [attr.data-on]="isAttached(p, r) ? 1 : null"></span>
                        <span class="tst-pop-kind">{{ kindName(r.kind) | t }}</span><span class="tst-pop-label">{{ r.label }}</span>
                        <span class="tst-pop-sub">{{ r.sub }}</span>
                      </button>
                    } @empty { <p class="st-hint tst-pad">{{ 'Nothing matches.' | t }}</p> }
                  </div>
                  <p class="st-hint tst-pad">{{ 'Every agent working on an attached project gets this palette.' | t }}</p>
                </div>
              }
            </span>
            <button class="tcv-btn" (click)="startExtract(); $event.stopPropagation()">{{ 'Extract from project…' | t }}</button>
            <button class="tcv-btn" (click)="exportPalette(p)" [title]="'Save this palette as a file to send to someone' | t">{{ 'Export' | t }}</button>
            <button class="tcv-btn" (click)="pin(p)">{{ (p.pinned ? 'Unpin' : 'Pin') | t }}</button>
            <button class="tcv-btn tst-del" (click)="remove(p)">{{ 'Delete' | t }}</button>
          }
        </div>
      </header>
      @let ps = openStats();
      <div class="st-tiles tsh-ptiles">
        <div class="st-tile" [attr.data-tone]="p.items.length ? null : 'dim'"><span>{{ 'Items' | t }}</span><b>{{ p.items.length }}</b>
          <small [title]="fmt('{n} by hand · {m} extracted', { n: ps.manual, m: p.items.length - ps.manual })">{{ fmt('{n} by hand · {m} extracted', { n: ps.manual, m: p.items.length - ps.manual }) }}</small></div>
        @for (s of strengths; track s.id) {
          <div class="st-tile tsh-str" [attr.data-s]="s.id" [attr.data-tone]="ps.str[s.id] ? null : 'dim'"><span>{{ s.label | t }}</span><b>{{ ps.str[s.id] }}</b>
            <div class="st-meter"><i [style.width.%]="pct(ps.str[s.id], p.items.length)" [style.background]="sc(s.id)"></i></div></div>
        }
        <div class="st-tile tsh-dtile"><span>{{ 'Domains' | t }}</span>
          <span class="tsh-dlegend">
            @for (d of domains; track d.id) {
              <span [class.dim]="!p.counts[d.id]" [title]="d.label | t"><i class="tsh-dot" [style.background]="dc(d.id)"></i>{{ d.short | t }} <b>{{ p.counts[d.id] || 0 }}</b></span>
            }
          </span>
          <span class="tsh-stack tsh-stack-d">
            @for (d of domains; track d.id) { @if (p.counts[d.id]) { <i [style.flex-grow]="p.counts[d.id]" [style.background]="dc(d.id)"></i> } }
          </span></div>
        <div class="st-tile" [attr.data-tone]="p.attached.length ? null : 'dim'"><span>{{ 'Attached' | t }}</span><b>{{ p.attached.length }}</b>
          <small [title]="attachedLine(p)">{{ p.attached.length ? attachedLine(p) : ('not attached' | t) }}</small></div>
        <div class="st-tile tsh-src" [attr.data-tone]="ps.sources.length ? null : 'dim'"><span>{{ 'Sources' | t }}</span>
          <b>{{ ps.sources.length ? fmt(ps.sources.length === 1 ? '{n} project' : '{n} projects', { n: ps.sources.length }) : ('by hand' | t) }}</b>
          <small [title]="ps.sourceLine">{{ ps.sources.length ? ps.sourceLine : ('nothing extracted' | t) }}</small></div>
      </div>
      @if (p.attached.length) {
        <div class="tst-attached">
          <span class="st-sub">{{ 'Given to the agents of' | t }}</span>
          @for (a of p.attached; track a.kind + a.id) {
            <span class="tst-chip"><em>{{ kindName(a.kind) | t }}</em> {{ a.label }}
              @if (can()) { <button (click)="detach(p, a)" [title]="'Detach' | t" [attr.aria-label]="('Detach' | t) + ': ' + a.label">×</button> }</span>
          }
        </div>
      }
      @if (can()) {
        <div class="tst-add">
          <select class="tst-sel" [value]="addStrength()" (change)="addStrength.set($any($event.target).value)" [attr.aria-label]="'Strength' | t">
            @for (s of strengths; track s.id) { <option [value]="s.id">{{ s.label | t }}</option> }</select>
          <select class="tst-sel" [value]="addDomain()" (change)="addDomain.set($any($event.target).value)" [attr.aria-label]="'Domain' | t">
            @for (d of domains; track d.id) { <option [value]="d.id">{{ d.label | t }}</option> }</select>
          <input #addBox class="tst-in tst-add-text" [placeholder]="'One statement, checkable: Walls 2 mm, outside edges filleted 1 mm' | t"
                 [value]="addText()" (input)="addText.set($any($event.target).value)" (keydown.enter)="addItem(p)">
          <input class="tst-in tst-add-why" [placeholder]="'Why (optional)' | t" [value]="addWhy()"
                 (input)="addWhy.set($any($event.target).value)" (keydown.enter)="addItem(p)">
          <button class="tcv-btn tcv-btn-accent" (click)="addItem(p)" [disabled]="!addText().trim()">{{ 'Add' | t }} <kbd>↵</kbd></button>
        </div>
      }
      @if (p.items.length) {
        <div class="tst-cols" [style.--n]="cols().length">
          @for (c of cols(); track c.id) {
            <div class="st-card tst-col" (dragover)="dragOver($event)" (drop)="dropOn($event, p, c.id, null)">
              <div class="st-card-head tst-col-head"><i class="tsh-dot" [style.background]="dc(c.id)"></i><h3>{{ c.label | t }}</h3><span class="st-sub">{{ c.items.length }}</span>
                <span class="st-right tsh-colfig">
                  @for (s of strengths; track s.id) { <span [attr.data-s]="s.id" [title]="s.label | t">{{ countOf(c.items, s.id) }}</span> }
                </span></div>
              <span class="tsh-stack tsh-colbar" aria-hidden="true">
                @for (s of strengths; track s.id) { @if (countOf(c.items, s.id)) { <i [style.flex-grow]="countOf(c.items, s.id)" [style.background]="sc(s.id)"></i> } }
              </span>
              @for (it of c.items; track it.id) {
                <div class="tst-item" tabindex="0" [attr.data-id]="it.id" [attr.draggable]="can() && editId() !== it.id ? 'true' : null"
                     [attr.data-drag]="dragId() === it.id ? 1 : null"
                     (dragstart)="dragStart($event, it)" (dragend)="dragId.set(null)"
                     (dragover)="dragOver($event)" (drop)="dropOn($event, p, c.id, it); $event.stopPropagation()"
                     (keydown)="itemKey($event, p, it)" (dblclick)="can() && editItem(it)">
                  <span class="tst-str" [attr.data-s]="it.strength">{{ strengthLabel(it.strength) | t }}</span>
                  <div class="tst-item-main">
                    @if (editId() === it.id) {
                      <textarea class="tst-edit" rows="2" [value]="draft().text" (input)="setDraft('text', $any($event.target).value)"
                                (keydown.enter)="$event.preventDefault(); saveItem(p, it)" (keydown.escape)="editId.set(null)"></textarea>
                      <div class="tst-edit-row">
                        <select class="tst-sel" [value]="draft().strength" (change)="setDraft('strength', $any($event.target).value)">
                          @for (s of strengths; track s.id) { <option [value]="s.id">{{ s.label | t }}</option> }</select>
                        <select class="tst-sel" [value]="draft().domain" (change)="setDraft('domain', $any($event.target).value)">
                          @for (d of domains; track d.id) { <option [value]="d.id">{{ d.label | t }}</option> }</select>
                        <input class="tst-in" [placeholder]="'Why (optional)' | t" [value]="draft().why ?? ''"
                               (input)="setDraft('why', $any($event.target).value)" (keydown.enter)="saveItem(p, it)"
                               (keydown.escape)="editId.set(null)">
                        <button class="tcv-btn" (click)="saveItem(p, it)">{{ 'Save' | t }}</button>
                        <button class="tcv-btn" (click)="editId.set(null)">{{ 'Cancel' | t }}</button>
                      </div>
                    } @else {
                      <span class="tst-text">{{ it.text }}</span>
                      @if (it.why) { <span class="tst-why">{{ it.why }}</span> }
                      @if (it.source !== 'manual') { <span class="tst-src">{{ fmt('from {p}', { p: it.source.label }) }}</span> }
                    }
                  </div>
                  @if (can() && editId() !== it.id) {
                    <span class="tst-item-acts">
                      <button class="tst-ib" (click)="editItem(it)" [title]="'Edit' | t">{{ 'Edit' | t }}</button>
                      <button class="tst-ib tst-del" (click)="dropItem(p, it)" [title]="'Delete' | t" [attr.aria-label]="'Delete' | t">×</button>
                    </span>
                  }
                </div>
              }
            </div>
          }
        </div>
        <p class="st-hint">{{ 'Drag an item, or Alt+↑ / Alt+↓ on it, to change its place; drop it on another column to change its domain. Double-click to edit.' | t }}</p>
      } @else {
        <p class="st-hint">{{ 'No items yet: write the first statement above, or extract them from a finished project.' | t }}</p>
      }
    } @else {
      <!-- HOME: every palette and run in figures, the folders to start from -->
      <header class="tst-head tsh-head">
        <div class="tst-title">
          <h2>{{ 'Taste' | t }}</h2>
          <span class="st-sub">{{ 'What makes a design good, as statements every agent follows: MUST always, PREFER unless the note says otherwise, AVOID never.' | t }}</span>
        </div>
      </header>

      @let o = overall();
      @let js = jobStats();
      <div class="st-tiles tsh-tiles">
        <div class="st-tile" [attr.data-tone]="o.palettes ? null : 'dim'"><span>{{ 'Palettes' | t }}</span><b>{{ o.palettes }}</b>
          <small>{{ fmt('{n} pinned', { n: o.pinned }) }}</small></div>
        <div class="st-tile" [attr.data-tone]="o.items ? null : 'dim'"><span>{{ 'Items' | t }}</span><b>{{ o.items }}</b>
          <small [title]="fmt('{n} by hand · {m} extracted', { n: o.manual, m: o.items - o.manual })">{{ fmt('{n} extracted', { n: o.items - o.manual }) }}</small></div>
        @for (s of strengths; track s.id) {
          <div class="st-tile tsh-str" [attr.data-s]="s.id" [attr.data-tone]="o.str[s.id] ? null : 'dim'"><span>{{ s.label | t }}</span><b>{{ o.str[s.id] }}</b>
            <small>{{ fmt('{p}% of the items', { p: pct(o.str[s.id], o.items) }) }}</small></div>
        }
        <div class="st-tile" [attr.data-tone]="o.attached ? null : 'dim'"><span>{{ 'Attached projects' | t }}</span><b>{{ o.attached }}</b>
          <small>{{ fmt('on {n} of {m} palettes', { n: o.attachedPal, m: o.palettes }) }}</small></div>
        <div class="st-tile" [attr.data-tone]="js.total ? null : 'dim'"><span>{{ 'Extractions' | t }}</span><b>{{ js.total }}</b>
          <small>{{ fmt('{n} done · {f} failed', { n: js.done, f: js.failed }) }}</small></div>
        <div class="st-tile" [attr.data-tone]="js.last ? statusTone(js.last.status) : 'dim'"><span>{{ 'Last extraction' | t }}</span>
          <b>{{ js.last ? when(js.last.started_at) : '–' }}</b>
          <small [title]="js.last ? js.last.project.label : ''">{{ js.last ? (statusName(js.last.status) | t) + ' · ' + js.last.project.label : ('none yet' | t) }}</small></div>
      </div>

      @if (!o.palettes) { <ng-container [ngTemplateOutlet]="howCard" /> }

      <div class="tsh-grid">
        <section class="st-card tsh-domains">
          <div class="st-card-head"><h3>{{ 'Items by domain' | t }}</h3>
            <span class="st-sub">{{ fmt('{n} items in {m} palettes', { n: o.items, m: o.palettes }) }}</span>
            <span class="st-right tsh-legend">
              @for (s of strengths; track s.id) { <span><i class="tsh-dot" [style.background]="sc(s.id)"></i>{{ s.label | t }}</span> }
            </span></div>
          <div class="st-card-body">
            @for (r of domainRows(); track r.id) {
              <div class="tsh-drow" [attr.data-all]="r.id === 'all' ? 1 : null">
                <span class="tsh-dname">@if (r.id !== 'all') { <i class="tsh-dot" [style.background]="dc(r.id)"></i> }{{ r.label | t }}</span>
                <span class="tsh-dtrack">
                  <span class="tsh-dfill" [style.width.%]="r.w">
                    @for (s of strengths; track s.id) { @if (r.s[s.id]) { <i [style.flex-grow]="r.s[s.id]" [style.background]="sc(s.id)" [title]="(s.label | t) + ': ' + r.s[s.id]"></i> } }
                  </span>
                </span>
                <span class="tsh-dfig"><b>{{ r.total }}</b>
                  <span>{{ r.s.must }}</span><span>{{ r.s.prefer }}</span><span>{{ r.s.avoid }}</span></span>
              </div>
            }
            <p class="st-hint">{{ 'Each bar is a domain across every palette, split MUST, PREFER, AVOID; then its total and the same three figures.' | t }}</p>
          </div>
        </section>

        <section class="st-card tsh-folders">
          <div class="st-card-head"><h3>{{ 'Start from a folder' | t }}</h3>
            <span class="st-sub">{{ 'a model reads every model, board and firmware in it' | t }}</span>
            @if (folders().length > 7) {
              <span class="st-right"><button class="st-more" (click)="allFolders.set(!allFolders())">
                {{ allFolders() ? ('Show fewer' | t) : fmt('Show all {n}', { n: folders().length }) }}</button></span>
            }</div>
          <div class="st-table-wrap">
            <table class="st-table tsh-ftable">
              <thead><tr><th>{{ 'Folder' | t }}</th><th>{{ 'Holds' | t }}</th><th>{{ 'Last run' | t }}</th><th></th></tr></thead>
              <tbody>
                @for (f of shownFolders(); track f.id) {
                  <tr>
                    <td class="give" [title]="f.id">@if (f.parent) { <span class="dim">{{ f.parent }}/</span> }{{ f.name }}</td>
                    <td class="dim">{{ f.holds }}</td>
                    <td>@if (f.last; as l) { <span class="st-tag" [attr.data-tone]="statusTone(l.status)">{{ statusName(l.status) | t }}</span>
                          <span class="dim"> {{ when(l.started_at) }}</span> } @else { <span class="dim">{{ 'never run' | t }}</span> }</td>
                    <td class="r">
                      @if (f.last && f.last.status === 'done') { <button class="st-more" (click)="showJob(f.last.id)">{{ 'Open' | t }}</button> }
                      @if (can()) {
                        <button class="tcv-btn tsh-go" (click)="extractFolder(f.ref)" [disabled]="starting() || runs.running() > 0"
                                [title]="runs.running() ? ('A run is going; one at a time.' | t) : fmt('Extract taste from {p}', { p: f.id })">{{ 'Extract' | t }}</button>
                      }
                    </td>
                  </tr>
                } @empty {
                  <tr><td colspan="4" class="dim">{{ 'No folder holds a model or a board yet.' | t }}</td></tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      </div>

      @if (!o.palettes && can()) {
        <section class="st-card tsh-first">
          <div class="st-card-head"><h3>{{ 'Write the first palette by hand' | t }}</h3>
            <span class="st-sub">{{ 'or start from the examples, one click each' | t }}</span></div>
          <div class="st-card-body">
            <div class="tst-add tsh-first-row">
              <input class="tst-in" [placeholder]="'Palette name' | t" [value]="firstName()" (input)="firstName.set($any($event.target).value)"
                     [attr.aria-label]="'Palette name' | t">
              <select class="tst-sel" [value]="addStrength()" (change)="addStrength.set($any($event.target).value)" [attr.aria-label]="'Strength' | t">
                @for (s of strengths; track s.id) { <option [value]="s.id" [selected]="s.id === addStrength()">{{ s.label | t }}</option> }</select>
              <select class="tst-sel" [value]="addDomain()" (change)="addDomain.set($any($event.target).value)" [attr.aria-label]="'Domain' | t">
                @for (d of domains; track d.id) { <option [value]="d.id" [selected]="d.id === addDomain()">{{ d.label | t }}</option> }</select>
              <input class="tst-in" [placeholder]="'One statement, checkable: Walls 2 mm, outside edges filleted 1 mm' | t"
                     [value]="addText()" (input)="addText.set($any($event.target).value)" (keydown.enter)="createFirst()">
              <button class="tcv-btn tcv-btn-accent" (click)="createFirst()" [disabled]="!addText().trim()">{{ 'Create the palette' | t }}</button>
            </div>
            <div class="tsh-examples">
              @for (d of examples; track d.domain) {
                <div class="tsh-ex">
                  <span class="tsh-ex-head"><i class="tsh-dot" [style.background]="dc(d.domain)"></i>{{ domainLabel(d.domain) | t }}</span>
                  @for (e of d.items; track e.text) {
                    <button class="tsh-ex-item" (click)="useExample(d.domain, e.strength, e.text)">
                      <span class="tst-str" [attr.data-s]="e.strength">{{ strengthLabel(e.strength) | t }}</span><span>{{ e.text | t }}</span></button>
                  }
                </div>
              }
            </div>
          </div>
        </section>
      }

      @if (o.palettes) {
        <section class="st-card">
          <div class="st-card-head"><h3>{{ 'Palettes' | t }}</h3>
            <span class="st-sub">{{ 'open one to edit its items, attach it or extract into it' | t }}</span></div>
          <div class="st-table-wrap">
            <table class="st-table tsh-ptable">
              <thead><tr>
                <th>{{ 'Palette' | t }}</th>
                @for (d of domains; track d.id) { <th class="tsh-dcol"><i class="tsh-dot" [style.background]="dc(d.id)"></i>{{ d.short | t }}</th> }
                <th>{{ 'Strength' | t }}</th><th>{{ 'Attached to' | t }}</th><th class="r">{{ 'Updated' | t }}</th>
              </tr></thead>
              <tbody>
                @for (r of palRows(); track r.p.id) {
                  <tr (click)="openPalette(r.p.id)">
                    <td class="give">@if (r.p.pinned) { <span class="tcv-notes-pin" [title]="'Pinned' | t">●</span> }
                      <b class="tsh-pname">{{ r.p.name }}</b>
                      <span class="dim"> {{ r.p.items.length }} {{ (r.p.items.length === 1 ? 'item' : 'items') | t }}</span>
                      @if (r.p.description) { <span class="dim"> · {{ r.p.description }}</span> }</td>
                    @for (d of r.d; track d.id) {
                      <td class="tsh-dcol"><span class="tsh-mini"><i [style.width.%]="d.w" [style.background]="dc(d.id)"></i></span>
                        <span class="mono" [class.dim]="!d.n">{{ d.n }}</span></td>
                    }
                    <td class="tsh-scol"><span class="tsh-stack tsh-stack-s">
                        @for (s of strengths; track s.id) { @if (r.s[s.id]) { <i [style.flex-grow]="r.s[s.id]" [style.background]="sc(s.id)"></i> } }</span>
                      <span class="mono dim">{{ r.s.must }}·{{ r.s.prefer }}·{{ r.s.avoid }}</span></td>
                    <td class="give-s">
                      @for (a of r.p.attached.slice(0, 2); track a.kind + a.id) { <span class="st-tag tsh-tag" [title]="(kindName(a.kind) | t) + ': ' + a.label">{{ a.label }}</span> }
                      @if (r.p.attached.length > 2) { <span class="dim"> +{{ r.p.attached.length - 2 }}</span> }
                      @if (!r.p.attached.length) { <span class="dim">–</span> }</td>
                    <td class="r">{{ when(r.p.updated_at) }} <span class="dim">· {{ r.p.by.name || ('someone' | t) }}</span></td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      }

      @if (recent().length) { <ng-container [ngTemplateOutlet]="recentCard" [ngTemplateOutletContext]="{ rows: recent().slice(0, 8) }" /> }

      @if (o.palettes) { <ng-container [ngTemplateOutlet]="howCard" /> }
    }
  </section>
</div>

<ng-template #recentCard let-rows="rows">
  <section class="st-card tsx-recent">
    <div class="st-card-head"><h3>{{ 'Recent extractions' | t }}</h3>
      <span class="st-sub">{{ 'open one to see its steps, or to review and save its proposals' | t }}</span></div>
    <div class="st-table-wrap">
      <table class="st-table tsx-table">
        <thead><tr>
          <th>{{ 'Project' | t }}</th><th>{{ 'Started' | t }}</th><th>{{ 'Status' | t }}</th>
          <th class="r">{{ 'Took' | t }}</th><th class="r">{{ 'Proposals' | t }}</th><th>{{ 'Saved to' | t }}</th><th></th>
        </tr></thead>
        <tbody>
          @for (r of rows; track r.id) {
            <tr [attr.data-on]="mode() === 'extract' && r.id === job()?.id ? 1 : null" (click)="showJob(r.id)">
              <td class="give"><span class="dim">{{ kindName(r.project.kind) | t }}</span> {{ r.project.label }}</td>
              <td>{{ when(r.started_at) }} <span class="dim">· {{ r.by.name || ('someone' | t) }}</span></td>
              <td><span class="st-tag" [attr.data-tone]="statusTone(r.status)">{{ statusName(r.status) | t }}</span></td>
              <td class="r mono">{{ dur(r.seconds) }}</td>
              <td class="r mono">{{ r.status === 'done' ? r.count : '–' }}</td>
              <td class="give-s">{{ r.saved_to?.name || '–' }}</td>
              <td class="r"><button class="st-more" (click)="showJob(r.id); $event.stopPropagation()">{{ 'Open' | t }}</button></td>
            </tr>
          }
        </tbody>
      </table>
    </div>
  </section>
</ng-template>

<ng-template #howCard>
  <section class="st-card tsh-how">
    <div class="st-card-head"><h3>{{ 'How taste works' | t }}</h3></div>
    <ol class="tsh-steps">
      <li><span class="tsh-n">1</span><div><b>{{ 'Extract from a project or folder' | t }}</b>
        <p>{{ 'A model reads a finished model, board, firmware or a whole folder - source, checks and drawn notes - and proposes statements.' | t }}</p></div></li>
      <li><span class="tsh-n">2</span><div><b>{{ 'Review and save to a palette' | t }}</b>
        <p>{{ 'Accept, edit or reject each proposal; only what you accept is kept. Statements can also be written by hand.' | t }}</p></div></li>
      <li><span class="tsh-n">3</span><div><b>{{ 'Attach it, or @-mention it in Chat' | t }}</b>
        <p>{{ 'Every agent on an attached project gets it:' | t }}
          <span class="tst-str" data-s="must">{{ 'MUST' | t }}</span> {{ 'always' | t }},
          <span class="tst-str" data-s="prefer">{{ 'PREFER' | t }}</span> {{ 'unless the note says otherwise' | t }},
          <span class="tst-str" data-s="avoid">{{ 'AVOID' | t }}</span> {{ 'never.' | t }}</p></div></li>
    </ol>
  </section>
</ng-template>`,
})
export class RoomTaste implements OnDestroy {
  private api = inject(TasteApi);
  readonly runs = inject(TasteRuns);
  private picked = inject(Selection);
  private auth = inject(Auth);
  private search = viewChild.required<ElementRef<HTMLInputElement>>('search');
  private addBox = viewChild<ElementRef<HTMLInputElement>>('addBox');
  private pickq = viewChild<ElementRef<HTMLInputElement>>('pickq');

  readonly domains = DOMAINS;
  readonly strengths = STRENGTHS;
  q = signal('');
  palettes = signal<Palette[]>([]);
  /** Every palette, whatever the search: the "Save to" list. */
  allPalettes = signal<Palette[]>([]);
  openId = signal<string | null>(null);
  mode = signal<'palette' | 'extract'>('palette');
  flash = signal<string | null>(null);

  addText = signal('');
  addWhy = signal('');
  addDomain = signal<Domain>('mechanical');
  addStrength = signal<Strength>('must');

  editId = signal<string | null>(null);
  draft = signal<{ text: string; domain: Domain; strength: Strength; why?: string }>({ text: '', domain: 'general', strength: 'prefer' });
  dragId = signal<string | null>(null);

  picker = signal<'attach' | 'extract' | null>(null);
  pickQ = signal('');
  pickIdx = signal(0);
  projects = signal<ProjectRef[]>([]);

  exProject = signal<ProjectRef | null>(null);
  exError = signal<string | null>(null);
  /** The run open here, as the server last said (with its proposals). */
  job = signal<TasteJob | null>(null);
  starting = signal(false);
  cancelling = signal(false);
  private tick = signal(Date.now());
  /** The server's clock minus this one, so a running step is timed right. */
  private offset = 0;
  private propsOf: string | null = null;
  private jobTimer?: ReturnType<typeof setTimeout>;
  private ticker?: ReturnType<typeof setInterval>;
  exModel = signal('');
  proposals = signal<Proposal[]>([]);
  saveTo = signal('');
  newName = signal('');
  saving = signal(false);

  private timer?: ReturnType<typeof setTimeout>;
  private pickTimer?: ReturnType<typeof setTimeout>;
  private poll = setInterval(() => { if (!this.editId()) this.read(); }, 20_000);

  can = computed(() => this.auth.can('draw'));
  open = computed(() => this.palettes().find(p => p.id === this.openId()) ?? this.allPalettes().find(p => p.id === this.openId()) ?? null);
  /** Only the domains that have items, so no column stands empty. */
  cols = computed(() => this.columns(this.open()?.items ?? []));
  propCols = computed(() => this.columns(this.proposals()).map(c => ({ ...c, kept: (c.items as Proposal[]).filter(i => i.keep).length })) as
    { id: Domain; label: string; items: Proposal[]; kept: number }[]);
  keptCount = computed(() => this.proposals().filter(p => p.keep).length);
  exFrom = computed(() => {
    const p = this.exProject();
    return p ? `${p.label}${this.exModel() ? ' · ' + this.exModel() : ''}` : '';
  });

  constructor() {
    // A run is in the address (?run=), so a reload comes back to it; with
    // none, a run still going in this workspace is shown by itself.
    this.runs.here = true;
    this.runs.seen();
    const asked = new URLSearchParams(location.search).get('run');
    this.readFolders();
    this.runs.refresh().then(rows => {
      if (asked) { this.showJob(asked); return; }
      const going = rows.find(isActive);
      if (going && !this.job()) this.showJob(going.id);
    });
    effect(() => {
      const id = this.mode() === 'extract' ? this.job()?.id ?? null : null;
      const url = new URL(location.href);
      if (id) url.searchParams.set('run', id); else url.searchParams.delete('run');
      if (url.href !== location.href) history.replaceState(null, '', url);
    });
    effect(() => {
      this.q(); this.api.changed();
      clearTimeout(this.timer);
      this.timer = setTimeout(() => untracked(() => this.read()), 150);
    });
    // Asked from the command palette: a palette, or the extraction.
    effect(() => {
      const w = this.picked.want();
      if (!w || (w.what !== 'taste' && w.what !== 'taste-extract')) return;
      untracked(() => {
        this.picked.want.set(null);
        if (w.what === 'taste' && w.arg) { this.q.set(''); this.openPalette(w.arg); } else this.startExtract();
      });
    });
    // The palette open here, for the command palette's "Ask Chat with this palette".
    effect(() => {
      const p = this.mode() === 'palette' ? this.open() : null;
      untracked(() => this.picked.taste.set(p ? { id: p.id, label: p.name } : null));
    });
  }

  private read() {
    this.api.list(this.q()).subscribe(ps => this.palettes.set(ps));
    this.api.list('').subscribe(ps => this.allPalettes.set(ps));
  }

  private columns<I extends TasteItem>(items: I[]) {
    return DOMAINS.map(d => ({ id: d.id, label: d.label, items: items.filter(i => i.domain === d.id) }))
      .filter(c => c.items.length);
  }

  private replace(p: Palette) {
    const put = (l: Palette[]) => l.some(x => x.id === p.id) ? l.map(x => x.id === p.id ? p : x) : [p, ...l];
    this.palettes.update(put);
    this.allPalettes.update(put);
  }

  private say(msg: string) { this.flash.set(msg); setTimeout(() => this.flash.set(null), 4000); }
  private failed = (fallback: string) => (e: HttpErrorResponse) => this.say(why(e, fallback));

  when = when;
  /** A sentence with {holes}, translated first and filled after. */
  fmt(text: string, vars: Record<string, string | number>) {
    return t(text).replace(/\{(\w+)\}/g, (m, k) => k in vars ? String(vars[k]) : m);
  }
  kindName(k: string) { return KIND_NAME[k] ?? k; }
  strengthLabel(s: Strength) { return STRENGTHS.find(x => x.id === s)?.label ?? s; }
  attachedLine(p: Palette) { return p.attached.map(a => a.label).join(', '); }
  isAttached(p: Palette, r: ProjectRef) { return p.attached.some(a => a.kind === r.kind && a.id === r.id); }

  openPalette(id: string) { this.mode.set('palette'); this.editId.set(null); this.openId.set(id); }
  /** The overview: no palette open. */
  goHome() { this.leaveExtract(); this.editId.set(null); this.openId.set(null); }

  // ---- the overview (home): every palette and run in figures

  folders = signal<ProjectRef[]>([]);
  allFolders = signal(false);
  home = computed(() => this.mode() === 'palette' && !this.open());
  dc(d: Domain | string) { return DOMAIN_COLOR[d as Domain] ?? 'var(--ink-dim)'; }
  sc(s: Strength) { return STRENGTH_COLOR[s]; }
  pct(n: number, of: number) { return of ? Math.round(n / of * 100) : 0; }
  countOf(items: TasteItem[], s: Strength) { return items.filter(i => i.strength === s).length; }

  overall = computed(() => {
    const ps = this.allPalettes(), items = ps.flatMap(p => p.items);
    const att = new Set(ps.flatMap(p => p.attached.map(a => a.kind + ':' + a.id)));
    const str = tally(items);
    return {
      palettes: ps.length, items: items.length, pinned: ps.filter(p => p.pinned).length,
      manual: items.filter(i => i.source === 'manual').length, str,
      attached: att.size, attachedPal: ps.filter(p => p.attached.length).length,
      bySeg: DOMAINS.map(d => ({ id: d.id, n: items.filter(i => i.domain === d.id).length, c: DOMAIN_COLOR[d.id] })).filter(x => x.n),
    };
  });
  jobStats = computed(() => {
    const js = this.runs.jobs();
    return { total: js.length, done: js.filter(j => j.status === 'done').length, failed: js.filter(j => j.status === 'failed').length,
             last: (js[0] as TasteJob | undefined) ?? null };
  });
  /** One row per domain, and one for all: a bar as long as its share of the
   *  biggest, split by strength. */
  domainRows = computed(() => {
    const items = this.allPalettes().flatMap(p => p.items);
    const rows = DOMAINS.map(d => { const its = items.filter(i => i.domain === d.id); return { id: d.id as string, label: d.label, total: its.length, s: tally(its), w: 0 }; });
    const max = Math.max(1, ...rows.map(r => r.total));
    rows.forEach(r => r.w = r.total / max * 100);
    return [...rows, { id: 'all', label: 'All domains', total: items.length, s: tally(items), w: items.length ? 100 : 0 }];
  });
  palRows = computed(() => {
    const ps = this.allPalettes();
    const max = Object.fromEntries(DOMAINS.map(d => [d.id, Math.max(1, ...ps.map(p => p.counts[d.id] ?? 0))])) as Record<Domain, number>;
    return ps.map(p => ({ p, s: tally(p.items),
      d: DOMAINS.map(d => ({ id: d.id, n: p.counts[d.id] ?? 0, w: (p.counts[d.id] ?? 0) / max[d.id] * 100 })) }));
  });
  /** The workspace's folders, each with what it holds and its last run. */
  private folderRows = computed(() => {
    const js = this.runs.jobs();
    return this.folders().map(f => {
      const cut = f.id.lastIndexOf('/');
      return { id: f.id, ref: f, parent: cut > 0 ? f.id.slice(0, cut) : '', name: cut > 0 ? f.id.slice(cut + 1) : f.id,
               holds: this.holds(f.sub ?? ''), last: js.find(j => j.project.kind === 'folder' && j.project.id === f.id) ?? null };
    });
  });
  shownFolders = computed(() => this.allFolders() ? this.folderRows() : this.folderRows().slice(0, 7));
  /** "16 models · 1 board", as the server writes it, in the page's language. */
  holds(sub: string) {
    return sub.replace(/(\d+) (models?|boards?)/g, (_m, n, w) => this.fmt(`{n} ${w}`, { n }));
  }
  private readFolders() {
    this.api.projects('', true).subscribe({ next: rows => this.folders.set(rows.filter(r => r.kind === 'folder')), error: () => {} });
  }
  /** One click: a run over the whole folder, followed in the dashboard. */
  extractFolder(f: ProjectRef) {
    if (!this.can() || this.starting() || this.runs.running()) return;
    this.stopFollowing();
    this.job.set(null);
    this.proposals.set([]);
    this.exProject.set(f);
    this.mode.set('extract');
    this.editId.set(null);
    this.runExtract();
  }
  /** The first palette, written on the overview: a name and its first statement. */
  firstName = signal('');
  readonly examples: { domain: Domain; items: { strength: Strength; text: string }[] }[] = [
    { domain: 'mechanical', items: [{ strength: 'must', text: 'Walls 2 mm, outside edges filleted 1 mm' },
      { strength: 'prefer', text: '0.3 mm clearance on press fits, 0.2 mm on sliding fits' }, { strength: 'avoid', text: 'Overhangs over 45° without support' }] },
    { domain: 'pcb', items: [{ strength: 'must', text: 'Decoupling caps within 2 mm of each supply pin' },
      { strength: 'prefer', text: 'Ground pour on both layers, stitched every 5 mm' }, { strength: 'avoid', text: 'Vias in pads' }] },
    { domain: 'firmware', items: [{ strength: 'must', text: 'Every task feeds the watchdog' },
      { strength: 'prefer', text: 'Settings kept in NVS, written only when they change' }, { strength: 'avoid', text: 'Blocking delay() in loop()' }] },
    { domain: 'general', items: [{ strength: 'must', text: 'Every part named as it is in the BOM' },
      { strength: 'prefer', text: 'One status LED visible from outside the case' }, { strength: 'avoid', text: 'Numbers in a source without a name' }] },
  ];
  domainLabel(d: Domain) { return DOMAINS.find(x => x.id === d)?.label ?? d; }
  useExample(d: Domain, s: Strength, text: string) { this.addDomain.set(d); this.addStrength.set(s); this.addText.set(t(text)); }
  createFirst() {
    const text = this.addText().trim();
    if (!text) return;
    const name = this.firstName().trim() || `${t('Palette')} ${this.allPalettes().length + 1}`;
    this.api.create(name, [{ text, domain: this.addDomain(), strength: this.addStrength() }]).subscribe({
      next: p => { this.replace(p); this.addText.set(''); this.firstName.set(''); this.openPalette(p.id); this.api.changed.update(v => v + 1); },
      error: this.failed('Could not make the palette.'),
    });
  }
  /** The open palette in figures. */
  openStats = computed(() => {
    const p = this.open();
    const items = p?.items ?? [];
    const src = new Map<string, string>();
    for (const i of items) if (i.source !== 'manual') src.set(i.source.kind + ':' + i.source.id, i.source.label);
    return { str: tally(items), manual: items.filter(i => i.source === 'manual').length,
             sources: [...src.values()], sourceLine: [...src.values()].join(', ') };
  });

  /** The palette as a .json file: its statements, nothing of this workspace. */
  exportPalette(p: Palette) {
    this.api.exportFile(p.id).subscribe({
      next: data => {
        const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = `${(p.name || 'palette').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'palette'}.taste.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      },
      error: this.failed('Could not export it.'),
    });
  }

  /** A palette file someone sent: read, sent to the server, opened. */
  importPalette(input: HTMLInputElement) {
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    f.text().then(text => {
      let data: unknown;
      try { data = JSON.parse(text); } catch { this.say(t('That file is not a palette.')); return; }
      this.api.importFile(data).subscribe({
        next: p => { this.replace(p); this.openPalette(p.id); this.api.changed.update(v => v + 1);
                     this.say(this.fmt('{p} imported: {n} items', { p: p.name, n: p.items.length })); },
        error: this.failed('Could not import it.'),
      });
    });
  }

  newPalette() {
    const n = this.allPalettes().length + 1;
    this.api.create(`${t('Palette')} ${n}`).subscribe({
      next: p => { this.replace(p); this.openPalette(p.id); this.api.changed.update(v => v + 1);
                   setTimeout(() => (document.querySelector('.tst-name') as HTMLInputElement | null)?.select()); },
      error: this.failed('Could not make the palette.'),
    });
  }

  rename(p: Palette, name: string) {
    name = name.trim();
    if (!name || name === p.name) return;
    this.api.patch(p.id, { name }).subscribe({ next: r => this.replace(r), error: this.failed('Could not rename it.') });
  }
  describe(p: Palette, description: string) {
    if (description.trim() === p.description) return;
    this.api.patch(p.id, { description: description.trim() }).subscribe({ next: r => this.replace(r), error: this.failed('Could not save it.') });
  }
  pin(p: Palette) { this.api.patch(p.id, { pinned: !p.pinned }).subscribe({ next: () => this.read(), error: this.failed('Could not save it.') }); }

  remove(p: Palette) {
    if (!confirm(t('Delete this palette and its items?') + `\n\n${p.name}`)) return;
    this.api.remove(p.id).subscribe({
      next: () => { this.openId.set(null); this.read(); },
      error: this.failed('Could not delete it.'),
    });
  }

  // ---- items

  addItem(p: Palette) {
    const text = this.addText().trim();
    if (!text) return;
    this.api.add(p.id, [{ text, domain: this.addDomain(), strength: this.addStrength(), why: this.addWhy().trim() }]).subscribe({
      next: r => { this.replace(r); this.addText.set(''); this.addWhy.set(''); this.addBox()?.nativeElement.focus(); },
      error: this.failed('Could not add it.'),
    });
  }

  editItem(it: TasteItem) {
    this.draft.set({ text: it.text, domain: it.domain, strength: it.strength, why: it.why ?? '' });
    this.editId.set(it.id);
    setTimeout(() => (document.querySelector('.tst-edit') as HTMLTextAreaElement | null)?.focus());
  }
  setDraft(k: 'text' | 'domain' | 'strength' | 'why', v: string) { this.draft.update(d => ({ ...d, [k]: v })); }

  saveItem(p: Palette, it: TasteItem) {
    const d = this.draft();
    if (!d.text.trim()) return;
    this.api.edit(p.id, it.id, { text: d.text.trim(), domain: d.domain, strength: d.strength, why: (d.why ?? '').trim() }).subscribe({
      next: r => { this.replace(r); this.editId.set(null); },
      error: this.failed('Could not save it.'),
    });
  }

  dropItem(p: Palette, it: TasteItem) {
    this.api.drop(p.id, it.id).subscribe({ next: r => this.replace(r), error: this.failed('Could not delete it.') });
  }

  /** Alt+↑ / Alt+↓: one place up or down in its column. */
  itemKey(e: KeyboardEvent, p: Palette, it: TasteItem) {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' && this.can()) { e.preventDefault(); this.editItem(it); return; }
    if ((e.key === 'Delete') && this.can()) { e.preventDefault(); this.dropItem(p, it); return; }
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || !this.can()) return;
    e.preventDefault();
    const all = [...p.items];
    const same = all.filter(x => x.domain === it.domain);
    const k = same.findIndex(x => x.id === it.id);
    const other = same[k + (e.key === 'ArrowUp' ? -1 : 1)];
    if (!other) return;
    const a = all.findIndex(x => x.id === it.id), b = all.findIndex(x => x.id === other.id);
    [all[a], all[b]] = [all[b], all[a]];
    this.reorder(p, all, it.id);
  }

  private reorder(p: Palette, items: TasteItem[], focus?: string) {
    this.replace({ ...p, items });
    this.api.order(p.id, items.map(i => i.id)).subscribe({
      next: r => {
        this.replace(r);
        if (focus) setTimeout(() => (document.querySelector(`.tst-item[data-id="${focus}"]`) as HTMLElement | null)?.focus());
      },
      error: this.failed('Could not move it.'),
    });
    if (focus) setTimeout(() => (document.querySelector(`.tst-item[data-id="${focus}"]`) as HTMLElement | null)?.focus());
  }

  dragStart(e: DragEvent, it: TasteItem) {
    this.dragId.set(it.id);
    e.dataTransfer?.setData('text/plain', it.id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  }
  dragOver(e: DragEvent) { if (this.dragId()) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; } }

  /** Dropped before `target`, or at the end of the column: in its place,
   *  and in the column's domain. */
  dropOn(e: DragEvent, p: Palette, domain: Domain, target: TasteItem | null) {
    const id = this.dragId();
    this.dragId.set(null);
    if (!id || id === target?.id) return;
    e.preventDefault();
    const moving = p.items.find(i => i.id === id);
    if (!moving) return;
    const rest = p.items.filter(i => i.id !== id);
    let at = target ? rest.findIndex(i => i.id === target.id) : -1;
    if (at < 0) {
      const lastOfCol = rest.map(i => i.domain).lastIndexOf(domain);
      at = lastOfCol < 0 ? rest.length : lastOfCol + 1;
    }
    const moved = { ...moving, domain };
    rest.splice(at, 0, moved);
    const ids = rest.map(i => i.id);
    this.replace({ ...p, items: rest });
    const order = () => this.api.order(p.id, ids).subscribe({ next: r => this.replace(r), error: this.failed('Could not move it.') });
    if (moving.domain !== domain) {
      this.api.edit(p.id, id, { domain }).subscribe({ next: () => order(), error: this.failed('Could not move it.') });
    } else order();
  }

  // ---- the project picker

  openPicker(which: 'attach' | 'extract') {
    if (this.picker() === which) { this.picker.set(null); return; }
    this.picker.set(which);
    this.pickIdx.set(0);
    this.findProjects(this.pickQ());
    setTimeout(() => this.pickq()?.nativeElement.focus());
  }
  closePicker() { this.picker.set(null); }

  findProjects(q: string) {
    this.pickQ.set(q);
    clearTimeout(this.pickTimer);
    this.pickTimer = setTimeout(() => this.api.projects(q, this.picker() === 'extract').subscribe({
      next: rows => { this.projects.set(rows); this.pickIdx.set(0); },
      error: this.failed('Could not list the projects.'),
    }), 120);
  }

  pickKey(e: KeyboardEvent) {
    const n = this.projects().length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (n) this.pickIdx.update(i => (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = this.projects()[this.pickIdx()];
      if (r) this.pickProject(r);
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      this.picker.set(null);
    }
  }

  pickProject(r: ProjectRef) {
    if (this.picker() === 'extract') {
      this.exProject.set(r);
      this.picker.set(null);
      return;
    }
    const p = this.open();
    if (!p) return;
    const next = this.isAttached(p, r) ? p.attached.filter(a => !(a.kind === r.kind && a.id === r.id)) : [...p.attached, r];
    this.api.attach(p.id, next.map(a => ({ kind: a.kind, id: a.id }))).subscribe({
      next: x => this.replace(x), error: this.failed('Could not attach it.'),
    });
  }

  detach(p: Palette, a: ProjectRef) {
    this.api.attach(p.id, p.attached.filter(x => x !== a).map(x => ({ kind: x.kind, id: x.id }))).subscribe({
      next: x => this.replace(x), error: this.failed('Could not detach it.'),
    });
  }

  // ---- extraction: a run in the server, followed here

  startExtract() {
    this.mode.set('extract');
    this.editId.set(null);
    const p = this.open();
    if (!this.job() && !this.exProject() && p?.attached.length) this.exProject.set(p.attached[0]);
    if (p) this.saveTo.set(p.id);
    if (!this.job() && !this.exProject()) setTimeout(() => this.openPicker('extract'));
    this.runs.refresh();
  }
  leaveExtract() { this.mode.set('palette'); this.picker.set(null); this.stopFollowing(); }

  runExtract() {
    const pr = this.exProject() ?? this.job()?.project;
    if (!pr || this.starting() || this.running()) return;
    this.starting.set(true);
    this.exError.set(null);
    this.api.extract(pr.kind, pr.id).subscribe({
      next: j => { this.starting.set(false); this.take(j); this.runs.put(j); },
      error: (e: HttpErrorResponse) => { this.starting.set(false); this.exError.set(why(e, 'The extraction could not start.')); },
    });
  }

  cancelRun() {
    const j = this.job();
    if (!j || this.cancelling()) return;
    this.cancelling.set(true);
    this.api.cancelJob(j.id).subscribe({
      next: r => { this.cancelling.set(false); this.take(r); this.runs.put(r); },
      error: (e: HttpErrorResponse) => { this.cancelling.set(false); this.exError.set(why(e, 'Could not cancel it.')); },
    });
  }

  /** Open a run - running, failed or done - and follow it while it goes. */
  showJob(id: string) {
    this.mode.set('extract');
    this.editId.set(null);
    this.picker.set(null);
    this.exError.set(null);
    this.api.job(id).subscribe({
      next: j => this.take(j),
      error: (e: HttpErrorResponse) => {
        this.job.set(null);
        this.exError.set(why(e, 'Could not open that run.'));
      },
    });
  }

  private take(j: TasteJob) {
    const fresh = this.job()?.id !== j.id;
    this.offset = Date.parse(j.now) - Date.now();
    this.job.set(j);
    this.exProject.set(j.project);
    this.exModel.set(j.model ?? '');
    if (j.status === 'done' && (fresh || !this.proposals().length || this.propsOf !== j.id)) {
      this.propsOf = j.id;
      this.proposals.set((j.proposals ?? []).map(i => ({ ...i, keep: true })));
      if (!this.saveTo() && !this.newName()) this.newName.set(this.fmt('Taste of {p}', { p: j.project.label }));
    } else if (j.status !== 'done' && fresh) {
      this.propsOf = null;
      this.proposals.set([]);
    }
    this.follow();
  }

  /** While the run goes: read it again every 1.5 s, and tick the clock. */
  private follow() {
    clearTimeout(this.jobTimer);
    clearInterval(this.ticker);
    const j = this.job();
    if (!isActive(j) || this.mode() !== 'extract') return;
    this.ticker = setInterval(() => this.tick.set(Date.now()), 500);
    this.jobTimer = setTimeout(() => this.api.job(j!.id).subscribe({
      next: r => {
        if (this.job()?.id !== r.id) return;
        const was = this.job()!.status;
        this.take(r);
        if (r.status !== was) this.runs.put(r);
      },
      error: () => this.follow(),
    }), 1500);
  }
  private stopFollowing() { clearTimeout(this.jobTimer); clearInterval(this.ticker); }

  running = computed(() => isActive(this.job()));
  elapsed = computed(() => {
    const j = this.job();
    if (!j) return null;
    if (!isActive(j)) return j.seconds;
    this.tick();
    return Math.max(0, (Date.now() + this.offset - Date.parse(j.started_at)) / 1000);
  });
  private readRows = computed(() => (this.job()?.steps ?? []).filter(s => s.kind === 'read'));
  readCount = computed(() => this.readRows().filter(s => s.state === 'done').length);
  skippedCount = computed(() => this.readRows().filter(s => s.state === 'skipped').length);
  charsRead = computed(() => this.readRows().reduce((n, s) => n + (s.chars ?? 0), 0));
  budgetPct = computed(() => {
    const b = this.job()?.totals.budget;
    return b ? Math.min(100, Math.round(this.charsRead() / b * 100)) : 0;
  });
  recent = computed(() => this.runs.jobs());
  doneSteps = computed(() => this.timeline().filter(r => r.state === 'done').length);
  /** Every project, the question, the answer and the result. */
  allSteps = computed(() => {
    const j = this.job();
    if (!j) return 0;
    const reads = j.steps.filter(s => s.kind === 'read').length;
    return Math.max(reads, j.totals.projects ?? reads) + (isActive(j) || j.status === 'done' ? 3 : j.steps.length - reads);
  });

  /** What the run is doing now, in a line under the clock. */
  nowLine = computed(() => {
    const j = this.job();
    if (!j) return '';
    if (j.finished_at) return this.fmt('finished {w}', { w: when(j.finished_at) });
    const cur = [...j.steps].reverse().find(s => s.state === 'running');
    if (!cur) return t('waiting to start');
    if (cur.kind === 'read') return this.fmt('reading {p}', { p: cur.project?.label ?? '' });
    if (cur.kind === 'ask') return this.fmt('waiting for {m}', { m: cur.model ?? '' });
    return t('reading the answer');
  });

  droppedLine = computed(() => {
    const p = this.job()?.steps.find(s => s.id === 'parse');
    if (!p || p.state === 'running') return '';
    const dropped = (p.duplicates ?? 0) + (p.invalid ?? 0) + (p.over ?? 0);
    return dropped ? this.fmt('{n} of {m} dropped', { n: dropped, m: p.rows ?? 0 }) : this.fmt('{n} rows in the answer', { n: p.rows ?? 0 });
  });

  /** The run line by line: each project read, the question, the answer,
   *  the proposals - and, while it goes, the steps still to come. */
  timeline = computed(() => {
    const j = this.job();
    if (!j) return [];
    this.tick();
    const rows: { id: string; state: StepState; kind: string; title: string; detail: string; reason?: string; fig: string; time: string }[] = [];
    const live = (s: JobStep) => s.state === 'running' && s.started_at
      ? this.dur(Math.max(0, (Date.now() + this.offset - Date.parse(s.started_at)) / 1000)) : this.dur(s.seconds ?? null);
    for (const s of j.steps) {
      if (s.kind === 'read') {
        const bits = [];
        if (s.clipped) bits.push(t('clipped to its share'));
        if (s.files != null) bits.push(this.fmt(s.files === 1 ? '{n} file' : '{n} files', { n: s.files }));
        if (s.revisions) bits.push(this.fmt(s.revisions === 1 ? '{n} drawn note' : '{n} drawn notes', { n: s.revisions }));
        if (s.notes) bits.push(this.fmt(s.notes === 1 ? '{n} note' : '{n} notes', { n: s.notes }));
        rows.push({ id: s.id, state: s.state, kind: this.kindName(s.project?.kind ?? ''), title: s.project?.label ?? '',
                    detail: bits.join(' · '), reason: s.reason, fig: s.state === 'done' ? this.fmt('{n} chars', { n: this.num(s.chars ?? 0) }) : '',
                    time: live(s) });
      } else if (s.kind === 'ask') {
        const bits = [this.fmt('{n} characters, ~{k} tokens sent', { n: this.num(s.prompt_chars ?? 0), k: this.num(s.tokens_est ?? 0) })];
        if (s.tokens_in != null) bits.push(this.fmt('{i} in / {o} out counted', { i: this.num(s.tokens_in), o: this.num(s.tokens_out ?? 0) }));
        else if (s.timeout) bits.push(this.fmt('gives up after {s} s', { s: s.timeout }));
        rows.push({ id: s.id, state: s.state, kind: 'Model', title: this.fmt('Asking {p} · {m}', { p: s.provider_name ?? s.provider ?? '', m: s.model ?? '' }),
                    detail: bits.join(' · '), reason: s.reason, fig: s.cost != null ? this.money(s.cost) : '', time: live(s) });
      } else if (s.kind === 'parse') {
        const bits = [this.fmt('{n} characters back', { n: this.num(s.raw_chars ?? 0) })];
        if (s.rows != null) bits.push(this.fmt('{n} rows', { n: s.rows }));
        if (s.duplicates) bits.push(this.fmt('{n} duplicates', { n: s.duplicates }));
        if (s.invalid) bits.push(this.fmt('{n} empty', { n: s.invalid }));
        if (s.over) bits.push(this.fmt('{n} over the limit', { n: s.over }));
        rows.push({ id: s.id, state: s.state, kind: 'Answer', title: t('Reading the answer'), detail: bits.join(' · '),
                    reason: s.reason, fig: s.parsed != null ? this.fmt('{n} kept', { n: s.parsed }) : '', time: live(s) });
      } else if (s.kind === 'done') {
        rows.push({ id: s.id, state: 'done', kind: 'Result', title: this.fmt('{n} proposals', { n: s.proposals ?? j.count }),
                    detail: t('to review below: accept, edit or reject each one'), fig: '', time: '' });
      }
    }
    if (isActive(j)) {
      const reads = j.steps.filter(s => s.kind === 'read').length;
      const left = (j.totals.projects ?? (reads ? 0 : 1)) - reads;
      const pend = (id: string, kind: string, title: string, detail = '') =>
        rows.push({ id, state: 'pending', kind, title, detail, fig: '', time: '' });
      if (left > 0) pend('p-read', 'Projects', this.fmt('{n} more to read', { n: left }));
      if (!j.steps.some(s => s.kind === 'ask')) pend('p-ask', 'Model', this.fmt('Asking {p} · {m}', { p: j.provider_name ?? '', m: j.model ?? '' }));
      if (!j.steps.some(s => s.kind === 'parse')) pend('p-parse', 'Answer', t('Reading the answer'));
      pend('p-done', 'Result', t('Proposals'));
    }
    return rows;
  });

  /** One bar per project read: how much of its share it took. */
  bars = computed(() => this.readRows().filter(s => s.state !== 'running').map(s => {
    const share = s.budget || 1, used = s.chars ?? 0;
    return {
      id: s.id, label: s.project?.label ?? s.id, pct: Math.min(100, Math.round(used / share * 100)),
      tone: s.state === 'skipped' ? 'dim' : s.clipped ? 'warn' : null,
      fig: s.state === 'skipped' ? t('skipped') : this.num(used),
      tip: `${s.project?.label ?? ''}: ${this.num(used)} / ${this.num(share)}`,
    };
  }));

  statusName(s: JobStatus) {
    return ({ queued: 'Queued', reading: 'Reading', asking: 'Asking', parsing: 'Parsing',
              done: 'Done', failed: 'Failed', cancelled: 'Cancelled' } as Record<JobStatus, string>)[s] ?? s;
  }
  statusTone(s: JobStatus) {
    return s === 'done' ? 'ok' : s === 'failed' ? 'danger' : s === 'cancelled' ? 'warn' : 'accent';
  }
  stateName(s: StepState) {
    return ({ running: 'running', done: 'done', skipped: 'skipped', failed: 'failed', cancelled: 'cancelled', pending: 'to come' } as Record<StepState, string>)[s] ?? s;
  }
  num(n: number) { return Math.round(n).toLocaleString(LANG() === 'tr' ? 'tr-TR' : 'en-US'); }
  round = Math.round;
  money(v: number | null | undefined) {
    if (v == null) return '–';
    return '$' + (v < 1 ? v.toFixed(4) : v.toFixed(2));
  }
  dur(s: number | null | undefined) {
    if (s == null) return '–';
    if (s < 10) return this.fmt('{s} s', { s: s.toFixed(1) });
    if (s < 60) return this.fmt('{s} s', { s: Math.floor(s) });
    return this.fmt('{m} min {s} s', { m: Math.floor(s / 60), s: String(Math.floor(s % 60)).padStart(2, '0') });
  }

  setKeep(it: Proposal, keep: boolean) { this.proposals.update(l => l.map(x => x.id === it.id ? { ...x, keep } : x)); }
  editProposal(it: Proposal) { this.editItem(it); }
  saveProposal(it: Proposal) {
    const d = this.draft();
    if (!d.text.trim()) return;
    this.proposals.update(l => l.map(x => x.id === it.id
      ? { ...x, text: d.text.trim(), domain: d.domain, strength: d.strength, why: (d.why ?? '').trim(), keep: true } : x));
    this.editId.set(null);
  }

  saveProposals() {
    const items: NewItem[] = this.proposals().filter(p => p.keep)
      .map(({ text, domain, strength, why: w, source }) => ({ text, domain, strength, why: w, source }));
    if (!items.length) return;
    this.saving.set(true);
    const to = this.saveTo();
    const jid = this.job()?.id;
    const req = to ? this.api.add(to, items) : this.api.create(this.newName().trim(), items);
    req.subscribe({
      next: p => {
        this.saving.set(false);
        this.replace(p);
        if (jid) this.api.savedTo(jid, { id: p.id, name: p.name, count: items.length }).subscribe({ next: j => this.runs.put(j), error: () => {} });
        this.say(this.fmt('{n} saved to {p}', { n: items.length, p: p.name }));
        this.api.changed.update(v => v + 1);
        this.leaveExtract();
        this.openPalette(p.id);
      },
      error: (e: HttpErrorResponse) => { this.saving.set(false); this.exError.set(why(e, 'Could not save them.')); },
    });
  }

  key(e: KeyboardEvent) {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName);
    if (e.key === '/' && !typing) { e.preventDefault(); this.search().nativeElement.focus(); return; }
    if (e.key === 'Escape' && this.picker()) { this.picker.set(null); return; }
    const onItem = (e.target as HTMLElement).classList?.contains('tst-item');
    if (!typing && !onItem && !e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && this.mode() === 'palette') {
      // the overview is the row above the first palette
      const list = this.palettes(), i = list.findIndex(p => p.id === this.openId());
      const k = Math.max(this.q() ? 0 : -1, Math.min(list.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
      e.preventDefault();
      if (k < 0) this.goHome(); else if (list[k]) this.openPalette(list[k].id);
    }
  }

  ngOnDestroy() {
    clearInterval(this.poll); clearTimeout(this.timer); clearTimeout(this.pickTimer); this.stopFollowing();
    this.runs.here = false;
  }
}
