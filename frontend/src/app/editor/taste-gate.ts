import { Component, OnDestroy, computed, effect, inject, signal, untracked } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { T, t } from '../i18n';
import { Toast } from '../toast';
import { Selection } from '../selection';

/** The Taste check before a note is marked applied (backend/taste_check.py).
 *
 *  "Mark applied" on a note whose project has Taste palettes is refused by
 *  the server (409) until the note's latest check passed. The editor then
 *  asks here - `TasteGate.ask(note)` - and this box runs the check: the
 *  model rendered from the palettes' reference views and judged by a model
 *  that reads images, which takes a minute or more, so it is a job on the
 *  server, read every two seconds, with each step and its time on screen.
 *
 *  Passed: the note is marked applied and the box closes by itself.
 *  Otherwise the items that fail (or, when nothing could be looked at, the
 *  items to look at and why) are listed, and the person marks it applied
 *  anyway (force) or goes back. Closing while it runs leaves the check
 *  running on the server; asking again picks it up. */

type Verdict = 'pass' | 'fail' | 'unclear' | 'unchecked';
interface CheckItem {
  palette: string; palette_name: string; id: string; text: string; strength: 'must' | 'prefer' | 'avoid';
  domain: string; applies_to: string; exception?: string; verdict: Verdict; why: string;
}
interface CheckStep { id: string; kind: string; state: string; seconds?: number; started_at?: string;
                      views?: string[]; shots?: number; model?: string; images?: number; items?: number; reason?: string }
export interface TasteCheck {
  id: string; note: string; status: 'queued' | 'rendering' | 'asking' | 'done' | 'failed' | 'none';
  started_at: string; finished_at: string | null; seconds: number | null; now: string;
  palettes: { id: string; name: string; via?: string | null }[];
  steps: CheckStep[]; error?: string | null; model?: string;
  result?: { verdict: Verdict | 'pass'; items: CheckItem[]; notice: string; model?: string | null;
             palettes: { id: string; name: string; via?: string | null }[] } | null;
}
const ACTIVE = ['queued', 'rendering', 'asking'];
const ORDER: Record<Verdict, number> = { fail: 0, unchecked: 1, unclear: 2, pass: 3 };

interface Ask { id: string; comment: string; done: (marked: boolean) => void }
const asks = signal<Ask[]>([]);

export class TasteGate {
  /** Check a note and mark it applied when it passes (or when the person
   *  marks it anyway): true once it is marked, false when they went back. */
  static ask(note: { id: string; comment: string }): Promise<boolean> {
    return new Promise(done => asks.update(q => [...q, { id: note.id, comment: note.comment, done }]));
  }
}

