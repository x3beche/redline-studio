import { Component, ElementRef, afterRenderEffect, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable, firstValueFrom } from 'rxjs';
import { LANG, T, t } from './i18n';
import { Auth } from './auth';
import { Avatar } from './avatar';
import { reportError } from './error-report';

/** Settings > Admin panel: the accounts on this server (backend/admin.py),
 *  for the owner and the admins - opened from the account menu.
 *
 *  There is no sign-up and there are no invitations: an account is added
 *  here, with a first password the person changes when they first sign in.
 *  Each account works in a private space of its own. The owner (the first
 *  account) changes roles and deletes accounts; an admin manages the users'
 *  accounts - not the owner's, not another admin's. The server says no to
 *  anything else; the page only does not offer it. */
export interface AdminUser {
  id: string; name: string; email: string; role: 'owner' | 'admin' | 'user';
  disabled: boolean; must_change_password: boolean;
  created_at: string | null; last_sign_in: string | null;
  sessions: number; tokens: number; me: boolean;
  has_avatar: boolean; avatar_v: number | null;
}
interface Listing { users: AdminUser[]; me: string; my_role: 'owner' | 'admin'; roles: string[]; about: Record<string, string> }

const MAX_BYTES = 5 * 1024 * 1024;
const MIN_PASSWORD = 10;

