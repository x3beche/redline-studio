// Pin mux explorer: the alternate functions of one pin, the pins that offer a
// function, and a check of a whole pin assignment for conflicts.
//
// Data, transcribed from the datasheets:
//  - STM32F103x8/xB LQFP48: DS5319 table 5 "pin definitions" (default and remap
//    columns) and RM0008 §9.3 "alternate function remapping" (AFIO_MAPR).
//    On the F1 a peripheral is remapped as a whole: every signal of it follows
//    one AFIO_MAPR field, so each function below carries the remap values it
//    is valid for (e.g. TIM2 has 0 none, 1 partial, 2 partial, 3 full).
//  - RP2040 QFN-56: RP2040 datasheet §1.4.3 pin list and §2.19.2 function
//    table (F1 SPI, F2 UART, F3 I2C, F4 PWM, F5 SIO, F6 PIO0, F7 PIO1,
//    F8 clock, F9 USB). The table repeats with the GPIO number, so it is
//    generated from that pattern below.
//  - ATmega328P DIP-28: datasheet §1.1 pinout and §14.3 alternate port functions.

// ---- STM32F103x8 LQFP48 ----
// [pin name, package pin, functions]; a function 'X@0,2' is valid with remap 0 or 2,
// a plain name is not remappable.
const F103 = [
  ['PC13', 2, ['TAMPER_RTC']], ['PC14', 3, ['OSC32_IN']], ['PC15', 4, ['OSC32_OUT']],
  ['PD0', 5, ['OSC_IN']], ['PD1', 6, ['OSC_OUT']],
  ['PA0', 10, ['WKUP', 'USART2_CTS@0', 'ADC12_IN0', 'TIM2_CH1_ETR@0,2']],
  ['PA1', 11, ['USART2_RTS@0', 'ADC12_IN1', 'TIM2_CH2@0,2']],
  ['PA2', 12, ['USART2_TX@0', 'ADC12_IN2', 'TIM2_CH3@0,1']],
  ['PA3', 13, ['USART2_RX@0', 'ADC12_IN3', 'TIM2_CH4@0,1']],
  ['PA4', 14, ['SPI1_NSS@0', 'USART2_CK@0', 'ADC12_IN4']],
  ['PA5', 15, ['SPI1_SCK@0', 'ADC12_IN5']],
  ['PA6', 16, ['SPI1_MISO@0', 'ADC12_IN6', 'TIM3_CH1@0', 'TIM1_BKIN@1']],
  ['PA7', 17, ['SPI1_MOSI@0', 'ADC12_IN7', 'TIM3_CH2@0', 'TIM1_CH1N@1']],
  ['PB0', 18, ['ADC12_IN8', 'TIM3_CH3@0,2', 'TIM1_CH2N@1']],
  ['PB1', 19, ['ADC12_IN9', 'TIM3_CH4@0,2', 'TIM1_CH3N@1']],
  ['PB2', 20, ['BOOT1']],
  ['PB10', 21, ['I2C2_SCL', 'USART3_TX@0', 'TIM2_CH3@2,3']],
  ['PB11', 22, ['I2C2_SDA', 'USART3_RX@0', 'TIM2_CH4@2,3']],
  ['PB12', 25, ['SPI2_NSS', 'I2C2_SMBA', 'USART3_CK@0', 'TIM1_BKIN@0']],
  ['PB13', 26, ['SPI2_SCK', 'USART3_CTS@0', 'TIM1_CH1N@0']],
  ['PB14', 27, ['SPI2_MISO', 'USART3_RTS@0', 'TIM1_CH2N@0']],
  ['PB15', 28, ['SPI2_MOSI', 'TIM1_CH3N@0']],
  ['PA8', 29, ['USART1_CK@0,1', 'TIM1_CH1@0,1', 'MCO']],
  ['PA9', 30, ['USART1_TX@0', 'TIM1_CH2@0,1']],
  ['PA10', 31, ['USART1_RX@0', 'TIM1_CH3@0,1']],
  ['PA11', 32, ['USART1_CTS@0,1', 'CAN_RX@0', 'TIM1_CH4@0,1', 'USB_DM']],
  ['PA12', 33, ['USART1_RTS@0,1', 'CAN_TX@0', 'TIM1_ETR@0,1', 'USB_DP']],
  ['PA13', 34, ['SWDIO']], ['PA14', 37, ['SWCLK']],
  ['PA15', 38, ['JTDI', 'TIM2_CH1_ETR@1,3', 'SPI1_NSS@1']],
  ['PB3', 39, ['JTDO_TRACESWO', 'TIM2_CH2@1,3', 'SPI1_SCK@1']],
  ['PB4', 40, ['NJTRST', 'TIM3_CH1@2', 'SPI1_MISO@1']],
  ['PB5', 41, ['I2C1_SMBA@0,1', 'TIM3_CH2@2', 'SPI1_MOSI@1']],
  ['PB6', 42, ['I2C1_SCL@0', 'TIM4_CH1', 'USART1_TX@1']],
  ['PB7', 43, ['I2C1_SDA@0', 'TIM4_CH2', 'USART1_RX@1']],
  ['PB8', 45, ['TIM4_CH3', 'I2C1_SCL@1', 'CAN_RX@2']],
  ['PB9', 46, ['TIM4_CH4', 'I2C1_SDA@1', 'CAN_TX@2']],
];
const F103_SPECIAL = {
  PA13: 'SWD data: using it as GPIO disables the debugger after reset (AFIO_MAPR SWJ_CFG = 100).',
  PA14: 'SWD clock: using it as GPIO disables the debugger.',
  PA15: 'JTAG after reset: free it with SWJ_CFG = 010 (SWD only).',
  PB3: 'JTAG after reset: free it with SWJ_CFG = 010 (SWD only).',
  PB4: 'JTAG after reset: free it with SWJ_CFG = 010 (SWD only).',
  PB2: 'BOOT1 strap, read at reset only when BOOT0 = 1.',
  PC13: 'Backup domain: sinks at most 3 mA, 2 MHz, one of PC13-15 as output at a time; do not source current.',
  PC14: 'Backup domain (LSE crystal): same 3 mA / 2 MHz limits as PC13.',
  PC15: 'Backup domain (LSE crystal): same 3 mA / 2 MHz limits as PC13.',
  PD0: 'HSE crystal pin: GPIO only with PD01_REMAP and no crystal.',
  PD1: 'HSE crystal pin: GPIO only with PD01_REMAP and no crystal.',
};

