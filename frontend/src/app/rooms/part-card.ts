import { Component, inject, input, output, signal } from '@angular/core';
import { Parts, PartHeld, PartPreview } from '../api';
import { money } from '../money';
import { T, t } from '../i18n';
import { PartBodiesCard } from './part-bodies';

/** The datasheet as the room holds it: being fetched, at hand, or why not. */
export interface DatasheetState { lcsc: string; state: 'busy' | 'ready' | 'error'; text?: string }

/** ONE PART, IN FULL - the board room's part card, in the Settings pages'
 *  look (settings.css): a header with what it is and what it costs, then
 *  cards for its 3D bodies, footprint, symbol, pins and drawer. The room
 *  (pcb.ts) owns the state and does the work; this lays it out.
 *
 *  The drawings are EasyEDA's own, only ever through <img>, where nothing
 *  in the markup can run. */
@Component({
  selector: 'app-part-card',
  imports: [T, PartBodiesCard],
  styleUrl: '../settings.css',
  styles: [`
    :host { display: block; container-type: inline-size; color: var(--ink); font-size: 12px; }
    .pc-head { display: flex; flex-direction: column; gap: 10px; padding: 12px 12px 12px 16px;
               border-bottom: 1px solid var(--line); background: var(--surface); }
    .pc-top { display: flex; align-items: flex-start; gap: 12px; min-width: 0; }
    .pc-photo { flex: none; width: 52px; height: 52px; object-fit: contain; border-radius: 5px;
                background: var(--shot-bg); border: 1px solid var(--line); }
    .pc-id { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    .pc-mpn { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
    .pc-mpn b { font-size: 16px; font-weight: 600; line-height: 1.2; color: var(--ink-bright);
                overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pc-line { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 8px; font-size: 11px; color: var(--ink-dim); min-width: 0; }
    .pc-line .mono { font-size: 10.5px; }
    .pc-line > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
    .pc-sep { width: 3px; height: 3px; border-radius: 50%; background: var(--line); flex: none; }
    .pc-desc { margin: 0; font-size: 11px; line-height: 1.45; color: var(--ink-dim);
               overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .pc-acts { flex: none; display: flex; align-items: center; gap: 6px; }
    .pc-btn { display: inline-flex; align-items: center; gap: 4px; padding: 3px 9px; font-size: 11px; line-height: 16px;
              color: var(--ink); background: var(--surface-2); border: 1px solid var(--line); border-radius: 4px;
              cursor: pointer; text-decoration: none; white-space: nowrap; }
    .pc-btn:hover:not(:disabled) { border-color: var(--ink-dim); }
    .pc-btn:disabled { opacity: .6; cursor: default; }
    .pc-btn.accent { color: var(--ink-on-accent); background: var(--accent); border-color: var(--accent); }
    .pc-x { width: 26px; height: 26px; padding: 0; font-size: 16px; line-height: 1; color: var(--ink-dim);
            background: none; border: 1px solid transparent; border-radius: 4px; cursor: pointer; }
    .pc-x:hover { color: var(--ink); border-color: var(--line); }
    .pc-in { display: inline-flex; align-items: center; height: 24px; padding: 0 9px; font-size: 11px; line-height: 1;
             color: var(--ok); border: 1px solid var(--ok); border-radius: 4px; white-space: nowrap; }
    .pc-out { color: var(--ink-dim); border-color: var(--line); }
    .st-tiles { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .pc-head .st-tile { background: var(--surface-2); border-color: transparent; }
    .pc-body { display: flex; flex-direction: column; gap: 12px; padding: 12px; background: var(--surface-2); }
    .pc-body .st-card { display: flex; flex-direction: column; }
    .pc-grid { display: grid; grid-template-columns: minmax(0, 7fr) minmax(0, 5fr); gap: 12px; align-items: stretch; }
    .pc-side { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
    .pc-side > .st-card { flex: 1 1 0; }
    .pc-pre { position: relative; flex: 1; min-height: 150px; margin: 8px; border-radius: 4px; overflow: hidden; }
    .pc-pre img { position: absolute; inset: 10px; width: calc(100% - 20px); height: calc(100% - 20px); object-fit: contain; }
    .pc-pre.fp { background: var(--pcb-bg); }
    .pc-pre.sym { background: var(--shot-bg); }
    .pc-pins { padding: 8px 10px; }
    .pc-pins .pdw-pinlist { max-height: 168px; }
    .pc-drawer .st-card-body { gap: 8px; }
    .pc-drawer select { width: 100%; }
    .pc-head-sub { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    @container (max-width: 680px) {
      .pc-grid { grid-template-columns: minmax(0, 1fr); }
      .pc-side { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
    }
    @container (max-width: 520px) {
      .pc-top { flex-wrap: wrap; }
      .pc-acts { order: 3; width: 100%; flex-wrap: wrap; }
      .pc-acts .pc-x { position: absolute; top: 8px; right: 8px; }
      .pc-head { position: relative; }
      .pc-id { padding-right: 28px; }
      .st-tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @container (max-width: 420px) {
      .pc-side { grid-template-columns: minmax(0, 1fr); }
    }
  `],
  template: `
  @let s = part();
  <header class="pc-head">
    <div class="pc-top">
      @if (s.has_photo && !noPhoto()) {
        <img class="pc-photo" [src]="store.file(s.lcsc, 'photo.jpg')" alt="" (error)="noPhoto.set(true)">
      }
      <div class="pc-id">
        <div class="pc-mpn"><b [title]="s.mpn || s.name || ''">{{ s.mpn || s.name || s.lcsc }}</b></div>
        <div class="pc-line">
          @if (s.maker) { <span [title]="s.maker">{{ s.maker }}</span><i class="pc-sep"></i> }
          <span class="mono">{{ s.lcsc }}</span>
          @if (s.package) { <i class="pc-sep"></i><span class="mono" [title]="s.package">{{ s.package }}</span> }
        </div>
        @if (s.description && s.description !== s.mpn) { <p class="pc-desc">{{ s.description }}</p> }
      </div>
      <div class="pc-acts">
        @if (s.have) {
          <span class="pc-in" [title]="'kept on the server, within reach of a board' | t">{{ 'in the drawer' | t }}</span>
        } @else if (canEdit()) {
          <button class="pc-btn accent" (click)="keep.emit()" [disabled]="adding()?.state === 'running'">
            {{ adding()?.state === 'running' && adding()?.lcsc === s.lcsc ? ('adding…' | t) : ('Add to the drawer' | t) }}</button>
        } @else {
          <span class="pc-in pc-out">{{ 'not in the drawer' | t }}</span>
        }
        <!-- The datasheet: fetched from LCSC only when asked, kept on the
             server after that, opened in a tab. -->
        @if (datasheet()?.state === 'ready') {
          <a class="pc-btn" [href]="datasheetUrl()" target="_blank" rel="noreferrer"
             [title]="'Open the datasheet' | t">{{ 'Datasheet' | t }} &#8599;</a>
        } @else {
          <button class="pc-btn" (click)="openDatasheet.emit()" [disabled]="datasheet()?.state === 'busy'"
                  [attr.aria-busy]="datasheet()?.state === 'busy'" [title]="'Fetch the datasheet from LCSC and open it' | t">
            {{ datasheet()?.state === 'busy' ? ('fetching the datasheet…' | t) : ('Datasheet' | t) }}</button>
        }
        @if (s.url) { <a class="pc-btn" [href]="s.url" target="_blank" rel="noreferrer">LCSC &#8599;</a> }
        <button class="pc-x" (click)="closed.emit()" [title]="'close (Esc)' | t" [attr.aria-label]="'close (Esc)' | t">&times;</button>
      </div>
    </div>
    @if (datasheet()?.state === 'error') { <p class="st-err">{{ datasheet()?.text }}</p> }
    <div class="st-tiles">
      <div class="st-tile"><span>{{ 'Price' | t }}</span><b>{{ price() }}</b>
        <small>@if (s.price == null) { {{ 'no price' | t }} } @else if (s.min && s.min > 1) { {{ 'min. order' | t }} {{ s.min }} } @else { {{ 'per piece' | t }} }</small></div>
      <div class="st-tile" [attr.data-tone]="s.stock ? null : 'danger'"><span>{{ 'Stock' | t }}</span><b>{{ count(s.stock) }}</b>
        <small>LCSC</small></div>
      <!-- JLCPCB assembles Basic parts without a loading fee; an Extended
           one costs a feeder per run. -->
      <div class="st-tile" [attr.data-tone]="basic() ? 'ok' : null"
           [title]="basic() ? ('no loading fee at JLCPCB' | t) : ('a feeder fee per assembly run at JLCPCB' | t)">
        <span>JLCPCB</span><b>{{ jlc() }}</b>
        <small>{{ s.jlc_class ? (basic() ? ('no loading fee' | t) : ('feeder fee per run' | t)) : '–' }}</small></div>
      <div class="st-tile"><span>{{ 'Pins' | t }}</span><b>{{ pins()?.length ?? '…' }}</b>
        <small>{{ s.has_model ? ('3D model' | t) : ('footprint only' | t) }}</small></div>
    </div>
  </header>

  <div class="pc-body">
    <div class="pc-grid">
      <app-part-bodies [lcsc]="s.lcsc" [glb]="store.file(s.lcsc, 'model.glb')" [hasModel]="s.has_model"
                       [modelName]="s.model_name" [inDrawer]="s.have"
                       [canEdit]="canEdit()" [canRun]="canRun()" />
      <div class="pc-side">
        <section class="st-card">
          <div class="st-card-head"><h3>{{ 'Footprint' | t }}</h3></div>
          <div class="pc-pre fp"><img [src]="store.file(s.lcsc, 'footprint.svg')" [alt]="'Footprint' | t"></div>
        </section>
        <section class="st-card">
          <div class="st-card-head"><h3>{{ 'Symbol' | t }}</h3></div>
          <div class="pc-pre sym"><img [src]="store.file(s.lcsc, 'symbol.svg')" [alt]="'Symbol' | t"></div>
        </section>
      </div>
    </div>

    <div class="pc-grid">
      <section class="st-card">
        <div class="st-card-head"><h3>{{ 'Pins' | t }}</h3>
          @if (pins(); as ps) { <span class="st-badge">{{ ps.length }}</span> }</div>
        <div class="pc-pins">
          @if (pins(); as ps) {
            @if (ps.length) {
              <ol class="pdw-pinlist">
                @for (n of ps; track n.number) {
                  <li><span class="mono pdw-pnum">{{ n.number }}</span>
                      <span class="pdw-pname" [title]="n.name">{{ n.name === n.number ? '–' : n.name }}</span></li>
                }
              </ol>
            } @else {
              <p class="st-hint">{{ 'its symbol names no pins' | t }}</p>
            }
          } @else {
            <p class="st-hint">{{ 'reading the pins…' | t }}</p>
          }
        </div>
      </section>

      <!-- Which drawer: the rules, a model's pick where they were unsure,
           or somebody's own choice - which wins. -->
      <section class="st-card pc-drawer">
        <div class="st-card-head"><h3>{{ 'Drawer' | t }}</h3>
          @if (held(); as h) {
            <span class="st-right"><span class="st-badge" [attr.data-tone]="h.place_by === 'manual' ? 'accent' : null"
                  [title]="placeTip(h)">{{ placeBy(h) }}</span></span>
          }
        </div>
        <div class="st-card-body">
          @if (held(); as h) {
            <label class="st-f"><span>{{ 'Category' | t }}</span>
              <select class="st-in" [disabled]="!canEdit()" (change)="place.emit($any($event.target).value)">
                @for (pg of places(); track pg.group) {
                  <optgroup [label]="pg.group">
                    @for (b of pg.branches; track b) {
                      <option [value]="pg.group + '/' + b" [selected]="h.group === pg.group && h.branch === b">{{ pg.group }} › {{ b }}</option>
                    }
                  </optgroup>
                }
              </select>
            </label>
            <div class="st-row">
              <span class="st-hint" style="flex: 1; min-width: 0">{{ placeTip(h) }}</span>
              @if (h.place_by === 'manual' && canEdit()) {
                <button class="pc-btn" (click)="place.emit(null)" [title]="'back to where LCSC\\'s category puts it' | t">{{ 'reset' | t }}</button>
              }
            </div>
          } @else if (s.have) {
            <p class="st-hint">…</p>
          } @else {
            <p class="st-hint">{{ 'Not in the drawer yet. Add it to keep its footprint and 3D model on the server, where a board can reach them.' | t }}</p>
          }
        </div>
      </section>
    </div>
  </div>
  `,
})
export class PartCard {
  store = inject(Parts);
  part = input.required<PartPreview>();
  pins = input<{ number: string; name: string }[] | null>(null);
  held = input<PartHeld | undefined>(undefined);
  places = input<{ group: string; branches: string[] }[]>([]);
  adding = input<{ lcsc: string; state: string } | null>(null);
  datasheet = input<DatasheetState | null>(null);
  canEdit = input(false);
  canRun = input(false);

