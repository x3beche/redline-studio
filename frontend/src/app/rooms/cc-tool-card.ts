import { Component, computed, input } from '@angular/core';
import { T, t } from '../i18n';
import type { CcStep } from './commandcode';
import { FileModal } from './file-modal';

const CHART = 'M4 20h16 M7 16v-5 M11 16V7 M15 16v-7 M19 16V4';
const SHELF = 'M3 8l9-5 9 5v12H3z M3 8h18 M7 20v-7h10v7 M7 16.5h10';
const FILE = 'M6 3h8l4 4v14H6z M14 3v4h4';
const CHAT = 'M4 5h16v11H9l-5 4z M8 9h8 M8 12h5';
const SWATCH = 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z';
const FACTORY = 'M3 20V10l5 3V10l5 3V6h3l1 4h1l1-6h2v16z M7 16h2 M12 16h2 M17 16h1';

/** The tools whose steps get a card (backend/chat_tools): the rest show their row only. */
const CARDS = new Set(['price_history', 'stock_low', 'files_search', 'dm_send', 'taste_propose', 'manufacturer_explore']);

/** What one step of an answer gave, as a row under it (rooms/commandcode.ts #stepsT): a price's line over
 *  time, what is low in stock, the files found - and, for a tool that asks first, what it will do, read
 *  before Allow / Deny (the exact message and who it goes to). Built from the step's own `vars` and `args`;
 *  nothing is asked of the server. */
