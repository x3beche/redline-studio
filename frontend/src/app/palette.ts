import { Component, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Auth } from './auth';
import { Catalog, FolderNode } from './api';
import { CcWant, Selection } from './selection';
import { WORKSPACES } from './workspaces';
import { NotesApi } from './rooms/notes';
import { Prefs } from './preferences';
import { THEMES, THEME_NAMES } from '../theme';
import { LANG, LANGS, T, setLang, t } from './i18n';

/** Ctrl+K: one box to go anywhere and do anything.
 *
 *  Type, and it offers - the rooms; every model and board by name;
 *  every tool; the things you can do (build, show the code, release, a
 *  technical drawing, a new note...); and, from the server, code lines,
 *  notes, chats, revisions and parts that mention what you typed. Arrows
 *  move, Enter goes, Esc closes. What it opens it asks of the room that
 *  can (Selection.ask), so the rooms keep doing their own work.
 */
interface Item {
  group: string; label: string; hint?: string; icon: string;
  run: () => void; keys?: string;
  /** The palette stays open (it only changes what is typed). */
  keep?: boolean;
  /** An "Ask Command Code about this …": Tab types the question here. */
  ask?: AskCtx;
}

/** What "Ask Command Code about this …" attaches: the thing open on screen. */
interface AskCtx { label: string; what: string; mention?: NonNullable<CcWant['mention']> }

/** "ask: how wide…" typed into the palette sends that question at once. */
const ASK = /^\s*ask\s*[:>]\s*(.*)$/i;

interface Hit {
  kind: 'code' | 'note' | 'chat' | 'revision' | 'part';
  id: string; label: string; text?: string; file?: 'model' | 'board'; line?: number; room?: string; model?: string;
}

const ROOM_ICON: Record<string, string> = {
  cad: '◆', pcb: '▦', notes: '✎', tools: '⚒', analyze: '▤',
};

function words(q: string) { return q.toLowerCase().split(/\s+/).filter(Boolean); }

/** Every word somewhere in the text; earlier and whole-word matches first.
 *  A word that is not there whole may still match the label's letters in
 *  order ("ccnew" finds "New Command Code chat"), ranked below. */
function score(text: string, ws: string[], label = ''): number {
  const t = text.toLowerCase(), l = label.toLowerCase();
  let s = 0;
  for (const w of ws) {
    const i = t.indexOf(w);
    if (i >= 0) { s += 10 - Math.min(i, 9) + (i === 0 || /\W/.test(t[i - 1]) ? 5 : 0); continue; }
    if (w.length < 2 || !subsequence(w, l)) return 0;
    s += 1;
  }
  return s;
}

function subsequence(w: string, text: string): boolean {
  let at = 0;
  for (const ch of w) {
    at = text.indexOf(ch, at);
    if (at < 0) return false;
    at++;
  }
  return true;
}

@Component({
  selector: 'app-palette',
  imports: [T],
  template: `
@if (open()) {
  <div class="tcv-pal-back" (click)="close()">
    <div class="tcv-pal" (click)="$event.stopPropagation()" role="dialog" aria-label="Command palette">
      <div class="tcv-pal-inrow">
        @if (asking(); as a) {
          <span class="tcv-pal-mode" [title]="a.label | t">{{ 'Ask Command Code' | t }} · {{ a.what }}</span>
        }
        <input #box class="tcv-pal-input"
               [placeholder]="(asking() ? 'Type the question and press Enter - or Enter now to open it with nothing typed'
                               : 'Go to a model, board, tool or room - search code, notes, chats, parts - or type an action') | t"
               [value]="q()" (input)="q.set($any($event.target).value)" (keydown)="nav($event)" aria-label="Search">
      </div>
      <div class="tcv-pal-list" #list>
        @for (g of grouped(); track g.name) {
          <div class="tcv-pal-group">{{ g.name | t }}</div>
          @for (it of g.items; track it.i) {
            <button class="tcv-pal-item" [attr.data-on]="it.i === cursor() ? 1 : null" (mouseenter)="cursor.set(it.i)"
                    (click)="go(it.item)">
              <span class="tcv-pal-icon">{{ it.item.icon }}</span>
              <span class="tcv-pal-label">{{ it.item.label | t }}</span>
              @if (it.item.hint) { <span class="tcv-pal-hint">{{ it.item.hint }}</span> }
              @if (it.item.keys) { <kbd class="tcv-pal-keys">{{ it.item.keys }}</kbd> }
            </button>
          }
        } @empty {
          <p class="tcv-pal-empty">{{ searching() ? 'looking…' : 'Nothing matches.' }}</p>
        }
      </div>
      <div class="tcv-pal-foot">{{ (asking() ? 'Enter to ask · Esc to go back'
                                     : hasAsk() ? '↑↓ to move · Enter to open · Tab to type the question here · Esc to close'
                                     : '↑↓ to move · Enter to open · Esc to close') | t }}
        @if (searching()) { <span> · searching code, notes, chats…</span> }</div>
    </div>
  </div>
}`,
})
export class Palette {
  private http = inject(HttpClient);
  private auth = inject(Auth);
  private catalog = inject(Catalog);
  private picked = inject(Selection);
  private notes = inject(NotesApi);
  private prefs = inject(Prefs);
  private box = viewChild<ElementRef<HTMLInputElement>>('box');
  private list = viewChild<ElementRef<HTMLElement>>('list');

