import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Selection } from '../selection';
import { T, t } from '../i18n';
import { BodySource, BodySpec, PartBodyView } from './part-body-view';
import { fetchJson, specUrl } from './part-assets';

/** One of a part's 3D bodies (backend/bodies.py listing). */
export interface PartBody {
  slug: string; name: string; kind: 'lcsc' | 'drawn'; default: boolean;
  model: string | null; ready: boolean; detail?: string;
  by?: { name?: string } | null; at?: string | null; model_version?: number | null; step_bytes?: number | null;
}
export interface PartBodies { lcsc: string; name?: string; in_drawer: boolean; default: string; bodies: PartBody[] }

interface ModelOpt { id: string; title: string }

/** A drawn body's build, the 3D room's viewer payload. Served immutable,
 *  so the model's version is in the URL. */
const payloadUrl = (b: PartBody) => `/api/models/${b.model}/viewer.json?v=${b.model_version ?? 0}`;

/** The part card's 3D: a viewer with a switch across the part's bodies -
 *  LCSC's model and the ones drawn in the 3D room for it - the default
 *  marked. The one picked is shown in the component frame, on its pads.
 *  Someone who may change the design picks the default, binds a built
 *  model as a new body, or unbinds one; someone who may queue notes asks
 *  the 3D room to draw one. */
