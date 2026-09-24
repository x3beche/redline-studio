// Clock tree planner: search the PLL dividers that turn a crystal (or the
// internal RC) into the wanted system clock, then derive the bus and
// peripheral clocks and the flash wait states.
//
// STM32F4 main PLL (RM0090 §6.3.2, RM0383 §6.3.2):
//   f_VCO_in  = f_src / PLLM            1..2 MHz (2 MHz recommended to limit jitter)
//   f_VCO     = f_VCO_in * PLLN          100..432 MHz
//   SYSCLK    = f_VCO / PLLP             PLLP in {2,4,6,8}
//   PLL48CLK  = f_VCO / PLLQ             must be 48 MHz for USB OTG FS, <= 48 MHz for SDIO/RNG
// STM32G4 main PLL (RM0440 §7.4.4):
//   f_VCO_in  = f_src / PLLM (1..16)     2.66..8 MHz
//   f_VCO     = f_VCO_in * PLLN (8..127) 96..344 MHz
//   SYSCLK    = f_VCO / PLLR             PLLR in {2,4,6,8};  PLLQ in {2,4,6,8} feeds 48 MHz / FDCAN
// RP2040 PLL (RP2040 datasheet §2.18.2):
//   f_out = (f_ref / REFDIV) * FBDIV / (POSTDIV1 * POSTDIV2)
//   f_ref/REFDIV >= 5 MHz, FBDIV 16..320, VCO 750..1600 MHz, POSTDIV 1..7
// Timer clocks on STM32: TIMxCLK = PCLKx when the APBx prescaler is 1, else 2 * PCLKx
// (RM0090 §6.2, "timer clock frequencies").
import { fmtEng } from '../kit/eng.js';

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

// Flash wait states: upper HCLK bound of each wait state at 2.7-3.6 V (F4) / range 1 boost (G4).
const FAMILIES = {
  f407: { name: 'STM32F405/407', kind: 'f4', hsi: 16e6, src: [4e6, 26e6], m: range(2, 63), n: range(50, 432),
    p: [2, 4, 6, 8], q: range(2, 15), vin: [1e6, 2e6], vco: [100e6, 432e6], sys: 168e6, apb1: 42e6, apb2: 84e6,
    ws: [30, 60, 90, 120, 150, 168].map((x) => x * 1e6), ref: 'RM0090, DS8626' },
  f429: { name: 'STM32F427/429', kind: 'f4', hsi: 16e6, src: [4e6, 26e6], m: range(2, 63), n: range(50, 432),
    p: [2, 4, 6, 8], q: range(2, 15), vin: [1e6, 2e6], vco: [100e6, 432e6], sys: 180e6, apb1: 45e6, apb2: 90e6,
    ws: [30, 60, 90, 120, 150, 180].map((x) => x * 1e6), ref: 'RM0090, DS9405 (180 MHz needs over-drive on)' },
  f411: { name: 'STM32F411', kind: 'f4', hsi: 16e6, src: [4e6, 26e6], m: range(2, 63), n: range(50, 432),
    p: [2, 4, 6, 8], q: range(2, 15), vin: [1e6, 2e6], vco: [100e6, 432e6], sys: 100e6, apb1: 50e6, apb2: 100e6,
    ws: [30, 64, 90, 100].map((x) => x * 1e6), ref: 'RM0383, DS10314' },
  g474: { name: 'STM32G431/474', kind: 'g4', hsi: 16e6, src: [4e6, 48e6], m: range(1, 16), n: range(8, 127),
    p: [2, 4, 6, 8], q: [2, 4, 6, 8], vin: [2.66e6, 8e6], vco: [96e6, 344e6], sys: 170e6, apb1: 170e6, apb2: 170e6,
    ws: [34, 68, 102, 136, 170].map((x) => x * 1e6), ref: 'RM0440, DS12288 (range 1 boost mode)' },
  rp2040: { name: 'RP2040', kind: 'rp', src: [1e6, 15e6], vco: [750e6, 1600e6], sys: 133e6, ref: 'RP2040 datasheet §2.15-2.18' },
};

