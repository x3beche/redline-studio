import { Component, Injectable, inject, output, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { catchError, throwError } from 'rxjs';
import { T } from './i18n';
import { Prefs } from './preferences';

/** Signing in, on the page's side (backend/auth.py).
 *
 *  With sign-in off - local mode - the server says so and the app is as it
 *  always was. With it on, the app waits for a session: a signed-out page
 *  shows the sign-in card, and the very first visit, before anyone has an
 *  account, offers to make the owner's.
 */
export interface Me { type: 'user'; id: string; name: string; email?: string }
export interface AuthState {
  mode: 'off' | 'on';
  needs_setup?: boolean;
  user: Me | null;
  workspace: string | null;
  workspace_name?: string | null;
  /** The role here, and what it allows (backend/access.py). */
  role?: string | null;
  can?: string[];
  roles?: string[];
  about?: Record<string, string>;
  actions?: Record<string, string>;
  token_roles?: string[];
}
export interface Invite { email: string; role: string; by: string | null; workspace: string; has_account: boolean }

@Injectable({ providedIn: 'root' })
export class Auth {
  private http = inject(HttpClient);
  /** Null until the server has said; then whether sign-in is on, and who. */
  state = signal<AuthState | null>(null);
  /** Why the server just refused something, for a few seconds. */
  refused = signal<string | null>(null);
  private refusedTimer?: ReturnType<typeof setTimeout>;

  load() {
    this.http.get<AuthState>('/api/auth/state').subscribe({
      next: s => this.state.set(s),
      // No answer at all: show the app, which says the server is down.
      error: () => this.state.set({ mode: 'off', user: null, workspace: null }),
    });
  }

  /** Whether the app itself may be shown. */
  signedIn(): boolean {
    const s = this.state();
    return !!s && (s.mode === 'off' || !!s.user);
  }

  /** Whether this role may (an action from backend/access.py). Before the
   *  server has said, yes - the server decides anyway. */
  can(action: string): boolean {
    const c = this.state()?.can;
    return !c || c.includes(action);
  }

  /** Why not, in a line for a tooltip; null when it may. */
  why(action: string): string | null {
    if (this.can(action)) return null;
    const s = this.state();
    return `as ${s?.role ?? 'nobody'} you cannot ${s?.actions?.[action] ?? action}`;
  }

  refuse(message: string) {
    this.refused.set(message);
    clearTimeout(this.refusedTimer);
    this.refusedTimer = setTimeout(() => this.refused.set(null), 7000);
  }

  signedOut() {
    const s = this.state();
    if (s?.mode === 'on') this.state.set({ ...s, user: null });
  }

  login(email: string, password: string) {
    return this.http.post<{ user: Me }>('/api/auth/login', { email, password });
  }

  setup(email: string, name: string, password: string) {
    return this.http.post<{ user: Me }>('/api/auth/setup', { email, name, password });
  }

  invite(key: string) { return this.http.get<Invite>(`/api/invite/${encodeURIComponent(key)}`); }

  accept(key: string, name: string, password: string) {
    return this.http.post<{ user: Me }>(`/api/invite/${encodeURIComponent(key)}/accept`, { name, password });
  }

  logout() {
    this.http.post('/api/auth/logout', {}).subscribe({ next: () => this.load(), error: () => this.load() });
  }
}

/** Every change carries the header only this page sends (the server's
 *  guard against another site using the cookie), and a 401 anywhere means
 *  the session is gone: back to the sign-in card. */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(Auth);
  const out = req.method === 'GET' ? req : req.clone({ setHeaders: { 'X-Redline-CSRF': '1' } });
  return next(out).pipe(catchError((e: HttpErrorResponse) => {
    if (e.status === 401 && !req.url.includes('/api/auth/') && !req.url.includes('/api/invite/')) auth.signedOut();
    // A role's refusal (backend/access.py): said once, at the top.
    if (e.status === 403 && e.error?.refused) auth.refuse(e.error.detail);
    return throwError(() => e);
  }));
};

