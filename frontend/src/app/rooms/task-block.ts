import { Component, Injectable, computed, inject, input, output, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Auth } from '../auth';
import { Markdown, TaskBlock } from '../markdown';
import { Selection } from '../selection';
import { T, t } from '../i18n';

/** Which note a task block became: kept on the message by the server
 *  (backend/tasks.py), so the button stays spent after a reload and for
 *  everyone else. `pending` while the note is being filed. */
export interface TaskState {
  note_id?: string; at: string; by?: { id?: string; name?: string };
  room?: string; target?: string; pending?: boolean;
}

interface Target { room: string; id: string; label: string }

/** Each room's queue, as the button names it, and its files' extension. */
const QUEUE: Record<string, { send: string; queued: string; name: string; ext: string }> = {
  cad: { send: 'Send to 3D queue', queued: 'Queued in 3D', name: '3D', ext: '.3d' },
  pcb: { send: 'Send to PCB queue', queued: 'Queued in PCB', name: 'PCB', ext: '.pcb' },
  firmware: { send: 'Send to Firmware queue', queued: 'Queued in Firmware', name: 'Firmware', ext: '.fw' },
};

/** What a task can be attached to, in every room: read once for all the
 *  boxes on screen (again after a minute), so a box can name its target as
 *  the catalog does - "Base.3d" - and say which queue it goes to. */
@Injectable({ providedIn: 'root' })
export class TaskTargets {
  private http = inject(HttpClient);
  all = signal<Target[] | null>(null);
  private at = 0;
  load() {
    if (Date.now() - this.at < 60_000) return;
    this.at = Date.now();
    this.http.get<Target[]>('/api/chat/task-targets').subscribe({
      next: r => this.all.set(r), error: () => { this.at = 0; } });
  }
  find(id: string | null | undefined, room?: string | null): Target | null {
    if (!id) return null;
    return (this.all() ?? []).find(x => x.id === id && (!room || x.room === room)) ?? null;
  }
}

/** A ```task block in a chat (markdown.ts splitTasks), as a box with a
 *  "Send to 3D queue" button and, beside it, what it will be attached to
 *  (click to change). The text is the server's: the button sends only which
 *  block it is, and what the person picked when the block names nothing. */
@Component({
  selector: 'rl-task-block',
  imports: [Markdown, T],
  template: `
<div class="md-task" [attr.data-queued]="done() ? 1 : null">
  <div class="md-task-head">
    <span class="md-task-label">{{ 'Task' | t }}</span>
    @if (block().title) { <b class="md-task-title">{{ block().title }}</b> }
    <button class="md-task-copy" (click)="copy()" [title]="(copied() ? 'Copied' : 'Copy') | t" [attr.aria-label]="'Copy' | t">
      @if (copied()) { <svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7" /></svg> }
      @else { <svg viewBox="0 0 24 24"><path d="M9 9h10v10H9z M5 15V5h10" /></svg> }
    </button>
  </div>
  <div class="md-task-body md" [innerHTML]="block().body | md"></div>
  @if (block().closed) {
    <div class="md-task-foot">
      @if (done(); as d) {
        @if (d.pending) {
          <span class="md-task-done">{{ 'Sending…' | t }}</span>
        } @else {
          <button class="tcv-btn" disabled>{{ queuedLabel(d.room) | t }}</button>
          <span class="md-task-done">{{ fileName(d.target, d.room) }} ·
            <a class="md-task-link" [href]="'?rev=' + d.note_id" (click)="openNote($event, d)"
               [title]="('open the note' | t) + ' ' + d.note_id">#{{ short(d.note_id) }}</a>
            · {{ stamp(d.at) }}@if (d.by?.name) { · {{ d.by!.name }} }</span>
        }
      } @else if (picking()) {
        <select class="tcv-field md-task-pick" [value]="choice()" (change)="choice.set($any($event.target).value)"
                [attr.aria-label]="'what this task is about' | t">
          <option value="">{{ 'pick what it is about…' | t }}</option>
          @for (g of groups(); track g.room) {
            <optgroup [label]="queueName(g.room)">
              @for (o of g.items; track o.id) {
                <option [value]="o.room + '|' + o.id" [selected]="choice() === o.room + '|' + o.id">{{ fileName(o.id, o.room) }}</option>
              }
            </optgroup>
          }
        </select>
        <button class="tcv-btn tcv-btn-accent" [disabled]="!choice() || busy()" (click)="send(choice())">
          {{ sendLabel(choiceRoom()) | t }}</button>
        <button class="tcv-cc-textbtn" (click)="picking.set(false)">{{ 'Cancel' | t }}</button>
      } @else {
        <button class="tcv-btn tcv-btn-accent" [disabled]="busy() || !auth.can('run')" (click)="start()"
                [title]="auth.why('run') ?? ('file this as a queued note' | t)">{{ (busy() ? 'Sending…' : sendLabel(dest()?.room)) | t }}</button>
        <button class="md-task-target" (click)="openPicker()" [disabled]="!auth.can('run')"
                [title]="'what the note is about - click to change' | t">→ {{ dest() ? fileName(dest()!.id, dest()!.room) : ('pick what it is about…' | t) }}</button>
      }
      @if (error(); as e) { <span class="md-task-err" role="alert">{{ e }}</span> }
    </div>
  }
</div>`,
})
export class TaskBlockView {
  private http = inject(HttpClient);
  private sel = inject(Selection);
  private known = inject(TaskTargets);
  auth = inject(Auth);

