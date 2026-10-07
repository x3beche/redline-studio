import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Auth } from './auth';
import { T, t } from './i18n';
import { when } from './llm-settings';
import { TelegramProfilePanel } from './telegram-profile';
import { Langs, TgLangPicker } from './telegram-langs';

/** Settings > Telegram (backend/tgbot/): one bot for the whole server, and
 *  each person's own link to it.
 *
 *  The top is the server's: a guided setup in five steps, each with its live
 *  status - create the bot with @BotFather, paste its token (checked with
 *  getMe; kept on the server, only its last four characters come back), pick
 *  how updates arrive (a webhook with a secret header, or long polling), link
 *  your own chat, send a test. Changing it is for the owner and the admins.
 *
 *  Under it, everyone's own: link my Telegram (a one-time code, a t.me link
 *  and a QR code, ten minutes), what I hear about (toggle tiles), the
 *  language questions come in, and the bot's commands.
 */
interface Pref { id: string; label: string; about: string }
interface LogRow { at: string; dir: 'in' | 'out'; kind: string; ok: boolean; error: string | null; preview: string | null; user: string | null }
interface TgState {
  bot: { set: boolean; hint: string | null; id: number | null; username: string | null; name: string | null;
         has_avatar: boolean; set_at: string | null; set_by: string | null; url: string | null };
  online: { ok: boolean; at: string; ms?: number; error?: string } | null;
  mode: 'webhook' | 'polling' | null; public_url: string | null; webhook_url: string | null;
  webhook: { url: string | null; pending_update_count: number | null; last_error_date: number | null;
             last_error_message: string | null; ip_address: string | null } | null;
  webhook_ok: boolean | null; last_update_at: string | null;
  last_error: { at: string; text: string } | null;
  stats: { sent: number; failed: number; received: number; days: number };
  linked: number; queue: number;
  me: { linked: boolean; chat?: number; username?: string | null; name?: string | null; linked_at?: string;
        prefs?: Record<string, boolean>; lang?: string | null; blocked?: boolean; code_pending?: boolean };
  prefs: Pref[]; commands: { command: string; about: string }[];
  can_edit: boolean; log?: LogRow[];
  profile: { name: boolean; description: boolean; short_description: boolean; photo: boolean } | null;
  /** Step 3's Save was pressed (cleared by a new token). */
  profile_done?: { at: string; by?: string } | null;
}
interface LinkCode { code: string; url: string; expires: string; minutes: number; qr: string; bot: string }

/** What the page shows before the server answers /api/telegram (an older
 *  API without the Telegram routes): a bot not set up yet. Marked, so the
 *  page says it is a preview. */
const STUB: TgState = {
  bot: { set: false, hint: null, id: null, username: null, name: null, has_avatar: false, set_at: null, set_by: null, url: null },
  online: null, mode: null, public_url: null, webhook_url: null, webhook: null, webhook_ok: null,
  last_update_at: null, last_error: null, stats: { sent: 0, failed: 0, received: 0, days: 7 }, linked: 0, queue: 0,
  me: { linked: false },
  prefs: [
    { id: 'question', label: 'An agent asks a question', about: 'answer with buttons or in your own words' },
    { id: 'note', label: 'A note is applied or fails', about: 'with its after picture when there is one' },
    { id: 'run', label: 'A run starts', about: 'an agent picks up a note' },
    { id: 'budget', label: 'Budget warnings', about: 'a monthly budget crosses its warning or 100%' },
    { id: 'build', label: 'A build fails', about: 'a model build, a board layout or convert' },
    { id: 'digest', label: 'Daily digest', about: 'every morning, 09:00 Istanbul: the day in six numbers' },
  ],
  commands: [
    { command: 'note', about: 'a draft note on a model or board' }, { command: 'queue', about: 'queue the last draft note' },
    { command: 'ask', about: "write to the agent's thread" }, { command: 'status', about: 'what is working now' },
    { command: 'lang', about: 'the language questions come in' }, { command: 'help', about: 'what the bot can do' },
    { command: 'stop', about: 'unlink this chat' },
  ],
  can_edit: true, log: [], profile: null,
};
const DEFAULT_PREFS: Record<string, boolean> = { question: true, note: true, run: false, budget: false, build: false, digest: false };

/** The one thing done in @BotFather: making the bot, which gives the token.
 *  Its name, descriptions, picture and commands are set here afterwards. */