/** The card a signed-out visitor sees - or, before anyone has an account,
 *  the one that makes the owner's. */
@Component({
  selector: 'app-sign-in',
  template: `
<div class="tcv-signin-wrap">
  <form class="tcv-signin" (submit)="$event.preventDefault(); go()">
    <div class="tcv-signin-brand">Redl<span class="brand-i">i</span>ne</div>
    @if (resetFor(); as r) {
      <p class="tcv-signin-lead">Choose a new password for <b>{{ r }}</b>. You are signed in with it at once,
        and signed out everywhere else.</p>
    } @else if (resetGone(); as g) {
      <p class="tcv-signin-error" role="alert">{{ g }}</p>
      <p class="tcv-signin-lead">Sign in, or make a new link on the machine: <code>tools/account.py reset</code>.</p>
    } @else if (invite(); as inv) {
      <p class="tcv-signin-lead">{{ inv.by || 'Someone' }} invited you to <b>{{ inv.workspace }}</b> as
        <b>{{ inv.role }}</b>{{ about(inv.role) }}.
        {{ inv.has_account ? 'Sign in with your password to join.' : 'Choose a name and a password to join.' }}</p>
      @if (!inv.has_account) {
        <label>Name<input [value]="name()" (input)="name.set($any($event.target).value)" autocomplete="name"></label>
      }
      <label>Email<input type="email" [value]="inv.email" disabled autocomplete="username"></label>
    } @else if (inviteGone(); as g) {
      <p class="tcv-signin-error" role="alert">{{ g }}</p>
      <p class="tcv-signin-lead">Sign in if you already have an account.</p>
    } @else if (setup()) {
      <p class="tcv-signin-lead">Nobody has an account yet. Make the first one - it owns this workspace, and
        invites the others.</p>
      <label>Name<input [value]="name()" (input)="name.set($any($event.target).value)" autocomplete="name"></label>
    } @else {
      <p class="tcv-signin-lead">Sign in to continue.</p>
    }
    @if (!invite() && !resetFor()) {
      <label>Email<input type="email" [value]="email()" (input)="email.set($any($event.target).value)"
                         autocomplete="username" required></label>
    }
    <label>Password<input type="password" [value]="password()" (input)="password.set($any($event.target).value)"
                          [attr.autocomplete]="newPassword() ? 'new-password' : 'current-password'" required></label>
    @if (newPassword()) { <p class="tcv-signin-hint">At least 10 characters.</p> }
    @if (error(); as e) { <p class="tcv-signin-error" role="alert">{{ e }}</p> }
    <button class="tcv-btn tcv-btn-accent" type="submit" [disabled]="busy()">
      {{ busy() ? '…' : resetFor() ? 'Set the password' : invite() ? 'Join' : setup() ? 'Make the account' : 'Sign in' }}</button>
  </form>
</div>`,
})
export class SignIn {
  private auth = inject(Auth);
  private http = inject(HttpClient);
  email = signal('');
  name = signal('');
  password = signal('');
  error = signal('');
  busy = signal(false);
  setup = () => !!this.auth.state()?.needs_setup;
  /** An invitation link: /?invite=<key>. */
  private key = new URLSearchParams(location.search).get('invite');
  invite = signal<Invite | null>(null);
  inviteGone = signal<string | null>(null);
  /** A password-reset link: /?reset=<key> (tools/account.py reset). */
  private resetKey = new URLSearchParams(location.search).get('reset');
  resetFor = signal<string | null>(null);
  resetGone = signal<string | null>(null);
  newPassword = () => this.resetFor() ? true : this.invite() ? !this.invite()!.has_account : this.setup();
  about = (role: string) => { const a = this.auth.state()?.about?.[role]; return a ? ` - ${a}` : ''; };

