import { Component, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable, firstValueFrom } from 'rxjs';
import { LANG, T, t } from './i18n';
import { Auth } from './auth';
import { Avatar } from './avatar';

/** Settings > Profile: the person's own account (backend/profile.py) - the
 *  picture, the name and the address, the system role (owner, admin or
 *  user), the password and the sessions. Only one's own; local mode, an agent's token and a headless
 *  browser get it read-only, with no password or sessions to show. */
interface Profile {
  kind: 'user' | 'local' | 'agent' | 'page';
  id: string; name: string; email: string | null; role: string | null; about_role?: string | null;
  created_at?: string | null; last_sign_in?: string | null;
  has_avatar: boolean; avatar_v: number | null;
}
interface Session { id: string; here: boolean; device: string; created_at: string | null; last_seen: string | null }

const MAX_BYTES = 5 * 1024 * 1024;
const MIN_PASSWORD = 10;

@Component({
  selector: 'app-profile-settings',
  imports: [T, Avatar],
  styleUrls: ['./settings.css', './profile-settings.css'],
  template: `
<div class="st-page">
  @if (!p()) {
    @if (loadErr(); as e) {
      <p class="st-err">{{ e }}</p>
    } @else {
      <div class="st-card pf-skel" aria-busy="true" [attr.aria-label]="'Loading your profile' | t">
        <div class="st-card-head"><i class="sk" style="width: 90px"></i></div>
        <div class="st-card-body">
          <div class="pf-top">
            <div class="pf-pic"><i class="sk sk-pic"></i><i class="sk sk-btn"></i></div>
            <div class="pf-fields">
              <div class="st-grid pf-grid"><i class="sk sk-in"></i><i class="sk sk-in"></i></div>
              <div class="st-tiles pf-tiles"><i class="sk sk-tile"></i><i class="sk sk-tile"></i><i class="sk sk-tile"></i><i class="sk sk-tile"></i></div>
            </div>
          </div>
        </div>
      </div>
      <div class="st-card pf-skel" aria-hidden="true">
        <div class="st-card-head"><i class="sk" style="width: 120px"></i></div>
        <div class="st-card-body"><i class="sk" style="width: 70%"></i><i class="sk" style="width: 45%"></i></div>
      </div>
    }
  } @else if (p(); as p) {
    @if (p.kind !== 'user') {
      <div class="st-banner">{{ noAccount(p.kind) | t }}</div>
    }
    <div class="st-card">
      <div class="st-card-head"><h3>{{ 'Profile' | t }}</h3>
        <span class="st-sub">{{ 'Your name and picture, and the address you sign in with' | t }}</span></div>
      <form class="st-card-body" (submit)="$event.preventDefault(); dirty() && name().trim() && save()">
        <div class="pf-top">
          <div class="pf-pic">
            <app-avatar [name]="name() || p.name" [userId]="p.id" [hasPicture]="p.has_avatar" [v]="p.avatar_v" [size]="88" />
            @if (p.kind === 'user') {
              <div class="pf-pic-acts">
                <label class="tcv-btn tcv-files-btn pf-file" [attr.data-busy]="picBusy() ? 1 : null">
                  {{ (p.has_avatar ? 'Change picture' : 'Upload picture') | t }}
                  <input type="file" accept="image/png,image/jpeg,image/webp" [disabled]="picBusy()" (change)="pick($event)">
                </label>
                @if (p.has_avatar) {
                  <button type="button" class="tcv-btn tcv-files-btn" [disabled]="picBusy()" (click)="dropPicture()">{{ 'Remove' | t }}</button>
                }
              </div>
              <span class="st-hint pf-pic-hint">{{ 'PNG, JPG or WebP, up to 5 MB - cut to a square.' | t }}</span>
              @if (picErr(); as e) { <span class="st-err">{{ e }}</span> }
            }
          </div>
          <div class="pf-fields">
            <div class="st-grid pf-grid">
              <label class="st-f"><span>{{ 'Display name' | t }}</span>
                <input class="st-in" [value]="name()" maxlength="80" autocomplete="name" [disabled]="p.kind !== 'user'"
                       (input)="name.set($any($event.target).value); saved.set(false)"></label>
              <label class="st-f"><span>{{ 'Email' | t }}</span>
                <input class="st-in" type="email" [value]="email()" maxlength="200" autocomplete="email"
                       [disabled]="p.kind !== 'user'" [placeholder]="p.kind === 'user' ? '' : ('no account' | t)"
                       (input)="email.set($any($event.target).value); saved.set(false)"></label>
              @if (emailChanged()) {
                <label class="st-f"><span>{{ 'Current password' | t }}</span>
                  <input class="st-in" type="password" [value]="emailPw()" autocomplete="current-password"
                         (input)="emailPw.set($any($event.target).value)"></label>
              }
            </div>
            @if (emailChanged()) { <p class="st-hint">{{ 'You sign in with this address: changing it asks for your password.' | t }}</p> }
            <div class="st-tiles pf-tiles">
              <div class="st-tile" [title]="p.about_role ?? ''"><span>{{ 'Role' | t }}</span><b>{{ (p.role ?? '-') | t }}</b>
                <small>{{ (p.kind === 'user' ? 'on this server' : 'of this token') | t }}</small></div>
              <div class="st-tile"><span>{{ 'Account since' | t }}</span><b>{{ day(p.created_at) }}</b>
                <small>{{ time(p.created_at) }}</small></div>
              <div class="st-tile"><span>{{ 'Last sign-in' | t }}</span><b>{{ day(p.last_sign_in) }}</b>
                <small>{{ time(p.last_sign_in) }}</small></div>
              <div class="st-tile"><span>{{ 'Account' | t }}</span><b>{{ kindName(p.kind) | t }}</b>
                <small class="mono">{{ p.id }}</small></div>
            </div>
          </div>
        </div>
        @if (p.kind === 'user') {
          <div class="pf-foot">
            @if (err(); as e) { <span class="st-err">{{ e }}</span> }
            @else if (saved()) { <span class="st-msg">{{ 'Saved' | t }}</span> }
            <button class="tcv-btn tcv-btn-accent" type="submit" [disabled]="!dirty() || busy() || !name().trim()">
              {{ (busy() ? 'Saving…' : 'Save') | t }}</button>
          </div>
        }
      </form>
    </div>

    @if (p.kind === 'user') {
      <div class="st-card">
        <div class="st-card-head"><h3>{{ 'Password' | t }}</h3>
          <span class="st-sub">{{ 'At least 10 characters. Your other sessions are signed out when it changes.' | t }}</span></div>
        <form class="st-card-body" (submit)="$event.preventDefault(); changePassword()">
          <input type="email" class="pf-hidden" [value]="p.email" autocomplete="username" tabindex="-1" aria-hidden="true" readonly>
          <div class="st-grid pf-grid3">
            <label class="st-f"><span>{{ 'Current password' | t }}</span>
              <input class="st-in" type="password" autocomplete="current-password" [value]="pwNow()" (input)="pwNow.set($any($event.target).value); pwMsg.set('')"></label>
            <label class="st-f"><span>{{ 'New password' | t }}</span>
              <input class="st-in" type="password" autocomplete="new-password" [value]="pwNew()" (input)="pwNew.set($any($event.target).value); pwMsg.set('')"></label>
            <label class="st-f"><span>{{ 'Repeat the new password' | t }}</span>
              <input class="st-in" type="password" autocomplete="new-password" [value]="pwAgain()" (input)="pwAgain.set($any($event.target).value); pwMsg.set('')"></label>
          </div>
          <div class="pf-foot">
            @if (pwErr(); as e) { <span class="st-err">{{ e }}</span> }
            @else if (pwProblem(); as e) { <span class="st-hint">{{ e | t }}</span> }
            @else if (pwMsg(); as m) { <span class="st-msg">{{ m }}</span> }
            <button class="tcv-btn tcv-btn-accent" type="submit" [disabled]="!!pwProblem() || pwBusy()">
              {{ 'Change password' | t }}</button>
          </div>
        </form>
      </div>

      <div class="st-card">
        <div class="st-card-head"><h3>{{ 'Sessions' | t }}</h3>
          <span class="st-sub">{{ sessions().length }} {{ 'signed in' | t }}</span>
          <div class="st-right">
            @if (outMsg(); as m) { <span class="st-msg">{{ m }}</span> }
            <button class="tcv-btn tcv-files-btn" [disabled]="others() === 0 || outBusy()" (click)="signOutOthers()">
              {{ 'Sign out other sessions' | t }}</button>
          </div>
        </div>
        <div class="st-table-wrap">
          <table class="st-table pf-sessions">
            <thead><tr><th>{{ 'Device' | t }}</th><th>{{ 'Signed in' | t }}</th><th>{{ 'Last seen' | t }}</th><th></th></tr></thead>
            <tbody>
              @for (s of sessions(); track s.id) {
                <tr>
                  <td class="give">{{ s.device }}</td>
                  <td>{{ day(s.created_at) }} <span class="dim">{{ time(s.created_at) }}</span></td>
                  <td>{{ day(s.last_seen) }} <span class="dim">{{ time(s.last_seen) }}</span></td>
                  <td class="r">@if (s.here) { <span class="st-tag" data-tone="accent">{{ 'this one' | t }}</span> }</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </div>
    }
  }
</div>`,
})
export class ProfileSettingsPanel {
  private http = inject(HttpClient);
  private auth = inject(Auth);

