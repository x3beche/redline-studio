import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ModelEntry } from '../api';
import { T, t } from '../i18n';
import { Toast } from '../toast';

/** The 3D room's Model tab (model-tab.ts), in the board room's "Board
 *  health" look (rooms/board-health.css): the open model at a glance.
 *
 *  On top, its build: built, building, failed or not built yet, against
 *  what and when, with "Build again". Then a card a fact - the build, the
 *  STEP, its parts, what it imports and who imports it, whether it moves,
 *  its overall size - each from what the page already has (the catalog
 *  entry and the loaded model); nothing is checked here that is not
 *  checked anyway. Then the project's latest releases, and the model's
 *  technical drawing: a preview of the sheet once it is made, opened as
 *  the PDF on a click; else "Make now".
 *
 *  The editor does the work: building, releasing, opening the drawing
 *  stay its own (with their rights and busy states); this only asks. */

type Tone = 'ok' | 'warn' | 'error' | 'none';

/** What the loaded model says about itself (editor.ts readFacts). */
export interface ModelFacts {
  parts: number;
  motions: number;
  /** Overall size along x, y, z, in mm. */
  size: [number, number, number] | null;
}

interface Card { id: string; title: string; tone: Tone; status: string; line: string; tip?: string }

interface Release {
  id: string; tag: string; status: 'building' | 'ready' | 'failed';
  by: { name?: string }; created_at: string; bytes?: number;
}

/** How many releases are listed here; the rest are in the Releases window. */
const LATEST = 3;

function ago(at: string | null | undefined): string {
  if (!at) return '';
  const s = Math.max(0, (Date.now() - Date.parse(at)) / 1000);
  if (!isFinite(s)) return '';
  return s < 90 ? t('just now')
    : s < 5400 ? `${Math.round(s / 60)} ${t('min ago')}`
    : s < 129600 ? `${Math.round(s / 3600)} ${t('h ago')}`
    : `${Math.round(s / 86400)} ${t('days ago')}`;
}