@Component({
  selector: 'app-admin-users',
  imports: [T, Avatar],
  styleUrls: ['./settings.css', './profile-settings.css', './admin-users.css'],
  template: `
<div class="st-page">
  @if (!data()) {
    @if (loadErr(); as e) {
      <p class="st-err">{{ e }}</p>
    } @else {
      <div class="st-card um-skel" aria-busy="true" [attr.aria-label]="'Loading the accounts' | t">
        <div class="st-card-head"><i class="sk" style="width: 80px"></i><span class="st-right"><i class="sk sk-btn"></i></span></div>
        <div class="st-card-body">
          <div class="st-tiles um-tiles">@for (i of [1, 2, 3, 4]; track i) { <i class="sk sk-tile"></i> }</div>
          @for (i of [1, 2, 3, 4]; track i) {
            <div class="um-skel-row"><i class="sk sk-av"></i><i class="sk" style="width: 30%"></i><i class="sk" style="width: 12%"></i><i class="sk" style="width: 14%"></i></div>
          }
        </div>
      </div>
    }
  } @else if (data(); as d) {
    @if (editing(); as u) {
      <!-- One account: its profile, its access, its password, its sessions. -->
      <div class="um-back">
        <button class="tcv-btn tcv-files-btn" (click)="close()">← {{ 'All users' | t }}</button>
        <span class="st-sub">{{ u.email }}</span>
      </div>

      <div class="st-card">
        <div class="st-card-head"><h3>{{ 'Profile' | t }}</h3>
          <span class="st-tag" [attr.data-tone]="roleTone(u.role)">{{ u.role | t }}</span>
          @if (u.disabled) { <span class="st-tag" data-tone="danger">{{ 'disabled' | t }}</span> }
          @if (u.me) { <span class="st-tag">{{ 'you' | t }}</span> }</div>
        <form class="st-card-body" (submit)="$event.preventDefault(); saveProfile(u)">
          <div class="pf-top">
            <div class="pf-pic">
              <app-avatar [name]="eName() || u.name" [userId]="u.id" [hasPicture]="u.has_avatar" [v]="u.avatar_v" [size]="88" />
              @if (mayManage(u)) {
                <div class="pf-pic-acts">
                  <label class="tcv-btn tcv-files-btn pf-file" [attr.data-busy]="picBusy() ? 1 : null">
                    {{ (u.has_avatar ? 'Change picture' : 'Upload picture') | t }}
                    <input type="file" accept="image/png,image/jpeg,image/webp" [disabled]="picBusy()" (change)="pick(u, $event)">
                  </label>
                  @if (u.has_avatar) {
                    <button type="button" class="tcv-btn tcv-files-btn" [disabled]="picBusy()" (click)="dropPicture(u)">{{ 'Remove' | t }}</button>
                  }
                </div>
                @if (picErr(); as e) { <span class="st-err">{{ e }}</span> }
              }
            </div>
            <div class="pf-fields">
              <div class="st-grid pf-grid">
                <label class="st-f"><span>{{ 'Display name' | t }}</span>
                  <input class="st-in" [value]="eName()" maxlength="80" [disabled]="!mayManage(u)"
                         (input)="eName.set($any($event.target).value); msg.set('')"></label>
                <label class="st-f"><span>{{ 'Email' | t }}</span>
                  <input class="st-in" type="email" [value]="eEmail()" maxlength="200" [disabled]="!mayManage(u)"
                         (input)="eEmail.set($any($event.target).value); msg.set('')"></label>
              </div>
              <div class="st-tiles pf-tiles">
                <div class="st-tile"><span>{{ 'Last sign-in' | t }}</span><b>{{ day(u.last_sign_in) }}</b><small>{{ time(u.last_sign_in) }}</small></div>
                <div class="st-tile"><span>{{ 'Created' | t }}</span><b>{{ day(u.created_at) }}</b><small>{{ time(u.created_at) }}</small></div>
                <div class="st-tile"><span>{{ 'Sessions' | t }}</span><b>{{ u.sessions }}</b><small>{{ 'signed in now' | t }}</small></div>
                <div class="st-tile"><span>{{ 'Agent tokens' | t }}</span><b>{{ u.tokens }}</b><small>{{ (u.disabled ? 'stopped' : 'working') | t }}</small></div>
              </div>
            </div>
          </div>
          @if (mayManage(u)) {
            <div class="pf-foot">
              @if (err(); as e) { <span class="st-err">{{ e }}</span> } @else if (msg(); as m) { <span class="st-msg">{{ m }}</span> }
              <button class="tcv-btn tcv-btn-accent" type="submit" [disabled]="!profileDirty(u) || busy() || !eName().trim()">{{ 'Save' | t }}</button>
            </div>
          } @else {
            <p class="st-hint">{{ 'An admin manages the users\\' accounts - only the owner changes this one.' | t }}</p>
          }
        </form>
      </div>

      @if (mayManage(u)) {
        <div class="st-card">
          <div class="st-card-head"><h3>{{ 'Access' | t }}</h3>
            <span class="st-sub">{{ d.about[u.role] }}</span></div>
          <div class="st-card-body">
            <div class="um-line">
              <div class="um-line-text"><b>{{ 'Role' | t }}</b>
                <span class="st-hint">{{ (u.role === 'owner' ? 'The owner stays the owner: there is one, and it cannot be demoted.' : d.my_role === 'owner' ? 'An admin runs the server\\'s settings and the users\\' accounts.' : 'Only the owner changes roles.') | t }}</span></div>
              <div class="st-seg">
                @for (r of ['admin', 'user']; track r) {
                  <button [class.on]="u.role === r" [disabled]="d.my_role !== 'owner' || u.role === 'owner' || busy()"
                          (click)="patch(u, { role: r }, 'Role changed.')">{{ r | t }}</button>
                }
              </div>
            </div>
            <div class="um-line">
              <div class="um-line-text"><b>{{ 'Status' | t }}</b>
                <span class="st-hint">{{ 'A disabled account cannot sign in; its sessions end at once and its agent tokens stop working.' | t }}</span></div>
              @if (u.disabled) {
                <button class="tcv-btn" [disabled]="busy()" (click)="patch(u, { disabled: false }, 'Enabled.')">{{ 'Enable' | t }}</button>
              } @else {
                <button class="tcv-btn" [disabled]="busy() || u.role === 'owner' || u.me" (click)="disable(u)">{{ 'Disable' | t }}</button>
              }
            </div>
            <div class="um-line">
              <div class="um-line-text"><b>{{ 'Sessions' | t }}</b>
                <span class="st-hint">{{ u.sessions }} {{ 'signed in now. Signing out ends every one of them, on every device.' | t }}</span></div>
              <button class="tcv-btn" [disabled]="busy() || !u.sessions" (click)="signOut(u)">{{ 'Sign out everywhere' | t }}</button>
            </div>
            @if (accessMsg(); as m) { <p class="st-msg">{{ m }}</p> }
          </div>
        </div>

        <div class="st-card">
          <div class="st-card-head"><h3>{{ 'Reset password' | t }}</h3>
            <span class="st-sub">{{ 'A temporary password: every session ends, and they choose their own at the next sign-in.' | t }}</span></div>
          <form class="st-card-body" (submit)="$event.preventDefault(); resetPassword(u)">
            <div class="st-grid um-pw">
              <label class="st-f"><span>{{ 'Temporary password' | t }}</span>
                <input class="st-in mono" type="text" autocomplete="off" spellcheck="false" [value]="pw()" (input)="pw.set($any($event.target).value); pwMsg.set('')"></label>
              <button type="button" class="tcv-btn tcv-files-btn um-gen" (click)="pw.set(generate())">{{ 'Generate' | t }}</button>
            </div>
            <label class="um-check"><input type="checkbox" [checked]="pwForce()" (change)="pwForce.set($any($event.target).checked)">
              {{ 'Must change the password at the next sign-in' | t }}</label>
            <div class="pf-foot">
              @if (pwMsg(); as m) { <span [class]="pwOk() ? 'st-msg' : 'st-err'">{{ m }}</span> }
              @else if (pw() && pw().length < 10) { <span class="st-hint">{{ 'At least 10 characters.' | t }}</span> }
              <button class="tcv-btn tcv-btn-accent" type="submit" [disabled]="pw().length < 10 || busy()">{{ 'Set the password' | t }}</button>
            </div>
          </form>
        </div>

        @if (d.my_role === 'owner' && u.role !== 'owner' && !u.me) {
          <div class="st-card">
            <div class="st-card-head"><h3>{{ 'Delete user' | t }}</h3>
              <span class="st-sub">{{ 'For good: the account, its sessions, agent tokens and Telegram link.' | t }}</span></div>
            <div class="st-card-body">
              @if (holds(); as n) {
                <p class="st-hint">{{ delErr() }}</p>
                <label class="um-check"><input type="checkbox" [checked]="withData()" (change)="withData.set($any($event.target).checked)">
                  {{ 'Delete their data too' | t }} ({{ n }})</label>
              } @else if (delErr(); as e) { <p class="st-err">{{ e }}</p> }
              <div class="pf-foot">
                <span class="st-hint">{{ 'Disabling keeps everything and can be undone.' | t }}</span>
                <button class="tcv-btn um-danger" [disabled]="busy() || (holds() > 0 && !withData())" (click)="remove(u)">{{ 'Delete user' | t }}</button>
              </div>
            </div>
          </div>
        }
      }
    } @else if (adding()) {
      <div class="um-back">
        <button class="tcv-btn tcv-files-btn" (click)="adding.set(false)">← {{ 'All users' | t }}</button>
      </div>
      <div class="st-card">
        <div class="st-card-head"><h3>{{ 'Add user' | t }}</h3>
          <span class="st-sub">{{ 'A new account starts as a user, with an empty private space of its own.' | t }}</span></div>
        <form class="st-card-body" (submit)="$event.preventDefault(); add()">
          <div class="st-grid um-add">
            <label class="st-f"><span>{{ 'Name' | t }}</span>
              <input class="st-in" [value]="nName()" maxlength="80" autocomplete="off" (input)="nName.set($any($event.target).value)"></label>
            <label class="st-f"><span>{{ 'Email' | t }}</span>
              <input class="st-in" type="email" [value]="nEmail()" maxlength="200" autocomplete="off" (input)="nEmail.set($any($event.target).value)"></label>
            <label class="st-f"><span>{{ 'Initial password' | t }}</span>
              <span class="um-pw-in">
                <input class="st-in mono" type="text" autocomplete="off" spellcheck="false" [value]="nPw()" (input)="nPw.set($any($event.target).value)">
                <button type="button" class="tcv-btn tcv-files-btn" (click)="nPw.set(generate())">{{ 'Generate' | t }}</button>
              </span></label>
          </div>
          <label class="um-check"><input type="checkbox" [checked]="nForce()" (change)="nForce.set($any($event.target).checked)">
            {{ 'Must change the password at first sign-in' | t }}</label>
          <p class="st-hint">{{ 'Redline sends no email: pass the address and the password on yourself.' | t }}</p>
          <div class="pf-foot">
            @if (err(); as e) { <span class="st-err">{{ e }}</span> }
            @else if (nPw() && nPw().length < 10) { <span class="st-hint">{{ 'At least 10 characters.' | t }}</span> }
            <button type="button" class="tcv-btn" (click)="adding.set(false)">{{ 'Cancel' | t }}</button>
            <button class="tcv-btn tcv-btn-accent" type="submit" [disabled]="busy() || !nEmail().trim() || nPw().length < 10">{{ 'Add user' | t }}</button>
          </div>
        </form>
      </div>
    } @else {
      <div class="st-card">
        <div class="st-card-head"><h3>{{ 'Users' | t }}</h3>
          <span class="st-sub">{{ d.users.length }} {{ 'accounts' | t }}</span>
          <div class="st-right">
            <input class="st-in um-find" type="search" [placeholder]="'Find a name or address' | t" [value]="q()" (input)="q.set($any($event.target).value)">
            <button class="tcv-btn tcv-btn-accent" (click)="startAdd()">+ {{ 'Add user' | t }}</button>
          </div>
        </div>
        <div class="st-card-body">
          <div class="st-tiles um-tiles">
            <div class="st-tile"><span>{{ 'Accounts' | t }}</span><b>{{ d.users.length }}</b></div>
            <div class="st-tile" data-tone="ok"><span>{{ 'Active' | t }}</span><b>{{ counts().active }}</b></div>
            <div class="st-tile" [attr.data-tone]="counts().disabled ? 'danger' : 'dim'"><span>{{ 'Disabled' | t }}</span><b>{{ counts().disabled }}</b></div>
            <div class="st-tile"><span>{{ 'Owner and admins' | t }}</span><b>{{ counts().admins }}</b></div>
          </div>
          @if (listMsg(); as m) { <p class="st-msg">{{ m }}</p> }
        </div>
        <!-- Plain rows, not a table: Chrome 154 drew a table inside its
             scrolling wrapper at no height at all on one screen. Each row
             flows: the person, then what they are and when they were last
             here, wrapping under the name when the stage is narrow. -->
        <div class="um-list">
          @for (u of shown(); track u.id) {
            <div class="um-row" tabindex="0" (click)="open(u)" (keydown.enter)="open(u)">
              <span class="um-who">
                <app-avatar [name]="u.name" [userId]="u.id" [hasPicture]="u.has_avatar" [v]="u.avatar_v" [size]="28" />
                <span class="um-who-text"><b>{{ u.name }}@if (u.me) { <span class="st-tag">{{ 'you' | t }}</span> }</b>
                  <small>{{ u.email }}</small></span>
              </span>
              <span class="um-meta">
                <span class="st-tag" [attr.data-tone]="roleTone(u.role)">{{ u.role | t }}</span>
                @if (u.disabled) { <span class="st-tag" data-tone="danger">{{ 'disabled' | t }}</span> }
                @else { <span class="st-tag" data-tone="ok">{{ 'active' | t }}</span> }
                @if (u.must_change_password) { <span class="st-tag" data-tone="warn" [title]="'Must change the password at the next sign-in' | t">{{ 'new password' | t }}</span> }
                <span class="um-when" [title]="('Created' | t) + ' ' + day(u.created_at)">
                  {{ 'Last sign-in' | t }}: {{ u.last_sign_in ? day(u.last_sign_in) + ' ' + time(u.last_sign_in) : '-' }}</span>
              </span>
              <button class="tcv-btn tcv-files-btn um-edit" (click)="$event.stopPropagation(); open(u)">{{ 'Edit' | t }}</button>
            </div>
          } @empty {
            <div class="st-empty">{{ 'Nobody matches.' | t }}</div>
          }
        </div>
      </div>
    }
  }
</div>`,
})
export class AdminUsersPanel {
  private http = inject(HttpClient);
  private auth = inject(Auth);

