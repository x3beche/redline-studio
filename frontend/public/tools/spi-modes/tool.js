// SPI mode reference. The mode number is CPOL·2 + CPHA (Motorola SPI Block
// Guide S12SPIV3, the de-facto definition; Linux spidev SPI_MODE_0..3):
//   CPOL = clock level when idle; CPHA = 0: data sampled on the leading (first)
//   edge after CS falls and shifted on the trailing edge; CPHA = 1: shifted on
//   the leading edge, sampled on the trailing edge.
// Device modes are from each part's datasheet timing diagram.

const MODES = [0, 1, 2, 3].map((n) => {
  const cpol = n >> 1, cpha = n & 1;
  const lead = cpol ? 'falling' : 'rising', trail = cpol ? 'rising' : 'falling';
  return { n, cpol, cpha, idle: cpol ? 'high' : 'low', sample: cpha ? trail : lead, shift: cpha ? lead : trail,
    first: cpha ? 'on the first clock edge' : 'when CS falls, before the first edge' };
});

// [part, modes, note]
const DEVICES = [
  ['SD / microSD card (SPI mode)', [0, 3], 'mode 0 is the usual choice; 400 kHz during init'],
  ['W25Qxx, MX25, GD25 SPI NOR flash', [0, 3], 'mode detected from the SCK level at CS fall'],
  ['25LCxxx / AT25xxx SPI EEPROM', [0, 3], ''],
  ['BMP280 / BME280 / BME680', [0, 3], 'auto-selected by the SCK level at CSB fall'],
  ['BMI160 / BMI088 / BMI270', [0, 3], ''],
  ['MPU-6000 / MPU-9250 / ICM-20948 / ICM-42688', [0, 3], 'max 1 MHz for register writes on MPU-6000/9250'],
  ['ADXL345', [3], 'CPOL = 1, CPHA = 1 only'],
  ['ADXL362', [0], ''],
  ['L3GD20 / LIS3DH / LSM6DS3 / LIS3MDL (ST MEMS)', [3], 'ST MEMS: SPC idle high, sampled on rising edge'],
  ['MAX31855 thermocouple', [0], 'read-only, 32 bits'],
  ['MAX6675 thermocouple', [0], 'read-only, 16 bits'],
  ['MAX31865 RTD', [1, 3], 'mode detected from SCLK level at CS fall'],
  ['MAX7219 LED driver', [0], 'data latched on LOAD/CS rising edge'],
  ['74HC595 shift register', [0], 'shifts on SRCLK rising; latch on RCLK'],
  ['MCP3008 / MCP3208 ADC', [0, 3], ''],
  ['MCP4921 / MCP4922 DAC', [0, 3], ''],
  ['MCP2515 CAN controller', [0, 3], ''],
  ['ADS1118 / ADS1220 / ADS1256 ADC', [1], 'data changes on rising, sampled on falling SCLK'],
  ['AD7124 ADC', [3], ''],
  ['AD9833 DDS', [2], 'data clocked in on SCLK falling edge, SCLK idle high'],
  ['AS5047P magnetic encoder', [1], '16-bit frames, CS high ≥ 350 ns between frames'],
  ['TMC2130 / TMC5160 stepper driver', [3], '40-bit datagrams'],
  ['nRF24L01+ radio', [0], 'max 10 MHz'],
  ['CC1101 radio', [0], 'wait for SO low after CS falls'],
  ['SX1276 / SX1262 LoRa', [0], 'SX126x: check BUSY low first'],
  ['DW1000 UWB', [0], 'modes 0–3 strapped by GPIO5/GPIO6 at reset; 0 by default'],
  ['ENC28J60 Ethernet', [0], ''],
  ['W5500 Ethernet', [0, 3], ''],
  ['MFRC522 RFID', [0], ''],
  ['ILI9341 / ST7735 display', [0], 'many boards also accept 3'],
  ['ST7789 display (boards without CS)', [3], 'with no CS pin the controller needs CPOL = 1'],
  ['SSD1306 OLED (4-wire SPI)', [0, 3], ''],
];

// How each ecosystem spells the mode: fn(mode) -> text
const NAMES = [
  ['Linux spidev', (m) => `SPI_MODE_${m.n}${m.n ? ` (= ${[m.cpol ? 'SPI_CPOL' : '', m.cpha ? 'SPI_CPHA' : ''].filter(Boolean).join(' | ')})` : ''}`],
  ['Arduino', (m) => `SPISettings(freq, MSBFIRST, SPI_MODE${m.n})`],
  ['ESP-IDF', (m) => `spi_device_interface_config_t.mode = ${m.n}`],
  ['Zephyr', (m) => (m.n ? [m.cpol ? 'SPI_MODE_CPOL' : '', m.cpha ? 'SPI_MODE_CPHA' : ''].filter(Boolean).join(' | ') : '(neither SPI_MODE_CPOL nor SPI_MODE_CPHA)')],
  ['STM32 HAL', (m) => `CLKPolarity = SPI_POLARITY_${m.cpol ? 'HIGH' : 'LOW'}, CLKPhase = SPI_PHASE_${m.cpha ? '2EDGE' : '1EDGE'}`],
  ['STM32 SPI_CR1', (m) => `CPOL (bit 1) = ${m.cpol}, CPHA (bit 0) = ${m.cpha}`],
  ['AVR SPCR', (m) => `CPOL = ${m.cpol}, CPHA = ${m.cpha} (SPCR |= ${m.n << 2 ? `0x${(m.n << 2).toString(16).toUpperCase().padStart(2, '0')}` : '0'})`],
  ['PIC MSSP (SSPxSTAT/SSPxCON1)', (m) => `CKP = ${m.cpol}, CKE = ${1 - m.cpha} (CKE is inverted CPHA)`],
  ['Atmel SAM3/4 SPI_CSR', (m) => `CPOL = ${m.cpol}, NCPHA = ${1 - m.cpha} (NCPHA is inverted CPHA)`],
  ['SAMD SERCOM CTRLA', (m) => `CPOL = ${m.cpol}, CPHA = ${m.cpha}`],
  ['TI Tiva / MSP432 SSI', (m) => `SPO = ${m.cpol}, SPH = ${m.cpha} (SSI_FRF_MOTO_MODE_${m.n})`],
  ['NXP LPSPI TCR', (m) => `CPOL = ${m.cpol}, CPHA = ${m.cpha}`],
  ['TI MSP430 eUSCI', (m) => `UCCKPL = ${m.cpol}, UCCKPH = ${1 - m.cpha} (UCCKPH is inverted CPHA)`],
];

