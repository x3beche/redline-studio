import { Component, inject, input } from '@angular/core';
import { T } from '../i18n';
import type { CcStep } from './commandcode';
import { Selection } from '../selection';

const CUBE = 'M12 3l8 4.5v9L12 21l-8-4.5v-9z M12 12l8-4.5 M12 12v9 M12 12L4 7.5';
const BOARD = 'M5 5h14v14H5z M9 9h6v6H9z M9 2v3 M15 2v3 M9 19v3 M15 19v3 M2 9h3 M2 15h3 M19 9h3 M19 15h3';
const QUEUE = 'M4 6h16 M4 12h16 M4 18h10 M17 16l3 2-3 2z';

/** A model id in a path: one segment per part, as the API's {model_id:path} takes it. */
function segs(id: string): string { return id.split('/').map(encodeURIComponent).join('/'); }

/** What one of the rooms' tools did, as one row under its step (rooms/commandcode.ts #stepsT): a build or a
 *  board's layout job and how it went, a model's technical drawing with its preview and PDF, a room note's
 *  state - and where to see it in its room. Built from the step's own `vars`; nothing is asked of the server
 *  but the drawing's preview, which is only shown when it is made. */
@Component({
  selector: 'app-cc-room-card',
  imports: [T],
  styleUrl: './cc-room-card.css',
  template: `
@let s = step();
@let v = s.vars ?? {};
@if (s.status === 'done') {
  @switch (s.tool) {
    @case ('model_build') {
      <div class="crc">
        <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="CUBE" /></svg>
        <span class="crc-name" [title]="str(v['model'])">{{ v['title'] }}</span>
        <span class="crc-state" [attr.data-tone]="tone(v['state'])">{{ jobWord(v) | t }}</span>
        @if (v['seconds'] != null && v['state'] !== 'running') { <span class="crc-fig"><b>{{ v['seconds'] }}</b> s</span> }
        @if (+v['artifacts']) { <span class="crc-fig"><b>{{ v['artifacts'] }}</b> {{ 'files' | t }}</span> }
        @if (v['error']) { <span class="crc-why" [title]="str(v['error'])">{{ v['error'] }}</span> } @else { <span class="crc-grow"></span> }
        <span class="crc-fig" [title]="'Build job' | t">{{ v['job'] }}</span>
        @if (v['model']) { <a [href]="'/3d/' + segs(str(v['model']))" (click)="go($event, 'cad', str(v['model']))">{{ 'Open in 3D' | t }}</a> }
      </div>
    }
    @case ('board_route') {
      <div class="crc">
        <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="BOARD" /></svg>
        <span class="crc-name" [title]="str(v['board'])">{{ v['title'] }}</span>
        <span class="crc-state" [attr.data-tone]="tone(v['state'])">{{ jobWord(v) | t }}</span>
        @if (v['unrouted'] != null) { <span class="crc-fig"><b>{{ v['unrouted'] }}</b> {{ 'unrouted' | t }}</span> }
        @if (v['drc'] != null) { <span class="crc-fig">DRC <b>{{ v['drc'] }}</b></span> }
        @if (v['erc'] != null) { <span class="crc-fig">ERC <b>{{ v['erc'] }}</b></span> }
        @if (v['seconds'] != null && v['state'] !== 'running') { <span class="crc-fig"><b>{{ v['seconds'] }}</b> s</span> }
        @if (v['error']) { <span class="crc-why" [title]="str(v['error'])">{{ v['error'] }}</span> } @else { <span class="crc-grow"></span> }
        <span class="crc-fig" [title]="'Layout job' | t">{{ v['job'] }}</span>
        @if (v['board']) { <a [href]="'/pcb/' + segs(str(v['board']))" (click)="go($event, 'pcb', str(v['board']))">{{ 'Open in PCB' | t }}</a> }
      </div>
    }
    @case ('drawing_get') {
      <div class="crc">
        @if (+v['preview'] && v['key']) {
          <a class="crc-thumb" [href]="pdf(v)" target="_blank" rel="noopener" [title]="'Open PDF' | t">
            <img [src]="'/api/models/' + segs(str(v['model'])) + '/drawing.png?k=' + str(v['key'])" alt="" loading="lazy" /></a>
        } @else {
          <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="CUBE" /></svg>
        }
        <span class="crc-name" [title]="str(v['model'])">{{ v['title'] }}</span>
        <span class="crc-state" [attr.data-tone]="drawTone(v['state'])">{{ drawWord(v['state']) | t }}</span>
        @if (v['sheet']) { <span class="crc-fig"><b>{{ v['sheet'] }}</b></span> }
        @if (v['scale']) { <span class="crc-fig">{{ v['scale'] }}</span> }
        @if (+v['views']) { <span class="crc-fig"><b>{{ v['views'] }}</b> {{ 'sheet views' | t }}</span> }
        @if (v['made']) { <span class="crc-fig">{{ v['made'] }}</span> }
        @if (v['error']) { <span class="crc-why" [title]="str(v['error'])">{{ v['error'] }}</span> } @else { <span class="crc-grow"></span> }
        @if (+v['pdf']) { <a [href]="pdf(v)" target="_blank" rel="noopener">{{ 'Open PDF' | t }}</a> }
        @if (v['model']) { <a [href]="'/3d/' + segs(str(v['model']))" (click)="go($event, 'drawing', str(v['model']))">{{ 'Open in 3D' | t }}</a> }
      </div>
    }
    @case ('note_status') {
      <div class="crc">
        <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="QUEUE" /></svg>
        <span class="crc-name" [title]="str(v['note'])">{{ v['title'] }}</span>
        <span class="crc-state" [attr.data-tone]="noteTone(v['state'])">{{ noteWord(v['state']) | t }}</span>
        @if (v['marked'] && v['marked'] !== 'yes') { <span class="crc-fig">{{ markWord(v['marked']) | t }}</span> }
        @if (v['run']) { <span class="crc-fig">{{ 'run' | t }} <b>{{ v['run'] }}</b></span> }
        @if (v['at']) { <span class="crc-fig">{{ v['at'] }}</span> }
        <span class="crc-grow"></span>
        <span class="crc-fig">{{ v['note'] }}</span>
        @if (v['model']) { <a [href]="'/3d?rev=' + str(v['note'])" (click)="go($event, str(v['room']), str(v['model']))">{{ 'Open the note' | t }}</a> }
      </div>
    }
  }
}
`,
})
export class CcRoomCard {
  step = input.required<CcStep>();
  private sel = inject(Selection);
  readonly CUBE = CUBE; readonly BOARD = BOARD; readonly QUEUE = QUEUE;

