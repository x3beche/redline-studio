import { Component, computed, signal } from '@angular/core';
import { fmtEng, fmtNum, parseEng } from '../eng';

// IPC-2221: I = k · ΔT^0.44 · A^0.725, with A the copper's cross-section in
// square mils. Outer layers shed heat into the air, inner ones only into
// the board, so an inner track needs about 2.6 times the section.
const K = { outer: 0.048, inner: 0.024 };
const MIL_PER_OZ = 1.378;              // 1 oz/ft² of copper is 35 µm thick
const MM_PER_MIL = 0.0254;
const RHO_20 = 1.724e-8;               // copper, Ω·m at 20 °C
const ALPHA = 0.00393;                 // and how that rises per °C

type Layer = keyof typeof K;

/** The cross-section a current needs, in square mils. */
function areaFor(amps: number, rise: number, layer: Layer): number {
  return Math.pow(amps / (K[layer] * Math.pow(rise, 0.44)), 1 / 0.725);
}

/** The current a cross-section carries at a temperature rise. */
function ampsFor(areaMil2: number, rise: number, layer: Layer): number {
  return K[layer] * Math.pow(rise, 0.44) * Math.pow(areaMil2, 0.725);
}

/** Resistance of a copper strip, hot: length and section in metres. */
function ohms(lengthM: number, areaM2: number, tempC: number): number {
  return RHO_20 * (1 + ALPHA * (tempC - 20)) * lengthM / areaM2;
}

/** Trace Width: how wide a track has to be for the current it carries,
 *  what it drops and burns on the way, and the same question for a via. */
@Component({
  selector: 'app-trace-width-tool',
  styleUrl: '../calc.css',
  template: `
<div class="calc">
  <section class="calc-sec">
    <div class="calc-title">The track</div>
    <div class="calc-grid">
      <label class="calc-f"><span>current (A)</span>
        <input [value]="amps()" (input)="amps.set($any($event.target).value)" [class.bad]="a() === null" /></label>
      <label class="calc-f"><span>temperature rise (°C)</span>
        <input [value]="rise()" (input)="rise.set($any($event.target).value)" [class.bad]="dt() === null" /></label>
      <label class="calc-f"><span>ambient (°C)</span>
        <input [value]="ambient()" (input)="ambient.set($any($event.target).value)" /></label>
      <label class="calc-f"><span>copper</span>
        <select (change)="oz.set(+$any($event.target).value)">
          @for (o of weights; track o) { <option [value]="o" [selected]="o === oz()">{{ o }} oz · {{ fmtNum(o * 35, 3) }} µm</option> }
        </select></label>
      <label class="calc-f"><span>track length (mm)</span>
        <input [value]="length()" (input)="length.set($any($event.target).value)" /></label>
    </div>
    @if (need(); as n) {
      @for (l of layers; track l) {
        <div class="calc-out">
          <div><span>{{ l === 'outer' ? 'outer layer' : 'inner layer' }} · width</span>
            <b>{{ fmtNum(n[l].mm, 3) }} mm</b><small>{{ fmtNum(n[l].mil, 3) }} mil</small></div>
          <div><span>resistance</span><b>{{ fmtEng(n[l].r, 'Ω') }}</b></div>
          <div><span>voltage drop</span><b>{{ fmtEng(n[l].v, 'V') }}</b></div>
          <div><span>power lost</span><b>{{ fmtEng(n[l].p, 'W') }}</b></div>
        </div>
      }
      @if (n.outside) {
        <div class="calc-warn">Past what IPC-2221's curves were measured on (up to 35 A, 10–100 °C rise,
          10 mm wide) - read it as a rough figure, and widen or pour instead.</div>
      }
    }
  </section>

  <section class="calc-sec">
    <div class="calc-title">What a track of a given width carries</div>
    <div class="calc-grid">
      <label class="calc-f"><span>width (mm)</span>
        <input [value]="width()" (input)="width.set($any($event.target).value)" /></label>
    </div>
    @if (carries(); as c) {
      <div class="calc-out">
        <div><span>outer layer</span><b>{{ fmtNum(c.outer, 3) }} A</b></div>
        <div><span>inner layer</span><b>{{ fmtNum(c.inner, 3) }} A</b></div>
        <div><span>at</span><b>{{ rise() }} °C rise</b><small>{{ oz() }} oz copper</small></div>
      </div>
    }
  </section>

  <section class="calc-sec">
    <div class="calc-title">A via</div>
    <div class="calc-hint">The barrel as a tube of plating, rated like an outer track; a rough guide - use two where one is close.</div>
    <div class="calc-grid">
      <label class="calc-f"><span>drill (mm)</span>
        <input [value]="drill()" (input)="drill.set($any($event.target).value)" /></label>
      <label class="calc-f"><span>plating (µm)</span>
        <input [value]="plating()" (input)="plating.set($any($event.target).value)" /></label>
      <label class="calc-f"><span>board thickness (mm)</span>
        <input [value]="board()" (input)="board.set($any($event.target).value)" /></label>
    </div>
    @if (via(); as v) {
      <div class="calc-out">
        <div><span>carries</span><b>{{ fmtNum(v.amps, 3) }} A</b><small>at {{ rise() }} °C rise</small></div>
        <div><span>resistance</span><b>{{ fmtEng(v.r, 'Ω') }}</b></div>
        @if (a(); as i) {
          <div><span>vias for {{ i }} A</span><b>{{ v.count }}</b></div>
        }
      </div>
    }
  </section>
</div>`,
})
export class TraceWidthTool {
  readonly layers: Layer[] = ['outer', 'inner'];
  readonly weights = [0.5, 1, 2, 3];
  readonly fmtNum = fmtNum;
  readonly fmtEng = fmtEng;

