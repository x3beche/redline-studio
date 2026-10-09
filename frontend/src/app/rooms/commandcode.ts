import {
  Component, ElementRef, Injectable, OnDestroy, computed, effect, inject, signal, untracked, viewChild,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { NgTemplateOutlet } from '@angular/common';
import { Segment, TaskBlock, plain, splitTasks, toHtml } from '../markdown';
import { TaskBlockView, TaskState } from './task-block';
import { Auth } from '../auth';
import { T, t } from '../i18n';
import { CcWant, Selection } from '../selection';
import { AgentThreads, RoomThread } from './agent-thread';
import { CcUsageLine } from '../cc-usage';
import { AvatarColours, avatarColour } from '../avatar';
import { AttachChips, ChatAttach, MentionPics, PAPERCLIP, isPicture } from './chat-attach';
import { FilesApi } from './files-model';
import { ComposerSuggest, SuggestChip } from './suggest';
import { ModelPicker } from '../model-picker';

/** The Chat room (id 'commandcode', kept so old links and saved tab orders
 *  still work): people talking with a model, in the open - and, pinned at
 *  the top of its list, each room's thread with its agent (agent-thread.ts).
 *
 *  A conversation is the workspace's: anyone here reads it and adds to it,
 *  and each line says who wrote it. The answer streams in as it is written
 *  and is kept when it is done (backend/cc_chat.py). Each conversation
 *  keeps its own model; a new one starts with the model chosen for the
 *  Chat room in Preferences > LLM settings.
 *
 *  The list: pinned on top, then by day; archived ones behind a filter;
 *  a delete waits a few seconds for "Undo" before it is sent, alone or a
 *  selection at once - and then goes to the Trash, where it can be
 *  restored for 30 days (or deleted for good) before the server drops it. A line: copied, deleted, the last one of one's own
 *  edited and sent again, the last answer written again (with another
 *  model if wished); every code block has its own copy button.
 *
 *  `@` in the composer mentions a model, a board, a file, a note, a drawn
 *  note or a part: the server reads it (as the person may see it) and the
 *  model gets it as context; the line shows it as a chip that opens it.
 *  Whoever has a conversation open sees an answer being written in it,
 *  whoever asked (GET /api/cc/chats/{id}/live). The search box searches
 *  every line on the server, and a hit opens the conversation at it.
 */
/** Something of the workspace mentioned in a line: what the chip shows. */
export interface CcMention {
  kind: 'model' | 'board' | 'file' | 'note' | 'revision' | 'part'; id: string; label: string;
  version?: string | number | null; sub?: string; chars?: number; truncated?: boolean; images?: number;
  /** A file that is a picture (backend/cc_context.py): drawn as one under the line. */
  image?: boolean;
  open?: { model?: string | null; board?: string | null; room?: string | null };
}
/** A tool the model used while it answered (backend/chat_tools): kept on
 *  the answer. `say` is an English sentence with {name} holes, filled from
 *  `vars` once translated (i18n.ts); `pos` is where it goes in the text. */
export interface CcStep {
  id: string; tool: string; level: ToolLevel; pos: number; say: string;
  status: 'running' | 'done' | 'error' | 'ask' | 'denied' | 'stopped' | 'interrupted';
  args?: Record<string, unknown>; vars?: Record<string, string | number>; summary?: string; error?: string; ms?: number;
}
export type ToolLevel = 'read' | 'change' | 'delete';
/** A chat tool, and whether it is on for me (GET /api/cc/tools). */
export interface CcTool { name: string; label: string; level: ToolLevel; description: string; default: boolean; on: boolean }
/** An answer's text with its steps where they happened. */
type Chunk = { text: string; steps?: undefined } | { text?: undefined; steps: CcStep[] };
/** An answer someone else is having written, as far as it got. */
export interface CcWatch {
  gen: string; client?: string | null; by: { id?: string; name?: string }; model: string; provider: string;
  message?: CcMessage | null; keep?: number; text: string; thinking: string; steps?: CcStep[];
  /** When it was asked for and when its first token came, and the server's clock (backend/ccgen.py state). */
  started_at?: string | null; first_at?: string | null; now?: string;
  /** The same two on this page's clock (Date.now()), for its speed. */
  t0?: number | null; t1?: number | null;
  /** Time to the first token, from the server's two times (no clock of this page in it). */
  ttft?: number | null;
  /** The speed as last worked out - when a piece came (rooms/commandcode.ts `speed`). */
  sp?: Speed | null;
}
/** How an answer came (backend/ccgen.py timing): kept with it. */
export type Speed = { text: string; tip: string };
export interface CcTiming {
  started_at?: string | null; first_at?: string | null; finished_at?: string;
  ttft_ms?: number; total_ms?: number; out_tokens?: number; estimated?: boolean; tps?: number;
}
/** A line the server's search found. */
export interface CcHit {
  chat_id: string; title: string; archived: boolean; pinned: boolean; trashed: boolean;
  message_id: string | null; role: string | null; at: string | null; by: string | null;
  snippet: string; hits: [number, number][];
}
export interface CcMessage {
  id: string; role: 'user' | 'assistant'; content: string; at: string; edited_at?: string;
  mentions?: CcMention[]; context_chars?: number;
  by?: { id?: string; name?: string; type?: string; picture?: string };
  provider?: string; model?: string; ms?: number; thinking_ms?: number; error?: string; stopped?: boolean;
  /** The model's reasoning, whole (backend/ccgen.py keeps all of it). */
  thinking?: string;
  /** The tools it used, in order (backend/chat_tools). */
  steps?: CcStep[];
  /** The model took no tools: it answered without them (why). */
  no_tools?: string;
  /** Its runner died with the server: kept as far as it got. */
  interrupted?: boolean;
  /** Which ```task blocks went to the queue, by index (backend/tasks.py). */
  tasks?: Record<string, TaskState>;
  usage?: { prompt_tokens?: number | null; completion_tokens?: number | null; cost?: number | null };
  timing?: CcTiming;
}
export interface CcChat {
  id: string; title: string; provider: string; model: string; by: { name?: string; id?: string };
  created_at: string; updated_at: string; count: number; pinned?: boolean; archived?: boolean;
  messages?: CcMessage[]; last?: { role: string; text: string; by?: string };
  /** The answer being written in it, if any (one at a time). */
  gen?: string | null;
  queue?: CcQueued[]; queue_paused?: boolean;
  /** In the trash: when, by whom, and when the server drops it for good. */
  deleted_at?: string; deleted_by?: { id?: string; name?: string }; purge_at?: string; days_left?: number;
}
export type CcTab = 'list' | 'archived' | 'trash';
/** A line sent while an answer was being written: it waits on the server
 *  and goes when the answer ends (backend/cc_chat.py, the queue). */
export interface CcQueued {
  id: string; content: string; mentions?: CcMention[]; by?: { id?: string; name?: string };
  at: string; provider?: string; model?: string;
}
/** This page's own answer being written in one conversation. */
interface Run { text: string; thinking: string; steps?: CcStep[]; t0: number; t1: number | null; sp?: Speed | null; model: string; gen: string | null }

export interface CcQueueState { type?: string; queue: CcQueued[]; paused: boolean; why?: string | null }
type Many = { deleted: string[]; refused: string[]; missing: string[] };
export interface LlmModel { id: string; name: string; context: number | null; anthropic: boolean;
  /** The cheap model a picker may land on by itself (backend/llm.py CHEAP). */
  cheap?: boolean;
  /** Reads images: a mentioned picture goes as a picture, not in words. */
  vision?: boolean }
export interface CcEvent {
  type: string; text?: string; error?: string; message?: CcMessage | null; keep?: number; title?: string;
  gen?: string; live?: CcWatch[]; thinking?: string; steps?: CcStep[];
  /** {type: queue}: the queue as it stands; in the hello, the same nested. */
  queue?: CcQueued[] | CcQueueState; paused?: boolean; why?: string | null; queued?: CcQueued;
}
type MentionRef = { kind: string; id: string };

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
  /** What `@` offers: this workspace's models, boards, files, notes, drawn notes and parts. */
  mentions(q: string, kind = '', limit = 30) {
    return this.http.get<CcMention[]>(`/api/cc/mentions?q=${encodeURIComponent(q)}&limit=${limit}` + (kind ? `&kind=${kind}` : ''));
  }
  /** Every line of every conversation, through the server's text index. */
  search(q: string, tab: CcTab, withArchived: boolean) {
    const archived = tab === 'archived' ? '1' : withArchived ? 'all' : '0';
    return this.http.get<{ q: string; how: string; results: CcHit[] }>(
      `/api/cc/search?q=${encodeURIComponent(q)}&archived=${archived}` + (tab === 'trash' ? '&trash=1' : ''));
  }

  /** The answers being written in a conversation, by anyone, as they are written. */
  live(id: string, signal: AbortSignal, on: (ev: CcEvent) => void, beat?: () => void) {
    return this.sse(`/api/cc/chats/${id}/live`, null, signal, on, beat);
  }

  /** Send a line (or, with `edit`, replace one's own and drop what followed);
   *  the answer comes back piece by piece through `on`. */
  say(id: string, body: { text: string; provider: string; model: string; edit?: string; mentions?: MentionRef[]; client?: string },
      signal: AbortSignal,
      on: (ev: CcEvent) => void) {
    return this.sse(`/api/cc/chats/${id}/messages`, body, signal, on);
  }

  /** A line while an answer is being written: it waits on the server (202),
   *  or - the answer having just ended - is answered at once, which the live
   *  stream then shows. */
  async queueSay(id: string, body: { text: string; provider: string; model: string; mentions?: MentionRef[]; client?: string }) {
    const r = await fetch(`/api/cc/chats/${id}/messages`, { method: 'POST', credentials: 'same-origin', headers: HEADERS,
                                                            body: JSON.stringify(body) });
    if (!r.ok) {
      let detail = `HTTP ${r.status}`;
      try { detail = (await r.json()).detail ?? detail; } catch { /* not json */ }
      throw new Error(typeof detail === 'string' ? detail : `HTTP ${r.status}`);
    }
    if ((r.headers.get('content-type') || '').includes('json')) return await r.json() as CcQueueState & { queued: CcQueued };
    void r.body?.cancel();                                // answered at once: the live stream has it
    return null;
  }
  queueEdit(id: string, qid: string, text: string) { return this.http.patch<CcQueueState>(`/api/cc/chats/${id}/queue/${qid}`, { text }); }
  queueRemove(id: string, qid: string) { return this.http.delete<CcQueueState>(`/api/cc/chats/${id}/queue/${qid}`); }
  queueResume(id: string) { return this.http.post<CcQueueState & { sent: boolean }>(`/api/cc/chats/${id}/queue/resume`, {}); }
  queueClear(id: string) { return this.http.post<CcQueueState>(`/api/cc/chats/${id}/queue/clear`, {}); }

  /** Stop the answer being written in it - kept as far as it got. Closing
   *  the page does not stop it: the server writes it to the end. */
  stop(id: string) { return this.http.post<{ stopped: boolean; gen?: string }>(`/api/cc/chats/${id}/stop`, {}); }
  /** The chat tools and my own on/off for each (kept on the server, per account). */
  tools() { return this.http.get<{ tools: CcTool[] }>('/api/cc/tools'); }
  setTools(change: Record<string, boolean>) {
    return this.http.put<{ tools: CcTool[] }>('/api/cc/tools', { tools: change }, { headers: HEADERS });
  }
  /** Yes or no to a tool that asks first (a delete-level one). */
  answerStep(id: string, step: string, allow: boolean) {
    return this.http.post<{ ok: boolean }>(`/api/cc/chats/${id}/steps/${step}`, { allow }, { headers: HEADERS });
  }

  /** The last answer written again, with this model. */
  regenerate(id: string, body: { provider: string; model: string; client?: string }, signal: AbortSignal,
             on: (ev: CcEvent) => void) {
    return this.sse(`/api/cc/chats/${id}/regenerate`, body, signal, on);
  }

  /** `beat`: anything at all arrived, a keep-alive too - how a live stream knows it is not dead. */
  private async sse(url: string, body: object | null, signal: AbortSignal, on: (ev: CcEvent) => void, beat?: () => void) {
    const r = await fetch(url, body === null ? { credentials: 'same-origin', signal, headers: { Accept: 'text/event-stream' } } : {
      method: 'POST', credentials: 'same-origin', signal, headers: HEADERS, body: JSON.stringify(body),
    });
    if (!r.ok || !r.body) {
      let detail = `HTTP ${r.status}`;
      try { detail = (await r.json()).detail ?? detail; } catch { /* not json */ }
      throw Object.assign(new Error(typeof detail === 'string' ? detail : `HTTP ${r.status}`), { status: r.status });
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      beat?.();
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
  fw: 'M6 6h12v12H6z M3 9h3 M3 15h3 M18 9h3 M18 15h3 M10.5 9.5L8.5 12l2 2.5 M13.5 9.5l2 2.5-2 2.5',
  pcb: 'M7 7h10v10H7z M10 3v4 M14 3v4 M10 17v4 M14 17v4 M3 10h4 M3 14h4 M17 10h4 M17 14h4',
  chip: 'M5 8h14v8H5z M8 8V5 M12 8V5 M16 8V5 M8 16v3 M12 16v3 M16 16v3 M8.5 12h1',
  cad: 'M12 3l8 4.5v9L12 21l-8-4.5v-9z M4 7.5l8 4.5 8-4.5 M12 12v9',
  at: 'M15.5 12a3.5 3.5 0 1 1-7 0a3.5 3.5 0 1 1 7 0z M15.5 12v1.3a2.6 2.6 0 0 0 5.2 0V12a8.7 8.7 0 1 0-3.4 6.9',
  file: 'M6 3h8l4 4v14H6z M14 3v4h4',
  note: 'M5 4h14v16H5z M8.5 9h7 M8.5 13h7 M8.5 17h4',
  drawer: 'M4 5h16v6H4z M4 11h16v8H4z M10 8h4 M10 15h4',
  sheet: 'M6 3h8l4 4v14H6z M14 3v4h4 M9 12h6 M9 15.5h6 M9 9h2',
  tool: 'M14.5 4.5a4 4 0 0 0-5 5L4 15l2 2 2 2 5.5-5.5a4 4 0 0 0 5-5l-2.5 2.5-2.5-.5-.5-2.5z',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  alert: 'M12 4l9 16H3z M12 10v4.5 M12 17.5h.01',
};

/** A tool's icon on its step (backend/chat_tools): by what it touches. */
const TOOL_ICON: Record<string, string> = {
  drawer_search: I.drawer, drawer_add: I.drawer, lcsc_search: I.search, datasheet_get: I.sheet, datasheet_read: I.sheet,
};
const LEVELS: { id: ToolLevel; name: string; about: string }[] = [
  { id: 'read', name: 'Only reads', about: 'run freely' },
  { id: 'change', name: 'Changes', about: 'run, and always show a step' },
  { id: 'delete', name: 'Deletes', about: 'ask you first' },
];

/** A mention's kind, as its icon and its name. */
const KIND: Record<CcMention['kind'], { icon: string; name: string }> = {
  model: { icon: I.cad, name: '3D model' }, board: { icon: I.pcb, name: 'Board' }, file: { icon: I.file, name: 'File' },
  note: { icon: I.note, name: 'Note' }, revision: { icon: I.edit, name: 'Drawn note' }, part: { icon: I.chip, name: 'Part' },
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
  imports: [T, NgTemplateOutlet, RoomThread, CcUsageLine, TaskBlockView, AttachChips, MentionPics, SuggestChip, ModelPicker],
  host: { '(window:keydown)': 'globalKey($event)', '(window:pagehide)': 'flushDeletes(true)' },
  template: `
<!-- Avatars: a person's picture, or their initials on a colour of their own
     (the one they chose on their Profile, or a series colour picked by name -
     avatar.ts); a model's or an agent's mark, all in one grey (styles.css). -->
<ng-template #userAv let-by let-hide="hide">
  <div class="tcv-cc-av" data-role="user" [attr.data-hide]="hide ? 1 : null" [attr.data-me]="by?.id === me() ? 1 : null"
       [style.background]="avTint(by?.name || by?.id, 28, '--surface', by?.id)" [style.border-color]="avTint(by?.name || by?.id, 100, '--line', by?.id)"
       aria-hidden="true">
    {{ initials(by?.name) }}
    @if (picOf(by); as src) { <img [src]="src" alt="" (error)="noPic(by)"> }
  </div>
</ng-template>
<ng-template #botAv let-model let-hide="hide">
  <div class="tcv-cc-av" data-role="assistant" [attr.data-hide]="hide ? 1 : null" [attr.data-family]="family(model)"
       [title]="model || ''" aria-hidden="true">
    @switch (family(model)) {
      @case ('claude') { <svg class="tcv-cc-mark" viewBox="0 0 24 24"><path d="M12 3.5v17 M3.5 12h17 M6 6l12 12 M18 6L6 18" /></svg> }
      @case ('gemini') { <svg class="tcv-cc-mark" viewBox="0 0 24 24"><path class="fill" d="M12 2.5c.7 5 4.5 8.8 9.5 9.5-5 .7-8.8 4.5-9.5 9.5-.7-5-4.5-8.8-9.5-9.5 5-.7 8.8-4.5 9.5-9.5z" /></svg> }
      @case ('redline') {
        <svg class="tcv-cc-mark" viewBox="0 0 64 64"><path d="M32 9.6 L54.4 22 V42 L32 54.4 L9.6 42 V22 Z" />
          <path class="red" d="M16.5 42.5 C25 35 33 33 47.5 23.5" /></svg>
      }
      @default { <span class="tcv-cc-mono">{{ monogram(model) }}</span> }
    }
  </div>
</ng-template>
<ng-template #ico let-d><svg class="tcv-cc-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="d" /></svg></ng-template>

<div class="tcv-room tcv-cc-room absolute inset-0 flex min-h-0 gap-1 p-1" [attr.data-drawer]="drawer() ? 1 : null">
  <!-- LEFT: the conversations -->
  <aside class="tcv-notes-side tcv-cc-side">
    <div class="tcv-cc-sidehead">
      <div class="tcv-cc-siderow">
        <label class="tcv-cc-search">
          <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.search }" />
          <input type="search" [placeholder]="'Search' | t" [value]="q()" [attr.aria-label]="'Search conversations' | t"
                 (input)="setQuery($any($event.target).value)" (keydown.escape)="setQuery('')">
        </label>
        @if (auth.can('draw')) {
          <button class="tcv-cc-newsm" data-act="new" (click)="newChat()" [title]="('New conversation' | t) + ' (' + mod + 'Shift+O)'">
            <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.plus }" />
            <span>{{ 'New' | t }}</span>
          </button>
        }
      </div>
      <div class="tcv-cc-tabrow">
        <div class="tcv-cc-tabs" role="tablist">
          <button role="tab" [class.on]="tab() === 'list'" [attr.aria-selected]="tab() === 'list'" (click)="showTab('list')">{{ 'Conversations' | t }}</button>
          <button role="tab" [class.on]="tab() === 'archived'" [attr.aria-selected]="tab() === 'archived'" (click)="showTab('archived')">{{ 'Archived' | t }}</button>
          <button role="tab" data-tab="trash" [class.on]="tab() === 'trash'" [attr.aria-selected]="tab() === 'trash'" (click)="showTab('trash')">{{ 'Trash' | t }}</button>
        </div>
        <span class="grow"></span>
        @if (trash() && auth.can('draw') && shownChats().length && !selecting()) {
          <button class="tcv-cc-ib tcv-cc-sm tcv-cc-danger" data-act="empty" (click)="askEmpty()" [title]="'Empty trash' | t">
            <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.trash }" /></button>
        }
        @if (auth.can('draw') && shownChats().length) {
          <button class="tcv-cc-ib tcv-cc-sm" data-act="select" [class.on]="selecting()" (click)="toggleSelecting()" [title]="'Select several' | t">
            <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.select }" /></button>
        }
      </div>
      @if (q().trim() && tab() === 'list') {
        <label class="tcv-cc-check tcv-cc-witharch">
          <input type="checkbox" [checked]="withArchived()" (change)="withArchived.set($any($event.target).checked); runSearch()">
          {{ 'Include archived' | t }}</label>
      }
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
      <!-- The rooms' agent threads: always here, always first, in the top
           bar's order; not renamed, archived or deleted. A search narrows
           them by name only. -->
      @if (shownRooms().length) {
        <div class="tcv-cc-group">{{ 'Rooms' | t }}</div>
        @for (r of shownRooms(); track r.room) {
          <div class="tcv-cc-item tcv-th-item" role="listitem" tabindex="0" [attr.data-room]="r.room"
               [attr.data-on]="sel.thread() === r.room ? 1 : null" (click)="openThread(r.room)" (keydown.enter)="openThread(r.room)"
               [title]="(threads.label(r.room) | t) + ' - ' + ('agent thread' | t)">
            <span class="tcv-th-ico"><ng-container *ngTemplateOutlet="ico; context: { $implicit: r.room === 'pcb' ? I.pcb : r.room === 'firmware' ? I.fw : I.cad }" /></span>
            <div class="tcv-cc-itemtext">
              <div class="tcv-cc-itemtop">
                <span class="tcv-cc-itemtitle">{{ threads.label(r.room) | t }}</span>
                @if (threads.unread(r.room); as n) { <span class="tcv-th-badge" [title]="'unread' | t">{{ n }}</span> }
                @else if (r.last) { <span class="tcv-cc-itemwhen">{{ when(r.last.at) }}</span> }
              </div>
              <div class="tcv-cc-itemsnip">{{ r.last ? (r.last.role === 'agent' ? ('agent' | t) : (r.last.by || ('you' | t))) + ': ' + snip(r.last.text)
                                                      : ('No messages yet' | t) }}</div>
            </div>
          </div>
        }
      }
      @if (trash() && shownChats().length) {
        <p class="tcv-cc-trashnote">{{ 'Deleted conversations are kept here for 30 days, then deleted for good.' | t }}</p>
      }
      @if (hits(); as hs) {
        <div class="tcv-cc-group">{{ 'Found in messages' | t }} · {{ hs.length }}</div>
        @for (h of hs; track $index) {
          <button class="tcv-cc-hit" [attr.data-on]="!sel.thread() && h.chat_id === openId() ? 1 : null" (click)="openHit(h)">
            <span class="tcv-cc-itemtop">
              <span class="tcv-cc-itemtitle">{{ h.title | t }}</span>
              @if (h.archived) { <span class="tcv-cc-tag">{{ 'Archived' | t }}</span> }
              @if (h.at) { <time class="tcv-cc-itemwhen" [title]="stamp(h.at)">{{ when(h.at) }}</time> }
            </span>
            <span class="tcv-cc-hitsnip">@if (h.by) {<b>{{ h.by }}: </b>}@for (seg of segments(h); track $index) {@if (seg.hit) {<mark>{{ seg.t }}</mark>} @else {<span>{{ seg.t }}</span>}}</span>
          </button>
        } @empty {
          <p class="tcv-cc-listempty">{{ searching() ? ('Searching…' | t) : ('Nothing found.' | t) }}</p>
        }
      } @else {
      @for (g of groups(); track g.name) {
        <div class="tcv-cc-group">{{ g.name | t }}</div>
        @for (c of g.chats; track c.id) {
          <div class="tcv-cc-item" role="listitem" tabindex="0" [attr.data-on]="!sel.thread() && c.id === openId() ? 1 : null"
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
                @if (!c.deleted_at && running(c)) {
                  <span class="tcv-cc-itemrun tcv-cc-pulse" data-running="1" [title]="'An answer is being written' | t" aria-hidden="true"></span>
                }
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
      }
    </div>
    <!-- The Command Code account's usage windows, pinned under the list (cc-usage.ts): opens LLM settings. -->
    <app-cc-usage-line />
    <!-- The tools the model may use with my lines: my own choice, kept on the server. -->
    <div class="tcv-cc-toolswrap" (keydown.escape)="toolsOpen.set(false)">
      @if (toolsOpen()) {
        <div class="tcv-cc-toolspop" role="dialog" [attr.aria-label]="'Tools' | t">
          <div class="tcv-cc-toolshead"><b>{{ 'Tools the model may use' | t }}</b>
            <button class="tcv-cc-ib" (click)="toolsOpen.set(false)" [title]="'Close' | t">
              <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.x }" /></button></div>
          @for (g of toolGroups(); track g.id) {
            <div class="tcv-cc-toolsgroup"><span>{{ g.name | t }}</span><em>{{ g.about | t }}</em></div>
            @for (tl of g.tools; track tl.name) {
              <label class="tcv-cc-toolrow">
                <button type="button" class="tcv-switch" [attr.data-on]="tl.on ? 1 : null" [attr.aria-pressed]="tl.on"
                        [disabled]="!auth.can('draw')" (click)="toggleTool(tl)" [attr.aria-label]="tl.label | t"></button>
                <span><b>{{ tl.label | t }}</b><small>{{ tl.description | t }}</small></span>
              </label>
            } @empty { <div class="tcv-cc-toolnone">{{ 'none yet' | t }}</div> }
          }
          <div class="tcv-cc-toolsfoot">{{ 'Your own choice, on every device. A model that cannot use tools answers without them.' | t }}</div>
        </div>
      }
      <button class="tcv-cc-toolsbtn" type="button" (click)="toolsOpen.set(!toolsOpen())" [attr.aria-expanded]="toolsOpen()"
              [title]="'Which tools the model may use with your lines' | t">
        <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.tool }" />
        <b>{{ 'Tools' | t }}</b><span>{{ toolsOn() }}/{{ tools().length }}</span>
        <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.chevron }" />
      </button>
    </div>
  </aside>
  <div class="tcv-cc-scrim" (click)="drawer.set(false)"></div>

  <!-- RIGHT: one conversation -->
  <section class="tcv-cc-main">
    @if (sel.thread(); as room) {
      <app-room-thread [room]="room" [userAv]="userAv" [botAv]="botAv" [ico]="ico" (menu)="drawer.set(!drawer())" />
    } @else if (chat(); as c) {
      <header class="tcv-cc-bar">
        <button class="tcv-cc-ib tcv-cc-burger" (click)="drawer.set(!drawer())" [title]="'Conversations' | t">
          <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.menu }" /></button>
        <input class="tcv-cc-title" [value]="c.title | t" (change)="rename($any($event.target).value)"
               (keydown.enter)="$any($event.target).blur()" [readonly]="!auth.can('draw')" [title]="'Rename' | t">
        @if (totals(); as tt) {
          <span class="tcv-cc-totals" [title]="tt.title">{{ tt.text }}</span>
        }
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

      <div class="tcv-cc-log tcv-cc-scroll" #log (click)="logClick($event)" (scroll)="logScrolled()"
           [class.tcv-att-over]="att.over()" (dragover)="auth.can('draw') && att.dragOver($event)"
           (dragleave)="att.dragLeave($event)" (drop)="auth.can('draw') && att.drop($event)">
        <div class="tcv-cc-col">
          @for (m of messages(); track m.id; let i = $index; let last = $last) {
            <article class="tcv-cc-row" [attr.data-role]="m.role" [attr.data-editing]="editing() === m.id ? 1 : null"
                     [attr.data-mid]="m.id" [attr.data-flash]="flash() === m.id ? 1 : null"
                     [attr.data-open]="detail() === m.id ? 1 : null" (click)="rowTap(m, $event)">
              @if (m.role === 'user') {
                <ng-container *ngTemplateOutlet="userAv; context: { $implicit: m.by, hide: sameAsBefore(i) }" />
              } @else {
                <ng-container *ngTemplateOutlet="botAv; context: { $implicit: m.model, hide: sameAsBefore(i) }" />
              }
              <div class="tcv-cc-rowmain">
                <div class="tcv-cc-rowhead">
                  @if (m.role === 'user') {
                    <b>{{ m.by?.name || ('someone' | t) }}</b>
                    @if (m.edited_at) { <span>· {{ 'edited' | t }}</span> }
                    <span class="tcv-cc-hovtime">{{ fullStamp(m.at) }}{{ m.edited_at ? ' · ' + ('edited' | t) + ' ' + fullStamp(m.edited_at) : '' }}{{
                      m.mentions?.length ? ' · ' + m.mentions!.length + ' ' + ((m.mentions!.length === 1 ? 'attachment' : 'attachments') | t) : '' }}</span>
                  } @else { <b [title]="m.model || ''">{{ short(m.model || '') }}</b> }
                </div>
                @if (m.role === 'assistant') {
                  @if (m.thinking) {
                    <ng-container *ngTemplateOutlet="think; context: { $implicit: m.thinking, key: m.id, streaming: false, ms: m.thinking_ms }" />
                  }
                  <!-- A task written for the queue is a box with its own button
                       (rooms/task-block.ts); the rest is the answer as written,
                       with the tools it used where it used them. -->
                  @for (ch of chunks(m.content, m.steps); track $index) {
                    @if (ch.steps) {
                      <ng-container *ngTemplateOutlet="stepsT; context: { $implicit: ch.steps, cid: c.id }" />
                    } @else {
                    @for (seg of parts(ch.text); track $index) {
                      @if (taskOf(seg); as tk) {
                        <rl-task-block [block]="tk" [state]="m.tasks?.[tk.index]"
                                       [url]="'/api/cc/chats/' + c.id + '/messages/' + m.id + '/task/' + tk.index + '/queue'"
                                       (queued)="taskQueued(m.id, tk.index, $event)" />
                      } @else {
                        <div class="tcv-cc-answer md" [innerHTML]="html(mdOf(seg))"></div>
                      }
                    }
                    }
                  }
                } @else {
                  <div class="tcv-cc-bubble">{{ m.content }}</div>
                }
                @if (m.mentions?.length) {
                  <!-- Pictures as pictures (a click opens the full one); the rest as chips. -->
                  <rl-mention-pics [mentions]="m.mentions" />
                  <div class="tcv-cc-mentions">
                    @for (mm of chipsOf(m.mentions); track mm.kind + mm.id) {
                      <button class="tcv-cc-mchip" [attr.data-kind]="mm.kind" (click)="openMention(mm)" [title]="mentionTip(mm)">
                        <ng-container *ngTemplateOutlet="ico; context: { $implicit: kindIcon(mm.kind) }" />
                        <span>{{ mm.label }}</span>
                        @if (mm.truncated) { <span class="tcv-cc-mcut">{{ 'cut' | t }}</span> }
                      </button>
                    }
                  </div>
                }
                @if (m.error) { <div class="tcv-cc-errline">{{ m.error }}</div> }
                <div class="tcv-cc-foot">
                @if (m.role === 'assistant') {
                  <div class="tcv-cc-statwrap">
                    <button class="tcv-cc-stats" data-act="details" (click)="toggleDetail(m.id); $event.stopPropagation()"
                            [attr.aria-expanded]="detail() === m.id" [attr.aria-label]="'Details' | t">{{ restLine(m) }}</button>
                    <div class="tcv-cc-detail" role="tooltip">
                      <dl>
                        @for (d of details(m); track d.k) { <dt>{{ d.k | t }}</dt><dd>{{ d.v }}</dd> }
                      </dl>
                    </div>
                  </div>
                }
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
              </div>
            </article>
          }
          @if (live(); as l) {
            <article class="tcv-cc-row" data-role="assistant">
              <ng-container *ngTemplateOutlet="botAv; context: { $implicit: liveModel() || model(), hide: false }" />
              <div class="tcv-cc-rowmain">
                <div class="tcv-cc-rowhead"><b>{{ short(liveModel() || model()) }}</b>
                  <span class="tcv-cc-pulse">{{ l.text ? ('writing…' | t) : ('thinking…' | t) }}</span></div>
                @if (l.thinking) {
                  <ng-container *ngTemplateOutlet="think; context: { $implicit: l.thinking, key: 'live', streaming: !l.text }" />
                }
                @for (ch of chunks(l.text, l.steps); track $index) {
                  @if (ch.steps) { <ng-container *ngTemplateOutlet="stepsT; context: { $implicit: ch.steps, cid: c.id }" /> }
                  @else if (ch.text) { <div class="tcv-cc-answer md" [innerHTML]="html(ch.text)"></div> }
                }
                <div class="tcv-cc-livefoot">
                  @if (!l.text) { <div class="tcv-cc-dots"><i></i><i></i><i></i></div> }
                  @if (l.sp; as sp) { <span class="tcv-cc-stats" data-live="1" [title]="sp.tip">{{ sp.text }}</span> }
                  <span class="tcv-cc-dim">· Esc {{ 'stops' | t }}</span>
                </div>
              </div>
            </article>
          }
          @for (w of watch(); track w.gen) {
            <article class="tcv-cc-row" data-role="assistant" data-watch="1">
              <ng-container *ngTemplateOutlet="botAv; context: { $implicit: w.model, hide: false }" />
              <div class="tcv-cc-rowmain">
                <div class="tcv-cc-rowhead"><b>{{ short(w.model) }}</b>
                  <span class="tcv-cc-pulse">{{ asking(w) }}</span>
                  <span class="tcv-cc-dim">· {{ w.text ? ('writing…' | t) : ('thinking…' | t) }}</span></div>
                @if (w.thinking) {
                  <ng-container *ngTemplateOutlet="think; context: { $implicit: w.thinking, key: w.gen, streaming: !w.text }" />
                }
                @for (ch of chunks(w.text, w.steps); track $index) {
                  @if (ch.steps) { <ng-container *ngTemplateOutlet="stepsT; context: { $implicit: ch.steps, cid: c.id }" /> }
                  @else if (ch.text) { <div class="tcv-cc-answer md" [innerHTML]="html(ch.text)"></div> }
                }
                <div class="tcv-cc-livefoot">
                  @if (!w.text) { <div class="tcv-cc-dots"><i></i><i></i><i></i></div> }
                  @if (w.sp; as sp) { <span class="tcv-cc-stats" data-live="1" [title]="sp.tip">{{ sp.text }}</span> }
                </div>
              </div>
            </article>
          }
          @if (queue().length) {
            <div class="tcv-cc-queue" role="list" [attr.aria-label]="'Queued' | t">
              <div class="tcv-cc-queuehead" [attr.data-paused]="queuePaused() ? 1 : null">
                <span>{{ (queuePaused() ? 'Paused' : 'Queued') | t }} · {{ queue().length }}</span>
                <span class="tcv-cc-dim">{{ (queuePaused() ? 'The answer did not end - nothing more is sent until you say so.'
                                                            : 'Sent one by one when the answer ends.') | t }}</span>
                @if (queuePaused() && auth.can('draw')) {
                  <span class="grow"></span>
                  <button class="tcv-cc-textbtn" data-act="queue-send" (click)="queueResume()">{{ 'Send now' | t }}</button>
                  <button class="tcv-cc-textbtn" data-act="queue-clear" (click)="queueClear()">{{ 'Clear' | t }}</button>
                }
              </div>
              @for (qm of queue(); track qm.id) {
                <article class="tcv-cc-row" data-role="user" data-queued="1" role="listitem">
                  <ng-container *ngTemplateOutlet="userAv; context: { $implicit: qm.by, hide: false }" />
                  <div class="tcv-cc-rowmain">
                    <div class="tcv-cc-rowhead"><b>{{ qm.by?.name || ('someone' | t) }}</b>
                      <span class="tcv-cc-tag">{{ (queuePaused() ? 'Paused' : 'Queued') | t }}</span>
                      @if (qm.model && qm.model !== model()) { <span class="tcv-cc-dim">{{ short(qm.model) }}</span> }</div>
                    @if (qEditing() === qm.id) {
                      <div class="tcv-cc-qedit">
                        <textarea rows="2" [value]="qDraft()" (input)="qDraft.set($any($event.target).value)"
                                  (keydown.enter)="qKey($any($event), qm)"
                                  (keydown.escape)="$event.stopPropagation(); qEditing.set(null)"></textarea>
                        <div class="tcv-cc-qeditacts">
                          <button class="tcv-cc-textbtn" (click)="qEditing.set(null)">{{ 'Cancel' | t }}</button>
                          <button class="tcv-cc-textbtn" data-act="queue-save" [disabled]="!qDraft().trim()" (click)="queueSave(qm)">{{ 'Save' | t }}</button>
                        </div>
                      </div>
                    } @else {
                      <div class="tcv-cc-bubble">{{ qm.content }}</div>
                    }
                    @if (qm.mentions?.length) {
                      <div class="tcv-cc-mentions">
                        @for (mm of qm.mentions; track mm.kind + mm.id) {
                          <span class="tcv-cc-mchip" [attr.data-kind]="mm.kind" [title]="mentionTip(mm)">
                            <ng-container *ngTemplateOutlet="ico; context: { $implicit: kindIcon(mm.kind) }" /><span>{{ mm.label }}</span></span>
                        }
                      </div>
                    }
                    @if (mayTouch(qm) && qEditing() !== qm.id) {
                      <div class="tcv-cc-tools tcv-cc-qtools" role="toolbar">
                        <button class="tcv-cc-ib" data-act="queue-edit" (click)="queueStartEdit(qm)" [title]="'Edit' | t">
                          <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.edit }" /></button>
                        <button class="tcv-cc-ib tcv-cc-danger" data-act="queue-remove" (click)="queueRemove(qm)" [title]="'Remove' | t">
                          <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.x }" /></button>
                      </div>
                    }
                  </div>
                </article>
              }
            </div>
          }
          @if (!messages().length && !live() && !watch().length && !queue().length) {
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
        <div class="tcv-cc-composer" [class.focus]="focused()" [class.editing]="editing()"
             [class.tcv-att-over]="att.over()" (dragover)="att.dragOver($event)" (dragleave)="att.dragLeave($event)"
             (drop)="att.drop($event)">
          @if (editing()) {
            <div class="tcv-cc-editbar">
              <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.edit }" />
              <span>{{ 'Editing your message - what came after it will be replaced.' | t }}</span>
              <span class="grow"></span>
              <button class="tcv-cc-textbtn" (click)="cancelEdit()">{{ 'Cancel' | t }}</button>
            </div>
          }
          @if (picked().length || att.items().length || att.error()) {
            <div class="tcv-cc-picked">
              <rl-attach-chips [att]="att" />
              @for (mm of picked(); track mm.kind + mm.id) {
                <span class="tcv-cc-mchip" [attr.data-kind]="mm.kind" [title]="mentionTip(mm)">
                  <ng-container *ngTemplateOutlet="ico; context: { $implicit: kindIcon(mm.kind) }" />
                  <span>{{ mm.label }}</span>
                  <button class="tcv-cc-mx" (click)="unpick(mm)" [title]="'Remove' | t">
                    <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.x }" /></button>
                </span>
              }
              @if (picturesAsText()) {
                <span class="tcv-cc-dim tcv-cc-mnote">{{ 'This model does not read images - pictures go as a description.' | t }}</span>
              }
            </div>
          }
          @if (mentionPop()) {
            <div class="tcv-cc-mpop" role="listbox" (mousedown)="$event.preventDefault()">
              <div class="tcv-cc-mhead">
                <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.at }" />
                <span>{{ mentionQ() || ('Mention a model, board, file, note or part' | t) }}</span>
              </div>
              <div class="tcv-cc-mlist">
                @for (r of mentionRows(); track r.kind + r.id; let k = $index) {
                  <button role="option" [class.on]="k === mentionIdx()" [attr.aria-selected]="k === mentionIdx()"
                          (mouseenter)="mentionIdx.set(k)" (click)="pickMention(r)">
                    <ng-container *ngTemplateOutlet="ico; context: { $implicit: kindIcon(r.kind) }" />
                    <span class="tcv-cc-modelname">{{ r.label }}</span>
                    <span class="tcv-cc-dim tcv-cc-msub">{{ r.sub }}</span>
                    <span class="tcv-cc-tag">{{ kindName(r.kind) | t }}</span>
                  </button>
                } @empty {
                  <p class="tcv-cc-dim tcv-cc-pad">{{ mentionBusy() ? ('Loading…' | t) : ('Nothing to mention matches.' | t) }}</p>
                }
              </div>
              <div class="tcv-cc-mfoot tcv-cc-dim"><kbd>↑↓</kbd> {{ 'choose' | t }} · <kbd>↵</kbd> {{ 'add' | t }} · <kbd>Esc</kbd> {{ 'close' | t }}</div>
            </div>
          }
          <textarea #box rows="1" [value]="text()" [class.tcv-sg-ghost]="!!sg.text()"
                    [placeholder]="sg.text() || ((busy() ? 'Write the next one - it is sent when the answer ends… (@ to mention)' : 'Write to the model… (@ to mention)') | t)"
                    (input)="typed($any($event.target)); grow()" (keydown)="key($event)" (click)="typed($any($event.target))"
                    (paste)="att.paste($event)"
                    (focus)="focused.set(true)" (blur)="focused.set(false); closeMentions()"></textarea>
          <div class="tcv-cc-compbar">
            <app-model-picker [models]="models()" [selected]="model()" [providers]="providers" [provider]="provider()"
                              [title]="('Model' | t) + ': ' + provName() + ' · ' + model()" [(open)]="modelPop"
                              (pick)="pickModel($event)" (providerPick)="pickProvider($event)" />
            <button class="tcv-cc-ib" data-act="mention" (click)="startMention()" [title]="('Mention' | t) + ' (@)'">
              <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.at }" /></button>
            <button class="tcv-cc-ib" data-act="attach" (click)="pickFile.click()"
                    [title]="'Attach a picture or a file (or paste, or drop it here)' | t">
              <ng-container *ngTemplateOutlet="ico; context: { $implicit: CLIP }" /></button>
            <input #pickFile type="file" multiple hidden (change)="att.pick($event)" />
            @if (meter(); as mt) {
              <span class="tcv-cc-meter" [attr.data-state]="mt.state" [title]="mt.title">
                <span class="tcv-cc-meterbar"><i [style.width.%]="mt.pct"></i></span>
                <span>{{ mt.text }}</span>
              </span>
            }
            <span class="tcv-cc-hint">
              <kbd>↵</kbd> {{ 'send' | t }} · <kbd>⇧↵</kbd> {{ 'new line' | t }} · <kbd>↑</kbd> {{ 'edit last' | t }}
            </span>
            <rl-suggest-chip [sg]="sg" />
            <span class="grow"></span>
            @if (busy()) {
              @if ((text().trim() || att.ready().length) && !editing()) {
                <button class="tcv-cc-queuebtn" data-act="queue" (click)="send()"
                        [title]="('Queue' | t) + ' (Enter) - ' + ('sent when the answer ends' | t)">{{ 'Queue' | t }}</button>
              }
              @if (live() || stoppable()) {
                <button class="tcv-cc-send stop" (click)="stop()" [title]="('Stop' | t) + ' (Esc)'">
                  <svg class="tcv-cc-ico" viewBox="0 0 24 24"><path class="fill" [attr.d]="I.stop" /></svg></button>
              }
            } @else {
              <button class="tcv-cc-send" [disabled]="(!text().trim() && !att.ready().length) || att.busy()" (click)="send()"
                      [title]="(att.busy() ? ('Uploading…' | t) : ((editing() ? 'Send again' : 'Send') | t)) + ' (Enter)'">
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

<!-- The model's thinking, whole: open while it thinks, folded once the
     answer begins (and opened again with a click), scrolled along with it
     unless the reader scrolled up. -->
<ng-template #think let-text let-key="key" let-streaming="streaming" let-ms="ms">
  <details class="tcv-cc-think" [open]="thinkOpen(key, streaming)" (toggle)="thinkToggled(key, streaming, $event)">
    <summary>
      <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.chevron }" />
      <span [class.tcv-cc-pulse]="streaming">{{ (streaming ? 'Thinking…' : 'Thinking') | t }}</span>
      <span class="tcv-cc-dim">{{ ms ? secs(ms) + ' · ' : '' }}{{ kfmt(text.length) }} {{ 'characters' | t }}</span>
    </summary>
    <div class="tcv-cc-thinkbody" [attr.data-live]="streaming ? 1 : null" (scroll)="thinkScrolled($event)">{{ text }}</div>
  </details>
</ng-template>

<!-- The tools the model used (backend/chat_tools): one flat row each, a
     plain sentence; a click opens what went in and what came back. -->
<ng-template #stepsT let-steps let-cid="cid">
  <div class="tcv-cc-steps">
    @for (s of steps; track s.id) {
      <details class="tcv-cc-step" [attr.data-status]="s.status" [attr.data-level]="s.level">
        <summary>
          @if (s.status === 'running') { <span class="tcv-cc-spin" aria-hidden="true"></span> }
          @else if (s.status === 'error' || s.status === 'denied') { <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.alert }" /> }
          @else { <ng-container *ngTemplateOutlet="ico; context: { $implicit: toolIcon(s.tool) }" /> }
          <span class="tcv-cc-steptext">{{ stepLine(s) }}</span>
          @if (stepNote(s); as n) { <span class="tcv-cc-stepnote">{{ n | t }}</span> }
          @if (s.ms != null && s.ms >= 500 && s.status !== 'running') { <span class="tcv-cc-dim">{{ secs(s.ms) }}</span> }
          <ng-container *ngTemplateOutlet="ico; context: { $implicit: I.chevron }" />
        </summary>
        <dl class="tcv-cc-stepbody">
          <dt>{{ 'Tool' | t }}</dt><dd class="mono">{{ s.tool }} · {{ levelName(s.level) | t }}</dd>
          <dt>{{ 'Input' | t }}</dt><dd class="mono">{{ argsLine(s) }}</dd>
          @if (s.summary) { <dt>{{ 'Result' | t }}</dt><dd><pre>{{ s.summary }}</pre></dd> }
          @if (s.error) { <dt>{{ 'Error' | t }}</dt><dd class="tcv-cc-steperr">{{ s.error }}</dd> }
        </dl>
      </details>
      @if (s.status === 'ask' && auth.can('draw')) {
        <div class="tcv-cc-stepask">
          <span>{{ 'This tool asks before it runs.' | t }}</span>
          <button class="tcv-cc-textbtn" (click)="answerStep(cid, s, true)">{{ 'Allow' | t }}</button>
          <button class="tcv-cc-textbtn" (click)="answerStep(cid, s, false)">{{ 'Deny' | t }}</button>
        </div>
      }
    }
  </div>
</ng-template>

<ng-template #hello>
  <div class="tcv-cc-hello">
    <div class="tcv-cc-hello-mark"><ng-container *ngTemplateOutlet="ico; context: { $implicit: I.chat }" /></div>
    <h2>{{ 'What are we building today?' | t }}</h2>
    <p>{{ 'Ask about a board, firmware or a model. Your conversations are private to your account.' | t }}</p>
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

  /** The composer, ready to type in, once it is on the page. Asked for as
   *  a room or conversation opens (Ctrl+K, the list), when the composer may
   *  not be drawn yet: tried again for a moment rather than once and lost. */
  focusSoon(tries = 30) {
    if (matchMedia('(hover: none)').matches) return;
    const el = this.box()?.nativeElement;
    if (el && el.offsetParent) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); return; }
    if (tries > 0) setTimeout(() => this.focusSoon(tries - 1), 50);
  }
  private logEl = viewChild<ElementRef<HTMLDivElement>>('log');

  readonly providers = PROVIDERS;
  readonly starters = STARTERS;
  readonly I = I;
  private readonly mac = /Mac|iPhone|iPad/.test(navigator.platform);
  readonly mod = this.mac ? '⌘+' : 'Ctrl+';
  readonly modShort = this.mac ? '⌘' : 'Ctrl ';
  modelPop = signal(false);
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
  /** This page's own answers being written, by conversation: so far, when
   *  each was asked (t0) and when its first token came (t1), on this page's
   *  clock, its model and generation. Several conversations may be answering
   *  at once (the server locks each one on its own); switching away from one
   *  leaves it running and its request streaming in here. */
  runs = signal<Map<string, Run>>(new Map());
  /** The open conversation's own answer being written. */
  live = computed(() => { const id = this.openId(); return id ? this.runs().get(id) ?? null : null; });
  liveModel = computed(() => this.live()?.model ?? '');
  /** An error an answer ended with while its conversation was not open: shown when it is opened. */
  private runErrors = new Map<string, string>();
  /** Thinking blocks the reader opened or folded by hand (by answer or generation). */
  private thinkHand = signal<Map<string, boolean>>(new Map());
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
  /** The requests streaming this page's own answers, by conversation. */
  private aborts = new Map<string, AbortController>();
  private timer = setInterval(() => this.poll(), 4000);
  private loadedProvider = '';
  private htmlCache = new Map<string, string>();
  private observer: MutationObserver | null = null;
  private editDraft = '';
  /** The reader scrolled up from the end of the conversation; where this page last scrolled it to. */
  private logFree = false;
  private logAuto = -9;

  me = computed(() => this.auth.state()?.user?.id ?? 'local');

  // ---- @-mentions, answers watched live, server search (round two) ----
  sel = inject(Selection);
  /** The rooms' agent threads, pinned at the top of the list. */
  threads = inject(AgentThreads);
  shownRooms = computed(() => {
    const q = this.q().trim().toLowerCase();
    return this.threads.ordered().filter(r => !q || this.threads.label(r.room).toLowerCase().includes(q)
                                                   || t(this.threads.label(r.room)).toLowerCase().includes(q));
  });
  openThread(room: string) {
    if (this.selecting()) return;
    this.drawer.set(false);
    this.sel.thread.set(room);
    this.threads.markSeen(room);
  }
  /** This page: its own answers come back on the live stream too, and are told apart by it. */
  private readonly client = Math.random().toString(36).slice(2, 12);
  /** Answers someone else is having written in the open conversation. */
  watch = signal<CcWatch[]>([]);
  private liveAbort: AbortController | null = null;
  private liveFor: string | null = null;
  private liveTimer: ReturnType<typeof setTimeout> | null = null;
  private liveTries = 0;
  private gone = false;
  /** Lines waiting for the answer being written (the server's queue). */
  queue = signal<CcQueued[]>([]);
  queuePaused = signal(false);
  qEditing = signal<string | null>(null);
  qDraft = signal('');
  /** An answer is being written here - mine or anyone's: a line now is queued. */
  busy = computed(() => !!this.live() || this.watch().length > 0);
  /** The next question, suggested in the empty composer after an answer (rooms/suggest.ts). */
  sg = new ComposerSuggest(() => {
    const c = this.chat(), m = c?.messages?.at(-1);
    return { kind: 'cc', id: c?.id ?? null, busy: this.busy(), may: this.auth.can('draw'),
             last: !c?.messages ? undefined : m?.role === 'assistant' && !m.error && m.content?.trim() ? m.id : null,
             empty: !this.text().trim() && !this.att.items().length && !this.picked().length && !this.editing() };
  }, s => { this.setText(s); const el = this.box()?.nativeElement; el?.focus(); el?.setSelectionRange(s.length, s.length); });
  /** An answer is being written in this conversation of the list - this page's own, or anyone's. */
  running(c: CcChat) { return !!c.gen || this.runs().has(c.id); }
  /** What the next line mentions, as chips in the composer. */
  picked = signal<CcMention[]>([]);
  mentionPop = signal(false);
  mentionQ = signal('');
  mentionRows = signal<CcMention[]>([]);
  mentionIdx = signal(0);
  mentionBusy = signal(false);
  private mentionAt = -1;
  private mentionSeq = 0;
  private mentionTimer: ReturnType<typeof setTimeout> | null = null;
  private editPicked: CcMention[] = [];
  /** The server's search: null while nothing is typed. */
  hits = signal<CcHit[] | null>(null);
  searching = signal(false);
  withArchived = signal(false);
  private searchSeq = 0;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  /** The line a search hit opened, lit for a moment. */
  flash = signal<string | null>(null);
  modelInfo = computed(() => this.models().find(x => x.id === this.model()) ?? null);
  /** A mention with a picture in it, and a model that reads none. */
  picturesAsText = computed(() => !this.modelInfo()?.vision && (this.att.pictures() || this.picked().some(m =>
    m.kind === 'revision' || m.kind === 'model' || isPicture(m))));
  readonly CLIP = PAPERCLIP;
  /** Pictures pasted, dropped or attached: uploaded to Files ("Chat"), then
   *  sent as @-mentions of those files (rooms/chat-attach.ts). Eight
   *  mentions go with one line (backend/cc_context.py MAX_MENTIONS). */
  att = new ChatAttach(inject(FilesApi), () => 'chat', () => 8 - this.picked().length);
  /** A line's mentions that are not pictures - those are drawn as pictures. */
  chipsOf(l: CcMention[] | undefined) { return (l ?? []).filter(m => !isPicture(m)); }

  /** Tokens and money the conversation's answers have used, from each answer's own usage. */
  totals = computed(() => {
    let tin = 0, tout = 0, cost = 0, priced = 0, unpriced = 0;
    for (const m of this.messages()) {
      if (m.role !== 'assistant' || !m.usage) continue;
      tin += m.usage.prompt_tokens ?? 0;
      tout += m.usage.completion_tokens ?? 0;
      if (m.usage.cost != null) { cost += m.usage.cost; priced++; } else if (m.usage.prompt_tokens || m.usage.completion_tokens) unpriced++;
    }
    if (!tin && !tout) return null;
    const title = `${t('Tokens in')}: ${tin.toLocaleString()}\n${t('Tokens out')}: ${tout.toLocaleString()}`
      + (priced ? `\n${t('Cost')}: ${this.money(cost)} · ${priced} ${t('answers priced')}` : '')
      + (unpriced ? `\n${unpriced} ${t('answers without a price - the provider does not say')}` : '');
    return { text: `${this.kfmt(tin + tout)} tok` + (priced ? ` · ${this.money(cost)}` : ''), title };
  });

  /** How full the chosen model's context window is: the last answer's own
   *  count for everything before it, the rest guessed at 4 characters a token. */
  meter = computed(() => {
    const ctx = this.modelInfo()?.context;
    const msgs = this.messages();
    if (!ctx || (!msgs.length && !this.text())) return null;
    let used = 0, from = 0;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const u = msgs[i].usage;
      if (msgs[i].role === 'assistant' && u?.prompt_tokens) { used = u.prompt_tokens + (u.completion_tokens ?? 0); from = i + 1; break; }
    }
    let chars = this.text().length;
    for (const m of msgs.slice(from)) chars += (m.content?.length ?? 0) + (m.context_chars ?? 0);
    used += Math.ceil(chars / 4);
    const pct = Math.min(100, used / ctx * 100);
    return { pct, state: pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : 'ok', text: `${this.kfmt(used)} / ${this.ctx(ctx)}`,
             title: `${t('Context window')}: ~${used.toLocaleString()} / ${ctx.toLocaleString()} tok (${pct.toFixed(1)}%)\n`
                    + t('Counted from the last answer; the rest estimated at 4 characters a token.') };
  });

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
    // The conversation's log comes and goes (a room thread is shown in its
    // place): whenever a new one is put on the page with a conversation in
    // it, it starts at the end - coming back from a thread to the same
    // conversation calls nothing else that would scroll it.
    let mounted: HTMLElement | null = null;
    effect(() => {
      const el = this.logEl()?.nativeElement ?? null;
      const id = this.chat()?.id;
      if (!el) { mounted = null; return; }
      if (el === mounted || !id) return;
      mounted = el;
      untracked(() => this.scroll());
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
    // Whatever is open is watched: answers others are having written show as they are written.
    effect(() => {
      const id = this.openId();
      untracked(() => this.connectLive(id));
    });
    // The room thread open is in the address (?thread=cad), so it can be linked to.
    effect(() => {
      const room = this.sel.thread();
      const url = new URL(location.href);
      if (room) url.searchParams.set('thread', room); else url.searchParams.delete('thread');
      url.searchParams.delete('chat');            // a linked conversation is opened once, not on every reload
      if (url.href !== location.href) history.replaceState(null, '', url);
    });
    // Asked of this room by the command palette (Ctrl+K).
    effect(() => {
      const w = this.sel.cc();
      if (w) untracked(() => { this.sel.cc.set(null); this.takeWant(w); });
    });
  }

  /** "Ask Command Code about this …", "New Command Code chat", "Open last
   *  chat" from the palette: a new conversation (or the open one, when it is
   *  still empty), what was asked about attached as an @-mention, and the
   *  question sent at once when it was typed there - otherwise the composer
   *  waits, focused. */
  private takeWant(w: CcWant) {
    this.sel.thread.set(null);
    if (w.action === 'last') { this.openLast(); return; }
    if (w.action === 'open' && w.chat) { this.open(w.chat, w.message ?? null); return; }
    const go = (c: CcChat) => {
      if (this.chat()?.id !== c.id) return;
      if (w.mention) {
        const m = w.mention;
        const chip: CcMention = { kind: m.kind, id: m.id, label: m.label || m.id };
        this.picked.set([chip]);
        // The server's own row for it (its kind, size, version) for the chip's tooltip.
        this.api.mentions(m.id, m.kind, 100).subscribe({
          next: rows => { const r = rows.find(x => x.kind === m.kind && x.id === m.id);
                          if (r) this.picked.update(l => l.map(x => x.kind === r.kind && x.id === r.id ? r : x)); },
          error: () => {},
        });
      }
      if (w.text) { this.setText(w.text); void this.send(); }
      else this.focusSoon();
    };
    const c = this.chat();
    if (c && !this.messages().length && !this.live() && !this.watch().length && this.tab() === 'list' && c.by?.id === this.me()) {
      this.cancelEdit(false);
      go(c);
      return;
    }
    // My newest conversation that is still empty, rather than one more empty one.
    if (this.tab() !== 'list') this.showTab('list');
    this.api.list('', 'list').subscribe({
      next: rows => {
        const empty = rows.filter(r => !r.count && !r.gen && !r.queue?.length && r.by?.id === this.me())
          .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0];
        if (empty && !this.live()) this.open(empty.id, null, go);
        else this.newChat(go);
      },
      error: () => this.newChat(go),
    });
  }

  /** The conversation last written in. */
  private openLast() {
    if (this.tab() !== 'list') this.showTab('list');
    this.api.list('', 'list').subscribe({
      next: rows => {
        const last = [...rows].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0];
        if (last && last.id !== this.openId()) this.open(last.id);
        else if (last) setTimeout(() => this.box()?.nativeElement.focus());
      },
      error: e => this.error.set(this.msg(e)),
    });
  }

  ngOnDestroy() {
    clearInterval(this.timer);
    clearInterval(this.clockTimer);
    this.gone = true;
    this.connectLive(null);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    if (this.mentionTimer) clearTimeout(this.mentionTimer);
    this.aborts.forEach(a => a.abort());
    this.aborts.clear();
    this.observer?.disconnect();
    document.removeEventListener('click', this.closeMenu);
    this.flushDeletes(true);
  }

  private closeMenu = () => {
    if (this.menu()) this.menu.set(false);
    if (this.modelPop()) this.modelPop.set(false);
  };

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
    if (this.q().trim()) this.runSearch();
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
    this.sel.thread.set(null);
    if (this.openId() === c.id && this.chat()?.id === c.id) { this.drawer.set(false); return; }
    this.open(c.id);
  }

  /** Open a conversation - at any time: answers being written elsewhere go
   *  on (on the server, and their requests here), and show again when their
   *  conversation is opened again. */
  open(id: string, at?: string | null, then?: (c: CcChat) => void) {
    this.openId.set(id);
    this.error.set(this.runErrors.get(id) ?? null);
    this.runErrors.delete(id);
    this.cancelEdit(false);
    this.drawer.set(false);
    this.api.get(id).subscribe({
      next: c => {
        if (this.openId() !== id) return;
        this.chat.set(c);
        this.applyQueue({ queue: c.queue ?? [], paused: !!c.queue_paused });
        this.provider.set(c.provider);
        this.model.set(c.model);
        if (at) this.scrollTo(at);
        else if (c.messages?.length || this.watch().length) this.scroll();
        if (this.watch().length) this.stickThink();
        if (then) { then(c); return; }
        if (!at) this.focusSoon();
      },
      error: e => this.error.set(this.msg(e)),
    });
  }

  newChat(then?: (c: CcChat) => void) {
    if (!this.auth.can('draw')) return;
    this.sel.thread.set(null);
    if (this.tab() !== 'list') this.showTab('list');
    this.api.create().subscribe({
      next: c => {
        this.chats.update(l => [c, ...l]);
        this.openId.set(c.id);
        this.chat.set(c);
        this.error.set(null);
        this.applyQueue({ queue: [], paused: false });
        this.provider.set(c.provider);
        this.model.set(c.model);
        this.drawer.set(false);
        this.cancelEdit(false);
        then ? then(c) : this.focusSoon();
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
    if (document.hidden) return;
    this.refresh();
    const c = this.chat();
    if (!c || this.live()) return;
    const row = this.chats().find(x => x.id === c.id);
    if (row && row.count !== (c.messages?.length ?? 0) && !this.watch().length) {
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
        // Only the cheap model is picked unasked; on a provider without it
        // the model is left for the person to choose - never the first in
        // the list, which may be the dearest.
        const cheap = m.find(x => x.cheap)?.id ?? '';
        if (cheap) this.pickModel(cheap); else this.modelPop.set(true);
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
    if (!this.editing()) { this.editDraft = this.text(); this.editPicked = this.picked(); }
    this.editing.set(id);
    this.picked.set(line.mentions ?? []);
    this.setText(line.content);
    setTimeout(() => { const el = this.box()?.nativeElement; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } });
  }

  cancelEdit(restore = true) {
    if (!this.editing()) return;
    this.editing.set(null);
    this.setText(restore ? this.editDraft : '');
    this.picked.set(restore ? this.editPicked : []);
    this.editDraft = '';
    this.editPicked = [];
  }

  private setText(s: string) {
    this.text.set(s);
    const el = this.box()?.nativeElement;
    if (el) { el.value = s; setTimeout(() => this.grow()); }
  }

  // ---- keys --------------------------------------------------------------

  key(e: KeyboardEvent) {
    if (this.sg.key(e)) return;                   // the suggested next question (rooms/suggest.ts)
    if (this.mentionPop() && !e.isComposing) {
      const n = this.mentionRows().length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (n) this.mentionIdx.update(i => (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
        setTimeout(() => document.querySelector('.tcv-cc-mlist button.on')?.scrollIntoView({ block: 'nearest' }));
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
        const r = this.mentionRows()[this.mentionIdx()];
        if (r) { e.preventDefault(); this.pickMention(r); return; }
      }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closeMentions(); return; }
    }
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
      if (this.mentionPop()) this.closeMentions();
      else if (this.live() || this.stoppable()) { e.preventDefault(); this.stop(); }
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
    let text = this.text().trim();
    const files = this.att.ready();
    if (!c || (!text && !files.length) || !this.model() || this.att.busy()) return;
    if (files.length) {
      // The uploaded pictures go as @-mentions of their files, as if picked by hand.
      this.picked.update(l => [...l, ...files.filter(p => !l.some(x => x.kind === 'file' && x.id === p.id))
        .map(p => ({ kind: 'file' as const, id: p.id!, label: p.name, image: p.image,
                     sub: (p.image ? 'image' : 'file') + ' · ' + Math.ceil(p.bytes / 1024) + ' kB' }))]);
      this.att.clear();
      if (!text) text = t(files.some(p => p.image) ? 'See the attached picture.' : 'See the attached file.');
    }
    if (this.busy()) {
      if (this.editing()) { this.error.set(t('An answer is being written in this conversation - wait for it, or stop it.')); return; }
      await this.queueLine(c, text);
      return;
    }
    const edit = this.editing() ?? undefined;
    const picked = this.picked();
    const mentions = picked.map(m => ({ kind: m.kind, id: m.id }));
    this.editing.set(null);
    this.editDraft = '';
    this.editPicked = [];
    this.picked.set([]);
    this.closeMentions();
    this.setText('');
    await this.run(c, (sig, on) => this.api.say(c.id, { text, provider: this.provider(), model: this.model(), edit,
                                                         mentions, client: this.client }, sig, on),
                   () => {
                     if (!this.text()) this.setText(text);
                     if (!this.picked().length) this.picked.set(picked);
                     if (edit) this.editing.set(edit);
                   });
  }

  /** The last answer again - with the model chosen here, or with `model`. */
  async regenerate(model?: string) {
    const c = this.chat();
    if (!c || this.live()) return;
    if (this.watch().length) { this.error.set(t('An answer is being written in this conversation - wait for it, or stop it.')); return; }
    if (model) this.model.set(model);
    if (!this.model()) return;
    await this.run(c, (sig, on) => this.api.regenerate(c.id, { provider: this.provider(), model: this.model(), client: this.client },
                                                        sig, on));
  }

  /** This page's own answer, in conversation `c` - keyed by it all the way:
   *  what streams back lands in `c` whichever conversation is open by then. */
  private async run(c: CcChat, call: (sig: AbortSignal, on: (ev: CcEvent) => void) => Promise<void>, failed?: () => void) {
    const id = c.id;
    const here = () => this.openId() === id;
    this.error.set(null);
    this.runErrors.delete(id);
    this.setRun(id, () => ({ text: '', thinking: '', t0: Date.now(), t1: null, model: this.model(), gen: null }));
    const abort = new AbortController();
    this.aborts.set(id, abort);
    let started = false;
    let finished = false;
    let left = false;
    try {
      await call(abort.signal, ev => {
        if (ev.type === 'user') {
          started = true;
          this.setRun(id, r => r && { ...r, gen: ev.gen ?? null });
          this.inChat(id, x => ({ ...x, messages: [...(x.messages ?? []).slice(0, ev.keep ?? (x.messages ?? []).length),
                                                   ...(ev.message ? [ev.message] : [])] }));
          if (here()) this.scroll();
        } else if (ev.type === 'thinking') {
          this.setRun(id, r => r && this.sped({ ...r, thinking: r.thinking + (ev.text ?? ''), t1: r.t1 ?? Date.now() }));
          if (here()) { this.stickThink(); this.scroll(true); }
        } else if (ev.type === 'text') {
          this.setRun(id, r => r && this.sped({ ...r, text: r.text + (ev.text ?? ''), t1: r.t1 ?? Date.now() }));
          if (here()) this.scroll(true);
        } else if (ev.type === 'steps') {
          this.setRun(id, r => r && { ...r, steps: ev.steps ?? [] });
          if (here()) this.scroll(true);
        } else if (ev.type === 'error') {
          const err = ev.error ?? t('The model did not answer.');
          if (here()) this.error.set(err); else this.runErrors.set(id, err);
        } else if (ev.type === 'done' && ev.message) {
          finished = true;
          this.inChat(id, x => (x.messages ?? []).some(y => y.id === ev.message!.id) ? x
                                : { ...x, messages: [...(x.messages ?? []), ev.message!] });
          this.setRun(id, () => null);
          if (here()) this.scroll();
        } else if (ev.type === 'title' && ev.title) {
          this.inChat(id, x => ({ ...x, title: ev.title! }));
          this.chats.update(l => l.map(x => x.id === id ? { ...x, title: ev.title! } : x));
        }
      });
    } catch (e) {
      left = (e as Error).name === 'AbortError';
      if (!left && !started) {
        if (here()) { this.error.set((e as Error).message); failed?.(); }
        else this.runErrors.set(id, (e as Error).message);
      }
      // Cut once it had started (the API reloaded, the network dropped):
      // the answer is still being written on the server - followed below.
    } finally {
      this.setRun(id, () => null);
      if (this.aborts.get(id) === abort) this.aborts.delete(id);
      this.refresh();
      this.api.get(id).subscribe({
        next: x => { if (this.openId() === x.id && !this.live()) { this.chat.set(x); this.scroll(); } }, error: () => {} });
      // Not seen to the end here: the live stream picks it up where it is
      // (and does by itself when the conversation is opened again later).
      if (started && !finished && !left && here()) this.relisten(id);
    }
  }

  /** This page's own answer in conversation `id`: changed, or ended (null). */
  private setRun(id: string, f: (r: Run | null) => Run | null) {
    this.runs.update(m => {
      const r = f(m.get(id) ?? null);
      if (!r && !m.has(id)) return m;
      const n = new Map(m);
      if (r) n.set(id, r); else n.delete(id);
      return n;
    });
  }

  /** The conversation on screen changed - only when it is `id` (one being
   *  opened may still show the one before it). */
  private inChat(id: string, f: (c: CcChat) => CcChat) {
    this.chat.update(x => x && x.id === id ? f(x) : x);
  }

  /** The answer being written that this page may stop: its own, or anyone's
   *  with the right to delete. */
  stoppable = computed(() => this.watch().find(w => w.by?.id === this.me() || this.auth.can('delete')) ?? null);

  /** Stop the answer being written - on the server, which keeps it as far
   *  as it got. Leaving the page does not stop it. */
  stop() {
    const id = this.openId();
    if (!id || (!this.live() && !this.stoppable())) return;
    this.api.stop(id).subscribe({ error: e => this.error.set(this.msg(e)) });
  }

  // ---- the queue: lines sent while an answer is being written ---------------

  /** Queued on the server; it goes by itself when the answer ends. */
  private async queueLine(c: CcChat, text: string) {
    const picked = this.picked();
    this.picked.set([]);
    this.closeMentions();
    this.setText('');
    try {
      const got = await this.api.queueSay(c.id, { text, provider: this.provider(), model: this.model(),
                                                  mentions: picked.map(m => ({ kind: m.kind, id: m.id })), client: this.client });
      if (got && this.openId() === c.id) this.applyQueue(got);
      this.scroll(true);
    } catch (e) {
      this.error.set((e as Error).message);
      if (!this.text()) this.setText(text);
      if (!this.picked().length) this.picked.set(picked);
    }
  }

  applyQueue(q: { queue: CcQueued[]; paused: boolean }) {
    this.queue.set(q.queue ?? []);
    this.queuePaused.set(!!q.paused && !!q.queue?.length);
    if (this.qEditing() && !this.queue().some(x => x.id === this.qEditing())) this.qEditing.set(null);
  }

  mayTouch(q: CcQueued) { return this.auth.can('draw') && (q.by?.id === this.me() || this.auth.can('delete')); }

  queueStartEdit(q: CcQueued) {
    this.qDraft.set(q.content);
    this.qEditing.set(q.id);
    setTimeout(() => this.logEl()?.nativeElement.querySelector<HTMLTextAreaElement>('.tcv-cc-qedit textarea')?.focus());
  }

  qKey(e: KeyboardEvent, q: CcQueued) {
    if (e.shiftKey || e.isComposing) return;
    e.preventDefault();
    this.queueSave(q);
  }

  private queueDo(call: (id: string) => Observable<CcQueueState>) {
    const id = this.openId();
    if (!id) return;
    call(id).subscribe({ next: q => { if (this.openId() === id) this.applyQueue(q); }, error: e => this.error.set(this.msg(e)) });
  }

  queueSave(q: CcQueued) {
    const text = this.qDraft().trim();
    if (!text) return;
    this.qEditing.set(null);
    if (text !== q.content) this.queueDo(id => this.api.queueEdit(id, q.id, text));
  }

  queueRemove(q: CcQueued) { this.queueDo(id => this.api.queueRemove(id, q.id)); }
  queueResume() { this.queueDo(id => this.api.queueResume(id)); }
  queueClear() { this.queueDo(id => this.api.queueClear(id)); }

  // ---- the thinking block ---------------------------------------------------

  /** Open while it thinks, folded once the answer begins - unless the reader chose. */
  thinkOpen(key: string, streaming: boolean) { return this.thinkHand().get(key) ?? streaming; }

  thinkToggled(key: string, streaming: boolean, e: Event) {
    const open = (e.target as HTMLDetailsElement).open;
    // The page folding it by itself (the answer began) is not the reader's choice.
    if (open === streaming && !this.thinkHand().has(key)) return;
    this.thinkHand.update(m => new Map(m).set(key, open));
    if (open) this.stickThink();
  }

  /** The reader scrolled up in a thinking block: it stops following, and
   *  follows again once scrolled back to the end. A scroll this page made
   *  itself (its event can come after the next piece grew the block) is
   *  not the reader's. */
  thinkScrolled(e: Event) {
    const el = e.target as HTMLElement;
    if (Math.abs(el.scrollTop - Number(el.dataset['auto'] ?? -9)) < 2) return;
    el.dataset['free'] = el.scrollHeight - el.scrollTop - el.clientHeight > 24 ? '1' : '';
  }

  /** Thinking blocks still being written follow their end - after the
   *  piece is on screen (a timer, then the next frame, for whichever
   *  comes after Angular has drawn it). */
  private stickThink() {
    const stick = () => {
      this.logEl()?.nativeElement.querySelectorAll<HTMLElement>('.tcv-cc-thinkbody[data-live]').forEach(el => {
        if (el.dataset['free'] === '1') return;
        el.scrollTop = el.scrollHeight;
        el.dataset['auto'] = String(el.scrollTop);
      });
    };
    setTimeout(() => { stick(); requestAnimationFrame(stick); });
  }

  /** The live stream again, from its hello: what is being written, as far as it got. */
  private relisten(id: string) {
    this.liveFor = null;
    this.connectLive(id);
  }

  // ---- watching: answers others are having written --------------------------

  /** One live stream, for the open conversation; none when nothing is open. */
  private connectLive(id: string | null) {
    if (id && this.liveFor === id && (this.liveAbort || this.liveTimer)) return;
    this.liveAbort?.abort();
    this.liveAbort = null;
    if (this.liveTimer) clearTimeout(this.liveTimer);
    this.liveTimer = null;
    this.liveFor = id;
    this.liveTries = 0;
    this.watch.set([]);
    if (id && !this.gone) void this.listen(id);
  }

  /** Listen until the server closes it, then again: at once after a goodbye,
   *  later and later (1 s doubling to 30 s) while the API is away - a reload. */
  private async listen(id: string) {
    const ctl = new AbortController();
    this.liveAbort = ctl;
    this.liveTimer = null;
    let heard = false;
    let status = 0;
    // The server says something every 10 s. A reload behind the dev proxy can
    // leave the stream open and silent for ever: after 25 s of nothing it is
    // given up and opened again.
    let last = Date.now(), dead = false;
    const watchdog = setInterval(() => {
      if (Date.now() - last > 25_000) { dead = true; ctl.abort(); }
    }, 5000);
    try {
      await this.api.live(id, ctl.signal, ev => { heard = true; this.liveTries = 0; this.onLive(id, ev); },
                          () => { last = Date.now(); });
    } catch (e) {
      status = (e as { status?: number }).status ?? 0;
      if ((e as Error).name === 'AbortError' && !dead) { clearInterval(watchdog); return; }
    }
    clearInterval(watchdog);
    if ((ctl.signal.aborted && !dead) || this.gone || this.liveFor !== id) return;
    if (dead) heard = false;                                  // not a goodbye: back off
    this.liveAbort = null;
    if (status === 404 || status === 403) return;              // gone, or not ours to watch
    const wait = heard ? 300 : Math.min(30_000, 1000 * 2 ** Math.min(this.liveTries, 5)) * (0.75 + Math.random() / 2);
    this.liveTries++;
    this.liveTimer = setTimeout(() => {
      this.liveTimer = null;
      if (this.liveFor === id && !this.gone) void this.listen(id);
    }, wait);
  }

  private onLive(id: string, ev: CcEvent & Partial<CcWatch>) {
    if (this.openId() !== id) return;
    // This page's own answer, while its request is still streaming it here;
    // after a refresh (or a cut stream) it is followed like anyone's.
    const own = this.runs().get(id);
    const mine = (w: { client?: string | null; gen?: string }) =>
      !!w.client && w.client === this.client && !!own && (!own.gen || w.gen === own.gen);
    switch (ev.type) {
      case 'hello': {
        const now = (ev.live ?? []).filter(w => !mine(w)).map(w => this.clocked(w));
        // Finished while the stream was away: read the conversation again.
        const lost = this.watch().some(w => !now.some(x => x.gen === w.gen));
        this.watch.set(now);
        now.forEach(w => this.showAsked(id, w));
        if (now.length) { this.stickThink(); this.scroll(true); }
        if (lost) this.reread(id);
        if (ev.queue && !Array.isArray(ev.queue)) this.applyQueue(ev.queue);
        break;
      }
      case 'timing': {
        const w0 = this.watch().find(w => w.gen === ev.gen);
        if (w0) this.watch.update(l => l.map(w => w.gen === ev.gen ? this.clocked({ ...w, started_at: ev.started_at, first_at: ev.first_at }) : w));
        break;
      }
      case 'queue':
        this.applyQueue({ queue: Array.isArray(ev.queue) ? ev.queue : [], paused: !!ev.paused });
        break;
      case 'start': {
        if (mine(ev) || !ev.gen) return;
        const w: CcWatch = this.clocked({ gen: ev.gen, client: ev.client, by: ev.by ?? {}, model: ev.model ?? '', provider: ev.provider ?? '',
                             message: ev.message ?? null, keep: ev.keep, text: ev.text ?? '', thinking: ev.thinking ?? '',
                             steps: ev.steps ?? [],
                             started_at: ev.started_at, first_at: ev.first_at, now: ev.now });
        this.watch.update(l => [...l.filter(x => x.gen !== w.gen), w]);
        this.showAsked(id, w);
        this.scroll(true);
        if (w.thinking) this.stickThink();
        break;
      }
      case 'text': case 'thinking': {
        const k = ev.type === 'text' ? 'text' : 'thinking';
        if (!this.watch().some(w => w.gen === ev.gen)) return;
        this.watch.update(l => l.map(w => w.gen === ev.gen ? this.sped({ ...w, [k]: w[k] + (ev.text ?? ''), t1: w.t1 ?? Date.now() }) : w));
        if (k === 'thinking') this.stickThink();
        this.scroll(true);
        break;
      }
      case 'steps':
        if (!this.watch().some(w => w.gen === ev.gen)) return;
        this.watch.update(l => l.map(w => w.gen === ev.gen ? { ...w, steps: ev.steps ?? [] } : w));
        this.scroll(true);
        break;
      case 'done': {
        if (!this.watch().some(w => w.gen === ev.gen)) return;
        this.watch.update(l => l.filter(w => w.gen !== ev.gen));
        const m = ev.message;
        if (m) this.inChat(id, x => (x.messages ?? []).some(y => y.id === m.id) ? x : { ...x, messages: [...(x.messages ?? []), m] });
        this.scroll(true);
        this.refresh();
        break;
      }
      case 'end':
        this.watch.update(l => l.filter(w => w.gen !== ev.gen));
        break;
      case 'title':
        if (ev.title) {
          this.chat.update(x => x && x.id === id ? { ...x, title: ev.title! } : x);
          this.chats.update(l => l.map(x => x.id === id ? { ...x, title: ev.title! } : x));
        }
        break;
    }
  }

  /** Someone else's question, in the conversation as they sent it. */
  private showAsked(id: string, w: CcWatch) {
    if (this.runs().has(id)) return;                          // my own answer is being written here
    const m = w.message;
    this.chat.update(x => {
      if (!x || x.id !== id) return x;
      const msgs = x.messages ?? [];
      if (m && msgs.some(y => y.id === m.id)) return x;
      return { ...x, messages: [...msgs.slice(0, w.keep ?? msgs.length), ...(m ? [m] : [])] };
    });
  }

  private reread(id: string) {
    this.api.get(id).subscribe({ next: x => { if (this.openId() === x.id && !this.live()) this.chat.set(x); }, error: () => {} });
  }

  // ---- speed: tokens per second, time to first token ----------------------

  /** The server's times of an answer being written, on this page's clock. */
  private clocked(w: CcWatch): CcWatch {
    const skew = w.now ? Date.now() - Date.parse(w.now) : 0;
    const local = (iso?: string | null) => iso && !isNaN(Date.parse(iso)) ? Date.parse(iso) + skew : null;
    const ttft = w.started_at && w.first_at ? Date.parse(w.first_at) - Date.parse(w.started_at) : null;
    return this.sped({ ...w, t0: w.t0 ?? local(w.started_at), t1: w.t1 ?? local(w.first_at),
                       ttft: ttft != null && ttft >= 0 ? ttft : w.ttft ?? null });
  }

  /** The speed worked out now, kept with the answer so the page shows it
   *  until the next piece (never read off the clock while drawing). */
  private sped<X extends { text: string; thinking: string; t0?: number | null; t1?: number | null; ttft?: number | null;
                           sp?: Speed | null }>(x: X): X {
    return { ...x, sp: this.speed(x.text, x.thinking, x.t0, x.t1, x.ttft) };
  }

  /** While it is written: tokens a second so far, estimated at 4 characters
   *  a token (the provider counts only at the end), and the time to the
   *  first token. Read again with every piece that comes. */
  private speed(text: string, thinking: string, t0?: number | null, t1?: number | null, known?: number | null): Speed | null {
    if (!t1) return null;
    const secs = (Date.now() - t1) / 1000;
    const tok = (text.length + thinking.length) / 4;
    // The server's own measure when there is one; this page's clock only for its own answer.
    const ttft = known != null ? known : t0 && t1 > t0 ? t1 - t0 : null;
    const rate = secs >= 0.3 && tok ? tok / secs : null;
    if (rate == null && ttft == null) return null;
    const parts = [rate != null ? `~${this.rateFmt(rate)} tok/s` : '', ttft != null ? `TTFT ${this.secs(ttft)}` : ''].filter(Boolean);
    const tip = [t('Tokens per second, estimated while it is written: about 4 characters a token, thinking included.'),
                 t('The exact count comes with the finished answer.'),
                 ttft != null ? `${t('Time to first token')}: ${this.secs(ttft)}` : ''].filter(Boolean).join('\n');
    return { text: parts.join(' · '), tip };
  }

  rateFmt(r: number) { return r >= 10 ? String(Math.round(r)) : r.toFixed(1); }



  /** Under a finished answer, at rest: how fast, how much, how long. */
  restLine(m: CcMessage) {
    const tm = m.timing;
    const est = tm?.estimated ? '~' : '';
    const bits: string[] = [];
    if (tm) {
      if (tm.tps != null) bits.push(`${est}${this.rateFmt(tm.tps)} tok/s`);
      if (tm.out_tokens) bits.push(`${est}${this.num(tm.out_tokens)} tok`);
      if (tm.total_ms != null) bits.push(this.secs(tm.total_ms));
    } else {
      if (m.usage?.completion_tokens) bits.push(`${this.num(m.usage.completion_tokens)} tok`);
      if (m.ms) bits.push(this.secs(m.ms));
    }
    if (m.stopped) bits.push(t('stopped'));
    if (m.interrupted) bits.push(t('interrupted'));
    return bits.join(' · ') || t('Details');
  }

  /** Everything about how an answer came, for its popover. */
  details(m: CcMessage): { k: string; v: string }[] {
    const tm = m.timing ?? {};
    const u = m.usage ?? {};
    const out: { k: string; v: string }[] = [];
    const add = (k: string, v: string | null | undefined | false) => { if (v) out.push({ k, v }); };
    add('Sent', this.fullStamp(tm.started_at || m.at));
    add('First token', tm.first_at ? this.fullStamp(tm.first_at) : '');
    add('Finished', tm.finished_at ? this.fullStamp(tm.finished_at) : '');
    add('Time to first token', tm.ttft_ms != null ? this.secs(tm.ttft_ms) : '');
    add('Average speed', tm.tps != null ? `${tm.estimated ? '~' : ''}${tm.tps} tok/s` : '');
    add('Thinking', m.thinking_ms ? this.secs(m.thinking_ms) : '');
    if (tm.first_at && tm.finished_at) add('Writing', this.secs(Math.max(0, Date.parse(tm.finished_at) - Date.parse(tm.first_at))));
    add('Total time', tm.total_ms != null ? this.secs(tm.total_ms) : m.ms ? this.secs(m.ms) : '');
    add('Tokens in', u.prompt_tokens ? this.num(u.prompt_tokens) : '');
    const outTok = u.completion_tokens ?? tm.out_tokens;
    add('Tokens out', outTok ? `${tm.estimated && !u.completion_tokens ? '~' : ''}${this.num(outTok)}` : '');
    add('Thinking tokens', m.thinking ? `~${this.num(Math.ceil(m.thinking.length / 4))}` : '');
    if (u.prompt_tokens || outTok) add('Total tokens', this.num((u.prompt_tokens ?? 0) + (outTok ?? 0)));
    const ctx = this.models().find(x => x.id === m.model)?.context;
    if (ctx && u.prompt_tokens) {
      const used = u.prompt_tokens + (u.completion_tokens ?? 0);
      add('Context used', `${(used / ctx * 100).toFixed(1)}% · ${this.kfmt(used)} / ${this.ctx(ctx)}`);
    }
    add('Cost', u.cost != null ? this.money(u.cost) : '');
    add('Model', m.model ? `${m.model}${m.provider ? ' · ' + this.provLabel(m.provider) : ''}` : '');
    const status = m.interrupted ? t('interrupted') + ' - ' + t('The server restarted while it was being written.')
      : m.stopped ? t('stopped') : m.error ? t('failed') : t('finished');
    add('Status', status + (m.error && !m.interrupted ? ` - ${m.error}` : ''));
    return out;
  }

  /** "7 Oct 2026, 14:03:27" - the reader's own time. */
  fullStamp(iso: string) {
    const d = new Date(iso);
    return isNaN(+d) ? '' : d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric',
                                                          hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  /** The popover of a line: opened by a tap (touch) or the stats button, closed by another. */
  detail = signal<string | null>(null);
  toggleDetail(id: string) { this.detail.update(d => d === id ? null : id); }
  rowTap(m: CcMessage, e: Event) {
    if (!matchMedia('(hover: none)').matches) return;
    // On a phone only a tap on the stats line opens the details; a tap on
    // the text is for reading and selecting it.
    if (!(e.target as HTMLElement).closest('.tcv-cc-statwrap')) return;
    if ((e.target as HTMLElement).closest('a, button, input, textarea, select, pre, summary, .tcv-cc-thinkbody')) return;
    this.toggleDetail(m.id);
  }

  /** The same sender as the line before: no avatar again. */
  sameAsBefore(i: number) {
    const msgs = this.messages();
    if (i <= 0) return false;
    const a = msgs[i], b = msgs[i - 1];
    if (a.role !== b.role) return false;
    // Two answers in a row are one sender only when the same model wrote both.
    if (a.role === 'assistant') return (a.model ?? '') === (b.model ?? '');
    return (a.by?.id ?? a.by?.name) === (b.by?.id ?? b.by?.name);
  }

  /** A person's picture (backend/profile.py), over their initials; one that
   *  is not there is not asked for again. Agents have none. */
  private noPics = signal<Set<string>>(new Set());
  picOf(by?: { id?: string; type?: string; picture?: string } | null): string | null {
    if (by?.picture) return by.picture;
    if (!by?.id || by.type === 'agent' || this.noPics().has(by.id)) return null;
    return `/api/me/avatar/${encodeURIComponent(by.id)}`;
  }
  noPic(by?: { id?: string } | null) {
    if (by?.id) this.noPics.update(s => new Set(s).add(by.id!));
  }

  /** The person's colour - the one they chose on their Profile, else a
   *  series colour picked by name (avatar.ts) - mixed into the surface (or
   *  the line) so the initials read in every theme. */
  private avColours = inject(AvatarColours);
  avTint(name: string | undefined, pct: number, base: '--surface' | '--line', id?: string) {
    const c = avatarColour(name || '?', this.avColours.of(id));
    return `color-mix(in srgb, ${c} ${pct}%, ${base === '--surface' ? 'var(--surface)' : 'var(--line)'})`;
  }

  /** Whose model it is, for its mark. */
  family(model?: string | null): string {
    const m = (model || '').toLowerCase();
    if (!m) return 'redline';
    if (m.includes('claude') || m.includes('anthropic')) return 'claude';
    if (m.includes('gemini') || m.includes('gemma')) return 'gemini';
    for (const f of ['qwen', 'gpt', 'openai', 'deepseek', 'llama', 'mistral', 'grok', 'kimi', 'glm', 'minimax', 'phi'])
      if (m.includes(f)) return f === 'openai' ? 'gpt' : f;
    return 'other';
  }

  monogram(model?: string | null) {
    const f = this.family(model);
    const MONO: Record<string, string> = { qwen: 'Q', gpt: 'AI', deepseek: 'DS', llama: 'L', mistral: 'M', grok: 'X',
                                           kimi: 'K', glm: 'Z', minimax: 'MM', phi: 'φ' };
    return MONO[f] ?? (this.short(model || '?').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 1).toUpperCase() || '?');
  }

  /** "Ada is asking…" */
  asking(w: CcWatch) {
    return t('{x} is asking…').replace('{x}', w.by?.name || t('someone'));
  }

  // ---- @-mentions -----------------------------------------------------------

  /** After each keystroke (or click): an "@word" just before the caret opens the picker. */
  typed(el: HTMLTextAreaElement) {
    this.text.set(el.value);
    const upto = el.value.slice(0, el.selectionStart ?? el.value.length);
    const m = /(^|\s)@([^\s@]{0,40})$/.exec(upto);
    if (!m) { if (this.mentionPop()) this.closeMentions(); return; }
    this.mentionAt = upto.length - m[2].length - 1;
    if (!this.mentionPop() || this.mentionQ() !== m[2]) {
      this.mentionQ.set(m[2]);
      this.mentionPop.set(true);
      this.findMentions(m[2]);
    }
  }

  private findMentions(q: string) {
    if (this.mentionTimer) clearTimeout(this.mentionTimer);
    const seq = ++this.mentionSeq;
    this.mentionBusy.set(true);
    this.mentionTimer = setTimeout(() => this.api.mentions(q).subscribe({
      next: rows => {
        if (seq !== this.mentionSeq) return;
        const have = this.picked();
        this.mentionRows.set(rows.filter(r => !have.some(h => h.kind === r.kind && h.id === r.id)));
        this.mentionIdx.set(0);
        this.mentionBusy.set(false);
      },
      error: e => { if (seq === this.mentionSeq) { this.mentionBusy.set(false); this.error.set(this.msg(e)); } },
    }), q ? 120 : 0);
  }

  closeMentions() {
    this.mentionPop.set(false);
    this.mentionAt = -1;
    this.mentionSeq++;
  }

  /** The @ button: an @ at the caret, and the picker. */
  startMention() {
    const el = this.box()?.nativeElement;
    if (!el) return;
    const v = this.text(), at = el.selectionStart ?? v.length;
    const lead = at > 0 && !/\s/.test(v[at - 1]) ? ' ' : '';
    this.setText(v.slice(0, at) + lead + '@' + v.slice(at));
    el.focus();
    const caret = at + lead.length + 1;
    el.setSelectionRange(caret, caret);
    this.typed(el);
  }

  /** The "@word" typed goes; the thing picked becomes a chip. */
  pickMention(r: CcMention) {
    const el = this.box()?.nativeElement;
    const v = this.text();
    if (this.mentionAt >= 0 && el) {
      let end = el.selectionStart ?? v.length;
      // No double space where the "@word" was.
      if (v[end] === ' ' && (this.mentionAt === 0 || /\s/.test(v[this.mentionAt - 1]))) end++;
      this.setText(v.slice(0, this.mentionAt) + v.slice(end));
      const at = this.mentionAt;
      setTimeout(() => { el.focus(); el.setSelectionRange(at, at); });
    }
    this.picked.update(l => l.some(x => x.kind === r.kind && x.id === r.id) ? l : [...l, r].slice(0, 8));
    this.closeMentions();
  }

  unpick(m: CcMention) { this.picked.update(l => l.filter(x => !(x.kind === m.kind && x.id === m.id))); }

  kindIcon(k: CcMention['kind']) { return KIND[k]?.icon ?? I.note; }
  kindName(k: CcMention['kind']) { return KIND[k]?.name ?? k; }

  mentionTip(m: CcMention) {
    const bits = [`${t(this.kindName(m.kind))} ${m.id}`];
    if (m.version != null && m.version !== '') bits.push(`${t('version')} ${m.version}`);
    if (m.chars) bits.push(`${m.chars.toLocaleString()} ${t('characters to the model')}` + (m.truncated ? ` (${t('cut')})` : ''));
    if (m.images) bits.push(`${m.images} ${t('images')}`);
    return bits.join(' · ');
  }

  /** A chip opens what it mentions, in its own room. */
  openMention(m: CcMention) {
    switch (m.kind) {
      case 'model': this.sel.room.set('cad'); this.sel.ask('model', m.id); break;
      case 'board': this.sel.openBoard(m.id); break;
      case 'note': this.sel.room.set('notes'); this.sel.ask('note', m.id); break;
      case 'part': this.sel.room.set('pcb'); setTimeout(() => this.sel.ask('part', m.id), 300); break;
      case 'file': window.open(`/api/files/${encodeURIComponent(m.id)}?inline=1`, '_blank', 'noopener'); break;
      case 'revision': {
        const o = m.open ?? {};
        const on = o.board || o.model;
        if (o.room === 'pcb' && on) this.sel.openBoard(on);
        else if (o.model) { this.sel.room.set('cad'); this.sel.ask('model', o.model); }
        break;
      }
    }
  }

  // ---- search: every line, on the server ------------------------------------

  setQuery(v: string) {
    this.q.set(v);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    if (!v.trim()) { this.searchSeq++; this.hits.set(null); this.searching.set(false); return; }
    this.searching.set(true);
    this.searchTimer = setTimeout(() => this.runSearch(), 250);
  }

  runSearch() {
    const q = this.q().trim();
    if (!q) { this.hits.set(null); return; }
    const seq = ++this.searchSeq;
    this.searching.set(true);
    this.api.search(q, this.tab(), this.withArchived()).subscribe({
      next: r => { if (seq === this.searchSeq) { this.hits.set(r.results); this.searching.set(false); } },
      error: e => { if (seq === this.searchSeq) { this.searching.set(false); this.error.set(this.msg(e)); } },
    });
  }

  /** A snippet in pieces: the words found, and what is between them. */
  segments(h: CcHit) {
    const out: { t: string; hit: boolean }[] = [];
    let at = 0;
    for (const [a, b] of [...h.hits].sort((x, y) => x[0] - y[0])) {
      if (a < at) continue;
      if (a > at) out.push({ t: h.snippet.slice(at, a), hit: false });
      out.push({ t: h.snippet.slice(a, b), hit: true });
      at = b;
    }
    if (at < h.snippet.length) out.push({ t: h.snippet.slice(at), hit: false });
    return out;
  }

  /** The conversation, at the line found. */
  openHit(h: CcHit) {
    if (h.trashed) return;                                    // restored first, then read
    this.sel.thread.set(null);
    this.drawer.set(false);
    if (this.openId() === h.chat_id && this.chat()?.id === h.chat_id) { if (h.message_id) this.scrollTo(h.message_id); return; }
    this.open(h.chat_id, h.message_id);
  }

  private scrollTo(mid: string) {
    setTimeout(() => {
      const el = this.logEl()?.nativeElement.querySelector(`[data-mid="${CSS.escape(mid)}"]`);
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      // Reading there now: the end of the conversation does not pull it back.
      this.logFree = true;
      this.flash.set(mid);
      setTimeout(() => { if (this.flash() === mid) this.flash.set(null); }, 2600);
    }, 60);
  }

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

  /** An answer as text and ```task blocks (markdown.ts splitTasks). */
  private split = new Map<string, Segment[]>();
  // ---- the tools the model used, and the ones it may -------------------------

  /** The text with its steps where they happened (`pos`). An answer with a
   *  ```task block shows its steps first instead: a task's index counts the
   *  whole answer (backend/tasks.py), and splitting would count it again. */
  chunks(text: string, steps?: CcStep[]): Chunk[] {
    text = text || '';
    if (!steps?.length) return [{ text }];
    if (text.includes('```task')) return [{ steps }, { text }];
    const out: Chunk[] = [];
    let at = 0;
    for (const s of [...steps].sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0))) {
      const pos = Math.min(Math.max(s.pos ?? 0, at), text.length);
      if (pos > at) out.push({ text: text.slice(at, pos) });
      const last = out[out.length - 1];
      if (last?.steps) last.steps.push(s); else out.push({ steps: [s] });
      at = pos;
    }
    if (at < text.length) out.push({ text: text.slice(at) });
    return out;
  }
  toolIcon(name: string) { return TOOL_ICON[name] ?? I.tool; }
  levelName(l: ToolLevel) { return LEVELS.find(x => x.id === l)?.name ?? l; }
  /** The step's sentence: translated, then its holes filled. */
  stepLine(s: CcStep): string {
    const v = s.vars ?? {};
    return t(s.say || s.tool).replace(/\{(\w+)\}/g, (m, k) => v[k] != null && v[k] !== '' ? String(v[k]) : (k === 'lcsc' ? '?' : m));
  }
  stepNote(s: CcStep): string | null {
    return s.status === 'ask' ? 'waiting for you' : s.status === 'denied' ? 'not allowed'
      : s.status === 'stopped' ? 'stopped' : s.status === 'interrupted' ? 'interrupted' : null;
  }
  argsLine(s: CcStep): string {
    const a = s.args ?? {};
    const parts = Object.entries(a).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    return parts.join(' · ') || '-';
  }
  answerStep(cid: string, s: CcStep, allow: boolean) {
    this.api.answerStep(cid, s.id, allow).subscribe({ error: e => this.error.set(e?.error?.detail ?? t('Something went wrong.')) });
  }

  tools = signal<CcTool[]>([]);
  toolsOpen = signal(false);
  toolsOn = computed(() => this.tools().filter(x => x.on).length);
  toolGroups = computed(() => LEVELS.map(l => ({ ...l, tools: this.tools().filter(x => x.level === l.id) })));
  private toolsLoaded = (() => { this.loadTools(); return true; })();
  private loadTools() {
    this.api.tools().subscribe({ next: r => this.tools.set(r.tools), error: () => {} });
  }
  /** One tool on or off for me: shown at once, then what the server keeps. */
  toggleTool(tl: CcTool) {
    const on = !tl.on;
    this.tools.update(l => l.map(x => x.name === tl.name ? { ...x, on } : x));
    this.api.setTools({ [tl.name]: on }).subscribe({
      next: r => this.tools.set(r.tools),
      error: e => { this.error.set(e?.error?.detail ?? t('Something went wrong.')); this.loadTools(); },
    });
  }

  parts(src: string): Segment[] {
    src = src || '';
    let got = this.split.get(src);
    if (!got) {
      got = splitTasks(src);
      if (this.split.size > 400) this.split.clear();
      this.split.set(src, got);
    }
    return got;
  }
  taskOf(s: Segment): TaskBlock | null { return 'task' in s ? s.task : null; }
  mdOf(s: Segment): string { return 'md' in s ? s.md : ''; }
  /** A task block sent to the queue: spent here at once, as the server keeps it. */
  taskQueued(mid: string, index: number, st: TaskState | null) {
    this.chat.update(c => c && c.messages ? { ...c, messages: c.messages.map(m => m.id !== mid ? m
      : { ...m, tasks: { ...(m.tasks ?? {}), [index]: st } }) } : c);
  }

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
  short(m: string) { return m.includes('/') ? m.split('/').pop()! : m; }
  ctx(n: number) { return n >= 1_000_000 ? `${Math.round(n / 1_000_000)}M` : `${Math.round(n / 1000)}k`; }
  kfmt(n: number) {
    return n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k` : `${(n / 1_000_000).toFixed(1)}M`;
  }
  /** A line's start for the list, without the Markdown marks. */
  snip(s: string) { return plain(s); }
  /** "local agents (x33)" → "LA": letters only, what is in brackets left out. */
  initials(name?: string) {
    const w = (name || '').replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').split(/[^\p{L}\p{N}]+/u).filter(x => x && /\p{L}/u.test(x[0]));
    if (!w.length) return '?';
    return (w[0][0] + (w.length > 1 ? w[1][0] : '')).toUpperCase();
  }
  stamp(iso: string) { return new Date(iso).toLocaleString(); }
  secs(ms: number) { return `${(ms / 1000).toFixed(1)} s`; }
  num(n: number | null | undefined) { return n == null ? '–' : n.toLocaleString(); }
  money(n: number | null | undefined) { return n == null ? '' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(3)}`; }
  provLabel(p: string) { return PROVIDERS.find(x => x.id === p)?.name ?? p; }

  /** "3 min ago" against a clock that ticks, not read while the page is drawn. */
  private clock = signal(Date.now());
  private clockTimer = setInterval(() => this.clock.set(Date.now()), 20_000);
  when(iso: string) {
    const s = (Math.max(this.clock(), Date.parse(iso)) - Date.parse(iso)) / 1000;
    if (s < 60) return t('just now');
    if (s < 3600) return `${Math.floor(s / 60)} ${t('min ago')}`;
    if (s < 86400) return `${Math.floor(s / 3600)} ${t('h ago')}`;
    return new Date(iso).toLocaleDateString();
  }

  /** To the end of the conversation - or, with `follow`, only while the
   *  reader has not scrolled up to read (then it waits until they scroll
   *  back to the end). */
  private scroll(follow = false) {
    if (!follow) this.logFree = false;
    const go = () => {
      const el = this.logEl()?.nativeElement;
      if (!el || (follow && this.logFree)) return;
      el.scrollTop = el.scrollHeight;
      this.logAuto = el.scrollTop;
    };
    setTimeout(() => { go(); requestAnimationFrame(go); });
    // Opening a conversation: what renders after the first frame - maths
    // typeset by KaTeX, pictures, code - makes it taller, so it is taken to
    // the end again as it settles, unless the reader has scrolled up.
    if (!follow) {
      for (const ms of [120, 350, 800, 1600]) setTimeout(() => { if (!this.logFree) go(); }, ms);
    }
  }

  /** The reader scrolled the conversation: away from its end, it stops
   *  following the answer; back at the end, it follows again. */
  logScrolled() {
    const el = this.logEl()?.nativeElement;
    if (!el || Math.abs(el.scrollTop - this.logAuto) < 2) return;      // this page's own scroll
    this.logFree = el.scrollHeight - el.scrollTop - el.clientHeight > 48;
  }

  private msg(e: unknown): string {
    const err = e as { error?: { detail?: unknown }; message?: string };
    return typeof err?.error?.detail === 'string' ? err.error.detail : (err?.message ?? t('Something went wrong.'));
  }
}

