import { Component, Injectable, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { HttpClient, HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { catchError, throwError } from 'rxjs';
import { T, t } from './i18n';
import { Prefs } from './preferences';
import { Avatar } from './avatar';

/** Signing in, on the page's side (backend/auth.py).
 *
 *  With sign-in off - local mode - the server says so and the app is as it
 *  always was. With it on, the app waits for a session: a signed-out page
 *  shows the sign-in card, and the very first visit, before anyone has an
 *  account, offers to make the owner's. Nobody signs themselves up: the
 *  owner and the admins add accounts (admin-users.ts). An account whose
 *  password an admin set chooses its own before anything else.
 */
export interface Me { type: 'user'; id: string; name: string; email?: string; has_avatar?: boolean; avatar_v?: number | null; avatar_colour?: string }
export interface AuthState {
  mode: 'off' | 'on';
  needs_setup?: boolean;
  user: Me | null;
  /** The system role - owner, admin or user - and what it allows
   *  (backend/access.py). An agent's page session: its token's role. */
  role?: string | null;
  can?: string[];
  roles?: string[];
  about?: Record<string, string>;
  actions?: Record<string, string>;
  token_roles?: string[];
  /** An admin set the password: a new one before anything else. */
  must_change_password?: boolean;
}

/** An account this browser remembers (backend/accounts.py). `live` is
 *  false once its token is gone - revoked, expired, the account disabled:
 *  the row then signs in with the password again. */
export interface SavedAccount {
  id: string; name: string; email: string;
  has_avatar: boolean; avatar_v: number | null; avatar_colour: string;
  live: boolean; current: boolean;
}

/** What the sign-in card opens on after a reload (one tab only): the
 *  password form to add an account, or one account's, to sign in again. */
const SIGNIN_NEXT = 'redline.signin.next';

/** Browser-kept copies of one account's data, dropped whenever who is
 *  signed in changes: nothing of one account is shown to the next. */
const ACCOUNT_KEYS = ['redline.analytics.data.', 'redline.settings.proxy.lastTest', 'redline.thread.seen',
  'redline.lastView'];

function forgetAccountData() {
  try {
    for (const k of Object.keys(localStorage)) {
      if (ACCOUNT_KEYS.some(p => k.startsWith(p))) localStorage.removeItem(k);
    }
  } catch { /* private window */ }
}

@Injectable({ providedIn: 'root' })
export class Auth {
  private http = inject(HttpClient);
  /** Null until the server has said; then whether sign-in is on, and who. */
  state = signal<AuthState | null>(null);
  /** Why the server just refused something, for a few seconds. */
  refused = signal<string | null>(null);
  private refusedTimer?: ReturnType<typeof setTimeout>;
  /** The accounts this browser remembers; [] until asked, or with sign-in off. */
  accounts = signal<SavedAccount[]>([]);
  /** Someone was signed in on this page: whoever signs in next gets a fresh
   *  page, not the one the last account's rooms were loaded into. */
  private hadUser = false;

  load() {
    this.http.get<AuthState>('/api/auth/state').subscribe({
      next: s => {
        this.state.set(s);
        if (s.user) this.hadUser = true;
        if (s.mode === 'on') this.loadAccounts();
      },
      // No answer at all: show the app, which says the server is down.
      error: () => this.state.set({ mode: 'off', user: null }),
    });
  }

  /** Whether the app itself may be shown: signed in, and not asked for a
   *  new password first. */
  signedIn(): boolean {
    const s = this.state();
    return !!s && (s.mode === 'off' || (!!s.user && !s.must_change_password));
  }

  /** The owner or an admin: the admin panel is theirs. */
  admin(): boolean { return this.state()?.mode === 'on' && this.can('users'); }

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

  login(email: string, password: string, remember = false) {
    return this.http.post<{ user: Me; remembered: boolean }>('/api/auth/login', { email, password, remember });
  }

  loadAccounts() {
    this.http.get<{ accounts: SavedAccount[] }>('/api/auth/accounts').subscribe({
      next: r => this.accounts.set(r.accounts ?? []),
      error: () => this.accounts.set([]),
    });
  }

  /** Signed in, by a password or a switch: the app for that account. A page
   *  that had another account loaded starts afresh. */
  entered() {
    forgetAccountData();
    if (this.hadUser) this.restart();
    else this.load();
  }

  /** The page again, from nothing: every room, cache and signal of the
   *  account that was here goes with it. The room stays; what was open in
   *  it may not exist in the next account's space. */
  private restart() {
    const url = new URL(location.href);
    url.search = url.searchParams.get('ws') ? `?ws=${encodeURIComponent(url.searchParams.get('ws')!)}` : '';
    url.hash = '';
    location.replace(url.toString());
  }

  /** Another remembered account, no password. Refused (its token is gone):
   *  the card asks for that account's password. */
  switchTo(a: SavedAccount, failed?: () => void) {
    if (!a.live) { this.signInAgain(a.email); return; }
    this.http.post('/api/auth/switch', { id: a.id }).subscribe({
      next: () => this.entered(),
      error: (e: HttpErrorResponse) => {
        failed?.();
        if (e.status === 401) { this.signInAgain(a.email); this.loadAccounts(); }
        else this.refuse(typeof e.error?.detail === 'string' ? e.error.detail : t('That account could not be opened.'));
      },
    });
  }

  /** This account kept on this browser, so another can be added beside it. */
  remember() {
    return this.http.post<{ remembered: boolean; new: boolean }>('/api/auth/remember', {});
  }

  /** The sign-in card, from the menu: to add an account (this one is
   *  remembered first, so it is not lost), or to give one its password again. */
  addAccount() { this.leaveFor({ mode: 'add' }); }

  signInAgain(email: string) {
    if (this.state()?.user) this.leaveFor({ mode: 'again', email });
    else this.next.set({ mode: 'again', email });
  }

  /** Signed out to the card, the account that was signed in remembered. */
  private leaveFor(next: SignInNext) {
    this.remember().subscribe({
      next: () => {
        try { sessionStorage.setItem(SIGNIN_NEXT, JSON.stringify(next)); } catch { /* private window */ }
        this.logout();
      },
      error: (e: HttpErrorResponse) => this.refuse(typeof e.error?.detail === 'string' ? e.error.detail : t('That did not work.')),
    });
  }

  /** What the sign-in card shows first: the chooser (null), the form to add
   *  an account, or one account's password. */
  next = signal<SignInNext | null>(readNext());

  /** Off this browser: its token revoked on the server. */
  forget(a: SavedAccount) {
    this.http.post('/api/auth/forget', { id: a.id }).subscribe({
      next: () => { if (a.current) this.restart(); else this.loadAccounts(); },
      error: () => this.loadAccounts(),
    });
  }

  /** Every account off this browser, and signed out. */
  forgetAll() {
    this.http.post('/api/auth/forget-all', {}).subscribe({
      next: () => { forgetAccountData(); this.restart(); },
      error: () => this.loadAccounts(),
    });
  }

  setup(email: string, name: string, password: string) {
    return this.http.post<{ user: Me }>('/api/auth/setup', { email, name, password });
  }

  newPassword(password: string) {
    return this.http.post<{ changed: boolean }>('/api/auth/new-password', { new: password });
  }

  /** Signed out, the accounts kept: the page starts again on the chooser,
   *  with nothing of this account left in it. */
  logout() {
    const done = () => { forgetAccountData(); if (this.hadUser) this.restart(); else this.load(); };
    this.http.post('/api/auth/logout', {}).subscribe({ next: done, error: done });
  }
}

export interface SignInNext { mode: 'add' | 'again'; email?: string }

function readNext(): SignInNext | null {
  try {
    const raw = sessionStorage.getItem(SIGNIN_NEXT);
    sessionStorage.removeItem(SIGNIN_NEXT);
    const v = raw ? JSON.parse(raw) : null;
    return v && (v.mode === 'add' || v.mode === 'again') ? { mode: v.mode, email: typeof v.email === 'string' ? v.email : undefined } : null;
  } catch { return null; }
}

/** Every change carries the header only this page sends (the server's
 *  guard against another site using the cookie), and a 401 anywhere means
 *  the session is gone: back to the sign-in card. */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(Auth);
  const out = req.method === 'GET' ? req : req.clone({ setHeaders: { 'X-Redline-CSRF': '1' } });
  return next(out).pipe(catchError((e: HttpErrorResponse) => {
    if (e.status === 401 && !req.url.includes('/api/auth/')) auth.signedOut();
    // A new password is owed first: back to the card that asks for it.
    if (e.status === 403 && e.error?.refused === 'password') auth.load();
    // A role's refusal (backend/access.py): said once, at the top.
    else if (e.status === 403 && e.error?.refused) auth.refuse(e.error.detail);
    return throwError(() => e);
  }));
};

/** The card a signed-out visitor sees - or, before anyone has an account,
 *  the one that makes the owner's; or, signed in with a password an admin
 *  set, the one that asks for the person's own.
 *
 *  A browser that remembers accounts (backend/accounts.py) opens on the
 *  chooser instead: each account a row, one click signs in; "…" removes one
 *  from this browser (its token is revoked); "Use another account" is the
 *  password form. A row whose token is gone asks for its password only. */
@Component({
  selector: 'app-sign-in',
  imports: [T, Avatar],
  host: { '(document:click)': 'menuFor.set(null)', '(document:keydown.escape)': 'menuFor.set(null)' },
  template: `
<div class="tcv-signin-wrap">
  @if (mustChange(); as u) {
    <form class="tcv-signin" (submit)="$event.preventDefault(); setNew()">
      <div class="tcv-signin-brand">Redline</div>
      <p class="tcv-signin-lead">{{ 'Hello' | t }} <b>{{ u.name }}</b>. {{ 'Your password was set by an admin. Choose your own to continue - your other sessions are signed out.' | t }}</p>
      <input type="email" class="tcv-signin-hidden" [value]="u.email ?? ''" autocomplete="username" tabindex="-1" aria-hidden="true" readonly>
      <label>{{ 'New password' | t }}<input type="password" [value]="password()" (input)="password.set($any($event.target).value); error.set('')"
                                           autocomplete="new-password" required></label>
      <label>{{ 'Repeat the new password' | t }}<input type="password" [value]="again()" (input)="again.set($any($event.target).value); error.set('')"
                                                      autocomplete="new-password" required></label>
      <p class="tcv-signin-hint">{{ 'At least 10 characters.' | t }}</p>
      @if (error(); as e) { <p class="tcv-signin-error" role="alert">{{ e }}</p> }
      <button class="tcv-btn tcv-btn-accent" type="submit" [disabled]="busy()">{{ busy() ? '…' : ('Set the password' | t) }}</button>
      <button class="tcv-btn" type="button" (click)="auth.logout()">{{ 'Sign out' | t }}</button>
    </form>
  } @else if (chooser()) {
    <div class="tcv-signin tcv-acct">
      <div class="tcv-signin-brand">Redline</div>
      <p class="tcv-signin-lead">{{ 'Choose an account' | t }}</p>
      <ul class="tcv-acct-list">
        @for (a of auth.accounts(); track a.id) {
          <li class="tcv-acct-row" [attr.data-dead]="a.live ? null : 1">
            <button type="button" class="tcv-acct-pick" (click)="pick(a)" [disabled]="busy()"
                    [title]="a.live ? a.email : ('Sign in again' | t)">
              <app-avatar [name]="a.name" [userId]="a.id" [hasPicture]="a.live && a.has_avatar" [v]="a.avatar_v"
                          [colour]="a.avatar_colour" [picture]="pictureOf(a)" [size]="36" />
              <span class="tcv-acct-text">
                <span class="tcv-acct-line"><span class="tcv-acct-name">{{ a.name }}</span>
                  @if (!a.live) { <span class="tcv-acct-again">{{ 'Sign in again' | t }}</span> }</span>
                <span class="tcv-acct-mail">{{ a.email }}</span>
              </span>
            </button>
            <button type="button" class="tcv-acct-more" [attr.data-on]="menuFor() === a.id ? 1 : null"
                    [attr.aria-label]="('More' | t) + ' - ' + a.email" aria-haspopup="menu" [attr.aria-expanded]="menuFor() === a.id"
                    (click)="$event.stopPropagation(); menuFor.set(menuFor() === a.id ? null : a.id)">
              <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.25"/><circle cx="8" cy="8" r="1.25"/><circle cx="12.5" cy="8" r="1.25"/></svg>
            </button>
            @if (menuFor() === a.id) {
              <div class="tcv-menu tcv-acct-menu" role="menu" (click)="$event.stopPropagation()">
                <button type="button" class="tcv-menu-item" role="menuitem" (click)="menuFor.set(null); auth.forget(a)">
                  <span class="tcv-menu-name">{{ 'Remove from this device' | t }}</span>
                  <span class="tcv-menu-blurb">{{ 'Signs it out here; the next sign-in asks for the password' | t }}</span></button>
              </div>
            }
          </li>
        }
      </ul>
      <button type="button" class="tcv-acct-other" (click)="useAnother()">
        <span class="tcv-acct-plus" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M8 3.5v9M3.5 8h9"/></svg></span>
        {{ 'Use another account' | t }}</button>
      @if (error(); as e) { <p class="tcv-signin-error" role="alert">{{ e }}</p> }
      <button type="button" class="tcv-acct-all" (click)="signOutAll()">{{ 'Sign out of all accounts on this device' | t }}</button>
    </div>
  } @else {
  <form class="tcv-signin" (submit)="$event.preventDefault(); go()">
    <div class="tcv-signin-brand">Redline</div>
    @if (resetFor(); as r) {
      <p class="tcv-signin-lead">Choose a new password for <b>{{ r }}</b>. You are signed in with it at once,
        and signed out everywhere else.</p>
    } @else if (resetGone(); as g) {
      <p class="tcv-signin-error" role="alert">{{ g }}</p>
      <p class="tcv-signin-lead">Sign in, or make a new link on the machine: <code>tools/account.py reset</code>.</p>
    } @else if (setup()) {
      <p class="tcv-signin-lead">{{ 'Nobody has an account yet. Make the first one - it is the owner: it runs the server and adds the other accounts.' | t }}</p>
      <label>Name<input [value]="name()" (input)="name.set($any($event.target).value)" autocomplete="name"></label>
    } @else if (againFor(); as a) {
      <p class="tcv-signin-lead">{{ 'This account is no longer remembered here. Enter its password to sign in again.' | t }}</p>
      <div class="tcv-acct-fixed">
        <app-avatar [name]="a.name" [userId]="a.id" [colour]="a.avatar_colour" [size]="32" />
        <span class="tcv-acct-text">
          <span class="tcv-acct-name">{{ a.name }}</span>
          <span class="tcv-acct-mail">{{ a.email }}</span>
        </span>
      </div>
    } @else {
      <p class="tcv-signin-lead">{{ (auth.next()?.mode === 'add' ? 'Sign in to another account.' : 'Sign in to continue.') | t }}</p>
    }
    @if (againFor(); as a) {
      <input type="email" class="tcv-signin-hidden" [value]="a.email" autocomplete="username" tabindex="-1" aria-hidden="true" readonly>
    } @else if (!resetFor()) {
      <label>{{ 'Email' | t }}<input type="email" [value]="email()" (input)="email.set($any($event.target).value)"
                         autocomplete="username" required></label>
    }
    <label>{{ 'Password' | t }}<input type="password" [value]="password()" (input)="password.set($any($event.target).value)"
                          [attr.autocomplete]="newPassword() ? 'new-password' : 'current-password'" required></label>
    @if (newPassword()) { <p class="tcv-signin-hint">At least 10 characters.</p> }
    @if (!newPassword()) {
      <label class="tcv-signin-check"><input type="checkbox" [checked]="remember()" (change)="rememberTouched = true; remember.set($any($event.target).checked)">
        <span>{{ 'Remember me' | t }}<span class="tcv-signin-check-sub">{{ 'Keep this account on this browser, to switch to it without the password' | t }}</span></span></label>
    }
    @if (error(); as e) { <p class="tcv-signin-error" role="alert">{{ e }}</p> }
    <button class="tcv-btn tcv-btn-accent" type="submit" [disabled]="busy()">
      {{ busy() ? '…' : resetFor() ? 'Set the password' : setup() ? 'Make the account' : ('Sign in' | t) }}</button>
    @if (!setup() && !resetFor() && auth.accounts().length) {
      <button type="button" class="tcv-btn tcv-signin-back" (click)="backToAccounts()">{{ 'Back to accounts' | t }}</button>
    }
  </form>
  }
</div>`,
})
export class SignIn {
  auth = inject(Auth);
  private http = inject(HttpClient);
  email = signal('');
  name = signal('');
  password = signal('');
  again = signal('');
  error = signal('');
  busy = signal(false);
  /** "Remember me": on when this browser already keeps accounts, or one is
   *  being added or signed in again. */
  remember = signal(!!this.auth.next());
  rememberTouched = false;
  /** The row whose "…" menu is open. */
  menuFor = signal<string | null>(null);
  setup = () => !!this.auth.state()?.needs_setup;
  /** Signed in, but owing a new password (an admin set this one). */
  mustChange = computed(() => {
    const s = this.auth.state();
    return s?.must_change_password && s.user ? s.user : null;
  });
  /** A password-reset link: /?reset=<key> (tools/account.py reset). */
  private resetKey = new URLSearchParams(location.search).get('reset');
  resetFor = signal<string | null>(null);
  resetGone = signal<string | null>(null);
  newPassword = () => this.resetFor() ? true : this.setup();
  /** The remembered accounts first, unless the form was asked for. */
  chooser = computed(() => !this.setup() && !this.resetKey && !this.auth.next() && this.auth.accounts().length > 0);
  /** The account whose password is asked for again: its row, as remembered. */
  againFor = computed(() => {
    const n = this.auth.next();
    if (n?.mode !== 'again' || !n.email) return null;
    return this.auth.accounts().find(a => a.email === n.email)
      ?? { id: '', name: n.email, email: n.email, avatar_colour: 'auto' } as Pick<SavedAccount, 'id' | 'name' | 'email' | 'avatar_colour'>;
  });

  constructor() {
    if (this.resetKey) {
      this.http.get<{ email: string }>(`/api/reset/${encodeURIComponent(this.resetKey)}`).subscribe({
        next: r => this.resetFor.set(r.email),
        error: (e: HttpErrorResponse) => this.resetGone.set(
          typeof e.error?.detail === 'string' ? e.error.detail : 'this link cannot be opened'),
      });
    }
    // Remember me is on by default once this browser keeps accounts.
    effect(() => { if (this.auth.accounts().length && !this.rememberTouched) untracked(() => this.remember.set(true)); });
  }

  /** A remembered account's picture: only this browser's token shows it. */
  pictureOf(a: SavedAccount) {
    return `/api/auth/accounts/${encodeURIComponent(a.id)}/avatar`;
  }

  pick(a: SavedAccount) {
    this.error.set('');
    if (!a.live) { this.auth.signInAgain(a.email); this.password.set(''); return; }
    this.busy.set(true);
    this.auth.switchTo(a, () => this.busy.set(false));
  }

  useAnother() {
    this.error.set('');
    this.email.set('');
    this.password.set('');
    this.auth.next.set({ mode: 'add' });
  }

  backToAccounts() {
    this.error.set('');
    this.password.set('');
    this.auth.next.set(null);
    this.auth.loadAccounts();
  }

  signOutAll() {
    if (!confirm(t('Sign out of every account on this device? Each one is removed from this browser and needs its password next time.'))) return;
    this.auth.forgetAll();
  }

  go() {
    this.busy.set(true);
    this.error.set('');
    const email = this.againFor()?.email ?? this.email();
    const call = this.resetFor() && this.resetKey
      ? this.http.post<{ user: Me }>(`/api/reset/${encodeURIComponent(this.resetKey)}`, { password: this.password() })
      : this.setup()
      ? this.auth.setup(this.email(), this.name(), this.password())
      : this.auth.login(email, this.password(), this.remember());
    call.subscribe({
      next: () => {
        this.busy.set(false); this.password.set('');
        // The link has done its work: off the address bar.
        if (this.resetKey) history.replaceState(null, '', location.pathname);
        this.auth.next.set(null);
        this.auth.entered();
      },
      error: (e: HttpErrorResponse) => {
        this.busy.set(false);
        this.error.set(typeof e.error?.detail === 'string' ? e.error.detail : 'that did not work');
      },
    });
  }

  setNew() {
    if (this.password().length < 10) { this.error.set(t('The new password needs at least 10 characters.')); return; }
    if (this.password() !== this.again()) { this.error.set(t('The two new passwords are not the same.')); return; }
    this.busy.set(true);
    this.error.set('');
    this.auth.newPassword(this.password()).subscribe({
      next: () => { this.busy.set(false); this.password.set(''); this.again.set(''); this.auth.load(); },
      error: (e: HttpErrorResponse) => {
        this.busy.set(false);
        this.error.set(typeof e.error?.detail === 'string' ? e.error.detail : 'that did not work');
      },
    });
  }
}

/** Who is signed in, and signing out - only when sign-in is on. */
@Component({
  selector: 'app-user-chip',
  imports: [NgTemplateOutlet, T, Avatar],
  host: { class: 'relative flex items-center' },
  template: `
@if (auth.state(); as s) {
  <!-- The month against its budget, when one is set (app.ts): the warning
       colour from its threshold, the danger colour past 100%. -->
  @if (spend(); as b) {
    <button class="tcv-spend" [attr.data-state]="b.state" [title]="b.title" (click)="analytics.emit()">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 13h12M4 10.5V8M8 10.5V4.5M12 10.5V6.5"/></svg>
      <span class="tcv-spend-text">{{ b.text }}</span></button>
  }
  @if (s.mode !== 'on') {
    <!-- Nobody signs in on this machine: a gear, with the same menu's
         Analytics (Settings is a tab of its own). -->
    <button class="tcv-user tcv-user-gear" (click)="toggle()" [attr.data-on]="open() ? 1 : null" [title]="'Analytics' | t">⚙</button>
    @if (open()) {
      <div class="tcv-menu tcv-user-menu" (mouseleave)="open.set(false)">
        <ng-container *ngTemplateOutlet="analyticsItem" />
      </div>
    }
  }
  @if (s.mode === 'on' && s.user; as u) {
    <!-- Who you are: your name over your role on this server. The caret
         says it opens. -->
    <button class="tcv-user" (click)="toggle()" [attr.data-on]="open() ? 1 : null"
            [title]="(u.email ?? u.name) + ' - ' + (s.role ?? '' | t)">
      <app-avatar class="tcv-user-av" [name]="u.name" [userId]="u.id" [hasPicture]="u.has_avatar" [v]="u.avatar_v" [colour]="u.avatar_colour" [size]="20" />
      <span class="tcv-user-text">
        <span class="tcv-user-name">{{ u.name }}</span>
        <span class="tcv-user-ws">{{ (s.role ?? '') | t }}</span>
      </span>
      <svg class="tcv-user-caret" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4"/></svg>
    </button>
    @if (open()) {
      <div class="tcv-menu tcv-user-menu" (mouseleave)="open.set(false)">
        <ng-container *ngTemplateOutlet="analyticsItem" />
        <button class="tcv-menu-item" (click)="open.set(false); prefs.open.set('profile')" [title]="'Profile' | t">
          <span class="tcv-menu-name">{{ u.name }}</span>
          <span class="tcv-menu-blurb">{{ u.email }} · {{ (s.role ?? '') | t }}</span>
          <span class="tcv-menu-blurb">{{ 'Your profile: name, picture, password, sessions' | t }}</span></button>
        @if (auth.admin()) {
          <button class="tcv-menu-item" (click)="open.set(false); prefs.open.set('admin')">
            <span class="tcv-menu-name">{{ 'Admin panel' | t }}</span>
            <span class="tcv-menu-blurb">{{ 'Accounts: add people, roles, passwords, disable' | t }}</span></button>
        }
        <!-- The accounts this browser remembers: the one signed in ticked,
             any other a click away, no password (backend/accounts.py). -->
        <div class="tcv-menu-head">{{ 'Accounts' | t }}</div>
        @for (a of menuAccounts(); track a.id) {
          <button class="tcv-menu-item tcv-acct-item" [disabled]="(a.current && a.live) || busy()" [attr.data-current]="a.current ? 1 : null"
                  (click)="pick(a)" [title]="a.current ? (a.live ? ('Signed in' | t) : ('Remember on this browser again' | t))
                                             : a.live ? ('Switch to this account' | t) : ('Sign in again' | t)">
            <app-avatar [name]="a.name" [userId]="a.id" [hasPicture]="a.live && a.has_avatar" [v]="a.avatar_v" [colour]="a.avatar_colour"
                        [picture]="a.current ? null : '/api/auth/accounts/' + a.id + '/avatar'" [size]="28" />
            <span class="tcv-acct-text">
              <span class="tcv-acct-line"><span class="tcv-acct-name">{{ a.name }}</span>
                @if (!a.live) { <span class="tcv-acct-again">{{ 'Sign in again' | t }}</span> }</span>
              <span class="tcv-acct-mail">{{ a.email }}</span>
            </span>
            @if (a.current) {
              <svg class="tcv-acct-tick" viewBox="0 0 16 16" role="img" [attr.aria-label]="'Signed in' | t"><path d="M3.5 8.5l3 3 6-7"/></svg>
            }
          </button>
        }
        <button class="tcv-menu-item tcv-acct-item" (click)="open.set(false); auth.addAccount()">
          <span class="tcv-acct-plus" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M8 3.5v9M3.5 8h9"/></svg></span>
          <span class="tcv-acct-text"><span class="tcv-acct-name">{{ 'Add account' | t }}</span></span></button>
        <button class="tcv-menu-item tcv-menu-out" (click)="open.set(false); auth.logout()">
          <span class="tcv-menu-name">{{ 'Sign out' | t }}</span>
          @if (auth.accounts().length) { <span class="tcv-menu-blurb">{{ 'The remembered accounts stay on this browser' | t }}</span> }</button>
      </div>
    }
  }
}
<!-- Analytics: first in the menu, a chart beside it so it reads as the
     place for figures, and the last seven days in a few words. -->
<ng-template #analyticsItem>
  <button class="tcv-menu-item tcv-menu-analytics" [attr.data-on]="inAnalytics() ? 1 : null"
          (click)="open.set(false); analytics.emit()" [title]="brief()?.title ?? ''">
    <span class="tcv-menu-name">
      <svg class="tcv-menu-chart" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M2 14h12" /><rect x="3" y="8" width="2.4" height="5" rx=".4" /><rect x="6.8" y="5" width="2.4" height="8" rx=".4" />
        <rect x="10.6" y="2" width="2.4" height="11" rx=".4" /></svg>
      {{ 'Analytics' | t }}</span>
    <span class="tcv-menu-blurb">{{ brief()?.text ?? ('LLM spend, the machine, energy, the work in each room' | t) }}</span></button>
</ng-template>`,
})
export class UserChip {
  auth = inject(Auth);
  prefs = inject(Prefs);
  /** The last seven days in a few words, from the shell (app.ts). */
  brief = input<{ text: string; title: string } | null>(null);
  /** The month's spend against its budget, from the shell; null with no budget. */
  spend = input<{ text: string; title: string; state: string } | null>(null);
  inAnalytics = input(false);
  analytics = output<void>();
  open = signal(false);
  busy = signal(false);

  /** The remembered accounts, and the signed-in one at the top even when
   *  this browser does not remember it. */
  menuAccounts = computed<SavedAccount[]>(() => {
    const s = this.auth.state();
    const saved = this.auth.accounts();
    const u = s?.user;
    if (!u) return saved;
    const mine = saved.find(a => a.id === u.id);
    const me: SavedAccount = mine ? { ...mine, current: true } : {
      id: u.id, name: u.name, email: u.email ?? '', has_avatar: !!u.has_avatar, avatar_v: u.avatar_v ?? null,
      avatar_colour: u.avatar_colour ?? 'auto', live: true, current: true };
    return [me, ...saved.filter(a => a.id !== u.id).map(a => ({ ...a, current: false }))];
  });

  toggle() {
    this.open.set(!this.open());
    if (this.open() && this.auth.state()?.mode === 'on') this.auth.loadAccounts();
  }

  pick(a: SavedAccount) {
    // Signed in, but no longer remembered here (revoked elsewhere): again.
    if (a.current) {
      if (!a.live) this.auth.remember().subscribe({ next: () => this.auth.loadAccounts(), error: () => this.auth.loadAccounts() });
      return;
    }
    this.busy.set(true);
    this.auth.switchTo(a, () => this.busy.set(false));
  }
}
