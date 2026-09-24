import { Component, computed, signal } from '@angular/core';
import { fmtEng, fmtNum, parseEng } from '../eng';

// Fields that all say the same quantity: type in any one and the rest
// follow. The field being typed in keeps exactly what was typed -
// rewriting it mid-number would eat the `.` of `1.`.

const LENGTH = [
  { k: 'mm', label: 'mm', per: 1 },
  { k: 'mil', label: 'mil (thou)', per: 0.0254 },
  { k: 'in', label: 'inch', per: 25.4 },
  { k: 'um', label: 'µm', per: 0.001 },
] as const;
type LenK = typeof LENGTH[number]['k'];

const BASES = [
  { k: 'dec', label: 'decimal', radix: 10 },
  { k: 'hex', label: 'hex', radix: 16 },
  { k: 'bin', label: 'binary', radix: 2 },
  { k: 'oct', label: 'octal', radix: 8 },
] as const;
type BaseK = typeof BASES[number]['k'];

/** Units & Numbers: the conversions that come up between a drawing, a
 *  board and a register - lengths, number bases, a UART's divider and a
 *  timer's prescaler. */
@Component({
  selector: 'app-units-tool',
  styleUrl: '../calc.css',
  template: `
<div class="calc">
  <section class="calc-sec">
    <div class="calc-title">Length</div>
    <div class="calc-grid">
      @for (u of length; track u.k) {
        <label class="calc-f" [class.given]="len().k === u.k">
          <span>{{ u.label }}</span>
          <input [value]="lenText(u.k)" (input)="len.set({ k: u.k, text: $any($event.target).value })"
                 [class.bad]="len().k === u.k && lenMm() === null" inputmode="decimal" />
        </label>
      }
    </div>
  </section>

  <section class="calc-sec">
    <div class="calc-title">Number bases</div>
    <div class="calc-hint">Negative decimals are shown as their two's complement in
      <span class="calc-seg">
        @for (w of widths; track w) {
          <button [class.on]="width() === w" (click)="width.set(w)">{{ w }}-bit</button>
        }
      </span>
    </div>
    <div class="calc-grid">
      @for (b of bases; track b.k) {
        <label class="calc-f" [class.given]="num().k === b.k">
          <span>{{ b.label }}</span>
          <input [value]="numText(b.k)" (input)="num.set({ k: b.k, text: $any($event.target).value })"
                 [class.bad]="num().k === b.k && numValue() === null" spellcheck="false" />
        </label>
      }
    </div>
    @if (numValue() !== null) {
      <div class="calc-out">
        <div><span>signed {{ width() }}-bit</span><b>{{ signed() }}</b></div>
        <div><span>bits set</span><b>{{ bitsSet() }}</b></div>
        <div><span>highest bit</span><b>{{ highBit() }}</b></div>
      </div>
    }
    @if (overflow()) { <div class="calc-warn">Does not fit in {{ width() }} bits; shown cut to its low bits.</div> }
  </section>

  <section class="calc-sec">
    <div class="calc-title">UART baud rate</div>
    <div class="calc-hint">STM32 USART (16× oversampling, BRR = clock / baud) and ESP32 (80 MHz APB, a divider in sixteenths).</div>
    <div class="calc-grid">
      <label class="calc-f"><span>peripheral clock (Hz)</span>
        <input [value]="uartClk()" (input)="uartClk.set($any($event.target).value)" /></label>
      <label class="calc-f"><span>baud</span>
        <input [value]="baud()" (input)="baud.set($any($event.target).value)" /></label>
    </div>
    @if (uart(); as u) {
      <div class="calc-out">
        <div><span>BRR</span><b>{{ u.brr }} <small class="mono" style="display:inline">0x{{ u.brr.toString(16).toUpperCase() }}</small></b></div>
        <div><span>actual baud</span><b>{{ fmtNum(u.actual, 6) }}</b></div>
        <div><span>error</span><b [style.color]="u.err > 2 ? 'var(--danger)' : u.err > 1 ? 'var(--warn)' : null">{{ fmtNum(u.err, 2) }} %</b>
          <small>under 2 % is safe for most links</small></div>
      </div>
    } @else { <div class="calc-bad">A clock above the baud rate, and a baud above 0.</div> }
  </section>

  <section class="calc-sec">
    <div class="calc-title">Timer period</div>
    <div class="calc-hint">f = clock / ((PSC + 1) × (ARR + 1)); the pair nearest the target, with the finest step.</div>
    <div class="calc-grid">
      <label class="calc-f"><span>timer clock (Hz)</span>
        <input [value]="timClk()" (input)="timClk.set($any($event.target).value)" /></label>
      <label class="calc-f"><span>target frequency (Hz)</span>
        <input [value]="timF()" (input)="timF.set($any($event.target).value)" /></label>
      <label class="calc-f"><span>counter</span>
        <select (change)="arrBits.set(+$any($event.target).value)">
          <option [value]="16" [selected]="arrBits() === 16">16-bit ARR</option><option [value]="32" [selected]="arrBits() === 32">32-bit ARR</option>
        </select></label>
    </div>
    @if (timer(); as t) {
      <div class="calc-out">
        <div><span>PSC</span><b>{{ t.psc }}</b></div>
        <div><span>ARR</span><b>{{ t.arr }}</b></div>
        <div><span>actual</span><b>{{ fmtEng(t.f, 'Hz', 6) }}</b><small>period {{ fmtEng(1 / t.f, 's', 4) }}</small></div>
        <div><span>error</span><b [style.color]="t.err > 1 ? 'var(--warn)' : null">{{ fmtNum(t.err, 2) }} %</b>
          <small>{{ t.arr + 1 }} steps per period</small></div>
      </div>
    } @else { <div class="calc-bad">Out of reach for this clock: the target is above the clock, or too slow for the prescaler and counter.</div> }
  </section>
</div>`,
})
export class UnitsTool {
  readonly length = LENGTH;
  readonly bases = BASES;
  readonly widths = [8, 16, 32, 64] as const;
  readonly fmtNum = fmtNum;
  readonly fmtEng = fmtEng;

