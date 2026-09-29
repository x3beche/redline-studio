// Linux GPIO Number Converter: a SoC pin name -> the gpiochip it sits on, its
// line offset in that chip, the legacy sysfs number (chip base + offset), the
// libgpiod v1 and v2 commands and the device-tree gpios specifier. Reverse: a
// sysfs number, "chip:line", "gpiochipN M" or a Raspberry Pi header pin.
//
// Numbering rules, per SoC family (where each comes from):
//  i.MX   GPIOn_IOm: one gpio-mxc chip per bank, 32 lines; /dev/gpiochip(n-1),
//         historical base (n-1)*32 from the "gpioN" alias
//         (drivers/gpio/gpio-mxc.c; imx6qdl.dtsi / imx8mm.dtsi aliases).
//  AM335x gpioN_M: one gpio-omap chip per bank, 32 lines, base N*32
//         (drivers/gpio/gpio-omap.c; am33xx.dtsi).
//  Allwinner PXn: one sunxi pinctrl chip per controller; lines padded to 32 per
//         bank, so line = bank*32 + n on "pio" (PA=0 ... ), base = pin_base;
//         PL.. sit on "r_pio" whose pin_base is PL_BASE = 352
//         (drivers/pinctrl/sunxi/pinctrl-sunxi.h, pinctrl-sun8i-h3.c).
//         DT uses <&pio bank pin flags> (3 cells; r_pio bank 0 = PL).
//  Rockchip GPIOx_Yn: one chip per bank, 32 lines as four groups A..D of 8:
//         line = group*8 + n, base x*32 (drivers/gpio/gpio-rockchip.c;
//         include/dt-bindings/pinctrl/rockchip.h RK_PA0..RK_PD7 = 0..31).
//  STM32MP15 PXn: one chip per bank, 16 lines, base = gpio-ranges start:
//         bank*16, GPIOZ 400 (stm32mp151.dtsi gpio-ranges;
//         drivers/pinctrl/stm32/pinctrl-stm32.c).
//  Raspberry Pi: one chip for all BCM lines (pinctrl-bcm2835: 54 lines,
//         pinctrl-bcm2711: 58, Pi 5 RP1 pinctrl-rp1: 54). Sysfs bases seen on
//         Raspberry Pi OS: 0 (Pi 1-4, kernel <= 6.1), 512 (Pi 1-4, 6.6+),
//         399 (Pi 5, 6.1), 571 (Pi 5, 6.6+). The Pi 5's RP1 chip was
//         /dev/gpiochip4 and is /dev/gpiochip0 on current kernels.
//  Since Linux 6.2 (ARCH_NR_GPIOS removed, drivers/gpio/gpiolib.c
//  GPIO_DYNAMIC_BASE = 512) a chip without a fixed base gets one from 512 up,
//  in probe order: the sysfs number is then not predictable - read
//  /sys/class/gpio/gpiochip*/base. The character device (/dev/gpiochipN +
//  line offset, libgpiod) is the stable interface
//  (Documentation/userspace-api/gpio/sysfs.rst: sysfs is deprecated).

const ACT = { high: 'GPIO_ACTIVE_HIGH', low: 'GPIO_ACTIVE_LOW' };
const hex = (v) => '0x' + v.toString(16).toUpperCase().padStart(8, '0');

const banks = (list) => list.map(([name, lines, bonded, addr, extra]) => ({ name, lines, bonded: bonded ?? lines, addr, ...(extra || {}) }));