// ---- RP2040: the function table repeats with the GPIO number ----
function rp2040() {
  // QFN-56 package pins of GPIO0..29 (datasheet §1.4.3)
  const PKG = [2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17, 18, 27, 28, 29, 30, 31, 32, 34, 35, 36, 37, 38, 39, 40, 41];
  const CLK = { 20: 'CLOCK_GPIN0', 21: 'CLOCK_GPOUT0', 22: 'CLOCK_GPIN1', 23: 'CLOCK_GPOUT1', 24: 'CLOCK_GPOUT2', 25: 'CLOCK_GPOUT3' };
  return PKG.map((pkg, n) => {
    const f = [
      `SPI${(n >> 3) & 1}_${['RX', 'CSN', 'SCK', 'TX'][n & 3]}`,
      `UART${((n >> 2) & 1) ^ ((n >> 3) & 1)}_${['TX', 'RX', 'CTS', 'RTS'][n & 3]}`,
      `I2C${(n >> 1) & 1}_${n & 1 ? 'SCL' : 'SDA'}`,
      `PWM${(n >> 1) & 7}_${n & 1 ? 'B' : 'A'}`,
      'SIO', 'PIO0', 'PIO1',
    ];
    if (CLK[n]) f.push(CLK[n]);
    f.push(['USB_OVCUR_DET', 'USB_VBUS_DET', 'USB_VBUS_EN'][n % 3]);
    if (n >= 26) f.push(`ADC${n - 26}`);
    return [`GPIO${n}`, pkg, f];
  });
}
const RP_SPECIAL = {
  GPIO23: 'On a Raspberry Pi Pico: the SMPS power-save pin (not on the header).',
  GPIO24: 'On a Raspberry Pi Pico: VBUS sense (not on the header).',
  GPIO25: 'On a Raspberry Pi Pico: the on-board LED.',
  GPIO29: 'On a Raspberry Pi Pico: VSYS/3 on ADC3 (not on the header).',
};

