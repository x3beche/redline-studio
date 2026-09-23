import {
  AfterViewInit, Component, ElementRef, OnDestroy, inject, signal, viewChild,
} from '@angular/core';
import { DecimalPipe, NgTemplateOutlet } from '@angular/common';
const SEED = `"""__NAME__ - a build123d model."""

from build123d import *

TITLE = "__NAME__"

with BuildPart() as part:
    Box(40, 30, 10)
    fillet(part.edges().filter_by(Axis.Z), radius=4)

# Redline reads these two names:
PARTS = [part.part]
NAMES = ["body"]
`;

import { Activity, Analytics, Api, CameraState, Catalog, Chat, ChatLine, Health, LogLine, Question, Questions, Run, Stats, SystemInfo, FolderNode, ModelEntry, ModelVersion,
         Revision, RevisionStatus } from '../api';
import { OcpViewer } from './ocp';

export type Tool = 'pen' | 'line' | 'rect' | 'ellipse' | 'triangle' | 'arrow' | 'text';
type Pt = [number, number];

/** One mark on the overlay. Freehand keeps a point list; the rest are
 *  defined by the drag start and end; text by a point and a string. */
type Mark =
  | { kind: 'pen'; color: string; width: number; pts: Pt[] }
  | { kind: Exclude<Tool, 'pen' | 'text'>; color: string; width: number; a: Pt; b: Pt }
  | { kind: 'text'; color: string; size: number; at: Pt; text: string };

@Component({
  selector: 'app-editor',
  imports: [DecimalPipe, NgTemplateOutlet],
  templateUrl: './editor.html',
})
export class Editor implements AfterViewInit, OnDestroy {
  private api = inject(Api);
  private cat = inject(Catalog);
  private health = inject(Health);
  private activity = inject(Activity);
  private asks = inject(Questions);
  private chat = inject(Chat);
  private host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private overlay = viewChild.required<ElementRef<HTMLCanvasElement>>('overlay');
  private stage = viewChild.required<ElementRef<HTMLDivElement>>('stage');
  private caret = viewChild<ElementRef<HTMLInputElement>>('caret');
  private cadInput = viewChild<ElementRef<HTMLInputElement>>('cadInput');
  private freezeBtn = viewChild<ElementRef<HTMLElement>>('freezeBtn');
  private taskPanel = viewChild<ElementRef<HTMLElement>>('taskPanel');
  private logPanel = viewChild<ElementRef<HTMLElement>>('logPanel');
  private drawTools = viewChild<ElementRef<HTMLElement>>('drawTools');
  private logBox = viewChild<ElementRef<HTMLDivElement>>('logBox');
  private threadBox = viewChild<ElementRef<HTMLDivElement>>('threadBox');

  frozen = signal(false);
  saving = signal(false);
  comment = signal('');
  part = signal('');
  parts = signal<string[]>([]);
  revisions = signal<Revision[]>([]);
  toast = signal('');
  glError = signal('');
  catalog = signal<FolderNode | null>(null);
  activeModel = signal<string>('');
  versions = signal<ModelVersion[]>([]);
  busy = signal('');
  collapsed = signal(false);
  stats = signal<Stats | null>(null);
  log = signal<LogLine[]>([]);
  run = signal<Run | null>(null);
  logOpen = signal(true);
  private builtAt = '';
  private lastRunStatus = '';
  private pendingCamera: string | null = null;
  /** resizeCadView re-frames the scene, so an explicitly set view has to be
   *  re-applied after every resize or it silently springs back.
   *
   *  Tagged with the model it was recorded against: the same numbers over a
   *  different model point at nothing, and this used to survive a model
   *  change and be stamped onto whatever loaded next. */
  private heldCamera: CameraState | null = null;
  private heldModel: string | null = null;
  /** Where the 3D area starts inside the stage. The cards that announce
   *  something belong over the model, not over the viewer's toolbar - and
   *  the toolbar's height is not a number we get to assume. */
  viewTop = signal(0);
  /** One revision lookup at a time, so the retries above do not each start
   *  their own and open the same model three times over. */
  private focusing = false;
  /** The revision whose view is being held, shown over the scene. */
  focused = signal<Revision | null>(null);
  notice = signal<{ id: string | null; title: string;
                    secs: number; ok: boolean } | null>(null);
  preview = signal<Revision | null>(null);
  editing = signal<string | null>(null);
  showArchived = signal(false);
  autoArchive = signal(false);
  autoTranslate = signal(false);
  collapsed_ = signal<Set<string>>(new Set());
  editText = signal('');
  editPart = signal('');
  editSummary = signal('');
  sys = signal<SystemInfo | null>(null);
  /** What the agent is waiting on, and what is being typed back. */
  questions = signal<Question[]>([]);
  thread = signal<ChatLine[]>([]);
  saying = signal('');
  /** Whether what is typed next goes as urgent: read between the agent's
   *  steps rather than when it next looks up. Sticks, because somebody
   *  who wants one thing seen promptly usually wants the next one too. */
  urgent = signal(false);
  chatOpen = signal(true);
  answerText = signal('');
  answerPicked = signal<Set<string>>(new Set());
  notifyState = signal<'unsupported' | 'default' | 'granted' | 'denied'>('default');
  private askedAlready = new Set<string>();
  private plainTitle = 'Redline';
  /* theme:pigment - a mark's colour is written into the revision and
     printed into the picture, so it must mean the same thing in every
     theme and on paper. These four are ink, not chrome, and are the one
     place in the application allowed a literal. */
  readonly PENS = ['#cc3333', '#5c8a5c', '#53a0e3', '#e8a735'];
  color = signal('#ff2d3f');            // theme:pigment
  penWidth = signal(4);
  tool = signal<Tool>('pen');
  fontSize = signal(18);
  /** Where the text caret sits, in CSS pixels of the stage, while typing. */
  typing = signal<{ left: number; top: number } | null>(null);
  private typeAt: Pt = [0, 0];

  private viewer?: OcpViewer;
  private frozenShot = '';
  private marks: Mark[] = [];
  private active: Mark | null = null;
  private drawing = false;
  private ro?: ResizeObserver;