  data = signal<Listing | null>(null);
  loadErr = signal('');
  q = signal('');
  listMsg = signal('');
  editingId = signal<string | null>(null);
  editing = computed(() => this.data()?.users.find(u => u.id === this.editingId()) ?? null);
  adding = signal(false);
  busy = signal(false);
  err = signal('');
  msg = signal('');
  accessMsg = signal('');

  eName = signal('');
  eEmail = signal('');
  picBusy = signal(false);
  picErr = signal('');
  pw = signal('');
  pwForce = signal(true);
  pwMsg = signal('');
  pwOk = signal(false);
  holds = signal(0);
  withData = signal(false);
  delErr = signal('');

  nName = signal('');
  nEmail = signal('');
  nPw = signal('');
  nForce = signal(true);

  shown = computed(() => {
    const q = this.q().trim().toLowerCase();
    const all = this.data()?.users ?? [];
    return q ? all.filter(u => (u.name + ' ' + u.email).toLowerCase().includes(q)) : all;
  });
  counts = computed(() => {
    const all = this.data()?.users ?? [];
    return { active: all.filter(u => !u.disabled).length, disabled: all.filter(u => u.disabled).length,
             admins: all.filter(u => u.role !== 'user').length };
  });

  private host = inject(ElementRef<HTMLElement>);
  private told = false;