// ---- ATmega328P DIP-28 ----
const M328 = [
  ['PC6', 1, ['RESET', 'PCINT14']], ['PD0', 2, ['RXD', 'PCINT16']], ['PD1', 3, ['TXD', 'PCINT17']],
  ['PD2', 4, ['INT0', 'PCINT18']], ['PD3', 5, ['INT1', 'OC2B', 'PCINT19']], ['PD4', 6, ['T0', 'XCK', 'PCINT20']],
  ['PB6', 9, ['XTAL1', 'TOSC1', 'PCINT6']], ['PB7', 10, ['XTAL2', 'TOSC2', 'PCINT7']],
  ['PD5', 11, ['T1', 'OC0B', 'PCINT21']], ['PD6', 12, ['AIN0', 'OC0A', 'PCINT22']], ['PD7', 13, ['AIN1', 'PCINT23']],
  ['PB0', 14, ['ICP1', 'CLKO', 'PCINT0']], ['PB1', 15, ['OC1A', 'PCINT1']], ['PB2', 16, ['SS', 'OC1B', 'PCINT2']],
  ['PB3', 17, ['MOSI', 'OC2A', 'PCINT3']], ['PB4', 18, ['MISO', 'PCINT4']], ['PB5', 19, ['SCK', 'PCINT5']],
  ['PC0', 23, ['ADC0', 'PCINT8']], ['PC1', 24, ['ADC1', 'PCINT9']], ['PC2', 25, ['ADC2', 'PCINT10']],
  ['PC3', 26, ['ADC3', 'PCINT11']], ['PC4', 27, ['ADC4', 'SDA', 'PCINT12']], ['PC5', 28, ['ADC5', 'SCL', 'PCINT13']],
];
const M328_SPECIAL = {
  PC6: 'RESET: a GPIO only with the RSTDISBL fuse, which ends ISP programming.',
  PB6: 'Crystal pin: GPIO only with the internal RC oscillator fuses.',
  PB7: 'Crystal pin: GPIO only with the internal RC oscillator fuses.',
  PD0: 'The serial bootloader (Arduino) uses it.', PD1: 'The serial bootloader (Arduino) uses it.',
  PB3: 'ISP programming (MOSI): keep loads light.', PB4: 'ISP programming (MISO).', PB5: 'ISP programming (SCK); the LED on an Arduino Uno.',
};

const CHIPS = {
  stm32f103c8: { name: 'STM32F103C8 (LQFP48)', pins: F103, special: F103_SPECIAL, remap: true },
  rp2040: { name: 'RP2040 (QFN-56)', pins: rp2040(), special: RP_SPECIAL },
  atmega328p: { name: 'ATmega328P (DIP-28)', pins: M328, special: M328_SPECIAL },
};

const norm = (s) => String(s ?? '').toUpperCase().replace(/[\s\-/]+/g, '_').replace(/^_+|_+$/g, '');
function split(f) { const [name, r] = f.split('@'); return { name, remaps: r ? r.split(',').map(Number) : null }; }
const periph = (name) => name.replace(/_(CH\d+N?|CH\d_ETR|ETR|BKIN|TX|RX|CK|CTS|RTS|NSS|SCK|MISO|MOSI|SCL|SDA|SMBA|IN\d+|CSN|A|B|DM|DP)$/, '');