  p = signal<Profile | null>(null);
  loadErr = signal('');
  name = signal('');
  email = signal('');
  emailPw = signal('');
  busy = signal(false);
  saved = signal(false);
  err = signal('');
  private savedTimer?: ReturnType<typeof setTimeout>;

  picBusy = signal(false);
  picErr = signal('');

  pwNow = signal('');
  pwNew = signal('');
  pwAgain = signal('');
  pwBusy = signal(false);
  pwErr = signal('');
  pwMsg = signal('');

  sessions = signal<Session[]>([]);
  outBusy = signal(false);
  outMsg = signal('');
  others = computed(() => this.sessions().filter(s => !s.here).length);

  emailChanged = computed(() => {
    const p = this.p();
    return !!p && p.kind === 'user' && this.email().trim().toLowerCase() !== (p.email ?? '');
  });
  dirty = computed(() => {
    const p = this.p();
    return !!p && (this.name().trim() !== p.name || this.emailChanged());
  });
  /** Why the password cannot be changed yet, while the boxes are filled in. */
  pwProblem = computed(() => {
    if (!this.pwNow() || !this.pwNew()) return 'Fill in your current and your new password.';
    if (this.pwNew().length < MIN_PASSWORD) return 'The new password needs at least 10 characters.';
    if (this.pwNew() !== this.pwAgain()) return 'The two new passwords are not the same.';
    return '';
  });

