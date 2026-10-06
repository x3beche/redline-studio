import {
  Component, ElementRef, Injectable, OnDestroy, computed, effect, inject, signal, untracked, viewChild,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { NgTemplateOutlet } from '@angular/common';
import { toHtml } from '../markdown';
import { Auth } from '../auth';
import { T, t } from '../i18n';

/** The Command Code room: people talking with a model, in the open.
 *
 *  A conversation is the workspace's: anyone here reads it and adds to it,
 *  and each line says who wrote it. The answer streams in as it is written
 *  and is kept when it is done (backend/cc_chat.py). Each conversation
 *  keeps its own model; a new one starts with the model chosen for the
 *  Command Code room in Preferences > LLM settings.
 *
 *  The list: pinned on top, then by day; archived ones behind a filter;
 *  a delete waits a few seconds for "Undo" before it is sent, alone or a
 *  selection at once - and then goes to the Trash, where it can be
 *  restored for 30 days (or deleted for good) before the server drops it. A line: copied, deleted, the last one of one's own
 *  edited and sent again, the last answer written again (with another
 *  model if wished); every code block has its own copy button.
 */
export interface CcMessage {
  id: string; role: 'user' | 'assistant'; content: string; at: string; edited_at?: string;
  by?: { id?: string; name?: string; type?: string };
  provider?: string; model?: string; ms?: number; thinking_ms?: number; error?: string; stopped?: boolean;
  usage?: { prompt_tokens?: number | null; completion_tokens?: number | null; cost?: number | null };
}
export interface CcChat {
  id: string; title: string; provider: string; model: string; by: { name?: string; id?: string };
  created_at: string; updated_at: string; count: number; pinned?: boolean; archived?: boolean;
  messages?: CcMessage[]; last?: { role: string; text: string; by?: string };
  /** In the trash: when, by whom, and when the server drops it for good. */
  deleted_at?: string; deleted_by?: { id?: string; name?: string }; purge_at?: string; days_left?: number;
}
export type CcTab = 'list' | 'archived' | 'trash';
type Many = { deleted: string[]; refused: string[]; missing: string[] };
export interface LlmModel { id: string; name: string; context: number | null; anthropic: boolean }
export interface CcEvent {
  type: string; text?: string; error?: string; message?: CcMessage | null; keep?: number; title?: string;
}

const HEADERS = { 'Content-Type': 'application/json', 'X-Redline-CSRF': '1' };

@Injectable({ providedIn: 'root' })
export class CcApi {
  private http = inject(HttpClient);
  list(q = '', tab: CcTab = 'list') {
    return this.http.get<CcChat[]>(`/api/cc/chats?q=${encodeURIComponent(q)}&archived=${tab === 'archived' ? 1 : 0}`
                                   + (tab === 'trash' ? '&trash=1' : ''));
  }
  get(id: string) { return this.http.get<CcChat>(`/api/cc/chats/${id}`); }
  create(provider?: string, model?: string) { return this.http.post<CcChat>('/api/cc/chats', { provider, model }); }
  patch(id: string, p: { title?: string; provider?: string; model?: string; pinned?: boolean; archived?: boolean }) {
    return this.http.patch<CcChat>(`/api/cc/chats/${id}`, p);
  }
  remove(id: string) { return this.http.delete(`/api/cc/chats/${id}`); }
  removeMany(ids: string[]) { return this.http.post<Many>('/api/cc/chats/bulk-delete', { ids }); }
  // The trash: back out of it, or gone for good.
  restore(id: string) { return this.http.post<CcChat>(`/api/cc/chats/${id}/restore`, {}); }
  restoreMany(ids: string[]) {
    return this.http.post<{ restored: string[]; refused: string[]; missing: string[] }>('/api/cc/chats/bulk-restore', { ids });
  }
  purge(id: string) { return this.http.delete(`/api/cc/chats/${id}?forever=1`); }
  purgeMany(ids: string[]) { return this.http.post<Many>('/api/cc/chats/bulk-delete', { ids, forever: true }); }
  emptyTrash() { return this.http.post<{ deleted: number; kept: number }>('/api/cc/chats/empty-trash', {}); }
  /** Deletes still waiting when the page goes: sent so they outlive it. */
  removeOnLeave(ids: string[]) {
    try {
      fetch('/api/cc/chats/bulk-delete', { method: 'POST', keepalive: true, credentials: 'same-origin',
                                          headers: HEADERS, body: JSON.stringify({ ids }) });
    } catch { /* the page is going anyway */ }
  }
  removeMessage(id: string, mid: string) { return this.http.delete<CcChat>(`/api/cc/chats/${id}/messages/${mid}`); }
  models(provider: string) { return this.http.get<LlmModel[]>(`/api/llm/models?provider=${provider}`); }

  /** Send a line (or, with `edit`, replace one's own and drop what followed);
   *  the answer comes back piece by piece through `on`. */
  say(id: string, body: { text: string; provider: string; model: string; edit?: string }, signal: AbortSignal,
      on: (ev: CcEvent) => void) {
    return this.sse(`/api/cc/chats/${id}/messages`, body, signal, on);
  }

  /** The last answer written again, with this model. */
  regenerate(id: string, body: { provider: string; model: string }, signal: AbortSignal, on: (ev: CcEvent) => void) {
    return this.sse(`/api/cc/chats/${id}/regenerate`, body, signal, on);
  }

  private async sse(url: string, body: object, signal: AbortSignal, on: (ev: CcEvent) => void) {
    const r = await fetch(url, {
      method: 'POST', credentials: 'same-origin', signal, headers: HEADERS, body: JSON.stringify(body),
    });
    if (!r.ok || !r.body) {
      let detail = `HTTP ${r.status}`;
      try { detail = (await r.json()).detail ?? detail; } catch { /* not json */ }
      throw new Error(detail);
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of chunk.split('\n')) {
          if (line.startsWith('data:')) {
            try { on(JSON.parse(line.slice(5))); } catch { /* a broken line */ }
          }
        }
      }
    }
  }
}

const PROVIDERS = [{ id: 'commandcode', name: 'Command Code' }, { id: 'openrouter', name: 'OpenRouter' }];
const UNDO_MS = 6000;

/** Line drawings, 24 units square, stroked in the text colour - the same
 *  hand as the top bar's tab icons (topbar.ts), whose PCB, 3D and Command
 *  Code drawings are reused here. */
const I = {
  plus: 'M12 5v14 M5 12h14',
  search: 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14z M20 20l-4.2-4.2',
  pin: 'M9 3h6 M10 3v6.5L7 13h10l-3-3.5V3 M12 13v8',
  archive: 'M4 4h16v4H4z M5.5 8v12h13V8 M10 12h4',
  unarchive: 'M4 4h16v4H4z M5.5 8v12h13V8 M12 18v-6 M9.5 14.5L12 12l2.5 2.5',
  trash: 'M4 7h16 M9.5 7V4h5v3 M6.5 7l.8 13h9.4l.8-13 M10 11v5.5 M14 11v5.5',
  restore: 'M4.5 12a7.5 7.5 0 1 0 2.2-5.3 M4.5 4v5h5',
  copy: 'M9 9h11v11H9z M15 9V4H4v11h5',
  edit: 'M4 20h4L19.5 8.5l-4-4L4 16z M13.5 6.5l4 4',
  regen: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3 M19.5 4v5h-5',
  chevron: 'M7 10l5 5 5-5',
  more: 'M5.5 12h.01 M12 12h.01 M18.5 12h.01',
  send: 'M12 19V5 M6 11l6-6 6 6',
  stop: 'M7 7h10v10H7z',
  menu: 'M4 6h16 M4 12h16 M4 18h16',
  download: 'M12 4v11 M7 10l5 5 5-5 M5 20h14',
  select: 'M4 4h16v16H4z M8 12l3 3 5-6',
  x: 'M6 6l12 12 M18 6L6 18',
  bot: 'M5 8h14v10H5z M12 8V5 M9 12.5h.01 M15 12.5h.01 M9.5 15.5h5 M3 12v3 M21 12v3',
  chat: 'M4 5h16v11h-9l-5 4v-4H4z M8 9l2.5 2L8 13 M13 13h3',
  pcb: 'M7 7h10v10H7z M10 3v4 M14 3v4 M10 17v4 M14 17v4 M3 10h4 M3 14h4 M17 10h4 M17 14h4',
  chip: 'M5 8h14v8H5z M8 8V5 M12 8V5 M16 8V5 M8 16v3 M12 16v3 M16 16v3 M8.5 12h1',
  cad: 'M12 3l8 4.5v9L12 21l-8-4.5v-9z M4 7.5l8 4.5 8-4.5 M12 12v9',
};