@Component({
  selector: 'wb-taste-gate',
  imports: [T],
  styles: [`
    .tg-veil { position: fixed; inset: 0; z-index: 9000; display: flex; align-items: center; justify-content: center;
               padding: 16px; background: rgba(0, 0, 0, .5); }
    .tg-box { display: flex; flex-direction: column; gap: 10px; width: min(980px, 100%); max-height: 86vh;
              box-sizing: border-box; padding: 16px 18px 14px; color: var(--ink); background: var(--surface);
              border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 12px 36px var(--shadow-hard); }
    .tg-head { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 12px; align-items: baseline; }
    .tg-head h2 { margin: 0; font-size: 15px; font-weight: 600; }
    .tg-head .tg-time { font: 11px 'IBM Plex Mono', ui-monospace, monospace; color: var(--ink-dim); }
    .tg-sub { grid-column: 1 / -1; font-size: 12px; color: var(--ink-dim); min-width: 0; overflow: hidden;
              text-overflow: ellipsis; white-space: nowrap; }
    .tg-pals { display: flex; flex-wrap: wrap; gap: 4px 6px; align-items: center; font-size: 11px; color: var(--ink-dim); }
    .tg-pals button { height: 20px; padding: 0 7px; font: inherit; color: var(--ink); background: var(--surface-2);
                      border: 1px solid var(--line); border-radius: 10px; cursor: pointer; }
    .tg-pals button:hover { border-color: var(--accent-deep); }
    .tg-pals small { color: var(--ink-dim); }

    /* the steps while it runs: one line each */
    .tg-steps { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; gap: 6px 10px; align-items: center;
                padding: 8px 10px; font-size: 12px; background: var(--surface-2); border: 1px solid var(--line); border-radius: 6px; }
    .tg-light { width: 8px; height: 8px; border-radius: 50%; background: var(--line); }
    .tg-light[data-state="running"] { background: var(--accent); }
    .tg-light[data-state="done"] { background: var(--ok); }
    .tg-light[data-state="failed"] { background: var(--danger); }
    .tg-steps .tg-s { font: 11px 'IBM Plex Mono', ui-monospace, monospace; color: var(--ink-dim); }
    .tg-wait { grid-column: 2 / -1; font-size: 11px; color: var(--ink-dim); }

    /* the verdict */
    .tg-verdict { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 2px 10px; align-items: center;
                  padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-2); }
    .tg-verdict b { font-size: 13px; }
    .tg-verdict[data-tone="fail"] { border-color: var(--danger); }
    .tg-verdict[data-tone="fail"] b { color: var(--danger); }
    .tg-verdict[data-tone="warn"] { border-color: var(--warn); }
    .tg-verdict[data-tone="warn"] b { color: var(--warn); }
    .tg-verdict[data-tone="ok"] b { color: var(--ok); }
    .tg-verdict span { font-size: 12px; color: var(--ink-dim); }
    .tg-tally { font: 11px 'IBM Plex Mono', ui-monospace, monospace; color: var(--ink-dim); white-space: nowrap; }

    /* the items: a row each - verdict, strength, the statement, what was seen, the palette */
    .tg-items { min-height: 0; overflow-y: auto; border: 1px solid var(--line); border-radius: 6px; }
    .tg-row { display: grid; grid-template-columns: 74px 56px minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 150px);
              gap: 10px; align-items: baseline; padding: 5px 10px; font-size: 12px; }
    .tg-row + .tg-row { border-top: 1px solid var(--line); }
    .tg-row[data-v="pass"] { color: var(--ink-dim); }
    .tg-v { font: 600 10.5px 'IBM Plex Mono', ui-monospace, monospace; text-transform: uppercase; letter-spacing: .04em; }
    .tg-row[data-v="fail"] .tg-v { color: var(--danger); }
    .tg-row[data-v="unclear"] .tg-v, .tg-row[data-v="unchecked"] .tg-v { color: var(--warn); }
    .tg-row[data-v="pass"] .tg-v { color: var(--ok); }
    .tg-st { font: 10.5px 'IBM Plex Mono', ui-monospace, monospace; color: var(--ink-dim); }
    .tg-why { color: var(--ink-dim); overflow-wrap: anywhere; }
    .tg-pal { color: var(--ink-dim); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; }
    .tg-more { width: 100%; padding: 5px 10px; font: inherit; font-size: 11px; color: var(--ink-dim); text-align: left;
               background: none; border: 0; border-top: 1px solid var(--line); cursor: pointer; }
    .tg-more:hover { color: var(--ink); background: var(--hover); }
    .tg-err { font-size: 12px; color: var(--danger); overflow-wrap: anywhere; }

    .tg-row-btns { display: flex; justify-content: flex-end; align-items: center; gap: 8px; }
    .tg-row-btns .tg-note { margin-right: auto; font-size: 11px; color: var(--ink-dim); }
    .tg-row-btns .tcv-btn { height: 28px; padding: 0 12px; font-size: 12.5px; }
    .tg-row-btns .tcv-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    @media (max-width: 720px) {
      .tg-row { grid-template-columns: 64px minmax(0, 1fr); }
      .tg-st, .tg-pal { display: none; }
      .tg-why { grid-column: 2; }
    }
  `],
  template: `
@if (cur(); as a) {
<div class="tg-veil tcv-m-veil" animate.leave="tcv-leave" (click)="$event.target === $event.currentTarget && back()">
  <div class="tg-box tcv-m-box" role="dialog" aria-modal="true" aria-labelledby="tg-title" (keydown.escape)="back()">
    <div class="tg-head">
      <h2 id="tg-title">{{ 'Taste check before marking it applied' | t }}</h2>
      <span class="tg-time">{{ clock() }}</span>
      <span class="tg-sub" [title]="a.comment">{{ a.comment }}</span>
    </div>
    @if (check(); as c) {
      <div class="tg-pals">
        <span>{{ 'Palettes' | t }}:</span>
        @for (p of c.palettes; track p.id) {
          <button type="button" (click)="openPalette(p.id)" [title]="'Open it in Taste' | t">{{ p.name }}@if (p.via) { <small> · {{ viaWord(p.via) }}</small> }</button>
        }
      </div>
      @if (running()) {
        <div class="tg-steps" role="status" aria-live="polite">
          @for (s of steps(); track s.id) {
            <i class="tg-light" [attr.data-state]="s.state" aria-hidden="true"></i>
            <span>{{ s.text }}</span>
            <span class="tg-s">{{ s.secs }}</span>
          }
          <span class="tg-wait">{{ 'The check goes on on the server: you can close this and mark it applied later.' | t }}</span>
        </div>
      } @else if (c.status === 'failed') {
        <div class="tg-verdict" data-tone="warn">
          <b>{{ 'The check could not finish' | t }}</b><span class="tg-err">{{ c.error }}</span>
        </div>
      } @else if (c.result; as r) {
        <div class="tg-verdict" [attr.data-tone]="r.verdict === 'fail' ? 'fail' : r.verdict === 'pass' ? 'ok' : 'warn'">
          <b>{{ headline() | t }}</b>
          <span class="tg-tally">{{ tally() }}</span>
          @if (r.notice) { <span style="grid-column: 1 / -1">{{ r.notice }}</span> }
        </div>
        @if (r.items.length) {
          <div class="tg-items">
            @for (i of shown(); track i.palette + i.id) {
              <div class="tg-row" [attr.data-v]="i.verdict">
                <span class="tg-v">{{ verdictWord(i.verdict) | t }}</span>
                <span class="tg-st">{{ i.strength.toUpperCase() }}</span>
                <span>{{ i.text }}@if (i.exception) { <span class="tg-why"> ({{ 'except' | t }}: {{ i.exception }})</span> }</span>
                <span class="tg-why">{{ i.why }}</span>
                <span class="tg-pal" [title]="i.palette_name">{{ i.palette_name }}</span>
              </div>
            }
            @if (hidden(); as n) {
              <button type="button" class="tg-more" (click)="all.set(true)">{{ n }} {{ 'passed - show them' | t }}</button>
            }
          </div>
        }
      }
    } @else if (error()) {
      <div class="tg-verdict" data-tone="warn"><b>{{ 'The check could not start' | t }}</b><span class="tg-err">{{ error() }}</span></div>
    } @else {
      <div class="tg-steps"><i class="tg-light" data-state="running"></i><span>{{ 'Starting the check…' | t }}</span><span></span></div>
    }
    <div class="tg-row-btns">
      @if (check()?.result?.model; as m) { <span class="tg-note">{{ 'judged by' | t }} {{ m }}</span> }
      <button type="button" class="tcv-btn" (click)="back()">{{ (running() ? 'Close' : 'Back') | t }}</button>
      @if (!running()) {
        @if (check() || error()) {
          <button type="button" class="tcv-btn" (click)="again()" [disabled]="busy()">{{ 'Check again' | t }}</button>
        }
        @if (check()?.status === 'done' || check()?.status === 'failed' || error()) {
          <button type="button" class="tcv-btn tcv-btn-accent" (click)="mark(true)" [disabled]="busy()">{{ 'Mark applied anyway' | t }}</button>
        }
      }
    </div>
  </div>
</div>
}`,
})
export class TasteGateHost implements OnDestroy {
  private http = inject(HttpClient);
  private picked = inject(Selection);
  cur = computed(() => asks()[0] ?? null);
  check = signal<TasteCheck | null>(null);
  error = signal<string | null>(null);
  busy = signal(false);
  all = signal(false);
  private tick = signal(Date.now());
  /** The server's clock minus this one, so a running step is timed right. */
  private offset = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private ticker?: ReturnType<typeof setInterval>;
  private shown_: Ask | null = null;

