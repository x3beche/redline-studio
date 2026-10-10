import { Component, computed, inject, signal } from '@angular/core';
import { Auth, SignIn } from './auth';

/** What a signed-out visitor sees: the front page, with signing in (and
 *  choosing, switching or removing a remembered account) in a sheet over
 *  it. The sheet opens by itself when there is something to do before
 *  anything else: the first account to make, a reset link, a password an
 *  admin set, or another account being added from inside the app. */
@Component({
  selector: 'app-landing',
  imports: [SignIn],
  styleUrl: './landing.css',
  host: { '(document:keydown.escape)': 'close()' },
  template: `
<div class="ld">
  <nav class="ld-nav"><div class="ld-wrap">
    <a class="ld-brand" href="/">
      <svg viewBox="0 0 64 64" aria-hidden="true"><path d="M8 8H56V56H8ZM14 14V30L30 14ZM14 50H22L50 22V14H42L14 42ZM34 50H50V34Z" fill-rule="evenodd"/></svg>
      Redline</a>
    <button type="button" class="ld-btn" (click)="open.set(true)">Sign in</button>
  </div></nav>

  <header class="ld-hero">
    <img src="/landing/hero.webp" alt="">
    <div class="ld-wrap">
      <h1>Design the whole product in one place.</h1>
      <p>Parts, circuit boards and firmware. Say what you need, and it gets built and checked.</p>
      <a class="ld-btn ld-solid" [href]="ask">Request access</a>
    </div>
  </header>

  @for (r of rows; track r.img) {
    <section class="ld-row"><div class="ld-wrap">
      <div class="ld-row-t"><h2>{{ r.title }}</h2><p>{{ r.line }}</p></div>
      <img [src]="r.img" alt="" loading="lazy">
    </div></section>
  }

  <section class="ld-end"><div class="ld-wrap">
    <h2>From idea to object.</h2>
    <a class="ld-btn ld-solid" [href]="ask">Request access</a>
  </div></section>

  <footer class="ld-foot"><div class="ld-wrap"><span>Redline</span><span>© 2026</span></div></footer>
</div>

@if (open() || forced()) {
  <div class="ld-veil" (click)="$event.target === $event.currentTarget && close()">
    <div class="ld-sheet">
      @if (!forced()) { <button type="button" class="ld-x" aria-label="Close" (click)="close()">×</button> }
      <app-sign-in />
    </div>
  </div>
}`,
})
export class Landing {
  private auth = inject(Auth);
  open = signal(new URLSearchParams(location.search).has('signin'));
  ask = 'mailto:info@medipol.dev?subject=Redline%20access';
  rows = [
    { title: '3D parts', line: 'Models that fit together and update when one changes.', img: '/landing/cad.webp' },
    { title: 'Circuit boards', line: 'Real parts, routed and checked.', img: '/landing/pcb.webp' },
    { title: 'Just ask', line: 'Write what you want. Watch it happen.', img: '/landing/chat.webp' },
  ];
  /** Something has to be done first: the sheet stays, with no way out. */
  forced = computed(() => {
    const s = this.auth.state();
    return !!s?.needs_setup || !!s?.must_change_password || !!this.auth.next()
      || new URLSearchParams(location.search).has('reset');
  });

  close() { if (!this.forced()) this.open.set(false); }
}