const FATHER = [
  { cmd: '/newbot', what: 'Send it to @BotFather. It asks for a display name (Redline), then a username that ends in "bot" (redline_studio_bot), and answers with the token.' },
];

@Component({
  selector: 'app-telegram-settings',
  imports: [T, TelegramProfilePanel, TgLangPicker],
  styleUrls: ['./settings.css', './telegram-settings.css'],
  template: `
@if (s(); as d) {
<div class="st-page">
  <p class="st-lead">{{ 'A Telegram bot for the whole server: the agents\\' questions reach people on their phones, and answers, notes and messages come back the same way. The token stays on the server - once saved, only its last four characters are shown.' | t }}</p>
  @if (stub()) { <div class="st-banner">{{ 'Preview - the server has no Telegram routes yet, so this shows a bot that is not set up.' | t }}</div> }
  @if (!d.can_edit) { <div class="st-banner">{{ 'Only the owner and the admins set up the bot. Linking your own Telegram is for everyone.' | t }}</div> }

  <div class="st-tiles">
    <div class="st-tile" [attr.data-tone]="!d.bot.set ? 'dim' : d.online?.ok === false ? 'danger' : 'ok'"><span>{{ 'Bot' | t }}</span>
      <b>{{ !d.bot.set ? ('not set' | t) : d.online?.ok === false ? ('offline' | t) : ('online' | t) }}</b>
      <small>{{ d.bot.username ? '@' + d.bot.username : ('no token yet' | t) }}</small></div>
    <div class="st-tile" [attr.data-tone]="updatesTone()"><span>{{ 'Updates' | t }}</span>
      <b>{{ updatesLabel() | t }}</b>
      <small>{{ d.mode === 'webhook' ? (d.webhook?.pending_update_count ?? 0) + ' ' + ('waiting' | t) : d.mode === 'polling' ? ('Redline asks Telegram' | t) : ('choose in step 4' | t) }}</small></div>
    <div class="st-tile"><span>{{ 'Linked people' | t }}</span><b>{{ d.linked }}</b>
      <small>{{ d.me.linked ? ('you included' | t) : ('you are not linked' | t) }}</small></div>
    <div class="st-tile"><span>{{ 'Sent' | t }} · {{ d.stats.days }}{{ 'd' }}</span><b>{{ d.stats.sent }}</b>
      <small>{{ d.stats.failed }} {{ 'failed' | t }} · {{ d.queue }} {{ 'queued' | t }}</small></div>
    <div class="st-tile"><span>{{ 'Received' | t }} · {{ d.stats.days }}{{ 'd' }}</span><b>{{ d.stats.received }}</b>
      <small>{{ d.last_update_at ? ('last' | t) + ' ' + when(d.last_update_at) : ('nothing yet' | t) }}</small></div>
    <div class="st-tile" [attr.data-tone]="d.last_error ? 'warn' : 'dim'"><span>{{ 'Last error' | t }}</span>
      <b [title]="d.last_error?.text || ''">{{ d.last_error ? when(d.last_error.at) : ('none' | t) }}</b>
      <small [title]="d.last_error?.text || ''">{{ d.last_error?.text || ('all quiet' | t) }}</small></div>
  </div>

  <!-- ---------------- the guide ---------------- -->
  <div class="st-card">
    <div class="st-card-head"><h3>{{ 'Set up the bot' | t }}</h3>
      <span class="st-sub">{{ 'six steps, each checked live' | t }}</span>
      <div class="st-right tg-progress">
        <span class="mono">{{ doneCount() }} / {{ steps().length }}</span>
        <div class="st-meter tg-meter"><i [style.width.%]="doneCount() * 100 / steps().length"></i></div>
      </div></div>
    <ol class="tg-steps">
      @for (st of steps(); track st.n) {
        <li class="tg-step" [attr.data-state]="st.state" [attr.data-open]="open() === st.n ? 1 : null">
          <button class="tg-step-head" (click)="toggle(st.n)" [attr.aria-expanded]="open() === st.n">
            <span class="tg-num">{{ st.state === 'done' ? '✓' : st.n }}</span>
            <span class="tg-step-text"><b>{{ st.title | t }}</b><span>{{ st.sub | t }}</span></span>
            <span class="st-badge" [attr.data-tone]="st.state === 'done' ? 'ok' : st.state === 'now' ? 'accent' : null">{{ (st.state === 'done' ? 'done' : st.state === 'now' ? 'next' : 'to do') | t }}</span>
            <span class="tg-chev" aria-hidden="true">{{ open() === st.n ? '▾' : '▸' }}</span>
          </button>
          @if (st.n === 3 && open() !== 3 && d.bot.set && d.can_edit) {
            <button class="tg-step-tip" (click)="toggle(3)"><b>✎</b>{{ 'You can change the bot\\'s name, descriptions and picture from here any time.' | t }}</button>
          }
          @if (open() === st.n) {
            <div class="tg-step-body">
              @switch (st.n) {
                @case (1) {
                  <p class="st-hint">{{ 'Open @BotFather in Telegram - Telegram\\'s own bot for making bots - and make a new one. That is all BotFather is needed for: the name, descriptions, picture and commands are set here, in step 3.' | t }}</p>
                  <div class="tg-cmds">
                    @for (f of father; track f.cmd) {
                      <div class="tg-cmd">
                        <div class="tg-cmd-top"><code>{{ f.cmd }}</code>
                          <button class="tg-copy" (click)="copy(f.cmd)">{{ copied() === f.cmd ? ('copied' | t) : ('copy' | t) }}</button></div>
                        <span>{{ f.what | t }}</span>
                      </div>
                    }
                  </div>
                  <div class="st-row">
                    <a class="tcv-btn tcv-files-btn tg-a" href="https://t.me/BotFather" target="_blank" rel="noopener">{{ 'Open @BotFather' | t }} ↗</a>
                    <span class="st-sub">{{ 'Its last message holds the token: 123456789:AA… Keep it secret; paste it in step 2.' | t }}</span>
                  </div>
                }
                @case (2) {
                  @if (d.bot.set) {
                    <div class="tg-bot">
                      @if (d.bot.has_avatar && !stub()) { <img class="tg-ava" src="/api/telegram/avatar" alt=""> }
                      @else { <span class="tg-ava tg-ava-none" aria-hidden="true">{{ (d.bot.name || '?').slice(0, 1) }}</span> }
                      <div class="tg-bot-text"><b>{{ d.bot.name }}</b>
                        <a class="st-link mono" [href]="d.bot.url" target="_blank" rel="noopener">&#64;{{ d.bot.username }} ↗</a>
                        <span class="st-sub">{{ 'token' | t }} <span class="mono">{{ d.bot.hint }}</span> · {{ 'saved' | t }} {{ when(d.bot.set_at) }}{{ d.bot.set_by ? ' · ' + d.bot.set_by : '' }}</span></div>
                      <span class="st-badge" [attr.data-tone]="d.online?.ok === false ? 'danger' : 'ok'">● {{ (d.online?.ok === false ? 'offline' : 'getMe ok') | t }}{{ d.online?.ms ? ' · ' + d.online?.ms + ' ms' : '' }}</span>
                    </div>
                  }
                  @if (d.can_edit) {
                    <div class="st-row">
                      <input class="st-in wide" type="password" autocomplete="off" [placeholder]="(d.bot.set ? 'Replace the token' : 'Paste the token from @BotFather') | t"
                             [value]="token()" (input)="token.set($any($event.target).value)" (keydown.enter)="saveToken()">
                      <button class="tcv-btn tcv-files-btn" [disabled]="!token().trim() || busy()" (click)="saveToken()">{{ busy() === 'token' ? '…' : ('Check & save' | t) }}</button>
                      @if (d.bot.set) {
                        <button class="tcv-btn tcv-files-btn" [disabled]="!!busy()" (click)="check()">{{ busy() === 'check' ? '…' : ('Check now' | t) }}</button>
                      }
                    </div>
                    <p class="st-hint">{{ 'Checked with Telegram (getMe) before it is kept. A token of another bot unlinks everyone: their chats were with the old bot.' | t }}</p>
                  }
                }
                @case (3) {
                  @if (d.bot.set && !stub()) {
                    <app-telegram-profile [canEdit]="d.can_edit" (changed)="load()" (saved)="profileSaved()" />
                  } @else { <p class="st-hint">{{ 'Once the token is saved, set the bot\'s name, description, short description and picture here.' | t }}</p> }
                }
                @case (4) {
                  <div class="tg-choices">
                    <button class="tg-choice" [attr.data-on]="d.mode === 'webhook' ? 1 : null" [disabled]="!d.can_edit || !d.bot.set || !!busy()" (click)="setMode('webhook')">
                      <span class="tg-choice-top"><b>{{ 'Webhook' | t }}</b><span class="st-badge" data-tone="accent">{{ 'recommended' | t }}</span></span>
                      <span>{{ 'Telegram calls Redline the moment something arrives. Needs the public https address; each call carries a secret header, and anything without it is refused.' | t }}</span>
                      <code class="tg-url">{{ webhookPreview() }}</code>
                    </button>
                    <button class="tg-choice" [attr.data-on]="d.mode === 'polling' ? 1 : null" [disabled]="!d.can_edit || !d.bot.set || !!busy()" (click)="setMode('polling')">
                      <span class="tg-choice-top"><b>{{ 'Long polling' | t }}</b><span class="st-badge">{{ 'fallback' | t }}</span></span>
                      <span>{{ 'Redline keeps asking Telegram for news. Works behind any firewall, with no public address - one server at a time.' | t }}</span>
                      <code class="tg-url">getUpdates · timeout 25 s</code>
                    </button>
                  </div>
                  <div class="st-row">
                    <span class="st-sec-title">{{ 'Public address' | t }}</span>
                    <input class="st-in wide" [disabled]="!d.can_edit" [value]="publicUrl()" (input)="publicUrl.set($any($event.target).value)" placeholder="https://redline.example.com">
                    @if (d.can_edit && publicUrl() !== (d.public_url || '')) {
                      <button class="tcv-btn tcv-files-btn" [disabled]="!!busy()" (click)="savePublicUrl()">{{ 'Save' | t }}</button>
                    }
                    @if (d.mode) {
                      <button class="tcv-btn tcv-files-btn" [disabled]="!d.can_edit || !!busy()" (click)="setMode('off')">{{ 'Stop updates' | t }}</button>
                    }
                  </div>
                  <p class="st-hint">{{ 'The links in messages point here too, back to the note or the model.' | t }}</p>
                  @if (d.mode === 'webhook') {
                    <div class="st-tiles tight">
                      <div class="st-tile" [attr.data-tone]="d.webhook_ok ? 'ok' : 'warn'"><span>{{ 'getWebhookInfo' }}</span><b>{{ (d.webhook_ok ? 'OK' : 'check') | t }}</b>
                        <small [title]="d.webhook?.url || ''">{{ d.webhook?.url || ('not registered' | t) }}</small></div>
                      <div class="st-tile"><span>{{ 'Waiting updates' | t }}</span><b>{{ d.webhook?.pending_update_count ?? '–' }}</b><small>{{ d.webhook?.ip_address || '' }}</small></div>
                      <div class="st-tile" [attr.data-tone]="d.webhook?.last_error_message ? 'warn' : 'dim'" style="grid-column: span 2"><span>{{ 'Telegram\\'s last delivery error' | t }}</span>
                        <b [title]="d.webhook?.last_error_message || ''">{{ d.webhook?.last_error_message || ('none' | t) }}</b>
                        <small>{{ d.webhook?.last_error_date ? when(d.webhook!.last_error_date! * 1000) : '' }}</small></div>
                    </div>
                  }
                }
                @case (5) {
                  <p class="st-hint">{{ 'Every account links its own chat, below in "Your Telegram": a one-time code, good for ten minutes. In Telegram they work in their own private space, as in the app; a disabled account is nobody to the bot.' | t }}</p>
                  <div class="st-row">
                    <span class="st-badge" [attr.data-tone]="d.linked ? 'ok' : null">{{ d.linked }} {{ 'linked' | t }}</span>
                    @if (!d.me.linked) { <button class="tcv-btn tcv-files-btn" [disabled]="!d.bot.set || !!busy()" (click)="makeCode()">{{ 'Link my Telegram' | t }}</button> }
                  </div>
                }
                @case (6) {
                  <p class="st-hint">{{ 'Sends a message - with a picture, so sendPhoto is tried as well - to your own linked chat, now, and says what Telegram answered.' | t }}</p>
                  <div class="st-row">
                    <div class="st-seg">
                      <button [class.on]="testPhoto()" (click)="testPhoto.set(true)">{{ 'with a picture' | t }}</button>
                      <button [class.on]="!testPhoto()" (click)="testPhoto.set(false)">{{ 'text only' | t }}</button>
                    </div>
                    <button class="tcv-btn tcv-files-btn" [disabled]="!d.me.linked || !!busy()" (click)="test()">{{ busy() === 'test' ? '…' : ('Send me a test' | t) }}</button>
                    @if (!d.me.linked) { <span class="st-sub">{{ 'link your Telegram first (step 5)' | t }}</span> }
                    @if (testResult(); as r) {
                      <span [class.st-ok]="r.ok" [class.st-err]="!r.ok" class="mono">{{ r.ok ? '✓ ' + ('delivered' | t) + ' · ' + r.ms + ' ms' : '✕ ' + (r.error || '') }}</span>
                    }
                  </div>
                }
              }
            </div>
          }
        </li>
      }
    </ol>
  </div>

  <div class="tg-split">
    <!-- ---------------- your own link ---------------- -->
    <div class="st-card" id="tg-me">
      <div class="st-card-head"><h3>{{ 'Your Telegram' | t }}</h3>
        <span class="st-sub">{{ 'just you - nobody else\\'s notifications change' | t }}</span>
        <div class="st-right">
          <span class="st-badge" [attr.data-tone]="d.me.linked ? (d.me.blocked ? 'warn' : 'ok') : null">{{ (d.me.linked ? (d.me.blocked ? 'bot blocked' : 'linked') : 'not linked') | t }}</span>
        </div></div>
      <div class="st-card-body">
        @if (d.me.linked) {
          <div class="tg-bot">
            <span class="tg-ava tg-ava-none" aria-hidden="true">{{ (d.me.name || d.me.username || '?').slice(0, 1) }}</span>
            <div class="tg-bot-text"><b>{{ d.me.name || ('Telegram chat' | t) }}</b>
              <span class="mono st-dim">{{ d.me.username ? '@' + d.me.username : 'chat ' + d.me.chat }}</span>
              <span class="st-sub">{{ 'linked' | t }} {{ when(d.me.linked_at) }}</span></div>
            <button class="tcv-btn tcv-files-btn" [disabled]="!!busy()" (click)="unlinkMe()">{{ 'Unlink' | t }}</button>
          </div>
          @if (d.me.blocked) { <p class="st-err">{{ 'Telegram says you blocked the bot. Open it and press Start (or send anything) to hear from it again.' | t }}</p> }
          <div class="st-row">
            <span class="st-sec-title">{{ 'Questions in' | t }}</span>
            <app-tg-lang-picker [label]="d.me.lang ? langs.label(d.me.lang) : ('English (original)' | t)" [current]="d.me.lang || null"
                                top="en" [topLabel]="'English (original)'" [exclude]="['en']" [disabled]="!!busy()" (picked)="setLang($event)" />
            <span class="st-sub">{{ 'translated by the Reading translation job; buttons answer with the agent\\'s own words' | t }}</span>
          </div>
        } @else if (code(); as c) {
          <div class="tg-code">
            <img class="tg-qr" [src]="c.qr" [alt]="'QR code for the link' | t">
            <div class="tg-code-text">
              <span class="st-sec-title">{{ 'Your code' | t }}</span>
              <b class="tg-code-big mono">{{ c.code }}</b>
              <span class="st-sub">{{ 'good for' | t }} <span class="mono">{{ left() }}</span> · {{ 'once' | t }}</span>
              <div class="st-row">
                <a class="tcv-btn tcv-files-btn tg-a" [href]="c.url" target="_blank" rel="noopener">{{ 'Open in Telegram' | t }} ↗</a>
                <button class="tg-copy" (click)="copy('/start ' + c.code)">{{ copied() === '/start ' + c.code ? ('copied' | t) : ('copy /start code' | t) }}</button>
              </div>
              <p class="st-hint">{{ 'On your phone: scan the code. On this computer: open the link. Telegram opens the bot - press Start, and this card turns green by itself.' | t }}</p>
            </div>
          </div>
        } @else {
          <div class="tg-cta">
            <span class="tg-cta-ico" aria-hidden="true">✈</span>
            <div class="tg-cta-text"><b>{{ 'Get the agents\\' questions on your phone' | t }}</b>
              <span>{{ 'Answer them with a tap, send a photo as a note, or write to the agent - from Telegram.' | t }}</span></div>
            <button class="tcv-btn tcv-files-btn" [disabled]="!d.bot.set || !!busy() || stub()" (click)="makeCode()">{{ 'Link my Telegram' | t }}</button>
          </div>
          @if (!d.bot.set) { <p class="st-hint">{{ 'The bot is not set up yet - once an admin finishes step 2, the button works.' | t }}</p> }
        }
      </div>
    </div>

    <!-- ---------------- the commands ---------------- -->
    <div class="st-card">
      <div class="st-card-head"><h3>{{ 'In the chat' | t }}</h3><span class="st-sub">{{ 'what the bot understands' | t }}</span></div>
      <div class="st-list-body">
        @for (c of d.commands; track c.command) {
          <div class="st-short"><span>{{ c.about | t }}</span><span class="st-kbd"><kbd>/{{ c.command }}</kbd></span></div>
        }
        <div class="st-short"><span>{{ 'A photo with a caption: a note with that picture' | t }}</span><span class="st-kbd"><kbd>📷</kbd></span></div>
        <div class="st-short"><span>{{ 'Anything else: it asks - note, ask the agent, or ignore' | t }}</span><span class="st-kbd"><kbd>…</kbd></span></div>
      </div>
    </div>
  </div>

  <!-- ---------------- what I hear about ---------------- -->
  <div class="st-card">
    <div class="st-card-head"><h3>{{ 'Notify me when' | t }}</h3>
      <span class="st-sub">{{ d.me.linked ? ('tap a tile to switch it' | t) : ('link your Telegram to choose' | t) }}</span>
      <span class="st-right st-sub mono">{{ onCount() }} / {{ d.prefs.length }}</span></div>
    <div class="st-card-body">
      <div class="tg-toggles">
        @for (p of d.prefs; track p.id) {
          <button class="tg-toggle" [attr.data-on]="prefOn(p.id) ? 1 : null" [disabled]="!d.me.linked || !!busy()" (click)="flip(p.id)" [attr.aria-pressed]="prefOn(p.id)">
            <span class="tg-toggle-top"><b>{{ p.label | t }}</b><i class="tg-switch" aria-hidden="true"></i></span>
            <span>{{ p.about | t }}</span>
          </button>
        }
      </div>
    </div>
  </div>

  @if (d.can_edit) {
    <div class="st-card">
      <div class="st-card-head"><h3>{{ 'Recent traffic' | t }}</h3><span class="st-sub">{{ 'kept 30 days' | t }}</span></div>
      @if (d.log?.length) {
        <div class="st-table-wrap"><table class="st-table">
          <thead><tr><th>{{ 'when' | t }}</th><th></th><th>{{ 'kind' | t }}</th><th>{{ 'what' | t }}</th></tr></thead>
          <tbody>
            @for (r of d.log; track $index) {
              <tr><td class="dim mono">{{ when(r.at) }}</td>
                <td><span class="st-tag" [attr.data-tone]="!r.ok ? 'danger' : r.dir === 'in' ? 'accent' : 'ok'">{{ r.dir === 'in' ? '← in' : '→ out' }}</span></td>
                <td class="mono">{{ r.kind }}</td><td class="give" [title]="r.error || r.preview || ''">{{ r.error || r.preview }}</td></tr>
            }
          </tbody></table></div>
      } @else { <div class="st-empty">{{ 'No messages yet.' | t }}</div> }
    </div>
  }
  @if (d.can_edit && d.bot.set) {
    <div class="st-card tg-danger" id="tg-remove">
      <div class="st-card-head"><h3>{{ 'Remove the bot' | t }}</h3>
        <span class="st-sub">{{ 'disconnect @' + d.bot.username + ' from Redline' }}</span></div>
      <div class="st-card-body">
        <p class="st-hint">{{ 'Every linked chat is told the bot was disconnected, then unlinked. The webhook is taken down and what waits there is dropped; the token, the secret, the codes and the unsent messages are forgotten.' | t }}</p>
        <p class="st-hint"><b>{{ 'The bot itself still exists on Telegram.' | t }}</b> {{ 'To delete it there, send /deletebot to @BotFather - Redline cannot do that.' | t }}</p>
        <div class="st-row">
          <label class="tg-check"><input type="checkbox" [checked]="forget()" (change)="forget.set($any($event.target).checked)">
            {{ 'Forget everything: the message log and the counters too' | t }}</label>
          <button class="tcv-btn tcv-files-btn tg-danger-btn" [disabled]="!!busy()" (click)="removeBot()">{{ busy() === 'remove' ? '…' : ('Remove the bot' | t) }}</button>
        </div>
      </div>
    </div>
  }
  @if (msg(); as m) { <p class="st-msg">{{ m }}</p> }
  @if (err(); as e) { <p class="st-err">{{ e }}</p> }
</div>
} @else {
  <div class="st-page"><p class="st-lead">{{ err() || ('Loading…' | t) }}</p></div>
}`,
})
export class TelegramSettingsPanel implements OnDestroy {
  private http = inject(HttpClient);
  readonly canEdit = inject(Auth).can('settings');
  readonly when = when;
  readonly father = FATHER;
  readonly langs = inject(Langs);
  s = signal<TgState | null>(null);
  stub = signal(false);
  open = signal<number | null>(null);
  token = signal('');
  publicUrl = signal('');
  busy = signal<string | null>(null);
  copied = signal<string | null>(null);
  code = signal<LinkCode | null>(null);
  now = signal(Date.now());
  testPhoto = signal(true);
  testResult = signal<{ ok: boolean; ms: number; error?: string | null } | null>(null);
  msg = signal<string | null>(null);
  err = signal<string | null>(null);
  private timer: ReturnType<typeof setInterval> | null = null;
  private poll = 0;