  async ngAfterViewInit() {
    const box = this.stage().nativeElement;
    try {
      this.viewer = new OcpViewer(this.host().nativeElement);
      this.viewer.init({ w: Math.max(box.clientWidth - 250, 400),
                         h: Math.max(box.clientHeight, 400) });
    } catch (e) {
      this.glError.set(String((e as Error)?.message ?? e));
      return;
    }
    // Clicking a part in the model fills the Part field on the right.
    this.viewer.onPick(name => {
      if (!name) return;
      const known = this.parts().find(p => p === name)
        ?? this.parts().find(p => name.endsWith(p));
      this.part.set(known ?? name);
      this.flash('part: ' + (known ?? name));
    });
    this.loadCatalog();
    this.loadVersions();
    this.applyUrlCamera();
    this.pollHealth();
    this.loadSettings();
    this.healthTimer = setInterval(() => this.pollHealth(), 2000);
    // Once a second while a run is live: the figures are what the panel is
    // for, and a number that moves once a quarter of a minute reads as a
    // number that is stuck. Reads that find no new transcript bytes are
    // answered from what was already ingested.
    this.pollLiveCost();
    this.costTimer = setInterval(() => this.pollLiveCost(), 1000);
    // Orbiting fires far too often to write on every frame; every couple of
    // seconds is close enough to "where I left it".
    // Started late, so the restore above finishes before anything is written
    // back: otherwise the default camera is saved over the one being put back.
    setTimeout(() => {
      this.viewTimer = setInterval(() => this.rememberView(), 2000);
    }, 2500);
    addEventListener('beforeunload', this.onLeave);
    setTimeout(() => this.sizeOverlay());     // after the viewer DOM settles
    this.ro = new ResizeObserver(() => this.sizeOverlay());
    this.ro.observe(box);
    this.refresh();
  }

  ngOnDestroy() {
    this.ro?.disconnect();
    this.viewer?.dispose();
    clearInterval(this.healthTimer);
    clearInterval(this.costTimer);
    clearInterval(this.viewTimer);
    removeEventListener('beforeunload', this.onLeave);
  }

  private healthTimer: ReturnType<typeof setInterval> | undefined;
  private viewTimer: ReturnType<typeof setInterval> | undefined;
  private onLeave = () => this.rememberView();


  pollHealth() {
    this.health.stats().subscribe({ next: v => this.stats.set(v), error: () => {} });
    this.asks.open().subscribe({ next: v => this.takeQuestions(v), error: () => {} });
    this.chat.history().subscribe({ next: v => this.takeThread(v), error: () => {} });
    this.health.system().subscribe({ next: v => this.sys.set(v), error: () => {} });
    this.activity.run().subscribe({
      next: v => {
        const was = this.lastRunStatus;
        const before = this.run()?.revision;
        this.run.set(v);
        this.lastRunStatus = v?.status ?? '';
        // The cost poll fires on a twenty-second timer, and its first tick
        // happened while this call was still in flight - so `run` was null,
        // it gave up, and the panel sat empty for twenty seconds. Ask as
        // soon as there is something to ask about.
        if (v?.status === 'running'
            && (v.revision !== before || !this.liveCost())) {
          this.pollLiveCost();
        }
        // When a run completes, swing to the angle the revision was drawn
        // from, so the result is judged from the same viewpoint.
        if (v && was === 'running' && v.status !== 'running') {
          this.showNotice(v);
          if (v.revision) this.focusRevision(v.revision);
        }
      },
      error: () => {},
    });
    this.loadCatalog();
    this.activity.lines().subscribe({
      next: v => {
        // Only follow the tail while the user is already at the bottom, so
        // scrolling back to read something is not yanked away.
        const el = this.logBox()?.nativeElement;
        const atBottom = !el
          || el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        this.log.set(v);
        if (atBottom) {
          setTimeout(() => this.scrollLog());
          setTimeout(() => this.scrollLog(), 120);   // after layout settles
        }
      },
      error: () => {},
    });
  }

  /** Work finishes while the user is looking somewhere else, so say so in
   *  the corner rather than only moving the camera. */
  private showNotice(r: Run) {
    const t1 = r.finished_at ? Date.parse(r.finished_at) : Date.now();
    this.notice.set({
      id: r.revision, title: r.title, ok: r.status === 'done',
      secs: Math.max(0, Math.round((t1 - Date.parse(r.started_at)) / 1000)),
    });
  }

  // Stays until it is dismissed: a notice that vanishes on its own is one
  // the reader misses exactly when they were away from the screen.
  dismissNotice() { this.notice.set(null); }

  /** Run duration, short form. */
  elapsed(s: number): string {
    return s < 60 ? `${s}s`
                  : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  }

  /** Move the freeze control into the viewer's toolbar. Angular still owns
   *  the element - only its parent changes - so the binding and the click
   *  handler carry on working. */
  private dockFreezeButton() {
    const btn = this.freezeBtn()?.nativeElement;
    const bar = this.viewer?.toolbar;
    if (btn && bar && btn.parentElement !== bar) bar.appendChild(btn);

    // The drawing tools go in the same bar, just before the freeze control:
    // they are for marking up what is on screen, so they sit over it.
    const tools = this.drawTools()?.nativeElement;
    if (tools && bar && tools.parentElement !== bar) bar.insertBefore(tools, btn ?? null);

    // The running task goes under the model tree, in the room the tree
    // panel was leaving empty. Always in the DOM, hidden when idle: an
    // @if would destroy it and the docking would have to be redone.
    const task = this.taskPanel()?.nativeElement;
    const tree = this.viewer?.tree;
    if (task && tree && task.parentElement !== tree) tree.appendChild(task);

    // Into the viewer's own body, which is a two-row grid: the tree column
    // spans both rows, the 3D area is the top cell and the log the bottom
    // one. Absolutely positioning it only ever covered the view.
    const log = this.logPanel()?.nativeElement;
    const body = this.viewer?.body;
    if (log && body && log.parentElement !== body) body.appendChild(log);




  }

  /** Keep the newest line in view, the way a terminal does. */
  private scrollLog() {
    const el = this.logBox()?.nativeElement;
    if (el) el.scrollTop = el.scrollHeight;
  }

  toggleLog() {
    this.logOpen.update(v => !v);
    setTimeout(() => this.sizeOverlay(), 60);
    setTimeout(() => this.scrollLog(), 80);
  }

  /** A run is live from the moment work starts until it reports finished. */
  runActive(): boolean { return this.run()?.status === 'running'; }

  levelColor(l: LogLine['level']): string {
    return l === 'error' ? 'var(--danger)'
      : l === 'warn' ? 'var(--warn)'
      : l === 'done' ? 'var(--ok)'
      : l === 'work' ? 'var(--accent)' : 'var(--ink-dim)';
  }

  toggleSidebar() {
    this.collapsed.update(v => !v);
    setTimeout(() => this.sizeOverlay(), 60);   // rescale once the transition ends
  }

  /** The queue folds away the same way the catalog does, for when the model
   *  is what you want the width for. */
  queueShut = signal(false);

  toggleQueue() {
    this.queueShut.update(v => !v);
    setTimeout(() => this.sizeOverlay(), 60);
  }

  gb(n: number): string { return (n / 1e9).toFixed(1) + ' GB'; }

  /** Compact gauges shown while the panel is collapsed. */
  /** The thread, and the one line being typed into it. Scrolled to the
   *  bottom when something lands, the way the log is. */
  private takeThread(rows: ChatLine[]) {
    const grew = rows.length !== this.thread().length;
    this.thread.set(rows);
    if (grew) setTimeout(() => this.scrollThread(), 40);
  }

  private scrollThread() {
    const box = this.threadBox()?.nativeElement;
    if (box) box.scrollTop = box.scrollHeight;
  }