  // ---- length ----
  len = signal<{ k: LenK; text: string }>({ k: 'mm', text: '1.6' });
  lenMm = computed(() => {
    const v = parseEng(this.len().text.replace(',', '.'));
    const u = LENGTH.find(x => x.k === this.len().k)!;
    return v === null ? null : v * u.per;
  });
  lenText(k: LenK): string {
    if (this.len().k === k) return this.len().text;
    const mm = this.lenMm();
    return mm === null ? '' : fmtNum(mm / LENGTH.find(x => x.k === k)!.per, 6);
  }

  // ---- number bases ----
  width = signal<8 | 16 | 32 | 64>(32);
  num = signal<{ k: BaseK; text: string }>({ k: 'hex', text: '1F' });
  private mask = computed(() => (1n << BigInt(this.width())) - 1n);
  /** What was typed, as an unbounded integer; null when it does not read. */
  private raw = computed((): bigint | null => {
    const { k, text } = this.num();
    let t = text.trim().replace(/[_\s]/g, '').toLowerCase();
    const neg = t.startsWith('-');
    if (neg) t = t.slice(1);
    t = t.replace(/^(0x|0b|0o)/, '');
    const digits = { dec: /^\d+$/, hex: /^[0-9a-f]+$/, bin: /^[01]+$/, oct: /^[0-7]+$/ }[k];
    if (!t || !digits.test(t)) return null;
    const prefix = { dec: '', hex: '0x', bin: '0b', oct: '0o' }[k];
    const v = BigInt(prefix + t);
    return neg ? -v : v;
  });
  /** Held as the unsigned pattern of `width` bits. */
  numValue = computed(() => {
    const r = this.raw();
    return r === null ? null : r & this.mask();
  });
  overflow = computed(() => {
    const r = this.raw();
    if (r === null) return false;
    const half = 1n << BigInt(this.width() - 1);
    return r < 0n ? r < -half : r > this.mask();
  });
  numText(k: BaseK): string {
    if (this.num().k === k) return this.num().text;
    const v = this.numValue();
    if (v === null) return '';
    const radix = BASES.find(b => b.k === k)!.radix;
    const s = v.toString(radix).toUpperCase();
    // Binary in nibbles, so a register reads at a glance.
    return k === 'bin' ? s.replace(/\B(?=(\d{4})+(?!\d))/g, ' ') : s;
  }
  signed = computed(() => {
    const v = this.numValue();
    if (v === null) return '–';
    const half = 1n << BigInt(this.width() - 1);
    return String(v >= half ? v - (this.mask() + 1n) : v);
  });
  bitsSet = computed(() => [...(this.numValue() ?? 0n).toString(2)].filter(c => c === '1').length);
  highBit = computed(() => {
    const v = this.numValue();
    return v ? String(v.toString(2).length - 1) : '–';
  });

  // ---- UART ----
  uartClk = signal('80M');
  baud = signal('115200');
  uart = computed(() => {
    const clk = parseEng(this.uartClk()), b = parseEng(this.baud());
    if (!clk || !b || b <= 0 || clk < b) return null;
    const brr = Math.round(clk / b);
    const actual = clk / brr;
    return { brr, actual, err: 100 * Math.abs(actual - b) / b };
  });

  // ---- timer ----
  timClk = signal('72M');
  timF = signal('1k');
  arrBits = signal<number>(16);
  timer = computed(() => {
    const clk = parseEng(this.timClk()), f = parseEng(this.timF());
    if (!clk || !f || f <= 0 || f > clk) return null;
    const maxArr = this.arrBits() === 32 ? 2 ** 32 - 1 : 65535;
    const total = clk / f;
    let best: { psc: number; arr: number; f: number; err: number } | null = null;
    // The smallest prescaler whose counter still fits gives the finest
    // steps; past an exact hit nothing does better.
    for (let psc = 0; psc <= 65535; psc++) {
      const arr = Math.round(total / (psc + 1)) - 1;
      if (arr > maxArr) continue;
      if (arr < 0) break;
      const got = clk / ((psc + 1) * (arr + 1));
      const err = 100 * Math.abs(got - f) / f;
      if (!best || err < best.err - 1e-12) best = { psc, arr, f: got, err };
      if (err === 0) break;
    }
    return best;
  });
}
