import { Component, Injectable, computed, inject, input, output, signal } from '@angular/core';
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
export interface Me { type: 'user'; id: string; name: string; email?: string; has_avatar?: boolean; avatar_v?: number | null }
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

  login(email: string, password: string) {
    return this.http.post<{ user: Me }>('/api/auth/login', { email, password });
  }

  setup(email: string, name: string, password: string) {
    return this.http.post<{ user: Me }>('/api/auth/setup', { email, name, password });
  }

  newPassword(password: string) {
    return this.http.post<{ changed: boolean }>('/api/auth/new-password', { new: password });
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
 *  set, the one that asks for the person's own. */
@Component({
  selector: 'app-sign-in',
  imports: [T],
  template: `
<div class="tcv-signin-wrap">
  @if (mustChange(); as u) {
    <form class="tcv-signin" (submit)="$event.preventDefault(); setNew()">
      <div class="tcv-signin-brand">Redl<span class="brand-i">i</span>ne</div>
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
  } @else {
  <form class="tcv-signin" (submit)="$event.preventDefault(); go()">
    <div class="tcv-signin-brand">Redl<span class="brand-i">i</span>ne</div>
    @if (resetFor(); as r) {
      <p class="tcv-signin-lead">Choose a new password for <b>{{ r }}</b>. You are signed in with it at once,
        and signed out everywhere else.</p>
    } @else if (resetGone(); as g) {
      <p class="tcv-signin-error" role="alert">{{ g }}</p>
      <p class="tcv-signin-lead">Sign in, or make a new link on the machine: <code>tools/account.py reset</code>.</p>
    } @else if (setup()) {
      <p class="tcv-signin-lead">{{ 'Nobody has an account yet. Make the first one - it is the owner: it runs the server and adds the other accounts.' | t }}</p>
      <label>Name<input [value]="name()" (input)="name.set($any($event.target).value)" autocomplete="name"></label>
    } @else {
      <p class="tcv-signin-lead">Sign in to continue.</p>
    }
    @if (!resetFor()) {
      <label>Email<input type="email" [value]="email()" (input)="email.set($any($event.target).value)"
                         autocomplete="username" required></label>
    }
    <label>Password<input type="password" [value]="password()" (input)="password.set($any($event.target).value)"
                          [attr.autocomplete]="newPassword() ? 'new-password' : 'current-password'" required></label>
    @if (newPassword()) { <p class="tcv-signin-hint">At least 10 characters.</p> }
    @if (error(); as e) { <p class="tcv-signin-error" role="alert">{{ e }}</p> }
    <button class="tcv-btn tcv-btn-accent" type="submit" [disabled]="busy()">
      {{ busy() ? '…' : resetFor() ? 'Set the password' : setup() ? 'Make the account' : 'Sign in' }}</button>
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

  constructor() {
    if (this.resetKey) {
      this.http.get<{ email: string }>(`/api/reset/${encodeURIComponent(this.resetKey)}`).subscribe({
        next: r => this.resetFor.set(r.email),
        error: (e: HttpErrorResponse) => this.resetGone.set(
          typeof e.error?.detail === 'string' ? e.error.detail : 'this link cannot be opened'),
      });
    }
  }

  go() {
    this.busy.set(true);
    this.error.set('');
    const call = this.resetFor() && this.resetKey
      ? this.http.post<{ user: Me }>(`/api/reset/${encodeURIComponent(this.resetKey)}`, { password: this.password() })
      : this.setup()
      ? this.auth.setup(this.email(), this.name(), this.password())
      : this.auth.login(this.email(), this.password());
    call.subscribe({
      next: () => {
        this.busy.set(false); this.password.set('');
        // The link has done its work: off the address bar.
        if (this.resetKey) history.replaceState(null, '', location.pathname);
        this.auth.load();
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
      <app-avatar class="tcv-user-av" [name]="u.name" [userId]="u.id" [hasPicture]="u.has_avatar" [v]="u.avatar_v" [size]="20" />
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
        <button class="tcv-menu-item" (click)="open.set(false); auth.logout()">
          <span class="tcv-menu-name">{{ 'Sign out' | t }}</span></button>
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

  toggle() { this.open.set(!this.open()); }
}