function findPin(chip, text) {
  let t = norm(text);
  if (!t) return null;
  if (chip === CHIPS.rp2040) t = t.replace(/^(GP|GPIO)?(\d+)$/, 'GPIO$2');
  const byName = chip.pins.find((p) => p[0] === t);
  if (byName) return byName;
  const num = /^(PIN_?|#)?(\d+)$/.exec(t);
  return num ? chip.pins.find((p) => p[1] === Number(num[2])) || null : null;
}

export function run({ chip: chipKey, pin, find, assign }) {
  const chip = CHIPS[chipKey] || CHIPS.stm32f103c8;
  const warnings = [], notes = [], tables = [], values = [];

  // 1. one pin
  if (String(pin ?? '').trim()) {
    const p = findPin(chip, pin);
    if (!p) warnings.push(`No pin "${pin}" on the ${chip.name}. Write it like ${chip.pins[5][0]} or its package pin number.`);
    else {
      values.push({ label: 'Pin', value: p[0], hint: `package pin ${p[1]}` },
        { label: 'Functions', value: p[2].length });
      if (chip.special[p[0]]) values.push({ label: 'Watch out', value: 'special pin', tone: 'warn', hint: chip.special[p[0]] });
      tables.push({ title: `Functions on ${p[0]}`, columns: chip.remap ? ['Function', 'Peripheral', 'Remap (AFIO_MAPR)'] : ['Function', 'Peripheral'],
        rows: p[2].map((f) => { const s = split(f); const r = [s.name, periph(s.name)];
          if (chip.remap) r.push(s.remaps ? (s.remaps.includes(0) ? (s.remaps.length > 1 ? `default or ${s.remaps.filter((x) => x).join('/')}` : 'default') : `remap ${s.remaps.join('/')}`) : 'fixed');
          return r; }) });
    }
  }

  // 2. pins offering a function
  const q = norm(find);
  if (q) {
    const rows = [];
    for (const p of chip.pins) for (const f of p[2]) {
      const s = split(f);
      if (!s.name.includes(q)) continue;
      const r = [s.name, p[0], p[1]];
      if (chip.remap) r.push(s.remaps ? (s.remaps.includes(0) ? 'default' : `remap ${s.remaps.join('/')}`) : 'fixed');
      r.push(chip.special[p[0]] ? 'special pin' : '');
      rows.push(r);
    }
    rows.sort((a, b) => a[0].localeCompare(b[0], 'en', { numeric: true }));
    if (rows.length) tables.push({ title: `Pins offering "${q}" (${rows.length})`, columns: chip.remap ? ['Function', 'Pin', 'Package pin', 'Remap', 'Note'] : ['Function', 'Pin', 'Package pin', 'Note'],
      rows: rows.slice(0, 80) });
    if (!rows.length) warnings.push(`No function matching "${q}" on the ${chip.name}. Try a peripheral name such as ${chip === CHIPS.rp2040 ? 'UART0 or PWM3' : chip.remap ? 'USART1 or TIM2' : 'OC1 or ADC'}.`);
  }

  // 3. the assignment
  const rows = [];
  const used = new Map();       // pin -> [signals]
  const perRemap = new Map();   // peripheral -> [{sig, remaps}]
  const periphs = new Set();
  let bad = 0;
  for (const a of assign || []) {
    const sig = norm(a.signal), pt = String(a.pin ?? '').trim();
    if (!sig && !pt) continue;
    const p = findPin(chip, pt);
    if (!p) {
      const offer = chip.pins.filter((x) => x[2].some((f) => split(f).name === sig)).map((x) => x[0]);
      rows.push([sig || '–', pt || '–', 'no such pin', offer.length ? `offered on ${offer.join(', ')}` : 'unknown function too']);
      bad++; continue;
    }
    used.set(p[0], [...(used.get(p[0]) || []), sig || 'GPIO']);
    if (!sig || sig === 'GPIO' || sig === 'SIO') {
      rows.push([sig || 'GPIO', p[0], chip.special[p[0]] ? 'check' : 'ok', chip.special[p[0]] || 'plain GPIO']);
      if (chip.special[p[0]]) bad++;
      continue;
    }
    const hit = p[2].map(split).find((s) => s.name === sig);
    if (!hit) {
      const offer = chip.pins.filter((x) => x[2].some((f) => split(f).name === sig)).map((x) => x[0]);
      rows.push([sig, p[0], 'not on this pin', offer.length ? `use ${offer.join(' or ')}` : 'unknown function']);
      bad++; continue;
    }
    periphs.add(periph(sig));
    if (hit.remaps) perRemap.set(periph(sig), [...(perRemap.get(periph(sig)) || []), { sig, pin: p[0], remaps: hit.remaps }]);
    rows.push([sig, p[0], chip.special[p[0]] ? 'check' : 'ok', chip.special[p[0]] || (hit.remaps && !hit.remaps.includes(0) ? `needs remap ${hit.remaps.join('/')}` : '')]);
    if (chip.special[p[0]]) bad++;
  }
  for (const [pn, sigs] of used) if (sigs.length > 1) { warnings.push(`${pn} is assigned twice (${sigs.join(', ')}): a pin carries one function at a time. Move one of them.`); bad++; }
  const remapPick = [];
  for (const [per, list] of perRemap) {
    let ok = [0, 1, 2, 3];
    for (const x of list) ok = ok.filter((r) => x.remaps.includes(r));
    if (!ok.length) {
      warnings.push(`${per}: ${list.map((x) => `${x.sig} on ${x.pin}`).join(', ')} need different AFIO remap settings. On the F1 all of ${per}'s signals move together: put them all on default or all on remapped pins.`);
      bad++;
    } else remapPick.push([per, ok.join(' or '), ok.includes(0) ? 'no remap needed' : `set the ${per} remap field to ${ok[0]}`]);
  }
  if (chip.remap) {
    if (periphs.has('CAN') && [...periphs].some((x) => x.startsWith('USB'))) { warnings.push('CAN and USB share the 512-byte packet SRAM on the STM32F103: they cannot be used at the same time (RM0008 §24.1). Pick one, or a part with a separate CAN RAM (F105/F107).'); bad++; }
    if ((perRemap.get('SPI1') || []).some((x) => !x.remaps.includes(0)) && periphs.has('I2C1')) warnings.push('SPI1 remapped with I2C1 in use: the STM32F103 errata sheet reports that the remapped SPI1 MOSI conflicts with I2C1 SMBA on PB5. Check the errata workaround before using both.');
    if ([...used.keys()].some((k) => ['PA15', 'PB3', 'PB4'].includes(k))) notes.push('PA15, PB3 and PB4 are JTAG pins after reset: write AFIO_MAPR SWJ_CFG = 010 (__HAL_AFIO_REMAP_SWJ_NOJTAG) to free them and keep SWD.');
  }
  if (rows.length) {
    tables.push({ title: 'Assignment check', columns: ['Signal', 'Pin', 'Status', 'Note'], rows });
    values.push({ label: 'Assignment', value: bad ? `${bad} issue${bad > 1 ? 's' : ''}` : 'no conflicts', tone: bad ? 'bad' : 'ok', hint: `${rows.length} signal${rows.length > 1 ? 's' : ''}` });
  }
  if (remapPick.length) tables.push({ title: 'Remap settings (AFIO_MAPR)', columns: ['Peripheral', 'Valid remap values', 'What to do'], rows: remapPick });
  if (chipKey === 'rp2040') notes.push('RP2040: each GPIO selects one function in its IO_BANK0 GPIOx_CTRL FUNCSEL; SIO is software GPIO, PIO0/PIO1 hand the pin to a state machine.');
  notes.push(`Data transcribed from the ${chip.name} datasheet; confirm against the current revision before ordering boards.`);
  return { values, tables, warnings, notes };
}