const AHB = [1, 2, 4, 8, 16, 64, 128, 256, 512];
const APB = [1, 2, 4, 8, 16];

// STM32: every (M, N, P[, Q]) in range, scored by error then jitter/power.
function searchStm(F, fsrc, target, need48) {
  const out = [];
  for (const m of F.m) {
    const vin = fsrc / m;
    if (vin < F.vin[0] - 1 || vin > F.vin[1] + 1) continue;
    for (const n of F.n) {
      const vco = vin * n;
      if (vco < F.vco[0] || vco > F.vco[1]) continue;
      for (const p of F.p) {
        const sys = vco / p;
        if (sys > F.sys * 1.0001) continue;
        const e = Math.abs(sys - target) / target;
        if (e > 0.05) continue;
        let q = null, f48 = null, e48 = 0;
        if (need48) {
          q = F.q.reduce((b, x) => (Math.abs(vco / x - 48e6) < Math.abs(vco / b - 48e6) ? x : b), F.q[0]);
          f48 = vco / q; e48 = Math.abs(f48 - 48e6) / 48e6;
          if (f48 > 48e6 * 1.0025) e48 += 1; // over 48 MHz is never allowed for SDIO/RNG
        }
        out.push({ m, n, p, q, vin, vco, sys, f48, e, e48 });
      }
    }
  }
  // exact first; the USB clock must be within ±0.25 % (USB 2.0 full speed: ±2500 ppm)
  out.sort((a, b) => (a.e + (a.e48 > 0.0025 ? a.e48 + 0.01 : 0)) - (b.e + (b.e48 > 0.0025 ? b.e48 + 0.01 : 0))
    || b.vin - a.vin || a.vco - b.vco);
  return out;
}

function searchRp(F, fref, target) {
  const out = [];
  for (let r = 1; r <= 63 && fref / r >= 5e6; r++) {
    for (let fb = 16; fb <= 320; fb++) {
      const vco = (fref / r) * fb;
      if (vco < F.vco[0] || vco > F.vco[1]) continue;
      for (let p1 = 1; p1 <= 7; p1++) for (let p2 = 1; p2 <= p1; p2++) {
        const f = vco / (p1 * p2);
        const e = Math.abs(f - target) / target;
        if (e > 0.05) continue;
        out.push({ r, fb, p1, p2, vco, sys: f, e });
      }
    }
  }
  // lower VCO draws less power (datasheet §2.18.2); REFDIV 1 keeps the reference fast
  out.sort((a, b) => a.e - b.e || a.r - b.r || a.vco - b.vco || b.p1 - a.p1);
  return out;
}

