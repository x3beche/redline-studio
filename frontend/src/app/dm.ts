import { Component, Injectable, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Toast, ToastTone } from './toast';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { Auth } from './auth';
import { Avatar } from './avatar';
import { T, t } from './i18n';
import { Selection } from './selection';
import { FileModal } from './rooms/file-modal';
import { EmptyState } from './empty-state';

/** Direct messages: people writing to each other in the Chat tab
 *  (backend/dm.py). One store for the whole app - the People in the Chat's
 *  list, the badge on the Chat tab with the senders' pictures, the open
 *  conversation and "Send to..." from the other tabs - fed by one live
 *  stream per page (GET /api/dm/live) and the state it asks for again
 *  whenever something happened (GET /api/dm/state).
 *
 *  Nothing here calls a model: a line goes to the others and that is all.
 *  A thing sent along (a model, a board, a project, a palette, a product,
 *  a stock item, a note, a file, a firmware) is a card that opens it in its
 *  modal right here (DmViewer). It is data, not a pointer: what it was
 *  when it was sent (backend/dm.py snapshots), which the others add to
 *  their own space with one click - and are taken to where it landed. */

export type DmKind = 'model' | 'board' | 'project' | 'taste' | 'product' | 'inventory' | 'note' | 'file' | 'firmware';
export interface DmPerson {
  id: string; name: string; has_avatar: boolean; avatar_v: number | string | null; avatar_colour: string;
  online: boolean; disabled?: boolean;
  /** People: the direct conversation with them, and what is unread in it. Senders: `n` unread. */
  chat?: string | null; unread?: number; n?: number;
}
export interface DmItem {
  kind: DmKind; id?: string; label: string; facts?: string[];
  open?: { model?: string; maker?: string; name?: string };
  /** What was sent (backend/dm.py snapshot): view it, add it, or - its sender - take it back. */
  snap?: string;
  /** In the reader's own space: the original opens in its tab. */
  own?: boolean;
  /** It can be added to one's own space. */
  add?: boolean;
  /** Its sender took it back. */
  revoked?: boolean;
  /** Something left out when it was sent (its 3D view, too big). */
  note?: string;
}
/** What was sent, as it was (GET /api/dm/items/{snap}). */
export interface DmSnapshot {
  snap: string; kind: DmKind; label: string; facts: string[]; by: { id: string; name: string }; at: string;
  add: boolean; data: Record<string, any>; blobs: Record<string, { bytes: number; type: string }>;
}
export interface DmLine { id: string; by: { id: string; name: string }; at: string; text: string; edited_at?: string; items?: DmItem[] }
export interface DmChat {
  /** `members`: the other person (a conversation is between two). */
  id: string; members: DmPerson[]; created_at: string; updated_at: string;
  last: { by: string; by_id: string; text: string; at: string; items?: number } | null;
  unread: number; read: Record<string, string>;
  /** Mine only: the other person pins and archives their own. A new line brings it back from the archive. */
  pinned?: boolean; archived?: boolean;
  messages?: DmLine[]; more?: boolean;
}
export interface DmState {
  enabled: boolean; me?: string; people: DmPerson[]; chats: DmChat[];
  unread: { total: number; senders: DmPerson[] };
}
export interface DmShareable { kind: DmKind; id: string; label: string; sub?: string }
export type DmEvent =
  | { type: 'hello' | 'bye' }
  | { type: 'message' | 'edit'; chat: string; message: DmLine }
  | { type: 'delete'; chat: string; id: string }
  | { type: 'read'; chat: string; user: string; at: string }
  | { type: 'chat'; chat: string };

