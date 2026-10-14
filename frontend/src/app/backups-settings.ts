import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { T, t } from './i18n';
import { fmt } from './rooms/charts';
import { Confirm } from './confirm';
import { Toast } from './toast';
import { Skeleton } from './skeleton';

/** Settings > Backups (backend/backups.py), for the owner and the admins:
 *  the mongodb stack's nightly dumps as they are on the disk - the archives
 *  and when each one goes, the dump log, the restore checks and what the
 *  last one compared, the disk, and the secret key that is not in them.
 *  The restore check runs from here; the owner downloads and deletes. */
interface Archive {
  name: string; size: number; mtime: number; kind: 'nightly' | 'manual'; newest: boolean; age_s: number;
  expires: number | null; plaintext: boolean | null; plaintext_by: 'check' | 'key-age' | null;
  check: { ok: boolean; at: string } | null;
}
interface Count { name: string; dump: number | null; live: number | null; new: boolean; bad: boolean }
interface Check {
  at: string; ts: number | null; ok: boolean; archive: string; message: string; duration_s: number | null;
  reasons: string[]; counts: Count[];
  secrets: { dump_sealed: number; dump: number; live_sealed: number | null; live: number | null } | null;
  collections: { dump: number; live: number } | null; not_in_dump: string[];
}
interface Dump { at: string; ts: number | null; ok: boolean; archive: string | null; size: string | null }
interface Run {
  id?: string; started?: number; by?: string; running: boolean; rc?: number | null; lost?: boolean;
  finished?: number | null; lines?: string[];
}
interface Key {
  source: 'env' | 'file'; env: string; path: string | null; rel?: string; exists: boolean;
  created: number | null; fingerprint: string | null; mode: string | null;
}
interface BkState {
  container: { found: boolean; running: boolean; host_dir: string | null; wired: boolean; script_mounted: boolean; status?: string };
  schedule: { at: string; keep_days: number; tz: string; weekly_check: number | null; source: 'container' | 'default' };
  key: Key; setup: { volume: string | null; loop: string | null; service: string | null };
  where: string; error: string | null; now?: number; next_dump?: number;
  archives: Archive[]; dumps: Dump[]; checks: Check[]; writing: { name: string; size: number; mtime: number }[];
  prom: { success?: boolean; last_run?: number | null; last_success?: number | null; documents?: number; duration_s?: number | null };
  disk: { archives: number; nightly: number; dir: number; size?: number; used?: number; free?: number; mount?: string; steady?: number | null } | null;
  health?: { dump_ok: boolean; newest_age_s: number | null; fresh: boolean; check_ok: boolean | null; plaintext: number };
  run: Run | null; owner: boolean;
}

const DAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