  constructor() {
    if (this.resetKey) {
      this.http.get<{ email: string }>(`/api/reset/${encodeURIComponent(this.resetKey)}`).subscribe({
        next: r => this.resetFor.set(r.email),
        error: (e: HttpErrorResponse) => this.resetGone.set(
          typeof e.error?.detail === 'string' ? e.error.detail : 'this link cannot be opened'),
      });
    }
    if (this.key) {
      this.auth.invite(this.key).subscribe({
        next: i => this.invite.set(i),
        error: (e: HttpErrorResponse) => this.inviteGone.set(
          typeof e.error?.detail === 'string' ? e.error.detail : 'this invitation cannot be opened'),
      });
    }
  }

  go() {
    this.busy.set(true);
    this.error.set('');
    const inv = this.invite();
    const call = this.resetFor() && this.resetKey
      ? this.http.post<{ user: Me }>(`/api/reset/${encodeURIComponent(this.resetKey)}`, { password: this.password() })
      : inv && this.key
      ? this.auth.accept(this.key, this.name(), this.password())
      : this.setup()
      ? this.auth.setup(this.email(), this.name(), this.password())
      : this.auth.login(this.email(), this.password());
    call.subscribe({
      next: () => {
        this.busy.set(false); this.password.set('');
        // The link has done its work: off the address bar.
        if (this.key || this.resetKey) history.replaceState(null, '', location.pathname);
        this.auth.load();
      },
      error: (e: HttpErrorResponse) => {
        this.busy.set(false);
        this.error.set(typeof e.error?.detail === 'string' ? e.error.detail : 'that did not work');
      },
    });
  }
}

export interface AgentToken {
  id: string; name: string; workspace: string; room: string | null; role?: string;
  created_by?: { name?: string }; created_at: string; last_used: string | null; revoked: boolean;
}

/** The agents allowed in, each with its own token: made here, shown once,
 *  taken back here. An agent with a token needs no database password - the
 *  server does its database work for it (backend/agent_api.py). */
@Component({
  selector: 'app-agent-tokens',
  template: `
<div class="tcv-tokens-back" (click)="closed.emit()">
  <div class="tcv-tokens" (click)="$event.stopPropagation()" role="dialog" aria-label="Agent tokens">
    <h2>Agent tokens</h2>
    <p>An agent - Claude Code in a terminal, a script - works in Redline with a token instead of the
      database password. Everything it does is recorded under the name you give it, and taking the token
      back stops it at once.</p>
    <form class="tcv-tokens-new" (submit)="$event.preventDefault(); make()">
      <input placeholder="Name the agent, e.g. pcb-builder" [value]="name()" maxlength="60"
             (input)="name.set($any($event.target).value)">
      <select class="tcv-tokens-role" [value]="role()" (change)="role.set($any($event.target).value)"
              title="What the agent may do">
        @for (r of auth.state()?.token_roles ?? ['editor']; track r) { <option [value]="r" [selected]="r === role()">{{ r }}</option> }
      </select>
      <button class="tcv-btn tcv-btn-accent" type="submit" [disabled]="!name().trim() || busy()">Make token</button>
    </form>
    @if (made(); as m) {
      <div class="tcv-tokens-once">
        <span>The token for <b>{{ m.name }}</b>. It is shown this once - copy it now. Give the agent these lines:</span>
        <code>X3_TRANSPORT=api<br>X3_API={{ origin }}<br>X3_TOKEN={{ m.token }}</code>
        <div class="tcv-tokens-end"><button class="tcv-btn" (click)="copy(m.token)">{{ copied() ? 'Copied' : 'Copy the lines' }}</button></div>
      </div>
    }
    @if (error(); as e) { <p class="tcv-signin-error" role="alert">{{ e }}</p> }
    @for (t of list(); track t.id) {
      <div class="tcv-tokens-row" [attr.data-off]="t.revoked ? '' : null">
        <div><span class="tcv-menu-name">{{ t.name }} <span class="tcv-role">{{ t.role ?? 'editor' }}</span></span>
          <span class="tcv-menu-blurb">made by {{ t.created_by?.name || 'someone' }} {{ ago(t.created_at) }} ·
            {{ t.revoked ? 'taken back' : t.last_used ? 'last used ' + ago(t.last_used) : 'not used yet' }}</span></div>
        @if (!t.revoked) { <button class="tcv-btn" (click)="revoke(t)">Take back</button> }
      </div>
    } @empty { <p>No agent has a token yet.</p> }
    <div class="tcv-tokens-end"><button class="tcv-btn" (click)="closed.emit()">Close</button></div>
  </div>
</div>`,
})
export class AgentTokens {
  private http = inject(HttpClient);
  auth = inject(Auth);
  closed = output<void>();
  list = signal<AgentToken[]>([]);
  name = signal('');
  role = signal('editor');
  made = signal<{ name: string; token: string } | null>(null);
  error = signal('');
  busy = signal(false);
  copied = signal(false);
  origin = location.origin;

