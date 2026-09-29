import { Component, OnDestroy, computed, inject, input, output, signal } from '@angular/core';
import { HttpClient, HttpEventType } from '@angular/common/http';
import { Auth } from '../auth';
import { Selection } from '../selection';

/** What the server says about an import (backend/imports/api.py). */
interface ImportJob {
  id: string; status: 'running' | 'done' | 'failed'; stage: string; title: string;
  files: string[]; board: string | null; folder?: string; error?: string;
  elapsed: number; seconds?: number; size_mm?: [number, number] | null;
  log: { at: number; stage: string }[];
  summary?: {
    files: { file: string; kind: string; layer?: string; plugin?: string; note?: string; bytes: number }[];
    found: { key: string; what: string; from: string[]; note?: string }[];
    missing: { key: string; what: string; needs: string }[];
    notes: string[];
    source?: string | null;
  };
}

interface Folder { name: string; path: string; folders: Folder[] }

/** Import a board from what the person has: a fab zip of Gerbers and
 *  drills, EasyEDA's flying-probe netlist, a BOM, the assembled STEP, or a
 *  design file KiCad can open. Everything it can do it does; what it could
 *  not, it names with the file that would have given it. */
@Component({
  selector: 'app-import-board',
  template: `
<div class="tcv-tokens-back" (click)="close()">
  <div class="tcv-tokens imp" (click)="$event.stopPropagation()" role="dialog" aria-label="Import a board">
    <h2>Import a board</h2>

    @if (!job()) {
      <p>A fab zip (Gerbers + drills), EasyEDA Pro's FlyingProbeTesting.json, a BOM or pick-and-place CSV,
        the assembled board's STEP, or a design file - .kicad_pcb, EasyEDA .epro/.json, Altium .PcbDoc,
        Eagle .brd. Several at once is best: each one fills in what the others cannot.</p>

      <label class="imp-drop" [attr.data-over]="over() ? 1 : null"
             (dragover)="$event.preventDefault(); over.set(true)" (dragleave)="over.set(false)"
             (drop)="dropped($event)">
        <input type="file" multiple class="imp-hidden" (change)="picked($event)">
        <span>Drop files here, or click to choose</span>
      </label>

      @if (files().length) {
        <div class="imp-files">
          @for (f of files(); track f.name + f.size) {
            <div class="imp-file">
              <span class="imp-name" [title]="f.name">{{ f.name }}</span>
              <span class="imp-dim">{{ size(f.size) }}</span>
              <button class="tcv-chip" (click)="drop(f)" title="leave it out">&times;</button>
            </div>
          }
        </div>
      }

      <div class="imp-form">
        <span class="imp-dim">project</span>
        <select class="tcv-field" [value]="project()" (change)="project.set($any($event.target).value)">
          <option value="">(top level)</option>
          @for (p of projects(); track p) { <option [value]="p" [selected]="p === project()">{{ p }}</option> }
        </select>
        <span class="imp-dim">folder</span>
        <input class="tcv-field" [value]="folder()" (input)="folder.set($any($event.target).value)"
               placeholder="imported" maxlength="40">
        <span class="imp-dim">name</span>
        <input class="tcv-field" [value]="name()" (input)="name.set($any($event.target).value)"
               [placeholder]="guess() || 'taken from the files'" maxlength="80">
      </div>

      @if (!auth.can('edit')) { <p class="imp-bad">{{ auth.why('edit') }}</p> }
      @if (error(); as e) { <p class="imp-bad" role="alert">{{ e }}</p> }
      @if (sent() !== null) {
        <div class="imp-bar"><i [style.width.%]="sent()"></i></div>
        <p>uploading… {{ sent() }} %</p>
      }
      <div class="tcv-tokens-end imp-end">
        <button class="tcv-btn" (click)="close()">Cancel</button>
        <button class="tcv-btn tcv-btn-accent" (click)="start()"
                [disabled]="!files().length || sent() !== null || !auth.can('edit') || !folderOk()">Import</button>
      </div>
    } @else if (job(); as j) {
      <p><b>{{ j.title }}</b> · {{ j.status === 'running' ? j.stage + '…' : j.status === 'done' ? 'imported' : 'failed' }}
        · {{ (j.seconds ?? j.elapsed).toFixed(1) }} s</p>
      @if (j.status === 'running') {
        <div class="imp-bar imp-bar-run"><i></i></div>
        <div class="imp-log mono">@for (l of j.log; track $index) { <div>{{ l.at.toFixed(1) }} s · {{ l.stage }}</div> }</div>
      }
      @if (j.error) { <p class="imp-bad">{{ j.error }}</p> }
      @if (j.summary; as s) {
        @if (j.size_mm; as mm) { <p>Board {{ mm[0] }} × {{ mm[1] }} mm@if (s.source) { · drawn from {{ s.source }}}</p> }
        <div class="imp-head">Found</div>
        @for (f of s.found; track f.key) {
          <div class="imp-row">
            <span class="imp-ok">✓</span>
            <span class="imp-what">{{ f.what }}@if (f.note) { <span class="imp-dim"> · {{ f.note }}</span> }</span>
            <span class="imp-from" [title]="f.from.join('\\n')">{{ from(f.from) }}</span>
          </div>
        } @empty { <p>nothing</p> }
        @if (s.missing.length) {
          <div class="imp-head">Missing</div>
          @for (m of s.missing; track m.key) {
            <div class="imp-row">
              <span class="imp-no">–</span>
              <span class="imp-what">{{ m.what }}</span>
              <span class="imp-from imp-needs">{{ m.needs }}</span>
            </div>
          }
        }
        @if (s.notes.length) {
          <div class="imp-head">Notes</div>
          @for (n of s.notes; track $index) { <div class="imp-note">{{ n }}</div> }
        }
        @if (ignored(s).length) {
          <details class="imp-note"><summary>{{ ignored(s).length }} files not used</summary>
            @for (f of ignored(s); track f.file) { <div>{{ f.file }} - {{ f.note || f.kind }}</div> }
          </details>
        }
      }
      <div class="tcv-tokens-end imp-end">
        @if (j.status !== 'running') { <button class="tcv-btn" (click)="again()">Import another</button> }
        <button class="tcv-btn" (click)="close()">Close</button>
        @if (j.board) {
          <button class="tcv-btn tcv-btn-accent" (click)="openIt(j.board)">Open the board</button>
        }
      </div>
    }
  </div>
</div>`,
  styles: [`
.imp { width: min(640px, 94vw); }
.imp-drop { display: flex; align-items: center; justify-content: center; min-height: 84px; cursor: pointer;
  border: 1px dashed var(--line); border-radius: 6px; background: var(--surface); color: var(--ink-dim); }
.imp-drop[data-over], .imp-drop:hover { border-color: var(--accent); color: var(--ink); }
.imp-hidden { display: none; }
.imp-files { display: flex; flex-direction: column; gap: 2px; max-height: 140px; overflow: auto; }
.imp-file { display: flex; align-items: center; gap: 8px; font-size: 11.5px; }
.imp-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink); }
.imp-dim { color: var(--ink-dim); font-size: 11px; }
.imp-form { display: grid; grid-template-columns: auto 1fr; gap: 6px 10px; align-items: center; }
.imp-form .tcv-field { padding: 4px 6px; font-size: 12px; }
.imp-bad { color: var(--danger) !important; }
.imp-bar { height: 4px; border-radius: 2px; background: var(--surface); overflow: hidden; }
.imp-bar i { display: block; height: 100%; background: var(--accent); transition: width .2s; }
.imp-bar-run i { width: 30%; animation: imp-slide 1.2s ease-in-out infinite; }
@keyframes imp-slide { from { margin-left: -30%; } to { margin-left: 100%; } }
.imp-log { font-size: 11px; color: var(--ink-dim); max-height: 120px; overflow: auto; }
.imp-head { margin-top: 4px; font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-dim); }
.imp-row { display: grid; grid-template-columns: 14px minmax(0, 1fr) minmax(0, 1.2fr); gap: 8px;
  padding: 3px 0; border-top: 1px solid var(--line); font-size: 12px; }
.imp-ok { color: var(--ok); }
.imp-no { color: var(--warn); }
.imp-what { color: var(--ink); }
.imp-from { color: var(--ink-dim); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.imp-needs { white-space: normal; }
.imp-note { font-size: 11.5px; color: var(--ink-dim); }
.imp-end { gap: 6px; }
`],
})
export class ImportBoard implements OnDestroy {
  private http = inject(HttpClient);
  private picked$ = inject(Selection);
  auth = inject(Auth);