@Component({
  selector: 'app-backups-settings',
  imports: [T, Skeleton],
  styleUrls: ['./settings.css', './backups-settings.css'],
  template: `
<div class="st-page bk">
  @if (error(); as e) { <div class="st-banner" role="alert">{{ e }}</div> }
  @if (s(); as d) {
    @if (d.error) { <div class="st-banner">{{ 'The backup folder could not be read' | t }}: {{ d.error | t }}</div> }

    <!-- ---------------- the state, in one band ---------------- -->
    <div class="st-card bk-now">
      <div class="bk-verdict" [attr.data-tone]="verdict().tone">
        <span class="bk-dot" aria-hidden="true"></span>
        <div class="bk-verdict-text"><b>{{ verdict().title | t }}</b><span>{{ verdict().sub }}</span></div>
      </div>
      <dl class="bk-figs">
        <div><dt>{{ 'Last dump' | t }}</dt>
          @if (d.dumps[0]; as l) {
            <dd [attr.data-tone]="l.ok ? null : 'danger'">{{ l.ok ? short(l.at) : ('failed' | t) }}
              <small>{{ l.ok ? (l.size ? l.size + 'B · ' : '') + ago(l.ts) : short(l.at) }}</small></dd>
          } @else { <dd class="dim">–<small>{{ 'nothing in the log' | t }}</small></dd> }
        </div>
        <div><dt>{{ 'Next dump' | t }}</dt>
          <dd>{{ d.next_dump ? short(d.next_dump) : d.schedule.at }}<small>{{ d.next_dump ? inn(d.next_dump) : ('nightly at' | t) + ' ' + d.schedule.at }}</small></dd></div>
        <div><dt>{{ 'Kept' | t }}</dt>
          <dd>{{ d.schedule.keep_days }} {{ 'days' | t }}<small>{{ nightly().length }} {{ 'nightly' | t }} · {{ manual().length }} {{ 'by hand' | t }}</small></dd></div>
        <div><dt>{{ 'Restore check' | t }}</dt>
          @if (d.checks[0]; as c) {
            <dd [attr.data-tone]="c.ok ? 'ok' : 'danger'">{{ (c.ok ? 'passed' : 'failed') | t }}<small>{{ ago(c.ts) }}</small></dd>
          } @else { <dd class="dim">{{ 'never run' | t }}<small>{{ d.container.wired ? ('weekly' | t) : ('not scheduled' | t) }}</small></dd> }
        </div>
        @if (d.disk; as k) {
          <div><dt>{{ 'Backup folder' | t }}</dt>
            <dd>{{ bytes(k.dir) }}<small>{{ bytes(k.nightly) }} {{ 'nightly' | t }}</small></dd></div>
          @if (k.size) {
            <div class="bk-fig-disk"><dt>{{ 'Disk free' | t }}</dt>
              <dd [attr.data-tone]="(k.free ?? 0) < (k.steady ?? 0) * 2 ? 'warn' : null">{{ bytes(k.free ?? 0) }}<small>{{ 'of' | t }} {{ bytes(k.size) }}</small>
                <span class="bk-disk" aria-hidden="true"><i class="bk-disk-other" [style.width.%]="share((k.used ?? 0) - k.dir, k.size)"></i><i class="bk-disk-bk" [style.width.%]="share(k.dir, k.size)"></i></span></dd></div>
          }
        }
      </dl>
    </div>

    @if (plain().length) {
      <div class="bk-alert" role="note">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.8L21.2 20H2.8z"/><path d="M12 10v4.2M12 17.2v.1"/></svg>
        <div><b>{{ plain().length }} {{ (plain().length === 1 ? 'archive holds the saved secrets in plaintext' : 'archives hold the saved secrets in plaintext') | t }}</b>
          <span>{{ 'They were written before the secret key was made' | t }}{{ d.key.created ? ' (' + short(d.key.created) + ')' : '' }}{{ ': the LLM API keys, Jina\\'s key, the proxy and McMaster passwords and the Telegram bot token are readable in them.' | t }}
            @if (plainExpire(); as x) { {{ 'The nightly ones are pruned by' | t }} {{ short(x) }}. }
            @if (plainManual()) { {{ plainManual() }} {{ 'kept by hand never expire - delete them, or keep them where only you can read them.' | t }} }</span></div>
      </div>
    }

    @if (d.writing.length) {
      <div class="st-banner">{{ 'A dump is being written now' | t }}: <span class="mono">{{ d.writing[0].name }}</span> · {{ bytes(d.writing[0].size) }}</div>
    }

    <!-- ---------------- the archives | the restore check ---------------- -->
    <div class="bk-main">
      <div class="st-card bk-arch">
        <div class="st-card-head"><h3>{{ 'Archives' | t }}</h3>
          <span class="st-sub">{{ d.archives.length }} · {{ bytes(d.disk?.archives ?? 0) }} · <span class="mono" [title]="'read from' | t">{{ d.where || '–' }}</span></span>
          <span class="st-right st-sub">{{ (d.owner ? 'newest first · the newest nightly cannot be deleted' : 'the owner downloads and deletes') | t }}</span></div>
        @if (d.archives.length) {
          <div class="st-table-wrap">
            <table class="st-table bk-table">
              <thead><tr>
                <th>{{ 'Archive' | t }}</th><th>{{ 'Age' | t }}</th><th class="r">{{ 'Size' | t }}</th>
                <th>{{ 'Goes' | t }}</th><th>{{ 'Secrets' | t }}</th><th>{{ 'Checked' | t }}</th>@if (d.owner) { <th></th> }
              </tr></thead>
              <tbody>
                @for (a of d.archives; track a.name) {
                  <tr [attr.data-plain]="a.plaintext ? 1 : null">
                    <td class="bk-name" [title]="a.name"><b>{{ label(a) }}</b>
                      @if (a.kind === 'manual') { <small>{{ short(a.mtime) }}</small> }
                      @if (a.newest) { <span class="st-tag" data-tone="accent">{{ 'newest' | t }}</span> }
                      <span class="st-tag">{{ (a.kind === 'manual' ? 'by hand' : 'nightly') | t }}</span></td>
                    <td [title]="exact(a.mtime)">{{ ago(a.mtime) }}</td>
                    <td class="r mono"><span class="bk-size"><i [style.width.%]="share(a.size, maxSize())"></i></span>{{ bytes(a.size) }}</td>
                    <td [title]="a.expires ? short(a.expires) : ''">
                      @if (a.expires) { <span [class.bk-soon]="a.expires - (d.now ?? 0) < 86400">{{ inn(a.expires) }}</span> }
                      @else { <span class="dim">{{ 'when deleted' | t }}</span> }</td>
                    <td [title]="(a.plaintext_by === 'check' ? 'found by its restore check' : a.plaintext_by === 'key-age' ? 'by its age: written before the secret key was made' : '') | t">
                      @if (a.plaintext === true) { <span class="st-tag" data-tone="danger">{{ 'contains plaintext secrets' | t }}</span> }
                      @else if (a.plaintext === false) { <span class="st-tag" data-tone="ok">{{ 'sealed' | t }}</span> }
                      @else { <span class="dim">–</span> }</td>
                    <td>
                      @if (a.check; as c) { <span class="st-tag" [attr.data-tone]="c.ok ? 'ok' : 'danger'" [title]="short(c.at)">{{ (c.ok ? 'passed' : 'failed') | t }}</span> }
                      @else { <span class="dim">–</span> }</td>
                    @if (d.owner) {
                      <td class="r bk-acts">
                        <button class="tcv-btn bk-btn" type="button" (click)="download(a)" [title]="'Download' | t">
                          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg></button>
                        <button class="tcv-btn bk-btn bk-danger" type="button" (click)="remove(a)" [disabled]="a.newest || busy() === a.name || !!run()?.running"
                                [title]="(a.newest ? 'the newest nightly archive stays' : 'Delete') | t">
                          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg></button>
                      </td>
                    }
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else { <div class="st-empty">{{ (d.error ? 'Nothing to show.' : 'No archive in the backup folder yet - the first one comes at the next dump.') | t }}</div> }
      </div>

      <div class="st-card bk-check">
        <div class="st-card-head"><h3>{{ 'Restore check' | t }}</h3>
          <span class="st-sub">{{ 'the newest archive, restored into a throwaway database and compared with the live one' | t }}</span>
          <button class="tcv-btn tcv-btn-accent bk-btn-t st-right" type="button" [disabled]="!!run()?.running || starting() || !d.container.running" (click)="startCheck()"
                  [title]="d.container.running ? '' : ('the mongo-backup container is not running' | t)">
            {{ (run()?.running || starting() ? 'Checking…' : 'Run restore check now') | t }}</button></div>
        <div class="st-card-body">
          @if (run(); as r) {
            @if (r.running || justRan()) {
              <div class="bk-run" [attr.data-on]="r.running ? 1 : null">
                <div class="bk-run-top">
                  @if (r.running) { <span class="bk-spin" aria-hidden="true"></span><b>{{ 'Restoring and comparing…' | t }}</b> }
                  @else { <b>{{ (r.rc === 0 ? 'The check passed' : r.lost ? 'The check stopped without a result' : 'The check failed') | t }}</b> }
                  <span class="st-sub">{{ elapsed() }} s{{ r.running ? ' ' + ('of about' | t) + ' ' + expected() + ' s' : '' }}{{ r.by ? ' · ' + r.by : '' }}</span>
                </div>
                @if (r.running) { <div class="st-meter bk-meter"><i [style.width.%]="progress()"></i></div> }
                <pre class="bk-out" aria-live="polite">{{ (r.lines ?? []).join('\\n') || '…' }}</pre>
              </div>
            }
          }
          @if (d.checks[0]; as c) {
            <div class="bk-last">
              <div class="bk-last-top">
                <span class="st-tag" [attr.data-tone]="c.ok ? 'ok' : 'danger'">{{ (c.ok ? 'passed' : 'failed') | t }}</span>
                <span class="bk-last-arch" [title]="c.archive">{{ labelOf(c.archive) }}</span>
                <span class="st-sub st-right">{{ short(c.at) }}{{ c.duration_s != null ? ' · ' + c.duration_s + ' s' : '' }}{{ d.prom.documents ? ' · ' + count(d.prom.documents) + ' ' + ('documents' | t) : '' }}</span>
              </div>
              @if (c.reasons.length) {
                <ul class="bk-reasons">@for (x of c.reasons; track $index) { <li>{{ plainWords(x) }}</li> }</ul>
              }
              @if (c.counts.length) {
                <div class="bk-counts">
                  @for (n of c.counts; track n.name) {
                    <div class="bk-count" [attr.data-bad]="n.bad ? 1 : null">
                      <span class="mono" [title]="n.name">{{ n.name }}</span>
                      @if (n.new) { <span class="dim" [title]="'new since the dump' | t">{{ 'new' | t }}</span> }
                      @else { <b>{{ n.dump }}<span class="dim"> / {{ n.live }}</span></b> }
                    </div>
                  }
                </div>
                <div class="bk-legend st-sub">{{ 'in the dump / live now - the live database has moved on since the dump, so small gaps are normal' | t }}</div>
              }
              <div class="bk-facts">
                @if (c.secrets; as x) {
                  <span [attr.data-tone]="x.dump_sealed < x.dump ? 'danger' : 'ok'">{{ 'Secrets sealed in the dump' | t }} <b>{{ x.dump_sealed }}/{{ x.dump }}</b></span>
                  @if (x.live != null) { <span>{{ 'live' | t }} <b>{{ x.live_sealed }}/{{ x.live }}</b></span> }
                }
                @if (c.collections; as x) { <span>{{ 'Collections' | t }} <b>{{ x.dump }}/{{ x.live }}</b></span> }
                <span [attr.data-tone]="d.container.wired ? null : 'warn'">{{ 'Weekly check' | t }} <b>{{ d.container.wired ? (day(d.schedule.weekly_check) | t) : ('not set up' | t) }}</b></span>
                @if (c.not_in_dump.length) { <span>{{ 'not in the dump' | t }}: <span class="mono">{{ c.not_in_dump.join(', ') }}</span></span> }
              </div>
            </div>
            @if (d.checks.length > 1) {
              <div class="bk-hist">
                <span class="st-sec-title">{{ 'Earlier checks' | t }}</span>
                @for (h of d.checks.slice(1, 7); track $index) {
                  <div class="bk-hist-row" [title]="h.message">
                    <span class="st-tag" [attr.data-tone]="h.ok ? 'ok' : 'danger'">{{ (h.ok ? 'passed' : 'failed') | t }}</span>
                    <span>{{ short(h.at) }}</span>
                    <span class="dim bk-hist-why">{{ h.reasons.length ? plainAll(h.reasons) : labelOf(h.archive) }}</span>
                    <span class="dim mono">{{ h.duration_s != null ? h.duration_s + ' s' : '' }}</span>
                  </div>
                }
              </div>
            }
          } @else if (!run()?.running) {
            <div class="st-empty">{{ 'No restore check has run yet.' | t }}</div>
          }
        </div>
      </div>
    </div>

    <!-- ---------------- the weekly check, not set up yet ---------------- -->
    @if (d.container.found && !d.container.wired) {
      <div class="st-card bk-setup">
        <div class="st-card-head"><h3>{{ 'Weekly restore check' | t }}</h3>
          <span class="st-tag" data-tone="warn">{{ 'not set up' | t }}</span>
          <span class="st-sub">{{ 'the mongo-backup service runs the check itself every Sunday, after the dump - two lines in the mongodb stack' | t }}</span>
          <button class="tcv-btn bk-btn-t st-right" type="button" [disabled]="!d.setup.service" (click)="copy(d.setup.service!, 'service')">{{ (copied() === 'service' ? 'Copied' : 'Copy the whole service') | t }}</button></div>
        <ol class="bk-steps">
          <li><span class="bk-n">1</span><div><b>{{ 'Open the stack' | t }}</b>
            <span class="st-sub">{{ 'Portainer > Stacks > mongodb > Editor, the mongo-backup service' | t }}</span></div></li>
          <li><span class="bk-n">2</span><div><b>{{ 'Under volumes, add' | t }}</b>
            <div class="bk-field"><code [title]="d.setup.volume || ''">{{ d.setup.volume || '–' }}</code>
              <button type="button" class="bk-ico" [disabled]="!d.setup.volume" (click)="copy(d.setup.volume!, 'volume')" [title]="'Copy' | t">@if (copied() === 'volume') { <svg viewBox="0 0 24 24"><path d="M5 12l5 5L19 7"/></svg> } @else { <svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg> }</button></div></div></li>
          <li><span class="bk-n">3</span><div><b>{{ 'In the loop, after sleep ...; dump, add' | t }}</b>
            <div class="bk-field"><code [title]="d.setup.loop || ''">{{ d.setup.loop || '–' }}</code>
              <button type="button" class="bk-ico" [disabled]="!d.setup.loop" (click)="copy(d.setup.loop!, 'loop')" [title]="'Copy' | t">@if (copied() === 'loop') { <svg viewBox="0 0 24 24"><path d="M5 12l5 5L19 7"/></svg> } @else { <svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg> }</button></div></div></li>
          <li><span class="bk-n">4</span><div><b>{{ 'Update the stack' | t }}</b>
            <span class="st-sub">{{ 'keep the env values it has; this page shows "weekly" once the container runs with the script' | t }}</span></div></li>
        </ol>
      </div>
    }

    <!-- ---------------- the dumps | the disk | the key ---------------- -->
    <div class="bk-low">
      <div class="st-card">
        <div class="st-card-head"><h3>{{ 'Dump log' | t }}</h3>
          <span class="st-sub">backup.log · {{ okDumps() }}/{{ d.dumps.length }} {{ 'ok' | t }}</span>
          <span class="st-right st-sub" [title]="d.schedule.tz + (d.schedule.source === 'default' ? ' - ' + ('read from the stack file: the container could not be asked' | t) : '')">
            {{ 'nightly at' | t }} {{ d.schedule.at }}{{ d.schedule.source === 'default' ? ' *' : '' }}</span></div>
        @if (d.dumps.length) {
          <div class="bk-dumps">
            @for (x of d.dumps.slice(0, 10); track $index) {
              <div class="bk-dump" [attr.data-bad]="x.ok ? null : 1">
                <span class="bk-dump-when" [title]="x.at">{{ short(x.at) }}</span>
                @if (x.ok) {
                  <span class="bk-size bk-dump-bar"><i [style.width.%]="share(sizeOf(x.size), maxLogSize())"></i></span>
                  <span class="mono r">{{ x.size }}B</span>
                } @else { <span class="bk-dump-fail">{{ 'dump failed' | t }}</span><span></span> }
              </div>
            }
          </div>
        } @else { <div class="st-empty">{{ 'The log has no dump yet.' | t }}</div> }
      </div>

      <div class="st-card">
        <div class="st-card-head"><h3>{{ 'Disk' | t }}</h3>@if (d.disk?.mount) { <span class="st-sub mono">{{ d.container.host_dir || d.disk?.mount }}</span> }</div>
        @if (d.disk; as k) {
          <div class="st-card-body">
            @if (k.size) {
              <div class="bk-bar" aria-hidden="true">
                <i class="bk-disk-other" [style.width.%]="share((k.used ?? 0) - k.dir, k.size)"></i><i class="bk-disk-bk" [style.width.%]="share(k.dir, k.size)"></i>
              </div>
              <div class="bk-keys">
                <span><i class="bk-sw bk-disk-bk"></i>{{ 'backups' | t }} <b>{{ bytes(k.dir) }}</b></span>
                <span><i class="bk-sw bk-disk-other"></i>{{ 'everything else' | t }} <b>{{ bytes((k.used ?? 0) - k.dir) }}</b></span>
                <span><i class="bk-sw"></i>{{ 'free' | t }} <b>{{ bytes(k.free ?? 0) }}</b></span>
              </div>
            }
            <dl class="st-facts">
              <div><dt>{{ 'Nightly archives' | t }}</dt><dd>{{ bytes(k.nightly) }} <span class="st-sub">· {{ nightly().length }}</span></dd></div>
              <div><dt>{{ 'Kept by hand' | t }}</dt><dd>{{ bytes(k.archives - k.nightly) }} <span class="st-sub">· {{ manual().length }}</span></dd></div>
              <div [title]="'about the newest archive\\'s size for each day kept' | t"><dt>{{ 'Nightly, settled' | t }}</dt><dd>{{ k.steady ? '~' + bytes(k.steady) : '–' }}</dd></div>
              <div><dt>{{ 'Growth, last 7 dumps' | t }}</dt><dd>{{ growth() }}</dd></div>
            </dl>
          </div>
        } @else { <div class="st-empty">{{ 'Not known.' | t }}</div> }
      </div>

      <div class="st-card bk-key">
        <div class="st-card-head"><h3>{{ 'Secret key' | t }}</h3>
          <span class="st-tag" data-tone="warn">{{ 'not in the backups' | t }}</span></div>
        <div class="st-card-body">
          <dl class="st-facts">
            <div><dt>{{ 'Kept in' | t }}</dt><dd class="mono">{{ d.key.source === 'env' ? d.key.env : (d.key.rel || d.key.path) }}</dd></div>
            <div><dt>{{ 'Made' | t }}</dt><dd>{{ d.key.created ? short(d.key.created) : (d.key.source === 'env' ? ('set in the environment' | t) : '–') }}</dd></div>
            <div [title]="'the first 12 characters of the key file\\'s SHA-256 - to check a kept copy, not the key' | t"><dt>{{ 'Fingerprint' | t }}</dt><dd class="mono">{{ d.key.fingerprint || '–' }}</dd></div>
            <div><dt>{{ 'Access' | t }}</dt><dd class="mono">{{ d.key.mode ? d.key.mode.replace('0o', '0') : '–' }}</dd></div>
          </dl>
          <p class="st-hint">{{ 'The saved secrets in the database are sealed with this key, and the key is kept apart from the database on purpose. A backup restored without it brings everything back except those secrets: they would have to be typed in Settings again. Keep a copy of the key somewhere off this machine.' | t }}</p>
          @if (d.key.source === 'file' && d.key.path) {
            <div class="bk-field"><code>cat {{ d.key.path }}</code>
              <button type="button" class="bk-ico" (click)="copy('cat ' + d.key.path, 'cat')" [title]="'Copy' | t">@if (copied() === 'cat') { <svg viewBox="0 0 24 24"><path d="M5 12l5 5L19 7"/></svg> } @else { <svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg> }</button></div>
            <p class="st-hint">{{ 'Run it on the server and put what it prints in your password manager. A kept copy is the right one when' | t }} <span class="mono">sha256sum secret.key</span> {{ 'starts with the fingerprint above.' | t }}</p>
          } @else {
            <p class="st-hint">{{ 'Keep the value of' | t }} <span class="mono">{{ d.key.env }}</span> {{ 'with the redline stack\\'s other secrets, in your password manager.' | t }}</p>
          }
        </div>
      </div>
    </div>
  } @else if (!error()) {
    <div class="wb-sk-stack"><wb-skel kind="rows" [count]="2" [h]="64" /><wb-skel kind="rows" [count]="8" [h]="28" /></div>
  }
</div>`,
})
export class BackupsSettings implements OnDestroy {
  private http = inject(HttpClient);
  s = signal<BkState | null>(null);
  run = signal<Run | null>(null);
  error = signal('');
  busy = signal<string | null>(null);
  starting = signal(false);
  /** The check that ended while this page watched it: its output stays in view. */
  justRan = signal(false);
  copied = signal<string | null>(null);
  private now = signal(Date.now());
  private timer = setInterval(() => { this.now.set(Date.now()); this.load(); }, 60_000);
  private poll: ReturnType<typeof setInterval> | null = null;