  amps = signal('1');
  rise = signal('10');
  ambient = signal('25');
  oz = signal(1);
  length = signal('50');
  width = signal('0.25');
  drill = signal('0.3');
  plating = signal('25');
  board = signal('1.6');

  a = computed(() => { const v = parseEng(this.amps()); return v && v > 0 ? v : null; });
  dt = computed(() => { const v = parseEng(this.rise()); return v && v > 0 ? v : null; });
  private thickMil = computed(() => this.oz() * MIL_PER_OZ);

  need = computed(() => {
    const i = this.a(), dt = this.dt();
    if (i === null || dt === null) return null;
    const t = this.thickMil();
    const len = (parseEng(this.length()) ?? 0) / 1000;
    const hot = (parseEng(this.ambient()) ?? 25) + dt;
    const one = (l: Layer) => {
      const mil = areaFor(i, dt, l) / t;
      const section = (mil * MM_PER_MIL / 1000) * (t * MM_PER_MIL / 1000);
      const r = len > 0 ? ohms(len, section, hot) : 0;
      return { mil, mm: mil * MM_PER_MIL, r, v: i * r, p: i * i * r };
    };
    const outer = one('outer');
    return {
      outer, inner: one('inner'),
      outside: i > 35 || dt < 10 || dt > 100 || outer.mm > 10.4,
    };
  });

  carries = computed(() => {
    const w = parseEng(this.width()), dt = this.dt();
    if (!w || w <= 0 || dt === null) return null;
    const area = (w / MM_PER_MIL) * this.thickMil();
    return { outer: ampsFor(area, dt, 'outer'), inner: ampsFor(area, dt, 'inner') };
  });

  via = computed(() => {
    const d = parseEng(this.drill()), pl = parseEng(this.plating()), h = parseEng(this.board());
    const dt = this.dt();
    if (!d || !pl || !h || d <= 0 || pl <= 0 || h <= 0 || dt === null) return null;
    const tMm = pl / 1000;
    // The plated ring: π · (d + t) · t, the drill being the inside.
    const sectionMm2 = Math.PI * (d + tMm) * tMm;
    const amps = ampsFor(sectionMm2 / (MM_PER_MIL * MM_PER_MIL), dt, 'outer');
    const hot = (parseEng(this.ambient()) ?? 25) + dt;
    const r = ohms(h / 1000, sectionMm2 / 1e6, hot);
    const i = this.a();
    return { amps, r, count: i ? Math.max(1, Math.ceil(i / amps)) : 0 };
  });
}