  constructor() { this.load(); }

  load() {
    this.http.get<AgentToken[]>('/api/agent-tokens').subscribe({
      next: l => this.list.set(l), error: e => this.error.set(this.say(e)) });
  }

  make() {
    this.busy.set(true);
    this.error.set('');
    this.http.post<AgentToken & { token: string }>('/api/agent-tokens',
                                                   { name: this.name().trim(), role: this.role() }).subscribe({
      next: t => { this.busy.set(false); this.made.set({ name: t.name, token: t.token }); this.copied.set(false);
                   this.name.set(''); this.load(); },
      error: e => { this.busy.set(false); this.error.set(this.say(e)); },
    });
  }

  revoke(t: AgentToken) {
    this.http.delete(`/api/agent-tokens/${t.id}`).subscribe({
      next: () => { if (this.made()?.name === t.name) this.made.set(null); this.load(); },
      error: e => this.error.set(this.say(e)) });
  }

  copy(token: string) {
    navigator.clipboard?.writeText(`X3_TRANSPORT=api\nX3_API=${this.origin}\nX3_TOKEN=${token}\n`)
      .then(() => this.copied.set(true), () => this.error.set('the browser would not copy - select the lines instead'));
  }

  ago(iso: string) {
    const s = (Date.now() - new Date(iso.endsWith('Z') ? iso : iso + 'Z').getTime()) / 1000;
    if (s < 90) return 'just now';
    if (s < 5400) return `${Math.round(s / 60)} min ago`;
    if (s < 129600) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} days ago`;
  }

  private say(e: HttpErrorResponse) { return typeof e.error?.detail === 'string' ? e.error.detail : 'that did not work'; }
}

interface Member { id: string; name: string; email: string; role: string; joined?: string }
interface PendingInvite { id: string; email: string; role: string; by?: { name: string }; created_at: string }

/** The people in the workspace and their roles, and inviting more. Owners
 *  and admins only (backend/access.py). Redline sends no email: an
 *  invitation is a link, shown once, that the inviter passes on. */
@Component({
  selector: 'app-members',
  template: `
<div class="tcv-tokens-back" (click)="closed.emit()">
  <div class="tcv-tokens" (click)="$event.stopPropagation()" role="dialog" aria-label="Members">
    <h2>Members</h2>
    <p>Who works in this workspace, and what each may do. Invite someone with their email address: you get a
      link to send them, good for a week.</p>
    <form class="tcv-tokens-new" (submit)="$event.preventDefault(); invite()">
      <input type="email" placeholder="their@email" [value]="email()" (input)="email.set($any($event.target).value)">
      <select class="tcv-tokens-role" [value]="role()" (change)="role.set($any($event.target).value)">
        @for (r of invitable(); track r) { <option [value]="r" [selected]="r === role()">{{ r }}</option> }
      </select>
      <button class="tcv-btn tcv-btn-accent" type="submit" [disabled]="!email().trim() || busy()">Invite</button>
    </form>
    <p class="tcv-menu-blurb">{{ about(role()) }}</p>
    @if (made(); as m) {
      <div class="tcv-tokens-once">
        <span>Send this link to <b>{{ m.email }}</b> - it is shown this once, and it lets them in as
          <b>{{ m.role }}</b>:</span>
        <code>{{ m.link }}</code>
        <div class="tcv-tokens-end"><button class="tcv-btn" (click)="copy(m.link)">{{ copied() ? 'Copied' : 'Copy the link' }}</button></div>
      </div>
    }
    @if (error(); as e) { <p class="tcv-signin-error" role="alert">{{ e }}</p> }
    @for (m of members(); track m.id) {
      <div class="tcv-tokens-row">
        <div><span class="tcv-menu-name">{{ m.name }}@if (m.id === me()) { <span class="tcv-role">you</span> }</span>
          <span class="tcv-menu-blurb">{{ m.email }}</span></div>
        <select class="tcv-tokens-role" [value]="m.role" [disabled]="!mayChange(m)" [title]="about(m.role)"
                (change)="setRole(m, $any($event.target).value)">
          @for (r of roles(); track r) { <option [value]="r" [selected]="r === m.role" [disabled]="!mayGive(r)">{{ r }}</option> }
        </select>
        @if (m.id !== me() && mayChange(m)) { <button class="tcv-btn" (click)="takeOut(m)">Take out</button> }
      </div>
    }
    @for (i of pending(); track i.id) {
      <div class="tcv-tokens-row" data-off>
        <div><span class="tcv-menu-name">{{ i.email }} <span class="tcv-role">{{ i.role }}</span></span>
          <span class="tcv-menu-blurb">invited by {{ i.by?.name || 'someone' }} · not joined yet</span></div>
        <button class="tcv-btn" (click)="cancel(i)">Cancel</button>
      </div>
    }
    <div class="tcv-tokens-end"><button class="tcv-btn" (click)="closed.emit()">Close</button></div>
  </div>
</div>`,
})
export class Members {
  private http = inject(HttpClient);
  private auth = inject(Auth);
  closed = output<void>();
  members = signal<Member[]>([]);
  pending = signal<PendingInvite[]>([]);
  email = signal('');
  role = signal('editor');
  made = signal<{ email: string; role: string; link: string } | null>(null);
  error = signal('');
  busy = signal(false);
  copied = signal(false);

  roles = () => this.auth.state()?.roles ?? [];
  private rank = (r: string) => { const i = this.roles().indexOf(r); return i < 0 ? 99 : i; };
  private mine = () => this.auth.state()?.role ?? 'viewer';
  me = () => this.auth.state()?.user?.id;
  /** Nobody gives a role above their own; an owner is made from the list. */
  mayGive = (r: string) => this.rank(r) >= this.rank(this.mine());
  mayChange = (m: Member) => this.rank(m.role) >= this.rank(this.mine());
  invitable = () => this.roles().filter(r => r !== 'owner' && this.mayGive(r));
  about = (r: string) => this.auth.state()?.about?.[r] ?? '';

  constructor() { this.load(); }

  load() {
    this.http.get<{ members: Member[]; invites: PendingInvite[] }>('/api/members').subscribe({
      next: d => { this.members.set(d.members); this.pending.set(d.invites); },
      error: e => this.error.set(this.say(e)) });
  }

  invite() {
    this.busy.set(true);
    this.error.set('');
    this.http.post<{ key: string; email: string; role: string }>('/api/invites',
                                                                 { email: this.email().trim(), role: this.role() }).subscribe({
      next: r => {
        this.busy.set(false); this.copied.set(false); this.email.set('');
        this.made.set({ email: r.email, role: r.role, link: `${location.origin}/?invite=${r.key}` });
        this.load();
      },
      error: e => { this.busy.set(false); this.error.set(this.say(e)); },
    });
  }

  setRole(m: Member, role: string) {
    this.error.set('');
    this.http.patch(`/api/members/${m.id}`, { role }).subscribe({
      next: () => { this.load(); if (m.id === this.me()) this.auth.load(); },
      error: e => { this.error.set(this.say(e)); this.load(); } });
  }

  takeOut(m: Member) {
    if (!confirm(`Take ${m.name} out of the workspace? They are signed out at once.`)) return;
    this.http.delete(`/api/members/${m.id}`).subscribe({ next: () => this.load(), error: e => this.error.set(this.say(e)) });
  }

  cancel(i: PendingInvite) {
    this.http.delete(`/api/invites/${i.id}`).subscribe({
      next: () => { if (this.made()?.email === i.email) this.made.set(null); this.load(); },
      error: e => this.error.set(this.say(e)) });
  }

  copy(link: string) {
    navigator.clipboard?.writeText(link)
      .then(() => this.copied.set(true), () => this.error.set('the browser would not copy - select the link instead'));
  }

  private say(e: HttpErrorResponse) { return typeof e.error?.detail === 'string' ? e.error.detail : 'that did not work'; }
}

/** Who is signed in, and signing out - only when sign-in is on. */
@Component({
  selector: 'app-user-chip',
  imports: [AgentTokens, Members, T],
  host: { class: 'relative flex items-center' },
  template: `
@if (auth.state(); as s) {
  @if (s.mode !== 'on') {
    <!-- Nobody signs in on this machine: the preferences on their own. -->
    <button class="tcv-user tcv-user-gear" (click)="prefs.open.set('appearance')" [title]="'Preferences' | t">⚙</button>
  }
  @if (s.mode === 'on' && s.user; as u) {
    <!-- Who you are, and where: your name over the workspace and your
         role in it. The caret says it opens. -->
    <button class="tcv-user" (click)="toggle()" [attr.data-on]="open() ? 1 : null"
            [title]="(u.email ?? u.name) + ' - ' + (s.role ?? '') + ' in ' + (s.workspace_name ?? s.workspace)">
      <span class="tcv-user-dot">{{ initial(u.name) }}</span>
      <span class="tcv-user-text">
        <span class="tcv-user-name">{{ u.name }}</span>
        <span class="tcv-user-ws">{{ s.workspace_name ?? s.workspace }} · {{ s.role }}</span>
      </span>
      <svg class="tcv-user-caret" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4"/></svg>
    </button>
    @if (open()) {
      <div class="tcv-menu tcv-user-menu" (mouseleave)="open.set(false)">
        <div class="tcv-menu-item"><span class="tcv-menu-name">{{ u.name }}</span>
          <span class="tcv-menu-blurb">{{ u.email }} · {{ s.role }} in {{ s.workspace_name ?? s.workspace }}</span></div>
        @if (spaces().length > 1) {
          <div class="tcv-menu-head">{{ 'Workspaces' | t }}</div>
          @for (w of spaces(); track w.id) {
            <button class="tcv-menu-item" (click)="openSpace(w.id)" [disabled]="w.id === s.workspace">
              <span class="tcv-menu-name">{{ w.name }}@if (w.id === s.workspace) { <span class="tcv-role">here</span> }</span>
              <span class="tcv-menu-blurb">{{ w.role }}</span></button>
          }
        }
        @if (auth.can('members')) {
          <button class="tcv-menu-item" (click)="open.set(false); making.set(true)">
            <span class="tcv-menu-name">{{ 'New workspace' | t }}</span>
            <span class="tcv-menu-blurb">Its own projects, members and agents - nothing shared with this one</span></button>
        }
        @if (auth.can('members')) {
          <button class="tcv-menu-item" (click)="open.set(false); members.set(true)">
            <span class="tcv-menu-name">{{ 'Members' | t }}</span>
            <span class="tcv-menu-blurb">{{ 'Invite people and set what each may do' | t }}</span></button>
        }
        @if (auth.can('tokens')) {
          <button class="tcv-menu-item" (click)="open.set(false); tokens.set(true)">
            <span class="tcv-menu-name">{{ 'Agent tokens' | t }}</span>
            <span class="tcv-menu-blurb">Let an agent work here without the database password</span></button>
        }
        <button class="tcv-menu-item" (click)="open.set(false); prefs.open.set('appearance')">
          <span class="tcv-menu-name">{{ 'Preferences' | t }}</span>
          <span class="tcv-menu-blurb">{{ 'Theme, language, keyboard shortcuts' | t }}</span></button>
        <button class="tcv-menu-item" (click)="open.set(false); auth.logout()">
          <span class="tcv-menu-name">{{ 'Sign out' | t }}</span></button>
      </div>
    }
    @if (tokens()) { <app-agent-tokens (closed)="tokens.set(false)"/> }
    @if (members()) { <app-members (closed)="members.set(false)"/> }
    @if (making()) {
      <div class="tcv-tokens-back" (click)="making.set(false)">
        <div class="tcv-tokens" (click)="$event.stopPropagation()" role="dialog" aria-label="New workspace">
          <h2>New workspace</h2>
          <p>An empty workspace with its own projects, notes, boards, apps, members and agent tokens. Nobody in
            this one sees into it, and it does not see into this one; the same names can be used in both.
            You own it, and can invite people to it once you are in it.</p>
          <form class="tcv-tokens-new" (submit)="$event.preventDefault(); makeSpace()">
            <input placeholder="Name, e.g. Customer A" [value]="spaceName()" maxlength="60"
                   (input)="spaceName.set($any($event.target).value)">
            <button class="tcv-btn tcv-btn-accent" type="submit" [disabled]="!spaceName().trim()">Make and open</button>
          </form>
          @if (spaceError(); as e) { <p class="tcv-signin-error" role="alert">{{ e }}</p> }
          <div class="tcv-tokens-end"><button class="tcv-btn" (click)="making.set(false)">Close</button></div>
        </div>
      </div>
    }
  }
}`,
})
export class UserChip {
  auth = inject(Auth);
  prefs = inject(Prefs);
  private http = inject(HttpClient);
  open = signal(false);
  tokens = signal(false);
  members = signal(false);
  making = signal(false);
  spaces = signal<{ id: string; name: string; role: string }[]>([]);
  spaceName = signal('');
  spaceError = signal('');

  toggle() {
    this.open.set(!this.open());
    if (this.open()) {
      this.http.get<{ workspaces: { id: string; name: string; role: string }[] }>('/api/workspaces')
        .subscribe({ next: d => this.spaces.set(d.workspaces), error: () => this.spaces.set([]) });
    }
  }

  /** Into another workspace: everything on the page is the other one's, so
   *  the page starts over - and forgets figures it kept for the last one. */
  openSpace(id: string) {
    this.http.post('/api/workspaces/' + encodeURIComponent(id) + '/open', {}).subscribe({
      next: () => {
        try {
          Object.keys(localStorage).filter(k => k.startsWith('x3.analytics.data.'))
            .forEach(k => localStorage.removeItem(k));
        } catch { /* private window */ }
        location.reload();
      },
      error: (e: HttpErrorResponse) => this.auth.refuse(typeof e.error?.detail === 'string' ? e.error.detail : 'that did not work'),
    });
  }

  makeSpace() {
    this.spaceError.set('');
    this.http.post<{ id: string }>('/api/workspaces', { name: this.spaceName().trim() }).subscribe({
      next: w => this.openSpace(w.id),
      error: (e: HttpErrorResponse) => this.spaceError.set(typeof e.error?.detail === 'string' ? e.error.detail : 'that did not work'),
    });
  }

  initial(n: string) { return (n.trim()[0] ?? '?').toUpperCase(); }
}