/** Where to begin, for an empty conversation: the work this app is for. */
const STARTERS: { icon: string; area: string; text: string }[] = [
  { icon: I.pcb, area: 'PCB', text: 'What protection should a 5 V / 3 A USB-C power input have (TVS, fuse, reverse polarity)? Give part examples.' },
  { icon: I.pcb, area: 'PCB', text: 'How wide should a 2 A trace be on 1 oz copper, and how many vias does the same current need?' },
  { icon: I.chip, area: 'Firmware', text: 'Write a non-blocking debounce for 4 buttons on an STM32 (HAL) that tells a short press from a long one.' },
  { icon: I.chip, area: 'Firmware', text: 'How do I put an ESP32-S3 into deep sleep and wake it on a GPIO or a timer? Show the code.' },
  { icon: I.cad, area: 'CAD', text: 'In build123d, how do I model a snap-fit lid for a 60 × 40 × 20 mm box with 2 mm walls?' },
  { icon: I.cad, area: 'CAD', text: 'What clearances should I design for FDM-printed press fits, sliding fits and screw holes?' },
];

type Group = { name: string; chats: CcChat[] };
type Toast = { text: string; undo?: () => void; ms: number; label?: string };
/** A question asked in the list before something cannot be undone. */
type Ask = { text: string; label: string; go: () => void };

