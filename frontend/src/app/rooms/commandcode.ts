import {
  Component, ElementRef, Injectable, OnDestroy, computed, effect, inject, signal, untracked, viewChild,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
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
 */
export interface CcMessage {
  id: string; role: 'user' | 'assistant'; content: string; at: string;
  by?: { id?: string; name?: string; type?: string };
  provider?: string; model?: string; ms?: number; thinking_ms?: number; error?: string;
  usage?: { prompt_tokens?: number | null; completion_tokens?: number | null; cost?: number | null };
}
export interface CcChat {
  id: string; title: string; provider: string; model: string; by: { name?: string; id?: string };
  created_at: string; updated_at: string; count: number;
  messages?: CcMessage[]; last?: { role: string; text: string; by?: string };
}
export interface LlmModel { id: string; name: string; context: number | null; anthropic: boolean }

@Injectable({ providedIn: 'root' })
export class CcApi {
  private http = inject(HttpClient);
  list(q = '') { return this.http.get<CcChat[]>(`/api/cc/chats?q=${encodeURIComponent(q)}`); }
  get(id: string) { return this.http.get<CcChat>(`/api/cc/chats/${id}`); }
  create(provider?: string, model?: string) { return this.http.post<CcChat>('/api/cc/chats', { provider, model }); }
  patch(id: string, p: { title?: string; provider?: string; model?: string }) {
    return this.http.patch<CcChat>(`/api/cc/chats/${id}`, p);
  }
  remove(id: string) { return this.http.delete(`/api/cc/chats/${id}`); }
  models(provider: string) { return this.http.get<LlmModel[]>(`/api/llm/models?provider=${provider}`); }

  /** Send a line; the answer comes back piece by piece through `on`. */
  async say(id: string, body: { text: string; provider: string; model: string }, signal: AbortSignal,
            on: (ev: { type: string; text?: string; error?: string; message?: CcMessage; title?: string }) => void) {
    const r = await fetch(`/api/cc/chats/${id}/messages`, {
      method: 'POST', credentials: 'same-origin', signal,
      headers: { 'Content-Type': 'application/json', 'X-Redline-CSRF': '1' },
      body: JSON.stringify(body),
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

@Component({
  selector: 'app-room-commandcode',
  imports: [T],
  template: `
<div class="tcv-room absolute inset-0 flex min-h-0 gap-1 p-1">
  <!-- LEFT: the conversations -->
  <aside class="tcv-notes-side">
    <div class="tcv-notes-find tcv-cc-side-top">
      @if (auth.can('draw')) {
        <button class="tcv-btn tcv-cc-new" (click)="newChat()">+ {{ 'New conversation' | t }}</button>
      }
      <input class="tcv-notes-search" [placeholder]="'Search conversations' | t" [value]="q()"
             (input)="q.set($any($event.target).value)" (keydown.escape)="q.set('')">
    </div>
    <div class="tcv-notes-list">
      @for (c of shownChats(); track c.id) {
        <button class="tcv-notes-item" [attr.data-on]="c.id === openId() ? 1 : null" (click)="open(c.id)">
          <span class="tcv-notes-item-top">
            <span class="tcv-notes-item-title">{{ c.title }}</span>
            <span class="tcv-notes-item-when">{{ when(c.updated_at) }}</span>
          </span>
          @if (c.last) { <span class="tcv-notes-item-snip">{{ c.last.by ? c.last.by + ': ' : '' }}{{ c.last.text }}</span> }
          <span class="tcv-notes-item-meta">
            <span>{{ short(c.model) }}</span><span>{{ c.count }} {{ 'lines' | t }}</span>
            @if (c.by.name) { <span>{{ c.by.name }}</span> }
          </span>
        </button>
      } @empty {
        <p class="tcv-notes-empty">{{ 'No conversations yet - start one.' | t }}</p>
      }
    </div>
  </aside>

  <!-- RIGHT: one conversation -->
  <section class="tcv-cc-main">
    @if (chat(); as c) {
      <header class="tcv-cc-head">
        <input class="tcv-cc-title" [value]="c.title" (change)="rename($any($event.target).value)"
               [readonly]="!auth.can('draw')" [title]="'Rename' | t">
        <select class="tcv-files-select" [value]="provider()" (change)="pickProvider($any($event.target).value)"
                [title]="'Provider' | t">
          @for (p of providers; track p.id) { <option [value]="p.id" [selected]="p.id === provider()">{{ p.name }}</option> }
        </select>
        <select class="tcv-files-select tcv-cc-model" [value]="model()" (change)="pickModel($any($event.target).value)"
                [title]="'Model' | t">
          @if (!hasModel()) { <option [value]="model()" selected>{{ model() }}</option> }
          @for (m of models(); track m.id) {
            <option [value]="m.id" [selected]="m.id === model()">{{ m.name }}{{ m.anthropic ? ' · Claude' : '' }}{{ m.context ? ' · ' + ctx(m.context) : '' }}</option>
          }
        </select>
        @if (auth.can('draw')) {
          <button class="tcv-btn tcv-files-btn tcv-files-del" (click)="remove()" [title]="'Delete the conversation' | t">✕</button>
        }
      </header>

      <div class="tcv-cc-log" #log>
        @for (m of messages(); track m.id) {
          <div class="tcv-cc-msg" [attr.data-role]="m.role">
            <div class="tcv-cc-who">
              @if (m.role === 'user') { <b>{{ m.by?.name || ('someone' | t) }}</b> }
              @else { <b>{{ short(m.model || '') }}</b> }
              <span>{{ when(m.at) }}</span>
              @if (m.role === 'assistant' && m.ms) {
                <span>{{ (m.ms / 1000).toFixed(1) }} s{{ m.thinking_ms ? ' · ' + ('thought' | t) + ' ' + (m.thinking_ms / 1000).toFixed(1) + ' s' : '' }}</span>
                @if (m.usage?.completion_tokens) { <span>{{ m.usage?.completion_tokens }} tok</span> }
              }
              @if (m.role === 'assistant' && m.content) {
                <button class="tcv-cc-copy" (click)="copy(m.content)" [title]="'Copy' | t">⧉</button>
              }
            </div>
            @if (m.role === 'assistant') {
              <div class="tcv-cc-body md" [innerHTML]="html(m.content)"></div>
            } @else {
              <div class="tcv-cc-body tcv-cc-plain">{{ m.content }}</div>
            }
            @if (m.error) { <div class="tcv-files-error">{{ m.error }}</div> }
          </div>
        }
        @if (live(); as l) {
          <div class="tcv-cc-msg" data-role="assistant">
            <div class="tcv-cc-who"><b>{{ short(model()) }}</b>
              <span class="tcv-cc-pulse">{{ l.text ? ('writing…' | t) : ('thinking…' | t) }}</span></div>
            @if (l.thinking && !l.text) { <div class="tcv-cc-thinking">{{ tail(l.thinking) }}</div> }
            <div class="tcv-cc-body md" [innerHTML]="html(l.text)"></div>
          </div>
        }
        @if (!messages().length && !live()) {
          <p class="tcv-notes-empty">{{ 'Ask anything. Everyone in this workspace sees the conversation and can join it.' | t }}</p>
        }
      </div>

      @if (error(); as e) { <p class="tcv-files-error tcv-cc-err">{{ e }}</p> }
      @if (auth.can('draw')) {
        <div class="tcv-note-compose tcv-cc-compose" [attr.data-focus]="focused() ? 1 : null">
          <textarea #box rows="2" [value]="text()" [placeholder]="'Write to the model…  Enter sends, Shift+Enter a new line' | t"
                    (input)="text.set($any($event.target).value); grow()" (keydown)="key($event)"
                    (focus)="focused.set(true)" (blur)="focused.set(false)"></textarea>
          <div class="tcv-note-compose-bar">
            <span class="tcv-note-hint">{{ provName() }} · {{ model() }}</span>
            <span class="grow"></span>
            @if (live()) {
              <button class="tcv-btn tcv-note-keep" (click)="stop()">{{ 'Stop' | t }} ■</button>
            } @else {
              <button class="tcv-btn tcv-note-keep" [disabled]="!text().trim()" (click)="send()">{{ 'Send' | t }} <kbd>↵</kbd></button>
            }
          </div>
        </div>
      }
    } @else {
      <div class="tcv-cc-intro">
        <h2>Command Code</h2>
        <p>{{ 'Talk with a model - every conversation is shared with the workspace, and each one keeps its own model.' | t }}</p>
        @if (auth.can('draw')) { <button class="tcv-btn" (click)="newChat()">+ {{ 'New conversation' | t }}</button> }
      </div>
    }
  </section>
</div>`,
})
export class RoomCommandCode implements OnDestroy {
  private api = inject(CcApi);
  auth = inject(Auth);
  private box = viewChild<ElementRef<HTMLTextAreaElement>>('box');
  private logEl = viewChild<ElementRef<HTMLDivElement>>('log');

  readonly providers = PROVIDERS;
  q = signal('');
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
  private abort: AbortController | null = null;
  private timer = setInterval(() => this.poll(), 4000);
  private loadedProvider = '';

  shownChats = computed(() => {
    const q = this.q().trim().toLowerCase();
    return q ? this.chats().filter(c => c.title.toLowerCase().includes(q) || (c.last?.text ?? '').toLowerCase().includes(q))
             : this.chats();
  });
  provName = computed(() => PROVIDERS.find(p => p.id === this.provider())?.name ?? this.provider());

  constructor() {
    this.refresh(true);
    effect(() => {
      const p = this.provider();
      untracked(() => this.loadModels(p));
    });
  }

  ngOnDestroy() { clearInterval(this.timer); this.abort?.abort(); }

  refresh(openFirst = false) {
    this.api.list().subscribe({
      next: rows => {
        this.chats.set(rows);
        if (openFirst && !this.openId() && rows.length) this.open(rows[0].id);
      },
      error: () => {},
    });
  }

  loadModels(p: string) {
    if (this.loadedProvider === p) return;
    this.loadedProvider = p;
    this.models.set([]);
    this.api.models(p).subscribe({ next: m => this.models.set(m), error: e => this.error.set(this.msg(e)) });
  }

  open(id: string) {
    if (this.live()) return;
    this.openId.set(id);
    this.error.set(null);
    this.api.get(id).subscribe({
      next: c => {
        this.chat.set(c);
        this.provider.set(c.provider);
        this.model.set(c.model);
        this.scroll();
        setTimeout(() => this.box()?.nativeElement.focus());
      },
      error: e => this.error.set(this.msg(e)),
    });
  }

  newChat() {
    this.api.create().subscribe({
      next: c => { this.chats.update(l => [c, ...l]); this.open(c.id); },
      error: e => this.error.set(this.msg(e)),
    });
  }

  /** Someone else may be talking in it: read it again when it grew. */
  poll() {
    if (this.live() || document.hidden) return;
    this.refresh();
    const c = this.chat();
    if (!c) return;
    const row = this.chats().find(x => x.id === c.id);
    if (row && row.count !== (c.messages?.length ?? 0)) {
      this.api.get(c.id).subscribe({ next: x => { this.chat.set(x); this.scroll(); }, error: () => {} });
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
    if (!c || !title.trim() || title === c.title) return;
    this.api.patch(c.id, { title: title.trim() }).subscribe({ next: () => this.refresh(), error: () => {} });
  }

  remove() {
    const c = this.chat();
    if (!c || !confirm(t('Delete this conversation?'))) return;
    this.api.remove(c.id).subscribe({
      next: () => { this.chat.set(null); this.openId.set(null); this.refresh(true); },
      error: e => this.error.set(this.msg(e)),
    });
  }

  key(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.send(); }
  }

  grow() {
    const el = this.box()?.nativeElement;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 260) + 'px';
  }

  async send() {
    const c = this.chat();
    const text = this.text().trim();
    if (!c || !text || this.live() || !this.model()) return;
    this.error.set(null);
    this.text.set('');
    const el = this.box()?.nativeElement;
    if (el) { el.value = ''; this.grow(); }
    this.live.set({ text: '', thinking: '' });
    this.abort = new AbortController();
    try {
      await this.api.say(c.id, { text, provider: this.provider(), model: this.model() }, this.abort.signal, ev => {
        if (ev.type === 'user' && ev.message) {
          this.chat.update(x => x && { ...x, title: ev.title || x.title, messages: [...(x.messages ?? []), ev.message!] });
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
        }
      });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') this.error.set((e as Error).message);
    } finally {
      this.live.set(null);
      this.abort = null;
      this.refresh();
      // A stopped answer is kept on the server as far as it got.
      this.api.get(c.id).subscribe({ next: x => { if (this.openId() === x.id) { this.chat.set(x); this.scroll(); } }, error: () => {} });
    }
  }

  stop() { this.abort?.abort(); }

  copy(s: string) { navigator.clipboard?.writeText(s); }

  /** Escaped by toHtml, sanitised again by Angular on the way into [innerHTML]. */
  html(src: string): string { return toHtml(src || ''); }
  tail(s: string) { return s.length > 400 ? '…' + s.slice(-400) : s; }
  short(m: string) { return m.includes('/') ? m.split('/').pop()! : m; }
  ctx(n: number) { return n >= 1_000_000 ? `${Math.round(n / 1_000_000)}M` : `${Math.round(n / 1000)}k`; }

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