  nightly = computed(() => (this.s()?.archives ?? []).filter(a => a.kind === 'nightly'));
  manual = computed(() => (this.s()?.archives ?? []).filter(a => a.kind === 'manual'));
  plain = computed(() => (this.s()?.archives ?? []).filter(a => a.plaintext));
  plainManual = computed(() => this.plain().filter(a => a.kind === 'manual').length);
  /** When the last nightly archive with plaintext secrets is pruned. */
  plainExpire = computed(() => Math.max(0, ...this.plain().map(a => a.expires ?? 0)) || null);
  maxSize = computed(() => Math.max(1, ...(this.s()?.archives ?? []).map(a => a.size)));
  maxLogSize = computed(() => Math.max(1, ...(this.s()?.dumps ?? []).map(x => this.sizeOf(x.size))));
  okDumps = computed(() => (this.s()?.dumps ?? []).filter(x => x.ok).length);
  /** The newest nightly archive's size against the one seven dumps before. */
  growth = computed(() => {
    const n = [...this.nightly()].sort((a, b) => b.mtime - a.mtime);
    if (n.length < 2) return '–';
    const old = n[Math.min(7, n.length - 1)];
    const dd = n[0].size - old.size;
    return `${dd >= 0 ? '+' : '−'}${fmt.bytes(Math.abs(dd))} · ${Math.round((n[0].mtime - old.mtime) / 86400)} ${t('days')}`;
  });