@Component({
  selector: 'app-room-commandcode',
  imports: [T, NgTemplateOutlet],
  host: { '(window:keydown)': 'globalKey($event)', '(window:pagehide)': 'flushDeletes(true)' },
  template: `
<ng-template #ico let-d><svg class="tcv-cc-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="d" /></svg></ng-template>

<div class="tcv-room tcv-cc-room absolute inset-0 flex min-h-0 gap-1 p-1" [attr.data-drawer]="drawer() ? 1 : null">
  <!-- LEFT: the conversations -->
  <aside class="tcv-notes-side tcv-cc-side">
    <div class="tcv-cc-sidehead">
      @if (auth.can('draw')) {
        <button class="tcv-cc-newbtn" (click)="newChat()" [title]="('New conversation' | t) + ' (' + mod + 'Shift+O)'">
          <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.plus }" />
          <span>{{ 'New conversation' | t }}</span>
          <kbd class="tcv-cc-kbd">{{ modShort }}⇧O</kbd>
        </button>
      }
      <label class="tcv-cc-search">
        <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.search }" />
        <input type="search" [placeholder]="'Search conversations' | t" [value]="q()"
               (input)="q.set($any($event.target).value)" (keydown.escape)="q.set('')">
      </label>
      <div class="tcv-cc-filterrow">
        <div class="tcv-cc-seg" role="tablist">
          <button role="tab" [class.on]="tab() === 'list'" (click)="showTab('list')">{{ 'Conversations' | t }}</button>
          <button role="tab" [class.on]="tab() === 'archived'" (click)="showTab('archived')">{{ 'Archived' | t }}</button>
          <button role="tab" data-tab="trash" [class.on]="tab() === 'trash'" (click)="showTab('trash')">{{ 'Trash' | t }}</button>
        </div>
        <span class="grow"></span>
        @if (trash() && auth.can('draw') && shownChats().length && !selecting()) {
          <button class="tcv-cc-ib tcv-cc-danger" data-act="empty" (click)="askEmpty()" [title]="'Empty trash' | t">
            <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.trash }" /></button>
        }
        @if (auth.can('draw') && shownChats().length) {
          <button class="tcv-cc-ib" data-act="select" [class.on]="selecting()" (click)="toggleSelecting()" [title]="'Select several' | t">
            <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.select }" /></button>
        }
      </div>
      @if (selecting()) {
        <div class="tcv-cc-selbar">
          <label class="tcv-cc-check"><input type="checkbox" [checked]="allSelected()" [indeterminate]="someSelected()"
                 (change)="selectAll($any($event.target).checked)"> {{ selected().size }} {{ 'selected' | t }}</label>
          <span class="grow"></span>
          @if (trash()) {
            <button class="tcv-cc-ib" data-act="restore-sel" [disabled]="!selected().size" (click)="restoreSelected()" [title]="'Restore' | t">
              <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.restore }" /></button>
            <button class="tcv-cc-ib tcv-cc-danger" data-act="purge-sel" [disabled]="!selected().size" (click)="purgeSelected()"
                    [title]="'Delete forever' | t">
              <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.trash }" /></button>
          } @else {
            <button class="tcv-cc-ib" [disabled]="!selected().size" (click)="archiveSelected()"
                    [title]="(archived() ? 'Unarchive' : 'Archive') | t">
              <ng-container *ngTemplateOutlet="ico; context: { $implicit: archived() ? I.unarchive : I.archive }" /></button>
            <button class="tcv-cc-ib tcv-cc-danger" [disabled]="!selected().size" (click)="deleteSelected()" [title]="'Delete' | t">
              <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.trash }" /></button>
          }
          <button class="tcv-cc-ib" (click)="toggleSelecting()" [title]="'Cancel' | t">
            <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.x }" /></button>
        </div>
      }
      @if (ask(); as a) {
        <div class="tcv-cc-ask" role="alertdialog" [attr.aria-label]="a.text">
          <span>{{ a.text }}</span>
          <div class="tcv-cc-askacts">
            <button class="tcv-cc-textbtn" (click)="ask.set(null)">{{ 'Cancel' | t }}</button>
            <button class="tcv-cc-askgo" data-act="confirm" (click)="ask.set(null); a.go()">{{ a.label }}</button>
          </div>
        </div>
      }
    </div>
    <div class="tcv-notes-list tcv-cc-list" role="list">
      @if (trash() && shownChats().length) {
        <p class="tcv-cc-trashnote">{{ 'Deleted conversations are kept here for 30 days, then deleted for good.' | t }}</p>
      }
      @for (g of groups(); track g.name) {
        <div class="tcv-cc-group">{{ g.name | t }}</div>
        @for (c of g.chats; track c.id) {
          <div class="tcv-cc-item" role="listitem" tabindex="0" [attr.data-on]="c.id === openId() ? 1 : null"
               [attr.data-trash]="c.deleted_at ? 1 : null"
               [attr.data-sel]="selected().has(c.id) ? 1 : null" (click)="pick(c, $event)" (keydown.enter)="pick(c, $event)"
               [title]="short(c.model) + ' · ' + c.count + ' ' + ('lines' | t) + (c.by.name ? ' · ' + c.by.name : '')
                        + (c.deleted_at ? ' · ' + ('deleted' | t) + ' ' + stamp(c.deleted_at) : '')">
            @if (selecting()) {
              <input type="checkbox" class="tcv-cc-itemcheck" [checked]="selected().has(c.id)" (click)="$event.stopPropagation()"
                     (change)="toggleSel(c.id)" [attr.aria-label]="'Select' | t">
            }
            <div class="tcv-cc-itemtext">
              <div class="tcv-cc-itemtop">
                @if (c.pinned) { <svg class="tcv-cc-ico tcv-cc-pinmark" viewBox="0 0 24 24"><path [attr.d]="I.pin" /></svg> }
                <span class="tcv-cc-itemtitle">{{ c.title | t }}</span>
                <span class="tcv-cc-itemwhen">{{ when(c.deleted_at || c.updated_at) }}</span>
              </div>
              @if (c.deleted_at) {
                <div class="tcv-cc-itemsnip tcv-cc-gone">
                  <span>{{ deletedBy(c) }}</span>
                  <span class="tcv-cc-purge" [attr.data-soon]="(c.days_left ?? 30) <= 3 ? 1 : null" [title]="c.purge_at ? stamp(c.purge_at) : ''">
                    · {{ purgeText(c) }}</span>
                </div>
              } @else {
                <div class="tcv-cc-itemsnip">{{ c.last ? (c.last.by ? c.last.by + ': ' : '') + snip(c.last.text) : ('No messages yet' | t) }}</div>
              }
            </div>
            @if (c.deleted_at && mayDelete(c) && !selecting()) {
              <div class="tcv-cc-itemacts">
                <button class="tcv-cc-ib" data-act="restore" (click)="restoreChats([c]); $event.stopPropagation()" [title]="'Restore' | t">
                  <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.restore }" /></button>
                <button class="tcv-cc-ib tcv-cc-danger" data-act="purge" (click)="askPurge([c]); $event.stopPropagation()"
                        [title]="'Delete forever' | t">
                  <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.trash }" /></button>
              </div>
            } @else if (!c.deleted_at && auth.can('draw') && !selecting()) {
              <div class="tcv-cc-itemacts">
                <button class="tcv-cc-ib" (click)="togglePin(c); $event.stopPropagation()" [class.on]="c.pinned"
                        [title]="(c.pinned ? 'Unpin' : 'Pin') | t">
                  <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.pin }" /></button>
                <button class="tcv-cc-ib" (click)="toggleArchive(c); $event.stopPropagation()"
                        [title]="(c.archived ? 'Unarchive' : 'Archive') | t">
                  <ng-container *ngTemplateOutlet="ico; context: { $implicit: c.archived ? I.unarchive : I.archive }" /></button>
                @if (mayDelete(c)) {
                  <button class="tcv-cc-ib tcv-cc-danger" (click)="deleteChats([c]); $event.stopPropagation()"
                          [title]="'Delete the conversation' | t">
                    <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.trash }" /></button>
                }
              </div>
            }
          </div>
        }
      } @empty {
        <p class="tcv-cc-listempty">{{ (trash() ? 'The trash is empty.' : archived() ? 'No archived conversations.'
                                        : 'No conversations yet - start one.') | t }}</p>
      }
    </div>
  </aside>
  <div class="tcv-cc-scrim" (click)="drawer.set(false)"></div>

  <!-- RIGHT: one conversation -->
  <section class="tcv-cc-main">
    @if (chat(); as c) {
      <header class="tcv-cc-bar">
        <button class="tcv-cc-ib tcv-cc-burger" (click)="drawer.set(!drawer())" [title]="'Conversations' | t">
          <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.menu }" /></button>
        <input class="tcv-cc-title" [value]="c.title | t" (change)="rename($any($event.target).value)"
               (keydown.enter)="$any($event.target).blur()" [readonly]="!auth.can('draw')" [title]="'Rename' | t">
        <div class="tcv-cc-baracts">
          @if (auth.can('draw')) {
            <button class="tcv-cc-ib tcv-cc-wide" (click)="togglePin(c)" [class.on]="c.pinned" [title]="(c.pinned ? 'Unpin' : 'Pin') | t">
              <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.pin }" /></button>
          }
          <button class="tcv-cc-ib tcv-cc-wide" (click)="exportChat()" [disabled]="!messages().length" [title]="'Export as Markdown' | t">
            <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.download }" /></button>
          <div class="tcv-cc-menuwrap">
            <button class="tcv-cc-ib tcv-cc-more" (click)="menu.set(!menu()); $event.stopPropagation()" [class.on]="menu()" [title]="'More' | t">
              <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.more }" /></button>
            @if (menu()) {
              <div class="tcv-cc-menu" (click)="menu.set(false)">
                @if (auth.can('draw')) {
                  <button (click)="togglePin(c)"><ng-container *ngTemplateOutlet="ico; context: { $implicit: I.pin }" />
                    {{ (c.pinned ? 'Unpin' : 'Pin') | t }}</button>
                  <button (click)="toggleArchive(c)"><ng-container *ngTemplateOutlet="ico; context: { $implicit: c.archived ? I.unarchive : I.archive }" />
                    {{ (c.archived ? 'Unarchive' : 'Archive') | t }}</button>
                }
                <button (click)="copyChat()" [disabled]="!messages().length"><ng-container *ngTemplateOutlet="ico; context: { $implicit: I.copy }" />
                  {{ 'Copy conversation' | t }}</button>
                <button (click)="exportChat()" [disabled]="!messages().length"><ng-container *ngTemplateOutlet="ico; context: { $implicit: I.download }" />
                  {{ 'Export as Markdown' | t }}</button>
                @if (mayDelete(c)) {
                  <hr>
                  <button class="tcv-cc-danger" (click)="deleteChats([c])"><ng-container *ngTemplateOutlet="ico; context: { $implicit: I.trash }" />
                    {{ 'Delete the conversation' | t }}</button>
                }
              </div>
            }
          </div>
          @if (mayDelete(c)) {
            <button class="tcv-cc-ib tcv-cc-danger" (click)="deleteChats([c])" [title]="'Delete the conversation' | t">
              <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.trash }" /></button>
          }
        </div>
      </header>

      <div class="tcv-cc-log tcv-cc-scroll" #log (click)="logClick($event)">
        <div class="tcv-cc-col">
          @for (m of messages(); track m.id; let i = $index; let last = $last) {
            <article class="tcv-cc-row" [attr.data-role]="m.role" [attr.data-editing]="editing() === m.id ? 1 : null">
              <div class="tcv-cc-av" [attr.data-role]="m.role" [attr.data-me]="m.by?.id === me() ? 1 : null">
                @if (m.role === 'user') { {{ initials(m.by?.name) }} }
                @else { <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.bot }" /> }
              </div>
              <div class="tcv-cc-rowmain">
                <div class="tcv-cc-rowhead">
                  @if (m.role === 'user') { <b>{{ m.by?.name || ('someone' | t) }}</b> }
                  @else { <b [title]="m.model || ''">{{ short(m.model || '') }}</b> }
                  <time [title]="stamp(m.at)">{{ when(m.at) }}</time>
                  @if (m.edited_at) { <span [title]="stamp(m.edited_at)">· {{ 'edited' | t }}</span> }
                  @if (m.stopped) { <span>· {{ 'stopped' | t }}</span> }
                  @if (m.role === 'assistant') {
                    <span class="tcv-cc-meta">
                      @if (m.ms) { <span>{{ secs(m.ms) }}{{ m.thinking_ms ? ' · ' + ('thought' | t) + ' ' + secs(m.thinking_ms) : '' }}</span> }
                      @if (m.usage?.prompt_tokens || m.usage?.completion_tokens) {
                        <span [title]="'tokens in / out' | t">{{ num(m.usage?.prompt_tokens) }} → {{ num(m.usage?.completion_tokens) }} tok</span>
                      }
                      @if (m.usage?.cost != null) { <span>{{ money(m.usage?.cost) }}</span> }
                      @if (m.provider) { <span>{{ provLabel(m.provider) }}</span> }
                    </span>
                  }
                </div>
                @if (m.role === 'assistant') {
                  <div class="tcv-cc-answer md" [innerHTML]="html(m.content)"></div>
                } @else {
                  <div class="tcv-cc-bubble">{{ m.content }}</div>
                }
                @if (m.error) { <div class="tcv-cc-errline">{{ m.error }}</div> }
                <div class="tcv-cc-tools" role="toolbar">
                  @if (m.content) {
                    <button class="tcv-cc-ib" (click)="copy(m.content)" [title]="'Copy' | t">
                      <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.copy }" /></button>
                  }
                  @if (!live() && auth.can('draw')) {
                    @if (m.role === 'user' && m.id === editableId()) {
                      <button class="tcv-cc-ib" (click)="startEdit(m)" [title]="('Edit and send again' | t) + ' (↑)'">
                        <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.edit }" /></button>
                    }
                    @if (last && m.role === 'assistant' && mayRegen()) {
                      <button class="tcv-cc-ib" (click)="regenerate()" [title]="'Answer again' | t">
                        <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.regen }" /></button>
                      <label class="tcv-cc-ib tcv-cc-regen" [title]="'Answer again with another model' | t">
                        <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.chevron }" />
                        <select (change)="regenerate($any($event.target).value); $any($event.target).value = ''">
                          <option value="" selected disabled>{{ 'Answer again with another model' | t }}</option>
                          @for (x of models(); track x.id) { <option [value]="x.id">{{ x.name }}</option> }
                        </select>
                      </label>
                    }
                    @if (mayDropLine(i)) {
                      <button class="tcv-cc-ib tcv-cc-danger" [class.armed]="armed() === m.id" (click)="deleteLine(m)"
                              [title]="'Delete this line' | t">
                        <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.trash }" />
                        @if (armed() === m.id) { <span>{{ 'Delete?' | t }}</span> }
                      </button>
                    }
                  }
                </div>
              </div>
            </article>
          }
          @if (live(); as l) {
            <article class="tcv-cc-row" data-role="assistant">
              <div class="tcv-cc-av" data-role="assistant"><ng-container *ngTemplateOutlet="ico; context: { $implicit: I.bot }" /></div>
              <div class="tcv-cc-rowmain">
                <div class="tcv-cc-rowhead"><b>{{ short(liveModel() || model()) }}</b>
                  <span class="tcv-cc-pulse">{{ l.text ? ('writing…' | t) : ('thinking…' | t) }}</span>
                  <span class="tcv-cc-dim">· Esc {{ 'stops' | t }}</span></div>
                @if (l.thinking && !l.text) { <div class="tcv-cc-thinking">{{ tail(l.thinking) }}</div> }
                @if (l.text) { <div class="tcv-cc-answer md" [innerHTML]="html(l.text)"></div> }
                @else { <div class="tcv-cc-dots"><i></i><i></i><i></i></div> }
              </div>
            </article>
          }
          @if (!messages().length && !live()) {
            <ng-container *ngTemplateOutlet="hello" />
          }
        </div>
      </div>

      @if (error(); as e) {
        <div class="tcv-cc-alert" role="alert"><span>{{ e }}</span>
          <button class="tcv-cc-ib" (click)="error.set(null)" [title]="'Close' | t">
            <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.x }" /></button></div>
      }
      @if (auth.can('draw')) {
        <div class="tcv-cc-composer" [class.focus]="focused()" [class.editing]="editing()">
          @if (editing()) {
            <div class="tcv-cc-editbar">
              <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.edit }" />
              <span>{{ 'Editing your message - what came after it will be replaced.' | t }}</span>
              <span class="grow"></span>
              <button class="tcv-cc-textbtn" (click)="cancelEdit()">{{ 'Cancel' | t }}</button>
            </div>
          }
          <textarea #box rows="1" [value]="text()" [placeholder]="'Write to the model…' | t"
                    (input)="text.set($any($event.target).value); grow()" (keydown)="key($event)"
                    (focus)="focused.set(true)" (blur)="focused.set(false)"></textarea>
          <div class="tcv-cc-compbar">
            <div class="tcv-cc-menuwrap">
              <button class="tcv-cc-chip" (click)="toggleModelPop(); $event.stopPropagation()" [class.on]="modelPop()"
                      [title]="('Model' | t) + ': ' + provName() + ' · ' + model()">
                <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.bot }" />
                <span>{{ modelName() }}</span>
                <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.chevron }" />
              </button>
              @if (modelPop()) {
                <div class="tcv-cc-modelpop" (click)="$event.stopPropagation()">
                  <div class="tcv-cc-seg tcv-cc-seg-full">
                    @for (p of providers; track p.id) {
                      <button [class.on]="p.id === provider()" (click)="pickProvider(p.id)">{{ p.name }}</button>
                    }
                  </div>
                  <label class="tcv-cc-search">
                    <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.search }" />
                    <input #mq type="search" [placeholder]="'Find a model' | t" [value]="modelQ()"
                           (input)="modelQ.set($any($event.target).value)" (keydown.escape)="modelPop.set(false)"
                           (keydown.enter)="pickFirstModel()">
                  </label>
                  <div class="tcv-cc-modellist">
                    @for (x of shownModels(); track x.id) {
                      <button [class.on]="x.id === model()" (click)="pickModel(x.id); modelPop.set(false)">
                        <span class="tcv-cc-modelname">{{ x.name }}</span>
                        @if (x.anthropic) { <span class="tcv-cc-tag">Claude</span> }
                        @if (x.context) { <span class="tcv-cc-dim">{{ ctx(x.context) }}</span> }
                      </button>
                    } @empty {
                      <p class="tcv-cc-dim tcv-cc-pad">{{ models().length ? ('No model matches.' | t) : ('Loading…' | t) }}</p>
                    }
                  </div>
                </div>
              }
            </div>
            <span class="tcv-cc-hint">
              <kbd>↵</kbd> {{ 'send' | t }} · <kbd>⇧↵</kbd> {{ 'new line' | t }} · <kbd>↑</kbd> {{ 'edit last' | t }}
            </span>
            <span class="grow"></span>
            @if (live()) {
              <button class="tcv-cc-send stop" (click)="stop()" [title]="('Stop' | t) + ' (Esc)'">
                <svg class="tcv-cc-ico" viewBox="0 0 24 24"><path class="fill" [attr.d]="I.stop" /></svg></button>
            } @else {
              <button class="tcv-cc-send" [disabled]="!text().trim()" (click)="send()"
                      [title]="((editing() ? 'Send again' : 'Send') | t) + ' (Enter)'">
                <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.send }" /></button>
            }
          </div>
        </div>
      }
    } @else {
      <div class="tcv-cc-log tcv-cc-scroll">
        <div class="tcv-cc-col">
          <button class="tcv-cc-ib tcv-cc-burger tcv-cc-burger-intro" (click)="drawer.set(true)">
            <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.menu }" /> {{ 'Conversations' | t }}</button>
          <ng-container *ngTemplateOutlet="hello" />
        </div>
      </div>
    }
    @if (toast(); as tt) {
      <div class="tcv-cc-toast" role="status">
        <span>{{ tt.text }}</span>
        @if (tt.undo) { <button class="tcv-cc-undo" (click)="tt.undo!()">{{ (tt.label || 'Undo') | t }}</button> }
        <span class="tcv-cc-toastbar" [style.animation-duration.ms]="tt.ms"></span>
      </div>
    }
  </section>
</div>

<ng-template #hello>
  <div class="tcv-cc-hello">
    <div class="tcv-cc-hello-mark"><ng-container *ngTemplateOutlet="ico; context: { $implicit: I.chat }" /></div>
    <h2>{{ 'What are we building today?' | t }}</h2>
    <p>{{ 'Ask about a board, firmware or a model. Everyone in this workspace sees the conversation and can join it.' | t }}</p>
    @if (auth.can('draw')) {
      <div class="tcv-cc-starters">
        @for (s of starters; track s.text) {
          <button class="tcv-cc-starter" (click)="starter(s.text)">
            <span class="tcv-cc-starter-area"><ng-container *ngTemplateOutlet="ico; context: { $implicit: s.icon }" /> {{ s.area | t }}</span>
            <span class="tcv-cc-starter-text">{{ s.text | t }}</span>
          </button>
        }
      </div>
    }
  </div>
</ng-template>`,
})
export class RoomCommandCode implements OnDestroy {
  private api = inject(CcApi);
  auth = inject(Auth);
  private box = viewChild<ElementRef<HTMLTextAreaElement>>('box');
  private logEl = viewChild<ElementRef<HTMLDivElement>>('log');

