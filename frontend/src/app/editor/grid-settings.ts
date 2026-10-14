import { Component, computed, inject, signal } from '@angular/core';
import { T } from '../i18n';
import { Prefs } from '../preferences';
import { toHex } from '../../theme';
import {
  AXIS_TOKEN, AXIS_VAR, GRID_AXES, GRID_DEFAULT, GRID_LABELS, GRID_STYLES, GridAxis, GridLook, GridLabels, GridStyle,
  axisColour, currentGrid, setGrid,
} from './grid-pref';

/** Settings > Appearance > 3D grid: how the 3D room's grid is drawn
 *  (grid-look.ts). Every change shows at once in the viewer and in the
 *  sample beside the controls - a top view of one plane with its two axes. */
@Component({
  selector: 'app-grid-settings',
  imports: [T],
  styleUrls: ['../settings.css', './grid-settings.css'],
  template: `
    <div class="st-card">
      <div class="st-card-head"><h3>{{ '3D grid' | t }}</h3>
        <span class="st-sub">{{ 'The grid and axes of the 3D room. Which planes show is on its toolbar\\'s grid button.' | t }}</span></div>
      <div class="st-card-body st-tree">
        <div class="st-tree-opts">
          <div class="st-icons-row">
            <span class="st-sec-title">{{ 'Grid' | t }}</span>
            <span class="st-pick" role="radiogroup" [attr.aria-label]="'Grid' | t">
              @for (s of styles; track s) {
                <button role="radio" [attr.aria-checked]="look().style === s" [class.on]="look().style === s"
                        (click)="pick({ style: s })">{{ styleNames[s] | t }}</button>
              }
            </span>
            <span class="st-icons-about">@if (isDefault()) { {{ 'default' | t }} } @else {
              <button type="button" class="st-tree-reset" (click)="pick(def)">{{ 'Back to the default' | t }}</button> }</span>
          </div>
          <div class="st-icons-row">
            <span class="st-sec-title">{{ 'Strength' | t }}</span>
            <input type="range" class="gs-range" min="10" max="100" step="5" [value]="pct()" [disabled]="look().style === 'off'"
                   [attr.aria-label]="'Strength' | t" (input)="pick({ opacity: +$any($event.target).value / 100 })">
            <span class="st-pick-unit gs-pct">{{ pct() }}%</span>
          </div>
          <div class="st-icons-row">
            <span class="st-sec-title">{{ 'Numbers' | t }}</span>
            <span class="st-pick" role="radiogroup" [attr.aria-label]="'Numbers' | t">
              @for (l of labels; track l) {
                <button role="radio" [attr.aria-checked]="look().labels === l" [class.on]="look().labels === l"
                        (click)="pick({ labels: l })">{{ labelNames[l] | t }}</button>
              }
            </span>
            <span class="st-icons-about">{{ labelAbout[look().labels] | t }}</span>
          </div>
          <div class="st-icons-row">
            <span class="st-sec-title">{{ 'Axes' | t }}</span>
            @for (a of axes; track a) {
              <label class="gs-axis" [attr.data-own]="look().axes[a] ? 1 : null">
                <input type="color" [value]="hex()[a]" [attr.aria-label]="('Axis colour' | t) + ' ' + a.toUpperCase()"
                       (input)="colour(a, $any($event.target).value)">
                <span>{{ a.toUpperCase() }}</span>
              </label>
              @if (look().axes[a]) {
                <button type="button" class="st-tree-reset gs-axis-reset" (click)="colour(a, null)">{{ 'theme' | t }}</button>
              }
            }
          </div>
        </div>
        <svg class="gs-demo" viewBox="0 0 340 190" aria-hidden="true" [style.--gs-op]="look().opacity">
          <defs>
            <radialGradient id="gs-fade" cx="50%" cy="50%" r="60%">
              <stop offset="0.45" stop-color="white" /><stop offset="1" stop-color="black" />
            </radialGradient>
            <mask id="gs-mask"><rect width="340" height="190" fill="url(#gs-fade)" /></mask>
          </defs>
          <g mask="url(#gs-mask)">
            @if (look().style === 'lines') {
              @for (p of minorX; track p) { <line class="gs-minor" [attr.x1]="p" y1="0" [attr.x2]="p" y2="190" /> }
              @for (p of minorY; track p) { <line class="gs-minor" x1="0" [attr.y1]="p" x2="340" [attr.y2]="p" /> }
              @for (p of majorX; track p) { <line class="gs-major" [attr.x1]="p" y1="0" [attr.x2]="p" y2="190" /> }
              @for (p of majorY; track p) { <line class="gs-major" x1="0" [attr.y1]="p" x2="340" [attr.y2]="p" /> }
            } @else if (look().style === 'dots') {
              @for (d of dots; track $index) { <path [class]="d.major ? 'gs-dot gs-dot-major' : 'gs-dot'" [attr.d]="d.d" /> }
            }
            <line class="gs-axisline" x1="0" y1="95.5" x2="340" y2="95.5" [style.stroke]="cssOf('x')" />
            <line class="gs-axisline" x1="170.5" y1="0" x2="170.5" y2="190" [style.stroke]="cssOf('y')" />
          </g>
          @if (look().labels !== 'none') {
            @for (n of tickX; track n.at) { <text class="gs-num" [attr.x]="n.at + 3" y="106">{{ n.text }}</text> }
            @for (n of tickY; track n.at) { <text class="gs-num" x="174" [attr.y]="n.at + 11">{{ n.text }}</text> }
          }
        </svg>
      </div>
    </div>`,
})
export class GridSettings {
  private prefs = inject(Prefs);
  readonly styles = GRID_STYLES;
  readonly labels = GRID_LABELS;
  readonly axes = GRID_AXES;
  readonly def = GRID_DEFAULT;
  readonly styleNames: Record<GridStyle, string> = { lines: 'Lines', dots: 'Dots', off: 'Off' };
  readonly labelNames: Record<GridLabels, string> = { none: 'None', major: 'Major', all: 'All' };
  readonly labelAbout: Record<GridLabels, string> = {
    none: 'No numbers on the axes.',
    major: 'At the major lines, each axis once.',
    all: 'At the major lines, on every plane that is on.',
  };