/** Line drawings, 24 units square (the Chat's own hand). */
export const DM_ICONS: Record<DmKind, string> = {
  model: 'M12 3l8 4.5v9L12 21l-8-4.5v-9z M4 7.5l8 4.5 8-4.5 M12 12v9',
  board: 'M7 7h10v10H7z M10 3v4 M14 3v4 M10 17v4 M14 17v4 M3 10h4 M3 14h4 M17 10h4 M17 14h4',
  project: 'M3 6h7l2 2h9v11H3z',
  taste: 'M4 5h16v4H4z M4 11h16v4H4z M4 17h10v3H4z M7 7h.01 M7 13h.01',
  product: 'M3 20V10l5 3V10l5 3V6h3l1 4h1l1-6h2v16z M7 16h2 M12 16h2 M17 16h1',
  inventory: 'M4 5h16v6H4z M4 11h16v8H4z M10 8h4 M10 15h4',
  note: 'M5 4h14v16H5z M8.5 9h7 M8.5 13h7 M8.5 17h4',
  file: 'M6 3h8l4 4v14H6z M14 3v4h4',
  firmware: 'M6 6h12v12H6z M3 9h3 M3 15h3 M18 9h3 M18 15h3 M10.5 9.5L8.5 12l2 2.5 M13.5 9.5l2 2.5-2 2.5',
};
export const DM_KIND_NAME: Record<DmKind, string> = {
  model: '3D model', board: 'Board', project: 'Project', taste: 'Taste palette', product: 'Part',
  inventory: 'Stock item', note: 'Note', file: 'File', firmware: 'Firmware',
};
/** "Add to my ...", and what is said once it is there. */
export const DM_ADD: Partial<Record<DmKind, string>> = {
  taste: 'Add to my taste', model: 'Add to my models', product: 'Add to my parts', note: 'Add to my notes',
  file: 'Add to my files', inventory: 'Add to my stock',
};
export const DM_ADDED: Partial<Record<DmKind, string>> = {
  taste: 'Added to your taste', model: 'Added to your models', product: 'Added to your parts', note: 'Added to your notes',
  file: 'Added to your files', inventory: 'Added to your stock',
};
export const SHARE_ICON = 'M15 5l4 4-4 4 M19 9H10a5 5 0 0 0-5 5v5';

@Injectable({ providedIn: 'root' })
export class DmApi {
  private http = inject(HttpClient);
  state() { return this.http.get<DmState>('/api/dm/state'); }
  open(person: string) { return this.http.post<DmChat>('/api/dm/chats', { people: [person] }); }
  get(id: string, before = '') { return this.http.get<DmChat>(`/api/dm/chats/${id}` + (before ? `?before=${encodeURIComponent(before)}` : '')); }
  say(id: string, text: string, items: { kind: DmKind; id: string }[]) {
    return this.http.post<DmLine>(`/api/dm/chats/${id}/messages`, { text, items });
  }
  edit(id: string, mid: string, text: string) { return this.http.patch<DmLine>(`/api/dm/chats/${id}/messages/${mid}`, { text }); }
  remove(id: string, mid: string) { return this.http.delete(`/api/dm/chats/${id}/messages/${mid}`); }
  read(id: string) { return this.http.post<{ ok: boolean }>(`/api/dm/chats/${id}/read`, {}); }
  flags(id: string, p: { pinned?: boolean; archived?: boolean }) { return this.http.patch<DmChat>(`/api/dm/chats/${id}`, p); }
  search(q: string) {
    return this.http.get<{ results: { chat_id: string; title: string; message_id: string; at: string; by: string; snippet: string }[] }>(
      `/api/dm/search?q=${encodeURIComponent(q)}`);
  }
  shareables(q: string, kind = '') {
    return this.http.get<DmShareable[]>(`/api/dm/shareables?q=${encodeURIComponent(q)}` + (kind ? `&kind=${kind}` : ''));
  }
  item(kind: DmKind, id: string) { return this.http.get<DmItem>(`/api/dm/item?kind=${kind}&id=${encodeURIComponent(id)}`); }
  snapshot(sid: string) { return this.http.get<DmSnapshot>(`/api/dm/items/${encodeURIComponent(sid)}`); }
  add(sid: string) {
    return this.http.post<{ kind: DmKind; id: string; label: string; maker?: string; folder?: string; already?: boolean }>(
      `/api/dm/items/${encodeURIComponent(sid)}/add`, {});
  }
  unshare(sid: string) { return this.http.post(`/api/dm/items/${encodeURIComponent(sid)}/unshare`, {}); }
}

@Injectable({ providedIn: 'root' })
export class DmStore {
  private api = inject(DmApi);
  private auth = inject(Auth);
  private sel = inject(Selection);