  /** The project the open board is in: where the new one goes unless changed. */
  initialProject = input<string>('');
  closed = output<void>();
  /** The new board's id, once the person asks to open it. */
  opened = output<string>();

  files = signal<File[]>([]);
  over = signal(false);
  projects = signal<string[]>([]);
  project = signal('');
  folder = signal('imported');
  name = signal('');
  error = signal('');
  /** Upload progress in percent, null while not uploading. */
  sent = signal<number | null>(null);
  job = signal<ImportJob | null>(null);
  private timer?: ReturnType<typeof setInterval>;

  guess = computed(() => ImportBoard.titleFrom(this.files().map(f => f.name)));
  folderOk = computed(() => /^[A-Za-z0-9_-]*$/.test(this.folder().trim()));

  constructor() {
    queueMicrotask(() => this.project.set(this.initialProject()));
    this.http.get<Folder>('/api/catalog').subscribe({
      next: t => this.projects.set(t.folders.map(f => f.path)),
    });
  }

  ngOnDestroy() { clearInterval(this.timer); }

  /** The same title the server would make: `Gerber_PCB_Demo_2026-09-29.zip` -> `Demo`. */
  static titleFrom(names: string[]): string {
    for (const n of names) {
      let s = n.replace(/\.[A-Za-z0-9_]+$/, '');
      s = s.replace(/^(gerber|3d|pcb|bom|pickandplace|fabrication)[_ -]+/i, '');
      s = s.replace(/^(gerber|3d|pcb)[_ -]+/i, '');
      s = s.replace(/[_ -]+\d{4}-\d{2}-\d{2}([_ -]\d+)?$/, '').replace(/_+/g, ' ').trim();
      if (s) return s.slice(0, 80);
    }
    return '';
  }