  constructor() {
    this.load();
    // The list came but no row is on screen: tell the server what this
    // browser made of it, once - a panel that draws for everyone else.
    afterRenderEffect(() => {
      const d = this.data();
      if (!d?.users?.length || this.editing() || this.told) return;
      setTimeout(() => {
        const el: HTMLElement = this.host.nativeElement;
        const rows = el.querySelectorAll('.um-list .um-row').length;
        const wrap = el.querySelector('.um-list') as HTMLElement | null;
        const box = wrap?.getBoundingClientRect();
        if (rows && box && box.height > 20 && wrap && getComputedStyle(wrap).display !== 'none') return;
        this.told = true;
        reportError({ message: `admin panel: ${d.users.length} users but ${rows} rows drawn`,
          stack: JSON.stringify({ wrap: !!wrap, display: wrap ? getComputedStyle(wrap).display : null,
            w: box?.width, h: box?.height, vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio,
            adding: this.adding(), q: this.q(), html: el.innerHTML.length,
            tail: el.innerHTML.slice(-600) }) }, 'diag');
      }, 800);
    });
  }

  async load() {
    try { this.data.set(await firstValueFrom(this.http.get<Listing>('/api/admin/users'))); }
    catch (e) { this.loadErr.set(this.say(e)); }
  }