  state = signal<DmState | null>(null);
  /** The direct conversation open in the Chat tab, if one is. */
  open = signal<string | null>(new URLSearchParams(location.search).get('dm'));
  /** "Send to...": the thing waiting for its people (the dialog, DmSend). */
  sendTo = signal<{ kind: DmKind; id: string; label?: string } | null>(null);
  /** What was sent, open in the viewer (DmViewer), by its snapshot. */
  viewing = signal<string | null>(null);
  /** Snapshots being added right now (their buttons wait). */
  adding = signal<Set<string>>(new Set());
  /** A short word after something was sent, saved or taken back: the app's toast (toast.ts). */
  say(m: string, tone: ToastTone = 'ok') { Toast.show(m, { tone }); }

  /** What was sent, made a thing of my own space - and there I go: the
   *  Taste tab with the palette open, the 3D tab with the model, the
   *  catalog with the product, and so on. */
  async addToMine(sid: string) {
    if (this.adding().has(sid)) return;
    this.adding.update(x => new Set(x).add(sid));
    try {
      const got = await firstValueFrom(this.api.add(sid));
      this.say(got.already ? t('Already in your catalog') : t(DM_ADDED[got.kind] ?? 'Added to your space'), got.already ? 'info' : 'ok');
      this.viewing.set(null);
      this.openItem({ kind: got.kind, id: got.id, label: got.label, own: true,
                      open: got.kind === 'product' ? { maker: got.maker, name: got.label } : undefined });
    } catch (e: unknown) {
      this.say((e as { error?: { detail?: string } })?.error?.detail || t('could not add it'), 'danger');
    } finally {
      this.adding.update(x => { const n = new Set(x); n.delete(sid); return n; });
    }
  }
  async unshare(sid: string) {
    try { await firstValueFrom(this.api.unshare(sid)); this.say(t('No longer shared')); }
    catch { this.say(t('could not save that'), 'danger'); }
  }

  enabled = computed(() => !!this.state()?.enabled);
  people = computed(() => this.state()?.people ?? []);
  total = computed(() => this.state()?.unread.total ?? 0);
  /** The badge's faces: the latest senders first, three at most. */
  senders = computed(() => (this.state()?.unread.senders ?? []).slice(0, 3));
  sendersTip = computed(() => (this.state()?.unread.senders ?? []).map(s => `${s.name} (${s.n})`).join(', '));
  chat(id: string | null) { return id ? (this.state()?.chats ?? []).find(c => c.id === id) ?? null : null; }