  running = computed(() => { const c = this.check(); return !!c && ACTIVE.includes(c.status); });

  constructor() {
    effect(() => {
      const a = this.cur();
      if (!a || a === this.shown_) return;
      this.shown_ = a;
      untracked(() => this.start(a));
    });
  }

  ngOnDestroy() { clearTimeout(this.timer); clearInterval(this.ticker); }

  private start(a: Ask, fresh = false) {
    this.check.set(null); this.error.set(null); this.all.set(false);
    clearInterval(this.ticker);
    this.ticker = setInterval(() => this.tick.set(Date.now()), 1000);
    // A check that ran already (the box closed while it went on, or one that
    // just failed) is read first: asked again, only when it is not passing.
    const go = () => this.http.post<TasteCheck>(`/api/revisions/${a.id}/taste-check`, {}).subscribe({
      next: c => this.take(a, c), error: (e: HttpErrorResponse) => this.error.set(this.why(e)),
    });
    if (fresh) { go(); return; }
    this.http.get<TasteCheck>(`/api/revisions/${a.id}/taste-check`).subscribe({
      next: c => (c.status === 'none' || c.status === 'failed' || (c.status === 'done' && c.result?.verdict === 'pass')) ? go() : this.take(a, c),
      error: () => go(),
    });
  }