  readonly providers = PROVIDERS;
  readonly starters = STARTERS;
  readonly I = I;
  private readonly mac = /Mac|iPhone|iPad/.test(navigator.platform);
  readonly mod = this.mac ? '⌘+' : 'Ctrl+';
  readonly modShort = this.mac ? '⌘' : 'Ctrl ';
  modelPop = signal(false);
  modelQ = signal('');
  private mqEl = viewChild<ElementRef<HTMLInputElement>>('mq');
  shownModels = computed(() => {
    const words = this.modelQ().toLowerCase().split(/\s+/).filter(Boolean);
    const rows = this.models();
    return words.length ? rows.filter(m => words.every(w => (m.name + ' ' + m.id).toLowerCase().includes(w))) : rows;
  });
  modelName = computed(() => {
    const m = this.models().find(x => x.id === this.model());
    return m?.name ?? this.short(this.model() || '…');
  });
  q = signal('');
  /** Which list: the conversations, the archived ones, or the trash. */
  tab = signal<CcTab>('list');
  archived = computed(() => this.tab() === 'archived');
  trash = computed(() => this.tab() === 'trash');
  ask = signal<Ask | null>(null);
  chats = signal<CcChat[]>([]);
  openId = signal<string | null>(null);
  chat = signal<CcChat | null>(null);
  messages = computed(() => this.chat()?.messages ?? []);
  provider = signal('commandcode');
  model = signal('');
  models = signal<LlmModel[]>([]);
  hasModel = computed(() => this.models().some(m => m.id === this.model()));
  text = signal('');
  focused = signal(false);
  error = signal<string | null>(null);
  live = signal<{ text: string; thinking: string } | null>(null);
  liveModel = signal('');
  /** The line being edited (its id), while the composer holds its text. */
  editing = signal<string | null>(null);
  /** A line's delete button asks once more before it deletes. */
  armed = signal<string | null>(null);
  menu = signal(false);
  drawer = signal(false);
  selecting = signal(false);
  selected = signal<Set<string>>(new Set());
  toast = signal<Toast | null>(null);
  /** Conversations deleted on the page, not yet on the server: "Undo" may bring them back. */
  pending = signal<Set<string>>(new Set());
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private armTimer: ReturnType<typeof setTimeout> | null = null;
  private abort: AbortController | null = null;
  private timer = setInterval(() => this.poll(), 4000);
  private loadedProvider = '';
  private htmlCache = new Map<string, string>();
  private observer: MutationObserver | null = null;
  private editDraft = '';

