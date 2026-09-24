import { Component, computed, signal } from '@angular/core';
import { SERIES, fmtEng, fmtNum, parseEng, standard, valuesOf } from '../eng';

type Q = 'V' | 'I' | 'R' | 'P';
const OHM: { k: Q; label: string; unit: string }[] = [
  { k: 'V', label: 'voltage (V)', unit: 'V' },
  { k: 'I', label: 'current (A)', unit: 'A' },
  { k: 'R', label: 'resistance (Ω)', unit: 'Ω' },
  { k: 'P', label: 'power (W)', unit: 'W' },
];

/** The other two of V, I, R and P from any two. */
function ohmsLaw(a: [Q, number], b: [Q, number]): Record<Q, number> | null {
  const g = Object.fromEntries([a, b]) as Partial<Record<Q, number>>;
  const { V, I, R, P } = g;
  if (V !== undefined && I !== undefined) return { V, I, R: V / I, P: V * I };
  if (V !== undefined && R !== undefined) return { V, R, I: V / R, P: V * V / R };
  if (V !== undefined && P !== undefined) return { V, P, I: P / V, R: V * V / P };
  if (I !== undefined && R !== undefined) return { I, R, V: I * R, P: I * I * R };
  if (I !== undefined && P !== undefined) return { I, P, V: P / I, R: P / (I * I) };
  if (R !== undefined && P !== undefined) return { R, P, V: Math.sqrt(P * R), I: Math.sqrt(P / R) };
  return null;
}

// What an SMD resistor takes, by size, in watts - used at half, the way a
// part lasts.
const PACKAGES: [string, number][] = [
  ['0402', 0.063], ['0603', 0.1], ['0805', 0.125], ['1206', 0.25], ['2010', 0.75], ['2512', 1],
];

const LEDS = [
  { name: 'red', vf: 2.0 }, { name: 'yellow', vf: 2.1 }, { name: 'green', vf: 3.0 },
  { name: 'blue', vf: 3.1 }, { name: 'white', vf: 3.1 },
];

/** Resistor & LED: Ohm's law from any two, an LED's series resistor in a
 *  value that is made, and a divider from two standard values. */
@Component({
  selector: 'app-resistor-tool',
  styleUrl: '../calc.css',
  template: `
<div class="calc">
  <section class="calc-sec">
    <div class="calc-title">Ohm's law</div>
    <div class="calc-hint">Type any two; the other two follow. <b>4k7</b>, <b>10m</b>, <b>2.2M</b> all read.</div>
    <div class="calc-grid">
      @for (q of ohm; track q.k) {
        <label class="calc-f" [class.given]="given().includes(q.k)">
          <span>{{ q.label }}</span>
          <input [value]="ohmText(q.k)" (input)="edit(q.k, $any($event.target).value)"
                 [class.bad]="given().includes(q.k) && !ohmOk(q.k)" spellcheck="false" />
        </label>
      }
    </div>
  </section>

  <section class="calc-sec">
    <div class="calc-title">LED series resistor</div>
    <div class="calc-grid">
      <label class="calc-f"><span>supply (V)</span>
        <input [value]="supply()" (input)="supply.set($any($event.target).value)" /></label>
      <label class="calc-f"><span>LED forward voltage (V)</span>
        <input [value]="vf()" (input)="vf.set($any($event.target).value)" /></label>
      <label class="calc-f"><span>LED current (mA)</span>
        <input [value]="ledMa()" (input)="ledMa.set($any($event.target).value)" /></label>
      <label class="calc-f"><span>values made in</span>
        <select (change)="ledSeries.set($any($event.target).value)">
          @for (s of seriesNames; track s) { <option [value]="s" [selected]="s === ledSeries()">{{ s }}</option> }
        </select></label>
    </div>
    <div class="calc-hint" style="margin-top: 6px">
      @for (l of leds; track l.name) {
        <button class="tcv-chip" style="margin-right: 4px" (click)="vf.set('' + l.vf)">{{ l.name }} {{ l.vf }} V</button>
      }
    </div>
    @if (led(); as l) {
      <div class="calc-out">
        <div><span>exactly</span><b>{{ fmtEng(l.exact, 'Ω') }}</b></div>
        <div><span>fit ({{ ledSeries() }}, next up)</span><b>{{ fmtEng(l.fit, 'Ω') }}</b></div>
        <div><span>current then</span><b>{{ fmtEng(l.amps, 'A') }}</b></div>
        <div><span>resistor burns</span><b>{{ fmtEng(l.watts, 'W') }}</b><small>{{ l.pkg }} or larger</small></div>
      </div>
    } @else {
      <div class="calc-bad">The supply has to be above the LED's forward voltage, and the current above 0.</div>
    }
  </section>

  <section class="calc-sec">
    <div class="calc-title">Voltage divider</div>
    <div class="calc-hint">Vout = Vin · R2 / (R1 + R2); the standard pair nearest the target, both within the total you allow.</div>
    <div class="calc-grid">
      <label class="calc-f"><span>Vin (V)</span>
        <input [value]="vin()" (input)="vin.set($any($event.target).value)" /></label>
      <label class="calc-f"><span>Vout wanted (V)</span>
        <input [value]="vout()" (input)="vout.set($any($event.target).value)" /></label>
      <label class="calc-f"><span>R1 + R2 from (Ω)</span>
        <input [value]="totLo()" (input)="totLo.set($any($event.target).value)" /></label>
      <label class="calc-f"><span>to (Ω)</span>
        <input [value]="totHi()" (input)="totHi.set($any($event.target).value)" /></label>
      <label class="calc-f"><span>values made in</span>
        <select (change)="divSeries.set($any($event.target).value)">
          @for (s of seriesNames; track s) { <option [value]="s" [selected]="s === divSeries()">{{ s }}</option> }
        </select></label>
    </div>
    @if (divider(); as d) {
      <div class="calc-out">
        <div><span>R1 (top)</span><b>{{ fmtEng(d.r1, 'Ω') }}</b></div>
        <div><span>R2 (bottom)</span><b>{{ fmtEng(d.r2, 'Ω') }}</b></div>
        <div><span>Vout then</span><b>{{ fmtNum(d.out, 5) }} V</b>
          <small>{{ d.err < 0.005 ? 'exact' : fmtNum(d.err, 2) + ' % off' }}</small></div>
        <div><span>draws</span><b>{{ fmtEng(d.amps, 'A') }}</b></div>
        <div><span>source impedance</span><b>{{ fmtEng(d.zout, 'Ω') }}</b><small>what an ADC pin sees</small></div>
      </div>
    } @else {
      <div class="calc-bad">Vout between 0 and Vin, and a total range that holds a pair.</div>
    }
  </section>
</div>`,
})
export class ResistorTool {
  readonly ohm = OHM;
  readonly leds = LEDS;
  readonly seriesNames = Object.keys(SERIES);
  readonly fmtEng = fmtEng;
  readonly fmtNum = fmtNum;