@Component({
  selector: 'app-part-bodies',
  imports: [T, PartBodyView],
  styleUrl: '../settings.css',
  styles: [`
    :host { display: flex; flex-direction: column; min-width: 0; }
    .st-card { display: flex; flex-direction: column; flex: 1; }
    .st-card-head { flex-wrap: nowrap; }
    .pb-seg { margin-left: auto; min-width: 0; max-width: 100%; overflow-x: auto; scrollbar-width: none; }
    .pb-seg button { display: inline-flex; align-items: center; gap: 5px; }
    .pb-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
    .pb-view { position: relative; flex: 1 1 auto; min-height: 260px; border-bottom: 1px solid var(--line);
               background: linear-gradient(var(--view-top), var(--view-mid) 60%, var(--view-bottom)); }
    .pb-list { display: flex; flex-direction: column; }
    .pb-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 2px 8px;
              padding: 6px 10px; border-left: 2px solid transparent; cursor: pointer; }
    .pb-row + .pb-row { border-top: 1px solid var(--line); }
    .pb-row:hover { background: var(--hover); }
    .pb-row[data-on] { border-left-color: var(--accent); background: var(--surface-2); }
    .pb-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .pb-name { font-size: 12px; font-weight: 600; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pb-meta { grid-column: 1; display: flex; flex-wrap: wrap; gap: 0 6px; min-width: 0;
               font: 10.5px 'IBM Plex Mono', ui-monospace, monospace; color: var(--ink-dim); }
    .pb-meta > span { min-width: 0; overflow-wrap: anywhere; }
    .pb-meta .warn { color: var(--warn); }
    .pb-link { padding: 0; font: inherit; color: var(--accent); background: none; border: 0; cursor: pointer; text-align: left; }
    .pb-link:hover { text-decoration: underline; }
    .pb-acts { grid-column: 2; grid-row: 1 / span 2; display: flex; align-items: center; gap: 4px; }
    .pb-btn { padding: 2px 8px; font-size: 11px; color: var(--ink); background: var(--surface-2);
              border: 1px solid var(--line); border-radius: 4px; cursor: pointer; white-space: nowrap; }
    .pb-btn:hover:not(:disabled) { border-color: var(--ink-dim); }
    .pb-btn:disabled { opacity: .5; cursor: default; }
    .pb-btn.accent { color: var(--ink-on-accent); background: var(--accent); border-color: var(--accent); }
    .pb-x { width: 22px; height: 22px; padding: 0; font-size: 14px; line-height: 1; color: var(--ink-dim);
            background: none; border: 1px solid transparent; border-radius: 4px; cursor: pointer; }
    .pb-x:hover:not(:disabled) { color: var(--danger); border-color: var(--line); }
    .pb-foot { display: flex; flex-direction: column; gap: 8px; padding: 8px 10px; border-top: 1px solid var(--line); }
    .pb-tabs { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; }
    .pb-tab { padding: 0; font-size: 11px; color: var(--ink-dim); background: none; border: 0; cursor: pointer; }
    .pb-tab:hover, .pb-tab[data-on] { color: var(--ink); }
    .pb-tab::before { content: '+'; display: inline-block; width: 10px; color: var(--accent); }
    .pb-tab[data-on]::before { content: '−'; }
    .pb-form { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .pb-form .st-in { padding: 3px 7px; font-size: 11.5px; }
    .pb-check { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--ink-dim); }
  `],
  template: `
  <div class="st-card">
    <div class="st-card-head">
      <h3>3D</h3>
      @if (shown(); as b) {
        <span class="st-sub" style="white-space: nowrap">{{ b.kind === 'drawn' ? ('drawn in the 3D room' | t) : ('from LCSC' | t) }}</span>
      }
      @if (bodies().length > 1) {
        <div class="st-seg pb-seg" role="tablist" [attr.aria-label]="'3D bodies' | t">
          @for (b of bodies(); track b.slug) {
            <button role="tab" [class.on]="b.slug === pick()" [attr.aria-selected]="b.slug === pick()"
                    (click)="pick.set(b.slug)" [title]="b.default ? ('The default: every board wears it unless it chooses another' | t) : b.name">
              @if (b.default) { <i class="pb-dot" aria-hidden="true"></i> }{{ b.kind === 'lcsc' ? 'LCSC' : b.name }}
            </button>
          }
        </div>
      }
    </div>

    <div class="pb-view">
      <app-part-body-view [src]="source()" [spec]="spec()" />
    </div>

    @if (inDrawer()) {
      @if (data()) {
        <div class="pb-list" role="list">
          @for (b of bodies(); track b.slug) {
            <div class="pb-row" role="listitem" [attr.data-on]="b.slug === pick() ? 1 : null" (click)="pick.set(b.slug)">
              <div class="pb-top">
                <span class="pb-name">{{ b.kind === 'lcsc' ? 'LCSC' : b.name }}</span>
                @if (b.default) { <span class="st-badge" data-tone="accent">{{ 'default' | t }}</span> }
                @if (!b.ready) { <span class="st-badge" data-tone="warn">{{ b.kind === 'lcsc' ? ('no model' | t) : ('not built' | t) }}</span> }
              </div>
              <div class="pb-meta">
                @if (b.kind === 'lcsc') {
                  <span>{{ b.detail }}</span>
                } @else {
                  @if (b.model) {
                    <span><button class="pb-link" (click)="open(b.model); $event.stopPropagation()"
                                  [title]="'Open it in the 3D room' | t">{{ b.model }} &#8599;</button></span>
                  }
                  @if (b.model_version) { <span>v{{ b.model_version }}</span> }
                  @if (b.step_bytes) { <span>{{ kb(b.step_bytes) }} kB STEP</span> }
                  @if (!b.ready) { <span class="warn">{{ b.detail }}</span> }
                  @if (b.by?.name) { <span>· {{ b.by?.name }}</span> }
                }
              </div>
              @if (canEdit()) {
                <div class="pb-acts" (click)="$event.stopPropagation()">
                  @if (!b.default) {
                    <button class="pb-btn" (click)="makeDefault(b)" [disabled]="busy() || !b.ready"
                            [title]="'Make it the default on every board' | t">{{ 'Make default' | t }}</button>
                  }
                  @if (b.kind === 'drawn') {
                    <button class="pb-x" (click)="unbind(b)" [disabled]="busy()" [attr.aria-label]="('Unbind' | t) + ': ' + b.name"
                            [title]="'Unbind it from the part (the model stays in the 3D room)' | t">&times;</button>
                  }
                </div>
              }
            </div>
          }
        </div>
      } @else if (!error()) {
        <p class="st-hint" style="padding: 8px 10px">…</p>
      }

      @if (canEdit() || canRun() || error() || said()) {
        <div class="pb-foot">
          @if (canEdit() || canRun()) {
            <div class="pb-tabs">
              @if (canEdit()) {
                <button class="pb-tab" [attr.data-on]="form() === 'bind' ? 1 : null" [attr.aria-expanded]="form() === 'bind'"
                        (click)="toggle('bind')">{{ 'Bind a built model' | t }}</button>
              }
              @if (canRun()) {
                <button class="pb-tab" [attr.data-on]="form() === 'ask' ? 1 : null" [attr.aria-expanded]="form() === 'ask'"
                        (click)="toggle('ask')">{{ 'Ask the 3D room to draw one' | t }}</button>
              }
            </div>
          }
          @if (form() === 'bind' && canEdit()) {
            <div class="pb-form">
              <select class="st-in" style="flex: 1 1 12rem; max-width: 18rem" [attr.aria-label]="'a built 3D model…' | t"
                      (focus)="loadModels()" (change)="model.set($any($event.target).value)">
                <option value="">{{ 'a built 3D model…' | t }}</option>
                @for (m of models(); track m.id) { <option [value]="m.id" [selected]="m.id === model()">{{ m.id }}</option> }
              </select>
              <input class="st-in" style="flex: 0 1 9rem" [placeholder]="'name, e.g. lying flat' | t" [attr.aria-label]="'name' | t"
                     [value]="name()" (input)="name.set($any($event.target).value)" maxlength="40">
              <label class="pb-check"><input type="checkbox" [checked]="asDefault()"
                     (change)="asDefault.set($any($event.target).checked)">{{ 'default' | t }}</label>
              <button class="pb-btn accent" (click)="bind()" [disabled]="busy() || !model() || !name().trim()">{{ 'Bind' | t }}</button>
            </div>
          }
          @if (form() === 'ask' && canRun()) {
            <div class="pb-form">
              <input class="st-in" style="flex: 0 1 9rem" [placeholder]="'name' | t" [attr.aria-label]="'name' | t"
                     [value]="reqName()" (input)="reqName.set($any($event.target).value)" maxlength="40">
              <input class="st-in" style="flex: 1 1 12rem" [placeholder]="'what it is for' | t" [attr.aria-label]="'what it is for' | t"
                     [value]="reqWhy()" (input)="reqWhy.set($any($event.target).value)">
              <button class="pb-btn accent" (click)="request()" [disabled]="busy() || !reqName().trim() || !reqWhy().trim()">{{ 'Send to 3D queue' | t }}</button>
            </div>
          }
          @if (error()) { <p class="st-err">{{ error() }}</p> }
          @if (said()) { <p class="st-msg">{{ said() }}</p> }
        </div>
      }
    }
  </div>
  `,
})
export class PartBodiesCard {
  private http = inject(HttpClient);
  private sel = inject(Selection);
  lcsc = input.required<string>();
  /** LCSC's GLB, and whether LCSC has a model at all (the preview's has_model). */
  glb = input.required<string>();
  hasModel = input(false);
  modelName = input<string | null>(null);
  /** Bodies are kept on a part in the drawer; outside it only LCSC's is shown. */
  inDrawer = input(false);
  canEdit = input(false);
  canRun = input(false);