  verdict = computed(() => {
    const d = this.s();
    const h = d?.health;
    if (!d || !h) return { tone: 'warn', title: 'Backups could not be read', sub: d?.error ? t(d.error) : '' };
    const age = h.newest_age_s != null ? `${t('newest')} ${this.dur(h.newest_age_s)} ${t('old')}` : t('no nightly archive');
    if (!h.dump_ok || !h.fresh) return { tone: 'danger', title: h.dump_ok ? 'No dump in the last day' : 'The last dump failed', sub: age };
    if (h.check_ok === false) return { tone: 'warn', title: 'Dumps are running, the last restore check failed', sub: `${age} · ${d.checks[0]?.reasons.map(r => this.plainWords(r, true)).join('; ') ?? ''}` };
    if (h.check_ok == null) return { tone: 'warn', title: 'Dumps are running, never restored', sub: age };
    return { tone: 'ok', title: 'Backups are running and restore', sub: age };
  });

  elapsed = computed(() => {
    const r = this.run();
    if (!r?.started) return 0;
    const end = r.running ? this.now() / 1000 : (r.finished ?? this.now() / 1000);
    return Math.max(0, Math.round(end - r.started));
  });
  expected = computed(() => {
    const d = this.s();
    return Math.round((d?.prom.duration_s ?? d?.checks[0]?.duration_s ?? 20) + 4);
  });
  progress = computed(() => Math.min(95, 100 * this.elapsed() / Math.max(1, this.expected())));