// ---------- SoC table ----------
const SOCS = {
  imx6q: { name: 'NXP i.MX6 Quad/DualLite', family: 'imx',
    // IOMUX-bonded lines: GPIO7 has IO00..IO13 (i.MX6DQ RM ch. 28)
    banks: banks([1, 2, 3, 4, 5, 6, 7].map((n) => [`GPIO${n}`, 32, n === 7 ? 14 : 32, 0x0209C000 + (n - 1) * 0x4000])) },
  imx6ul: { name: 'NXP i.MX6UL/ULL', family: 'imx',
    // GPIO1_IO00-31, GPIO2_IO00-21, GPIO3_IO00-28, GPIO4_IO00-28, GPIO5_IO00-11 (i.MX6UL RM ch. 26)
    banks: banks([[1, 32], [2, 22], [3, 29], [4, 29], [5, 12]].map(([n, b]) => [`GPIO${n}`, 32, b, 0x0209C000 + (n - 1) * 0x4000])) },
  imx7d: { name: 'NXP i.MX7Dual', family: 'imx',
    banks: banks([1, 2, 3, 4, 5, 6, 7].map((n) => [`GPIO${n}`, 32, 32, 0x30200000 + (n - 1) * 0x10000])) },
  imx8mm: { name: 'NXP i.MX8M Mini', family: 'imx',
    // GPIO1_IO00-29, GPIO2_IO00-20, GPIO3_IO00-25, GPIO4_IO00-31, GPIO5_IO00-29 (i.MX8MM RM §8.3)
    banks: banks([[1, 30], [2, 21], [3, 26], [4, 32], [5, 30]].map(([n, b]) => [`GPIO${n}`, 32, b, 0x30200000 + (n - 1) * 0x10000])) },
  am335x: { name: 'TI AM335x (BeagleBone)', family: 'am335x',
    banks: banks([['gpio0', 32, 32, 0x44E07000], ['gpio1', 32, 32, 0x4804C000], ['gpio2', 32, 32, 0x481AC000], ['gpio3', 32, 32, 0x481AE000]]) },
  h3: { name: 'Allwinner H3/H5 (Orange Pi, NanoPi)', family: 'sunxi',
    // H3 datasheet §4.22: PA0-21, PC0-18, PD0-17, PE0-15, PF0-6, PG0-13, PL0-11
    banks: banks([['PA', 32, 22], ['PC', 32, 19], ['PD', 32, 18], ['PE', 32, 16], ['PF', 32, 7], ['PG', 32, 14], ['PL', 32, 12]]),
    pio: 0x01C20800, rpio: 0x01F02C00 },
  a64: { name: 'Allwinner A64 (Pine64)', family: 'sunxi',
    // A64 user manual §3.21: PB0-9, PC0-16, PD0-24, PE0-17, PF0-6, PG0-13, PH0-11, PL0-12
    banks: banks([['PB', 32, 10], ['PC', 32, 17], ['PD', 32, 25], ['PE', 32, 18], ['PF', 32, 7], ['PG', 32, 14], ['PH', 32, 12], ['PL', 32, 13]]),
    pio: 0x01C20800, rpio: 0x01F02C00 },
  rk3399: { name: 'Rockchip RK3399', family: 'rockchip',
    banks: banks([['GPIO0', 32, 32, 0xFF720000], ['GPIO1', 32, 32, 0xFF730000], ['GPIO2', 32, 32, 0xFF780000], ['GPIO3', 32, 32, 0xFF788000], ['GPIO4', 32, 32, 0xFF790000]]) },
  rk3568: { name: 'Rockchip RK3566/RK3568', family: 'rockchip',
    banks: banks([['GPIO0', 32, 32, 0xFDD60000], ['GPIO1', 32, 32, 0xFE740000], ['GPIO2', 32, 32, 0xFE750000], ['GPIO3', 32, 32, 0xFE760000], ['GPIO4', 32, 32, 0xFE770000]]) },
  rk3588: { name: 'Rockchip RK3588', family: 'rockchip',
    banks: banks([['GPIO0', 32, 32, 0xFD8A0000], ['GPIO1', 32, 32, 0xFEC20000], ['GPIO2', 32, 32, 0xFEC30000], ['GPIO3', 32, 32, 0xFEC40000], ['GPIO4', 32, 32, 0xFEC50000]]) },
  bcm2835: { name: 'Raspberry Pi 1/2/3/Zero (BCM2835/6/7)', family: 'rpi', label: 'pinctrl-bcm2835', dt: 'gpio',
    banks: banks([['GPIO', 54, 54, 0x7E200000]]) },
  bcm2711: { name: 'Raspberry Pi 4 / 400 / CM4 (BCM2711)', family: 'rpi', label: 'pinctrl-bcm2711', dt: 'gpio',
    banks: banks([['GPIO', 58, 58, 0x7E200000]]) },
  bcm2712: { name: 'Raspberry Pi 5 / CM5 (BCM2712 + RP1)', family: 'rpi', label: 'pinctrl-rp1', dt: 'rp1_gpio', pi5: true,
    banks: banks([['GPIO', 54, 54, 0x400D0000]]) },
  stm32mp15: { name: 'ST STM32MP15x', family: 'stm32',
    banks: banks([...'ABCDEFGHIJK'].map((c, i) => [`GPIO${c}`, 16, 16, 0x50002000 + i * 0x1000]).concat([['GPIOZ', 8, 8, 0x54004000]])) },
};