  open = signal(false);
  q = signal('');
  /** An "Ask Command Code about this …" chosen with Tab: the box takes the question. */
  asking = signal<AskCtx | null>(null);
  cursor = signal(0);
  searching = signal(false);
  private tree = signal<FolderNode | null>(null);
  private tools = signal<{ id: string; name: string; blurb: string }[]>([]);
  private hits = signal<Hit[]>([]);
  private timer?: ReturnType<typeof setTimeout>;

  constructor() {
    // The server's half, a moment after typing stops.
    effect(() => {
      const q = this.q().trim();
      clearTimeout(this.timer);
      if (q.length < 2) { this.hits.set([]); this.searching.set(false); return; }
      this.searching.set(true);
      this.timer = setTimeout(() => untracked(() => this.http.get<Hit[]>(`/api/search?q=${encodeURIComponent(q)}`)
        .subscribe({ next: h => { if (this.q().trim() === q) { this.hits.set(h); this.searching.set(false); } },
                     error: () => this.searching.set(false) })), 180);
    });
    effect(() => { this.q(); untracked(() => this.cursor.set(0)); });
    // Caught before anything else sees it: the code editor (Monaco) takes
    // Ctrl+K for itself otherwise.
    window.addEventListener('keydown', e => this.key(e), true);
  }

  /** The things that can be done, whatever is typed. */
  private actions(): Item[] {
    const room = this.picked.room();
    const out: Item[] = [
      { group: 'Actions', icon: '✎', label: 'New note', hint: 'from anywhere', keys: 'Alt+N', run: () => this.notes.quick.set(true) },
      { group: 'Actions', icon: '⌨', label: 'Keyboard shortcuts', keys: '?', run: () => this.prefs.open.set('shortcuts') },
      { group: 'Actions', icon: '⚙', label: 'Settings', hint: 'theme, language, shortcuts, LLM, proxy', run: () => this.prefs.open.set('appearance') },
      { group: 'Actions', icon: '⚙', label: 'LLM settings', hint: 'API keys, and which model does what', run: () => this.prefs.open.set('llm') },
      { group: 'Actions', icon: '⚙', label: 'Top bar settings', hint: 'order and visibility of the tabs', run: () => this.prefs.open.set('topbar') },
      { group: 'Actions', icon: '⚙', label: 'Proxy settings', hint: 'a second way out for EasyEDA lookups', run: () => this.prefs.open.set('proxy') },
      { group: 'Actions', icon: '◐', label: 'Switch theme…', hint: (THEME_NAMES as Record<string, string>)[this.prefs.theme()] ?? '', keep: true,
        run: () => this.q.set('Theme: ') },
      ...THEMES.map(th => ({ group: 'Actions', icon: '◐', label: `Theme: ${THEME_NAMES[th]}`,
                             hint: this.prefs.theme() === th ? 'on' : '', run: () => this.prefs.wear(th) })),
      ...LANGS.map(l => ({ group: 'Actions', icon: 'A', label: `Language: ${l.name}`,
                           hint: LANG() === l.id ? 'on' : '', run: () => setLang(l.id) })),
    ];
    if (room === 'cad' || room === 'pcb') {
      out.push(
        { group: 'Actions', icon: '</>', label: 'Show the code', hint: room === 'pcb' ? 'the board source' : 'the model source',
          run: () => this.picked.ask('code') },
        { group: 'Actions', icon: '▣', label: 'Release the project', hint: 'Gerbers, BOM, STEP, drawings', run: () => this.picked.ask('release') });
    }
    if (room === 'cad') out.push({ group: 'Actions', icon: '⊞', label: 'Technical drawing', hint: 'the open model, as PDF', run: () => this.picked.ask('drawing') });
    if (room === 'pcb') out.push({ group: 'Actions', icon: '▶', label: 'Build the board', hint: 'source to routed board and DRC', run: () => this.picked.ask('build') });
    if (this.auth.state()?.mode === 'on') out.push({ group: 'Actions', icon: '⏻', label: 'Sign out', run: () => this.auth.logout() });
    return [...this.ccItems(), ...out];
  }

