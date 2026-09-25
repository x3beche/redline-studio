import { Component, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Auth } from './auth';
import { Catalog, FolderNode } from './api';
import { Selection } from './selection';
import { WORKSPACES } from './workspaces';
import { NotesApi } from './rooms/notes';
import { Prefs } from './preferences';
import { THEMES, THEME_NAMES } from '../theme';
import { LANG, LANGS, T, setLang, t } from './i18n';

/** Ctrl+K: one box to go anywhere and do anything.
 *
 *  Type, and it offers - the rooms; every model, board and app by name;
 *  every tool; the things you can do (build, show the code, release, a
 *  technical drawing, a new note...); and, from the server, code lines,
 *  notes, chats, revisions and parts that mention what you typed. Arrows
 *  move, Enter goes, Esc closes. What it opens it asks of the room that
 *  can (Selection.ask), so the rooms keep doing their own work.
 */
interface Item {
  group: string; label: string; hint?: string; icon: string;
  run: () => void; keys?: string;
}

interface Hit {
  kind: 'code' | 'note' | 'chat' | 'revision' | 'part';
  id: string; label: string; text?: string; file?: 'model' | 'board'; line?: number; room?: string; model?: string;
}

const ROOM_ICON: Record<string, string> = {
  cad: '◆', pcb: '▦', embedded: '⌁', web: '◎', mobile: '▯', notes: '✎', tools: '⚒', analyze: '▤',
};

function words(q: string) { return q.toLowerCase().split(/\s+/).filter(Boolean); }

/** Every word somewhere in the text; earlier and whole-word matches first. */
function score(text: string, ws: string[]): number {
  const t = text.toLowerCase();
  let s = 0;
  for (const w of ws) {
    const i = t.indexOf(w);
    if (i < 0) return 0;
    s += 10 - Math.min(i, 9) + (i === 0 || /\W/.test(t[i - 1]) ? 5 : 0);
  }
  return s;
}

@Component({
  selector: 'app-palette',
  imports: [T],
  template: `
@if (open()) {
  <div class="tcv-pal-back" (click)="close()">
    <div class="tcv-pal" (click)="$event.stopPropagation()" role="dialog" aria-label="Command palette">
      <input #box class="tcv-pal-input" [placeholder]="'Go to a model, board, tool or room - search code, notes, chats, parts - or type an action' | t"
             [value]="q()" (input)="q.set($any($event.target).value)" (keydown)="nav($event)" aria-label="Search">
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
      <div class="tcv-pal-foot">{{ '↑↓ to move · Enter to open · Esc to close' | t }}
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
      { group: 'Actions', icon: '⚙', label: 'Preferences', hint: 'theme, language, shortcuts', run: () => this.prefs.open.set('appearance') },
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
    return out;
  }

  private places(): Item[] {
    const out: Item[] = WORKSPACES.map(w => ({
      group: 'Rooms', icon: ROOM_ICON[w.id] ?? '·', label: w.label, hint: 'room', run: () => this.picked.room.set(w.id),
    }));
    const walk = (n: FolderNode & { boards?: { id: string; title?: string }[]; apps?: { id: string; title: string; platform: 'web' | 'embedded' | 'mobile' }[] }) => {
      for (const m of n.models) out.push({ group: 'Models', icon: '◆', label: m.title || m.name, hint: m.id,
        run: () => { this.picked.room.set('cad'); this.picked.ask('model', m.id); } });
      for (const b of n.boards ?? []) out.push({ group: 'Boards', icon: '▦', label: b.title || b.id, hint: `${b.id}.pcb`,
        run: () => this.picked.openBoard(b.id) });
      for (const a of n.apps ?? []) out.push({ group: 'Apps', icon: ROOM_ICON[a.platform] ?? '◎', label: a.title, hint: a.platform,
        run: () => this.picked.openApp(a.id, a.platform) });
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
    const ws = words(this.q());
    const local = [...this.actions(), ...this.places()];
    // Nothing typed: the room's own actions and the rooms; themes and
    // languages wait to be asked for.
    if (!ws.length) return [...this.actions().filter(i => !/^(Theme|Language): /.test(i.label)),
                            ...local.filter(i => i.group === 'Rooms')];
    // Actions only when they match; then a small lead over names that match as well.
    const ranked = local.map(i => ({ i, s: score(`${i.label} ${t(i.label)} ${i.hint ?? ''}`, ws) }))
      .filter(x => x.s > 0).map(x => ({ ...x, s: x.s + (x.i.group === 'Actions' ? 3 : 0) }))
      .sort((a, b) => b.s - a.s).slice(0, 40).map(x => x.i);
    return [...ranked, ...this.found()];
  });

  grouped = computed(() => {
    const out: { name: string; items: { item: Item; i: number }[] }[] = [];
    const order = ['Actions', 'Rooms', 'Models', 'Boards', 'Apps', 'Tools', 'In the code', 'Notes', 'Chats', 'Revisions', 'Parts'];
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

  show() {
    if (!this.auth.signedIn()) return;
    this.q.set('');
    this.open.set(true);
    this.catalog.tree().subscribe(t => this.tree.set(t));
    if (!this.tools().length) {
      fetch('/api/tools/catalog').then(r => r.ok ? r.json() : null)
        .then(d => d && this.tools.set(d.tools)).catch(() => {});
    }
    setTimeout(() => this.box()?.nativeElement.focus());
  }

  close() { this.open.set(false); }

  go(it: Item) { this.close(); it.run(); }

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
    }
  }

  key(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (this.open()) this.close(); else this.show();
    } else if (e.key === 'Escape' && this.open()) {
      this.close();
    }
  }
}
