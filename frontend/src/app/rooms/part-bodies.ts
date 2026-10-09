import { Component, effect, inject, input, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Selection } from '../selection';
import { T, t } from '../i18n';

/** One of a part's 3D bodies (backend/bodies.py listing). */
export interface PartBody {
  slug: string; name: string; kind: 'lcsc' | 'drawn'; default: boolean;
  model: string | null; ready: boolean; detail?: string;
  by?: { name?: string } | null; at?: string | null; model_version?: number | null;
}
export interface PartBodies { lcsc: string; name?: string; in_drawer: boolean; default: string; bodies: PartBody[] }

interface ModelOpt { id: string; title: string }

/** The part card's "3D bodies": LCSC's model and the ones drawn in the 3D
 *  room for this part, the default marked. Someone who may change the
 *  design picks the default, binds a built model as a new body, or unbinds
 *  one; someone who may queue notes asks the 3D room to draw one. */
@Component({
  selector: 'app-part-bodies',
  imports: [T],
  styles: [`
    :host { display: block; font-size: 11px; }
    .pb-list { display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: 4px; }
    .pb-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 1px 8px; align-items: center;
              padding: 4px 6px; }
    .pb-row + .pb-row { border-top: 1px dashed var(--line); }
    .pb-def { width: 12px; height: 12px; border-radius: 50%; border: 1px solid var(--ink-dim); background: none;
              padding: 0; cursor: pointer; }
    .pb-def[data-on] { background: var(--accent); border-color: var(--accent); }
    .pb-def:disabled { cursor: default; opacity: .7; }
    .pb-name { color: var(--ink); font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pb-sub { grid-column: 2 / -1; color: var(--ink-dim); min-width: 0; overflow-wrap: anywhere; }
    .pb-sub button { color: var(--accent); background: none; border: 0; padding: 0; cursor: pointer; font: inherit; }
    .pb-warn { color: var(--warn); }
    .pb-x { padding: 0 5px; font-size: 13px; line-height: 16px; color: var(--ink-dim); background: none;
            border: 1px solid transparent; border-radius: 3px; cursor: pointer; }
    .pb-x:hover { color: var(--danger); border-color: var(--line); }
    .pb-form { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin-top: 6px; }
    .pb-form input, .pb-form select { min-width: 0; }
    .pb-err { margin-top: 4px; color: var(--danger); }
    .pb-ok { margin-top: 4px; color: var(--ok); }
  `],
  template: `
  <div class="tcv-label">{{ '3D bodies' | t }}</div>
  @if (data(); as d) {
    <div class="pb-list mt-1">
      @for (b of d.bodies; track b.slug) {
        <div class="pb-row">
          <button class="pb-def" [attr.data-on]="b.default ? 1 : null" [disabled]="!canEdit() || b.default || busy()"
                  (click)="makeDefault(b)"
                  [title]="b.default ? ('The default: every board wears it unless it chooses another' | t)
                                     : ('Make it the default on every board' | t)"
                  [attr.aria-label]="('Default' | t) + ': ' + b.name"></button>
          <span class="pb-name">{{ b.name }}@if (b.default) { <span style="color: var(--ink-dim); font-weight: 400"> · {{ 'default' | t }}</span> }</span>
          @if (b.kind === 'drawn' && canEdit()) {
            <button class="pb-x" (click)="unbind(b)" [disabled]="busy()"
                    [title]="'Unbind it from the part (the model stays in the 3D room)' | t">×</button>
          } @else { <span></span> }
          <span class="pb-sub" [class.pb-warn]="!b.ready">
            @if (b.model) { <button (click)="open(b.model)" [title]="'Open it in the 3D room' | t">{{ b.model }}</button> · }
            {{ b.detail }}</span>
        </div>
      }
    </div>
    @if (canEdit()) {
      <div class="pb-form">
        <select class="tcv-field px-1 py-0.5 text-[11px]" style="max-width: 14rem"
                (focus)="loadModels()" (change)="model.set($any($event.target).value)">
          <option value="">{{ 'a built 3D model…' | t }}</option>
          @for (m of models(); track m.id) { <option [value]="m.id" [selected]="m.id === model()">{{ m.id }}</option> }
        </select>
        <input class="tcv-field px-1 py-0.5 text-[11px]" style="width: 8rem" [placeholder]="'name, e.g. lying flat' | t"
               [value]="name()" (input)="name.set($any($event.target).value)" maxlength="40">
        <label class="flex items-center gap-1"><input type="checkbox" [checked]="asDefault()"
               (change)="asDefault.set($any($event.target).checked)">{{ 'default' | t }}</label>
        <button class="tcv-chip" (click)="bind()" [disabled]="busy() || !model() || !name().trim()">{{ 'Bind' | t }}</button>
      </div>
    }
    @if (canRun()) {
      <details class="mt-1">
        <summary style="color: var(--ink-dim); cursor: pointer">{{ 'Ask the 3D room to draw one' | t }}</summary>
        <div class="pb-form">
          <input class="tcv-field px-1 py-0.5 text-[11px]" style="width: 8rem" [placeholder]="'name' | t"
                 [value]="reqName()" (input)="reqName.set($any($event.target).value)" maxlength="40">
          <input class="tcv-field px-1 py-0.5 text-[11px]" style="flex: 1 1 12rem" [placeholder]="'what it is for' | t"
                 [value]="reqWhy()" (input)="reqWhy.set($any($event.target).value)">
          <button class="tcv-chip" (click)="request()" [disabled]="busy() || !reqName().trim() || !reqWhy().trim()">{{ 'Send to 3D queue' | t }}</button>
        </div>
      </details>
    }
    @if (error()) { <p class="pb-err">{{ error() }}</p> }
    @if (said()) { <p class="pb-ok">{{ said() }}</p> }
  } @else {
    <p class="mt-1" style="color: var(--ink-dim)">…</p>
  }
  `,
})
export class PartBodiesCard {
  private http = inject(HttpClient);
  private sel = inject(Selection);
  lcsc = input.required<string>();
  canEdit = input(false);
  canRun = input(false);

  data = signal<PartBodies | null>(null);
  models = signal<ModelOpt[]>([]);
  model = signal('');
  name = signal('');
  asDefault = signal(false);
  reqName = signal('');
  reqWhy = signal('');
  busy = signal(false);
  error = signal('');
  said = signal('');

  constructor() {
    effect(() => { const c = this.lcsc(); this.data.set(null); this.error.set(''); this.said.set(''); this.load(c); });
  }

  private url(rest = '') { return `/api/parts/${encodeURIComponent(this.lcsc())}/bodies${rest}`; }

  load(c = this.lcsc()) {
    this.http.get<PartBodies>(`/api/parts/${encodeURIComponent(c)}/bodies`).subscribe({
      next: d => { if (d.lcsc === this.lcsc()) this.data.set(d); },
      error: () => this.error.set(t('could not read its 3D bodies')),
    });
  }

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
      .subscribe({ next: r => { this.name.set(''); this.done(t('Bound') + ': ' + r.body.name); }, error: e => this.fail(e) });
  }

  unbind(b: PartBody) {
    if (!confirm(t('Unbind this body from the part? The model stays in the 3D room.') + `\n\n${b.name} - ${b.model}`)) return;
    this.busy.set(true);
    this.http.delete(this.url('/' + encodeURIComponent(b.slug))).subscribe({
      next: () => this.done(t('Unbound') + ': ' + b.name), error: e => this.fail(e) });
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