  constructor() { this.load(); }
  ngOnDestroy() { clearInterval(this.timer); if (this.poll) clearInterval(this.poll); }

  load() {
    this.http.get<BkState>('/api/admin/backups').subscribe({
      next: d => {
        this.s.set(d); this.error.set('');
        if (d.run && (d.run.running || !this.run())) this.run.set(d.run);
        if (d.run?.running) this.watch();
      },
      error: (e: HttpErrorResponse) => this.error.set(this.why(e)),
    });
  }

  async startCheck() {
    const d = this.s();
    const a = d?.archives.find(x => x.newest);
    if (!await Confirm.ask({
      title: t('Run the restore check now?'),
      text: `${t('The newest archive')}${a ? ` (${a.name}, ${fmt.bytes(a.size)})` : ''} ${t('is restored into a throwaway mongo:7.0 container, compared with the live database by read-only counts, and removed. It takes about')} ${this.expected()} s ${t('and up to 2 GB of memory meanwhile.')}`,
      ok: t('Run the check'),
    })) return;
    this.starting.set(true);
    this.http.post<Run>('/api/admin/backups/check', {}).subscribe({
      next: r => { this.starting.set(false); this.justRan.set(true); this.run.set(r); this.now.set(Date.now()); this.watch(); },
      error: (e: HttpErrorResponse) => { this.starting.set(false); Toast.show(this.why(e), { tone: 'danger' }); },
    });
  }