  private listeners = new Set<(e: DmEvent) => void>();
  on(fn: (e: DmEvent) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  private started = false;
  private abort: AbortController | null = null;
  private again: ReturnType<typeof setTimeout> | null = null;

  /** Once signed in as a person: the state, and the live stream from then on. */
  start() {
    if (this.started) return;
    this.started = true;
    this.refresh();
    void this.connect();
    if (!this.hooked) {
      this.hooked = true;
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.resync(false); });
      window.addEventListener('online', () => this.resync(true));
    }
  }
  stop() {
    this.started = false;
    this.abort?.abort();
    this.state.set(null);
  }

  /** When the live stream last said anything - a keep-alive every 10 s at least. */
  private beat = 0;
  private hooked = false;
  /** Back on the page or the network: a stream quiet for 12 s (or any, back
   *  online) is not trusted - opened again, and the state read again for
   *  what came meanwhile. */
  private resync(force: boolean) {
    if (!this.started) return;
    if (force || Date.now() - this.beat > 12_000) {
      this.abort?.abort();
      if (this.again) clearTimeout(this.again);
      void this.connect();
    }
    this.refresh();
  }

  refresh() {
    this.api.state().subscribe({ next: s => this.state.set(s), error: () => { /* signed out, or no people */ } });
  }
  private soon: ReturnType<typeof setTimeout> | null = null;
  private refreshSoon() {
    if (this.soon) clearTimeout(this.soon);
    this.soon = setTimeout(() => { this.soon = null; this.refresh(); }, 250);
  }

  private async connect() {
    if (!this.started) return;
    const ctl = new AbortController();
    this.abort = ctl;
    let wait = 1500;
    // Silent for 25 s - the API reloaded behind the dev server's proxy, which
    // can leave the stream open and empty for ever: given up, opened again.
    let dead = false;
    this.beat = Date.now();
    const dog = setInterval(() => { if (Date.now() - this.beat > 25_000) { dead = true; ctl.abort(); } }, 5000);
    try {
      const r = await fetch('/api/dm/live', { credentials: 'same-origin', signal: ctl.signal, headers: { Accept: 'text/event-stream' } });
      if (r.status === 401 || r.status === 403) { this.started = false; return; }   // signed out, or no account to write from
      if (!r.ok || !r.body) throw new Error(String(r.status));
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        this.beat = Date.now();
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data:')) continue;
            try { this.take(JSON.parse(line.slice(5)) as DmEvent); } catch { /* a broken line */ }
          }
        }
      }
    } catch {
      wait = 5000;
    } finally {
      clearInterval(dog);
    }
    if ((ctl.signal.aborted && !dead) || !this.started || this.abort !== ctl) return;
    if (dead) this.refresh();                                 // what came while it was silent
    if (this.again) clearTimeout(this.again);
    this.again = setTimeout(() => void this.connect(), wait);
  }

  private take(e: DmEvent) {
    if (e.type === 'hello') { this.refresh(); return; }
    if (e.type === 'bye') return;
    for (const fn of this.listeners) fn(e);
    this.refreshSoon();
  }

  /** The conversation with this person (made the first time), opened in the Chat tab. */
  async withPerson(id: string) {
    const p = this.people().find(x => x.id === id);
    if (p?.chat) { this.show(p.chat); return; }
    const c = await firstValueFrom(this.api.open(id));
    this.show(c.id);
    this.refresh();
  }
  show(id: string | null) {
    this.open.set(id);
    if (id) {
      this.sel.thread.set(null);
      this.sel.room.set('commandcode');
    }
    const url = new URL(location.href);
    if (id) url.searchParams.set('dm', id); else url.searchParams.delete('dm');
    if (url.href !== location.href) history.replaceState(null, '', url);
  }
  /** Pinned or archived, for me: at once here, then as the server has it. */
  setFlags(id: string, p: { pinned?: boolean; archived?: boolean }) {
    const s = this.state();
    if (s) this.state.set({ ...s, chats: s.chats.map(x => x.id === id ? { ...x, ...p } : x) });
    this.api.flags(id, p).subscribe({
      next: () => this.refreshSoon(),
      error: () => { this.say(t('could not save that'), 'danger'); this.refresh(); },
    });
  }
  /** Read, here: its count goes at once, not on the next state. */
  markRead(id: string) {
    const s = this.state();
    const c = s?.chats.find(x => x.id === id);
    if (s && c?.unread) {
      const n = c.unread;
      this.state.set({ ...s, chats: s.chats.map(x => x.id === id ? { ...x, unread: 0 } : x),
                       people: s.people.map(p => p.chat === id ? { ...p, unread: 0 } : p),
                       unread: { ...s.unread, total: Math.max(0, s.unread.total - n) } });
    }
    if (this.auth.can('draw')) this.api.read(id).subscribe({ next: () => this.refreshSoon(), error: () => {} });
  }

  /** A sent thing, opened where it lives. */
  openItem(it: DmItem) {
    if (it.revoked) return;
    if (!it.own || !it.id) { if (it.snap) this.viewing.set(it.snap); return; }
    const s = this.sel;
    switch (it.kind) {
      case 'model': s.room.set('cad'); s.ask('model', it.id); break;
      case 'project': if (it.open?.model) { s.room.set('cad'); s.ask('model', it.open.model); } else s.room.set('cad'); break;
      case 'board': s.openBoard(it.id); break;
      case 'taste': s.room.set('taste'); s.ask('taste', it.id); break;
      case 'product': s.room.set('mfr'); setTimeout(() => s.ask('mfr-open', it.id), 50); break;
      // A stock line sent before stock was a part of the Parts page: its product, there.
      case 'inventory': s.room.set('mfr'); s.ask('mfr-stock-item', it.id); break;
      case 'note': s.room.set('notes'); s.ask('note', it.id); break;
      case 'file': s.room.set('files'); FileModal.open({ id: it.id, name: it.label }); break;
      case 'firmware': s.jumpToFirmware(it.id, null); break;
    }
  }
}