  say() {
    const text = this.saying().trim();
    if (!text) return;
    const urgent = this.urgent();
    // Shown straight away rather than on the next poll: two seconds of
    // nothing looks like the message went nowhere.
    this.thread.update(t => [...t, {
      _id: 'local-' + Date.now(), at: new Date().toISOString(),
      role: 'user' as const, text, urgent, seen_at: null }]);
    this.saying.set('');
    setTimeout(() => this.scrollThread(), 40);
    this.chat.say(text, urgent).subscribe({
      next: () => this.chat.history().subscribe({
        next: v => this.takeThread(v), error: () => {} }),
      error: () => this.flash('could not send that'),
    });
  }

  /** Take a message back. Only offered while it is still unread, and the
   *  server checks that again - the agent may have picked it up in the
   *  second between the card drawing and the click. */
  unsay(m: ChatLine) {
    if (m.seen_at || !this.sent(m)) return;
    this.thread.update(t => t.filter(x => x._id !== m._id));
    this.chat.retract(m._id).subscribe({
      next: () => this.chat.history().subscribe({
        next: v => this.takeThread(v), error: () => {} }),
      error: () => {
        this.flash('too late, the agent already has it');
        this.chat.history().subscribe({
          next: v => this.takeThread(v), error: () => {} });
      },
    });
  }

  /** Whether the server has this line yet. Until it does it has only the
   *  id this window made up, which nothing else would recognise. */
  sent(m: ChatLine): boolean { return !m._id.startsWith('local-'); }