  /** Every second while a check runs: its output; then the page again. */
  private watch() {
    if (this.poll) return;
    this.poll = setInterval(() => {
      this.now.set(Date.now());
      this.http.get<Run>('/api/admin/backups/check').subscribe({
        next: r => {
          this.run.set(r);
          if (r.running) return;
          clearInterval(this.poll!); this.poll = null; this.justRan.set(true);
          Toast.show(t(r.rc === 0 ? 'The restore check passed.' : 'The restore check failed - see why on the page.'), { tone: r.rc === 0 ? 'ok' : 'danger' });
          this.load();
        },
        error: () => { clearInterval(this.poll!); this.poll = null; },
      });
    }, 1000);
  }

  async download(a: Archive) {
    const warn = a.plaintext
      ? t('This archive contains plaintext secrets: the LLM API keys, the proxy and McMaster passwords and the Telegram bot token are readable in it. Keep the file where only you can read it, and delete the copy when you are done.')
      : t('The file is a mongodump archive of the whole database: accounts, chats, models, files. Keep it where only you can read it.');
    if (!await Confirm.ask({ title: t('Download this archive?'), text: `${a.name} · ${fmt.bytes(a.size)}\n\n${warn}`,
                             ok: t('Download'), danger: !!a.plaintext })) return;
    const link = document.createElement('a');
    link.href = `/api/admin/backups/archives/${encodeURIComponent(a.name)}`;
    link.download = a.name;
    document.body.appendChild(link); link.click(); link.remove();
  }

