// GPIO restriction warner: the boot straps, flash pins, input-only pins,
// debug pins and other special-purpose GPIOs of common MCUs, and which of the
// pins you plan to use are among them.
//
// Sources (strap levels and pin roles):
//  ESP32     - ESP32 datasheet v4.x §2.4 "Strapping pins", ESP32-WROOM-32 / WROVER-E datasheets,
//              ESP-IDF ADC docs (ADC2 is used by the Wi-Fi driver)
//  ESP32-S3  - ESP32-S3 datasheet §2.6 strapping pins, ESP32-S3-WROOM-1 datasheet (octal PSRAM pins)
//  ESP32-C3  - ESP32-C3 datasheet §2.4 strapping pins, ESP32-C3 errata (ADC2)
//  ESP8266   - ESP8266EX datasheet §4 and "ESP8266 boot mode selection" (Espressif FAQ)
//  STM32F103 - DS5319 §3.4 boot modes and table 5 notes, RM0008 §9.3.5 SWJ_CFG
//  RP2040    - RP2040 datasheet §2.8 bootrom (QSPI_SS), Raspberry Pi Pico datasheet §2.1 pinout
//  ATmega328P - datasheet §28 fuses (RSTDISBL), §13 clock sources, §1.1 (ADC6/7 input only)