// Raspberry Pi 40-pin header (all models since the B+): pin -> BCM line or power.
export const HEADER = [
  '3V3', '5V', 2, '5V', 3, 'GND', 4, 14, 'GND', 15, 17, 18, 27, 'GND', 22, 23, '3V3', 24, 10, 'GND',
  9, 25, 11, 8, 'GND', 7, 0, 1, 5, 'GND', 6, 12, 13, 'GND', 19, 16, 26, 20, 'GND', 21,
];
// Default (ALT0 / common) function of the header lines (BCM2835 peripherals, §6.2).
const RPI_FN = { 0: 'ID_SD (HAT EEPROM)', 1: 'ID_SC (HAT EEPROM)', 2: 'I2C1 SDA', 3: 'I2C1 SCL', 4: 'GPCLK0',
  5: '', 6: '', 7: 'SPI0 CE1', 8: 'SPI0 CE0', 9: 'SPI0 MISO', 10: 'SPI0 MOSI', 11: 'SPI0 SCLK', 12: 'PWM0',
  13: 'PWM1', 14: 'UART TXD', 15: 'UART RXD', 16: '', 17: '', 18: 'PCM CLK / PWM0', 19: 'PCM FS / PWM1', 20: 'PCM DIN',
  21: 'PCM DOUT', 22: '', 23: '', 24: '', 25: '', 26: '', 27: '' };

export const SOC_IDS = Object.keys(SOCS);

// ---------- per-family naming ----------
const RK = 'ABCD';
function pinName(soc, b, i) {
  const bank = soc.banks[b];
  switch (soc.family) {
    case 'imx': return `${bank.name}_IO${String(i).padStart(2, '0')}`;
    case 'am335x': return `${bank.name}_${i}`;
    case 'sunxi': return `${bank.name}${i}`;
    case 'rockchip': return `${bank.name}_${RK[i >> 3]}${i & 7}`;
    case 'stm32': return `P${bank.name.slice(4)}${i}`;
    case 'rpi': return `GPIO${i}`;
    default: return `${bank.name}.${i}`;
  }
}

/** The chips the SoC registers: which bank on which /dev/gpiochipN, its line
 *  offset and default sysfs base. */
function chipsOf(soc, kernel) {
  const f = soc.family;
  const out = soc.banks.map((bank, b) => {
    if (f === 'imx') { const n = b; return { dev: n, label: `${bank.addr.toString(16)}.gpio`, base: n * 32, lineOf: (i) => i }; }
    if (f === 'am335x') return { dev: b, label: `${bank.addr.toString(16)}.gpio`, base: b * 32, lineOf: (i) => i };
    if (f === 'rockchip') return { dev: b, label: `gpio${b}`, base: b * 32, lineOf: (i) => i };
    if (f === 'stm32') {
      const z = bank.name === 'GPIOZ';
      return { dev: b, label: bank.name, base: z ? 400 : b * 16, lineOf: (i) => i };
    }
    if (f === 'rpi') {
      const new66 = kernel === 'new';
      const base = soc.pi5 ? (new66 ? 571 : 399) : (new66 ? 512 : 0);
      const dev = soc.pi5 ? (new66 ? 0 : 4) : 0;
      return { dev, label: soc.label, base, lineOf: (i) => i };
    }
    // sunxi: bank index from the letter; PL and up on r_pio
    const idx = bank.name.charCodeAt(1) - 65;
    const r = idx >= 11;
    return { dev: r ? 1 : 0, label: `${(r ? soc.rpio : soc.pio).toString(16)}.pinctrl`, base: r ? 352 : 0,
      lineOf: (i) => (r ? (idx - 11) * 32 + i : idx * 32 + i), idx, rbank: r ? idx - 11 : idx, ctl: r ? 'r_pio' : 'pio' };
  });
  return out;
}