  constructor() { this.load(); }

  async load() {
    try {
      const p = await firstValueFrom(this.http.get<Profile>('/api/me'));
      this.take(p);
      if (p.kind === 'user') this.loadSessions();
    } catch (e) { this.loadErr.set(this.say(e)); }
  }

  private take(p: Profile) {
    this.p.set(p);
    this.name.set(p.name ?? '');
    this.email.set(p.email ?? '');
    this.emailPw.set('');
  }

  loadSessions() {
    this.http.get<{ sessions: Session[] }>('/api/me/sessions')
      .subscribe({ next: d => this.sessions.set(d.sessions), error: () => this.sessions.set([]) });
  }

  async save() {
    const p = this.p();
    if (!p) return;
    this.busy.set(true); this.err.set(''); this.saved.set(false);
    const body: Record<string, string> = { name: this.name().trim() };
    if (this.emailChanged()) { body['email'] = this.email().trim(); body['password'] = this.emailPw(); }
    try {
      this.take(await firstValueFrom(this.http.patch<Profile>('/api/me', body)));
      this.saved.set(true);
      clearTimeout(this.savedTimer);
      this.savedTimer = setTimeout(() => this.saved.set(false), 2500);
      this.auth.load();
    } catch (e) { this.err.set(this.say(e)); }
    this.busy.set(false);
  }