  constructor() { this.load(true); }
  ngOnDestroy() { if (this.timer) clearInterval(this.timer); }

  load(first = false) {
    this.http.get<TgState>('/api/telegram').subscribe({
      next: d => this.take(d, first),
      error: e => {
        if (e?.status === 404 || e?.status === 405) { this.stub.set(true); this.take(STUB, first); }
        else this.err.set(this.text(e));
      },
    });
  }

  private take(d: TgState, first = false) {
    this.s.set(d);
    if (first || !this.publicUrl()) this.publicUrl.set(d.public_url || location.origin);
    if (d.me.linked && this.code()) { this.code.set(null); this.flash(t('Linked.')); }
    if (first) this.open.set(this.steps().find(x => x.state === 'now')?.n ?? null);
  }

  /** The five steps and where each one stands. */
  steps = computed(() => {
    const d = this.s();
    const done = [
      !!d?.bot.set,
      !!d?.bot.set,
      !!d?.bot.set && !!d?.profile_done,
      !!d?.mode && (d.mode === 'polling' || !!d.webhook_ok),
      (d?.linked ?? 0) > 0,
      (d?.stats.sent ?? 0) > 0,
    ];
    const first = done.indexOf(false);
    const meta = [
      { title: 'Create the bot with @BotFather', sub: 'only /newbot - it gives the token' },
      { title: 'Paste its token', sub: 'checked with getMe; only the last four characters are shown again' },
      { title: 'Name and picture', sub: 'name, description, short description, picture - per language, from here' },
      { title: 'Choose how updates arrive', sub: 'a webhook with a secret header, or long polling' },
      { title: 'Link your Telegram', sub: 'every account links its own chat, with a one-time code' },
      { title: 'Send a test message', sub: 'to your own chat, with a picture' },
    ];
    return meta.map((m, i) => ({ n: i + 1, ...m, state: done[i] ? 'done' : i === first ? 'now' : 'todo' }));
  });
  doneCount = computed(() => this.steps().filter(x => x.state === 'done').length);
  /** Step 3 saved: fold it and open what is next. */
  profileSaved() {
    setTimeout(() => this.open.set(this.steps().find(x => x.state === 'now')?.n ?? null), 900);
  }
  toggle(n: number) { this.open.set(this.open() === n ? null : n); }

