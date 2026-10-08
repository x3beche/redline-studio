import { Component, Injectable, computed, effect, inject, input, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';

/** Someone's picture, or their initials on a colour of their own.
 *
 *  `<app-avatar [name]="m.name" [userId]="m.id" [hasPicture]="m.has_avatar" [v]="m.avatar_v" [size]="24" />`
 *
 *  The picture comes from the server (backend/profile.py, 256 x 256); the
 *  URL carries the moment it changed (`v`), so a browser keeps it until it
 *  does. Without one - or for an agent, or local mode - the initials: the
 *  first letters of the first two words, skipping symbols and anything in
 *  brackets ("local agents (x33)" is LA), on one of the theme's series
 *  colours, picked from the name so the same name always wears the same one -
 *  or on the colour the person chose on their Profile (`[colour]`, one of
 *  AVATAR_COLOURS; 'auto' is the name's). The same colour rings a picture.
 *  Models and agents wear no colour at all: one grey (styles.css, Chat).
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

/** The colours a person may choose (backend/profile.py COLOURS): theme
 *  tokens, so every theme draws them its own way. 'auto' is the name's. */
export const AVATAR_COLOURS = ['series-1', 'series-2', 'series-3', 'series-4',
  'series-5', 'series-6', 'series-7', 'series-8', 'accent'] as const;

/** One of the eight series colours, the same for the same name - or, given
 *  one of AVATAR_COLOURS, that one. */
export function avatarColour(name: string | null | undefined, chosen?: string | null): string {
  if (chosen && (AVATAR_COLOURS as readonly string[]).includes(chosen)) return `var(--${chosen})`;
  let h = 5381;
  for (const ch of (name ?? '').trim().toLowerCase()) h = ((h * 33) ^ ch.codePointAt(0)!) >>> 0;
  return `var(--series-${(h % 8) + 1})`;
}

/** Other people's chosen colours, for a page that draws them by id (the
 *  Chat's lines): asked for in one batch (GET /api/me/colours?ids=...),
 *  kept for the page's life. Not answered yet, or never: 'auto'. */
@Injectable({ providedIn: 'root' })
export class AvatarColours {
  private http = inject(HttpClient);
  private map = signal<Record<string, string>>({});
  private asked = new Set<string>();
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Someone's colour - asking for it the first time. */
  of(id: string | null | undefined): string {
    if (!id) return 'auto';
    const got = this.map()[id];
    if (got) return got;
    if (!this.asked.has(id)) {
      this.asked.add(id);
      this.pending.add(id);
      this.timer ??= setTimeout(() => this.flush(), 30);
    }
    return 'auto';
  }
  /** What is known now (one's own new choice, from the Profile page). */
  set(id: string, colour: string) { this.asked.add(id); this.map.update(m => ({ ...m, [id]: colour })); }

  private flush() {
    this.timer = null;
    const ids = [...this.pending];
    this.pending.clear();
    if (!ids.length) return;
    this.http.get<{ colours: Record<string, string> }>('/api/me/colours', { params: { ids: ids.join(',') } })
      .subscribe({ next: r => this.map.update(m => ({ ...m, ...(r.colours || {}) })), error: () => { /* auto it is */ } });
  }
}

@Component({
  selector: 'app-avatar',
  host: {
    class: 'app-avatar',
    // Through variables, so a stylesheet may still size it (the top bar on a phone).
    '[style.--av-size]': 'px() + "px"', '[style.--av-font]': 'fontScale()',
    // The initials' ground; around a picture, its ring.
    '[style.background]': 'ground()', '[attr.data-pic]': 'showPicture() ? 1 : null',
    // A whole-pixel ring, the same on every side: the size is made even.
    '[style.--av-ring]': 'ring() + "px"',
    '[attr.title]': 'title() ? name() : null',
    'role': 'img', '[attr.aria-label]': 'name()',
  },
  template: `@if (showPicture()) { <img [src]="src()" alt="" draggable="false" (error)="broken.set(true)"> }
@else { <span aria-hidden="true">{{ letters() }}</span> }`,
  styles: [`
    :host { width: var(--av-size, 24px); height: var(--av-size, 24px); box-sizing: border-box;
      font-size: calc(var(--av-size, 24px) * var(--av-font, .4));
      flex: none; display: inline-grid; place-items: center; overflow: hidden; vertical-align: middle;
      border-radius: 50%; color: var(--ink-on-accent); font-weight: 600; line-height: 1; letter-spacing: .02em;
      user-select: none; }
    span { display: block; line-height: 1; }
    :host([data-pic]) { padding: var(--av-ring, 2px); }
    img { width: 100%; height: 100%; object-fit: cover; display: block; border-radius: 50%; border: 0; }
  `],
})
export class Avatar {
  name = input<string | null | undefined>('');
  userId = input<string | null | undefined>(null);
  hasPicture = input<boolean | null | undefined>(false);
  /** When the picture last changed (avatar_v), for the URL. */
  v = input<number | string | null | undefined>(null);
  size = input(24);
  /** The colour they chose (AVATAR_COLOURS), or 'auto' / nothing: the name's. */
  colour = input<string | null | undefined>('auto');
  /** Show the name on hover. */
  title = input(false);

  /** The picture would not load: the initials instead. */
  broken = signal(false);
  constructor() {
    effect(() => { this.userId(); this.v(); this.hasPicture(); this.broken.set(false); });
  }

  letters = computed(() => initials(this.name()));
  ground = computed(() => avatarColour(this.name(), this.colour()));
  /** The size, made even (its centre on a whole pixel). */
  px = computed(() => { const n = Math.round(this.size()); return n % 2 ? n + 1 : n; });
  /** The ring around a picture, in whole pixels. */
  ring = computed(() => (this.px() >= 64 ? 3 : 2));
  fontScale = computed(() => (this.letters().length > 1 ? 0.4 : 0.48));
  showPicture = computed(() => !!this.hasPicture() && !!this.userId() && !this.broken());
  src = computed(() => `/api/me/avatar/${encodeURIComponent(this.userId() ?? '')}?v=${encodeURIComponent(String(this.v() ?? ''))}`);
}
