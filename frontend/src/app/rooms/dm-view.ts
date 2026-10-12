import {
  Component, ElementRef, TemplateRef, computed, effect, inject, input, output, signal, untracked, viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { Auth } from '../auth';
import { Avatar } from '../avatar';
import { T, t } from '../i18n';
import { Markdown } from '../markdown';
import {
  DM_ICONS, DM_KIND_NAME, DmApi, DmCard, DmChat, DmEvent, DmKind, DmLine, DmPerson, DmShareable, DmStore, SHARE_ICON,
} from '../dm';
import { Skeleton } from '../skeleton';

const MAX_TEXT = 20_000;
const MAX_ITEMS = 8;
const KINDS: DmKind[] = ['model', 'board', 'project', 'taste', 'product', 'inventory', 'note', 'file', 'firmware'];

function stamp(iso: string) {
  const d = new Date(iso);
  return isNaN(+d) ? '' : d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** When, in the list's words: the time today, the day this week, else the date. */
export function dmWhen(iso: string | null | undefined) {
  if (!iso) return '';
  const d = new Date(iso), now = new Date();
  if (isNaN(+d)) return '';
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (now.getTime() - d.getTime() < 6 * 86400_000) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** The People in the Chat's list (backend/dm.py): everyone else on the
 *  server, the ones who wrote first, then who is online; a click opens the
 *  conversation with them. The groups one is in follow; "New group" picks
 *  several people. A search in the list narrows them by name. */
@Component({
  selector: 'app-dm-people',
  host: { style: 'display: contents' },
  imports: [T, Avatar],
  template: `
@if (store.enabled()) {
  <div class="tcv-cc-group tcv-dm-grouphead">
    <span>{{ 'People' | t }}</span>
    @if (auth.can('draw') && store.people().length > 1) {
      <button class="tcv-cc-textbtn" data-act="dm-group" (click)="toggleGroup()" [class.on]="grouping()">
        {{ (grouping() ? 'Cancel' : 'New group') | t }}</button>
    }
  </div>
  @if (grouping()) {
    <div class="tcv-dm-groupbar">
      <input class="tcv-field" type="text" maxlength="120" [placeholder]="'Group name (optional)' | t" [value]="title()"
             (input)="title.set($any($event.target).value)">
      <button class="tcv-btn tcv-btn-accent" [disabled]="picked().size < 2" (click)="makeGroup()">
        {{ 'Start' | t }}@if (picked().size) { ({{ picked().size }}) }</button>
    </div>
  }
  @for (p of shown(); track p.id) {
    <div class="tcv-cc-item tcv-dm-person" role="listitem" tabindex="0" [attr.data-person]="p.id"
         [attr.data-on]="p.chat && p.chat === store.open() ? 1 : null" [attr.data-unread]="p.unread ? 1 : null"
         (click)="pick(p)" (keydown.enter)="pick(p)">
      @if (grouping()) {
        <input type="checkbox" class="tcv-cc-itemcheck" [checked]="picked().has(p.id)" (click)="$event.stopPropagation()"
               (change)="togglePick(p.id)" [attr.aria-label]="'Select' | t">
      }
      <span class="tcv-dm-face">
        <app-avatar [name]="p.name" [userId]="p.id" [hasPicture]="p.has_avatar" [v]="p.avatar_v" [colour]="p.avatar_colour" [size]="26" />
        @if (p.online) { <span class="tcv-dm-dot" [title]="'online' | t"></span> }
      </span>
      <div class="tcv-cc-itemtext">
        <div class="tcv-cc-itemtop">
          <span class="tcv-cc-itemtitle">{{ p.name }}</span>
          @if (p.unread) { <span class="tcv-th-badge" [title]="'unread' | t">{{ p.unread }}</span> }
          @else if (lastOf(p.chat); as l) { <span class="tcv-cc-itemwhen">{{ when(l.at) }}</span> }
        </div>
        <div class="tcv-cc-itemsnip">
          @if (lastOf(p.chat); as l) { {{ l.by_id === store.state()?.me ? ('you' | t) + ': ' : '' }}{{ l.text }} }
          @else { {{ (p.online ? 'online' : 'Write a message') | t }} }
        </div>
      </div>
    </div>
  } @empty {
    <p class="tcv-cc-listempty">{{ (q().trim() ? 'Nobody matches.' : 'There is nobody else on this server yet.') | t }}</p>
  }
  @for (g of groups(); track g.id) {
    <div class="tcv-cc-item tcv-dm-person" role="listitem" tabindex="0" [attr.data-on]="g.id === store.open() ? 1 : null"
         (click)="store.show(g.id); opened.emit()" (keydown.enter)="store.show(g.id); opened.emit()">
      <span class="tcv-dm-face tcv-dm-stack">
        @for (m of g.members.slice(0, 2); track m.id) {
          <app-avatar [name]="m.name" [userId]="m.id" [hasPicture]="m.has_avatar" [v]="m.avatar_v" [colour]="m.avatar_colour" [size]="20" />
        }
      </span>
      <div class="tcv-cc-itemtext">
        <div class="tcv-cc-itemtop">
          <span class="tcv-cc-itemtitle">{{ groupName(g) }}</span>
          @if (g.unread) { <span class="tcv-th-badge">{{ g.unread }}</span> }
          @else if (g.last) { <span class="tcv-cc-itemwhen">{{ when(g.last.at) }}</span> }
        </div>
        <div class="tcv-cc-itemsnip">{{ g.last ? g.last.by + ': ' + g.last.text : g.members.length + 1 + ' ' + ('people' | t) }}</div>
      </div>
    </div>
  }
  @if (err()) { <p class="tcv-cc-listempty tcv-dm-err">{{ err() }}</p> }
}`,
})
export class DmPeople {
  store = inject(DmStore);
  auth = inject(Auth);
  q = input('');
  opened = output<void>();
  grouping = signal(false);
  picked = signal<Set<string>>(new Set());
  title = signal('');
  err = signal<string | null>(null);

  shown = computed(() => {
    const w = this.q().trim().toLocaleLowerCase();
    return this.store.people().filter(p => !w || p.name.toLocaleLowerCase().includes(w));
  });
  groups = computed(() => {
    const w = this.q().trim().toLocaleLowerCase();
    return this.store.groups().filter(g => !w || this.groupName(g).toLocaleLowerCase().includes(w));
  });
  lastOf(cid: string | null | undefined) { return this.store.chat(cid ?? null)?.last ?? null; }
  when = dmWhen;
  groupName(g: DmChat) { return g.title || g.members.map(m => m.name).join(', '); }

  async pick(p: DmPerson) {
    if (this.grouping()) { this.togglePick(p.id); return; }
    this.err.set(null);
    try { await this.store.withPerson(p.id); this.opened.emit(); }
    catch { this.err.set(t('could not open the conversation')); }
  }
  toggleGroup() { this.grouping.set(!this.grouping()); this.picked.set(new Set()); this.title.set(''); }
  togglePick(id: string) {
    this.picked.update(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }
  async makeGroup() {
    try {
      await this.store.group([...this.picked()], this.title().trim());
      this.toggleGroup();
      this.opened.emit();
    } catch { this.err.set(t('could not open the conversation')); }
  }
}

/** One direct conversation, in the Chat tab's conversation area: the
 *  lines, live as they come, and a composer that sends to the people in
 *  it - text (Markdown) and things of one's own space as cards. Nobody's
 *  model answers. */
@Component({
  selector: 'app-dm-view',
  host: { style: 'display: contents' },
  imports: [Skeleton, NgTemplateOutlet, T, Avatar, Markdown, DmCard],
  template: `
<header class="tcv-cc-bar tcv-dm-bar">
  <button class="tcv-cc-ib tcv-cc-burger" (click)="menu.emit()" [title]="'Conversations' | t">
    <ng-container *ngTemplateOutlet="ico(); context: { $implicit: MENU }" /></button>
  @if (chat(); as c) {
    <span class="tcv-dm-face tcv-dm-stack">
      @for (m of c.members.slice(0, 3); track m.id) {
        <app-avatar [name]="m.name" [userId]="m.id" [hasPicture]="m.has_avatar" [v]="m.avatar_v" [colour]="m.avatar_colour" [size]="28" />
      }
      @if (c.direct && c.members[0]?.online) { <span class="tcv-dm-dot"></span> }
    </span>
    <div class="tcv-th-title">
      <b>{{ name() }}</b>
      <span class="tcv-cc-dim">{{ sub() }}</span>
    </div>
  }
</header>

<div class="tcv-cc-log tcv-cc-scroll" #log (scroll)="scrolled()">
  <div class="tcv-cc-col">
    @if (chat()?.more) {
      <button class="tcv-cc-textbtn tcv-dm-more" (click)="older()">{{ 'Earlier messages' | t }}</button>
    }
    @for (m of lines(); track m.id; let i = $index) {
      @let mine = m.by.id === me();
      @let p = person(m.by.id);
      <article class="tcv-cc-row tcv-dm-row" [attr.data-role]="mine ? 'user' : 'other'" [attr.data-mid]="m.id"
               [attr.data-editing]="editing() === m.id ? 1 : null" [attr.data-same]="same(i) ? 1 : null">
        <span class="tcv-dm-avwrap" [attr.data-hide]="same(i) ? 1 : null">
          <app-avatar [name]="m.by.name" [userId]="m.by.id" [hasPicture]="p?.has_avatar ?? mineAv()?.has_avatar"
                      [v]="p?.avatar_v ?? mineAv()?.avatar_v" [colour]="p?.avatar_colour ?? mineAv()?.avatar_colour" [size]="30" />
        </span>
        <div class="tcv-cc-rowmain">
          <div class="tcv-cc-rowhead">
            @if (!same(i)) { <b>{{ mine ? ('you' | t) : m.by.name }}</b> }
            @if (m.edited_at) { <span>· {{ 'edited' | t }}</span> }
            <span class="tcv-cc-hovtime">{{ stamp(m.at) }}</span>
          </div>
          @if (editing() === m.id) {
            <div class="tcv-dm-edit">
              <textarea class="tcv-field" rows="3" [value]="editText()" (input)="editText.set($any($event.target).value)"
                        (keydown)="editKey($event, m)"></textarea>
              <div class="tcv-dm-editacts">
                <button class="tcv-cc-textbtn" (click)="editing.set(null)">{{ 'Cancel' | t }}</button>
                <button class="tcv-btn tcv-btn-accent" [disabled]="!editText().trim()" (click)="saveEdit(m)">{{ 'Save' | t }}</button>
              </div>
            </div>
          } @else if (m.text) {
            <div class="tcv-cc-bubble tcv-dm-bubble md" [innerHTML]="m.text | md"></div>
          }
          @if (m.items?.length) {
            <div class="tcv-dm-cards">
              @for (it of m.items; track $index) { <rl-dm-card [item]="it" [mine]="mine" /> }
            </div>
          }
          <div class="tcv-cc-foot">
            <div class="tcv-cc-tools" role="toolbar">
              @if (m.text) {
                <button class="tcv-cc-ib" (click)="copy(m.text)" [title]="'Copy' | t">
                  <ng-container *ngTemplateOutlet="ico(); context: { $implicit: COPY }" /></button>
              }
              @if (mine && auth.can('draw')) {
                @if (m.text) {
                  <button class="tcv-cc-ib" (click)="startEdit(m)" [title]="'Edit' | t">
                    <ng-container *ngTemplateOutlet="ico(); context: { $implicit: EDIT }" /></button>
                }
                <button class="tcv-cc-ib tcv-cc-danger" (click)="remove(m)" [title]="'Delete' | t">
                  <ng-container *ngTemplateOutlet="ico(); context: { $implicit: TRASH }" /></button>
              }
            </div>
            @if (mine && m.id === seenId()) { <span class="tcv-dm-seen">{{ 'Seen' | t }}</span> }
          </div>
        </div>
      </article>
    } @empty {
      @if (loaded()) {
        <div class="tcv-cc-hello">
          <div class="tcv-cc-hello-mark"><ng-container *ngTemplateOutlet="ico(); context: { $implicit: SHARE }" /></div>
          <h2>{{ name() }}</h2>
          <p>{{ 'Write a message, or send a model, a board, a project, a palette, a product, a stock item, a note, a file or a firmware. Only the people in this conversation read it; no model answers.' | t }}</p>
        </div>
      } @else { <wb-skel kind="text" [count]="6" style="padding: 14px 16px" /> }
    }
  </div>
</div>

@if (auth.can('draw')) {
  <div class="tcv-cc-composer" [class.focus]="focused()">
    @if (items().length) {
      <div class="tcv-cc-picked">
        @for (it of items(); track it.kind + it.id) {
          <span class="tcv-cc-mchip" [attr.data-kind]="it.kind" [title]="kindName(it.kind) | t">
            <ng-container *ngTemplateOutlet="ico(); context: { $implicit: kindIcon(it.kind) }" />
            <span>{{ it.label }}</span>
            <button class="tcv-cc-mx" (click)="unpick(it)" [title]="'Remove' | t">
              <ng-container *ngTemplateOutlet="ico(); context: { $implicit: X }" /></button>
          </span>
        }
      </div>
    }
    @if (pop()) {
      <div class="tcv-cc-mpop tcv-dm-pop" animate.leave="tcv-leave" role="listbox" (mousedown)="keepFocus($event)">
        <div class="tcv-cc-mhead tcv-dm-pophead">
          <ng-container *ngTemplateOutlet="ico(); context: { $implicit: SHARE }" />
          <input #find class="tcv-dm-find" type="search" [value]="popQ()" [placeholder]="'Send something of yours…' | t"
                 (input)="popQ.set($any($event.target).value); look()" (keydown)="popKey($event)">
        </div>
        <div class="tcv-dm-kinds">
          <button [class.on]="!popKind()" (click)="setKind('')">{{ 'All' | t }}</button>
          @for (k of KINDS; track k) {
            <button [class.on]="popKind() === k" (click)="setKind(k)">{{ kindName(k) | t }}</button>
          }
        </div>
        <div class="tcv-cc-mlist">
          @for (r of rows(); track r.kind + r.id; let k = $index) {
            <button role="option" [class.on]="k === idx()" [attr.aria-selected]="k === idx()" (mouseenter)="idx.set(k)" (click)="pickRow(r)">
              <ng-container *ngTemplateOutlet="ico(); context: { $implicit: kindIcon(r.kind) }" />
              <span class="tcv-cc-modelname">{{ r.label }}</span>
              <span class="tcv-cc-dim tcv-cc-msub">{{ r.sub }}</span>
              <span class="tcv-cc-tag">{{ kindName(r.kind) | t }}</span>
            </button>
          } @empty {
            <p class="tcv-cc-dim tcv-cc-pad">{{ popBusy() ? ('Loading…' | t) : ('Nothing matches.' | t) }}</p>
          }
        </div>
        <div class="tcv-cc-mfoot tcv-cc-dim"><kbd>↑↓</kbd> {{ 'choose' | t }} · <kbd>↵</kbd> {{ 'add' | t }} · <kbd>Esc</kbd> {{ 'close' | t }}</div>
      </div>
    }
    <textarea #box rows="1" [value]="text()" [placeholder]="('Write a message' | t) + '… (' + ('@ to send something' | t) + ')'"
              (input)="typed($any($event.target)); grow()" (keydown)="key($event)"
              (focus)="focused.set(true)" (blur)="focused.set(false)"></textarea>
    <div class="tcv-cc-compbar">
      <button class="tcv-cc-ib" data-act="dm-share" (click)="openPop()" [class.on]="pop()"
              [title]="('Send a model, board, palette, product…' | t) + ' (@)'">
        <ng-container *ngTemplateOutlet="ico(); context: { $implicit: SHARE }" /></button>
      <span class="tcv-cc-hint"><kbd>↵</kbd> {{ 'send' | t }} · <kbd>⇧↵</kbd> {{ 'new line' | t }}</span>
      <span class="grow"></span>
      <button class="tcv-cc-send" [disabled]="!canSend()" (click)="send()" [title]="('Send' | t) + ' (Enter)'">
        <ng-container *ngTemplateOutlet="ico(); context: { $implicit: SEND }" /></button>
    </div>
  </div>
}
@if (error(); as e) { <div class="tcv-cc-alert" role="alert"><span>{{ e }}</span>
  <button class="tcv-cc-textbtn" (click)="error.set(null)">{{ 'close' | t }}</button></div> }
`,
})
export class DmView {
  store = inject(DmStore);
  auth = inject(Auth);
  private api = inject(DmApi);

  id = input.required<string>();
  ico = input.required<TemplateRef<unknown>>();
  menu = output<void>();

  readonly MENU = 'M4 6h16 M4 12h16 M4 18h16';
  readonly SEND = 'M12 19V5 M6 11l6-6 6 6';
  readonly COPY = 'M9 9h11v11H9z M15 9V4H4v11h5';
  readonly EDIT = 'M4 20h4L19.5 8.5l-4-4L4 16z M13.5 6.5l4 4';
  readonly TRASH = 'M4 7h16 M9.5 7V4h5v3 M6.5 7l.8 13h9.4l.8-13 M10 11v5.5 M14 11v5.5';
  readonly X = 'M6 6l12 12 M18 6L6 18';
  readonly SHARE = SHARE_ICON;
  readonly KINDS = KINDS;

  chat = signal<DmChat | null>(null);
  lines = signal<DmLine[]>([]);
  loaded = signal(false);
  text = signal('');
  items = signal<DmShareable[]>([]);
  focused = signal(false);
  error = signal<string | null>(null);
  editing = signal<string | null>(null);
  editText = signal('');

  pop = signal(false);
  popQ = signal('');
  popKind = signal<DmKind | ''>('');
  rows = signal<DmShareable[]>([]);
  idx = signal(0);
  popBusy = signal(false);

  me = computed(() => this.store.state()?.me ?? this.auth.state()?.user?.id ?? '');
  mineAv = computed(() => this.auth.state()?.user ?? null);
  name = computed(() => {
    const c = this.chat();
    if (!c) return '';
    return c.title || c.members.map(m => m.name).join(', ');
  });
  sub = computed(() => {
    const c = this.chat();
    if (!c) return '';
    if (c.direct) return c.members[0]?.online ? t('online') : t('direct message');
    return `${c.members.length + 1} ${t('people')}`;
  });
  /** My last line that everyone else has read since. */
  seenId = computed(() => {
    const c = this.chat(), me = this.me();
    const mine = [...this.lines()].reverse().find(m => m.by.id === me);
    if (!c || !mine || !c.members.length) return null;
    const last = this.lines().at(-1);
    if (last && last.id !== mine.id) return null;
    return c.members.every(m => (c.read?.[m.id] ?? '') >= mine.at) ? mine.id : null;
  });

  private log = viewChild<ElementRef<HTMLDivElement>>('log');
  private box = viewChild<ElementRef<HTMLTextAreaElement>>('box');
  private find = viewChild<ElementRef<HTMLInputElement>>('find');
  private off: () => void;

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => this.load(id));
    });
    this.off = this.store.on(e => this.take(e));
  }
  ngOnDestroy() { this.off(); }

  private load(id: string) {
    this.chat.set(null); this.lines.set([]); this.loaded.set(false); this.items.set([]); this.text.set('');
    this.editing.set(null); this.pop.set(false);
    this.api.get(id).subscribe({
      next: c => {
        if (id !== this.id()) return;
        this.chat.set(c); this.lines.set(c.messages ?? []); this.loaded.set(true);
        this.store.markRead(id);
        this.scroll();
        this.focusSoon();
      },
      error: e => {
        this.loaded.set(true);
        this.error.set(e?.status === 404 ? t('This conversation is not yours to read, or it is gone.') : t('could not open the conversation'));
      },
    });
  }

  older() {
    const c = this.chat(), first = this.lines()[0];
    if (!c || !first) return;
    const el = this.log()?.nativeElement, h = el?.scrollHeight ?? 0;
    this.api.get(c.id, first.at).subscribe({
      next: got => {
        this.lines.update(l => [...(got.messages ?? []), ...l]);
        this.chat.update(x => x ? { ...x, more: got.more } : x);
        setTimeout(() => { if (el) el.scrollTop += el.scrollHeight - h; });
      },
      error: () => {},
    });
  }

  private take(e: DmEvent) {
    if (!('chat' in e) || e.chat !== this.id()) return;
    if (e.type === 'message') {
      if (!this.lines().some(m => m.id === e.message.id)) {
        this.lines.update(l => [...l, e.message]);
        this.scroll(e.message.by.id !== this.me());
        if (e.message.by.id !== this.me() && document.visibilityState === 'visible') this.store.markRead(this.id());
      }
    } else if (e.type === 'edit') {
      this.lines.update(l => l.map(m => m.id === e.message.id ? e.message : m));
    } else if (e.type === 'delete') {
      this.lines.update(l => l.filter(m => m.id !== e.id));
    } else if (e.type === 'read') {
      this.chat.update(c => c ? { ...c, read: { ...c.read, [e.user]: e.at } } : c);
    }
  }

  person(id: string) { return this.chat()?.members.find(m => m.id === id) ?? null; }
  same(i: number) {
    const l = this.lines();
    if (i <= 0 || l[i].by.id !== l[i - 1].by.id) return false;
    return new Date(l[i].at).getTime() - new Date(l[i - 1].at).getTime() < 5 * 60_000;
  }
  stamp = stamp;
  kindIcon(k: DmKind) { return DM_ICONS[k]; }
  kindName(k: DmKind) { return DM_KIND_NAME[k]; }

  canSend() { return !!this.text().trim() || this.items().length > 0; }

  send() {
    if (!this.canSend()) return;
    const text = this.text().trim();
    if (text.length > MAX_TEXT) { this.error.set(`${t('too long to send')}: ${text.length} / ${MAX_TEXT}`); return; }
    const items = this.items();
    const id = this.id();
    this.text.set(''); this.items.set([]);
    const el = this.box()?.nativeElement;
    if (el) el.value = '';
    this.grow();
    this.api.say(id, text, items.map(i => ({ kind: i.kind, id: i.id }))).subscribe({
      next: m => {
        if (id !== this.id()) return;
        if (!this.lines().some(x => x.id === m.id)) this.lines.update(l => [...l, m]);
        this.scroll();
        this.store.refresh();
      },
      error: e => {
        this.error.set(e?.error?.detail || t('could not send that'));
        if (!this.text()) this.text.set(text);
        if (!this.items().length) this.items.set(items);
      },
    });
  }

  key(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.send(); return; }
    if (e.key === 'Escape' && this.pop()) { this.pop.set(false); }
  }

  /** `@` at the start of a word opens the picker; the `@` itself is not kept. */
  typed(el: HTMLTextAreaElement) {
    const v = el.value, at = el.selectionStart ?? v.length;
    if (v[at - 1] === '@' && (at === 1 || /\s/.test(v[at - 2]))) {
      const clean = v.slice(0, at - 1) + v.slice(at);
      el.value = clean;
      this.text.set(clean);
      this.openPop();
      return;
    }
    this.text.set(v);
  }

  grow() {
    const el = this.box()?.nativeElement;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 260) + 'px';
  }

  openPop() {
    if (this.pop()) { this.pop.set(false); return; }
    this.pop.set(true); this.popQ.set(''); this.idx.set(0);
    this.look();
    setTimeout(() => this.find()?.nativeElement.focus());
  }
  setKind(k: DmKind | '') { this.popKind.set(k); this.idx.set(0); this.look(); this.find()?.nativeElement.focus(); }
  keepFocus(e: MouseEvent) { if ((e.target as HTMLElement).tagName !== 'INPUT') e.preventDefault(); }
  private seq = 0;
  private lookTimer: ReturnType<typeof setTimeout> | null = null;
  look() {
    if (this.lookTimer) clearTimeout(this.lookTimer);
    this.popBusy.set(true);
    this.lookTimer = setTimeout(() => {
      const n = ++this.seq;
      this.api.shareables(this.popQ(), this.popKind()).subscribe({
        next: r => { if (n === this.seq) { this.rows.set(r); this.popBusy.set(false); this.idx.set(0); } },
        error: () => { if (n === this.seq) { this.rows.set([]); this.popBusy.set(false); } },
      });
    }, 150);
  }
  popKey(e: KeyboardEvent) {
    const n = this.rows().length;
    if (e.key === 'ArrowDown') { e.preventDefault(); this.idx.set(n ? (this.idx() + 1) % n : 0); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); this.idx.set(n ? (this.idx() - 1 + n) % n : 0); }
    else if (e.key === 'Enter') { e.preventDefault(); const r = this.rows()[this.idx()]; if (r) this.pickRow(r); }
    else if (e.key === 'Escape') { e.preventDefault(); this.pop.set(false); this.box()?.nativeElement.focus(); }
  }
  pickRow(r: DmShareable) {
    if (!this.items().some(i => i.kind === r.kind && i.id === r.id) && this.items().length < MAX_ITEMS) {
      this.items.update(l => [...l, r]);
    }
    this.pop.set(false);
    this.box()?.nativeElement.focus();
  }
  unpick(r: DmShareable) { this.items.update(l => l.filter(i => !(i.kind === r.kind && i.id === r.id))); }

  copy(text: string) { void navigator.clipboard?.writeText(text).catch(() => {}); }
  startEdit(m: DmLine) { this.editing.set(m.id); this.editText.set(m.text); }
  editKey(e: KeyboardEvent, m: DmLine) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.saveEdit(m); }
    else if (e.key === 'Escape') this.editing.set(null);
  }
  saveEdit(m: DmLine) {
    const text = this.editText().trim();
    if (!text) return;
    this.api.edit(this.id(), m.id, text).subscribe({
      next: got => { this.lines.update(l => l.map(x => x.id === got.id ? got : x)); this.editing.set(null); this.store.refresh(); },
      error: e => this.error.set(e?.error?.detail || t('could not save that')),
    });
  }
  remove(m: DmLine) {
    this.lines.update(l => l.filter(x => x.id !== m.id));
    this.api.remove(this.id(), m.id).subscribe({
      next: () => this.store.refresh(),
      error: e => { this.error.set(e?.error?.detail || t('could not delete that')); this.load(this.id()); },
    });
  }

  private follow = true;
  scrolled() {
    const el = this.log()?.nativeElement;
    if (el) this.follow = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
  }
  private scroll(onlyIfAtEnd = false) {
    if (onlyIfAtEnd && !this.follow) return;
    const go = () => { const e = this.log()?.nativeElement; if (e) e.scrollTop = e.scrollHeight; };
    setTimeout(() => { go(); requestAnimationFrame(go); });
    for (const ms of [150, 500]) setTimeout(go, ms);
  }
  private focusSoon(tries = 20) {
    if (matchMedia('(hover: none)').matches) return;
    const el = this.box()?.nativeElement;
    if (el && el.offsetParent) { el.focus(); return; }
    if (tries > 0) setTimeout(() => this.focusSoon(tries - 1), 50);
  }
}