  async pick(ev: Event) {
    const box = ev.target as HTMLInputElement;
    const f = box.files?.[0];
    box.value = '';
    this.picErr.set('');
    if (!f) return;
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) { this.picErr.set(t('A PNG, JPG or WebP picture, please.')); return; }
    if (f.size > MAX_BYTES) { this.picErr.set(t('That picture is larger than 5 MB.')); return; }
    const fd = new FormData();
    fd.append('file', f);
    await this.picture(this.http.put<{ has_avatar: boolean; avatar_v: number | null }>('/api/me/avatar', fd));
  }

  async dropPicture() {
    await this.picture(this.http.delete<{ has_avatar: boolean; avatar_v: number | null }>('/api/me/avatar'));
  }

  private async picture(req: Observable<{ has_avatar: boolean; avatar_v: number | null }>) {
    this.picBusy.set(true);
    try {
      const r = await firstValueFrom(req);
      const p = this.p();
      if (p) this.p.set({ ...p, has_avatar: r.has_avatar, avatar_v: r.avatar_v });
      this.auth.load();
    } catch (e) { this.picErr.set(this.say(e)); }
    this.picBusy.set(false);
  }

  async changePassword() {
    if (this.pwProblem()) return;
    this.pwBusy.set(true); this.pwErr.set(''); this.pwMsg.set('');
    try {
      const r = await firstValueFrom(this.http.post<{ signed_out: number }>('/api/me/password',
        { current: this.pwNow(), new: this.pwNew() }));
      this.pwNow.set(''); this.pwNew.set(''); this.pwAgain.set('');
      this.pwMsg.set(t('Password changed.') + (r.signed_out ? ` ${t('Other sessions signed out:')} ${r.signed_out}` : ''));
      this.loadSessions();
    } catch (e) { this.pwErr.set(this.say(e)); }
    this.pwBusy.set(false);
  }

  async signOutOthers() {
    this.outBusy.set(true); this.outMsg.set('');
    try {
      const r = await firstValueFrom(this.http.post<{ signed_out: number }>('/api/me/sessions/revoke-others', {}));
      this.outMsg.set(`${t('Signed out:')} ${r.signed_out}`);
      this.loadSessions();
    } catch (e) { this.outMsg.set(this.say(e)); }
    this.outBusy.set(false);
  }

  noAccount(kind: Profile['kind']): string {
    if (kind === 'local') return 'Sign-in is off on this server: nobody has an account, so there is nothing to change here.';
    if (kind === 'agent') return 'This is an agent\'s token: it has no account, password or sessions of its own.';
    return 'A read-only page session: it can look at the profile, not change it.';
  }
  kindName(kind: Profile['kind']): string {
    return { user: 'person', local: 'local mode', agent: 'agent', page: 'page session' }[kind];
  }

  day(iso: string | null | undefined): string {
    if (!iso) return '-';
    const d = new Date(iso);
    return isNaN(+d) ? '-' : d.toLocaleDateString(LANG() === 'tr' ? 'tr-TR' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  time(iso: string | null | undefined): string {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(+d) ? '' : d.toLocaleTimeString(LANG() === 'tr' ? 'tr-TR' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  private say(e: unknown): string {
    const err = e as HttpErrorResponse;
    const d = err?.error?.detail;
    if (typeof d === 'string') return d;
    if (Array.isArray(d) && d[0]?.msg) return String(d[0].msg);
    return t('That did not work.');
  }
}