  /** The owner manages everyone; an admin, the users and themselves. */
  mayManage(u: AdminUser) { return this.data()?.my_role === 'owner' || u.me || u.role === 'user'; }
  roleTone(r: string) { return r === 'owner' ? 'accent' : r === 'admin' ? 'warn' : null; }

  open(u: AdminUser) {
    this.editingId.set(u.id);
    this.eName.set(u.name); this.eEmail.set(u.email);
    for (const s of [this.err, this.msg, this.accessMsg, this.picErr, this.pwMsg, this.delErr, this.listMsg]) s.set('');
    this.pw.set(''); this.pwForce.set(true); this.holds.set(0); this.withData.set(false);
  }
  close() { this.editingId.set(null); }

  startAdd() {
    this.adding.set(true); this.err.set('');
    this.nName.set(''); this.nEmail.set(''); this.nPw.set(this.generate()); this.nForce.set(true);
  }

  profileDirty(u: AdminUser) { return this.eName().trim() !== u.name || this.eEmail().trim().toLowerCase() !== u.email; }

  /** A row back from the server, put in the list. */
  private take(u: AdminUser) {
    const d = this.data();
    if (d) this.data.set({ ...d, users: d.users.map(x => x.id === u.id ? u : x) });
    if (u.me) this.auth.load();
  }

  async saveProfile(u: AdminUser) {
    const body: Record<string, string> = {};
    if (this.eName().trim() !== u.name) body['name'] = this.eName().trim();
    if (this.eEmail().trim().toLowerCase() !== u.email) body['email'] = this.eEmail().trim();
    this.busy.set(true); this.err.set(''); this.msg.set('');
    try {
      const got = await firstValueFrom(this.http.patch<AdminUser>(`/api/admin/users/${u.id}`, body));
      this.take(got); this.eName.set(got.name); this.eEmail.set(got.email);
      this.msg.set(t('Saved'));
    } catch (e) { this.err.set(this.say(e)); }
    this.busy.set(false);
  }

  async patch(u: AdminUser, body: Record<string, unknown>, done: string) {
    this.busy.set(true); this.accessMsg.set('');
    try {
      this.take(await firstValueFrom(this.http.patch<AdminUser>(`/api/admin/users/${u.id}`, body)));
      this.accessMsg.set(t(done));
    } catch (e) { this.accessMsg.set(this.say(e)); }
    this.busy.set(false);
  }