export function run({ family, source, xtal, target, need48, ahb }) {
  const F = FAMILIES[family] || FAMILIES.f407;
  const warnings = [], notes = [];
  const useHsi = source === 'hsi' && F.kind !== 'rp';
  const fsrc = useHsi ? F.hsi : (xtal > 0 ? xtal * 1e6 : null);
  if (!fsrc) return { warnings: ['Give the crystal frequency in MHz, e.g. 8 or 12.'] };
  if (!(target > 0)) return { warnings: ['Give the wanted system clock in MHz, e.g. 168.'] };
  const ft = target * 1e6;
  if (!useHsi && (fsrc < F.src[0] || fsrc > F.src[1])) {
    warnings.push(`${fmtEng(fsrc, 'Hz')} is outside the ${F.name} oscillator range ${fmtEng(F.src[0], 'Hz')}-${fmtEng(F.src[1], 'Hz')}: pick another crystal or feed an external clock in bypass mode.`);
  }
  if (ft > F.sys * 1.0001) {
    warnings.push(`${fmtEng(ft, 'Hz')} is over the ${F.name} maximum of ${fmtEng(F.sys, 'Hz')}; the search is capped there.`);
  }
  const want = Math.min(ft, F.sys);

  if (F.kind === 'rp') {
    const c = searchRp(F, fsrc, want);
    if (!c.length) return { warnings: [...warnings, `No PLL setting gets within 5 % of ${fmtEng(want, 'Hz')} from ${fmtEng(fsrc, 'Hz')}. Try 12 MHz, the reference crystal.`] };
    const b = c[0];
    const u = searchRp(F, fsrc, 48e6)[0];
    if (b.e > 1e-6) warnings.push(`No exact setting: the nearest is ${fmtEng(b.sys, 'Hz')} (${(b.e * 100).toFixed(3)} % off).`);
    if (!u || u.e > 0.0025) warnings.push('PLL_USB cannot make 48 MHz within ±0.25 % from this crystal: USB will not work. Use a 12 MHz crystal.');
    if (fsrc !== 12e6) notes.push('The boot ROM and the Pico SDK assume a 12 MHz crystal; for another value set XOSC_KHZ and PLL_COMMON_REFDIV in the board header.');
    return {
      values: [
        { label: 'System clock', value: fmtEng(b.sys, 'Hz'), tone: Math.abs(b.sys - ft) / ft < 1e-6 ? 'ok' : 'warn', hint: `target ${fmtEng(ft, 'Hz')}` },
        { label: 'PLL_SYS VCO', value: fmtEng(b.vco, 'Hz'), hint: '750-1600 MHz' },
        { label: 'REFDIV / FBDIV', value: `${b.r} / ${b.fb}` },
        { label: 'POSTDIV1 / POSTDIV2', value: `${b.p1} / ${b.p2}` },
        { label: 'USB / ADC clock', value: u ? fmtEng(u.sys, 'Hz') : '–', tone: u && u.e < 0.0025 ? 'ok' : 'bad',
          hint: u ? `PLL_USB VCO ${fmtEng(u.vco, 'Hz')}, FBDIV ${u.fb}, POSTDIV ${u.p1}/${u.p2}` : 'no setting' },
      ],
      tables: [
        { title: 'Clocks', columns: ['Clock', 'Source', 'Frequency'], rows: [
          ['clk_ref', 'XOSC', fmtEng(fsrc, 'Hz')], ['clk_sys', 'PLL_SYS', fmtEng(b.sys, 'Hz')],
          ['clk_peri (UART, SPI)', 'clk_sys', fmtEng(b.sys, 'Hz')], ['clk_usb', 'PLL_USB', u ? fmtEng(u.sys, 'Hz') : '–'],
          ['clk_adc', 'PLL_USB', u ? fmtEng(u.sys, 'Hz') : '–'], ['clk_rtc', 'PLL_USB / 1024', u ? fmtEng(u.sys / 1024, 'Hz') : '–']] },
        { title: 'Other PLL_SYS settings for this clock', columns: ['REFDIV', 'FBDIV', 'VCO', 'POSTDIV1', 'POSTDIV2', 'Output'],
          rows: c.slice(0, 6).map((x) => [x.r, x.fb, fmtEng(x.vco, 'Hz'), x.p1, x.p2, fmtEng(x.sys, 'Hz')]) },
      ],
      texts: [{ title: 'C', lang: 'c', body: `// RP2040, ${fmtEng(fsrc, 'Hz')} crystal -> ${fmtEng(b.sys, 'Hz')}\n// pico SDK: set_sys_clock_pll(vco_freq, post_div1, post_div2)\nset_sys_clock_pll(${Math.round(b.vco)}, ${b.p1}, ${b.p2});\n` }],
      warnings,
      notes: [...notes, 'Above 133 MHz the RP2040 is overclocked: raise the core voltage (vreg_set_voltage) and check the flash clock divider.',
        'Among equal settings the lowest VCO is chosen: it draws less power (datasheet §2.18.2); a higher VCO has slightly less jitter.'],
    };
  }

  const c = searchStm(F, fsrc, want, need48);
  if (!c.length) return { warnings: [...warnings, `No PLL setting gets within 5 % of ${fmtEng(want, 'Hz')} from ${fmtEng(fsrc, 'Hz')}. Choose a crystal that divides to ${fmtEng(F.vin[0], 'Hz')}-${fmtEng(F.vin[1], 'Hz')}.`] };
  const b = c[0];
  if (b.e > 1e-6) warnings.push(`No exact setting: the nearest SYSCLK is ${fmtEng(b.sys, 'Hz')} (${(b.e * 100).toFixed(3)} % off).`);
  if (need48 && b.e48 > 0.0025) warnings.push(`The 48 MHz clock comes out at ${fmtEng(b.f48, 'Hz')}: USB needs 48 MHz ±0.25 %. Pick a SYSCLK whose VCO is a multiple of 48 MHz (e.g. 168 or 96 MHz), or on G4 use HSI48 with CRS.`);
  if (useHsi && need48) warnings.push('USB from the HSI is not accurate enough (±1 %); use a crystal for USB (or HSI48 + CRS on parts that have it).');
  const ahbDiv = AHB.includes(Number(ahb)) ? Number(ahb) : 1;
  const hclk = b.sys / ahbDiv;
  const d1 = APB.find((d) => hclk / d <= F.apb1 * 1.0001) ?? 16;
  const d2 = APB.find((d) => hclk / d <= F.apb2 * 1.0001) ?? 16;
  const p1 = hclk / d1, p2 = hclk / d2;
  const t1 = d1 === 1 ? p1 : 2 * p1, t2 = d2 === 1 ? p2 : 2 * p2;
  let ws = F.ws.findIndex((f) => hclk <= f * 1.0001);
  if (ws < 0) ws = F.ws.length - 1;
  const rName = F.kind === 'g4' ? 'PLLR' : 'PLLP';
  const qName = 'PLLQ';
  const values = [
    { label: 'SYSCLK', value: fmtEng(b.sys, 'Hz'), tone: Math.abs(b.sys - ft) / ft < 1e-6 ? 'ok' : 'warn', hint: `target ${fmtEng(ft, 'Hz')}` },
    { label: `PLLM / PLLN / ${rName}`, value: `${b.m} / ${b.n} / ${b.p}` },
    { label: 'VCO input', value: fmtEng(b.vin, 'Hz'), hint: `${fmtEng(F.vin[0], 'Hz')}-${fmtEng(F.vin[1], 'Hz')}` },
    { label: 'VCO output', value: fmtEng(b.vco, 'Hz'), hint: `${fmtEng(F.vco[0], 'Hz')}-${fmtEng(F.vco[1], 'Hz')}` },
  ];
  if (need48) values.push({ label: `48 MHz clock (${qName} = ${b.q})`, value: fmtEng(b.f48, 'Hz'), tone: b.e48 <= 0.0025 ? 'ok' : 'bad' });
  values.push(
    { label: 'HCLK (AHB)', value: fmtEng(hclk, 'Hz'), hint: `/${ahbDiv}` },
    { label: 'PCLK1 (APB1)', value: fmtEng(p1, 'Hz'), hint: `/${d1}, max ${fmtEng(F.apb1, 'Hz')}` },
    { label: 'PCLK2 (APB2)', value: fmtEng(p2, 'Hz'), hint: `/${d2}, max ${fmtEng(F.apb2, 'Hz')}` },
    { label: 'Flash wait states', value: ws, hint: F.kind === 'g4' ? 'range 1 boost' : 'at 2.7-3.6 V' },
  );
  const rows = [
    ['PLL source', useHsi ? 'HSI' : 'HSE', fmtEng(fsrc, 'Hz')],
    ['SYSCLK', 'PLL', fmtEng(b.sys, 'Hz')],
    ['HCLK: core, AHB, DMA, memory', `SYSCLK /${ahbDiv}`, fmtEng(hclk, 'Hz')],
    ['SysTick (HCLK or HCLK/8)', 'HCLK', `${fmtEng(hclk, 'Hz')} or ${fmtEng(hclk / 8, 'Hz')}`],
    ['PCLK1: APB1 (USART2/3, I2C, SPI2/3)', `HCLK /${d1}`, fmtEng(p1, 'Hz')],
    ['APB1 timer clock', d1 === 1 ? 'PCLK1' : 'PCLK1 x2', fmtEng(t1, 'Hz')],
    ['PCLK2: APB2 (USART1/6, SPI1, ADC)', `HCLK /${d2}`, fmtEng(p2, 'Hz')],
    ['APB2 timer clock', d2 === 1 ? 'PCLK2' : 'PCLK2 x2', fmtEng(t2, 'Hz')],
  ];
  if (need48) rows.push(['48 MHz (USB, SDIO, RNG)', `VCO /${b.q}`, fmtEng(b.f48, 'Hz')]);
  if (F.kind === 'f4') notes.push('ADC clock = PCLK2 / 2, 4, 6 or 8 (ADC_CCR ADCPRE): keep it at or below 36 MHz (F4 datasheet).');
  const hal = F.kind === 'g4'
    ? `RCC_OscInitStruct.PLL.PLLM = RCC_PLLM_DIV${b.m};\nRCC_OscInitStruct.PLL.PLLN = ${b.n};\nRCC_OscInitStruct.PLL.PLLR = RCC_PLLR_DIV${b.p};\nRCC_OscInitStruct.PLL.PLLQ = RCC_PLLQ_DIV${b.q ?? 2};\nRCC_OscInitStruct.PLL.PLLP = RCC_PLLP_DIV2;`
    : `RCC_OscInitStruct.PLL.PLLM = ${b.m};\nRCC_OscInitStruct.PLL.PLLN = ${b.n};\nRCC_OscInitStruct.PLL.PLLP = RCC_PLLP_DIV${b.p};\nRCC_OscInitStruct.PLL.PLLQ = ${b.q ?? 7};`;
  const body = `// ${F.name}: ${useHsi ? 'HSI' : 'HSE'} ${fmtEng(fsrc, 'Hz')} -> SYSCLK ${fmtEng(b.sys, 'Hz')}\n` +
    `RCC_OscInitStruct.PLL.PLLState = RCC_PLL_ON;\nRCC_OscInitStruct.PLL.PLLSource = RCC_PLLSOURCE_${useHsi ? 'HSI' : 'HSE'};\n${hal}\n\n` +
    `RCC_ClkInitStruct.SYSCLKSource = RCC_SYSCLKSOURCE_PLLCLK;\nRCC_ClkInitStruct.AHBCLKDivider = RCC_SYSCLK_DIV${ahbDiv};\n` +
    `RCC_ClkInitStruct.APB1CLKDivider = RCC_HCLK_DIV${d1};\nRCC_ClkInitStruct.APB2CLKDivider = RCC_HCLK_DIV${d2};\n` +
    `HAL_RCC_ClockConfig(&RCC_ClkInitStruct, FLASH_LATENCY_${ws});\n`;
  if (F.kind === 'g4' && hclk > 150e6) notes.push('Above 150 MHz the G4 needs voltage range 1 boost mode (PWR_REGULATOR_VOLTAGE_SCALE1_BOOST); step through an AHB /2 for 1 µs when switching (RM0440 §6.1.5).');
  if (family === 'f429' && hclk > 168e6) notes.push('Above 168 MHz the F429 needs over-drive mode on (HAL_PWREx_EnableOverDrive) before raising the clock.');
  return {
    values,
    tables: [
      { title: 'Clock tree', columns: ['Clock', 'From', 'Frequency'], rows },
      { title: 'Other PLL settings', columns: ['PLLM', 'PLLN', rName, need48 ? 'PLLQ' : 'VCO in', 'VCO', 'SYSCLK'],
        rows: c.slice(0, 6).map((x) => [x.m, x.n, x.p, need48 ? `${x.q} (${fmtEng(x.f48, 'Hz')})` : fmtEng(x.vin, 'Hz'), fmtEng(x.vco, 'Hz'), fmtEng(x.sys, 'Hz')]) },
    ],
    texts: [{ title: 'HAL', lang: 'c', body }],
    warnings,
    notes: [...notes, `Limits from ${F.ref}. The highest VCO input in range is preferred (less PLL jitter, RM0090 recommends 2 MHz); then the lowest VCO.`,
      'Flash wait states assume a 2.7-3.6 V supply; at lower VDD more are needed (see the flash latency table in the reference manual).'],
  };
}