// sev: 3 = can stop the chip from booting or programming, 2 = a real limit, 1 = worth knowing
// cond: 'wifi' / 'psram' / 'board' - the row only matters when that input is on
const CHIPS = {
  esp32: { name: 'ESP32 (WROOM/WROVER module)', num: 'GPIO', rows: [
    { pins: [0], kind: 'boot strap', sev: 3, risk: 'Internal pull-up; low at reset enters the serial download mode instead of running your code.', fix: 'No pull-down or load that holds it low at reset; a button to GND or an output used after boot is fine.' },
    { pins: [2], kind: 'boot strap', sev: 2, risk: 'Internal pull-down; must be low or floating at reset to enter download mode. Drives the LED on many dev boards.', fix: 'Do not pull it up externally; use it as an output after boot.' },
    { pins: [12], kind: 'boot strap (MTDI)', sev: 3, risk: 'Selects the flash voltage (VDD_SDIO): high at reset gives 1.8 V and a 3.3 V flash module will not boot.', fix: 'Keep it low at reset (no pull-up, no load that pulls it high) or burn the eFuse: espefuse.py set_flash_voltage 3.3V.' },
    { pins: [15], kind: 'boot strap (MTDO)', sev: 1, risk: 'Internal pull-up; low at reset silences the ROM boot log on UART0 and changes SDIO slave timing.', fix: 'Fine as GPIO; avoid a pull-down if you want the boot log.' },
    { pins: [5], kind: 'boot strap', sev: 1, risk: 'Internal pull-up; sets SDIO slave timing at reset (only matters when booting as SDIO slave).', fix: 'Fine as GPIO; do not hold it low at reset if you use SDIO slave.' },
    { pins: [6, 7, 8, 9, 10, 11], kind: 'SPI flash', sev: 3, risk: 'Wired to the module\'s SPI flash (SD_CLK, SD_DATA0-3, SD_CMD); touching them crashes the chip.', fix: 'Never use them.' },
    { pins: [16, 17], kind: 'PSRAM', sev: 3, cond: 'psram', risk: 'On WROVER modules these carry the PSRAM clock and chip select.', fix: 'Leave them unconnected on modules with PSRAM.' },
    { pins: [34, 35, 36, 39], kind: 'input only', sev: 2, risk: 'Input only: no output driver and no internal pull-up or pull-down.', fix: 'Use for inputs with an external pull resistor, or for ADC1.' },
    { pins: [1, 3], kind: 'UART0', sev: 2, risk: 'TXD0 / RXD0: flashing and the boot log use them; GPIO1 toggles at reset.', fix: 'Keep them for the USB-serial bridge, or accept losing the console and serial flashing.' },
    { pins: [0, 2, 4, 12, 13, 14, 15, 25, 26, 27], kind: 'ADC2', sev: 2, cond: 'wifi', risk: 'ADC2 cannot be read while Wi-Fi is running (the Wi-Fi driver owns it).', fix: 'Put analog inputs on ADC1: GPIO32-39.' },
    { pins: [12, 13, 14, 15], kind: 'JTAG', sev: 1, risk: 'MTDI, MTCK, MTMS, MTDO: using them gives up JTAG debugging.', fix: 'Keep them free on boards that need a debugger.' },
  ] },
  esp32s3: { name: 'ESP32-S3 (WROOM-1 module)', num: 'GPIO', rows: [
    { pins: [0], kind: 'boot strap', sev: 3, risk: 'Internal pull-up; low at reset enters download mode.', fix: 'No pull-down or load that holds it low at reset.' },
    { pins: [46], kind: 'boot strap', sev: 3, risk: 'Internal pull-down; with GPIO0 low it must be low too (GPIO0 = 0, GPIO46 = 1 is an invalid boot). Also controls the ROM log.', fix: 'Keep it low at reset; use it for an output after boot.' },
    { pins: [45], kind: 'boot strap (VDD_SPI)', sev: 3, risk: 'Internal pull-down; high at reset selects 1.8 V flash: 3.3 V flash modules fail to boot.', fix: 'Keep it low at reset or fix VDD_SPI in eFuse.' },
    { pins: [3], kind: 'boot strap (JTAG source)', sev: 1, risk: 'Floating strap; only read when the eFuses select JTAG by strap.', fix: 'Fine as GPIO on default eFuses.' },
    { pins: [26, 27, 28, 29, 30, 31, 32], kind: 'SPI flash / PSRAM', sev: 3, risk: 'Wired to the module\'s flash and quad PSRAM.', fix: 'Never use them.' },
    { pins: [33, 34, 35, 36, 37], kind: 'octal flash / PSRAM', sev: 3, cond: 'psram', risk: 'On modules with octal PSRAM or flash (N8R8, N16R8 ...) these are the extra data lines.', fix: 'Leave them unconnected on octal modules.' },
    { pins: [19, 20], kind: 'USB', sev: 2, risk: 'USB D- / D+ of the USB-Serial-JTAG: many boards flash and debug through them.', fix: 'Keep them for USB unless the board has a separate UART bridge.' },
    { pins: [43, 44], kind: 'UART0', sev: 2, risk: 'U0TXD / U0RXD: the boot log and serial flashing.', fix: 'Keep them for the console, or flash over USB.' },
    { pins: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20], kind: 'ADC2', sev: 2, cond: 'wifi', risk: 'ADC2 is not reliable while Wi-Fi is running.', fix: 'Put analog inputs on ADC1: GPIO1-10.' },
    { pins: [39, 40, 41, 42], kind: 'JTAG', sev: 1, risk: 'MTCK, MTDO, MTDI, MTMS for an external JTAG probe.', fix: 'Keep them free if you debug over JTAG pins instead of USB.' },
  ] },
  esp32c3: { name: 'ESP32-C3', num: 'GPIO', rows: [
    { pins: [9], kind: 'boot strap', sev: 3, risk: 'Internal pull-up; low at reset enters download mode (the BOOT button).', fix: 'No pull-down or load that holds it low at reset.' },
    { pins: [8], kind: 'boot strap', sev: 2, risk: 'Must be high for download mode (with GPIO9 low); also gates the ROM log. An LED on many boards.', fix: 'Do not pull it low at reset; an LED to VDD with a resistor is fine.' },
    { pins: [2], kind: 'boot strap', sev: 3, risk: 'Must be high at reset (datasheet strapping table).', fix: 'Add a pull-up; do not load it low at reset.' },
    { pins: [12, 13, 14, 15, 16, 17], kind: 'SPI flash', sev: 3, risk: 'Wired to the SPI flash (in-package on C3FN4/FH4, external on modules).', fix: 'Never use them.' },
    { pins: [11], kind: 'VDD_SPI', sev: 2, risk: 'Is the flash supply output by default; a GPIO only after burning the VDD_SPI_AS_GPIO eFuse.', fix: 'Leave it alone unless you burn that eFuse (irreversible).' },
    { pins: [18, 19], kind: 'USB', sev: 2, risk: 'USB D- / D+ of the USB-Serial-JTAG used for flashing and debugging.', fix: 'Keep them for USB unless the board has a UART bridge.' },
    { pins: [20, 21], kind: 'UART0', sev: 2, risk: 'U0RXD / U0TXD: boot log and serial flashing.', fix: 'Keep them for the console, or flash over USB.' },
    { pins: [5], kind: 'ADC2', sev: 2, risk: 'ADC2 is not calibrated and fails with Wi-Fi on (C3 errata): Espressif recommends not using it.', fix: 'Use ADC1: GPIO0-4.' },
    { pins: [4, 5, 6, 7], kind: 'JTAG', sev: 1, risk: 'MTMS, MTDI, MTCK, MTDO for an external JTAG probe.', fix: 'Keep them free only if you debug over pins instead of USB.' },
  ] },
  esp8266: { name: 'ESP8266 (ESP-12)', num: 'GPIO', rows: [
    { pins: [0], kind: 'boot strap', sev: 3, risk: 'High at reset runs from flash; low enters UART download.', fix: 'Pull it up (10 kΩ); a button to GND is fine; no load that pulls it low at reset.' },
    { pins: [2], kind: 'boot strap', sev: 3, risk: 'Must be high at reset or the chip does not boot. The blue LED on ESP-12.', fix: 'Pull it up; an LED to VCC is fine, a load to GND is not.' },
    { pins: [15], kind: 'boot strap', sev: 3, risk: 'Must be low at reset (high selects SD-card boot).', fix: 'Pull it down (10 kΩ); never pull it up.' },
    { pins: [6, 7, 8, 9, 10, 11], kind: 'SPI flash', sev: 3, risk: 'Wired to the module\'s flash.', fix: 'Never use them.' },
    { pins: [1, 3], kind: 'UART0', sev: 2, risk: 'TX / RX for flashing; GPIO1 prints the boot log at 74880 baud after reset.', fix: 'Keep them for serial, or accept garbage on them at boot.' },
    { pins: [16], kind: 'RTC GPIO', sev: 2, risk: 'No interrupts, no PWM or I2C, only an internal pull-down; the deep-sleep wake pin (wire to RST).', fix: 'Use for simple outputs or for deep-sleep wake.' },
  ] },
  stm32f103: { name: 'STM32F103C8 (Blue Pill)', num: '', rows: [
    { pins: ['BOOT0'], kind: 'boot pin', sev: 3, risk: 'Not a GPIO: high at reset boots the system-memory bootloader instead of flash.', fix: 'Tie it to GND through 10 kΩ; a jumper to VDD for the UART bootloader.' },
    { pins: ['PB2'], kind: 'boot strap (BOOT1)', sev: 1, risk: 'Read at reset only when BOOT0 = 1 (selects system memory or SRAM).', fix: 'Free as GPIO after reset; keep a pull-down if you use the bootloader.' },
    { pins: ['PA13', 'PA14'], kind: 'SWD', sev: 3, risk: 'SWDIO / SWCLK: using them as GPIO disables the debugger, and reflashing then needs connect-under-reset.', fix: 'Keep them for SWD.' },
    { pins: ['PA15', 'PB3', 'PB4'], kind: 'JTAG', sev: 2, risk: 'JTDI, JTDO, NJTRST after reset: not GPIO until JTAG is switched off.', fix: 'Set AFIO_MAPR SWJ_CFG = 010 (__HAL_AFIO_REMAP_SWJ_NOJTAG) to free them and keep SWD.' },
    { pins: ['PC13', 'PC14', 'PC15'], kind: 'backup domain', sev: 2, risk: 'Sink at most 3 mA, 2 MHz, only one of the three as output at a time, must not source current (DS5319 table 5 note).', fix: 'Drive only an LED to VDD through ≥1 kΩ, or use them as slow inputs.' },
    { pins: ['PD0', 'PD1'], kind: 'HSE crystal', sev: 2, risk: 'OSC_IN / OSC_OUT for the 8 MHz crystal.', fix: 'GPIO only with no crystal and AFIO PD01_REMAP.' },
    { pins: ['PA11', 'PA12'], kind: 'USB', sev: 2, risk: 'USB D- / D+; the Blue Pill ties PA12 to 3.3 V through R10 (10 kΩ, should be 1.5 kΩ).', fix: 'Keep them for USB, or remove R10 to use them as GPIO.' },
    { pins: ['PA0', 'PA1', 'PA2', 'PA3', 'PA4', 'PA5', 'PA6', 'PA7', 'PB0', 'PB1', 'PB5', 'PC13', 'PC14', 'PC15'], kind: 'not 5 V tolerant', sev: 2, risk: 'The analog-capable pins, PB5 and PC13-15 are not FT: 5 V on them damages the chip.', fix: 'Put 5 V signals on FT pins (PA8-PA15, PB3-PB15 except PB5) or add a divider.' },
  ] },
  rp2040: { name: 'RP2040 (Raspberry Pi Pico)', num: 'GPIO', rows: [
    { pins: ['QSPI_SS'], kind: 'boot strap', sev: 3, risk: 'Not a GPIO: low at reset (the BOOTSEL button) starts the USB bootloader.', fix: 'Leave only the BOOTSEL button on it.' },
    { pins: [23], kind: 'board', sev: 2, cond: 'board', risk: 'Pico: SMPS power-save control, not on the header.', fix: 'Leave it to the board.' },
    { pins: [24], kind: 'board', sev: 2, cond: 'board', risk: 'Pico: VBUS sense, not on the header.', fix: 'Read only.' },
    { pins: [25], kind: 'board', sev: 1, cond: 'board', risk: 'Pico: the on-board LED.', fix: 'Fine as an output.' },
    { pins: [29], kind: 'board', sev: 2, cond: 'board', risk: 'Pico: ADC3 measures VSYS/3, not on the header.', fix: 'Read only.' },
    { pins: [26, 27, 28, 29], kind: 'ADC', sev: 1, risk: 'The only ADC inputs; keep them for analog if you need any.', fix: 'Plan analog signals here first.' },
  ] },
  atmega328p: { name: 'ATmega328P (Arduino Uno)', num: '', rows: [
    { pins: ['PC6'], kind: 'RESET', sev: 3, risk: 'GPIO only with the RSTDISBL fuse, which ends ISP (SPI) programming.', fix: 'Keep it as RESET.' },
    { pins: ['PB6', 'PB7'], kind: 'crystal', sev: 2, risk: 'XTAL1 / XTAL2 for the 16 MHz crystal.', fix: 'GPIO only with internal-RC clock fuses.' },
    { pins: ['PD0', 'PD1'], kind: 'serial bootloader', sev: 2, risk: 'RXD / TXD: the USB-serial chip and the bootloader use them.', fix: 'Add series resistors (1 kΩ) or keep them for serial.' },
    { pins: ['PB3', 'PB4', 'PB5'], kind: 'ISP', sev: 1, risk: 'MOSI, MISO, SCK for in-system programming; PB5 drives the Uno LED.', fix: 'Keep loads on them light so the programmer still works.' },
    { pins: ['ADC6', 'ADC7'], kind: 'input only', sev: 2, risk: 'TQFP/QFN only: analog inputs with no digital buffer.', fix: 'Use only with analogRead.' },
  ] },
};

