import { Component, ElementRef, Injectable, OnDestroy, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Selection } from '../selection';
import { Auth } from '../auth';
import { T, t } from '../i18n';

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

export const DOMAINS: { id: Domain; label: string; short: string }[] = [
  { id: 'mechanical', label: 'Mechanical', short: 'Mech' }, { id: 'pcb', label: 'PCB', short: 'PCB' },
  { id: 'firmware', label: 'Firmware', short: 'FW' }, { id: 'general', label: 'General', short: 'Gen' },
];
export const STRENGTHS: { id: Strength; label: string }[] = [
  { id: 'must', label: 'MUST' }, { id: 'prefer', label: 'PREFER' }, { id: 'avoid', label: 'AVOID' },
];
const KIND_NAME: Record<string, string> = { folder: 'Folder', model: '3D model', board: 'Board', firmware: 'Firmware' };

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
  attach(id: string, attached: { kind: string; id: string }[]) {
    return this.http.put<Palette>(`/api/taste/${id}/attached`, { attached });
  }
  /** Models, boards and firmware; with `folders`, the folders too (extraction reads a folder whole). */
  projects(q = '', folders = false) {
    return this.http.get<ProjectRef[]>(`/api/taste/projects?q=${encodeURIComponent(q)}${folders ? '&folders=1' : ''}`);
  }
  extract(kind: string, id: string) {
    return this.http.post<{ project: ProjectRef; proposals: TasteItem[]; provider: string; model: string }>(
      '/api/taste/extract', { kind, id });
  }
}

function when(iso: string): string {
  const d = new Date(iso), now = new Date();
  const days = Math.floor((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86400000);
  if (days === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function why(e: HttpErrorResponse, fallback: string): string {
  return typeof e.error?.detail === 'string' ? e.error.detail : t(fallback);
}

/** The Taste room. */
@Component({
  selector: 'app-room-taste',
  imports: [T],
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
      </div>
    }
    <div class="tcv-notes-list">
      @for (p of palettes(); track p.id) {
        <button class="tcv-notes-item" [attr.data-on]="p.id === openId() && mode() === 'palette' ? 1 : null" (click)="openPalette(p.id)">
          <span class="tcv-notes-item-top">
            @if (p.pinned) { <span class="tcv-notes-pin" [title]="'Pinned' | t">●</span> }
            <span class="tcv-notes-item-title">{{ p.name }}</span>
            <span class="tcv-notes-item-when">{{ p.items.length }} {{ (p.items.length === 1 ? 'item' : 'items') | t }}</span>
          </span>
          <span class="tcv-notes-item-meta tst-counts">
            @for (d of domains; track d.id) {
              @if (p.counts[d.id]) { <span>{{ d.short | t }} <b>{{ p.counts[d.id] }}</b></span> }
            }
            @if (p.attached.length) { <span class="tst-on">{{ fmt('on {p}', { p: attachedLine(p) }) }}</span> }
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
          <span class="st-sub">{{ 'A model reads the project and proposes statements; nothing is kept until you save it.' | t }}</span>
        </div>
        <div class="tst-acts">
          <span class="tst-pickwrap" (click)="$event.stopPropagation()">
            <button class="tcv-btn" (click)="openPicker('extract')" [disabled]="exBusy()">
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
          <button class="tcv-btn tcv-btn-accent" (click)="runExtract()" [disabled]="!exProject() || exBusy()">
            {{ (exBusy() ? 'Reading…' : proposals().length ? 'Run again' : 'Run') | t }}</button>
          <button class="tcv-btn" (click)="leaveExtract()">{{ 'Close' | t }}</button>
        </div>
      </header>
      @if (exError(); as e) { <div class="st-banner tst-banner" role="alert">{{ e }}</div> }
      @if (exBusy()) {
        <p class="st-hint">{{ exProject()?.kind === 'folder'
              ? fmt('Reading every model, board and firmware in {p} and asking the model. This takes a few minutes.', { p: exProject()?.label ?? '' })
              : fmt('Reading {p} - its source, checks, notes and drawn notes - and asking the model. This takes up to a minute.', { p: exProject()?.label ?? '' }) }}</p>
      }
      @if (proposals().length) {
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
      } @else if (!exBusy() && !exError()) {
        <p class="st-hint">{{ 'Choose a finished model, board or firmware and run. Its proposals appear here by domain, to accept, edit or reject one by one.' | t }}</p>
      }
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
            <button class="tcv-btn" (click)="pin(p)">{{ (p.pinned ? 'Unpin' : 'Pin') | t }}</button>
            <button class="tcv-btn tst-del" (click)="remove(p)">{{ 'Delete' | t }}</button>
          }
        </div>
      </header>
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
            <div class="tst-col" (dragover)="dragOver($event)" (drop)="dropOn($event, p, c.id, null)">
              <div class="tst-col-head"><h3>{{ c.label | t }}</h3><span class="st-sub">{{ c.items.length }}</span></div>
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
      <div class="tst-empty">
        <p>{{ 'Taste palettes are what makes a design good, as statements the AI follows: attach one to a project, or mention it in Chat.' | t }}</p>
        @if (can()) {
          <div class="tst-acts">
            <button class="tcv-btn tcv-btn-accent" (click)="newPalette()">{{ 'New palette' | t }}</button>
            <button class="tcv-btn" (click)="startExtract(); $event.stopPropagation()">{{ 'Extract from project…' | t }}</button>
          </div>
        }
      </div>
    }
  </section>
</div>`,
})
export class RoomTaste implements OnDestroy {
  private api = inject(TasteApi);
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
  exBusy = signal(false);
  exError = signal<string | null>(null);
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
    this.api.list(this.q()).subscribe(ps => {
      this.palettes.set(ps);
      if (!this.openId() && ps.length && !this.q() && this.mode() === 'palette') this.openId.set(ps[0].id);
    });
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

  // ---- extraction

  startExtract() {
    this.mode.set('extract');
    this.editId.set(null);
    const p = this.open();
    if (!this.exProject() && p?.attached.length) this.exProject.set(p.attached[0]);
    if (p) this.saveTo.set(p.id);
    if (!this.exProject()) setTimeout(() => this.openPicker('extract'));
  }
  leaveExtract() { this.mode.set('palette'); this.picker.set(null); }

  runExtract() {
    const pr = this.exProject();
    if (!pr || this.exBusy()) return;
    this.exBusy.set(true);
    this.exError.set(null);
    this.api.extract(pr.kind, pr.id).subscribe({
      next: r => {
        this.exBusy.set(false);
        this.exModel.set(r.model);
        this.proposals.set(r.proposals.map(i => ({ ...i, keep: true })));
        if (!this.saveTo() && !this.newName()) this.newName.set(this.fmt('Taste of {p}', { p: r.project.label }));
      },
      error: (e: HttpErrorResponse) => { this.exBusy.set(false); this.exError.set(why(e, 'The extraction failed.')); },
    });
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
    const req = to ? this.api.add(to, items) : this.api.create(this.newName().trim(), items);
    req.subscribe({
      next: p => {
        this.saving.set(false);
        this.replace(p);
        this.proposals.set([]);
        this.say(this.fmt('{n} saved to {p}', { n: items.length, p: p.name }));
        this.api.changed.update(v => v + 1);
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
      const list = this.palettes(), i = list.findIndex(p => p.id === this.openId());
      const next = list[Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) { e.preventDefault(); this.openPalette(next.id); }
    }
  }

  ngOnDestroy() { clearInterval(this.poll); clearTimeout(this.timer); clearTimeout(this.pickTimer); }
}