/** A thing sent in a line: its icon, name, kind and a line of facts, with
 *  "View" (the modal, right here) and "Add to my ..." (a thing of one's own
 *  space made from it, and there one goes). The sender's own card, in the
 *  space it came from, opens the original instead of adding it again - and
 *  can take it back. */
@Component({
  selector: 'rl-dm-card',
  imports: [T],
  template: `
<div class="tcv-dm-card" [attr.data-kind]="item().kind" [attr.data-revoked]="item().revoked ? 1 : null">
  <button class="tcv-dm-cardmain" type="button" [disabled]="item().revoked" (click)="view()"
          [title]="(item().revoked ? 'No longer shared' : 'View it') | t">
    <span class="tcv-dm-cardico"><svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="icon()" /></svg></span>
    <span class="tcv-dm-cardtext">
      <span class="tcv-dm-cardtop"><b>{{ item().label }}</b><span class="tcv-dm-cardkind">{{ kindName() | t }}</span></span>
      @if (item().revoked) {
        <span class="tcv-dm-cardfacts tcv-dm-cardlock">{{ 'No longer shared' | t }}</span>
      } @else if (item().facts?.length) {
        <span class="tcv-dm-cardfacts">{{ item().facts!.join(' · ') }}</span>
      }
    </span>
  </button>
  @if (!item().revoked && item().snap) {
    <span class="tcv-dm-cardacts">
      <button class="tcv-cc-textbtn" data-act="dm-view" (click)="view()">{{ 'View it' | t }}</button>
      @if (item().own && item().id) {
        <button class="tcv-cc-textbtn" data-act="dm-open" (click)="store.openItem(item())">{{ 'Open' | t }}</button>
      } @else if (item().add && addLabel() && auth.can('edit')) {
        <button class="tcv-cc-textbtn" data-act="dm-add" [disabled]="store.adding().has(item().snap!)"
                (click)="store.addToMine(item().snap!)">{{ addLabel()! | t }}</button>
      }
      @if (mine() && auth.can('draw')) {
        <button class="tcv-cc-textbtn tcv-dm-unshare" (click)="store.unshare(item().snap!)"
                [title]="'The others cannot view it or add it any more' | t">{{ 'Take back' | t }}</button>
      }
    </span>
  }
</div>`,
})
export class DmCard {
  store = inject(DmStore);
  auth = inject(Auth);
  item = input.required<DmItem>();
  /** Sent by the reader: they may take it back. */
  mine = input(false);
  icon = computed(() => DM_ICONS[this.item().kind] ?? DM_ICONS.file);
  kindName = computed(() => DM_KIND_NAME[this.item().kind] ?? this.item().kind);
  addLabel = computed(() => DM_ADD[this.item().kind] ?? null);
  view() { const s = this.item().snap; if (s && !this.item().revoked) this.store.viewing.set(s); }
}

/** "Send to...": a thing of this tab, to one or more people - each gets it
 *  in their direct conversation, with a line if one is written. */
