import { AfterViewInit, Component, ElementRef, OnDestroy, computed, inject, signal } from '@angular/core';
import { Auth, SignIn } from './auth';

/** What a signed-out visitor sees: the front page - one real project,
 *  iot-fan, from its parts to its board, firmware and cost - with signing
 *  in (and choosing, switching or removing a remembered account) in a sheet
 *  over it. The sheet opens by itself when there is something to do before
 *  anything else: the first account to make, a reset link, a password an
 *  admin set, or another account being added from inside the app. */
@Component({
  selector: 'app-landing',
  imports: [SignIn],
  styleUrl: './landing.css',
  host: { '(document:keydown.escape)': 'close()' },
  template: `
<nav class="nav">
  <a class="brand" href="/"><svg viewBox="0 0 64 64" aria-hidden="true"><path d="M8 8H56V56H8ZM14 14V30L30 14ZM14 50H22L50 22V14H42L14 42ZM34 50H50V34Z" fill-rule="evenodd"/></svg>Redline</a>
  <div class="links">@for (l of links; track l.id) { <a [href]="'#' + l.id" (click)="go($event, l.id)">{{ l.name }}</a> }</div>
  <div class="nav-r"><button type="button" class="t" (click)="open.set(true)">Sign in</button><a class="btn" [href]="ask">Request access</a></div>
</nav>

<header class="hero wrap">
  <h1>Redline</h1>
  <div class="grid strip">
    <div class="kind">Hardware design workbench</div>
    <p>3D parts, circuit boards and firmware for one product. Say what you need, and AI agents build it and check it.</p>
    <svg class="down" viewBox="0 0 24 24"><path d="M12 3v17M5 13l7 7 7-7"/></svg>
  </div>
  <div class="band" id="heroband"><img src="/landing/station.webp" alt="The iot-fan station, rendered in Redline"></div>
  <div class="grid under"><b>iot-fan</b><span>A desk fan station. Its case, board and firmware were all made in Redline.</span></div>
</header>

<section class="wrap">
  <div class="grid sh rv"><h2>The project, in numbers</h2><p>Straight from Redline's own analytics for iot-fan.</p></div>
  <div class="stats rv">
    <div class="stat"><span>Items</span><b class="num">27</b><em>26 models · 1 board</em><div class="bar"><i style="flex:26;background:var(--s1)"></i><i style="flex:1;background:var(--s3)"></i></div></div>
    <div class="stat"><span>Notes</span><b class="num">67</b><em>written on the design</em><div class="bar"><i style="flex:1;background:var(--s7)"></i></div></div>
    <div class="stat"><span>Runs</span><b class="num">54</b><em>by the agents</em><div class="bar"><i style="flex:1;background:var(--s4)"></i></div></div>
    <div class="stat"><span>Jobs</span><b class="num">342</b><em>builds, renders, layouts, tests</em><div class="bar"><i style="flex:335;background:var(--s3)"></i><i style="flex:7;background:var(--s6)"></i></div></div>
    <div class="stat"><span>Failed</span><b class="num">7</b><em>2.0% of jobs</em><div class="bar"><i style="flex:7;background:var(--s6)"></i><i style="flex:335;background:var(--panel-2)"></i></div></div>
  </div>
</section>

<section class="wrap" id="parts">
  <div class="grid sh rv"><h2>3D parts</h2><p>Three assemblies built from 26 models. Change one part, and everything that uses it is rebuilt.</p><span class="n">01</span></div>
  <div class="asm rv">
    <div class="pic"><img src="/landing/fanmodule.webp" alt="The Fan Module, from behind"></div>
    <div class="rows">
      <div class="row"><h4>Station</h4><dl><div><dt>Notes</dt><dd class="num">37</dd></div><div><dt>Applied</dt><dd class="num">36</dd></div><div><dt>Build</dt><dd class="num">113 s</dd></div></dl><div class="bar"><i style="flex:36;background:var(--s1)"></i><i style="flex:1;background:var(--panel-2)"></i></div></div>
      <div class="row"><h4>Base</h4><dl><div><dt>Notes</dt><dd class="num">19</dd></div><div><dt>Applied</dt><dd class="num">19</dd></div><div><dt>Build</dt><dd class="num">150 s</dd></div></dl><div class="bar"><i style="flex:1;background:var(--s2)"></i></div></div>
      <div class="row"><h4>Fan Module</h4><dl><div><dt>Notes</dt><dd class="num">2</dd></div><div><dt>Applied</dt><dd class="num">2</dd></div><div><dt>Build</dt><dd class="num">143 s</dd></div></dl><div class="bar"><i style="flex:1;background:var(--s4)"></i></div></div>
    </div>
  </div>
</section>

<section class="feat wrap" id="board">
  <div class="band rv"><img src="/landing/board.webp" alt="The iot-fan board, routed"></div>
  <div class="grid cap rv"><h3>Circuit board</h3><p>Real parts from LCSC, placed and routed by TraceMaker: 235 of 235 connections in 121 seconds.</p></div>
  <div class="specs rv">
    <div class="spec"><span>Size</span><b class="num">95.5 × 58.7 mm</b><em>56 cm²</em></div>
    <div class="spec"><span>Parts</span><b class="num">91</b><em>48 different ones</em></div>
    <div class="spec"><span>Copper</span><b class="num">1,014 tracks</b><em>179 vias · 2.87 m</em></div>
    <div class="spec"><span>Schematic</span><b><i style="background:var(--s3)"></i>0 errors</b><em>electrical rules check</em></div>
    <div class="spec"><span>Parts cost</span><b class="num">$20.51</b><em>a board, ordering 10</em></div>
  </div>
</section>

<section class="feat wrap" id="firmware">
  <div class="band rv" style="background:#111113"><img src="/landing/sheet.webp" alt="The board's schematic, read by the firmware"></div>
  <div class="grid cap rv"><h3>Firmware</h3><p>Written for the board it runs on. Every pin is named from the schematic.</p></div>
  <div class="specs rv">
    <div class="spec"><span>Chip</span><b>ESP32-WROOM-32</b><em>Arduino on PlatformIO</em></div>
    <div class="spec"><span>Pins</span><b class="num">39</b><em>from the schematic</em></div>
    <div class="spec"><span>Build</span><b><i style="background:var(--s3)"></i>0 errors</b><em>0 warnings · 8.4 s</em></div>
    <div class="spec"><span>Flash</span><b class="num">24.6%</b><em>315 KB of 1.25 MB</em></div>
    <div class="spec"><span>RAM</span><b class="num">7.0%</b><em>22 KB of 320 KB</em></div>
  </div>
</section>

<div class="stmt wrap">
  <h2 class="rv">It asks before<br>it guesses<span>.</span></h2>
  <div class="qa rv">
    <div><span>The 3D room's agent, on iot-fan</span><p>The fan's own plug does not fit the board's fan socket (CN1).</p></div>
    <div><span>The answer</span><p class="ans"><i></i>Re-terminate the fan cable with a 2-pin XH plug.</p></div>
  </div>
</div>

<section class="wrap" id="cost">
  <div class="grid sh rv"><h2>What it cost</h2><p>Every call, build and kilowatt-hour is counted, and priced in your currency.</p><span class="n">04</span></div>
  <div class="shot rv"><img src="/landing/project.webp" alt="Analytics for iot-fan: spend by item"></div>
  <p class="lbl">iot-fan in Analytics, all time.</p>

  <div class="grid big rv" style="margin-top:120px">
    <b class="num">251.4<small>×</small></b>
    <div>
      <p>This month's work, priced at API rates, against the plans that paid for it.</p>
      <p>All of Redline, October so far.</p>
      <div class="vs">
        <div><span>Plans</span><span class="t"><i style="width:.4%;background:var(--s8)"></i></span><b class="num">₺3,416</b></div>
        <div><span>At API prices</span><span class="t"><i style="width:100%;background:var(--s2)"></i></span><b class="num">~₺858,624</b></div>
      </div>
    </div>
  </div>
  <div class="two rv">
    <div><div class="shot"><img src="/landing/costs.webp" alt="Settings, costs and currency"></div><p class="lbl">Settings · Costs &amp; currency</p></div>
    <div><div class="shot"><img src="/landing/usage.webp" alt="Command Code usage"></div><p class="lbl">Settings · LLM usage</p></div>
  </div>
</section>

<div class="end">
  <div class="bar"><i style="flex:92;background:var(--s1)"></i><i style="flex:7;background:var(--s2)"></i><i style="flex:1;background:var(--s3)"></i></div>
  <div class="grid">
    <h2>From idea<br>to object.</h2>
    <div class="r">
      <p>In private beta. Ask for an invite.</p>
      <div class="acts"><a class="btn" [href]="ask">Request access</a><button type="button" class="btn ghost" (click)="open.set(true)">Sign in</button></div>
    </div>
  </div>
</div>

<footer>
  <div class="grid">
    <a class="brand" href="/"><svg viewBox="0 0 64 64" aria-hidden="true"><path d="M8 8H56V56H8ZM14 14V30L30 14ZM14 50H22L50 22V14H42L14 42ZM34 50H50V34Z" fill-rule="evenodd"/></svg>Redline</a>
    <div class="col"><h4>Product</h4>@for (l of links; track l.id) { <a [href]="'#' + l.id" (click)="go($event, l.id)">{{ l.name }}</a> }</div>
    <div class="col"><h4>Access</h4><a [href]="ask">Request access</a><a href="/" (click)="$event.preventDefault(); open.set(true)">Sign in</a></div>
    <div class="col"><h4>Contact</h4><a href="mailto:info@medipol.dev">info@medipol.dev</a></div>
    <div class="fine"><span>© 2026 Redline</span><span>Istanbul</span></div>
  </div>
</footer>

@if (open() || forced()) {
  <div class="ld-veil" (click)="$event.target === $event.currentTarget && close()">
    <div class="ld-sheet">
      @if (!forced()) { <button type="button" class="ld-x" aria-label="Close" (click)="close()">×</button> }
      <app-sign-in />
    </div>
  </div>
}`,
})
export class Landing implements AfterViewInit, OnDestroy {
  private auth = inject(Auth);
  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  private io?: IntersectionObserver;
  open = signal(new URLSearchParams(location.search).has('signin'));
  ask = 'mailto:info@medipol.dev?subject=Redline%20access';
  links = [
    { id: 'parts', name: '3D parts' }, { id: 'board', name: 'Circuit board' },
    { id: 'firmware', name: 'Firmware' }, { id: 'cost', name: 'Cost' },
  ];
  /** Something has to be done first: the sheet stays, with no way out. */
  forced = computed(() => {
    const s = this.auth.state();
    return !!s?.needs_setup || !!s?.must_change_password || !!this.auth.next()
      || new URLSearchParams(location.search).has('reset');
  });

  close() { if (!this.forced()) this.open.set(false); }

  /** In-page links scroll the page itself, not the address. */
  go(e: Event, id: string) {
    e.preventDefault();
    this.host.nativeElement.querySelector('#' + id)?.scrollIntoView({ behavior: 'smooth' });
  }

  /** Sections rise in as they come into view; all at once without motion. */
  ngAfterViewInit() {
    const el = this.host.nativeElement;
    if (!('IntersectionObserver' in window) || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.classList.add('static');
      return;
    }
    this.io = new IntersectionObserver(es => es.forEach(x => {
      if (x.isIntersecting) { x.target.classList.add('in'); this.io?.unobserve(x.target); }
    }), { root: el, threshold: .1 });
    el.querySelectorAll('.rv, #heroband').forEach(n => this.io!.observe(n));
  }

  ngOnDestroy() { this.io?.disconnect(); }
}