  closed = output<void>();
  keep = output<void>();
  openDatasheet = output<void>();
  /** A drawer as "group/branch", or null for LCSC's category again. */
  place = output<string | null>();

  noPhoto = signal(false);

  datasheetUrl(): string { return `/api/parts/${encodeURIComponent(this.part().lcsc)}/datasheet`; }
  price(): string { const p = this.part().price; return p == null ? '–' : money(p); }
  count(n: number | null): string {
    if (!n) return t('none');
    return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
  }
  basic(): boolean { return (this.part().jlc_class ?? '').toLowerCase().startsWith('basic'); }
  jlc(): string {
    const c = this.part().jlc_class;
    if (!c) return '–';
    return this.basic() ? t('Basic') : /extend/i.test(c) ? t('Extended') : c;
  }
  placeBy(h: PartHeld): string {
    return t(h.place_by === 'manual' ? 'set by hand' : h.place_by === 'llm' ? 'by LLM' : 'by LCSC category');
  }
  placeTip(h: PartHeld): string {
    return h.place_by === 'llm' ? t('LCSC\'s category said too little; a model picked it') + (h.place_model ? ` (${h.place_model})` : '')
      : h.place_by === 'manual' ? t('chosen here - it wins over LCSC and the model')
      : t('from the category LCSC files it under');
  }
}