function parseByte(t, dflt) {
  const s = String(t ?? '').trim();
  if (!s) return { v: dflt, ok: true };
  const m = /^(?:0x)?([0-9a-f]{1,2})$/i.exec(s) || /^0b([01]{1,8})$/i.exec(s);
  if (!m) return { v: dflt, ok: false };
  return { v: /^0b/i.test(s) ? parseInt(m[1], 2) : parseInt(m[1], 16), ok: true };
}
const bitsOf = (v, lsb) => Array.from({ length: 8 }, (_, i) => (lsb ? (v >> i) & 1 : (v >> (7 - i)) & 1));
const hx = (v) => '0x' + v.toString(16).toUpperCase().padStart(2, '0');

export function run({ mode, device, mosi, miso, order }) {
  const warnings = [];
  const sel = mode === 'all' ? null : MODES[Number(mode)] ?? MODES[0];
  const tx = parseByte(mosi, 0xA5), rx = parseByte(miso, 0x3C);
  if (!tx.ok) warnings.push(`MOSI byte "${mosi}" is not a byte; write it like 0xA5 or 0b10100101. 0xA5 is drawn.`);
  if (!rx.ok) warnings.push(`MISO byte "${miso}" is not a byte; write it like 0x3C. 0x3C is drawn.`);
  const lsb = order === 'lsb';
  const q = String(device || '').trim().toLowerCase();
  const devs = DEVICES.filter(([name, ms]) => (!q || name.toLowerCase().includes(q)) && (!sel || ms.includes(sel.n)));
  if (q && !devs.length) warnings.push(`No listed part matches "${device}"${sel ? ` in mode ${sel.n}` : ''}. Check the part's timing diagram: find the SCK level while CS is high (CPOL) and the edge where the part reads MOSI (the sample edge).`);

  const shown = sel ? [sel] : MODES;
  const values = sel ? [
    { label: 'Mode', value: sel.n, tone: 'ok' },
    { label: 'CPOL', value: sel.cpol, hint: `clock idles ${sel.idle}` },
    { label: 'CPHA', value: sel.cpha, hint: sel.cpha ? 'sample on 2nd (trailing) edge' : 'sample on 1st (leading) edge' },
    { label: 'Sample on', value: `${sel.sample} edge` },
    { label: 'Shift on', value: `${sel.shift} edge` },
    { label: 'First bit valid', value: sel.cpha ? 'after 1st edge' : 'at CS fall' },
  ] : [{ label: 'Modes shown', value: 'all four' }];

  const tables = [
    { title: 'SPI modes', columns: ['Mode', 'CPOL', 'CPHA', 'SCK idle', 'Sample edge', 'Shift edge', 'First bit on MOSI'],
      rows: shown.map((m) => [m.n, m.cpol, m.cpha, m.idle, m.sample, m.shift, m.first]) },
  ];
  if (sel) tables.push({ title: `Mode ${sel.n} in each ecosystem`, columns: ['Where', 'Setting'], rows: NAMES.map(([k, f]) => [k, f(sel)]) });
  if (devs.length) tables.push({ title: q || sel ? 'Parts that match' : 'Common parts', columns: ['Part', 'Modes', 'Note'],
    rows: devs.map(([n, ms, note]) => [n, ms.join(', '), note]) });

  return {
    // Every part the filter matches, whatever the mode: the page's part list.
    parts: DEVICES.filter(([name]) => !q || name.toLowerCase().includes(q)).map(([name, ms, note]) => ({ name, modes: ms, note })),
    values,
    warnings,
    tables,
    drawing: { modes: shown.map((m) => ({ n: m.n, cpol: m.cpol, cpha: m.cpha, sample: m.sample })),
      mosi: bitsOf(tx.v, lsb), miso: bitsOf(rx.v, lsb), mosiVal: tx.v, misoVal: rx.v, lsb, mosiHex: hx(tx.v), misoHex: hx(rx.v), order: lsb ? 'LSB first' : 'MSB first' },
    notes: [
      'Mode = 2·CPOL + CPHA. Master and slave must agree; a one-mode error often reads as data shifted by one bit, a wrong CPOL can lose the first or last bit.',
      'Parts that accept "0 and 3" sample on the rising edge either way; they latch the SCK level when CS falls.',
      'PIC CKE, MSP430 UCCKPH and SAM NCPHA are the inverse of CPHA: check the manual before copying a mode number.',
    ],
  };
}