@Component({
  selector: 'app-cc-tool-card',
  imports: [T],
  styleUrl: './cc-tool-card.css',
  template: `
@let s = step();
@let v = s.vars ?? {};
@switch (s.tool) {
  @case ('price_history') {
    @if (s.status === 'done' && v['last'] != null) {
      <div class="cct">
        <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="CHART" /></svg>
        <span class="cct-name" [title]="'' + v['name']">{{ v['name'] }}</span>
        <span class="cct-fig"><b>{{ v['last'] }} {{ v['cur'] }}</b></span>
        <span class="cct-fig" [title]="'lowest – highest' | t">{{ v['low'] }} – {{ v['high'] }}</span>
        @if (v['change']) { <span class="cct-fig">{{ v['change'] }}</span> }
        @if (points(); as pts) {
          <svg class="cct-spark" viewBox="0 0 100 24" preserveAspectRatio="none" role="img" [attr.aria-label]="'Price history' | t">
            <polyline [attr.points]="pts" />
          </svg>
        } @else { <span class="cct-grow"></span> }
        <span class="cct-fig">{{ v['n'] }} {{ 'readings' | t }}</span>
        @if (v['link']) { <a [href]="str(v['link'])">{{ 'Open in Parts' | t }}</a> }
      </div>
    }
  }
  @case ('stock_low') {
    @if (s.status === 'done' && +v['n'] > 0) {
      <div class="cct">
        <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="SHELF" /></svg>
        <span class="cct-fig"><b>{{ v['n'] }}</b> {{ 'low' | t }}</span>
        <span class="cct-fig"><b>{{ v['sellers'] }}</b> {{ 'sellers' | t }}</span>
        <span class="cct-fig"><b>{{ v['reorder'] }}</b> {{ 'to reorder' | t }}</span>
        @if (+v['missing']) { <span class="cct-fig"><b>{{ v['missing'] }}</b> {{ 'without a reorder rule' | t }}</span> }
        <span class="cct-grow"></span>
        @if (v['file']) {
          <button type="button" class="cct-link" (click)="openFile()">{{ 'Shopping list' | t }}@if (v['total']) { · {{ v['total'] }}}</button>
        }
        <a href="/parts/stock">{{ 'Open Stock' | t }}</a>
      </div>
    }
  }
  @case ('files_search') {
    @if (s.status === 'done' && +v['n'] > 0) {
      <div class="cct">
        <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="FILE" /></svg>
        <span class="cct-fig"><b>{{ v['n'] }}</b> {{ (+v['n'] === 1 ? 'file' : 'files') | t }}</span>
        <span class="cct-files">
          @for (f of found(); track f.link) { <a [href]="f.link" [title]="f.name">{{ f.name }}</a> }
        </span>
        <a [href]="v['area'] === 'deleted' ? '/files/deleted' : '/files'">{{ 'Open Files' | t }}</a>
      </div>
    }
  }
  @case ('dm_send') {
    @if (s.status === 'ask' || s.status === 'running') {
      <div class="cct ask">
        <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="CHAT" /></svg>
        <span class="cct-label">{{ 'To' | t }}</span>
        <span class="cct-name">{{ arg('person') }}</span>
        <span class="cct-grow"></span>
        <span class="cct-fig">{{ arg('text').length }} {{ 'characters' | t }}</span>
        <p class="cct-quote">{{ arg('text') }}</p>
      </div>
    } @else if (s.status === 'done' && v['thread']) {
      <div class="cct">
        <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="CHAT" /></svg>
        <span class="cct-label">{{ 'Sent to' | t }}</span>
        <span class="cct-name">{{ v['name'] }}</span>
        <span class="cct-text cct-fig">{{ clip(arg('text')) }}</span>
        <a [href]="'/dm/' + v['thread']">{{ 'Open the conversation' | t }}</a>
      </div>
    }
  }
  @case ('taste_propose') {
    @if (s.status === 'ask' || (s.status === 'done' && v['run'])) {
      <div class="cct">
        <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="SWATCH" /></svg>
        <span class="cct-word">{{ (arg('strength') === 'avoid' ? 'Avoid' : 'Prefer') | t }}</span>
        <span class="cct-text">{{ arg('text') }}</span>
        @if (arg('scope')) { <span class="cct-fig">{{ arg('scope') }}</span> }
        @if (s.status === 'done') { <a [href]="str(v['link'])">{{ 'Review in Taste' | t }}</a> }
      </div>
    }
  }
  @case ('manufacturer_explore') {
    @if (s.status === 'ask') {
      <div class="cct">
        <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="FACTORY" /></svg>
        <span class="cct-name">{{ arg('manufacturer') || arg('url') }}</span>
        <span class="cct-text cct-fig">{{ 'reads up to 100 pages of the site and costs LLM tokens; one exploration at a time' | t }}</span>
      </div>
    } @else if (s.status === 'done' && v['run']) {
      <div class="cct">
        <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="FACTORY" /></svg>
        <span class="cct-name">{{ v['name'] }}</span>
        <span class="cct-fig">{{ 'run' | t }} {{ v['run'] }} · {{ str(v['status']) | t }}</span>
        <span class="cct-grow"></span>
        <a [href]="str(v['link'])">{{ 'Watch the run' | t }}</a>
      </div>
    }
  }
}
`,
})
export class CcToolCard {
  step = input.required<CcStep>();
  readonly CHART = CHART; readonly SHELF = SHELF; readonly FILE = FILE; readonly CHAT = CHAT;
  readonly SWATCH = SWATCH; readonly FACTORY = FACTORY;

  /** price_history's line: its `spark` is the last readings, each 0-99 between the lowest and the highest. */
  points = computed(() => {
    const raw = String(this.step().vars?.['spark'] ?? '').trim();
    const ys = raw ? raw.split(/\s+/).map(Number).filter(n => Number.isFinite(n)) : [];
    if (ys.length < 2) return '';
    return ys.map((y, i) => `${(100 * i / (ys.length - 1)).toFixed(1)},${(22 - 20 * y / 99).toFixed(1)}`).join(' ');
  });
  /** files_search's first few, as links into Files. */
  found = computed(() => {
    const v = this.step().vars ?? {};
    return [0, 1, 2].filter(i => v['f' + i] && v['l' + i]).map(i => ({ name: String(v['f' + i]), link: String(v['l' + i]) }));
  });

  str(x: unknown): string { return x == null ? '' : String(x); }
  arg(k: string): string { const a = this.step().args?.[k]; return a == null ? '' : String(a); }
  clip(s: string): string { return s.length > 90 ? s.slice(0, 89) + '…' : s; }
  openFile() {
    const v = this.step().vars ?? {};
    FileModal.open({ id: String(v['file']), name: String(v['name'] ?? t('Shopping list')) });
  }
}

/** Whether a step has a card at all (the answer leaves no empty element for the rest). */
export function hasCard(s: CcStep): boolean { return CARDS.has(s.tool); }
