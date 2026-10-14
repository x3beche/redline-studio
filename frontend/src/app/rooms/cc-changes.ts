import { HttpClient } from '@angular/common/http';
import { Component, Injectable, computed, effect, inject, input, output, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { T, t } from '../i18n';
import { Toast } from '../toast';
import { toolIcon } from './cc-tools';
import type { CcMessage, CcStep } from './commandcode';

/** What a tool changed, as GET /api/cc/chats/{id}/changes gives it
 *  (backend/chat_undo.py): one a step of an answer. */
export interface CcChange {
  id: string; step: string; tool: string; level: string; say: string; vars: Record<string, string | number>;
  by: { id?: string; name?: string }; at: string; failed: boolean; n: number;
  things: { kind: string; name: string; op: 'added' | 'removed' | 'changed'; fields?: string[] }[];
  undone: { at: string; by: { name?: string } } | null; redone: { at: string } | null;
  /** Why it cannot be undone ("" - it can). */
  why: string;
  /** Whether I have the rights it needed. */
  may: boolean;
}
/** Why an undo did not go: what changed since, field by field. */
export interface CcConflict {
  id: string; why: string; rows: { kind: string; name: string; field?: string; then?: string; now?: string; why: string }[];
}
interface Answer { done: string[]; conflict: CcConflict | null; changes: CcChange[] }

const HEADERS = { 'Content-Type': 'application/json', 'X-Redline-CSRF': '1' };
const UNDO = 'M9 14L4 9l5-5 M4 9h10.5a5.5 5.5 0 0 1 0 11H11';
const REDO = 'M15 14l5-5-5-5 M20 9H9.5a5.5 5.5 0 0 0 0 11H13';
const CHEVRON = 'M10 7l5 5-5 5';
/** A thing's fate, as the page says it ('removed' alone is another sentence's word). */
const OPS = { added: 'added', removed: 'taken out', changed: 'changed' } as const;
const CLOSE = 'M6 6l12 12 M18 6L6 18';

/** The conversations' changes, loaded once each and again after an answer
 *  that wrote something or an undo. */
@Injectable({ providedIn: 'root' })
export class CcChanges {
  private http = inject(HttpClient);
  private lists = signal<Record<string, CcChange[]>>({});
  private loading = new Set<string>();
  private asked = new Map<string, string>();
  readonly busy = signal(false);
  /** The last undo that did not go, per conversation: shown under its change. */
  private conflicts = signal<Record<string, CcConflict | null>>({});
  conflictOf(cid: string): CcConflict | null { return this.conflicts()[cid] ?? null; }
  dismiss(cid: string) { this.conflicts.update(m => ({ ...m, [cid]: null })); }

  of(cid: string): CcChange[] { return this.lists()[cid] ?? []; }

  load(cid: string) {
    if (this.loading.has(cid)) return;
    this.loading.add(cid);
    this.http.get<{ changes: CcChange[] }>(`/api/cc/chats/${cid}/changes`).subscribe({
      next: r => { this.set(cid, r.changes); this.loading.delete(cid); },
      error: () => this.loading.delete(cid),
    });
  }

  /** Steps that wrote something whose changes are not here yet: load them (once for this set). */
  want(cid: string, steps: CcStep[] | undefined) {
    const writing = (steps ?? []).filter(s => s.level !== 'read' && s.status !== 'denied' && s.status !== 'running' && s.status !== 'ask');
    if (!writing.length) return;
    const have = new Set(this.of(cid).map(c => c.step));
    const key = writing.map(s => s.id).join(',');
    if (writing.every(s => have.has(s.id)) || this.asked.get(cid + key)) return;
    this.asked.set(cid + key, '1');
    this.load(cid);
  }

  private set(cid: string, list: CcChange[]) { this.lists.update(m => ({ ...m, [cid]: list })); }

  /** Undo these (newest first on the server); a conflict comes back to be shown. */
  async undo(cid: string, ids: string[]): Promise<CcConflict | null> {
    return this.go(cid, `/api/cc/chats/${cid}/changes/undo`, { ids });
  }
  async redo(cid: string, id: string): Promise<CcConflict | null> {
    return this.go(cid, `/api/cc/chats/${cid}/changes/${id}/redo`, {});
  }
  private async go(cid: string, url: string, body: object): Promise<CcConflict | null> {
    this.busy.set(true);
    this.dismiss(cid);
    try {
      const r = await firstValueFrom(this.http.post<Answer>(url, body, { headers: HEADERS }));
      this.set(cid, r.changes);
      this.conflicts.update(m => ({ ...m, [cid]: r.conflict }));
      if (r.done.length && !r.conflict) Toast.show(t(r.done.length === 1 ? 'Undone' : 'Undone: {n} changes').replace('{n}', String(r.done.length)));
      return r.conflict;
    } catch (e: any) {
      Toast.show(e?.error?.detail ?? t('Something went wrong.'), { tone: 'danger' });
      return null;
    } finally {
      this.busy.set(false);
    }
  }
}

/** A change's sentence: the step's, translated, its holes filled. */
export function changeLine(c: CcChange): string {
  const v = c.vars ?? {};
  return t(c.say || c.tool).replace(/\{(\w+)\}/g, (m, k) => v[k] != null && v[k] !== '' ? String(v[k]) : m);
}
/** What it touched, in a few words: "stock line M3 screw added". */
export function thingsLine(c: CcChange, most = 3): string {
  const parts = c.things.slice(0, most).map(x =>
    `${t(x.kind)} ${x.name ? '“' + x.name + '”' : ''} ${t(OPS[x.op])}${shown(x.fields).length ? ' (' + shown(x.fields).join(', ') + ')' : ''}`.replace(/\s+/g, ' ').trim());
  return parts.join(' · ') + (c.things.length > most ? ` · +${c.things.length - most}` : '');
}
/** A change's fields as the page says them: its log is what any change writes. */
function shown(fields?: string[]): string[] { return (fields ?? []).filter(f => f !== 'log'); }
function clock(iso: string): string {
  const d = new Date(iso);
  return isNaN(+d) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** The rows of some changes, each with its Undo (or Redo), and a conflict
 *  under the one it stopped at, its fields shown on "Show". */
@Component({
  selector: 'rl-cc-change-rows',
  standalone: true,
  imports: [T],
  styleUrls: ['./cc-changes.css'],
  template: `
    @for (c of list(); track c.id) {
      <div class="ccx-row" [class.ccx-undone]="c.undone">
        <svg class="ccx-ico" viewBox="0 0 24 24"><path [attr.d]="icon(c.tool)" /></svg>
        <span class="ccx-what" [title]="line(c)">{{ line(c) }}</span>
        <span class="ccx-things" [title]="things(c, 40)">{{ things(c) }}</span>
        <span class="ccx-meta">{{ c.by.name || ('someone' | t) }} · {{ when(c.at) }}</span>
        @if (c.undone) {
          <span class="ccx-state">{{ 'Undone by' | t }} {{ c.undone.by.name || ('someone' | t) }}</span>
          @if (c.may && !c.why) {
            <button class="ccx-act" (click)="redo(c)" [disabled]="store.busy()">{{ 'Redo' | t }}</button>
          }
        } @else if (c.why) {
          <span class="ccx-state" [title]="c.why | t">{{ c.why | t }}</span>
        } @else if (!c.may) {
          <span class="ccx-state" [title]="'Undoing it needs the rights it needed' | t">{{ 'Not yours to undo' | t }}</span>
        } @else {
          <button class="ccx-act" (click)="undo([c.id])" [disabled]="store.busy()">{{ 'Undo' | t }}</button>
        }
      </div>
      @if (store.conflictOf(cid())?.id === c.id) {
        @let cf = store.conflictOf(cid())!;
        <div class="ccx-conflict" role="alert">
          <span>{{ 'Not undone' | t }}: {{ conflictLine(cf) }}</span>
          @if (cf.rows.length) {
            <button class="ccx-act" (click)="showing.set(!showing())" [attr.aria-expanded]="showing()">{{ (showing() ? 'Hide' : 'Show') | t }}</button>
          }
          <button class="ccx-act" (click)="store.dismiss(cid())">{{ 'Dismiss' | t }}</button>
        </div>
        @if (showing()) {
          <dl class="ccx-diff">
            @for (r of cf.rows; track $index) {
              <dt>{{ r.kind | t }} {{ r.name ? '“' + r.name + '”' : '' }}{{ r.field ? ' · ' + r.field : '' }}</dt>
              <dd>@if (r.then != null || r.now != null) {
                <span class="ccx-then">{{ r.then }}</span> <span class="ccx-arrow">→</span> <span>{{ r.now }}</span>
              } @else { {{ r.why | t }} }</dd>
            }
          </dl>
        }
      }
    }
  `,
})
export class CcChangeRows {
  store = inject(CcChanges);
  cid = input.required<string>();
  list = input.required<CcChange[]>();
  showing = signal(false);
  icon = toolIcon;
  line = changeLine;
  things = thingsLine;
  when = clock;
  undo(ids: string[]) {
    this.showing.set(false);
    this.store.undo(this.cid(), ids);
  }
  redo(c: CcChange) { this.store.redo(this.cid(), c.id); }
  conflictLine(cf: CcConflict): string {
    const r = cf.rows[0];
    if (!r) return t(cf.why);
    const what = `${t(r.kind)}${r.name ? ' “' + r.name + '”' : ''}`;
    return `${what} ${t(r.why)}` + (cf.rows.length > 1 ? ` (+${cf.rows.length - 1})` : '');
  }
}

/** Under an answer that changed things: "Changed: 3 things · Undo", its
 *  rows on a click. Nothing for an answer that changed nothing. */
@Component({
  selector: 'rl-cc-changed',
  standalone: true,
  imports: [T, CcChangeRows],
  styleUrls: ['./cc-changes.css'],
  template: `
    @if (mine().length) {
      <div class="ccx-line">
        <svg class="ccx-ico" viewBox="0 0 24 24"><path [attr.d]="UNDO" /></svg>
        <button class="ccx-toggle" (click)="open.set(!open())" [attr.aria-expanded]="open()">
          @if (live().length) {
            {{ 'Changed' | t }}: {{ count(live()) }} {{ (count(live()) === 1 ? 'thing' : 'things') | t }}
          } @else {
            {{ 'Undone' | t }}: {{ count(mine()) }} {{ (count(mine()) === 1 ? 'thing' : 'things') | t }}
          }
          @if (live().length && live().length < mine().length) {
            <span class="ccx-dim">· {{ mine().length - live().length }} {{ 'undone' | t }}</span>
          }
          <svg class="ccx-chev" [class.ccx-open]="open()" viewBox="0 0 24 24"><path [attr.d]="CHEVRON" /></svg>
        </button>
        @if (undoable().length) {
          <span class="ccx-dim">·</span>
          <button class="ccx-act" (click)="undoAll()" [disabled]="store.busy()"
                  [title]="'Undo all from this answer' | t">{{ 'Undo' | t }}</button>
        }
      </div>
      @if (open() || stopped()) {
        <div class="ccx-under">
          <rl-cc-change-rows [cid]="cid()" [list]="mine()" />
        </div>
      }
    }
  `,
})
export class CcChanged {
  store = inject(CcChanges);
  cid = input.required<string>();
  steps = input<CcStep[] | undefined>();
  open = signal(false);
  UNDO = UNDO; CHEVRON = CHEVRON;
  mine = computed(() => {
    const ids = new Set((this.steps() ?? []).map(s => s.id));
    return this.store.of(this.cid()).filter(c => ids.has(c.step));
  });
  live = computed(() => this.mine().filter(c => !c.undone));
  undoable = computed(() => this.live().filter(c => !c.why && c.may));
  /** An undo stopped at one of mine: its rows are shown with why. */
  stopped = computed(() => { const id = this.store.conflictOf(this.cid())?.id; return !!id && this.mine().some(c => c.id === id); });
  constructor() {
    effect(() => this.store.want(this.cid(), this.steps()));
  }
  count(list: CcChange[]) { return list.reduce((n, c) => n + Math.max(1, c.n), 0); }
  undoAll() { this.store.undo(this.cid(), this.undoable().map(c => c.id)); }
}

/** Everything the tools changed in this conversation, by answer, with
 *  "Undo all from this answer" for each (the header menu's "Changes"). */
@Component({
  selector: 'rl-cc-changes',
  standalone: true,
  imports: [T, CcChangeRows],
  styleUrls: ['./cc-changes.css'],
  template: `
    <div class="ccx-veil tcv-m-veil" animate.leave="tcv-leave" (click)="close.emit()"></div>
    <aside class="ccx-panel tcv-m-panel-r" animate.leave="tcv-leave" role="dialog" aria-modal="true" [attr.aria-label]="'Changes made' | t"
           (keydown.escape)="close.emit()">
      <header class="ccx-head">
        <h2>{{ 'Changes made' | t }}</h2>
        <span class="ccx-dim">{{ heading() }}</span>
        <button class="ccx-x" (click)="close.emit()" [title]="'Close' | t">
          <svg viewBox="0 0 24 24"><path [attr.d]="CLOSE" /></svg></button>
      </header>
      <div class="ccx-body">
        @for (g of groups(); track g.key) {
          <section class="ccx-group">
            <div class="ccx-ghead">
              <span class="ccx-gtitle">{{ g.title }}</span>
              <span class="ccx-dim">{{ g.list.length }} {{ (g.list.length === 1 ? 'change' : 'changes') | t }}</span>
              @if (g.undoable.length > 1) {
                <button class="ccx-act" (click)="undoAll(g.undoable)" [disabled]="store.busy()">{{ 'Undo all from this answer' | t }}</button>
              }
            </div>
            <rl-cc-change-rows [cid]="cid()" [list]="g.list" />
          </section>
        } @empty {
          <p class="ccx-empty">{{ 'The tools have changed nothing in this conversation yet.' | t }}</p>
        }
      </div>
    </aside>
  `,
})
export class CcChangesPanel {
  store = inject(CcChanges);
  cid = input.required<string>();
  messages = input<CcMessage[]>([]);
  close = output<void>();
  CLOSE = CLOSE;
  constructor() {
    effect(() => this.store.load(this.cid()));
  }
  heading = computed(() => {
    const all = this.store.of(this.cid());
    const undone = all.filter(c => c.undone).length;
    return `${all.length} ${t(all.length === 1 ? 'change' : 'changes')}` + (undone ? ` · ${undone} ${t('undone')}` : '');
  });
  /** The changes by the answer whose step made them, newest answer first. */
  groups = computed(() => {
    const where = new Map<string, CcMessage>();
    for (const m of this.messages()) for (const s of m.steps ?? []) where.set(s.id, m);
    const out = new Map<string, { key: string; title: string; at: string; list: CcChange[]; undoable: CcChange[] }>();
    for (const c of this.store.of(this.cid())) {
      const m = where.get(c.step);
      const key = m?.id ?? 'gone';
      if (!out.has(key)) {
        out.set(key, { key, at: m?.at ?? c.at, list: [], undoable: [],
                       title: m ? `${t('Answer')} · ${clock(m.at)}${m.model ? ' · ' + m.model.split('/').pop() : ''}` : t('An answer no longer in the conversation') });
      }
      const g = out.get(key)!;
      g.list.push(c);
      if (!c.undone && !c.why && c.may) g.undoable.push(c);
    }
    return [...out.values()].sort((a, b) => b.at.localeCompare(a.at));
  });
  undoAll(list: CcChange[]) { this.store.undo(this.cid(), list.map(c => c.id)); }
}