  /** The thing open on screen that Command Code could be asked about. */
  private askCtx(): AskCtx | null {
    const room = this.picked.room();
    if (room === 'cad' && this.picked.model()) {
      const id = this.picked.model()!;
      const label = this.titleOf('model', id) ?? id;
      return { label: 'Ask Command Code about this project', what: label, mention: { kind: 'model', id, label } };
    }
    if (room === 'pcb' && this.picked.board()) {
      const id = this.picked.board()!;
      const label = this.titleOf('board', id) ?? id;
      return { label: 'Ask Command Code about this board', what: label, mention: { kind: 'board', id, label } };
    }
    const note = this.picked.note();
    if (room === 'notes' && note) return { label: 'Ask Command Code about this note', what: note.label, mention: { kind: 'note', ...note } };
    const file = this.picked.file();
    if (room === 'files' && file) return { label: 'Ask Command Code about this file', what: file.label, mention: { kind: 'file', ...file } };
    return null;
  }

  private ask(ctx: AskCtx | null, text?: string) {
    this.picked.askCc({ action: 'new', mention: ctx?.mention, text: text?.trim() || undefined });
  }

  private ccItems(): Item[] {
    if (!this.auth.can('draw')) return [{ group: 'Command Code', icon: '›_', label: 'Open last Command Code chat',
                                         run: () => this.picked.askCc({ action: 'last' }) }];
    const ctx = this.askCtx();
    const out: Item[] = [];
    if (ctx) out.push({ group: 'Command Code', icon: '›_', label: ctx.label, hint: ctx.what, ask: ctx, run: () => this.ask(ctx) });
    out.push(
      { group: 'Command Code', icon: '+', label: 'New Command Code chat', keys: 'Ctrl+Shift+O',
        run: () => this.picked.askCc({ action: 'new' }) },
      { group: 'Command Code', icon: '›_', label: 'Open last Command Code chat', run: () => this.picked.askCc({ action: 'last' }) });
    return out;
  }

  /** A model's or board's name, from the catalog tree. */
  private titleOf(kind: 'model' | 'board', id: string): string | null {
    let found: string | null = null;
    const walk = (n: FolderNode & { boards?: { id: string; title?: string }[] }) => {
      if (found) return;
      if (kind === 'model') { const m = n.models.find(x => x.id === id); if (m) found = m.title || m.name; }
      else { const b = (n.boards ?? []).find(x => x.id === id); if (b) found = b.title || b.id; }
      for (const f of n.folders) walk(f as typeof n);
    };
    const t = this.tree();
    if (t) walk(t as never);
    return found;
  }

  private places(): Item[] {
    const out: Item[] = WORKSPACES.map(w => ({
      group: 'Rooms', icon: ROOM_ICON[w.id] ?? '·', label: w.label, hint: 'go to', run: () => this.picked.room.set(w.id),
    }));
    const walk = (n: FolderNode & { boards?: { id: string; title?: string }[] }) => {
      for (const m of n.models) out.push({ group: 'Models', icon: '◆', label: m.title || m.name, hint: m.id,
        run: () => { this.picked.room.set('cad'); this.picked.ask('model', m.id); } });
      for (const b of n.boards ?? []) out.push({ group: 'Boards', icon: '▦', label: b.title || b.id, hint: `${b.id}.pcb`,
        run: () => this.picked.openBoard(b.id) });
      for (const f of n.folders) walk(f as typeof n);
    };
    const t = this.tree();
    if (t) walk(t as never);
    for (const tool of this.tools()) out.push({ group: 'Tools', icon: '⚒', label: tool.name, hint: tool.blurb,
      run: () => { this.picked.room.set('tools'); this.picked.ask('tool', tool.id); } });
    return out;
  }

  private found(): Item[] {
    return this.hits().map(h => {
      switch (h.kind) {
        case 'code': return { group: 'In the code', icon: '</>', label: h.label, hint: h.text,
          run: () => {
            if (h.file === 'board') this.picked.openBoard(h.id); else this.picked.room.set('cad');
            if (h.file === 'model') this.picked.ask('model', h.id);
            setTimeout(() => this.picked.ask('code-line', `${h.id}#${h.line}`), 300);
          } };
        case 'note': return { group: 'Notes', icon: '✎', label: h.label, hint: h.text,
          run: () => { this.picked.room.set('notes'); this.picked.ask('note', h.id); } };
        case 'chat': return { group: 'Chats', icon: '💬', label: h.text ?? '', hint: h.label,
          run: () => this.picked.room.set((h.room ?? 'cad') as never) };
        case 'revision': return { group: 'Revisions', icon: '✦', label: h.label, hint: h.text,
          run: () => this.picked.room.set((h.room === 'pcb' ? 'pcb' : 'cad') as never) };
        default: return { group: 'Parts', icon: '⬚', label: h.label, hint: h.text,
          run: () => { this.picked.room.set('pcb'); setTimeout(() => this.picked.ask('part', h.id), 300); } };
      }
    });
  }