function dtSpec(soc, b, i, act) {
  const bank = soc.banks[b];
  switch (soc.family) {
    case 'imx': return `<&gpio${b + 1} ${i} ${act}>`;
    case 'am335x': return `<&gpio${b} ${i} ${act}>`;
    case 'rockchip': return `<&gpio${b} RK_P${RK[i >> 3]}${i & 7} ${act}>`;
    case 'stm32': return `<&gpio${bank.name.slice(4).toLowerCase()} ${i} ${act}>`;
    case 'rpi': return `<&${soc.dt} ${i} ${act}>`;
    case 'sunxi': {
      const idx = bank.name.charCodeAt(1) - 65;
      return idx >= 11 ? `<&r_pio ${idx - 11} ${i} ${act}>` : `<&pio ${idx} ${i} ${act}>`;
    }
    default: return '';
  }
}

// ---------- parsing ----------
function findBank(soc, pred) { const b = soc.banks.findIndex(pred); return b < 0 ? null : b; }

/** Text -> {b, i} on this SoC, or {error}. */
function parsePin(soc, chips, text, baseOverride) { // baseOverride: only named in the message
  const t = String(text ?? '').trim();
  if (!t) return { error: 'No pin given: type a pin name like the ones on the grid, a sysfs number or chip:line.' };
  const f = soc.family;
  let m;
  // chip:line, gpiochipN M, gpiochipN:M
  if ((m = /^(?:\/dev\/)?(?:gpiochip)?\s*(\d+)\s*[: ]\s*(\d+)$/i.exec(t)) && /:|gpiochip/i.test(t)) {
    const dev = Number(m[1]), line = Number(m[2]);
    for (let b = 0; b < soc.banks.length; b++) {
      if (chips[b].dev !== dev) continue;
      for (let i = 0; i < soc.banks[b].lines; i++) if (chips[b].lineOf(i) === line) return { b, i, via: 'chip' };
    }
    return { error: `gpiochip${dev} line ${line} is not a line of the ${soc.name} (see the chips in the table).` };
  }
  // Raspberry Pi header pin
  if (f === 'rpi' && (m = /^(?:pin|header|p|hdr|j8[-_ ]?)\s*[#-]?\s*(\d+)$/i.exec(t))) {
    const p = Number(m[1]);
    if (p < 1 || p > 40) return { error: `Header pin ${p} does not exist: the header has pins 1 to 40.` };
    const v = HEADER[p - 1];
    if (typeof v !== 'number') return { error: `Header pin ${p} is ${v}, not a GPIO.` };
    return { b: 0, i: v, via: 'header' };
  }
  // plain number: legacy sysfs number
  if ((m = /^(?:gpio)?\s*(\d+)$/i.exec(t)) && !(f === 'rpi' && /^gpio/i.test(t))) {
    const n = Number(m[1]);
    for (let b = 0; b < soc.banks.length; b++) {
      const base = chips[b].base;
      for (let i = 0; i < soc.banks[b].lines; i++) if (base + chips[b].lineOf(i) === n) return { b, i, via: 'sysfs' };
    }
    return { error: `No line has sysfs number ${n} with the default chip bases of the ${soc.name}${baseOverride != null ? ' (a number is looked up with the default bases; with your own base, type the pin name)' : ''}.` };
  }
  let b = null, i = null;
  if (f === 'imx' && (m = /^gpio\s*(\d)\s*[_.\-\s]?\s*(?:io)?\s*(\d{1,2})$/i.exec(t))) {
    b = findBank(soc, (x) => x.name === `GPIO${m[1]}`); i = Number(m[2]);
  } else if (f === 'am335x' && (m = /^gpio\s*(\d)\s*[_.\-\[\s]\s*(\d{1,2})\]?$/i.exec(t))) {
    b = findBank(soc, (x) => x.name === `gpio${m[1]}`); i = Number(m[2]);
  } else if (f === 'sunxi' && (m = /^p\s*([a-n])\s*[_\-]?\s*(\d{1,2})$/i.exec(t))) {
    b = findBank(soc, (x) => x.name === `P${m[1].toUpperCase()}`); i = Number(m[2]);
  } else if (f === 'rockchip' && (m = /^(?:gpio)?\s*(\d)\s*[_\-]?\s*(?:rk_p)?([a-d])\s*(\d)$/i.exec(t))) {
    b = findBank(soc, (x) => x.name === `GPIO${m[1]}`); i = RK.indexOf(m[2].toUpperCase()) * 8 + Number(m[3]);
    if (Number(m[3]) > 7) return { error: `${t}: a Rockchip group has lines 0 to 7.` };
  } else if (f === 'stm32' && (m = /^(?:gpio)?p?\s*([a-kz])\s*[_\-]?\s*(\d{1,2})$/i.exec(t))) {
    b = findBank(soc, (x) => x.name === `GPIO${m[1].toUpperCase()}`); i = Number(m[2]);
  } else if (f === 'rpi' && (m = /^(?:bcm|gpio)\s*[_\-]?\s*(\d+)$/i.exec(t))) {
    b = 0; i = Number(m[1]);
  } else {
    const ex = { imx: 'GPIO1_IO05', am335x: 'gpio1_28', sunxi: 'PA10', rockchip: 'GPIO3_B4', stm32: 'PA13', rpi: 'GPIO17 or pin 11' }[f];
    return { error: `"${t}" does not read as a ${soc.name} pin. Write it like ${ex}, a sysfs number, or chip:line (0:5).` };
  }
  if (b == null) return { error: `"${t}": the ${soc.name} has no such bank (banks: ${soc.banks.map((x) => x.name).join(', ')}).` };
  if (i >= soc.banks[b].lines) return { error: `"${t}": ${soc.banks[b].name} has lines 0 to ${soc.banks[b].lines - 1}.` };
  return { b, i, via: 'name' };
}

function parseBase(text) {
  const t = String(text ?? '').trim();
  if (!t) return { v: null };
  const v = /^0x[0-9a-f]+$/i.test(t) ? parseInt(t, 16) : /^\d+$/.test(t) ? Number(t) : NaN;
  return Number.isFinite(v) ? { v } : { error: `Chip base "${t}" is not a whole number; leave it empty for the default.` };
}

// ---------- run ----------
export function run(input) {
  const warnings = [], notes = [];
  const socId = SOCS[input.soc] ? input.soc : 'imx6q';
  if (!SOCS[input.soc]) warnings.push(`Unknown SoC "${input.soc}": showing the i.MX6 Quad instead.`);
  const soc = SOCS[socId];
  const kernel = input.kernel === 'old' ? 'old' : 'new';
  const act = input.active === 'low' ? 'low' : 'high';
  const chips = chipsOf(soc, kernel);
  const bp = parseBase(input.base);
  if (bp.error) warnings.push(bp.error);
  const baseOverride = bp.v ?? null;

  let sel = parsePin(soc, chips, input.pin, baseOverride);
  let found = !sel.error;
  if (!found) { warnings.push(sel.error); sel = { b: 0, i: 0, via: 'fallback' }; }
  const { b, i } = sel;
  const bank = soc.banks[b], chip = chips[b];
  const name = pinName(soc, b, i);
  const line = chip.lineOf(i);
  const useOverride = baseOverride != null && sel.via !== 'sysfs';
  if (baseOverride != null && sel.via === 'sysfs') warnings.push(`A sysfs number was looked up with the default chip bases, so your base ${baseOverride} is not applied. Type the pin name to use your base.`);
  const base = useOverride ? baseOverride : chip.base;
  const sysfs = base + line;
  const dev = `gpiochip${chip.dev}`;
  const spec = dtSpec(soc, b, i, ACT[act]);
  const bonded = i < bank.bonded;
  const headerPin = soc.family === 'rpi' ? HEADER.findIndex((v) => v === i) + 1 : 0;

  if (found && !bonded) warnings.push(`${name} is not bonded out on the ${soc.name} (${bank.name} has lines 0 to ${bank.bonded - 1} on the package): the kernel still counts the line, but nothing is connected to it. Pick a pin that exists on the ball map.`);
  if (soc.family === 'rpi' && found && (i === 0 || i === 1)) warnings.push(`GPIO${i} (header pin ${headerPin}) is reserved for the HAT ID EEPROM (ID_SD/ID_SC): use it only if no HAT needs it.`);
  if (soc.family === 'rpi' && found && !headerPin) notes.push(`GPIO${i} is not on the 40-pin header (it drives on-board functions or is only on a Compute Module).`);
  if (soc.family === 'stm32' && bank.name === 'GPIOZ') notes.push('GPIOZ may be assigned to the secure world (TF-A/OP-TEE); if Linux does not see it, check the ETZPC/RIF setting in the TF-A device tree.');

  // sysfs base honesty
  if (soc.family === 'rpi') {
    notes.push(kernel === 'new'
      ? `Kernel 6.6+ on Raspberry Pi OS: the ${soc.label} chip's sysfs base is ${chip.base}, so the sysfs number is BCM + ${chip.base}.`
      : `Kernel 6.1 and older: the ${soc.label} chip's sysfs base is ${chip.base}.`);
    if (soc.pi5) notes.push(`Pi 5: the header lines are on the RP1 chip, /dev/gpiochip4 on kernel 6.1 and early 6.6 builds, /dev/gpiochip0 on current Raspberry Pi OS kernels (2024 onwards). gpiodetect shows which; libgpiod v2 also accepts the line name (gpioget GPIO${i}).`);
  } else if (!useOverride) {
    notes.push(`The sysfs number uses the historical base ${chip.base} of ${bank.name}. Since Linux 6.2 a chip without a fixed base is numbered from 512 upwards in probe order, so on your kernel read /sys/class/gpio/gpiochip*/base (or /sys/kernel/debug/gpio) and type that base in; the chip and line offset do not change.`);
  }
  if (soc.family === 'am335x') notes.push('AM335x: /dev/gpiochipN follows probe order; on most kernels gpio0 (44e07000, wakeup domain) is gpiochip0, but check the label with gpiodetect.');
  if (soc.family === 'sunxi') notes.push(`Allwinner: one chip holds all the ${chip.ctl === 'r_pio' ? 'PL-and-up (r_pio)' : 'PA..PK (pio)'} banks, padded to 32 lines per bank, so the line offset is ${chip.ctl === 'r_pio' ? '(bank - PL)' : 'bank'} * 32 + pin = ${line}.`);
  if (soc.family === 'imx') notes.push('i.MX: the pad must also be muxed to its GPIO function in the IOMUXC (a pinctrl group with the MX..._PAD_..._GPIOn_IOm macro), or the line reads the pin\'s other function.');
  if (soc.family === 'rockchip') notes.push(`Rockchip: line = group * 8 + n (A=0, B=1, C=2, D=3): ${name} -> ${RK.indexOf(RK[i >> 3])} * 8 + ${i & 7} = ${i}; dt-bindings/pinctrl/rockchip.h defines RK_P${RK[i >> 3]}${i & 7} = ${i}.`);

  const low = act === 'low';
  const chipArg = dev;
  const cmds = [
    `# ${name} on the ${soc.name}: ${dev} (${chip.label}) line ${line}, legacy sysfs ${sysfs}`,
    '',
    '# libgpiod v2 (2.x: Debian 13, Ubuntu 24.04+, Yocto scarthgap+)',
    'gpiodetect',
    `gpioinfo -c ${chipArg} ${line}`,
    `gpioget ${low ? '-l ' : ''}-c ${chipArg} ${line}`,
    `gpioset ${low ? '-l ' : ''}-t0 -c ${chipArg} ${line}=1     # -t0: set and exit; without it gpioset holds the line until Ctrl-C`,
    `gpiomon ${low ? '-l ' : ''}-e both -c ${chipArg} ${line}`,
    '',
    '# libgpiod v1 (1.x: Debian 12, Ubuntu 22.04, Yocto kirkstone)',
    `gpioinfo ${chipArg}`,
    `gpioget ${low ? '-l ' : ''}${chipArg} ${line}`,
    `gpioset ${low ? '-l ' : ''}${chipArg} ${line}=1          # exits at once; the line may fall back. -m wait holds it`,
    `gpiomon ${low ? '-l ' : ''}${chipArg} ${line}`,
    '',
    '# legacy sysfs (deprecated; needs CONFIG_GPIO_SYSFS)',
    `echo ${sysfs} > /sys/class/gpio/export`,
    `echo out > /sys/class/gpio/gpio${sysfs}/direction`,
    ...(low ? [`echo 1 > /sys/class/gpio/gpio${sysfs}/active_low`] : []),
    `echo 1 > /sys/class/gpio/gpio${sysfs}/value`,
    `echo ${sysfs} > /sys/class/gpio/unexport`,
  ].join('\n');
  const dtHdr = ['#include <dt-bindings/gpio/gpio.h>', ...(soc.family === 'rockchip' ? ['#include <dt-bindings/pinctrl/rockchip.h>'] : [])];
  const dts = [
    ...dtHdr, '',
    '/* a consumer: a gpio-leds LED, or <name>-gpios in any driver node */',
    'leds {',
    '\tcompatible = "gpio-leds";',
    '\tled-0 {',
    `\t\tgpios = ${spec};`,
    '\t\tdefault-state = "off";',
    '\t};',
    '};',
  ].join('\n');

  // one table row per chip
  const rows = soc.banks.map((bk, k) => {
    const c = chips[k];
    const first = pinName(soc, k, 0), last = pinName(soc, k, bk.bonded - 1);
    const b0 = useOverride && k === b ? baseOverride : c.base;
    return [bk.name, `gpiochip${c.dev}`, c.label, `${c.lineOf(0)}..${c.lineOf(bk.lines - 1)}`, `${first}..${last}`, `${b0 + c.lineOf(0)}..${b0 + c.lineOf(bk.lines - 1)}`];
  });

  const values = [
    { label: 'Pin', value: found ? name : `not found (showing ${name})`, hint: !found ? 'see the warning' : headerPin ? `header pin ${headerPin}${RPI_FN[i] ? ', ' + RPI_FN[i] : ''}` : bank.addr ? `${bank.name} @ ${hex(bank.addr)}` : bank.name, tone: found ? (bonded ? 'ok' : 'warn') : 'bad' },
    { label: 'Character device', value: `/dev/${dev}`, hint: `label ${chip.label}` },
    { label: 'Line offset', value: line, hint: soc.family === 'sunxi' ? `bank ${chip.rbank} * 32 + ${i}` : soc.family === 'rockchip' ? `${RK[i >> 3]}=${i >> 3} * 8 + ${i & 7}` : `in ${bank.name}` },
    { label: 'Legacy sysfs number', value: sysfs, hint: `base ${base} + ${line}${useOverride ? ' (your base)' : soc.family === 'rpi' ? ` (kernel ${kernel === 'new' ? '6.6+' : '<= 6.1'})` : ' (historical default)'}` },
    { label: 'Device tree', value: spec },
  ];

  const grid = {
    family: soc.family, soc: soc.name,
    banks: soc.banks.map((bk, k) => ({ name: bk.name, lines: bk.lines, bonded: bk.bonded, dev: chips[k].dev, label: chips[k].label,
      base: useOverride && k === b ? baseOverride : chips[k].base, addr: bk.addr ? hex(bk.addr) : '',
      names: Array.from({ length: bk.lines }, (_, x) => pinName(soc, k, x)),
      offsets: Array.from({ length: bk.lines }, (_, x) => chips[k].lineOf(x)) })),
    sel: { b, i, found, name, line, sysfs, dev, spec, header: headerPin },
    header: soc.family === 'rpi' ? HEADER.map((v, k) => ({ pin: k + 1, v, fn: typeof v === 'number' ? RPI_FN[v] || '' : '' })) : null,
  };

  return {
    values,
    tables: [{ title: `${soc.name}: GPIO chips`, columns: ['Bank', 'Device', 'Label', 'Lines', 'Pins', 'Sysfs'], rows }],
    texts: [{ title: 'Commands', body: cmds, lang: 'sh' }, { title: 'Device tree', body: dts, lang: 'dts' }],
    warnings, notes, grid,
  };
}