  // ---- Ohm's law ----
  texts = signal<Record<Q, string>>({ V: '5', I: '', R: '1k', P: '' });
  /** The two typed last: the rest is worked out from these. */
  given = signal<[Q, Q]>(['V', 'R']);
  private read = (k: Q) => parseEng(this.texts()[k]);
  ohmOk(k: Q): boolean { const v = this.read(k); return v !== null && v > 0; }
  private solved = computed(() => {
    const [a, b] = this.given();
    const va = this.read(a), vb = this.read(b);
    if (!va || !vb || va <= 0 || vb <= 0) return null;
    return ohmsLaw([a, va], [b, vb]);
  });
  edit(k: Q, text: string) {
    this.texts.update(t => ({ ...t, [k]: text }));
    const [a, b] = this.given();
    if (a !== k) this.given.set([k, a]);
    else this.given.set([k, b]);
  }
  ohmText(k: Q): string {
    if (this.given().includes(k)) return this.texts()[k];
    const s = this.solved();
    return s ? fmtEng(s[k], '', 4) : '';
  }

  // ---- LED ----
  supply = signal('3.3');
  vf = signal('2.0');
  ledMa = signal('5');
  ledSeries = signal('E24');
  led = computed(() => {
    const v = parseEng(this.supply()), f = parseEng(this.vf()), ma = parseEng(this.ledMa());
    if (v === null || f === null || !ma || ma <= 0 || v <= f) return null;
    const i = ma / 1000;
    const exact = (v - f) / i;
    const fit = standard(exact, SERIES[this.ledSeries()], 'up') ?? exact;
    const amps = (v - f) / fit;
    const watts = amps * amps * fit;
    const pkg = (PACKAGES.find(([, w]) => w >= 2 * watts) ?? ['more than 2512'])[0];
    return { exact, fit, amps, watts, pkg };
  });

  // ---- divider ----
  vin = signal('12');
  vout = signal('3.3');
  totLo = signal('10k');
  totHi = signal('1M');
  divSeries = signal('E24');
  divider = computed(() => {
    const vin = parseEng(this.vin()), vout = parseEng(this.vout());
    const lo = parseEng(this.totLo()) ?? 0, hi = parseEng(this.totHi()) ?? Infinity;
    if (!vin || !vout || vout <= 0 || vout >= vin || hi < lo) return null;
    const series = SERIES[this.divSeries()];
    const ratio = vout / vin;
    let best: { r1: number; r2: number; out: number; err: number } | null = null;
    // Every R2 in range, with the R1 nearest the ratio for it; the pair
    // closest to the target wins, a smaller total breaking a tie.
    for (const r2 of valuesOf(series, 1, 1e7)) {
      if (r2 >= hi) break;
      const r1 = standard(r2 * (1 / ratio - 1), series);
      if (!r1 || r1 + r2 < lo || r1 + r2 > hi) continue;
      const out = vin * r2 / (r1 + r2);
      const err = 100 * Math.abs(out - vout) / vout;
      if (!best || err < best.err - 1e-9) best = { r1, r2, out, err };
    }
    if (!best) return null;
    const { r1, r2 } = best;
    return { ...best, amps: vin / (r1 + r2), zout: r1 * r2 / (r1 + r2) };
  });
}