  async remove(a: Archive) {
    if (!await Confirm.ask({
      title: t('Delete this archive?'),
      text: `${a.name} · ${fmt.bytes(a.size)} · ${this.short(a.mtime)}\n\n${t(a.kind === 'manual' ? 'It was kept by hand: the nightly prune would never have removed it.' : 'The nightly prune would take it on its own')}${a.expires ? ' ' + this.short(a.expires) : ''}. ${t('A deleted archive cannot be brought back.')}`,
      ok: t('Delete'), danger: true,
    })) return;
    this.busy.set(a.name);
    this.http.delete<BkState>(`/api/admin/backups/archives/${encodeURIComponent(a.name)}`).subscribe({
      next: d => { this.busy.set(null); this.s.set({ ...d, run: d.run ?? this.run() }); Toast.show(`${t('Deleted')}: ${a.name}`, { tone: 'ok' }); },
      error: (e: HttpErrorResponse) => { this.busy.set(null); Toast.show(this.why(e), { tone: 'danger' }); },
    });
  }

  copy(text: string, what: string) {
    navigator.clipboard?.writeText(text).then(() => {
      this.copied.set(what);
      setTimeout(() => this.copied.set(null), 1500);
    });
  }

  bytes(v: number) { return fmt.bytes(Math.max(0, v)); }
  count(v: number) { return fmt.count(v); }
  share(v: number, of: number) { return of > 0 ? Math.max(0, Math.min(100, 100 * v / of)) : 0; }
  pct(v: number, of: number) { return of > 0 ? Math.round(100 * v / of) + '%' : '–'; }
  day(n: number | null) { return DAYS[n ?? 7] ?? ''; }
  exact(ts: number) { return new Date(ts * 1000).toLocaleString(); }
  /** "566M" from the dump log, in bytes - for the bars only. */
  sizeOf(s: string | null) {
    const m = /^([\d.]+)([KMGT]?)$/.exec(s ?? '');
    return m ? parseFloat(m[1]) * 1024 ** ' KMGT'.indexOf(m[2] || ' ') : 0;
  }
  /** A span of time, short: "35 min", "11 h", "3 d 4 h". */
  dur(s: number) {
    s = Math.max(0, s);
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))} ${t('min')}`;
    if (s < 86400) return `${Math.round(s / 3600)} ${t('h')}`;
    const d = Math.floor(s / 86400);
    const hh = Math.floor((s % 86400) / 3600);
    return hh ? `${d} ${t('d')} ${hh} ${t('h')}` : `${d} ${t('d')}`;
  }
  ago(ts: number | null) { return ts == null ? '–' : t('{x} ago').replace('{x}', this.dur(this.now() / 1000 - ts)); }
  inn(ts: number) { return t('in {x}').replace('{x}', this.dur(ts - this.now() / 1000)); }

  /** "14 Oct 03:30": a time from the server (epoch seconds, or ISO text). */
  short(at: number | string | null | undefined) {
    if (at == null || at === '') return '–';
    const d = typeof at === 'number' ? new Date(at * 1000) : new Date(at);
    if (isNaN(d.getTime())) return String(at);
    return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  /** An archive by what it is: a nightly one by the time in its name (the server's clock), one kept by hand by the name it was given. */
  label(a: Archive) { return this.labelOf(a.name); }
  labelOf(name: string) {
    const m = /^redline-(\d{4})-(\d\d)-(\d\d)_(\d\d)(\d\d)\.archive\.gz$/.exec(name);
    if (m) return this.short(new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() / 1000);
    return name.replace(/\.archive\.gz$/, '').replace(/-\d{8}_\d{4}$/, '');
  }
  plainAll(rs: string[]) { return rs.map(r => this.plainWords(r)).join('; '); }
  /** A restore check's reason, as the script wrote it, in plain words. */
  plainWords = (r: string, newest = false): string => {
    let m = /^(\d+) secret\(s\) not enc1:?$/.exec(r);
    if (m) return `${m[1]} ${t(+m[1] === 1 ? (newest ? 'secret stored unencrypted in the newest archive' : 'secret stored unencrypted in the archive')
                                           : (newest ? 'secrets stored unencrypted in the newest archive' : 'secrets stored unencrypted in the archive'))}`;
    if ((m = /^secrets (\d+) vs live (\d+)$/.exec(r))) return `${t('secrets in the archive')}: ${m[1]}, ${t('live')}: ${m[2]}`;
    if ((m = /^(\S+) missing$/.exec(r))) return `${m[1]} ${t('is missing from the archive')}`;
    if ((m = /^(\S+) (\d+) vs live (\d+)$/.exec(r))) return `${m[1]}: ${m[2]} ${t('in the archive')}, ${m[3]} ${t('live')}`;
    if ((m = /^(\S+) sample unreadable$/.exec(r))) return `${m[1]}: ${t('a document did not read back')}`;
    if (r === 'model_files chunk unreadable') return t('a model file did not read back');
    return r;
  };

  private why(e: HttpErrorResponse) { return typeof e.error?.detail === 'string' ? t(e.error.detail) : t('that did not work'); }
}
