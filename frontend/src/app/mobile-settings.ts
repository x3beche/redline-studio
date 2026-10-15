import { Component, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpEventType } from '@angular/common/http';
import { LANG, T, t } from './i18n';
import { Auth } from './auth';
import { qrPath } from './qr';

/** Settings > Mobile app: the Android app (github.com/x3beche/workbench-mobile),
 *  handed out by this server itself (backend/mobile_app.py). What it is,
 *  the latest build with a download button and a QR code of the same link
 *  for a phone to scan, the address to type into the app, how to install
 *  it - and, for the owner and the admins, a new build to upload. The
 *  download needs no sign-in: the phone is not signed in yet. */
interface Build {
  version: string; versionCode: number | null; size: number; sha256: string;
  built_at: string | null; published_at: string | null; min_sdk: number | null; min_android: string | null;
  abis: string[]; file: string; url: string;
}

const ICON_COPY = 'M9 9h11v11H9zM5 15V5a2 2 0 0 1 2-2h8';
const ICON_DONE = 'M5 12l5 5L19 7';

@Component({
  selector: 'app-mobile-settings',
  imports: [T],
  styleUrls: ['./settings.css', './mobile-settings.css'],
  template: `
<div class="st-page mb">
  <div class="st-card mb-top">
    <section>
      <div class="mb-name"><b>{{ 'Workbench for Android' | t }}</b><span>{{ 'iOS: not available yet' | t }}</span></div>
      <p class="mb-what">{{ 'The Chat on your phone: your conversations, the same models and tools, voice input - with the same account as here. It talks to this server and keeps no password on the phone.' | t }}</p>
      @if (build(); as b) {
        <div class="mb-facts">
          <div><span>{{ 'Version' | t }}</span><b>{{ b.version }}@if (b.versionCode !== null) { <span class="st-dim"> ({{ b.versionCode }})</span> }</b></div>
          <div><span>{{ 'Size' | t }}</span><b>{{ mb(b.size) }}</b></div>
          <div><span>{{ 'Built' | t }}</span><b>{{ day(b.built_at) }}</b></div>
          <div><span>{{ 'Needs Android' | t }}</span><b>{{ b.min_android || '7.0' }}+ <span class="st-dim">· {{ arch(b.abis) }}</span></b></div>
        </div>
        <div class="mb-sha">
          <span>SHA-256</span><code class="mono" [title]="b.sha256">{{ b.sha256 }}</code>
          <button type="button" class="mb-ico small" (click)="copy(b.sha256, 'sha')" [title]="'Copy' | t" [attr.aria-label]="'Copy' | t">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="copied() === 'sha' ? done : copyIco"/></svg></button>
        </div>
        <div class="mb-get">
          <a class="mb-download" [href]="b.url" [attr.download]="b.file">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>
            {{ 'Download the APK' | t }} <small>{{ mb(b.size) }}</small></a>
          <span class="st-sub">{{ 'No sign-in needed: open this page on the phone, or scan the code.' | t }}</span>
        </div>
      } @else if (missing()) {
        <p class="st-hint">{{ 'No Android build is published on this server yet.' | t }}@if (canUpload) { {{ 'Upload one below.' | t }} }</p>
      } @else if (error(); as e) {
        <p class="st-err">{{ e }}</p>
      } @else { <p class="st-hint">…</p> }
    </section>
    <section class="mb-addr">
      <span class="mb-sec">{{ 'Server address to enter in the app' | t }}</span>
      <div class="mb-field">
        <code class="mono">{{ origin }}</code>
        <button type="button" class="mb-ico" (click)="copy(origin, 'addr')" [title]="'Copy address' | t" [attr.aria-label]="'Copy address' | t">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="copied() === 'addr' ? done : copyIco"/></svg></button>
      </div>
      <span class="st-sub">{{ 'The app asks for it on its first start, then for your e-mail and password - the ones you sign in with here.' | t }}</span>
    </section>
    @if (build() && qr(); as q) {
      <section class="mb-qr">
        <svg [attr.viewBox]="'0 0 ' + q.size + ' ' + q.size" role="img" [attr.aria-label]="'QR code of the download link' | t" shape-rendering="crispEdges"><path [attr.d]="q.d"/></svg>
        <span class="st-sub">{{ 'Scan with the phone\\'s camera to download' | t }}</span>
      </section>
    }
  </div>

  <div class="st-card">
    <div class="st-card-head"><h3>{{ 'Install' | t }}</h3><span class="st-sub">{{ 'on the phone, once' | t }}</span></div>
    <ol class="mb-steps">
      @for (s of steps; track s.what; let i = $index) {
        <li><span class="mb-n">{{ i + 1 }}</span><div class="mb-step"><b>{{ s.what | t }}</b><span>{{ s.how | t }}</span></div></li>
      }
    </ol>
    <div class="mb-notes">
      <p><b>{{ 'Updating' | t }}</b> · {{ 'download the new APK the same way and install it over the old one; you stay signed in.' | t }}</p>
      <p><b>{{ 'Not from the Play Store' | t }}</b> · {{ 'the APK is signed with a debug key, so Android asks once whether to allow installing it. Play Protect may ask to scan it.' | t }}</p>
      <p><b>{{ 'Source' | t }}</b> · {{ 'open source, at' | t }} <code class="mono">github.com/x3beche/workbench-mobile</code></p>
    </div>
  </div>

  @if (canUpload) {
    <div class="st-card">
      <div class="st-card-head"><h3>{{ 'Upload a new build' | t }}</h3>
        <span class="st-sub">{{ 'an APK of at most 150 MB; its version is read from it. It replaces the download above at once.' | t }}</span></div>
      <div class="mb-up">
        <input #pick type="file" accept=".apk,application/vnd.android.package-archive" [attr.aria-label]="'APK file' | t"
               (change)="file.set(pick.files?.[0] ?? null)" [disabled]="busy()">
        <input class="st-in" [placeholder]="'Version' | t" [value]="ver()" (input)="ver.set($any($event.target).value)"
               [attr.aria-label]="'Version' | t" [title]="'Only if the APK does not say it' | t" [disabled]="busy()">
        <input class="st-in" placeholder="versionCode" inputmode="numeric" [value]="code()" (input)="code.set($any($event.target).value)"
               aria-label="versionCode" [title]="'Only if the APK does not say it' | t" [disabled]="busy()">
        <button type="button" class="tcv-btn tcv-btn-accent" [disabled]="!file() || busy()" (click)="upload(pick)">
          {{ busy() ? ('Uploading…' | t) + ' ' + progress() + '%' : ('Upload' | t) }}</button>
        @if (upMsg(); as m) { <span class="st-msg">{{ m }}</span> }
        @if (upErr(); as e) { <span class="st-err">{{ e }}</span> }
      </div>
    </div>
  }
</div>`,
})
export class MobileSettings {
  private http = inject(HttpClient);
  private auth = inject(Auth);
  readonly canUpload = this.auth.can('settings');
  readonly origin = location.origin;
  readonly copyIco = ICON_COPY;
  readonly done = ICON_DONE;
  build = signal<Build | null>(null);
  missing = signal(false);
  error = signal('');
  copied = signal<'sha' | 'addr' | null>(null);
  /** The QR code of the absolute download link. */
  qr = computed(() => {
    const b = this.build();
    try { return b ? qrPath(new URL(b.url, location.origin).href) : null; } catch { return null; }
  });
  readonly steps = [
    { what: 'Open the link on the phone', how: 'Scan the code, or open this page on the phone and tap Download.' },
    { what: 'Allow this source', how: 'Android asks to allow installs from the browser or Files: allow it, then Install.' },
    { what: 'Open Workbench', how: 'It is with your other apps.' },
    { what: 'Enter the server address', how: 'The address above, as it is written.' },
    { what: 'Sign in', how: 'With your e-mail and password, as here.' },
  ];
  // the upload
  file = signal<File | null>(null);
  ver = signal('');
  code = signal('');
  busy = signal(false);
  progress = signal(0);
  upMsg = signal('');
  upErr = signal('');