  disable(u: AdminUser) {
    if (!confirm(t('Disable this account? It is signed out everywhere at once and its agent tokens stop working.') + `\n\n${u.name} <${u.email}>`)) return;
    this.patch(u, { disabled: true }, 'Disabled: signed out everywhere, its agent tokens stopped.');
  }

  async signOut(u: AdminUser) {
    this.busy.set(true); this.accessMsg.set('');
    try {
      const r = await firstValueFrom(this.http.post<AdminUser & { signed_out: number }>(`/api/admin/users/${u.id}/sign-out`, {}));
      this.take(r);
      this.accessMsg.set(`${t('Signed out:')} ${r.signed_out}`);
    } catch (e) { this.accessMsg.set(this.say(e)); }
    this.busy.set(false);
  }

  async resetPassword(u: AdminUser) {
    if (this.pw().length < MIN_PASSWORD) return;
    this.busy.set(true); this.pwMsg.set('');
    try {
      const r = await firstValueFrom(this.http.post<AdminUser & { signed_out: number }>(`/api/admin/users/${u.id}/password`,
        { password: this.pw(), must_change_password: this.pwForce() }));
      this.take(r);
      this.pwOk.set(true);
      this.pwMsg.set(t('Password set. Pass it on yourself.') + (r.signed_out ? ` ${t('Signed out:')} ${r.signed_out}` : ''));
    } catch (e) { this.pwOk.set(false); this.pwMsg.set(this.say(e)); }
    this.busy.set(false);
  }

  async pick(u: AdminUser, ev: Event) {
    const box = ev.target as HTMLInputElement;
    const f = box.files?.[0];
    box.value = '';
    this.picErr.set('');
    if (!f) return;
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) { this.picErr.set(t('A PNG, JPG or WebP picture, please.')); return; }
    if (f.size > MAX_BYTES) { this.picErr.set(t('That picture is larger than 5 MB.')); return; }
    const fd = new FormData();
    fd.append('file', f);
    await this.picture(this.http.put<AdminUser>(`/api/admin/users/${u.id}/avatar`, fd));
  }

  async dropPicture(u: AdminUser) { await this.picture(this.http.delete<AdminUser>(`/api/admin/users/${u.id}/avatar`)); }

  private async picture(req: Observable<AdminUser>) {
    this.picBusy.set(true);
    try { this.take(await firstValueFrom(req)); } catch (e) { this.picErr.set(this.say(e)); }
    this.picBusy.set(false);
  }

  async remove(u: AdminUser) {
    const data = this.holds() > 0 && this.withData();
    if (!confirm(t('Delete this account for good?') + `\n\n${u.name} <${u.email}>` + (data ? '\n\n' + t('Their data is deleted too.') : ''))) return;
    this.busy.set(true); this.delErr.set('');
    try {
      await firstValueFrom(this.http.delete(`/api/admin/users/${u.id}` + (data ? '?with_data=1' : '')));
      const d = this.data();
      if (d) this.data.set({ ...d, users: d.users.filter(x => x.id !== u.id) });
      this.close();
      this.listMsg.set(`${t('Deleted:')} ${u.name}`);
    } catch (e) {
      const err = e as HttpErrorResponse;
      const m = /holds (\d+) items/.exec(String(err?.error?.detail ?? ''));
      if (err?.status === 409 && m) this.holds.set(+m[1]);
      this.delErr.set(this.say(e));
    }
    this.busy.set(false);
  }

  async add() {
    this.busy.set(true); this.err.set('');
    try {
      const u = await firstValueFrom(this.http.post<AdminUser>('/api/admin/users', {
        name: this.nName().trim(), email: this.nEmail().trim(), password: this.nPw(),
        must_change_password: this.nForce() }));
      const d = this.data();
      if (d) this.data.set({ ...d, users: [...d.users, u] });
      this.adding.set(false);
      this.listMsg.set(`${t('Added:')} ${u.name} <${u.email}>`);
    } catch (e) { this.err.set(this.say(e)); }
    this.busy.set(false);
  }

  /** A password to pass on: 14 letters and digits that do not look alike. */
  generate(): string {
    const abc = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const got = crypto.getRandomValues(new Uint32Array(14));
    return Array.from(got, n => abc[n % abc.length]).join('');
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