  data = signal<PartBodies | null>(null);
  spec = signal<BodySpec | null>(null);
  pick = signal('lcsc');
  form = signal<'' | 'bind' | 'ask'>('');
  models = signal<ModelOpt[]>([]);
  model = signal('');
  name = signal('');
  asDefault = signal(false);
  reqName = signal('');
  reqWhy = signal('');
  busy = signal(false);
  error = signal('');
  said = signal('');

  /** The switch's bodies: the listing, or LCSC's alone outside the drawer. */
  bodies = computed<PartBody[]>(() => {
    const d = this.data();
    if (d && this.inDrawer()) return d.bodies;
    return [{ slug: 'lcsc', name: 'LCSC', kind: 'lcsc', default: true, model: null, ready: this.hasModel(),
              detail: this.modelName() ?? undefined }];
  });
  shown = computed(() => this.bodies().find(b => b.slug === this.pick()) ?? this.bodies()[0]);

  /** What the viewer loads for the body picked. */
  source = computed<BodySource | null>(() => {
    const b = this.shown();
    if (!b) return null;
    if (b.kind === 'lcsc') return this.hasModel() ? { kind: 'glb', url: this.glb() } : null;
    if (!b.model || !b.ready) return null;
    return { kind: 'tcv', url: payloadUrl(b) };
  });

