import { Component, OnDestroy, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ModelEntry } from '../api';
import { T, t } from '../i18n';
import { Toast } from '../toast';

/** The 3D room's Model tab (model-tab.ts), in the board room's "Board
 *  health" look (rooms/board-health.css), kept small: the open model at a
 *  glance.
 *
 *  On top one line for its build - built, building, failed, not built -
 *  with "Build again", a dim line of its size and parts, and a warning only
 *  when something is wrong (the build failed, no STEP, imports moved on).
 *  Then the project's latest releases, and the model's technical drawing:
 *  where it is (made, being made and how far, waiting, when it is made by
 *  itself, failed), a small picture of the sheet once made, what the sheet
 *  holds, and Open / Download / Make again.
 *
 *  Everything about the drawing is asked of the server for the model on
 *  show (GET .../drawing/status), and dropped the moment another model is
 *  opened: nothing of one model's drawing is ever shown on another. */

type Tone = 'ok' | 'warn' | 'error' | 'none' | 'busy';

/** What the loaded model says about itself (editor.ts readFacts). */
export interface ModelFacts {
  parts: number;
  /** Overall size along x, y, z, in mm. */
  size: [number, number, number] | null;
  /** Its part names in order (NAMES) and its tree's groups. */
  names?: string[];
  groups?: string[];
}

interface Release {
  id: string; tag: string; status: 'building' | 'ready' | 'failed';
  by: { name?: string }; created_at: string; bytes?: number;
}