// which pin names exist, to catch typos
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const EXISTS = {
  esp32: (p) => [...range(0, 19), 21, 22, 23, 25, 26, 27, ...range(32, 39)].includes(p),
  esp32s3: (p) => [...range(0, 21), ...range(26, 48)].includes(p),
  esp32c3: (p) => range(0, 21).includes(p),
  esp8266: (p) => range(0, 16).includes(p),
  rp2040: (p) => range(0, 29).includes(p) || p === 'QSPI_SS',
  stm32f103: (p) => /^(P[AB](1[0-5]|[0-9])|PC1[3-5]|PD[01]|BOOT0)$/.test(p),
  atmega328p: (p) => /^(P[BD][0-7]|PC[0-6]|ADC[67])$/.test(p),
};

const SEV = { 3: 'high', 2: 'medium', 1: 'low' };

function norm(chip, t) {
  const s = String(t).trim().toUpperCase().replace(/\s+/g, '');
  if (!s) return null;
  if (chip.num) { const m = /^(GPIO|GP|IO|D)?(\d+)$/.exec(s); if (m) return Number(m[2]); }
  return s;
}

export function run({ chip: key, pins, wifi, psram, board, show }) {
  const chip = CHIPS[key] || CHIPS.esp32;
  const flags = { wifi: !!wifi, psram: !!psram, board: !!board };
  const label = (p) => (typeof p === 'number' ? `${chip.num}${p}` : p);
  const exists = EXISTS[key] || EXISTS.esp32;
  const all = String(pins ?? '').split(/[,;\s]+/).map((t) => norm(chip, t)).filter((x) => x != null);
  const unknown = all.filter((p) => !exists(p));
  const mine = [...new Set(all.filter((p) => exists(p)))];
  const active = chip.rows.filter((r) => !r.cond || flags[r.cond]);
  const warnings = [], notes = [];
  if (unknown.length) warnings.push(`Not a pin on the ${chip.name}: ${unknown.map(label).join(', ')}. Check the name (${chip.num ? 'GPIO numbers such as 4 or IO4' : 'port names such as PA9'}).`);
  const hits = [];
  for (const p of mine) for (const r of active) if (r.pins.includes(p)) hits.push({ p, r });
  hits.sort((a, b) => b.r.sev - a.r.sev);
  for (const h of hits.filter((x) => x.r.sev === 3)) warnings.push(`${label(h.p)} (${h.r.kind}): ${h.r.risk} ${h.r.fix}`);
  const clean = mine.filter((p) => !hits.some((h) => h.p === p));
  const rows = (show === 'mine' ? active.filter((r) => r.pins.some((p) => mine.includes(p))) : active)
    .slice().sort((a, b) => b.sev - a.sev)
    .map((r) => [r.pins.map(label).join(', '), r.kind, SEV[r.sev], r.risk, r.fix, r.pins.some((p) => mine.includes(p)) ? 'YOURS' : '']);
  const high = hits.filter((h) => h.r.sev === 3).length, med = hits.filter((h) => h.r.sev === 2).length;
  const skipped = chip.rows.filter((r) => r.cond && !flags[r.cond]);
  if (skipped.length) notes.push(`Hidden because its condition is off: ${skipped.map((r) => `${r.kind} (${r.pins.map(label).join(', ')})`).join('; ')}.`);
  notes.push('Straps are only read at reset: a strap pin is usually fine as an output or button after boot, as long as nothing holds it at the wrong level while the chip resets.');
  return {
    values: [
      { label: 'Your pins', value: mine.length },
      { label: 'Boot/flash risks', value: high, tone: high ? 'bad' : 'ok', hint: 'can stop booting or programming' },
      { label: 'Limits to design for', value: med, tone: med ? 'warn' : 'ok' },
      { label: 'Unrestricted', value: clean.length, tone: 'ok', hint: clean.length ? clean.map(label).join(', ') : 'none' },
    ],
    tables: [
      ...(hits.length ? [{ title: 'Your restricted pins', columns: ['Pin', 'Kind', 'Severity', 'What to do'],
        rows: hits.map((h) => [label(h.p), h.r.kind, SEV[h.r.sev], h.r.fix]) }] : []),
      { title: `${chip.name}: special-purpose pins`, columns: ['Pins', 'Kind', 'Severity', 'Risk', 'What to do', 'Used'], rows },
    ],
    warnings, notes,
  };
}