  block = input.required<TaskBlock>();
  /** Where the queue route for this block is (backend/tasks.py). */
  url = input.required<string>();
  /** The server's word on this block, from the message. */
  state = input<TaskState | null | undefined>(null);
  /** The thread's room; null in an AI conversation, which has none. */
  room = input<string | null>(null);
  queued = output<TaskState>();

  private mine = signal<TaskState | null>(null);
  done = computed(() => this.state() ?? this.mine());
  busy = signal(false);
  error = signal<string | null>(null);
  picking = signal(false);
  choice = signal('');
  copied = signal(false);
  /** Picked in the picker: where it goes, instead of the block's own. */
  private picked = signal<Target | null>(null);

  constructor() { this.known.load(); }

  /** What is open in the thread's room: used only when the block names
   *  nothing that exists (the server checks it again). */
  hint = computed(() => {
    const r = this.room();
    return r === 'cad' ? this.sel.model() : r === 'pcb' ? this.sel.board() : r === 'firmware' ? this.sel.firmware() : null;
  });
  /** Where it will go: what was picked, else the block's own target, else
   *  what is open in the room. */
  dest = computed<Target | null>(() => {
    const p = this.picked();
    if (p) return p;
    const room = this.room();
    const own = this.known.find(this.block().target, room);
    if (own) return own;
    const h = this.hint();
    if (room && h) return this.known.find(h, room) ?? { room, id: h, label: h };
    return null;
  });
  choiceRoom = computed(() => this.choice().split('|')[0] || this.room());
  groups = computed(() => {
    const room = this.room();
    const by = new Map<string, Target[]>();
    for (const o of this.known.all() ?? []) if (!room || o.room === room) by.set(o.room, [...(by.get(o.room) ?? []), o]);
    return [...by].map(([r, items]) => ({ room: r, items }));
  });

  sendLabel(room?: string | null) { return QUEUE[room ?? '']?.send ?? 'Send to queue'; }
  queuedLabel(room?: string | null) { return QUEUE[room ?? '']?.queued ?? 'Queued'; }
  queueName(room: string) { return QUEUE[room]?.name ?? room; }
  /** As the catalog names it: "Base.3d", "controller.pcb". */
  fileName(id?: string | null, room?: string | null) {
    if (!id) return '';
    const label = this.known.find(id, room)?.label ?? id.split('/').pop() ?? id;
    return label + (QUEUE[room ?? '']?.ext ?? '');
  }
  short(id?: string) { return (id ?? '').split('-').pop() ?? ''; }
  stamp(iso: string) {
    const d = new Date(iso);
    return isNaN(+d) ? '' : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  copy() {
    const b = this.block();
    navigator.clipboard?.writeText(b.title ? `${b.title}\n\n${b.body}` : b.body).then(() => {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1500);
    }, () => {});
  }

  start() {
    const d = this.dest();
    if (!d) { this.openPicker(); return; }
    // The block's own target goes from the stored text; anything else is sent.
    this.send(!this.picked() && this.block().target === d.id ? '' : `${d.room}|${d.id}`);
  }

  openPicker() {
    this.error.set(null);
    this.known.load();
    const d = this.dest();
    this.choice.set(d ? `${d.room}|${d.id}` : '');
    this.picking.set(true);
  }

  send(choice: string) {
    const [room, ...rest] = choice ? choice.split('|') : [''];
    const target = rest.join('|');
    const body: Record<string, string> = {};
    if (target) body['target'] = target;
    if (room && !this.room()) body['room'] = room;
    if (target) this.picked.set(this.known.find(target, room) ?? { room, id: target, label: target });
    this.busy.set(true);
    this.error.set(null);
    this.http.post<{ task: TaskState }>(this.url(), body).subscribe({
      next: r => { this.busy.set(false); this.picking.set(false); this.mine.set(r.task); this.queued.emit(r.task); },
      error: (e: HttpErrorResponse) => {
        this.busy.set(false);
        const d = e.error?.detail;
        if (e.status === 409 && d?.task) { this.mine.set(d.task); this.queued.emit(d.task); return; }
        if (e.status === 422 && d?.need_target) { this.picked.set(null); this.openPicker(); return; }
        this.error.set(typeof d === 'string' ? d : d?.message ?? t('could not queue it'));
      },
    });
  }

  /** The note, in its room: the model, board or firmware it is about. */
  openNote(e: MouseEvent, d: TaskState) {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    const target = d.target ?? '';
    if (d.room === 'pcb') this.sel.openBoard(target);
    else if (d.room === 'firmware') this.sel.openFirmware(target);
    else { this.sel.room.set('cad'); if (target) this.sel.ask('model', target); }
  }
}