  me = computed(() => this.auth.state()?.user?.id ?? 'local');

  shownChats = computed(() => {
    const q = this.q().trim().toLowerCase();
    const gone = this.pending();
    const rows = this.chats().filter(c => !gone.has(c.id)
      && (this.trash() ? !!c.deleted_at : !c.deleted_at && !!c.archived === this.archived()));
    return q ? rows.filter(c => c.title.toLowerCase().includes(q) || (c.last?.text ?? '').toLowerCase().includes(q)) : rows;
  });

  /** Pinned, then Today, Yesterday, the previous seven days, older. */
  groups = computed<Group[]>(() => {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const today = start.getTime(), yesterday = today - 86_400_000, week = today - 7 * 86_400_000;
    const g: Record<string, CcChat[]> = { Pinned: [], Today: [], Yesterday: [], 'Previous 7 days': [], Older: [] };
    for (const c of this.shownChats()) {
      const at = Date.parse(c.deleted_at || c.updated_at);   // the trash: by when it was deleted
      const k = c.pinned && this.tab() === 'list' ? 'Pinned'
        : at >= today ? 'Today' : at >= yesterday ? 'Yesterday' : at >= week ? 'Previous 7 days' : 'Older';
      g[k].push(c);
    }
    return Object.entries(g).filter(([, v]) => v.length).map(([name, chats]) => ({ name, chats }));
  });

  allSelected = computed(() => {
    const s = this.selected(), rows = this.shownChats();
    return rows.length > 0 && rows.every(c => s.has(c.id));
  });
  someSelected = computed(() => this.selected().size > 0 && !this.allSelected());