  updatesLabel() {
    const d = this.s()!;
    if (!d.mode) return 'not chosen';
    if (d.mode === 'polling') return 'polling';
    return d.webhook_ok ? 'webhook OK' : 'webhook ?';
  }
  updatesTone() {
    const d = this.s()!;
    return !d.mode ? 'dim' : d.mode === 'polling' || d.webhook_ok ? 'ok' : 'warn';
  }
  webhookPreview() { return (this.publicUrl() || location.origin).replace(/\/+$/, '') + '/api/telegram/webhook'; }
  prefOn(id: string) { const p = this.s()?.me.prefs; return p ? !!p[id] : DEFAULT_PREFS[id]; }
  onCount() { return (this.s()?.prefs ?? []).filter(p => this.prefOn(p.id)).length; }
  left() {
    const c = this.code();
    if (!c) return '';
    const s = Math.max(0, Math.round((new Date(c.expires).getTime() - this.now()) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  copy(text: string) {
    navigator.clipboard?.writeText(text).then(() => {
      this.copied.set(text);
      setTimeout(() => { if (this.copied() === text) this.copied.set(null); }, 1500);
    }).catch(() => undefined);
  }

  saveToken() {
    const v = this.token().trim();
    if (!v) return;
    this.call('token', this.http.put<TgState>('/api/telegram/token', { token: v }), t('Token checked and saved.'),
      () => { this.token.set(''); this.open.set(3); });
  }
  forget = signal(false);
  removeBot() {
    const d = this.s()!;
    const what = t('Remove @{bot} from Redline? Every linked chat is told and unlinked, and the token is forgotten.').replace('{bot}', d.bot.username ?? '')
      + (this.forget() ? '\n\n' + t('The message log and the counters are deleted too.') : '');
    if (!confirm(what)) return;
    this.call('remove', this.http.delete<TgState>(`/api/telegram/bot?forget=${this.forget()}`), t('The bot is removed from Redline.'),
      () => { this.open.set(1); this.code.set(null); this.testResult.set(null); });
  }
  check() { this.call('check', this.http.get<TgState>('/api/telegram/check'), t('Asked Telegram just now.')); }
  setMode(mode: 'webhook' | 'polling' | 'off') {
    this.call('mode', this.http.put<TgState>('/api/telegram/mode', { mode, public_url: this.publicUrl() || null }),
      mode === 'webhook' ? t('Webhook registered.') : mode === 'polling' ? t('Long polling on.') : t('Updates stopped.'));
  }
  savePublicUrl() { this.call('url', this.http.put<TgState>('/api/telegram/settings', { public_url: this.publicUrl() || null }), t('Saved.')); }

  makeCode() {
    this.busy.set('code');
    this.http.post<LinkCode>('/api/telegram/link', {}).subscribe({
      next: c => {
        this.busy.set(null);
        this.code.set(c);
        document.getElementById('tg-me')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (this.timer) clearInterval(this.timer);
        this.timer = setInterval(() => {
          this.now.set(Date.now());
          if (this.now() > new Date(c.expires).getTime()) { this.code.set(null); clearInterval(this.timer!); this.timer = null; return; }
          if (++this.poll % 3 === 0) this.load();
          if (!this.code()) { clearInterval(this.timer!); this.timer = null; }
        }, 1000);
      },
      error: e => { this.busy.set(null); this.err.set(this.text(e)); },
    });
  }
  unlinkMe() {
    if (!confirm(t('Unlink your Telegram? Nothing more is sent to it.'))) return;
    this.call('unlink', this.http.delete<TgState>('/api/telegram/link'), t('Unlinked.'));
  }
  flip(id: string) { this.call('pref', this.http.put<TgState>('/api/telegram/me', { prefs: { [id]: !this.prefOn(id) } })); }
  setLang(id: string) { this.call('pref', this.http.put<TgState>('/api/telegram/me', { lang: id })); }
  test() {
    this.busy.set('test');
    this.testResult.set(null);
    this.http.post<{ ok: boolean; ms: number; error?: string | null }>('/api/telegram/me/test', { photo: this.testPhoto() }).subscribe({
      next: r => { this.busy.set(null); this.testResult.set(r); this.load(); },
      error: e => { this.busy.set(null); this.testResult.set({ ok: false, ms: 0, error: this.text(e) }); },
    });
  }

  private call(what: string, req: import('rxjs').Observable<TgState>, ok?: string, after?: () => void) {
    this.busy.set(what);
    this.err.set(null);
    req.subscribe({
      next: d => { this.busy.set(null); this.take(d); if (ok) this.flash(ok); after?.(); },
      error: e => { this.busy.set(null); this.err.set(this.text(e)); },
    });
  }
  private flash(m: string) { this.msg.set(m); setTimeout(() => this.msg.set(null), 3000); }
  private text(e: unknown): string {
    const err = e as { error?: { detail?: unknown }; message?: string };
    return typeof err?.error?.detail === 'string' ? err.error.detail : (err?.message ?? t('Something went wrong.'));
  }
}