  size(n: number): string {
    return n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1000 ? Math.round(n / 1000) + ' kB' : n + ' B';
  }

  from(list: string[]): string {
    return list.length > 2 ? `${list[0]} +${list.length - 1} more` : list.join(', ');
  }

  ignored(s: NonNullable<ImportJob['summary']>) {
    return s.files.filter(f => f.kind === 'ignored');
  }

  private add(list: FileList | null | undefined) {
    if (!list) return;
    const have = new Set(this.files().map(f => f.name + f.size));
    this.files.update(fs => [...fs, ...Array.from(list).filter(f => !have.has(f.name + f.size))]);
    this.error.set('');
  }

  dropped(ev: DragEvent) {
    ev.preventDefault();
    this.over.set(false);
    this.add(ev.dataTransfer?.files);
  }

  picked(ev: Event) {
    const el = ev.target as HTMLInputElement;
    this.add(el.files);
    el.value = '';
  }

  drop(f: File) { this.files.update(fs => fs.filter(x => x !== f)); }

  start() {
    const form = new FormData();
    for (const f of this.files()) form.append('files', f, f.name);
    form.append('project', this.project());
    form.append('folder', this.folder().trim());
    form.append('name', this.name().trim());
    this.error.set('');
    this.sent.set(0);
    this.http.post<{ job: string }>('/api/boards/import', form,
                                     { reportProgress: true, observe: 'events' }).subscribe({
      next: ev => {
        if (ev.type === HttpEventType.UploadProgress && ev.total) {
          this.sent.set(Math.round(100 * ev.loaded / ev.total));
        } else if (ev.type === HttpEventType.Response && ev.body) {
          this.sent.set(null);
          this.watch(ev.body.job);
        }
      },
      error: e => {
        this.sent.set(null);
        this.error.set(String(e?.error?.detail ?? 'the upload failed'));
      },
    });
  }

  private watch(id: string) {
    const look = () => this.http.get<ImportJob>(`/api/boards/import/${id}`).subscribe({
      next: j => {
        this.job.set(j);
        if (j.status !== 'running') clearInterval(this.timer);
      },
      error: () => { clearInterval(this.timer); this.error.set('the import went away'); this.job.set(null); },
    });
    look();
    this.timer = setInterval(look, 800);
  }

  again() {
    clearInterval(this.timer);
    this.job.set(null);
    this.files.set([]);
    this.name.set('');
  }

  openIt(id: string) {
    this.picked$.openBoard(id);
    this.opened.emit(id);
  }

  close() {
    clearInterval(this.timer);
    this.closed.emit();
  }
}