  constructor() { this.load(); }

  load() {
    this.http.get<Build>('/api/public/m/app.json').subscribe({
      next: b => { this.build.set(b); this.missing.set(false); this.error.set(''); },
      error: (e: HttpErrorResponse) => {
        this.build.set(null);
        if (e.status === 404) this.missing.set(true); else this.error.set(this.why(e));
      },
    });
  }

  upload(pick: HTMLInputElement) {
    const f = this.file();
    if (!f) return;
    const body = new FormData();
    body.append('file', f, f.name);
    if (this.ver().trim()) body.append('version', this.ver().trim());
    if (this.code().trim()) body.append('version_code', this.code().trim());
    this.busy.set(true); this.progress.set(0); this.upMsg.set(''); this.upErr.set('');
    this.http.post<Build>('/api/mobile/apk', body, { reportProgress: true, observe: 'events' }).subscribe({
      next: ev => {
        if (ev.type === HttpEventType.UploadProgress && ev.total) this.progress.set(Math.round(100 * ev.loaded / ev.total));
        if (ev.type === HttpEventType.Response && ev.body) {
          const b = ev.body;
          this.busy.set(false);
          this.build.set(b); this.missing.set(false);
          this.upMsg.set(`${t('Published')}: ${b.version}${b.versionCode !== null ? ' (' + b.versionCode + ')' : ''} · ${this.mb(b.size)}`);
          this.file.set(null); this.ver.set(''); this.code.set('');
          pick.value = '';
        }
      },
      error: (e: HttpErrorResponse) => { this.busy.set(false); this.upErr.set(this.why(e)); },
    });
  }

  copy(text: string, what: 'sha' | 'addr') {
    navigator.clipboard?.writeText(text).then(() => {
      this.copied.set(what);
      setTimeout(() => this.copied.set(null), 1500);
    });
  }

  mb(bytes: number) { return `${(bytes / 1e6).toFixed(1)} MB`; }
  day(iso: string | null) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString(LANG() === 'tr' ? 'tr-TR' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  /** arm64-v8a -> arm64. */
  arch(abis: string[]) { return abis.length ? abis.map(a => a.replace('-v8a', '').replace('armeabi-v7a', 'arm32')).join(', ') : t('any CPU'); }
  private why(e: HttpErrorResponse) {
    if (e.status === 413) return t('The file is too large (at most 150 MB).');
    return typeof e.error?.detail === 'string' ? e.error.detail : t('that did not work');
  }
}