@Component({
  selector: 'app-dm-send',
  imports: [EmptyState, T, Avatar, DmCard],
  host: { '(window:keydown.escape)': 'close()' },
  template: `
@if (store.sendTo(); as what) {
  <div class="tcv-dm-scrim" animate.leave="tcv-leave" (mousedown)="scrimDown($event)" (click)="scrimClick()">
    <div class="tcv-dm-dialog tcv-dm-send" role="dialog" aria-modal="true" aria-labelledby="dm-send-title">
      <h2 id="dm-send-title" class="tcv-dm-dtitle">{{ 'Send to…' | t }}</h2>
      @if (card(); as c) { <rl-dm-card [item]="c" /> }
      @else if (err()) { <p class="tcv-dm-dtext tcv-dm-err">{{ err() }}</p> }
      <input class="tcv-field" type="search" [placeholder]="'Find a person' | t" [value]="q()" (input)="q.set($any($event.target).value)">
      <div class="tcv-dm-sendlist" role="listbox" aria-multiselectable="true">
        @for (p of shown(); track p.id) {
          <label class="tcv-dm-sendrow" [attr.data-on]="picked().has(p.id) ? 1 : null">
            <input type="checkbox" class="tcv-check" [checked]="picked().has(p.id)" (change)="toggle(p.id)">
            <app-avatar [name]="p.name" [userId]="p.id" [hasPicture]="p.has_avatar" [v]="p.avatar_v" [colour]="p.avatar_colour" [size]="24" />
            <span class="tcv-dm-sendname">{{ p.name }}</span>
            @if (p.online) { <span class="tcv-dm-dot" [title]="'online' | t"></span> }
          </label>
        } @empty {
          <wb-empty compact [icon]="store.people().length ? 'search' : 'chat'" [text]="store.people().length ? 'Nobody matches.' : 'There is nobody else on this server yet.'" />
        }
      </div>
      <textarea class="tcv-field tcv-dm-sendtext" rows="2" [placeholder]="'Add a message (optional)' | t" [value]="text()"
                (input)="text.set($any($event.target).value)"></textarea>
      <div class="tcv-dm-drow">
        <button type="button" class="tcv-btn tcv-dm-dbtn" (click)="close()">{{ 'Cancel' | t }}</button>
        <button type="button" class="tcv-btn tcv-dm-dbtn tcv-dm-dok" [disabled]="!picked().size || !card() || busy()" (click)="send()">
          {{ (busy() ? 'Sending…' : 'Send') | t }}@if (picked().size > 1) { ({{ picked().size }}) }</button>
      </div>
    </div>
  </div>
}
`,
})
export class DmSend {
  store = inject(DmStore);
  private api = inject(DmApi);
  q = signal('');
  text = signal('');
  picked = signal<Set<string>>(new Set());
  card = signal<DmItem | null>(null);
  err = signal<string | null>(null);
  busy = signal(false);
  down = false;

  shown = computed(() => {
    const w = this.q().trim().toLocaleLowerCase();
    return this.store.people().filter(p => !w || p.name.toLocaleLowerCase().includes(w));
  });

  constructor() {
    // The card as it will be sent, read from the server when asked.
    effect(() => {
      const w = this.store.sendTo();
      untracked(() => {
        this.card.set(null); this.err.set(null); this.picked.set(new Set()); this.text.set(''); this.q.set('');
        if (!w) return;
        this.store.refresh();
        this.api.item(w.kind, w.id).subscribe({ next: c => this.card.set(c), error: e => this.err.set(e?.error?.detail || t('could not read it')) });
      });
    });
  }

  toggle(id: string) {
    this.picked.update(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }
  close() { this.store.sendTo.set(null); }
  /** Only a press that began and ended on the dim ground closes it (not a drag out of a field). */
  scrimDown(e: MouseEvent) { this.down = e.target === e.currentTarget; }
  scrimClick() { if (this.down) this.close(); }

  async send() {
    const w = this.store.sendTo();
    if (!w || !this.picked().size) return;
    this.busy.set(true);
    const names: string[] = [];
    try {
      for (const pid of this.picked()) {
        const p = this.store.people().find(x => x.id === pid);
        const cid = p?.chat ?? (await firstValueFrom(this.api.open(pid))).id;
        await firstValueFrom(this.api.say(cid, this.text().trim(), [{ kind: w.kind, id: w.id }]));
        names.push(p?.name ?? pid);
      }
      this.close();
      this.store.say(t('Sent to') + ' ' + names.join(', '));
      this.store.refresh();
    } catch (e: unknown) {
      this.err.set((e as { error?: { detail?: string } })?.error?.detail || t('could not send that'));
    } finally {
      this.busy.set(false);
    }
  }
}

/** The "Send to..." button the other tabs put beside a thing. */
@Component({
  selector: 'rl-dm-send-btn',
  imports: [T],
  template: `@if (store.enabled() && store.people().length) {
  <button type="button" [class]="cls()" (click)="store.sendTo.set({ kind: kind(), id: id(), label: label() }); $event.stopPropagation()"
          [title]="'Send to a person in Chat' | t">
    <svg class="tcv-dm-sendico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="ICON" /></svg>
    @if (text()) { <span>{{ 'Send to…' | t }}</span> }
  </button>
}`,
})
export class DmSendButton {
  store = inject(DmStore);
  kind = input.required<DmKind>();
  id = input.required<string>();
  label = input<string>('');
  /** The button's own classes, as the place it sits in draws its buttons. */
  cls = input<string>('tcv-btn');
  text = input(true);
  readonly ICON = SHARE_ICON;
}