  private take(a: Ask, c: TasteCheck) {
    if (this.cur() !== a) return;
    if (c.status === 'none') { this.mark(false); return; }       // no palette applies (any more)
    this.offset = Date.parse(c.now) - Date.now();
    this.check.set(c);
    clearTimeout(this.timer);
    if (ACTIVE.includes(c.status)) {
      this.timer = setTimeout(() => this.http.get<TasteCheck>(`/api/revisions/${a.id}/taste-check`).subscribe({
        next: n => this.take(a, n), error: () => this.take(a, c),
      }), 2000);
      return;
    }
    clearInterval(this.ticker);
    if (c.status === 'done' && c.result?.verdict === 'pass') {
      Toast.show(t('Taste check passed - marked applied'), { tone: 'ok' });
      this.mark(false);
    }
  }

  /** PATCH it applied; `force` past a check that did not pass. */
  mark(force: boolean) {
    const a = this.cur();
    if (!a) return;
    this.busy.set(true);
    this.http.patch(`/api/revisions/${a.id}?status=applied${force ? '&force=true' : ''}`, {}).subscribe({
      next: () => { this.busy.set(false); this.close(true); },
      error: (e: HttpErrorResponse) => {
        this.busy.set(false);
        if (e.status === 409 && !force) { this.start(a, true); return; }
        Toast.show(this.why(e), { tone: 'danger' });
      },
    });
  }

  again() { const a = this.cur(); if (a) this.start(a, true); }
  back() { if (!this.busy()) this.close(false); }

  private close(marked: boolean) {
    const a = this.cur();
    clearTimeout(this.timer); clearInterval(this.ticker);
    this.check.set(null); this.error.set(null);
    this.shown_ = null;
    asks.update(q => q.slice(1));
    a?.done(marked);
  }

  openPalette(id: string) {
    this.back();
    this.picked.room.set('taste');
    setTimeout(() => this.picked.ask('taste', id), 50);
  }

  private why(e: HttpErrorResponse): string {
    const d = e.error?.detail;
    return typeof d === 'string' ? d : t('Could not reach the server.');
  }

  /** The steps as lines: what is done, what runs, with its time. */
  steps = computed(() => {
    this.tick();
    const c = this.check();
    if (!c) return [];
    const now = Date.now() + this.offset;
    const secs = (s: CheckStep) => s.seconds != null ? `${Math.round(s.seconds)} s`
      : s.started_at ? `${Math.max(0, Math.round((now - Date.parse(s.started_at)) / 1000))} s` : '';
    const rows: { id: string; state: string; text: string; secs: string }[] = [];
    const render = c.steps.find(s => s.id === 'render'), ask = c.steps.find(s => s.id === 'ask');
    rows.push({ id: 'render', state: render?.state ?? (c.status === 'queued' ? 'running' : 'pending'),
                text: t('Rendering the model from {n} views').replace('{n}', String(render?.views?.length ?? 6))
                  + (render?.shots ? ` - ${render.shots} ${t('shots')}` : ''),
                secs: render ? secs(render) : '' });
    rows.push({ id: 'ask', state: ask?.state ?? 'pending',
                text: t('Comparing with the palettes') + (ask?.model ? ` - ${ask.model}` : '')
                  + (ask?.items ? `, ${ask.items} ${t('items')}` : ''),
                secs: ask ? secs(ask) : '' });
    return rows;
  });

  clock = computed(() => {
    this.tick();
    const c = this.check();
    if (!c) return '';
    const s = c.seconds ?? Math.max(0, (Date.now() + this.offset - Date.parse(c.started_at)) / 1000);
    return `${Math.round(s)} s`;
  });

  /** Failing first, then what could not be judged; what passed folded away. */
  sorted = computed(() => [...(this.check()?.result?.items ?? [])].sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict]));
  shown = computed(() => this.all() ? this.sorted() : this.sorted().filter(i => i.verdict !== 'pass'));
  hidden = computed(() => this.all() ? 0 : this.sorted().length - this.shown().length);
  tally = computed(() => {
    const items = this.check()?.result?.items ?? [];
    const n = (v: Verdict) => items.filter(i => i.verdict === v).length;
    if (items.every(i => i.verdict === 'unchecked')) return `${items.length} ${t('items')}`;
    return `${n('fail')} ${t('fail')} · ${n('unclear')} ${t('unclear')} · ${n('pass')} ${t('pass')}`;
  });
  headline = computed(() => {
    const v = this.check()?.result?.verdict;
    return v === 'fail' ? 'The design does not follow the palette' : v === 'pass' ? 'Passed'
      : 'Nothing could be checked automatically';
  });
  viaWord(folder: string) { return t('via {f}').replace('{f}', folder + '/'); }
  verdictWord(v: Verdict) { return v === 'unchecked' ? 'look' : v; }
}