function bytes(n: number): string {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

function secs(s: number): string {
  return s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

function mm(n: number): string {
  return n >= 100 ? n.toFixed(0) : n.toFixed(1).replace(/\.0$/, '');
}

@Component({
  selector: 'app-model-health',
  imports: [T],
  styleUrls: ['../settings.css', '../rooms/board-health.css'],
  styles: [`
    .bh { padding: 6px; }
    .mh-card { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; align-items: center;
               gap: 2px 8px; padding: 7px 9px; }
    .mh-card .bh-line { grid-column: 2 / -1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mh-card[data-tone="ok"] > .bh-light { background: var(--ok); }
    .mh-card[data-tone="warn"] > .bh-light { background: var(--warn); }
    .mh-card[data-tone="error"] > .bh-light { background: var(--danger); }
    .bh-verdict[data-tone="busy"] .bh-mark { background: var(--accent); color: var(--surface); font-size: 9.5px; }
    .mh-error { grid-column: 1 / -1; font: 10.5px/1.4 'IBM Plex Mono', ui-monospace, monospace; color: var(--danger);
                overflow-wrap: anywhere; max-height: 5.6em; overflow: hidden; }

    /* a section's head, with its action on the right */
    .mh-sec { display: flex; align-items: center; gap: 8px; margin-bottom: 0; }
    .mh-sec > span { flex: 1; min-width: 0; }
    .mh-sec .bh-run { text-transform: none; letter-spacing: 0; }

    /* releases */
    .mh-rel { grid-template-columns: auto minmax(0, 1fr) auto; }
    .mh-rel .bh-pose-sub { grid-column: 2 / 3; }
    .mh-state { font: 10.5px 'IBM Plex Mono', ui-monospace, monospace; color: var(--ink-dim); white-space: nowrap; }
    .mh-state[data-status="failed"] { color: var(--danger); }
    .mh-state[data-status="building"] { color: var(--warn); }
    .mh-all { width: 100%; display: flex; align-items: center; gap: 8px; padding: 6px 9px; font: inherit; font-size: 11px;
              color: var(--ink-dim); background: none; border: 0; border-top: 1px solid var(--line); cursor: pointer;
              text-align: left; border-radius: 0 0 6px 6px; }
    .mh-all::after { content: '›'; margin-left: auto; font-size: 11px; }
    .mh-all:hover { color: var(--ink); background: var(--hover); }
    .mh-all:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

    /* the drawing: the sheet as it is printed, paper white in any theme */
    .mh-sheet { position: relative; display: block; width: 100%; padding: 0; aspect-ratio: 420 / 297; cursor: zoom-in;
                background: var(--surface-2); border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
    .mh-sheet img { display: block; width: 100%; height: 100%; object-fit: contain; opacity: 0;
                    transition: opacity .15s; }
    .mh-sheet[data-shown] img { opacity: 1; }
    .mh-sheet:hover { border-color: var(--accent-deep); }
    .mh-sheet:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .mh-sheet:disabled { cursor: progress; }
    .mh-sheet-busy { position: absolute; inset: auto 6px 6px auto; padding: 1px 7px; font-size: 11px; color: var(--ink);
                     background: var(--surface); border: 1px solid var(--line); border-radius: 4px; }
    .mh-none { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; padding: 10px;
               font-size: 11px; line-height: 1.4; color: var(--ink-dim); background: var(--surface);
               border: 1px dashed var(--line); border-radius: 6px; }
    .mh-none b { color: var(--ink); font-weight: 600; font-size: 12px; }
    @media (prefers-reduced-motion: reduce) { .mh-sheet img { transition: none; } }
  `],
  template: `
<div class="bh">
  @if (entry(); as m) {
    <!-- THE BUILD: one state, when, against what. -->
    <section class="bh-verdict" [attr.data-tone]="verdict().tone">
      <span class="bh-mark" aria-hidden="true">{{ verdict().mark }}</span>
      <div class="bh-state">{{ verdict().text }}</div>
      <div class="bh-when">
        <span [title]="m.built_at ?? ''">{{ verdict().when }}</span>
        @if (canBuild()) {
          <button class="tcv-btn bh-run" (click)="build.emit()" [disabled]="m.building"
                  [title]="'Runs the model\\'s script again' | t">{{ 'Build again' | t }}</button>
        }
      </div>
      @if (verdict().error; as e) { <div class="mh-error" [title]="e">{{ e }}</div> }
    </section>

    <!-- THE MODEL IN FACTS: a light, a name, a figure, a line. -->
    <div class="bh-list">
      @for (c of cards(); track c.id) {
        <section class="bh-check mh-card" [attr.data-tone]="c.tone" [title]="c.tip ?? ''">
          <i class="bh-light" aria-hidden="true"></i>
          <span class="bh-title">{{ c.title | t }}</span>
          <span class="bh-status">{{ c.status }}</span>
          <span class="bh-line">{{ c.line }}</span>
        </section>
      }
    </div>

    <!-- RELEASES of the model's project (rooms/releases.ts). -->
    <div class="bh-sec mh-sec">
      <span>{{ 'Releases' | t }}</span>
      <button class="tcv-btn bh-run" (click)="release.emit()"
              [title]="'Pack the project for manufacturing' | t">{{ 'Release' | t }}</button>
    </div>
    <div class="bh-poses">
      @for (r of latest(); track r.id) {
        <div class="bh-pose mh-rel">
          <span class="bh-ref">{{ r.tag }}</span>
          <span class="bh-pose-nums">{{ date(r.created_at) }}</span>
          <span class="mh-state" [attr.data-status]="r.status">{{ relState(r) }}</span>
          <span class="bh-pose-sub">{{ r.by.name || ('someone' | t) }}</span>
        </div>
      } @empty {
        <div class="bh-empty" style="padding: 7px 9px">{{ relEmpty() }}</div>
      }
      <button class="mh-all" (click)="releases.emit()">
        {{ 'All releases' | t }}@if (releasesList().length > latest().length) { <span class="bh-count">{{ releasesList().length }}</span> }</button>
    </div>

    <!-- THE TECHNICAL DRAWING: the sheet once made, the PDF on a click. -->
    <div class="bh-sec mh-sec">
      <span>{{ 'Technical drawing' | t }}</span>
      @if (preview() === 'shown') {
        <button class="tcv-btn bh-run" (click)="openDrawing.emit()" [disabled]="drawingBusy()">
          {{ (drawingBusy() ? 'Drawing…' : 'Open PDF') | t }}</button>
      }
    </div>
    @if (!m.step_bytes) {
      <div class="mh-none"><b>{{ 'No STEP to draw from' | t }}</b>{{ 'The model\\'s script does not export one.' | t }}</div>
    } @else if (preview() === 'none') {
      <div class="mh-none">
        <b>{{ 'Not made yet' | t }}</b>
        <span>{{ 'Made 10 minutes after a build, or now.' | t }}</span>
        <button class="tcv-btn bh-run" style="margin-left: 0" (click)="make()" [disabled]="making() || drawingBusy()">
          {{ (making() || drawingBusy() ? 'Drawing…' : 'Make now') | t }}</button>
      </div>
    } @else {
      <button class="mh-sheet" [attr.data-shown]="preview() === 'shown' ? 1 : null" (click)="openDrawing.emit()"
              [disabled]="drawingBusy() || preview() !== 'shown'" [attr.aria-label]="'Open the technical drawing as PDF' | t"
              [title]="'Open the technical drawing as PDF' | t">
        <img [src]="previewUrl()" alt="" (load)="preview.set('shown')" (error)="preview.set('none')">
        @if (drawingBusy()) { <span class="mh-sheet-busy">{{ 'Drawing…' | t }}</span> }
      </button>
    }
  }
</div>
`,
})
export class ModelHealth {
  private http = inject(HttpClient);
  /** The open model's catalog entry. */
  entry = input<ModelEntry | null>(null);
  facts = input<ModelFacts | null>(null);
  /** How far a running build is, against the last one's time. */
  pct = input<number | null>(null);
  /** Whether "Build again" is offered: the right to run. */
  canBuild = input(false);
  /** The editor's drawing is being made and opened. */
  drawingBusy = input(false);
  /** The Releases window is open: the list is read again when it closes. */
  releasing = input(false);
  build = output<void>();
  release = output<void>();
  releases = output<void>();
  openDrawing = output<void>();

  releasesList = signal<Release[]>([]);
  private loaded = signal('');
  latest = computed(() => this.releasesList().slice(0, LATEST));
  /** The preview: on its way, there, or not made yet. */
  preview = signal<'loading' | 'shown' | 'none'>('loading');
  /** Asked again after a drawing was made here or opened. */
  private ask = signal(0);
  making = signal(false);

  private project = computed(() => this.entry()?.id.split('/')[0] ?? '');
  previewUrl = computed(() => {
    const m = this.entry();
    return m ? `/api/models/${m.id}/drawing.svg?b=${encodeURIComponent(m.built_at ?? '')}&n=${this.ask()}` : '';
  });

  constructor() {
    // The releases of the model's project, again when the Releases window closes.
    effect(() => {
      const p = this.project();
      if (this.releasing() || !p) return;
      untracked(() => this.loadReleases(p));
    });
    // A new address is a new question.
    effect(() => { this.previewUrl(); untracked(() => this.preview.set('loading')); });
    // The editor's drawing done (opened, perhaps made just now): look again.
    let was = false;
    effect(() => {
      const busy = this.drawingBusy();
      if (was && !busy) untracked(() => this.ask.update(n => n + 1));
      was = busy;
    });
  }

  private loadReleases(project: string) {
    this.http.get<Release[]>(`/api/releases?project=${encodeURIComponent(project)}`).subscribe({
      next: l => {
        this.releasesList.set([...l].sort((a, b) => b.created_at.localeCompare(a.created_at)));
        this.loaded.set(project);
      },
      error: () => { this.releasesList.set([]); this.loaded.set(project); },
    });
  }

  relEmpty() {
    return this.loaded() === this.project()
      ? t('No releases of {x} yet.').replace('{x}', this.project()) : t('Loading…');
  }

  relState(r: Release) {
    return r.status === 'building' ? t('packing…') : r.status === 'failed' ? t('failed')
      : r.bytes ? bytes(r.bytes) : '';
  }

  date(iso: string) {
    return new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  /** The drawing made now, without opening it: the preview comes when it is. */
  make() {
    const m = this.entry();
    if (!m || this.making()) return;
    this.making.set(true);
    fetch(`/api/models/${m.id}/drawing.pdf`, { credentials: 'same-origin' })
      .then(async res => {
        if (res.ok) return;
        let why = `${res.status}`;
        try { const j = await res.json(); why = typeof j?.detail === 'string' ? j.detail : why; } catch { /* not JSON */ }
        Toast.show(t('The technical drawing could not be made.') + ' ' + why, { tone: 'danger', ms: 8000 });
      })
      .catch(e => Toast.show(t('The technical drawing could not be made.') + ' ' + String(e?.message ?? e),
                             { tone: 'danger', ms: 8000 }))
      .finally(() => { this.making.set(false); this.ask.update(n => n + 1); });
  }

  /** The uses it was built against, and how many have moved on since. */
  private behind = computed(() => (this.entry()?.uses ?? [])
    .filter(u => u.built_against != null && u.version != null && u.built_against !== u.version));

  verdict = computed(() => {
    const m = this.entry()!;
    const link = m.link;
    const failed = link && ['failed', 'blocked', 'cycle'].includes(link.state);
    if (m.building || link?.state === 'building') {
      const p = this.pct();
      return { tone: 'busy', mark: p != null ? `${p}` : '…', error: '',
               text: p != null ? `${t('Building')} ${p}%` : t('Building…'),
               when: `${t('Started')} ${ago(m.build_started ?? link?.at)}` };
    }
    if (failed) {
      const why = link!.state === 'cycle' ? t('It imports itself, through') + ' ' + (link!.cycle ?? []).join(' → ')
        : link!.error ?? '';
      return { tone: 'error', mark: '!', text: link!.state === 'blocked' ? t('Build held up') : t('Build failed'),
               error: why, when: link!.because ? `${t('after')} ${link!.because.title}` + (link!.because.version ? ` v${link!.because.version}` : '')
                 : ago(link!.done_at ?? link!.at) };
    }
    if (link?.state === 'queued') {
      return { tone: 'busy', mark: '…', text: t('Queued to build'), error: '',
               when: link.because ? `${t('after')} ${link.because.title}` : '' };
    }
    if (!m.built_at || !m.data) {
      return { tone: 'none', mark: '·', text: t('Not built yet'), error: '', when: t('Build it to see it') };
    }
    const uses = m.uses ?? [];
    const behind = this.behind().length;
    const against = !uses.length ? ''
      : behind ? ` · ${behind}/${uses.length} ${t('imports moved on')}`
      : ` · ${t('against the latest of')} ${uses.length} ${t(uses.length === 1 ? 'import' : 'imports')}`;
    const when = `v${m.version ?? 1} · ${t('built')} ${ago(m.built_at)}${against}`;
    if (m.stale) return { tone: 'warn', mark: '!', text: t('Source changed since the build'), error: '', when };
    if (behind) return { tone: 'warn', mark: '!', text: t('Built, imports moved on'), error: '', when };
    return { tone: 'ok', mark: '✓', text: t('Built'), error: '', when };
  });

  cards = computed<Card[]>(() => {
    const m = this.entry();
    if (!m) return [];
    const f = this.facts();
    const out: Card[] = [];
    const built = !!m.built_at && !!m.data;
    const failed = !!m.link && ['failed', 'blocked', 'cycle'].includes(m.link.state);

    out.push({ id: 'build', title: 'Build', tone: failed ? 'error' : built ? (m.stale ? 'warn' : 'ok') : 'none',
               status: m.build_secs ? secs(m.build_secs) : '–',
               line: failed ? t('The last build failed; the one before is on show')
                 : built ? `${t('Last')} ${new Date(m.built_at!).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
                   + (m.stale ? ` · ${t('source changed since')}` : '')
                 : t('Not built yet'),
               tip: m.built_at ?? '' });

    const step = m.step_bytes ?? 0;
    out.push({ id: 'step', title: 'STEP exported', tone: step ? 'ok' : 'none',
               status: step ? bytes(step) : t('No'),
               line: step ? t('For CAD, the drawing and releases') : t('The script does not export one') });

    if (f) {
      out.push({ id: 'parts', title: 'Parts', tone: 'none', status: String(f.parts),
                 line: t(f.parts === 1 ? 'One body' : 'In the model tree') });
    }

    const uses = m.uses ?? [], usedBy = m.used_by ?? [];
    const behind = this.behind();
    out.push({ id: 'links', title: 'Imports', tone: behind.length ? 'warn' : uses.length || usedBy.length ? 'ok' : 'none',
               status: `${uses.length} / ${usedBy.length}`,
               line: behind.length ? `${t('Moved on')}: ${behind.map(u => u.title).join(', ')}`
                 : `${t('uses')} ${uses.length} · ${t('used in')} ${usedBy.length}`,
               tip: [uses.length ? `${t('uses')}: ${uses.map(u => u.title).join(', ')}` : '',
                     usedBy.length ? `${t('used in')}: ${usedBy.map(u => u.title).join(', ')}` : ''].filter(Boolean).join('\n') });

    if (f) {
      out.push({ id: 'motion', title: 'Motion', tone: f.motions ? 'ok' : 'none',
                 status: f.motions ? String(f.motions) : t('None'),
                 line: f.motions ? t('Moving parts, on the Motion tab') : t('Nothing moves') });
      if (f.size) {
        out.push({ id: 'size', title: 'Size', tone: 'none', status: f.size.map(mm).join(' × '),
                   line: t('Overall, in mm (x × y × z)') });
      }
    }
    return out;
  });
}