  /** My last line, which ↑ or ✎ edits - only while nobody else spoke after it. */
  editableId = computed(() => {
    const msgs = this.messages();
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === 'user') return m.by?.id === this.me() ? m.id : null;
    }
    return null;
  });

  provName = computed(() => this.provLabel(this.provider()));

  constructor() {
    this.refresh(true);
    effect(() => {
      const p = this.provider();
      untracked(() => this.loadModels(p));
    });
    // Each code block gets a copy button, whenever new ones appear.
    effect(() => {
      const el = this.logEl()?.nativeElement;
      this.observer?.disconnect();
      if (!el) return;
      this.observer = new MutationObserver(() => this.decorate(el));
      this.observer.observe(el, { childList: true, subtree: true });
      this.decorate(el);
    });
    document.addEventListener('click', this.closeMenu);
  }

  ngOnDestroy() {
    clearInterval(this.timer);
    this.abort?.abort();
    this.observer?.disconnect();
    document.removeEventListener('click', this.closeMenu);
    this.flushDeletes(true);
  }

  private closeMenu = () => {
    if (this.menu()) this.menu.set(false);
    if (this.modelPop()) this.modelPop.set(false);
  };

  toggleModelPop() {
    this.modelPop.update(v => !v);
    this.modelQ.set('');
    if (this.modelPop()) setTimeout(() => this.mqEl()?.nativeElement.focus());
  }

  pickFirstModel() {
    const m = this.shownModels()[0];
    if (m) { this.pickModel(m.id); this.modelPop.set(false); }
  }

  refresh(openFirst = false) {
    const tab = this.tab();
    this.api.list('', tab).subscribe({
      next: rows => {
        if (this.tab() !== tab) return;                  // the tab changed meanwhile
        this.chats.set(rows);
        if (openFirst && !this.openId()) {
          const first = this.shownChats()[0];
          if (first) this.open(first.id);
        }
      },
      error: () => {},
    });
  }

  showTab(tab: CcTab) {
    if (this.tab() === tab) return;
    this.tab.set(tab);
    this.selected.set(new Set());
    this.ask.set(null);
    this.chats.set([]);
    this.refresh();
  }

  loadModels(p: string) {
    if (this.loadedProvider === p) return;
    this.loadedProvider = p;
    this.models.set([]);
    this.api.models(p).subscribe({ next: m => this.models.set(m), error: e => this.error.set(this.msg(e)) });
  }

  pick(c: CcChat, e: Event) {
    if (this.selecting()) { this.toggleSel(c.id); return; }
    if ((e.target as HTMLElement).closest('button, input')) return;
    if (c.deleted_at) return;                            // restored first, then read
    this.open(c.id);
  }

  open(id: string) {
    if (this.live()) return;
    this.openId.set(id);
    this.error.set(null);
    this.cancelEdit(false);
    this.drawer.set(false);
    this.api.get(id).subscribe({
      next: c => {
        if (this.openId() !== id) return;
        this.chat.set(c);
        this.provider.set(c.provider);
        this.model.set(c.model);
        if (c.messages?.length) this.scroll();
        if (!matchMedia('(hover: none)').matches) setTimeout(() => this.box()?.nativeElement.focus());
      },
      error: e => this.error.set(this.msg(e)),
    });
  }

  newChat(then?: (c: CcChat) => void) {
    if (this.live() || !this.auth.can('draw')) return;
    if (this.tab() !== 'list') this.showTab('list');
    this.api.create().subscribe({
      next: c => {
        this.chats.update(l => [c, ...l]);
        this.openId.set(c.id);
        this.chat.set(c);
        this.provider.set(c.provider);
        this.model.set(c.model);
        this.drawer.set(false);
        this.cancelEdit(false);
        then ? then(c) : setTimeout(() => this.box()?.nativeElement.focus());
      },
      error: e => this.error.set(this.msg(e)),
    });
  }

  starter(text: string) {
    const go = () => { this.text.set(t(text)); this.send(); };
    this.chat() ? go() : this.newChat(() => go());
  }

  /** Someone else may be talking in it: read it again when it grew. */
  poll() {
    if (this.live() || document.hidden) return;
    this.refresh();
    const c = this.chat();
    if (!c) return;
    const row = this.chats().find(x => x.id === c.id);
    if (row && row.count !== (c.messages?.length ?? 0)) {
      this.api.get(c.id).subscribe({ next: x => { if (this.openId() === x.id && !this.live()) { this.chat.set(x); this.scroll(); } }, error: () => {} });
    }
  }

  pickProvider(p: string) {
    this.provider.set(p);
    this.model.set('');
    this.api.models(p).subscribe({
      next: m => {
        this.models.set(m);
        this.loadedProvider = p;
        const first = m[0]?.id ?? '';
        this.pickModel(first);
      },
      error: e => this.error.set(this.msg(e)),
    });
  }

  pickModel(m: string) {
    this.model.set(m);
    const c = this.chat();
    if (c && m) this.api.patch(c.id, { provider: this.provider(), model: m }).subscribe({ error: () => {} });
  }

  rename(title: string) {
    const c = this.chat();
    if (!c || !title.trim() || title === c.title || title === t(c.title)) return;
    this.chat.set({ ...c, title: title.trim() });
    this.chats.update(l => l.map(x => x.id === c.id ? { ...x, title: title.trim() } : x));
    this.api.patch(c.id, { title: title.trim() }).subscribe({ next: () => this.refresh(), error: e => this.error.set(this.msg(e)) });
  }

  // ---- pin, archive ------------------------------------------------------

  private setFlags(c: CcChat, p: { pinned?: boolean; archived?: boolean }) {
    const upd = (x: CcChat) => x.id === c.id ? { ...x, ...p } : x;
    this.chats.update(l => l.map(upd));
    this.chat.update(x => x && upd(x));
    this.api.patch(c.id, p).subscribe({ next: () => this.refresh(), error: e => { this.error.set(this.msg(e)); this.refresh(); } });
  }

  togglePin(c: CcChat) { this.setFlags(c, { pinned: !c.pinned }); }

  toggleArchive(c: CcChat) {
    const archived = !c.archived;
    this.setFlags(c, { archived });
    this.showToast(t(archived ? 'Archived.' : 'Back in the list.'), () => this.setFlags({ ...c, archived }, { archived: !archived }));
  }

  // ---- selecting ---------------------------------------------------------

  toggleSelecting() {
    this.selecting.update(v => !v);
    this.selected.set(new Set());
  }

  toggleSel(id: string) {
    this.selected.update(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  selectAll(on: boolean) { this.selected.set(on ? new Set(this.shownChats().map(c => c.id)) : new Set()); }

  deleteSelected() {
    const ids = this.selected();
    const rows = this.shownChats().filter(c => ids.has(c.id));
    const mine = rows.filter(c => this.mayDelete(c));
    if (mine.length < rows.length) this.error.set(t('Some of these are someone else\'s - you may not delete them.'));
    this.deleteChats(mine);
    this.selecting.set(false);
    this.selected.set(new Set());
  }

  archiveSelected() {
    const ids = this.selected();
    const archived = !this.archived();
    for (const c of this.shownChats().filter(x => ids.has(x.id))) this.setFlags(c, { archived });
    this.selecting.set(false);
    this.selected.set(new Set());
  }

  // ---- deleting, with a moment to undo ------------------------------------

  mayDelete(c: CcChat) { return this.auth.can('draw') && (c.by?.id === this.me() || this.auth.can('delete')); }

  /** Gone from the page at once; from the server once the toast has gone. */
  deleteChats(rows: CcChat[]) {
    if (!rows.length) return;
    this.flushDeletes();
    const ids = new Set(rows.map(c => c.id));
    // The open one: on to the next in the list, or the one before it.
    const open = this.openId();
    if (open && ids.has(open)) {
      const list = this.groups().flatMap(g => g.chats);   // as the list shows them
      const at = list.findIndex(c => c.id === open);
      const next = list.slice(at + 1).find(c => !ids.has(c.id)) ?? list.slice(0, Math.max(at, 0)).reverse().find(c => !ids.has(c.id));
      if (this.live()) this.stop();
      this.chat.set(null);
      this.openId.set(null);
      if (next) setTimeout(() => this.open(next.id));
    }
    this.pending.set(ids);
    const text = rows.length === 1 ? `${t('Deleted')} “${t(rows[0].title)}”` : `${rows.length} ${t('conversations deleted')}`;
    this.showToast(text, () => {
      if (this.pendingTimer) clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
      this.pending.set(new Set());
      if (!this.openId() && open && ids.has(open)) this.open(open);
    });
    this.pendingTimer = setTimeout(() => this.flushDeletes(), UNDO_MS);
  }

  /** Send the deletes that are waiting - now, or (leaving) so they outlive the page. */
  flushDeletes(leaving = false) {
    const ids = [...this.pending()];
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    if (!ids.length) return;
    if (leaving) { this.api.removeOnLeave(ids); this.pending.set(new Set()); return; }
    if (this.toast()?.undo) this.toast.set(null);
    const done = () => {
      this.chats.update(l => l.filter(c => !ids.includes(c.id)));
      this.pending.update(s => { const n = new Set(s); ids.forEach(i => n.delete(i)); return n; });
    };
    const req = ids.length === 1 ? this.api.remove(ids[0]) : this.api.removeMany(ids);
    req.subscribe({
      next: (r: unknown) => {
        const refused = (r as { refused?: string[] })?.refused ?? [];
        if (refused.length) this.error.set(`${refused.length} ${t('not deleted - they are someone else\'s.')}`);
        done();
        this.refresh();
        // Not gone: 30 days in the trash, one click away.
        if (refused.length < ids.length) this.showToast(t('Moved to Trash.'), () => this.showTab('trash'), 4000, 'Show');
      },
      error: e => { this.error.set(this.msg(e)); this.pending.set(new Set()); this.refresh(); },
    });
  }

  // ---- the trash: restore, or delete for good ------------------------------

  /** "deletes for good in N days" - today, tomorrow, or in N days. */
  purgeText(c: CcChat) {
    const n = c.days_left ?? 30;
    return n <= 0 ? t('deletes for good today') : n === 1 ? t('deletes for good tomorrow')
      : t('deletes for good in {n} days').replace('{n}', String(n));
  }

  deletedBy(c: CcChat) {
    const who = c.deleted_by?.id === this.me() ? t('you') : (c.deleted_by?.name || t('someone'));
    return t('Deleted by {x}').replace('{x}', who);
  }

  private mineOf(rows: CcChat[]) {
    const mine = rows.filter(c => this.mayDelete(c));
    if (mine.length < rows.length) this.error.set(t('Some of these are someone else\'s - you may not delete them.'));
    return mine;
  }

  /** Out of the trash, back in the list it came from. */
  restoreChats(rows: CcChat[]) {
    rows = this.mineOf(rows);
    if (!rows.length) return;
    const ids = rows.map(c => c.id);
    this.chats.update(l => l.filter(c => !ids.includes(c.id)));
    const text = rows.length === 1 ? `${t('Restored')} “${t(rows[0].title)}”` : `${rows.length} ${t('conversations restored')}`;
    const req: Observable<unknown> = ids.length === 1 ? this.api.restore(ids[0]) : this.api.restoreMany(ids);
    req.subscribe({
      next: (r: unknown) => {
        const refused = (r as { refused?: string[] })?.refused ?? [];
        if (refused.length) this.error.set(`${refused.length} ${t('not restored - they are someone else\'s.')}`);
        this.showToast(text, () => this.showTab(rows.every(c => c.archived) ? 'archived' : 'list'), 4000, 'Show');
        this.refresh();
      },
      error: e => { this.error.set(this.msg(e)); this.refresh(); },
    });
  }

  restoreSelected() {
    const ids = this.selected();
    this.restoreChats(this.shownChats().filter(c => ids.has(c.id)));
    this.selecting.set(false);
    this.selected.set(new Set());
  }

  /** Asked first - there is no undoing this one. */
  askPurge(rows: CcChat[]) {
    rows = this.mineOf(rows);
    if (!rows.length) return;
    const text = rows.length === 1 ? t('Delete “{x}” for good? This cannot be undone.').replace('{x}', t(rows[0].title))
      : t('Delete {n} conversations for good? This cannot be undone.').replace('{n}', String(rows.length));
    this.ask.set({ text, label: t('Delete forever'), go: () => this.purge(rows) });
  }

  purgeSelected() {
    const ids = this.selected();
    this.askPurge(this.shownChats().filter(c => ids.has(c.id)));
    this.selecting.set(false);
    this.selected.set(new Set());
  }

  private purge(rows: CcChat[]) {
    const ids = rows.map(c => c.id);
    this.chats.update(l => l.filter(c => !ids.includes(c.id)));
    const req: Observable<unknown> = ids.length === 1 ? this.api.purge(ids[0]) : this.api.purgeMany(ids);
    req.subscribe({
      next: (r: unknown) => {
        const refused = (r as { refused?: string[] })?.refused ?? [];
        if (refused.length) this.error.set(`${refused.length} ${t('not deleted - they are someone else\'s.')}`);
        this.showToast(t('Deleted for good.'), undefined, 2500);
        this.refresh();
      },
      error: e => { this.error.set(this.msg(e)); this.refresh(); },
    });
  }

  askEmpty() {
    const n = this.shownChats().length;
    if (!n) return;
    const theirs = this.shownChats().filter(c => !this.mayDelete(c)).length;
    const text = t('Empty the trash? {n} conversations are deleted for good.').replace('{n}', String(n - theirs))
      + (theirs ? ' ' + t('{n} of someone else\'s stay.').replace('{n}', String(theirs)) : '');
    this.ask.set({ text, label: t('Empty trash'), go: () => this.emptyTrash() });
  }

  private emptyTrash() {
    this.api.emptyTrash().subscribe({
      next: r => {
        this.showToast(`${t('Trash emptied')} · ${r.deleted}`, undefined, 2500);
        if (r.kept) this.error.set(`${r.kept} ${t('not deleted - they are someone else\'s.')}`);
        this.refresh();
      },
      error: e => { this.error.set(this.msg(e)); this.refresh(); },
    });
  }

  private showToast(text: string, undo?: () => void, ms = UNDO_MS, label?: string) {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    const toast: Toast = { text, ms, label, undo: undo && (() => { this.toast.set(null); undo(); }) };
    this.toast.set(toast);
    this.toastTimer = setTimeout(() => { if (this.toast() === toast) this.toast.set(null); }, ms);
  }

  // ---- lines -------------------------------------------------------------

  /** One's own line, or an answer to it; anyone's with the right to delete. */
  mayDropLine(i: number) {
    if (!this.auth.can('draw')) return false;
    if (this.auth.can('delete')) return true;
    const msgs = this.messages();
    for (let j = i; j >= 0; j--) if (msgs[j].role === 'user') return msgs[j].by?.id === this.me();
    return false;
  }

  mayRegen() {
    const msgs = this.messages();
    const at = msgs.map(m => m.role).lastIndexOf('user');
    return at >= 0 && (this.auth.can('delete') || msgs[at].by?.id === this.me());
  }

  deleteLine(m: CcMessage) {
    const c = this.chat();
    if (!c) return;
    if (this.armed() !== m.id) {
      this.armed.set(m.id);
      if (this.armTimer) clearTimeout(this.armTimer);
      this.armTimer = setTimeout(() => this.armed.set(null), 3000);
      return;
    }
    this.armed.set(null);
    this.chat.update(x => x && { ...x, messages: (x.messages ?? []).filter(y => y.id !== m.id) });
    this.api.removeMessage(c.id, m.id).subscribe({
      next: x => { if (this.openId() === x.id) this.chat.set(x); this.refresh(); },
      error: e => { this.error.set(this.msg(e)); this.api.get(c.id).subscribe({ next: x => this.chat.set(x), error: () => {} }); },
    });
  }

  startEdit(m?: CcMessage) {
    const id = m?.id ?? this.editableId();
    const line = this.messages().find(x => x.id === id);
    if (!id || !line || this.live()) return;
    if (!this.editing()) this.editDraft = this.text();
    this.editing.set(id);
    this.setText(line.content);
    setTimeout(() => { const el = this.box()?.nativeElement; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } });
  }

  cancelEdit(restore = true) {
    if (!this.editing()) return;
    this.editing.set(null);
    this.setText(restore ? this.editDraft : '');
    this.editDraft = '';
  }

  private setText(s: string) {
    this.text.set(s);
    const el = this.box()?.nativeElement;
    if (el) { el.value = s; setTimeout(() => this.grow()); }
  }

  // ---- keys --------------------------------------------------------------

  key(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.send(); }
    else if (e.key === 'ArrowUp' && !this.text() && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && this.editableId()) {
      e.preventDefault(); this.startEdit();
    } else if (e.key === 'Escape' && this.editing() && !this.live()) { e.preventDefault(); e.stopPropagation(); this.cancelEdit(); }
  }

  /** Anywhere in the room: Esc stops an answer, Ctrl/⌘+Shift+O starts a conversation. */
  globalKey(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && (e.code === 'KeyO' || e.key === 'o' || e.key === 'O')) {
      e.preventDefault();
      this.newChat();
    } else if (e.key === 'Escape') {
      if (this.live()) { e.preventDefault(); this.stop(); }
      else if (this.menu() || this.modelPop()) { this.menu.set(false); this.modelPop.set(false); }
      else if (this.ask()) this.ask.set(null);
      else if (this.drawer()) this.drawer.set(false);
      else if (this.selecting()) this.toggleSelecting();
    }
  }

  grow() {
    const el = this.box()?.nativeElement;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 260) + 'px';
  }

  // ---- talking -----------------------------------------------------------

  async send() {
    const c = this.chat();
    const text = this.text().trim();
    if (!c || !text || this.live() || !this.model()) return;
    const edit = this.editing() ?? undefined;
    this.editing.set(null);
    this.editDraft = '';
    this.setText('');
    await this.run(c, (sig, on) => this.api.say(c.id, { text, provider: this.provider(), model: this.model(), edit }, sig, on),
                   () => { if (!this.text()) this.setText(text); if (edit) this.editing.set(edit); });
  }

  /** The last answer again - with the model chosen here, or with `model`. */
  async regenerate(model?: string) {
    const c = this.chat();
    if (!c || this.live()) return;
    if (model) this.model.set(model);
    if (!this.model()) return;
    await this.run(c, (sig, on) => this.api.regenerate(c.id, { provider: this.provider(), model: this.model() }, sig, on));
  }

  private async run(c: CcChat, call: (sig: AbortSignal, on: (ev: CcEvent) => void) => Promise<void>, failed?: () => void) {
    this.error.set(null);
    this.live.set({ text: '', thinking: '' });
    this.liveModel.set(this.model());
    this.abort = new AbortController();
    let started = false;
    let stopped = false;
    try {
      await call(this.abort.signal, ev => {
        if (this.openId() !== c.id) return;
        if (ev.type === 'user') {
          started = true;
          this.chat.update(x => x && { ...x, messages: [...(x.messages ?? []).slice(0, ev.keep ?? (x.messages ?? []).length),
                                                       ...(ev.message ? [ev.message] : [])] });
          this.scroll();
        } else if (ev.type === 'thinking') {
          this.live.update(l => l && { ...l, thinking: l.thinking + (ev.text ?? '') });
        } else if (ev.type === 'text') {
          this.live.update(l => l && { ...l, text: l.text + (ev.text ?? '') });
          this.scroll(true);
        } else if (ev.type === 'error') {
          this.error.set(ev.error ?? t('The model did not answer.'));
        } else if (ev.type === 'done' && ev.message) {
          this.chat.update(x => x && { ...x, messages: [...(x.messages ?? []), ev.message!] });
          this.live.set(null);
          this.scroll();
        } else if (ev.type === 'title' && ev.title) {
          this.chat.update(x => x && { ...x, title: ev.title! });
          this.chats.update(l => l.map(x => x.id === c.id ? { ...x, title: ev.title! } : x));
        }
      });
    } catch (e) {
      stopped = (e as Error).name === 'AbortError';
      if (!stopped) {
        this.error.set((e as Error).message);
        if (!started) failed?.();
      }
    } finally {
      this.live.set(null);
      this.abort = null;
      this.refresh();
      // A stopped answer is kept on the server as far as it got - a moment
      // after the stop, so it is read again a little later.
      const reread = () => this.api.get(c.id).subscribe({
        next: x => { if (this.openId() === x.id && !this.live()) { this.chat.set(x); this.scroll(); } }, error: () => {} });
      reread();
      if (stopped) setTimeout(reread, 1200);
    }
  }

  stop() { this.abort?.abort(); }

  // ---- copying out -------------------------------------------------------

  copy(s: string, what = 'Copied') {
    navigator.clipboard?.writeText(s).then(() => this.showToast(t(what), undefined, 1800), () => this.error.set(t('Could not copy.')));
  }

  /** The conversation as Markdown: who said what, and when. */
  markdown(): string {
    const c = this.chat();
    if (!c) return '';
    const head = `# ${t(c.title)}\n\n_${this.provLabel(c.provider)} · ${c.model} · ${new Date(c.created_at).toLocaleString()}_\n`;
    const lines = this.messages().map(m => {
      const who = m.role === 'user' ? (m.by?.name || t('someone')) : `${this.short(m.model || '')} (${t('model')})`;
      return `## ${who} · ${new Date(m.at).toLocaleString()}\n\n${m.content}${m.error ? `\n\n> ${m.error}` : ''}\n`;
    });
    return [head, ...lines].join('\n---\n\n');
  }

  copyChat() { this.copy(this.markdown(), 'Conversation copied'); }

  exportChat() {
    const c = this.chat();
    if (!c) return;
    const blob = new Blob([this.markdown()], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const slug = t(c.title).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || 'conversation';
    a.download = `${slug}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /** Each <pre> gets a copy button; the log's click handler does the copying. */
  private decorate(root: HTMLElement) {
    root.querySelectorAll('.tcv-cc-answer pre:not([data-cc])').forEach(pre => {
      pre.setAttribute('data-cc', '1');
      const b = document.createElement('button');
      b.className = 'tcv-cc-codecopy';
      b.type = 'button';
      b.textContent = t('Copy');
      b.title = t('Copy the code');
      pre.appendChild(b);
    });
  }

  logClick(e: MouseEvent) {
    const b = (e.target as HTMLElement).closest('.tcv-cc-codecopy');
    if (!b) return;
    const code = b.parentElement?.querySelector('code')?.textContent ?? '';
    navigator.clipboard?.writeText(code).then(() => {
      b.textContent = t('Copied');
      setTimeout(() => { b.textContent = t('Copy'); }, 1500);
    });
  }

  // ---- words -------------------------------------------------------------

  /** Escaped by toHtml, sanitised again by Angular on the way into [innerHTML]. */
  html(src: string): string {
    src = src || '';
    let out = this.htmlCache.get(src);
    if (out === undefined) {
      out = toHtml(src);
      if (this.htmlCache.size > 400) this.htmlCache.clear();
      this.htmlCache.set(src, out);
    }
    return out;
  }
  tail(s: string) { return s.length > 400 ? '…' + s.slice(-400) : s; }
  short(m: string) { return m.includes('/') ? m.split('/').pop()! : m; }
  ctx(n: number) { return n >= 1_000_000 ? `${Math.round(n / 1_000_000)}M` : `${Math.round(n / 1000)}k`; }
  /** A line's start for the list, without the Markdown marks. */
  snip(s: string) { return s.replace(/```[\w-]*/g, ' ').replace(/[#*_`>|]+/g, ' ').replace(/\s+/g, ' ').trim(); }
  initials(name?: string) {
    const w = (name || '?').trim().split(/\s+/);
    return ((w[0]?.[0] ?? '?') + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase();
  }
  stamp(iso: string) { return new Date(iso).toLocaleString(); }
  secs(ms: number) { return `${(ms / 1000).toFixed(1)} s`; }
  num(n: number | null | undefined) { return n == null ? '–' : n.toLocaleString(); }
  money(n: number | null | undefined) { return n == null ? '' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(3)}`; }
  provLabel(p: string) { return PROVIDERS.find(x => x.id === p)?.name ?? p; }

  when(iso: string) {
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 60) return t('just now');
    if (s < 3600) return `${Math.floor(s / 60)} ${t('min ago')}`;
    if (s < 86400) return `${Math.floor(s / 3600)} ${t('h ago')}`;
    return new Date(iso).toLocaleDateString();
  }

  private scroll(onlyIfNear = false) {
    setTimeout(() => {
      const el = this.logEl()?.nativeElement;
      if (!el) return;
      if (onlyIfNear && el.scrollHeight - el.scrollTop - el.clientHeight > 160) return;
      el.scrollTop = el.scrollHeight;
    });
  }

  private msg(e: unknown): string {
    const err = e as { error?: { detail?: unknown }; message?: string };
    return typeof err?.error?.detail === 'string' ? err.error.detail : (err?.message ?? t('Something went wrong.'));
  }
}