  /** Enter sends, shift+enter keeps typing - it is a line to somebody, not
   *  a document. */
  sayKey(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.say(); }
  }

  /** How many of the person's lines the agent has not picked up. Zero
   *  reads as nothing rather than as a 0. */
  unreadSaid(): number | null {
    const n = this.thread().filter(m => m.role === 'user' && !m.seen_at).length;
    return n || null;
  }

  toggleChat() {
    this.chatOpen.update(v => !v);
    if (this.chatOpen()) setTimeout(() => this.scrollThread(), 40);
  }

  /** A question is the agent standing still, so it has to reach the person
   *  even when the tab is in the background: the title carries it, and the
   *  browser is asked to raise a notice once per question. */
  private takeQuestions(rows: Question[]) {
    const before = this.questions().map(q => q._id).join(',');
    this.questions.set(rows);
    if (rows.map(q => q._id).join(',') === before) return;
    this.answerPicked.set(new Set());

    document.title = rows.length ? `● ${rows.length} question${rows.length === 1 ? '' : 's'} · ${this.plainTitle}`
                                 : this.plainTitle;
    if (!('Notification' in window)) { this.notifyState.set('unsupported'); return; }
    this.notifyState.set(Notification.permission as 'default' | 'granted' | 'denied');
    if (Notification.permission !== 'granted') return;
    for (const q of rows) {
      if (this.askedAlready.has(q._id)) continue;
      this.askedAlready.add(q._id);
      try {
        const n = new Notification('Redline needs an answer', {
          body: q.text.slice(0, 180), tag: q._id, icon: '/favicon.svg',
        });
        n.onclick = () => { window.focus(); n.close(); };
      } catch { /* the browser refused; the card still shows it */ }
    }
  }

  /** Permission cannot be asked for out of the blue - browsers want a
   *  gesture - so the card offers it and this runs on the click. */
  async enableNotices() {
    if (!('Notification' in window)) return;
    try {
      this.notifyState.set(await Notification.requestPermission() as any);
    } catch { /* ignore */ }
  }

  pickOption(q: Question, opt: string) {
    const next = new Set(q.multi ? this.answerPicked() : []);
    if (next.has(opt)) next.delete(opt); else next.add(opt);
    this.answerPicked.set(next);
    if (!q.multi) this.sendAnswer(q, opt);
  }

  /** Whatever was typed wins over whatever was clicked: an option list is a
   *  convenience, and the real answer is often "neither, because...". */
  sendAnswer(q: Question, chosen?: string) {
    const typed = this.answerText().trim();
    const picked = [...this.answerPicked()].join(', ');
    const answer = typed || chosen || picked;
    if (!answer) return;
    this.asks.answer(q._id, answer).subscribe({
      next: () => {
        this.answerText.set('');
        this.answerPicked.set(new Set());
        this.questions.update(list => list.filter(x => x._id !== q._id));
        if (!this.questions().length) document.title = this.plainTitle;
        this.flash('answered');
      },
      error: () => this.flash('could not send the answer'),
    });
  }

  gauges(): { key: string; short: string; pct: number; tip: string }[] {
    const st = this.stats(), m = this.sys();
    const out: { key: string; short: string; pct: number; tip: string }[] = [];
    if (st?.quota_bytes) {
      out.push({ key: 'DB', short: 'D', pct: st.percent ?? 0,
                 tip: `MongoDB ${this.mb(st.used_bytes)} / ${this.mb(st.quota_bytes)}`
                    + ` · ${st.objects} docs · ${st.versions} versions`
                    + ` · ${st.revisions['queued'] ?? 0} queued` });
    }
    if (m) {
      out.push({ key: 'CPU', short: 'C', pct: m.cpu.load,
                 tip: `${m.cpu.name} · ${m.cpu.load.toFixed(0)}% · ${m.cpu.cores}c/${m.cpu.threads}t` });
      out.push({ key: 'RAM', short: 'R', pct: m.ram.percent,
                 tip: `RAM ${this.gb(m.ram.used_bytes)} / ${this.gb(m.ram.total_bytes)}` });
      if (m.gpu) {
        out.push({ key: 'GPU', short: 'G', pct: m.gpu.util,
                   tip: `${m.gpu.name} · ${m.gpu.util.toFixed(0)}%`
                      + ` · ${(m.gpu.mem_used_mb / 1024).toFixed(1)}/${(m.gpu.mem_total_mb / 1024).toFixed(1)} GB`
                      + ` · ${m.gpu.temp_c.toFixed(0)}°` });
      }
    }
    return out;
  }

  /** The open model's title, for the collapsed rail. With the catalog shut,
   *  which model is on screen is the one thing you can no longer see. */
  activeTitle(): string {
    const id = this.activeModel(), tree = this.catalog();
    if (!id || !tree) return '';
    const hit = this.findModel(tree, id);
    return hit?.title || hit?.name || id;
  }

  gaugeColor(pct: number): string {
    return pct > 85 ? 'var(--danger)' : pct > 60 ? 'var(--warn)' : 'var(--accent)';
  }

  /** ?rev=<id> opens the model at that revision's camera; ?model=<id>
   *  opens a named model, which is how a shot of one is taken. */
  private applyUrlCamera() {
    const q = new URLSearchParams(location.search);
    const rev = q.get('rev');
    if (rev) this.focusRevision(rev);
  }

  private urlModel(): string | null {
    return new URLSearchParams(location.search).get('model');
  }

  /** Move to the camera a revision was drawn from. If no model is loaded
   *  yet, remember it and apply once the load completes. */
  focusRevision(id: string) {
    if (!this.activeModel() || !this.viewer) { this.pendingCamera = id; return; }
    this.focusing = true;
    this.api.one(id).subscribe({
      next: r => {
        this.focusing = false;
        // Open the model the revision is about. Only the camera was applied
        // before, so a revision on one model was shown against whichever
        // model happened to load first.
        if (r.model && r.model !== this.activeModel()) {
          const target = this.catalog() && this.findModel(this.catalog()!, r.model);
          if (target) {
            this.pendingCamera = id;
            this.openModel(target);
            return;
          }
        }
        if (!r.camera || !this.viewer) return;
        this.heldCamera = r.camera;
        this.heldModel = r.model ?? this.activeModel();
        this.focused.set(r);
        // Parts first, then the camera: the drawing was made against a
        // particular set of them, and the same angle over a different set is
        // a picture of something else.
        this.viewer.applyStates(r.view?.states);
        this.viewer.applyCamera(r.camera);
      },
      error: () => { this.focusing = false; },
    });
  }

  // ---- catalog ----
  loadCatalog() {
    this.cat.tree().subscribe(t => {
      this.catalog.set(t);
      if (!this.activeModel()) {
        const wanted = this.urlModel() ?? this.lastView()?.model;
        const pick = (wanted && this.findModel(t, wanted)) || this.firstReady(t);
        if (pick) this.openModel(pick);
        return;
      }
      // A rebuild replaces the stored viewer payload. Without this the open
      // page keeps showing the geometry it loaded the first time.
      const live = this.findModel(t, this.activeModel());
      if (live?.built_at && live.built_at !== this.builtAt) {
        this.builtAt = live.built_at;      // claim it so the poll fires once
        this.flash('model rebuilt, reloading');
        this.openModel(live);
      }
    });
  }

  /** By id, or by bare name so ?model=stand works without the folder. */
  private findModel(n: FolderNode, id: string): ModelEntry | null {
    return n.models.find(m => m.id === id || m.name === id)
      ?? n.folders.reduce<ModelEntry | null>(
        (hit, f) => hit ?? this.findModel(f, id), null);
  }

  private firstReady(n: FolderNode): ModelEntry | null {
    const hit = n.models.find(m => m.data) ?? n.models.find(m => m.ready);
    if (hit) return hit;
    for (const f of n.folders) {
      const deep = this.firstReady(f);
      if (deep) return deep;
    }
    return null;
  }

  async openModel(m: ModelEntry) {
    if (!this.viewer) return;
    if (!m.data) { this.flash(m.name + ': build it first'); return; }
    this.builtAt = m.built_at ?? '';
    this.busy.set('loading model…');
    try {
      // Data is not on disk; it streams from the database.
      await this.viewer.load(this.cat.viewerUrl(m.id, m.built_at));
      this.dockFreezeButton();
      // Whatever was being held belonged to the model that just left.
      if (this.heldModel !== m.id) {
        this.heldCamera = null;
        this.heldModel = null;
        this.focused.set(null);
      }
      this.activeModel.set(m.id);
      this.parts.set(this.viewer.parts);
      setTimeout(() => this.sizeOverlay());
      // render() resets the camera, so a pending view has to be applied
      // after the load finishes rather than racing it.
      if (this.pendingCamera) {
        const rev = this.pendingCamera;
        this.pendingCamera = null;
        // Asked for more than once, like the remembered view below: the
        // viewer re-frames itself after the load and again on the next
        // resize, and a single attempt at 300 ms was landing before that
        // and being overwritten. Whichever attempt takes, the rest see the
        // hold and stand down.
        for (const ms of [300, 900, 1600]) {
          setTimeout(() => {
            if (this.heldCamera || this.pendingCamera || this.focusing) return;
            this.focusRevision(rev);
          }, ms);
        }
      } else {
        // Back to the angle this window was left at. Only for the model it
        // was left on: the same numbers over a different model point at
        // nothing in particular.
        //
        // Applied more than once: the viewer sets its own camera after the
        // load and again when it is resized, and a single apply at 300 ms
        // was simply overwritten.
        const seen = this.lastView();
        if (seen?.model === m.id && seen.camera) {
          for (const ms of [300, 900, 1600]) {
            setTimeout(() => {
              // A revision's camera may have landed in between - it is the
              // one that was asked for, and the last timer to fire used to
              // stamp the remembered angle over it. That is why a rendered
              // "after" came back from a different angle than the drawing.
              if (this.heldCamera) return;
              this.viewer?.applyCamera(seen.camera!);
            }, ms);
          }
        }
      }
      this.rememberView();
    } catch (e) {
      this.flash('load failed: ' + (e as Error).message);
    }
    this.busy.set('');
  }

  rebuild(m: ModelEntry, ev: Event) {
    ev.stopPropagation();
    this.busy.set('building ' + m.name + '…');
    this.cat.build(m.id).subscribe({
      next: () => { this.busy.set(''); this.flash(m.name + ' rebuilt');
                    this.loadCatalog(); },
      error: e => { this.busy.set(''); this.flash('error: ' + (e.error?.detail ?? e.status)); },
    });
  }

  newFolder(parent: string) {
    const name = prompt('Folder name (letters, digits, - , _):');
    if (!name) return;
    this.cat.newFolder(name, parent).subscribe({
      next: () => this.loadCatalog(),
      error: e => this.flash(e.error?.detail ?? 'could not create folder'),
    });
  }

  /** Bring in a STEP (or IGES/BREP/STL). The server stores it and writes a
   *  model that imports it, so it is on screen without a second step. */
  pickCad() { this.cadInput()?.nativeElement.click(); }

  // ---- left column: move and delete ----
  // Two clicks rather than drag and drop: pick the model, then pick the
  // folder. Works the same on a trackpad and is testable.
  moving = signal<ModelEntry | null>(null);

  armMove(m: ModelEntry, ev: Event) {
    ev.stopPropagation();
    this.moving.set(this.moving()?.id === m.id ? null : m);
  }

  cancelMove() { this.moving.set(null); }

  moveTo(folder: string, ev?: Event) {
    ev?.stopPropagation();
    const m = this.moving();
    if (!m) return;
    this.moving.set(null);
    this.cat.move(m.id, folder).subscribe({
      next: r => {
        this.flash(`${m.title} -> ${folder || 'root'}`);
        // The id carries the path, so the open model is now under a new one.
        if (this.activeModel() === m.id) this.activeModel.set(r.to);
        this.loadCatalog();
      },
      error: e => this.flash(e.error?.detail ?? 'move failed'),
    });
  }

  // Two clicks, no dialog: the first arms the row, the second deletes. A
  // browser confirm() freezes the page and cannot be driven in a test.
  deleting = signal<string | null>(null);
  private deleteTimer: ReturnType<typeof setTimeout> | undefined;

  armDelete(m: ModelEntry, ev: Event) {
    ev.stopPropagation();
    clearTimeout(this.deleteTimer);
    if (this.deleting() !== m.id) {
      this.deleting.set(m.id);
      this.deleteTimer = setTimeout(() => this.deleting.set(null), 4000);
      return;
    }
    this.deleting.set(null);
    this.cat.dropModel(m.id).subscribe({
      next: () => this.afterDelete(m),
      error: e => {
        // 409: another model imports this one. Say so and offer the override.
        const detail = e.error?.detail ?? 'could not delete';
        if (e.status === 409) {
          this.forcing.set({ model: m, why: detail });
        } else {
          this.flash(detail);
        }
      },
    });
  }

  forcing = signal<{ model: ModelEntry; why: string } | null>(null);

  forceDelete() {
    const f = this.forcing();
    if (!f) return;
    this.forcing.set(null);
    this.cat.dropModel(f.model.id, true).subscribe({
      next: () => this.afterDelete(f.model),
      error: e => this.flash(e.error?.detail ?? 'could not delete'),
    });
  }

  private afterDelete(m: ModelEntry) {
    this.flash(m.title + ' deleted');
    if (this.activeModel() === m.id) this.activeModel.set('');
    this.loadCatalog();
  }

  dropFolder(path: string, ev: Event) {
    ev.stopPropagation();
    this.cat.dropFolder(path).subscribe({
      next: () => { this.flash(path + ' deleted'); this.loadCatalog(); },
      error: e => this.flash(e.error?.detail ?? 'could not delete folder'),
    });
  }

  uploadCad(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';                       // same file twice must still fire
    if (!file) return;
    this.busy.set('uploading ' + file.name);
    this.cat.upload(file).subscribe({
      next: r => {
        this.busy.set('');
        this.flash(`${r.name} imported (${Math.round(r.bytes / 1024)} kB)`);
        this.loadCatalog();
        if (r.model) this.cat.build(r.model).subscribe({
          next: () => { this.flash(r.model + ' built'); this.loadCatalog(); },
          error: e => this.flash('build failed: ' + (e.error?.detail ?? e.status)),
        });
      },
      error: e => {
        this.busy.set('');
        this.flash(e.error?.detail ?? 'upload failed');
      },
    });
  }

  newModel(folder: string) {
    const name = prompt('Model name (letters, digits, - , _):');
    if (!name) return;
    const id = folder ? `${folder}/${name}` : name;
    const source = SEED.replace('__NAME__', name);
    this.cat.createModel(id, source).subscribe({
      next: () => { this.flash(name + ' created'); this.loadCatalog(); },
      error: e => this.flash(e.error?.detail ?? 'could not create model'),
    });
  }

  /** What a folded card says. The generated sentence when there is one,
   *  otherwise the first line cut short - the full text is what folding is
   *  meant to get rid of. */
  cardLine(r: Revision): string {
    if (r.summary) return r.summary;
    const text = (r.comment ?? '').trim();
    const first = text.split('\n')[0].trim();
    if (first.length > 64) return first.slice(0, 64).trimEnd() + '…';
    return first === text ? first : first + '…';
  }

  imageUrl(r: Revision, which: 'before' | 'after' = 'before'): string {
    return this.api.imageUrl(r.id, which);
  }

  // ---- what the work cost ----
  // The numbers come from the agent's own transcripts and are frozen onto the
  // revision when its run finishes; a run still going is re-read live. Kept
  // per card and fetched on demand: most cards are never opened.
  cost = signal<Record<string, Analytics | 'loading' | 'none'>>({});
  costOpen = signal<Set<string>>(new Set());

  costShown(id: string): boolean { return this.costOpen().has(id); }

  costOf(id: string): Analytics | null {
    const v = this.cost()[id];
    return v && v !== 'loading' && v !== 'none' ? v : null;
  }

  costState(id: string): 'loading' | 'none' | 'ok' | 'idle' {
    const v = this.cost()[id];
    if (v === 'loading' || v === 'none') return v;
    return v ? 'ok' : 'idle';
  }

  toggleCost(r: Revision) {
    const open = new Set(this.costOpen());
    if (open.has(r.id)) {
      open.delete(r.id);
      this.costOpen.set(open);
      return;
    }
    open.add(r.id);
    this.costOpen.set(open);
    this.loadCost(r);
  }

  loadCost(r: Revision) {
    const rn = this.run();
    const live = rn?.revision === r.id && rn.status === 'running';
    this.cost.set({ ...this.cost(), [r.id]: 'loading' });
    this.api.analytics(r.id, live).subscribe({
      next: a => this.cost.set({ ...this.cost(), [r.id]: a }),
      // 404 means nobody recorded a run for it - older revisions, or one
      // applied by hand. That is a fact about the card, not an error.
      error: () => this.cost.set({ ...this.cost(), [r.id]: 'none' }),
    });
  }

  /** 12_714_933 -> "12.7M". Cache reads run to millions and the raw number
   *  pushes every other column off the card. */
  tokens(n: number | null | undefined): string {
    const v = n ?? 0;
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
    return String(v);
  }

  usd(n: number | null | undefined): string {
    if (n == null) return '-';
    if (n >= 1) return '$' + n.toFixed(2);
    if (n >= 0.01) return '$' + n.toFixed(3);
    return '$' + n.toFixed(5);
  }

  // ---- where you left off ----
  // A reload used to drop you on whichever model happened to be first, at
  // the default angle. The open model and the camera are kept in this
  // browser - they are about this window, not about the project, so they do
  // not belong in the database.
  private static SEEN = 'x3.lastView';

  private rememberView() {
    const id = this.activeModel();
    if (!id || !this.viewer) return;
    try {
      localStorage.setItem(Editor.SEEN, JSON.stringify(
        { model: id, camera: this.viewer.cameraState() }));
    } catch { /* private window, or storage full */ }
  }

  private lastView(): { model: string; camera: CameraState | null } | null {
    try {
      const raw = localStorage.getItem(Editor.SEEN);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  /** How far along a build is, against how long this model took last time.
   *  The script reports no progress of its own, so this is an estimate and
   *  is held at 95% rather than sitting at 100% while the work goes on. */
  buildPct(m: ModelEntry): number | null {
    if (!m.building || !m.build_started || !m.build_secs) return null;
    const gone = (Date.now() - Date.parse(m.build_started)) / 1000;
    if (!isFinite(gone) || gone < 0) return null;
    return Math.min(Math.round(gone / m.build_secs * 100), 95);
  }

  /** 825.1 -> "13m 45s" */
  duration(sec: number | null | undefined): string {
    const s = Math.max(0, Math.round(sec ?? 0));
    if (s < 60) return s + 's';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
  }

  /** Output tokens per bucket as an SVG polyline, scaled to the tallest
   *  bucket. A flat empty chart says "no samples" more clearly than a
   *  missing element, so an empty series still draws the baseline. */
  spark(a: Analytics, w = 250, h = 34): string {
    const v = a.series?.output ?? [];
    if (v.length < 2) return `0,${h} ${w},${h}`;
    const top = Math.max(...v, 1);
    return v.map((n, i) =>
      `${(i / (v.length - 1) * w).toFixed(1)},` +
      `${(h - (n / top) * (h - 2)).toFixed(1)}`).join(' ');
  }

  /** Colours for the spend split. Fixed per kind so the same slice is the
   *  same colour on every card. */
  private static KIND = new Map<string, [string, string]>([
    ['work', ['var(--chart-work)', 'design']],
    ['build', ['var(--chart-build)', 'builds']],
    ['progress', ['var(--chart-progress)', 'progress']],
    ['reply', ['var(--chart-reply)', 'replies']],
    ['summary', ['var(--chart-summary)', 'ai summary']],
    ['translate', ['var(--chart-translate)', 'translation']],
  ]);

  // ---- the running task, shown in the viewer's own panel ----
  // The tree panel has a lot of empty room under the model tree, and the
  // card for the task being worked on was on the far side of the screen from
  // the thing it is changing. It moves here while the run is live, costs and
  // all, and comes off the queue on the right so it is not in two places.
  liveCost = signal<Analytics | null>(null);
  private costTimer: ReturnType<typeof setInterval> | undefined;

  runningRevision(): Revision | null {
    const rn = this.run();
    if (!rn || rn.status !== 'running' || !rn.revision) return null;
    return this.revisions().find(r => r.id === rn.revision) ?? null;
  }

  private pollLiveCost() {
    const rn = this.run();
    if (!rn?.revision || rn.status !== 'running') {
      this.liveCost.set(null);
      return;
    }
    // Every live read writes its roll-up to the database, so the stored copy
    // is never more than one poll old. Paint that first and let the live
    // read land on top: the panel is filled in before the request returns
    // rather than after it.
    if (!this.liveCost()) {
      this.api.analytics(rn.revision, false).subscribe({
        next: a => { if (!this.liveCost()) this.showCost(rn.revision!, a); },
        error: () => {},
      });
    }
    this.api.analytics(rn.revision, true).subscribe({
      next: a => this.showCost(rn.revision!, a),
      error: () => {},
    });
  }

  /** The docked card shows its cost section open, and it reads from the same
   *  per-card store as the queue does. */
  private showCost(rid: string, a: Analytics) {
    this.liveCost.set(a);
    this.cost.set({ ...this.cost(), [rid]: a });
  }

  /** The name for a spending surface. An "else agent" fallback filed the
   *  translation calls under the agent, which is the one thing they are not. */
  surfaceName(surface: string): string {
    return { 'card-summary': 'ai summary', translate: 'translation',
             'claude-code': 'agent' }[surface] ?? surface;
  }

  /** Slices of a donut, as stroke dash offsets on a circle of circumference
   *  100. Drawn with SVG strokes rather than arc paths: no trigonometry, and
   *  a single slice of 100% still renders as a full ring. */
  donut(a: Analytics): { label: string; colour: string; dash: string;
                         offset: number; pct: number; usd: number }[] {
    const rows = (a.kinds ?? []).filter(k => k.cost_usd > 0);
    const total = rows.reduce((n, k) => n + k.cost_usd, 0);
    if (!total) return [];
    let at = 0;
    return rows.map(k => {
      const pct = k.cost_usd / total * 100;
      const [colour, label] = Editor.KIND.get(k.kind)
        ?? ['var(--chart-other)', k.kind];
      const slice = { label, colour, dash: `${pct} ${100 - pct}`,
                      offset: -at, pct, usd: k.cost_usd };
      at += pct;
      return slice;
    });
  }

  /** The count alone: "2 builds · 4 renders" is wider than the value column
   *  and wrapped onto a second line. The split goes in the tooltip. */
  computeJobs(c: NonNullable<Analytics['compute']>): string {
    const n = c.totals?.jobs ?? 0;
    return n ? `${n} job${n === 1 ? '' : 's'}` : 'nothing recorded';
  }

  computeJobsTitle(c: NonNullable<Analytics['compute']>): string {
    const parts = (c.kinds ?? []).map(k =>
      `${k.jobs} ${k.kind}${k.jobs === 1 ? '' : 's'}`);
    return parts.join(' \u00b7 ') || 'no build or render was recorded';
  }

  /** Core-minutes, or seconds while it is still small: "42s of one core"
   *  reads better than "0.7 core-min" for a render. */
  coreTime(sec: number | null | undefined): string {
    const v = sec ?? 0;
    if (v < 90) return v.toFixed(0) + ' core-s';
    return (v / 60).toFixed(1) + ' core-min';
  }

  mem(mb: number | null | undefined): string {
    if (mb == null) return '-';
    return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb.toFixed(0) + ' MB';
  }

  /** Watt-hours. A build is a few of them, so this never needs a kWh. */
  wh(v: number | null | undefined): string {
    if (v == null) return '-';
    return v < 10 ? v.toFixed(2) + ' Wh' : v.toFixed(0) + ' Wh';
  }

  /** The energy figure is a guess and has to look like one. */
  energyNote(e: { basis: string; watts_per_core: number | null } | undefined): string {
    if (!e) return '';
    return e.basis === 'measured'
      ? 'read from the machine\u2019s own energy counter'
      : `assumed: ${e.watts_per_core} W per busy core, no readable power counter`;
  }

  /** Tokens per second at the busiest bucket, for the chart's scale label. */
  sparkPeak(a: Analytics): number {
    const v = a.series?.output ?? [];
    if (!v.length) return 0;
    return Math.round(Math.max(...v) / (a.series.bucket_s || 30));
  }

  /** Which of the two shots the overlay is showing. */
  previewSide = signal<'before' | 'after'>('before');

  openShot(r: Revision, which: 'before' | 'after' = 'before') {
    this.previewSide.set(which);
    this.preview.set(r);
  }
  closeShot() { this.preview.set(null); }

  // ---- version history ----
  loadVersions() { this.cat.versions().subscribe({ next: v => this.versions.set(v),
                                                   error: () => {} }); }

  takeSnapshot() {
    const note = prompt('Version note:') ?? '';
    this.busy.set('taking snapshot…');
    this.cat.snapshot(note).subscribe({
      next: () => { this.busy.set(''); this.flash('version saved'); this.loadVersions(); },
      error: e => { this.busy.set(''); this.flash(e.error?.detail ?? 'snapshot failed'); },
    });
  }

  restore(v: ModelVersion) {
    if (!confirm(`Roll back to ${v.short}?\nThe current state is snapshotted first.`)) return;
    this.busy.set('restoring…');
    this.cat.restore(v._id).subscribe({
      next: () => { this.busy.set(''); this.flash('restored: ' + v.short);
                    this.loadVersions(); this.loadCatalog(); },
      error: e => { this.busy.set(''); this.flash(e.error?.detail ?? 'restore failed'); },
    });
  }

  mb(n: number): string { return (n / 1e6).toFixed(1) + ' MB'; }

  /** Only offer the WebGL advice when the failure really is WebGL related. */
  isWebglError(): boolean {
    return /webgl|context|gpu/i.test(this.glError());
  }

  /** The host sits 8 px above the card's bottom edge; the viewer must be
   *  told the shorter height or it paints straight over that gap. */
  private static GUTTER = 8;

  private sizeOverlay() {
    const box = this.stage().nativeElement;
    this.viewer?.resize(box.clientWidth, box.clientHeight - Editor.GUTTER);
    if (this.heldCamera && this.heldModel === this.activeModel()) {
      this.viewer?.applyCamera(this.heldCamera);
    }

    // getImage() returns the canvas only; unless the overlay sits exactly on
    // top of it, marks land in the wrong place in the saved image.
    const c = this.overlay().nativeElement;
    const cad = this.viewer?.canvasRect();
    const stage = box.getBoundingClientRect();
    this.viewTop.set(cad ? Math.round(cad.top - stage.top) : 0);
    const w = cad ? cad.width : box.clientWidth;
    const h = cad ? cad.height : box.clientHeight;
    const ratio = Math.min(devicePixelRatio, 2);
    c.width = Math.round(w * ratio);
    c.height = Math.round(h * ratio);
    c.style.width = w + 'px';
    c.style.height = h + 'px';
    c.style.left = (cad ? cad.left - stage.left : 0) + 'px';
    c.style.top = (cad ? cad.top - stage.top : 0) + 'px';
    this.repaint();
  }

  // ---- freeze / unfreeze ----
  /** Once the user orbits, stop forcing the stored view and drop the card. */
  releaseCamera() {
    if (!this.heldCamera) return;
    this.heldCamera = null;
    this.heldModel = null;
    this.focused.set(null);
  }

  async freeze() {
    if (!this.viewer) return;
    this.frozenShot = await this.viewer.image();
    this.viewer.setEnabled(false);
    this.frozen.set(true);
  }

  resume() {
    this.viewer?.setEnabled(true);
    this.frozen.set(false);
    this.typing.set(null);
    this.marks = []; this.active = null; this.repaint();
  }

  // ---- drawing ----
  private pos(ev: PointerEvent): [number, number] {
    const c = this.overlay().nativeElement;
    const r = c.getBoundingClientRect();
    return [(ev.clientX - r.left) * c.width / r.width,
            (ev.clientY - r.top) * c.height / r.height];
  }

  down(ev: PointerEvent) {
    if (!this.frozen()) return;
    const at = this.pos(ev);
    const t = this.tool();

    if (t === 'text') {
      // An inline caret rather than prompt(): a modal dialog freezes the
      // whole page, and the label has to be placed while the model is visible.
      const stage = this.stage().nativeElement.getBoundingClientRect();
      this.typeAt = at;
      this.typing.set({ left: ev.clientX - stage.left, top: ev.clientY - stage.top });
      setTimeout(() => this.caret()?.nativeElement.focus());
      return;
    }

    this.drawing = true;
    (ev.target as HTMLElement).setPointerCapture(ev.pointerId);
    this.active = t === 'pen'
      ? { kind: 'pen', color: this.color(), width: this.penWidth(), pts: [at] }
      : { kind: t, color: this.color(), width: this.penWidth(), a: at, b: at };
    this.marks.push(this.active);
    this.repaint();
  }

  move(ev: PointerEvent) {
    if (!this.drawing || !this.active) return;
    const at = this.pos(ev);
    if (this.active.kind === 'pen') this.active.pts.push(at);
    else if (this.active.kind !== 'text') this.active.b = at;
    this.repaint();
  }

  up() {
    // A click with a shape tool leaves a zero-size mark; drop it.
    if (this.active && this.active.kind !== 'pen' && this.active.kind !== 'text') {
      const [ax, ay] = this.active.a, [bx, by] = this.active.b;
      if (Math.hypot(bx - ax, by - ay) < 3) this.marks.pop();
    }
    this.drawing = false;
    this.active = null;
    this.repaint();
  }

  undo() { this.marks.pop(); this.repaint(); }
  clear() { this.marks = []; this.repaint(); }

  private repaint() {
    const c = this.overlay().nativeElement;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.lineCap = ctx.lineJoin = 'round';
    const scale = Math.min(devicePixelRatio, 2);

    for (const m of this.marks) {
      ctx.strokeStyle = m.color;
      ctx.fillStyle = m.color;

      if (m.kind === 'text') {
        ctx.font = `600 ${m.size}px 'IBM Plex Sans', sans-serif`;
        ctx.textBaseline = 'middle';
        ctx.fillText(m.text, m.at[0], m.at[1]);
        continue;
      }

      ctx.lineWidth = m.width * scale;
      ctx.beginPath();

      if (m.kind === 'pen') {
        m.pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
      } else {
        const [ax, ay] = m.a, [bx, by] = m.b;
        if (m.kind === 'line') {
          ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
        } else if (m.kind === 'rect') {
          ctx.rect(ax, ay, bx - ax, by - ay);
        } else if (m.kind === 'ellipse') {
          ctx.ellipse((ax + bx) / 2, (ay + by) / 2,
                      Math.abs(bx - ax) / 2, Math.abs(by - ay) / 2, 0, 0, Math.PI * 2);
        } else if (m.kind === 'triangle') {
          ctx.moveTo((ax + bx) / 2, ay);
          ctx.lineTo(bx, by); ctx.lineTo(ax, by); ctx.closePath();
        } else if (m.kind === 'arrow') {
          const head = Math.max(10, m.width * scale * 3);
          const ang = Math.atan2(by - ay, bx - ax);
          ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
          ctx.moveTo(bx, by);
          ctx.lineTo(bx - head * Math.cos(ang - 0.4), by - head * Math.sin(ang - 0.4));
          ctx.moveTo(bx, by);
          ctx.lineTo(bx - head * Math.cos(ang + 0.4), by - head * Math.sin(ang + 0.4));
        }
      }
      ctx.stroke();
    }
  }

  commitText(value: string) {
    // Enter closes the caret, which then blurs: without this guard the label
    // is committed twice, one copy exactly on top of the other.
    if (!this.typing()) return;
    const text = value.trim();
    this.typing.set(null);
    if (!text) return;
    const scale = Math.min(devicePixelRatio, 2);
    this.marks.push({ kind: 'text', color: this.color(),
                      size: this.fontSize() * scale, at: this.typeAt, text });
    this.repaint();
  }

  cancelText() { this.typing.set(null); }

  readonly tools: { id: Tool; glyph: string; label: string }[] = [
    { id: 'pen', glyph: '✎', label: 'freehand' },
    { id: 'line', glyph: '╱', label: 'line' },
    { id: 'arrow', glyph: '→', label: 'arrow' },
    { id: 'rect', glyph: '▭', label: 'rectangle' },
    { id: 'ellipse', glyph: '◯', label: 'ellipse' },
    { id: 'triangle', glyph: '△', label: 'triangle' },
    { id: 'text', glyph: 'T', label: 'text' },
  ];

  // ---- save ----
  async save() {
    if (!this.viewer) return;
    if (!this.comment().trim()) { this.flash('write a comment first'); return; }
    this.saving.set(true);
    // A note about a part is a valid revision; the drawing is optional.
    const merged = this.frozen() ? await this.merge(this.frozenShot) : null;
    this.api.create({
      comment: this.comment().trim(), image_png: merged,
      camera: this.viewer.cameraState(), part: this.part() || null,
      model: this.activeModel() || null,
      // What was on screen, not just where it was seen from: which parts
      // were switched off is half of the picture, and without it the "after"
      // shot shows a different thing from the same angle.
      view: { states: this.viewer.states() },
    }).subscribe({
      next: () => {
        this.saving.set(false);
        this.comment.set('');
        // The revision is filed, so let go of the view: staying frozen just
        // means the next orbit is a click on Unfreeze first.
        if (this.frozen()) this.resume(); else this.clear();
        this.flash('revision saved');
        this.refresh();
      },
      error: e => { this.saving.set(false); this.flash('save failed: ' + e.status); },
    });
  }

  /** Merge the frozen frame and the drawing layer into one PNG. */
  private merge(shotUrl: string): Promise<string> {
    return new Promise(resolve => {
      const overlay = this.overlay().nativeElement;
      if (!shotUrl) { resolve(overlay.toDataURL('image/png')); return; }
      const out = document.createElement('canvas');
      const img = new Image();
      img.onload = () => {
        out.width = img.width; out.height = img.height;
        const c = out.getContext('2d')!;
        c.drawImage(img, 0, 0);
        c.drawImage(overlay, 0, 0, out.width, out.height);
        resolve(out.toDataURL('image/png'));
      };
      img.onerror = () => resolve(overlay.toDataURL('image/png'));
      img.src = shotUrl;
    });
  }

  refresh() {
    this.api.list(this.showArchived()).subscribe({
      next: r => this.revisions.set(r), error: () => {} });
  }

  toggleArchivedView() { this.showArchived.update(v => !v); this.refresh(); }

  /** Server-side so the CLI honours it too, not just this browser. */
  loadSettings() {
    this.api.settings().subscribe({
      next: s => {
        this.autoArchive.set(s.auto_archive);
        this.autoTranslate.set(s.auto_translate);
      },
      error: () => {},
    });
  }

  toggleAutoArchive() {
    this.api.setSetting('auto_archive', !this.autoArchive()).subscribe({
      next: s => {
        this.autoArchive.set(s.auto_archive);
        this.flash(s.auto_archive ? 'applied revisions will be archived'
                                  : 'auto-archive off');
      },
      error: () => this.flash('could not change the setting'),
    });
  }

  toggleAutoTranslate() {
    this.api.setSetting('auto_translate', !this.autoTranslate()).subscribe({
      next: s => {
        this.autoTranslate.set(s.auto_translate);
        this.flash(s.auto_translate
          ? 'notes will be saved as English requests'
          : 'notes will be saved as written');
      },
      error: () => this.flash('could not change the setting'),
    });
  }

  archive(r: Revision) {
    this.api.archive(r.id, !r.archived).subscribe(() => {
      this.flash(r.archived ? 'restored from archive' : 'archived');
      this.refresh();
    });
  }

  /** Cards fold to a single line; the set holds the folded ids. */
  isFolded(id: string): boolean { return this.collapsed_().has(id); }

  toggleFold(id: string) {
    const next = new Set(this.collapsed_());
    next.has(id) ? next.delete(id) : next.add(id);
    this.collapsed_.set(next);
  }

  foldAll() {
    this.collapsed_.set(new Set(this.revisions().map(r => r.id)));
  }

  unfoldAll() { this.collapsed_.set(new Set()); }

  startEdit(r: Revision) {
    this.editing.set(r.id);
    this.editText.set(r.comment);
    this.editPart.set(r.part ?? '');
    this.editSummary.set(r.summary ?? '');
  }

  cancelEdit() { this.editing.set(null); }

  saveEdit(r: Revision) {
    const text = this.editText().trim();
    if (!text) { this.flash('comment cannot be empty'); return; }
    // An unchanged summary is not sent: sending it back would mark a
    // generated sentence as hand-written and freeze it.
    const summary = this.editSummary().trim();
    const body: { comment: string; part: string | null; summary?: string } =
      { comment: text, part: this.editPart() || null };
    if (summary !== (r.summary ?? '')) body.summary = summary;
    this.api.edit(r.id, body).subscribe({
      next: () => { this.editing.set(null); this.flash('revision updated'); this.refresh(); },
      error: e => this.flash(e.error?.detail ?? 'update failed'),
    });
  }

  remove(r: Revision) {
    if (!confirm(`Delete this revision?\n\n"${r.comment}"`)) return;
    this.api.remove(r.id).subscribe({
      next: () => { this.flash('revision deleted'); this.refresh(); this.pollHealth(); },
      error: () => this.flash('delete failed'),
    });
  }

  mark(r: Revision, status: RevisionStatus) {
    this.api.setStatus(r.id, status).subscribe(() => { this.refresh(); this.pollHealth(); });
  }

  /** One button, three-state cycle: draft -> queued -> applied -> draft,
   *  so "applied" can be undone. */
  private static NEXT: Record<string, RevisionStatus> = {
    draft: 'queued', queued: 'applied', applied: 'draft', rejected: 'draft',
  };

  cycle(r: Revision) { this.mark(r, Editor.NEXT[r.status] ?? 'draft'); }

  /** The button always reads as the action the next click performs. */
  nextLabel(s: RevisionStatus): string {
    return s === 'draft' ? 'queue'
      : s === 'queued' ? 'mark applied'
      : 'back to draft';
  }

  nextClass(s: RevisionStatus): string {
    return s === 'draft' ? 'tcv-chip tcv-chip-accent'
      : s === 'queued' ? 'tcv-chip tcv-chip-ok'
      : 'tcv-chip';
  }

  /** Position in the queue; the list already arrives ordered by queued_at. */
  queueIndex(r: Revision): number {
    return this.revisions().filter(x => x.status === 'queued').indexOf(r) + 1;
  }

  queueCount(): number {
    return this.revisions().filter(x => x.status === 'queued').length;
  }

  badge(s: RevisionStatus): string {
    return s === 'applied' ? 'var(--ok)'
      : s === 'queued' ? 'var(--accent-deep)'
      : s === 'rejected' ? 'var(--line)' : 'var(--warn)';
  }

  label(s: RevisionStatus): string {
    return s === 'applied' ? 'applied'
      : s === 'queued' ? 'queued'
      : s === 'rejected' ? 'rejected' : 'draft';
  }

  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  private flash(msg: string) {
    // Cancel the previous timer: without this an older message's timeout
    // wipes a newer one, and the second of two quick messages barely shows.
    clearTimeout(this.toastTimer);
    this.toast.set(msg);
    this.toastTimer = setTimeout(() => this.toast.set(''), 2600);
  }
}
