import { Component, computed, effect, input, signal } from '@angular/core';

/** Someone's picture, or their initials on a colour of their own.
 *
 *  `<app-avatar [name]="m.name" [userId]="m.id" [hasPicture]="m.has_avatar" [v]="m.avatar_v" [size]="24" />`
 *
 *  The picture comes from the server (backend/profile.py, 256 x 256); the
 *  URL carries the moment it changed (`v`), so a browser keeps it until it
 *  does. Without one - or for an agent, or local mode - the initials: the
 *  first letters of the first two words, skipping symbols and anything in
 *  brackets ("local agents (x33)" is LA), on one of the theme's series
 *  colours, picked from the name so the same name always wears the same one.
 */
export function initials(name: string | null | undefined): string {
  const words = (name ?? '')
    .replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, ' ')
    .split(/[\s._@\-/]+/)
    .map(w => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean);
  const out = words.slice(0, 2).map(w => [...w][0]).join('');
  return (out || '?').toLocaleUpperCase();
}

/** One of the eight series colours, the same for the same name. */
export function avatarColour(name: string | null | undefined): string {
  let h = 5381;
  for (const ch of (name ?? '').trim().toLowerCase()) h = ((h * 33) ^ ch.codePointAt(0)!) >>> 0;
  return `var(--series-${(h % 8) + 1})`;
}

@Component({
  selector: 'app-avatar',
  host: {
    class: 'app-avatar',
    // Through variables, so a stylesheet may still size it (the top bar on a phone).
    '[style.--av-size]': 'size() + "px"', '[style.--av-font]': 'fontScale()',
    '[style.background]': 'showPicture() ? null : colour()',
    '[attr.title]': 'title() ? name() : null',
    'role': 'img', '[attr.aria-label]': 'name()',
  },
  template: `@if (showPicture()) { <img [src]="src()" alt="" draggable="false" (error)="broken.set(true)"> }
@else { <span aria-hidden="true">{{ letters() }}</span> }`,
  styles: [`
    :host { width: var(--av-size, 24px); height: var(--av-size, 24px);
      font-size: calc(var(--av-size, 24px) * var(--av-font, .4));
      flex: none; display: inline-flex; align-items: center; justify-content: center; overflow: hidden;
      border-radius: 50%; color: var(--ink-on-accent); font-weight: 600; line-height: 1; letter-spacing: .02em;
      user-select: none; }
    img { width: 100%; height: 100%; object-fit: cover; display: block; }
  `],
})
export class Avatar {
  name = input<string | null | undefined>('');
  userId = input<string | null | undefined>(null);
  hasPicture = input<boolean | null | undefined>(false);
  /** When the picture last changed (avatar_v), for the URL. */
  v = input<number | string | null | undefined>(null);
  size = input(24);
  /** Show the name on hover. */
  title = input(false);

  /** The picture would not load: the initials instead. */
  broken = signal(false);
  constructor() {
    effect(() => { this.userId(); this.v(); this.hasPicture(); this.broken.set(false); });
  }

  letters = computed(() => initials(this.name()));
  colour = computed(() => avatarColour(this.name()));
  fontScale = computed(() => (this.letters().length > 1 ? 0.4 : 0.48));
  showPicture = computed(() => !!this.hasPicture() && !!this.userId() && !this.broken());
  src = computed(() => `/api/me/avatar/${encodeURIComponent(this.userId() ?? '')}?v=${encodeURIComponent(String(this.v() ?? ''))}`);
}
