import { AfterViewInit, Component, ElementRef, OnDestroy, computed, inject, input, signal } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { Auth, SignIn } from './auth';

/** A view of the app, taken 1:1 from the live interface: a static HTML
 *  snapshot (/landing/snap/s-<src>.html - its DOM and CSS, canvases as
 *  pictures, no scripts) rendered at the app's own size and scaled to the
 *  frame. `crop` is the part of the page shown, [x, y, w, h] in the page's
 *  pixels. Text never drops below `min` of its size in the app: a frame too
 *  narrow for the whole crop shows the part of it around `focus` instead.
 *  With `frame` (a width, or [width, height], in the page's pixels) the crop
 *  is shown at the scale that fits that width, centred, dark around it - so views in
 *  one row given one scale show their text at one size. */
@Component({
  selector: 'app-snap',
  template: `<iframe [src]="url()" [width]="page()[0]" [height]="page()[1]" [title]="alt()" loading="lazy"
    sandbox="allow-same-origin" scrolling="no" tabindex="-1" aria-hidden="true" [style.transform]="tf()" [style.clip-path]="clip()"></iframe>`,
  host: { role: 'img', '[attr.aria-label]': 'alt()', '[style.aspect-ratio]': '(fr() ?? box()).slice(-2).join(" / ")' },
  styles: `:host { display: block; position: relative; overflow: hidden; width: 100%; background: #09090b; }
    iframe { position: absolute; left: 0; top: 0; border: 0; display: block; transform-origin: 0 0; pointer-events: none; }`,
})
export class Snap implements AfterViewInit, OnDestroy {
  private el = inject<ElementRef<HTMLElement>>(ElementRef);
  private sani = inject(DomSanitizer);
  private ro?: ResizeObserver;
  src = input.required<string>();
  page = input<number[]>([1920, 1080]);
  crop = input<number[] | null>(null);
  focus = input<number[] | null>(null);
  min = input(0.85);
  frame = input<number | number[] | null>(null);
  /** The frame as [width, height] in page pixels, from `frame`. */
  protected fr = computed(() => { const f = this.frame(); return f == null ? null : typeof f === 'number' ? [f, this.box()[3]] : f; });
  alt = input('');
  private width = signal(0);
  box = computed(() => this.crop() ?? [0, 0, this.page()[0], this.page()[1]]);
  url = computed(() => this.sani.bypassSecurityTrustResourceUrl(`/landing/snap/s-${this.src()}.html`));
  tf = computed(() => {
    const [x, y, w, h] = this.box(), bw = this.width();
    if (!bw) return 'scale(0)';
    const f = this.fr();
    if (f) return `scale(${bw / f[0]}) translate(${(f[0] - w) / 2 - x}px, ${(f[1] - h) / 2 - y}px)`;
    const k = Math.max(this.min(), bw / w), vw = bw / k, vh = vw * h / w;
    const [fx, fy] = this.focus() ?? [x, y];
    const x0 = Math.min(Math.max(fx - vw / 2, x), x + w - vw), y0 = Math.min(Math.max(fy - vh / 2, y), y + h - vh);
    return `scale(${k}) translate(${-x0}px, ${-y0}px)`;
  });
  clip = computed(() => {
    if (!this.frame()) return null;
    const [x, y, w, h] = this.box(), [pw, ph] = this.page();
    return `inset(${y}px ${pw - x - w}px ${ph - y - h}px ${x}px)`;
  });
  ngAfterViewInit() {
    const fit = () => this.width.set(this.el.nativeElement.clientWidth);
    fit();
    if ('ResizeObserver' in window) { this.ro = new ResizeObserver(fit); this.ro.observe(this.el.nativeElement); }
  }
  ngOnDestroy() { this.ro?.disconnect(); }
}

type Card = { name: string; lead: string; lbl: string; w: number; wide?: boolean;
              crops: { src: string; crop: number[]; page?: number[]; fit?: boolean; frame?: number[] }[] };