/** backend/release.py drawing_status. */
export interface DrawingStatus {
  id: string;
  state: 'no_step' | 'none' | 'scheduled' | 'queued' | 'making' | 'ready' | 'failed';
  pct?: number | null; stage?: string | null; started_at?: string | null;
  scheduled_at: string | null; auto_after_s: number;
  built: { version: number | null; at: string | null };
  step?: { sha: string; bytes: number };
  key?: string;
  layout?: { custom: boolean; version: number; key: string };
  made?: { at: string; pdf_bytes: number; preview: boolean; sheet?: string; scale?: string; views?: string[];
           layout?: string; boxes?: any[]; parts?: string[]; unmatched?: string[] };
  failed?: { reason: string; at: string };
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

function mm(n: number): string {
  return n >= 100 ? n.toFixed(0) : n.toFixed(1).replace(/\.0$/, '');
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function day(iso: string): string {
  return new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

@Component({
  selector: 'app-model-health',
  imports: [T],
  styleUrls: ['../settings.css', '../rooms/board-health.css'],
  styles: [`
    .bh { padding: 6px; gap: 6px; }

    /* the build: one line, a dim line of figures, a warning when wrong */
    .mh-top { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; align-items: center; gap: 2px 8px;
              padding: 6px 8px; background: var(--surface-2); border: 1px solid var(--line); border-radius: 6px; }
    .mh-top[data-tone="ok"] > .bh-light { background: var(--ok); }
    .mh-top[data-tone="warn"] > .bh-light { background: var(--warn); }
    .mh-top[data-tone="error"] > .bh-light { background: var(--danger); }
    .mh-top[data-tone="busy"] > .bh-light { background: var(--accent); }
    .mh-line { font-size: 12px; font-weight: 600; color: var(--ink-bright); min-width: 0; overflow: hidden;
               text-overflow: ellipsis; white-space: nowrap; }
    .mh-act { padding: 1px 7px; font-size: 11px; }
    .mh-dim { grid-column: 2 / -1; font-size: 11px; color: var(--ink-dim); min-width: 0; overflow: hidden;
              text-overflow: ellipsis; white-space: nowrap; }
    .mh-warn { grid-column: 2 / -1; font-size: 11px; line-height: 1.35; color: var(--warn); overflow-wrap: anywhere;
               max-height: 4.1em; overflow: hidden; }
    .mh-top[data-tone="error"] .mh-warn { color: var(--danger); }

    /* a section's head, with what it is or its action on the right */
    .mh-sec { display: flex; align-items: center; gap: 8px; margin: 2px 2px 0; }
    .mh-sec > span:first-child { flex: 1; min-width: 0; }
    .mh-sec .mh-act, .mh-chip { text-transform: none; letter-spacing: 0; }
    .mh-chip { font: 10.5px 'IBM Plex Mono', ui-monospace, monospace; color: var(--ink-dim); }
    .mh-chip[data-state="ready"] { color: var(--ok); }
    .mh-chip[data-state="making"], .mh-chip[data-state="queued"] { color: var(--accent); }
    .mh-chip[data-state="failed"] { color: var(--danger); }

    /* releases: a line each */
    .mh-rels { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; }
    .mh-rel { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 8px;
              padding: 4px 8px; font-size: 11px; color: var(--ink-dim); }
    .mh-rel + .mh-rel { border-top: 1px dashed var(--line); }
    .mh-rel > span:nth-child(2) { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mh-rel-state { font: 10.5px 'IBM Plex Mono', ui-monospace, monospace; white-space: nowrap; }
    .mh-rel-state[data-status="failed"] { color: var(--danger); }
    .mh-rel-state[data-status="building"] { color: var(--warn); }
    .mh-all { width: 100%; display: flex; align-items: center; gap: 8px; padding: 4px 8px; font: inherit; font-size: 11px;
              color: var(--ink-dim); background: none; border: 0; border-top: 1px solid var(--line); cursor: pointer;
              text-align: left; border-radius: 0 0 6px 6px; }
    .mh-all::after { content: '›'; margin-left: auto; }
    .mh-all:hover { color: var(--ink); background: var(--hover); }
    .mh-all:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .mh-rels .bh-empty { padding: 5px 8px; }

    /* the drawing */
    .mh-draw { display: flex; flex-direction: column; gap: 6px; padding: 6px; background: var(--surface);
               border: 1px solid var(--line); border-radius: 6px; font-size: 11px; color: var(--ink-dim); }
    .mh-sheet { display: block; line-height: 0; border: 1px solid var(--line); border-radius: 4px; overflow: hidden;
                background: var(--surface-2); cursor: zoom-in; }
    .mh-sheet img { display: block; width: 100%; height: auto; }
    .mh-sheet:hover { border-color: var(--accent-deep); }
    .mh-sheet:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .mh-bar { height: 4px; border-radius: 2px; background: var(--surface-2); overflow: hidden; }
    .mh-bar > i { display: block; height: 100%; background: var(--accent); transform-origin: left;
                  transition: transform .2s; }
    .mh-busy { display: flex; justify-content: space-between; gap: 8px; color: var(--ink); }
    .mh-busy b { font: 600 11px 'IBM Plex Mono', ui-monospace, monospace; }
    .mh-facts { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 2px 8px; }
    .mh-facts > span:nth-child(odd) { color: var(--ink-dim); }
    .mh-facts > span:nth-child(even) { color: var(--ink); min-width: 0; overflow-wrap: anywhere; }
    .mh-fail { color: var(--danger); overflow-wrap: anywhere; max-height: 4.1em; overflow: hidden; }
    .mh-btns { display: flex; flex-wrap: wrap; gap: 4px; }
    .mh-btns .tcv-btn { padding: 2px 8px; font-size: 11px; text-decoration: none; }
    @media (prefers-reduced-motion: reduce) { .mh-bar > i { transition: none; } }
  `],
  template: `
<div class="bh">
  @if (entry(); as m) {
    <!-- THE BUILD: one line; figures; a warning only when wrong. -->
    <section class="mh-top" [attr.data-tone]="top().tone">
      <i class="bh-light" aria-hidden="true"></i>
      <span class="mh-line" [title]="m.built_at ?? ''">{{ top().text }}</span>
      @if (canBuild()) {
        <button class="tcv-btn mh-act" (click)="build.emit()" [disabled]="m.building"
                [title]="'Runs the model\\'s script again' | t">{{ 'Build again' | t }}</button>
      } @else { <span></span> }
      @if (figures()) { <span class="mh-dim">{{ figures() }}</span> }
      @for (w of warnings(); track $index) { <span class="mh-warn" [title]="w">{{ w }}</span> }
    </section>

    <!-- RELEASES of the model's project (rooms/releases.ts). -->
    <div class="bh-sec mh-sec">
      <span>{{ 'Releases' | t }}</span>
      <button class="tcv-btn mh-act" (click)="release.emit()"
              [title]="'Pack the project for manufacturing' | t">{{ 'Release' | t }}</button>
    </div>
    <div class="mh-rels">
      @for (r of latest(); track r.id) {
        <div class="mh-rel">
          <span class="bh-ref">{{ r.tag }}</span>
          <span [title]="r.created_at">{{ day(r.created_at) }} · {{ r.by.name || ('someone' | t) }}</span>
          <span class="mh-rel-state" [attr.data-status]="r.status">{{ relState(r) }}</span>
        </div>
      } @empty {
        <div class="bh-empty">{{ relEmpty() }}</div>
      }
      <button class="mh-all" (click)="releases.emit()">
        {{ 'All releases' | t }}@if (releasesList().length > latest().length) { <span class="bh-count">{{ releasesList().length }}</span> }</button>
    </div>

    <!-- THE TECHNICAL DRAWING of this model's current STEP. -->
    <div class="bh-sec mh-sec">
      <span>{{ 'Technical drawing' | t }}</span>
      @if (draw(); as d) { <span class="mh-chip" [attr.data-state]="d.state">{{ chip() }}</span> }
    </div>
    @if (draw(); as d) {
      <div class="mh-draw">
        @if (d.state === 'making' || d.state === 'queued') {
          <div class="mh-busy"><span>{{ (d.stage || (d.state === 'queued' ? 'waiting its turn' : 'starting')) | t }}</span>
            <b>{{ d.state === 'queued' ? '' : (d.pct ?? 0) + '%' }}</b></div>
          <div class="mh-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" [attr.aria-valuenow]="d.pct ?? 0">
            <i [style.transform]="'scaleX(' + ((d.pct ?? 0) / 100) + ')'"></i></div>
        }
        @if (d.made; as made) {
          @if (made.preview) {
            <a class="mh-sheet" [href]="pdfUrl()" target="_blank" rel="noopener"
               [title]="'Open the technical drawing as PDF' | t">
              <img [src]="pngUrl()" width="480" height="339" loading="lazy" decoding="async"
                   [alt]="'Technical drawing' | t"></a>
          }
          <div class="mh-facts">
            <span>{{ 'Made' | t }}</span><span [title]="made.at">{{ day(made.at) }}@if (d.built.version) { · {{ 'of' | t }} v{{ d.built.version }} }@if (d.step) { · STEP {{ d.step.sha.slice(0, 8) }} }</span>
            @if (made.scale) { <span>{{ 'Sheet' | t }}</span><span>{{ made.sheet | t }} · {{ made.scale }}</span> }
            @if (made.views?.length) { <span>{{ 'Views' | t }}</span><span>{{ viewNames(made.views!) }}</span> }
            <span>{{ 'Layout' | t }}</span><span>{{ (d.layout?.custom ? 'own' : 'automatic') | t }}</span>
            <span>PDF</span><span>{{ size(made.pdf_bytes) }}</span>
          </div>
        } @else if (d.state === 'no_step') {
          <span>{{ 'No STEP to draw from: the model\\'s script does not export one.' | t }}</span>
        } @else if (d.state !== 'making' && d.state !== 'queued') {
          <span>{{ 'Not made yet.' | t }}</span>
        }
        @if (d.state !== 'no_step') { <span>{{ schedule() }}</span> }
        @if (d.failed; as f) { <span class="mh-fail" [title]="f.reason">{{ 'Last attempt failed' | t }}: {{ f.reason }}</span> }
        @if (d.state !== 'no_step') {
          <div class="mh-btns">
            @if (d.made) {
              <a class="tcv-btn tcv-btn-accent" [href]="pdfUrl()" target="_blank" rel="noopener">{{ 'Open PDF' | t }}</a>
              <a class="tcv-btn" [href]="pdfUrl() + '?download=1'" download>{{ 'Download' | t }}</a>
            }
            @if (canBuild() && d.state !== 'making') {
              <button class="tcv-btn" (click)="make(!!d.made)" [disabled]="asking()">
                {{ (d.made ? 'Make again' : 'Make now') | t }}</button>
            }
            <button class="tcv-btn" (click)="layout.emit(d)" [title]="'Choose the sheet, the views and their sizes' | t">{{ 'Edit layout' | t }}</button>
          </div>
        }
      </div>
    } @else {
      <div class="mh-draw"><span>{{ 'Loading…' | t }}</span></div>
    }
  }
</div>
`,
})
export class ModelHealth implements OnDestroy {
  private http = inject(HttpClient);
  /** The open model's catalog entry. */
  entry = input<ModelEntry | null>(null);
  facts = input<ModelFacts | null>(null);
  /** How far a running build is, against the last one's time. */
  pct = input<number | null>(null);
  /** Whether "Build again" and making the drawing are offered: the right to run. */
  canBuild = input(false);
  /** The Releases window is open: the list is read again when it closes. */
  releasing = input(false);
  build = output<void>();
  release = output<void>();
  releases = output<void>();
  /** "Edit layout": the editor opens the layout editor (drawing-layout.ts). */
  layout = output<DrawingStatus>();

  readonly day = day;
  releasesList = signal<Release[]>([]);
  private loaded = signal('');
  latest = computed(() => this.releasesList().slice(0, LATEST));

  /** The drawing of the model on show; null while it is asked for. */
  draw = signal<DrawingStatus | null>(null);
  /** A make is being asked for. */
  asking = signal(false);
  private timer?: ReturnType<typeof setTimeout>;

  private id = computed(() => this.entry()?.id ?? '');
  private project = computed(() => this.id().split('/')[0]);
  pdfUrl = computed(() => `/api/models/${this.id()}/drawing.pdf`);
  /** Kept for good by the browser: the key changes with the drawing. */
  pngUrl = computed(() => {
    const d = this.draw();
    return d?.key ? `/api/models/${d.id}/drawing.png?k=${d.key}` : '';
  });

  constructor() {
    // The releases of the model's project, again when the Releases window closes.
    effect(() => {
      const p = this.project();
      if (this.releasing() || !p) return;
      untracked(() => this.loadReleases(p));
    });
    // Another model, or this one built again: its drawing asked for anew,
    // and nothing of the one before kept on show.
    effect(() => {
      const id = this.id();
      this.entry()?.built_at;
      untracked(() => {
        clearTimeout(this.timer);
        if (this.draw()?.id !== id) this.draw.set(null);
        if (id) this.status(id);
      });
    });
  }

  ngOnDestroy() { clearTimeout(this.timer); }

  /** Read the drawing's status again (the layout editor made a new one). */
  refresh() { const id = this.id(); if (id) this.status(id); }

  /** Where the drawing is; asked again every second while it is being
   *  made or waits its turn, every half minute while it is due. */
  private status(id: string) {
    this.http.get<DrawingStatus>(`/api/models/${id}/drawing/status`).subscribe({
      next: d => {
        if (d.id !== this.id()) return;
        this.draw.set(d);
        this.follow(d);
      },
      error: () => { if (id === this.id()) this.draw.set(null); },
    });
  }

  private follow(d: DrawingStatus) {
    clearTimeout(this.timer);
    const ms = d.state === 'making' || d.state === 'queued' ? 1000 : d.state === 'scheduled' ? 30_000 : 0;
    if (ms) this.timer = setTimeout(() => this.status(d.id), ms);
  }

  /** Made now, in the background (anew if it is made); followed here. */
  make(again: boolean) {
    const id = this.id();
    if (!id || this.asking()) return;
    this.asking.set(true);
    this.http.post<DrawingStatus>(`/api/models/${id}/drawing${again ? '?again=1' : ''}`, {}).subscribe({
      next: d => {
        this.asking.set(false);
        if (d.id !== this.id()) return;
        this.draw.set(d);
        this.follow(d);
      },
      error: e => {
        this.asking.set(false);
        Toast.show(t('The technical drawing could not be made.') + ' ' + (e.error?.detail ?? e.status),
                   { tone: 'danger', ms: 8000 });
      },
    });
  }

  chip = computed(() => {
    const d = this.draw();
    if (!d) return '';
    switch (d.state) {
      case 'making': return `${t('making')} ${d.pct ?? 0}%`;
      case 'queued': return t('waiting');
      case 'ready': return t('ready');
      case 'failed': return t('failed');
      case 'scheduled': return `${t('due')} ${clock(d.scheduled_at!)}`;
      case 'no_step': return t('no STEP');
      default: return t('not made');
    }
  });

  /** When it is made by itself. */
  schedule = computed(() => {
    const d = this.draw();
    if (!d) return '';
    const after = Math.round(d.auto_after_s / 60);
    const base = t('Made by itself {n} min after a build').replace('{n}', String(after));
    return d.scheduled_at ? `${base} · ${t('next at')} ${clock(d.scheduled_at)}` : `${base}.`;
  });

  viewNames(v: string[]) { return v.map(x => t(x)).join(', '); }
  size(n: number) { return bytes(n); }

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

  /** The uses it was built against that have moved on since. */
  private behind = computed(() => (this.entry()?.uses ?? [])
    .filter(u => u.built_against != null && u.version != null && u.built_against !== u.version));

  top = computed<{ tone: Tone; text: string }>(() => {
    const m = this.entry()!;
    const link = m.link;
    if (m.building || link?.state === 'building') {
      const p = this.pct();
      return { tone: 'busy', text: p != null ? `${t('Building')} ${p}%` : t('Building…') };
    }
    if (link && ['failed', 'blocked', 'cycle'].includes(link.state)) {
      return { tone: 'error', text: link.state === 'blocked' ? t('Build held up') : t('Build failed') };
    }
    if (link?.state === 'queued') return { tone: 'busy', text: t('Queued to build') };
    if (!m.built_at || !m.data) return { tone: 'none', text: t('Not built yet') };
    const text = `${t('Built')} v${m.version ?? 1} · ${ago(m.built_at)}`;
    return { tone: m.stale || this.behind().length || !m.step_bytes ? 'warn' : 'ok', text };
  });

  figures = computed(() => {
    const f = this.facts();
    if (!f) return '';
    return [f.size ? `${f.size.map(mm).join(' × ')} mm` : '',
            f.parts ? `${f.parts} ${t(f.parts === 1 ? 'part' : 'parts')}` : ''].filter(Boolean).join(' · ');
  });

  /** Only what is wrong. */
  warnings = computed(() => {
    const m = this.entry()!;
    const out: string[] = [];
    const link = m.link;
    if (link && ['failed', 'blocked', 'cycle'].includes(link.state)) {
      out.push(link.state === 'cycle' ? `${t('It imports itself, through')} ${(link.cycle ?? []).join(' → ')}`
        : (link.because ? `${t('after')} ${link.because.title}: ` : '') + (link.error ?? ''));
    }
    if (m.built_at && m.data) {
      if (m.stale) out.push(t('Source changed since the build'));
      const behind = this.behind();
      if (behind.length) out.push(`${t('Built against older')}: ${behind.map(u => u.title).join(', ')}`);
      if (!m.step_bytes) out.push(t('No STEP: the script does not export one'));
    }
    return out.filter(Boolean);
  });
}
