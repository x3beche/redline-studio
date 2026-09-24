import { Component, Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { catchError, throwError } from 'rxjs';

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
}

@Injectable({ providedIn: 'root' })
export class Auth {
  private http = inject(HttpClient);
  /** Null until the server has said; then whether sign-in is on, and who. */
  state = signal<AuthState | null>(null);

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
    @if (setup()) {
      <p class="tcv-signin-lead">Nobody has an account yet. Make the first one - it owns this workspace, and
        invites the others.</p>
      <label>Name<input [value]="name()" (input)="name.set($any($event.target).value)" autocomplete="name"></label>
    } @else {
      <p class="tcv-signin-lead">Sign in to continue.</p>
    }
    <label>Email<input type="email" [value]="email()" (input)="email.set($any($event.target).value)"
                       autocomplete="username" required></label>
    <label>Password<input type="password" [value]="password()" (input)="password.set($any($event.target).value)"
                          [attr.autocomplete]="setup() ? 'new-password' : 'current-password'" required></label>
    @if (setup()) { <p class="tcv-signin-hint">At least 10 characters.</p> }
    @if (error(); as e) { <p class="tcv-signin-error" role="alert">{{ e }}</p> }
    <button class="tcv-btn tcv-btn-accent" type="submit" [disabled]="busy()">
      {{ busy() ? '…' : setup() ? 'Make the account' : 'Sign in' }}</button>
  </form>
</div>`,
})
export class SignIn {
  private auth = inject(Auth);
  email = signal('');
  name = signal('');
  password = signal('');
  error = signal('');
  busy = signal(false);
  setup = () => !!this.auth.state()?.needs_setup;

  go() {
    this.busy.set(true);
    this.error.set('');
    const call = this.setup()
      ? this.auth.setup(this.email(), this.name(), this.password())
      : this.auth.login(this.email(), this.password());
    call.subscribe({
      next: () => { this.busy.set(false); this.password.set(''); this.auth.load(); },
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
  host: { class: 'relative flex items-center' },
  template: `
@if (auth.state(); as s) {
  @if (s.mode === 'on' && s.user; as u) {
    <button class="tcv-tab tcv-user" (click)="open.set(!open())" [title]="u.email ?? u.name">
      <span class="tcv-user-dot">{{ initial(u.name) }}</span>{{ u.name }}
    </button>
    @if (open()) {
      <div class="tcv-menu tcv-user-menu" (mouseleave)="open.set(false)">
        <div class="tcv-menu-item"><span class="tcv-menu-name">{{ u.name }}</span>
          <span class="tcv-menu-blurb">{{ u.email }} · workspace {{ s.workspace }}</span></div>
        <button class="tcv-menu-item" (click)="open.set(false); auth.logout()">
          <span class="tcv-menu-name">Sign out</span></button>
      </div>
    }
  }
}`,
})
export class UserChip {
  auth = inject(Auth);
  open = signal(false);
  initial(n: string) { return (n.trim()[0] ?? '?').toUpperCase(); }
}
