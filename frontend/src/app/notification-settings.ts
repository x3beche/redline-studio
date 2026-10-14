import { Component, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { T, t } from './i18n';
import { Toast } from './toast';
import { NC_GROUPS, NotifyStore, ncIcon } from './notifications';
import { Prefs } from './preferences';

interface KindPref { id: string; group: string; label: string; server: boolean; inapp: boolean; telegram: boolean | null }
interface NcSettings { kinds: KindPref[]; toast: boolean; telegram: { bot: boolean; linked: boolean; blocked: boolean } }

/** Settings > Notifications: for each kind, whether it comes into the app
 *  (the bell, the /notifications page) and whether it comes on Telegram -
 *  the Telegram side is the linked chat's own choices, the same ones as
 *  Settings > Telegram's "Notify me when" (backend/notifications.py writes
 *  both). One compact grid, every kind a line; toasts on or off beside it. */
@Component({
  selector: 'app-notification-settings',
  imports: [T],
  styleUrls: ['./settings.css', './notifications.css'],
  template: `
<div class="st-page">
  <div class="st-card">
    <div class="st-card-head"><h3>{{ 'Notify me when' | t }}</h3>
      <span class="st-sub">{{ tgNote() | t }}</span>
      @if (s()?.telegram?.bot && !s()?.telegram?.linked) {
        <button type="button" class="ns-link" (click)="prefs.open.set('telegram')">{{ 'Link Telegram' | t }}</button>
      }
      <span class="st-right">
        <label class="tcv-check-row st-sub">
          <input type="checkbox" class="tcv-check" [checked]="s()?.toast" [disabled]="!s() || busy()" (change)="setToast($any($event.target).checked)">
          {{ 'A toast when one comes' | t }}</label>
        <span class="mono st-sub">{{ appOn() }} / {{ s()?.kinds?.length ?? 0 }} {{ 'in the app' | t }}</span>
      </span>
    </div>
    <div class="st-card-body">
      @if (s(); as d) {
        <div class="ns-grid">
          @for (k of ordered(); track k.id) {
            <div class="ns-item">
              <svg class="nc-ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="ico(k.id).s"/>@if (ico(k.id).f) {<path class="f" [attr.d]="ico(k.id).f"/>}</svg>
              <span class="ns-name" [title]="k.label | t">{{ k.label | t }}@if (k.server) {<small>{{ 'admins' | t }}</small>}</span>
              <label class="tcv-check-row"><input type="checkbox" class="tcv-check" [checked]="k.inapp" [disabled]="busy()"
                     (change)="set('inapp', k.id, $any($event.target).checked)">{{ 'App' | t }}</label>
              <label class="tcv-check-row" [title]="(d.telegram.linked ? 'On your linked Telegram chat' : 'Link your Telegram to choose') | t">
                <input type="checkbox" class="tcv-check" [checked]="!!k.telegram" [disabled]="busy() || k.telegram === null"
                       (change)="set('telegram', k.id, $any($event.target).checked)">{{ 'Telegram' | t }}</label>
            </div>
          }
        </div>
      } @else {
        <div class="st-sub">{{ 'Loading…' | t }}</div>
      }
    </div>
  </div>
</div>`,
})
export class NotificationSettingsPanel {
  private http = inject(HttpClient);
  private store = inject(NotifyStore);
  prefs = inject(Prefs);
  s = signal<NcSettings | null>(null);
  busy = signal(false);
  appOn = computed(() => (this.s()?.kinds ?? []).filter(k => k.inapp).length);
  tgNote = computed(() => {
    const tg = this.s()?.telegram;
    if (!tg) return '';
    if (!tg.bot) return 'no Telegram bot on this server - the app only';
    if (!tg.linked) return 'Telegram is not linked - the app only';
    return tg.blocked ? 'the bot is blocked in your Telegram chat' : 'in the app and on your Telegram';
  });
  /** The kinds in their groups' order, laid across the grid's columns. */
  ordered = computed(() => {
    const order = NC_GROUPS.flatMap(g => g.kinds);
    return [...(this.s()?.kinds ?? [])].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  });

  constructor() {
    void firstValueFrom(this.http.get<NcSettings>('/api/notifications/settings')).then(d => this.s.set(d))
      .catch(() => Toast.show(t('Could not read the notification settings.'), { tone: 'danger' }));
  }

  ico(kind: string) { return ncIcon(kind); }

  async set(side: 'inapp' | 'telegram', kind: string, on: boolean) {
    await this.save({ [side]: { [kind]: on } });
  }

  async setToast(on: boolean) {
    if (await this.save({ toast: on })) this.store.toasts.set(on);
  }

  private async save(body: object): Promise<boolean> {
    this.busy.set(true);
    try {
      this.s.set(await firstValueFrom(this.http.put<NcSettings>('/api/notifications/settings', body)));
      return true;
    } catch {
      Toast.show(t('Could not save it.'), { tone: 'danger' });
      // What the server has, back on the page.
      void firstValueFrom(this.http.get<NcSettings>('/api/notifications/settings')).then(d => this.s.set(d)).catch(() => {});
      return false;
    } finally {
      this.busy.set(false);
    }
  }
}