  look = signal<GridLook>(currentGrid());
  readonly isDefault = computed(() => JSON.stringify(this.look()) === JSON.stringify(GRID_DEFAULT));
  readonly pct = computed(() => Math.round(this.look().opacity * 100));
  /** The pickers' colours: an axis's own, else what the theme worn now gives it. */
  readonly hex = computed(() => {
    this.prefs.theme();
    this.look();
    const out = {} as Record<GridAxis, string>;
    for (const a of GRID_AXES) out[a] = toHex(axisColour(a)).slice(0, 7);
    return out;
  });

  // The sample: 10 px a minor line, a major every 5, centred on 170, 95
  // (on the half pixel, so a 1 px line is one pixel wide).
  readonly minorX = this.steps(170.5, 340, 10, false);
  readonly minorY = this.steps(95.5, 190, 10, false);
  readonly majorX = this.steps(170.5, 340, 10, true);
  readonly majorY = this.steps(95.5, 190, 10, true);
  readonly dots = this.cross();
  // The numbers stay clear of the sample's edges; the unit goes on the last.
  readonly tickX = this.majorX.filter(p => p > 20 && p < 300)
    .map((p, i, all) => ({ at: p, text: this.num((p - 170.5) / 2.5, i === all.length - 1) }));
  readonly tickY = this.majorY.map(p => ({ at: p, text: this.num((95.5 - p) / 2.5, p === Math.min(...this.majorY)) }));

  pick(change: Partial<GridLook>) { this.look.set(setGrid({ ...this.look(), ...change })); }
  colour(a: GridAxis, hex: string | null) { this.pick({ axes: { ...this.look().axes, [a]: hex } }); }
  cssOf(a: GridAxis) { return `var(${AXIS_VAR[a]}, var(${AXIS_TOKEN[a]}))`; }

  private steps(mid: number, len: number, step: number, major: boolean): number[] {
    const out: number[] = [];
    for (let k = -Math.floor(mid / step); mid + k * step <= len; k++) {
      if (k === 0 || (k % 5 === 0) !== major) continue;
      out.push(mid + k * step);
    }
    return out;
  }
  private cross(): { d: string; major: boolean }[] {
    const out: { d: string; major: boolean }[] = [];
    for (let x = 10.5; x < 340; x += 10) for (let y = 5.5; y < 190; y += 10) {
      if (x === 170.5 || y === 95.5) continue;
      const major = (x - 170.5) % 50 === 0 && (y - 95.5) % 50 === 0, r = major ? 2.5 : 1;
      out.push({ d: `M${x - r} ${y}h${2 * r}M${x} ${y - r}v${2 * r}`, major });
    }
    return out;
  }
  private num(v: number, last: boolean): string {
    return (v < 0 ? '−' : '') + Math.abs(Math.round(v)) + (last ? ' mm' : '');
  }
}