  constructor() {
    effect(() => {
      const c = this.lcsc();
      this.data.set(null); this.spec.set(null); this.pick.set('lcsc');
      this.error.set(''); this.said.set(''); this.form.set('');
      if (this.inDrawer()) this.load(c);
      // The footprint in the component frame: the pads under the body,
      // and where LCSC's box sits. Nothing is lost without it.
      fetchJson<BodySpec>(specUrl(c)).then(s => { if (c === this.lcsc()) this.spec.set(s); }, () => {});
    });
  }

  private url(rest = '') { return `/api/parts/${encodeURIComponent(this.lcsc())}/bodies${rest}`; }

  load(c = this.lcsc()) {
    this.http.get<PartBodies>(`/api/parts/${encodeURIComponent(c)}/bodies`).subscribe({
      next: d => {
        if (d.lcsc !== this.lcsc()) return;
        this.data.set(d);
        // The drawn bodies' payloads too, so switching to one is instant.
        for (const b of d.bodies) if (b.kind === 'drawn' && b.model && b.ready) void fetchJson(payloadUrl(b)).catch(() => {});
        if (!d.bodies.some(b => b.slug === this.pick())) this.pick.set(d.default || 'lcsc');
      },
      error: () => this.error.set(t('could not read its 3D bodies')),
    });
  }

  toggle(f: 'bind' | 'ask') {
    this.form.set(this.form() === f ? '' : f);
    if (f === 'bind') this.loadModels();
  }

  kb(bytes: number): number { return Math.round(bytes / 1024); }

  loadModels() {
    if (this.models().length) return;
    this.http.get<any>('/api/catalog').subscribe(tree => {
      const out: ModelOpt[] = [];
      const walk = (n: any) => {
        for (const m of n.models ?? []) if (m.data) out.push({ id: m.id, title: m.title });
        for (const f of n.folders ?? []) walk(f);
      };
      walk(tree);
      out.sort((a, b) => a.id.localeCompare(b.id));
      this.models.set(out);
    });
  }

  private done(text: string) { this.busy.set(false); this.error.set(''); this.said.set(text); this.load(); }
  private fail(e: any) { this.busy.set(false); this.said.set(''); this.error.set(e?.error?.detail ?? t('refused')); }

  makeDefault(b: PartBody) {
    this.busy.set(true);
    this.http.put<{ default: string; queued: string[] }>(this.url('/default'), { variant: b.slug }).subscribe({
      next: r => this.done(t('Default') + ': ' + b.name + (r.queued?.length ? ' - ' + t('redrawing') + ' ' + r.queued.join(', ') : '')),
      error: e => this.fail(e),
    });
  }

  bind() {
    this.busy.set(true);
    this.http.post<{ body: PartBody }>(this.url(), { model: this.model(), name: this.name().trim(), default: this.asDefault() })
      .subscribe({ next: r => { this.name.set(''); this.pick.set(r.body.slug); this.done(t('Bound') + ': ' + r.body.name); },
                   error: e => this.fail(e) });
  }

  unbind(b: PartBody) {
    if (!confirm(t('Unbind this body from the part? The model stays in the 3D room.') + `\n\n${b.name} - ${b.model}`)) return;
    this.busy.set(true);
    this.http.delete(this.url('/' + encodeURIComponent(b.slug))).subscribe({
      next: () => { if (this.pick() === b.slug) this.pick.set('lcsc'); this.done(t('Unbound') + ': ' + b.name); },
      error: e => this.fail(e) });
  }

  request() {
    this.busy.set(true);
    this.http.post<{ note: string; model: string }>(`/api/parts/${encodeURIComponent(this.lcsc())}/body-request`,
      { name: this.reqName().trim(), why: this.reqWhy().trim() }).subscribe({
      next: r => { this.reqName.set(''); this.reqWhy.set(''); this.done(t('Queued for the 3D room') + `: ${r.model}`); },
      error: e => this.fail(e),
    });
  }

  open(model: string) { this.sel.room.set('cad'); this.sel.ask('model', model); }
}