  items = computed<Item[]>(() => {
    // Asking: one line, the question as typed.
    const a = this.asking();
    if (a) {
      const q = this.q().trim();
      return [{ group: 'Command Code', icon: '›_', label: a.label, hint: q ? `“${q}”` : a.what, run: () => this.ask(a, q) }];
    }
    // "ask: …" sends that question - with what is open attached, or alone.
    const m = ASK.exec(this.q());
    if (m && this.auth.can('draw')) {
      const q = m[1].trim(), ctx = this.askCtx();
      const out: Item[] = [];
      if (ctx) out.push({ group: 'Command Code', icon: '›_', label: ctx.label, hint: q ? `“${q}”` : ctx.what, run: () => this.ask(ctx, q) });
      out.push({ group: 'Command Code', icon: '›_', label: 'Ask Command Code', hint: q ? `“${q}”` : t('type the question after "ask:"'),
                 run: () => this.ask(null, q) });
      return out;
    }
    const ws = words(this.q());
    const local = [...this.actions(), ...this.places()];
    // Nothing typed: the room's own actions and the rooms; themes and
    // languages wait to be asked for.
    if (!ws.length) return [...this.actions().filter(i => !/^(Theme|Language): /.test(i.label)),
                            ...local.filter(i => i.group === 'Rooms')];
    // Actions only when they match; then a small lead over names that match as well.
    const ranked = local.map(i => ({ i, s: score(`${i.label} ${t(i.label)} ${i.hint ?? ''}`, ws, `${i.label} ${t(i.label)}`) }))
      .filter(x => x.s > 0).map(x => ({ ...x, s: x.s + (x.i.group === 'Actions' || x.i.group === 'Command Code' ? 3 : 0) }))
      .sort((a, b) => b.s - a.s).slice(0, 40).map(x => x.i);
    return [...ranked, ...this.found()];
  });

  grouped = computed(() => {
    const out: { name: string; items: { item: Item; i: number }[] }[] = [];
    const order = ['Command Code', 'Actions', 'Rooms', 'Models', 'Boards', 'Tools', 'In the code', 'Notes', 'Chats', 'Revisions', 'Parts'];
    const by = new Map<string, Item[]>();
    for (const it of this.items()) by.set(it.group, [...(by.get(it.group) ?? []), it]);
    let i = 0;
    for (const g of order) {
      const list = by.get(g);
      if (list?.length) out.push({ name: g, items: list.map(item => ({ item, i: i++ })) });
    }
    return out;
  });
  private flat = computed(() => this.grouped().flatMap(g => g.items.map(x => x.item)));
  hasAsk = computed(() => this.flat().some(i => i.ask));

  show() {
    if (!this.auth.signedIn()) return;
    this.q.set('');
    this.asking.set(null);
    this.open.set(true);
    this.catalog.tree().subscribe(t => this.tree.set(t));
    if (!this.tools().length) {
      fetch('/api/tools/catalog').then(r => r.ok ? r.json() : null)
        .then(d => d && this.tools.set(d.tools)).catch(() => {});
    }
    setTimeout(() => this.box()?.nativeElement.focus());
  }

  close() { this.open.set(false); this.asking.set(null); }

  go(it: Item) {
    if (it.keep) { it.run(); this.box()?.nativeElement.focus(); return; }
    this.close();
    it.run();
  }

  /** Tab on an "Ask … about this": the question is typed here. */
  private startAsking(it: Item) {
    if (!it.ask) return false;
    this.asking.set(it.ask);
    this.q.set('');
    const el = this.box()?.nativeElement;
    if (el) el.value = '';
    return true;
  }

  nav(e: KeyboardEvent) {
    const n = this.flat().length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this.cursor.set(n ? (this.cursor() + (e.key === 'ArrowDown' ? 1 : -1) + n) % n : 0);
      setTimeout(() => this.list()?.nativeElement.querySelector('[data-on]')?.scrollIntoView({ block: 'nearest' }));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const it = this.flat()[this.cursor()];
      if (it) this.go(it);
    } else if (e.key === 'Tab' && !e.shiftKey && !this.asking()) {
      const it = this.flat()[this.cursor()];
      if (it?.ask) { e.preventDefault(); this.startAsking(it); }
    } else if (e.key === 'Backspace' && this.asking() && !this.q()) {
      e.preventDefault();
      this.asking.set(null);
    }
  }

  key(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (this.open()) this.close(); else this.show();
    } else if (e.key === 'Escape' && this.open()) {
      // Not on to the room under it (the Command Code room stops an answer on Esc).
      e.stopPropagation();
      e.preventDefault();
      if (this.asking()) { this.asking.set(null); this.q.set(''); } else this.close();
    }
  }
}