  str(x: unknown): string { return x == null ? '' : String(x); }
  segs(id: string): string { return segs(id); }
  pdf(v: Record<string, string | number>): string { return '/api/models/' + segs(this.str(v['model'])) + '/drawing.pdf'; }

  tone(state: unknown): string { return state === 'ok' ? 'ok' : state === 'failed' || state === 'lost' ? 'bad' : 'dim'; }
  jobWord(v: Record<string, string | number>): string {
    if (+v['busy']) return 'Already running';
    return ({ running: 'Running', ok: 'Done', failed: 'Failed', lost: 'Lost' } as Record<string, string>)[this.str(v['state'])] ?? this.str(v['state']);
  }
  drawTone(state: unknown): string { return state === 'ready' ? 'ok' : state === 'failed' ? 'bad' : 'dim'; }
  drawWord(state: unknown): string {
    return ({ ready: 'Made', making: 'Being made', failed: 'Failed', none: 'Not made yet', no_step: 'No STEP',
              scheduled: 'Not made yet', queued: 'Being made' } as Record<string, string>)[this.str(state)] ?? this.str(state);
  }
  noteTone(state: unknown): string { return state === 'applied' ? 'ok' : state === 'failed' || state === 'rejected' ? 'bad' : state === 'review' ? '' : 'dim'; }
  noteWord(state: unknown): string {
    return ({ draft: 'Draft', queued: 'Queued', working: 'Working now', review: 'Waiting for review', failed: 'Failed',
              applied: 'Applied', rejected: 'Rejected' } as Record<string, string>)[this.str(state)] ?? this.str(state);
  }
  markWord(m: unknown): string {
    return ({ held: 'Taste check did not pass', checking: 'Taste check running', already: 'Applied already' } as Record<string, string>)[this.str(m)] ?? '';
  }

  /** Opens it in its room, as the step's other links do; a middle click or Ctrl+click opens the address in a tab. */
  go(e: MouseEvent, room: string, id: string) {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0 || !id) return;
    e.preventDefault();
    if (room === 'pcb') this.sel.openBoard(id);
    else if (room === 'firmware') this.sel.openFirmware(id);
    else {
      this.sel.room.set('cad');
      this.sel.ask('model', id);
      if (room === 'drawing') setTimeout(() => this.sel.ask('drawing'), 600);
    }
  }
}