@Component({
  selector: 'app-landing',
  imports: [SignIn, Snap],
  styleUrl: './landing.css',
  host: { '(document:keydown.escape)': 'close()', '(document:click)': 'shutMore($event)' },
  template: `
<nav class="nav">
  <a class="brand" href="/"><svg viewBox="0 0 64 64" aria-hidden="true"><path d="M8 8H56V56H8ZM14 14V30L30 14ZM14 50H22L50 22V14H42L14 42ZM34 50H50V34Z" fill-rule="evenodd"/></svg>Redline</a>
  <!-- Five sections in the bar, the rest under More: the bar never runs into Sign in. -->
  <div class="links">@for (l of links.slice(0, 5); track l.id) { <a [href]="'#' + l.id" (click)="go($event, l.id)">{{ l.name }}</a> }
    <details class="more" #more>
      <summary>More</summary>
      <div class="more-menu">@for (l of links.slice(5); track l.id) {
        <a [href]="'#' + l.id" (click)="go($event, l.id); more.open = false">{{ l.name }}</a> }</div>
    </details>
  </div>
  <div class="nav-r"><button type="button" class="t" (click)="open.set(true)">Sign in</button><a class="btn" [href]="ask">Request access</a></div>
</nav>

<header class="hero wrap">
  <div class="grid top">
    <h1>Redline</h1>
    <p>A hardware design workbench. AI agents design the 3D parts, the circuit board and the firmware of one product, together, and check each other's work.</p>
  </div>
  <div class="shot hero-shot" id="heroband"><app-snap src="hero" [crop]="[0, 0, 1920, 1000]" [min]="0" alt="Redline's 3D Drawing room with the iot-fan station open" /></div>
  <div class="grid under">
    <b>iot-fan, live in the app</b>
    <span>3D Drawing with the station open: the project tree, Working now, a note the Chat agent wrote and its run with tokens and cost, and the queue of drawn notes.</span>
  </div>
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

<section class="wrap" id="rooms">
  <div class="grid sh rv"><h2>Three rooms, one product</h2><p>Parts, board and firmware are built against each other. Change the board, and the case and the pin map follow.</p><span class="n">01</span></div>
  <div class="rooms rv">
    @for (r of rooms; track r.name) {
      <article class="room">
        <div class="shot stack">@for (c of r.crops; track $index) { <app-snap [src]="r.snap" [crop]="c" [min]="r.min" [alt]="r.lbl" /> }</div>
        <p class="lbl">{{ r.lbl }}</p>
        <h3>{{ r.name }}</h3>
        <p class="lead">{{ r.lead }}</p>
        <dl>@for (f of r.facts; track f[0]) { <div><dt>{{ f[0] }}</dt><dd class="num">{{ f[1] }}</dd><em>{{ f[2] }}</em></div> }</dl>
      </article>
    }
  </div>
</section>

<section class="wrap" id="draw">
  <div class="grid sh rv"><h2>Draw it, or write it</h2><p>Mark the model or the board and say what you want. The note keeps the drawing and goes to that room's agent.</p><span class="n">02</span></div>
  <div class="feats rv">
    @for (f of draws; track f.name) {
      <article class="feat" [class.wide]="f.wide">
        <div class="fshot">@for (c of f.crops; track $index) { <app-snap [src]="c.src" [page]="c.page ?? [1920, 1080]" [crop]="c.crop" [min]="0" [frame]="c.fit ? null : (c.frame ?? f.w)" [alt]="f.name" /> }</div>
        <h3>{{ f.name }}</h3>
        <p class="lead">{{ f.lead }}</p>
        <p class="lbl">{{ f.lbl }}</p>
      </article>
    }
  </div>
</section>

<section class="wrap" id="work">
  <div class="grid sh rv"><h2>Notes, chat and agents</h2><p>Ask in Chat. It looks things up with its tools, reads your photos, and writes tasks that go to a room's agent.</p><span class="n">03</span></div>
  <div class="pair rv">
    <div><div class="shot"><app-snap src="chattool" [page]="chatPage" [crop]="chatStep" [min]="0" [frame]="chatFrame" alt="Chat: a tool step, opened" /></div><p class="lbl">Chat · a tool step, opened: model_read lists the 3D models, then the task is written</p></div>
    <div><div class="shot"><app-snap src="chattool" [page]="chatPage" [crop]="chatPhoto" [min]="0" [frame]="chatFrame" alt="Chat: a photo of a screw, read" /></div><p class="lbl">Chat · a photo read: the screw named from the picture</p></div>
  </div>
  <div class="shot wide rv"><app-snap src="chattools" [page]="[1800, 920]" [crop]="[271, 43, 1208, 864]" [min]="0" alt="Chat's conversations and usage card, and the Tools page" /></div>
  <p class="lbl">Chat · the conversations, the plan's usage and the Tools page: uses by tool, and the tools in packages, one for each tab</p>
</section>

<div class="stmt wrap">
  <h2 class="rv">It asks before<br>it guesses<span>.</span></h2>
  <div class="qa rv">
    <div><span>The 3D room's agent, on iot-fan</span><p>The fan's own plug does not fit the board's fan socket (CN1).</p></div>
    <div><span>The answer</span><p class="ans"><i></i>Re-terminate the fan cable with a 2-pin XH plug.</p></div>
    <div class="tg"><app-snap src="tg" [crop]="tgCrop" [min]="0" [frame]="506" alt="Telegram: what the bot understands" />
      <p><b>On your phone too.</b> The agents' questions reach Telegram; answer with a button, or send a note with a photo.</p></div>
  </div>
</div>

<section class="wrap" id="analytics">
  <div class="grid sh rv"><h2>Analytics</h2><p>Every call, job and kilowatt-hour since the first note, 21 September to 11 October.</p><span class="n">04</span></div>
  <div class="shot rv"><app-snap src="analytics" [page]="anPage" [crop]="an.overview" [min]="0" alt="Analytics overview tiles" /></div>
  <p class="lbl">Analytics · Overview, all time</p>
  <div class="pair fit rv">
    <div [style.flex]="ar(an.models)"><div class="shot"><app-snap src="analytics" [page]="anPage" [crop]="an.models" alt="Spend by model and tokens by type" /></div><p class="lbl">Analytics · LLMs: spend by model, tokens by type</p></div>
    <div [style.flex]="ar(an.rooms)"><div class="shot"><app-snap src="analytics" [page]="anPage" [crop]="an.rooms" alt="Spend by room and by kind of work" /></div><p class="lbl">Spend by room and by kind of work</p></div>
  </div>
  <div class="shot wide rv" style="margin-top:28px"><app-snap src="analytics" [page]="anPage" [crop]="an.machine" [min]="0" alt="Machine load, power, energy, compute by job and the jobs table" /></div>
  <p class="lbl">Analytics · Machine &amp; energy: load, power, energy per day, CPU hours by kind of job, and every job counted</p>
</section>

<section class="wrap" id="taste">
  <div class="grid sh rv"><h2>Taste</h2><p>A finished project, distilled into the rules the next one follows. One run read every model, board and firmware in iot-fan.</p><span class="n">05</span></div>
  <div class="stats rv">
    <div class="stat"><span>Read</span><b class="num">17</b><em>of 18 projects · bought parts left out</em><div class="bar"><i style="flex:17;background:var(--s1)"></i><i style="flex:1;background:var(--panel-2)"></i></div></div>
    <div class="stat"><span>Sent</span><b class="num">66k</b><em>tokens · 124,437 characters</em><div class="bar"><i style="flex:1;background:var(--s7)"></i></div></div>
    <div class="stat"><span>Time</span><b class="num">20 s</b><em>one call to Claude Haiku 5.5</em><div class="bar"><i style="flex:1;background:var(--s4)"></i></div></div>
    <div class="stat"><span>Rules</span><b class="num">27</b><em>16 must · 11 prefer</em><div class="bar"><i style="flex:16;background:var(--ink)"></i><i style="flex:11;background:var(--s8)"></i></div></div>
    <div class="stat"><span>Domains</span><b class="num">4</b><em>3D 14 · PCB 7 · FW 2 · general 4</em><div class="bar"><i style="flex:14;background:var(--s1)"></i><i style="flex:7;background:var(--s3)"></i><i style="flex:2;background:var(--s4)"></i><i style="flex:4;background:var(--s7)"></i></div></div>
  </div>
  <div class="shot rv"><app-snap src="taste-home" [crop]="[604, 108, 986, 322]" alt="The Taste tab's overview" /></div>
  <p class="lbl">Taste · overview: palettes, items, MUST / PREFER / AVOID, runs; items by domain; a folder to start from</p>
  <div class="pair rv">
    <div><div class="shot"><app-snap src="taste-run" [crop]="[606, 214, 492, 600]" alt="The finished iot-fan extraction" /></div><p class="lbl">Taste · the iot-fan run: 17 of 18 projects read, 27 proposals</p></div>
    <div><div class="shot"><app-snap src="taste-pal" [crop]="[1097, 279, 492, 600]" alt="3D Project Design Taste: firmware and general rules" /></div><p class="lbl">3D Project Design Taste · the firmware and general columns of the palette</p></div>
  </div>
  <div class="tcols rv">
    @for (c of taste; track c.name) {
      <div class="tcol">
        <h4><i [style.background]="c.color"></i>{{ c.name }}<span class="num">{{ c.n }}</span></h4>
        @for (r of c.rules; track r.text) { <p><b [class.must]="r.must">{{ r.must ? 'Must' : 'Prefer' }}</b>{{ r.text }}</p> }
      </div>
    }
  </div>
  <p class="lbl">The palette from iot-fan, as extracted. Every rule was reviewed before it was kept; attach the palette to a project and its agents follow it.</p>
</section>

<section class="wrap" id="themes">
  <div class="grid sh rv"><h2>Themes</h2><p>28 themes, 22 dark and 6 light, chosen per browser. The 3D backdrop and the code editor follow.</p><span class="n">06</span></div>
  <div class="feats rv">
    @for (f of themes; track f.name) {
      <article class="feat" [class.wide]="f.wide">
        <div class="fshot">@for (c of f.crops; track $index) { <app-snap [src]="c.src" [page]="c.page ?? [1920, 1080]" [crop]="c.crop" [min]="0" [frame]="c.fit ? null : (c.frame ?? f.w)" [alt]="f.name" /> }</div>
        <h3>{{ f.name }}</h3>
        <p class="lead">{{ f.lead }}</p>
        <p class="lbl">{{ f.lbl }}</p>
      </article>
    }
  </div>
</section>

<section class="wrap" id="cost">
  <div class="grid sh rv"><h2>What it cost</h2><p>Connect the plans you already pay for. Redline routes the agents' work through them and prices every call at API rates, so you see what the plans saved.</p><span class="n">07</span></div>
  <div class="save rv">
    <div class="save-x">
      <span>The plans against API prices</span>
      <b class="num">251.9<small>×</small></b>
      <em>₺579,595 of work, paid with ₺2,301 of plans</em>
    </div>
    <div class="save-vs">
      <div class="row"><span>At API list prices</span><b class="num">₺579,595</b></div>
      <div class="t"><i style="width:100%;background:var(--s2)"></i></div>
      <div class="row"><span>Paid, the plans</span><b class="num">₺2,301</b></div>
      <div class="t"><i style="width:.4%;min-width:6px;background:var(--s3)"></i></div>
      <p>Three weeks of work, 21 September to 11 October. Claude Max (₺3,170 a month) and Command Code ($5 a month), prorated over 0.67 months.</p>
    </div>
  </div>
  <div class="stats plans rv">
    @for (p of plans; track p[0]) { <div class="stat"><span><i [style.background]="p[3]"></i>{{ p[0] }}</span><b>{{ p[1] }}</b><em>{{ p[2] }}</em></div> }
  </div>
  <div class="shot rv" style="margin-top:12px"><app-snap src="llm" [page]="[1920, 1400]" [crop]="llmCrop" alt="Settings, LLM settings: the connected providers and the Command Code plan" /></div>
  <p class="lbl">Settings · LLM settings: four providers, nine jobs, the Command Code plan with its windows and spend per day. Keys show as dots.</p>
</section>

<section class="wrap" id="proxy">
  <div class="grid sh rv"><h2>A proxy for part lookups</h2><p>EasyEDA turns bursts of lookups away. A rotating proxy gives them another way out, with its traffic and cost measured.</p><span class="n">08</span></div>
  <div class="feats rv">
    @for (f of proxy; track f.name) {
      <article class="feat" [class.wide]="f.wide">
        <div class="fshot">@for (c of f.crops; track $index) { <app-snap [src]="c.src" [page]="c.page ?? [1920, 1080]" [crop]="c.crop" [min]="0" [frame]="c.fit ? null : (c.frame ?? f.w)" [alt]="f.name" /> }</div>
        <h3>{{ f.name }}</h3>
        <p class="lead">{{ f.lead }}</p>
        <p class="lbl">{{ f.lbl }}</p>
      </article>
    }
  </div>
</section>

<section class="wrap" id="platform">
  <div class="grid sh rv"><h2>Why not build it yourself</h2><p>An agent can write a part. What it needs around it to do a whole product is the rest of this.</p><span class="n">09</span></div>
  <div class="infra rv">
    @for (c of infra; track c.name) {
      <div class="inf">
        <h4><i [style.background]="c.color"></i>{{ c.name }}</h4>
        <b class="num">{{ c.big }}</b><em>{{ c.sub }}</em>
        <ul>@for (l of c.lines; track l) { <li>{{ l }}</li> }</ul>
      </div>
    }
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
  <div class="ld-veil" (click)="veil($event)">
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
    { id: 'rooms', name: 'Rooms' }, { id: 'draw', name: 'Draw' }, { id: 'work', name: 'Agents' }, { id: 'analytics', name: 'Analytics' },
    { id: 'taste', name: 'Taste' }, { id: 'themes', name: 'Themes' }, { id: 'cost', name: 'Cost' }, { id: 'proxy', name: 'Proxy' },
    { id: 'platform', name: 'Platform' },
  ];
  /** The three rooms, each a live view and iot-fan's figures for it. */
  rooms = [
    { name: '3D parts', snap: '3d', crops: [[700, 160, 860, 860]], min: 0, lbl: '3D Drawing · the Station assembly',
      lead: 'Three assemblies built from 26 models. Change one part, and everything that uses it is rebuilt.',
      facts: [['Notes', '58', '57 applied'], ['Assemblies', '3', 'Station, Base, Fan Module'], ['Build', '113-150 s', 'an assembly, from source']] },
    { name: 'Circuit board', snap: 'pcb', crops: [[573, 171, 905, 641]], min: 0, lbl: 'PCB Design · the iot-fan board, routed by TraceMaker',
      lead: 'Real parts from LCSC, placed and routed by TraceMaker: 235 of 235 connections in 121 seconds.',
      facts: [['Size', '95.5 × 58.7 mm', '91 parts, 48 different'], ['Copper', '1,014 tracks', '179 vias · 2.87 m'], ['Parts cost', '$20.51', 'a board, ordering 10 · ERC 0']] },
    { name: 'Firmware', snap: 'fw', crops: [[571, 462, 430, 430]], min: 0.85, lbl: 'Firmware · src/main.cpp',
      lead: 'Written for the board it runs on. Every pin is named from the schematic, and pins.h is rewritten when the board changes.',
      facts: [['Chip', 'ESP32-WROOM-32', 'Arduino on PlatformIO'], ['Pins', '39', 'from the schematic'], ['Build', '0 errors · 8.4 s', 'flash 24.6% · RAM 7.0%']] },
  ];
  /** Cards of app views, a row each: crops of the snapshots [x, y, w, h] in
   *  the page's pixels, `page` when it is not 1920 x 1080. Every view in a
   *  row is shown at one scale - the card's width is `w` page pixels - so
   *  their text is one size; `fit` views (the model, the board) fill it. */
  draws: Card[] = [
    { name: 'Draw on the model', w: 470, lbl: '3D Drawing · draw mode on the Station: seven tools, four inks',
      lead: 'Hold the view, circle what is wrong and say it in a line. The picture and the camera go with the note to the 3D agent.',
      crops: [{ src: 'draw3d', crop: [1158, 46, 438, 36] }, { src: 'draw3d', crop: [662, 162, 860, 860], fit: true }] },
    { name: 'Draw on the board', w: 470, lbl: 'PCB Design · the same pen on the iot-fan board',
      lead: 'The same pen over the layout: circle the part, point where it should go, and say it in your own language.',
      crops: [{ src: 'drawpcb', crop: [1072, 46, 438, 36] }, { src: 'drawpcb', crop: [586, 180, 984, 620], frame: [984, 984] }] },
    { name: 'A note becomes a task', w: 470, lbl: '3D Drawing · a drawn note in the queue',
      lead: 'Auto English turns it into English for the agent. Saved as a draft, then queued; the note keeps its drawing and its status.',
      crops: [{ src: 'hero', crop: [1620, 327, 284, 228], frame: [470, 507] }] },
  ];
  themes: Card[] = [
    { name: 'And your own', w: 430, lbl: 'Settings · Appearance, the light themes, worn in GitHub Light',
      lead: 'Make a theme from any of them and share it as a file; a teammate imports it.',
      crops: [{ src: 'themes', page: [1280, 1100], crop: [542, 551, 406, 383] }] },
    { name: 'Every view follows the theme', w: 290, wide: true, lbl: 'Settings · the same list in Dracula, Nord and Solarized Light',
      lead: 'The whole window takes the theme: panels, lines, text and the accent.',
      crops: [{ src: 'th-dracula', crop: [267, 114, 260, 210] }, { src: 'th-nord', crop: [267, 114, 260, 210] },
              { src: 'th-solarized-light', crop: [267, 114, 260, 210] }] },
  ];
  proxy: Card[] = [
    { name: 'Its state', w: 430, lbl: 'Settings · Proxy & Data: on, the last 7 days of traffic, EasyEDA and the exits\' health',
      lead: 'Whether it is on, what went through it this week and what that cost, and whether EasyEDA answers.',
      crops: [{ src: 'proxy', page: [1280, 1400], crop: [540, 152, 410, 154] }] },
    { name: 'Always, or when refused', w: 430, lbl: 'Settings · Proxy & Data: the mode. Address and login left out.',
      lead: 'Every lookup through it, or only the ones EasyEDA turns away. Each lookup comes out somewhere new.',
      crops: [{ src: 'proxy', page: [1280, 1400], crop: [540, 314, 410, 64] }, { src: 'proxy', page: [1280, 1400], crop: [540, 838, 410, 66] }] },
    { name: 'Where it came out', w: 430, lbl: 'Settings · Proxy & Data: exits over 7 days',
      lead: 'How many addresses and countries, and how often and how fast a lookup worked, with and without it.',
      crops: [{ src: 'proxy', page: [1280, 1400], crop: [540, 912, 410, 218] }] },
  ];
  tgCrop = [1157, 432, 430, 304];
  /** Crops of the analytics snapshot (a 1920 × 3700 page). */
  anPage = [1920, 3700];
  an = { overview: [271, 88, 1328, 326], models: [279, 888, 871, 575], rooms: [1160, 888, 431, 575],
         machine: [271, 2650, 1328, 772] };
  llmCrop = [535, 40, 1060, 900];
  /** flex-grow for a row of crops with one height: each one's width over its height. */
  ar(c: number[]) { return c[2] / c[3]; }
  /** Crops of the Chat snapshot (a 1500 × 3200 page): one frame, so both show text at one size. */
  chatPage = [1500, 3200];
  chatStep = [596, 849, 582, 506];
  chatPhoto = [596, 2201, 582, 648];
  chatFrame = [582, 648];
  /** The plans connected to Redline (Settings > Costs, LLM settings). */
  plans = [
    ['Claude Max', '₺3,170/mo', 'a plan, entered in Settings > Costs', 'var(--s5)'],
    ['Command Code', '$5/mo', '8 of 9 jobs · 4,321 requests this period', 'var(--s1)'],
    ['Claude API', '1 job', '124k tokens this month', 'var(--s2)'],
    ['OpenRouter', '458 models', 'connected · no job on it now', 'var(--s4)'],
    ['Cache', '98.5%', 'of prompt tokens · ₺4.17M not paid', 'var(--s3)'],
  ];
  /** What Redline runs around the agents, in iot-fan's figures. */
  infra = [
    { name: 'Compute', color: 'var(--s1)', big: '1,310 jobs', sub: '35.2 h of CPU · 8.16 kWh',
      lines: ['801 model builds, 342 renders', '78 board runs, 76 layouts, 13 firmware builds', 'queued, run in containers, timed and metered'] },
    { name: 'Storage', color: 'var(--s2)', big: '677 MB', sub: 'database · 168k documents',
      lines: ['250 built models, 344 MB', '229 source versions, 370 history entries', '195 note pictures, 50 files, 2 releases'] },
    { name: 'Agent API and MCP', color: 'var(--s3)', big: '26 tools', sub: 'over MCP, for any agent',
      lines: ['agents connect from their own tools with REDLINE_TRANSPORT=api and a token you can revoke', 'each token sees one workspace; deletes are audited', '221 engineering calculators through find_tool and run_tool'] },
    { name: 'LLM routing and cost', color: 'var(--s4)', big: '21.8k calls', sub: 'each priced and counted',
      lines: ['4 providers: Claude API, Command Code, OpenRouter, OpenCode Go', '9 kinds of job, each with its own model', 'plans you connect, priced against API rates; budgets and spend per note'] },
  ];
  /** iot-fan's taste palette, as extracted (backend/taste.py): two rules a domain. */
  taste = [
    { name: '3D parts', n: 14, color: 'var(--s1)', rules: [
      { must: true, text: 'Every printed overhang is at least 45° from horizontal; the build fails when one is not.' },
      { must: false, text: 'Split tall or sloped parts into halves that print flat, rather than a lip on supports.' } ] },
    { name: 'Circuit board', n: 7, color: 'var(--s3)', rules: [
      { must: true, text: 'Zero courtyard overlaps, zero unconnected pads and zero ERC errors before release.' },
      { must: false, text: 'Parts in stock at LCSC, JLCPCB Basic first, with the LCSC number on each.' } ] },
    { name: 'Firmware', n: 2, color: 'var(--s4)', rules: [
      { must: true, text: 'Fan PWM from a microcontroller pin, the tach on a pulled-up input, so the RPM reads back.' },
      { must: false, text: 'The 12 V fan rail is held on by the firmware while the fan runs.' } ] },
    { name: 'Across them', n: 4, color: 'var(--s7)', rules: [
      { must: true, text: 'Every size comes from the imported part data; the build stops when two disagree.' },
      { must: true, text: 'A new variant gets its own folder; the original project stays untouched.' } ] },
  ];
  /** Something has to be done first: the sheet stays, with no way out. */
  forced = computed(() => {
    const s = this.auth.state();
    return !!s?.needs_setup || !!s?.must_change_password || !!this.auth.next()
      || new URLSearchParams(location.search).has('reset');
  });

  close() { if (!this.forced()) this.open.set(false); }

  /** A click on the dim around the sheet closes it. Returns nothing: a
   *  handler that returns false cancels the click, and with it the form's
   *  submit inside the sheet. */
  veil(e: MouseEvent) { if (e.target === e.currentTarget) this.close(); }

  /** In-page links scroll the page itself, not the address. */
  /** The nav's More menu closes on a click anywhere else. */
  shutMore(e: Event) {
    const d = this.host.nativeElement.querySelector('details.more') as HTMLDetailsElement | null;
    if (d?.open && !d.contains(e.target as Node)) d.open = false;
  }

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
