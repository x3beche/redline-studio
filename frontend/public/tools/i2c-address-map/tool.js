// I2C address map: parse a device list (or an i2cdetect grid), place every
// device on a 7-bit address, and report conflicts and the free alternatives.
// Reserved addresses per NXP UM10204 table 4: 0x00–0x07 and 0x78–0x7F.
// Device addresses and their strap options are from each part's datasheet.

const hx = (a) => '0x' + a.toString(16).toUpperCase().padStart(2, '0');
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

// key: normalised name (letters+digits, upper case); addrs[0] is the default.
const DEVICES = [
  { names: ['BME280', 'BMP280', 'BME680', 'BME688', 'BMP388', 'BMP390'], addrs: [0x76, 0x77], how: 'SDO pin low/high' },
  { names: ['BMP180', 'BMP085'], addrs: [0x77], how: 'fixed' },
  { names: ['SHT30', 'SHT31', 'SHT35', 'SHT3X', 'SHT85'], addrs: [0x44, 0x45], how: 'ADDR pin low/high (SHT85: 0x44 only)' },
  { names: ['SHT40', 'SHT41', 'SHT45', 'SHT4X'], addrs: [0x44, 0x45, 0x46], how: 'fixed per order code (-AD1B 0x44, -BD1B 0x45, -CD1B 0x46)' },
  { names: ['HTU21D', 'SI7021', 'SI7020', 'HDC1080'], addrs: [0x40], how: 'fixed' },
  { names: ['AHT20', 'AHT10', 'AHT21'], addrs: [0x38], how: 'fixed (AHT10: 0x39 with ADDR high)' },
  { names: ['TMP102'], addrs: [0x48, 0x49, 0x4A, 0x4B], how: 'ADD0 to GND/V+/SDA/SCL' },
  { names: ['TMP117'], addrs: [0x48, 0x49, 0x4A, 0x4B], how: 'ADD0 to GND/V+/SDA/SCL' },
  { names: ['LM75', 'LM75A', 'LM75B'], addrs: range(0x48, 0x4F), how: 'A2..A0 pins' },
  { names: ['MCP9808'], addrs: range(0x18, 0x1F), how: 'A2..A0 pins' },
  { names: ['ADS1115', 'ADS1015', 'ADS1113', 'ADS1114'], addrs: [0x48, 0x49, 0x4A, 0x4B], how: 'ADDR to GND/VDD/SDA/SCL' },
  { names: ['INA219'], addrs: range(0x40, 0x4F), how: 'A1, A0 to GND/VS/SDA/SCL' },
  { names: ['INA226', 'INA228', 'INA260', 'INA230'], addrs: range(0x40, 0x4F), how: 'A1, A0 to GND/VS/SDA/SCL' },
  { names: ['INA3221'], addrs: range(0x40, 0x43), how: 'A0 to GND/VS/SDA/SCL' },
  { names: ['PCA9685'], addrs: range(0x40, 0x7F).filter((a) => a !== 0x70 && a < 0x78), how: 'A5..A0 pins; 0x70 is its ALLCALL address (on by default)' },
  { names: ['MCP23017', 'MCP23008', 'MCP23018'], addrs: range(0x20, 0x27), how: 'A2..A0 pins' },
  { names: ['PCF8574', 'PCF8575', 'TCA9555', 'PCA9555'], addrs: range(0x20, 0x27), how: 'A2..A0 pins' },
  { names: ['PCF8574A'], addrs: range(0x38, 0x3F), how: 'A2..A0 pins' },
  { names: ['SSD1306', 'SH1106', 'SSD1309'], addrs: [0x3C, 0x3D], how: 'SA0 / D/C pin low/high' },
  { names: ['MPU6050', 'MPU6500', 'MPU9250', 'ICM20948', 'ICM20602', 'ICM42688', 'ICM42605'], addrs: [0x68, 0x69], how: 'AD0 pin low/high' },
  { names: ['DS3231', 'DS1307', 'DS1338'], addrs: [0x68], how: 'fixed' },
  { names: ['PCF8563', 'PCF85063'], addrs: [0x51], how: 'fixed' },
  { names: ['RV3028'], addrs: [0x52], how: 'fixed' },
  { names: ['AT24C32', 'AT24C02', 'AT24C256', '24LC256', '24LC64', '24C02', '24AA02', 'M24C64', 'EEPROM'], addrs: range(0x50, 0x57), how: 'A2..A0 pins (small parts use the pins as page bits)' },
  { names: ['VL53L0X', 'VL53L1X', 'VL6180X'], addrs: [0x29], how: '0x29 at power-up; set another in software with XSHUT sequencing' },
  { names: ['TCA9548A', 'PCA9548A', 'TCA9548'], addrs: range(0x70, 0x77), how: 'A2..A0 pins' },
  { names: ['ADXL345'], addrs: [0x53, 0x1D], how: 'SDO/ALT ADDRESS low/high' },
  { names: ['LIS3DH', 'LIS2DH12', 'LIS2DW12'], addrs: [0x18, 0x19], how: 'SA0 low/high' },
  { names: ['LSM6DS3', 'LSM6DSO', 'LSM6DSOX', 'LSM6DS33', 'ISM330DHCX'], addrs: [0x6A, 0x6B], how: 'SA0 low/high' },
  { names: ['LIS3MDL'], addrs: [0x1C, 0x1E], how: 'SA1 low/high' },
  { names: ['BNO055'], addrs: [0x28, 0x29], how: 'COM3 low/high' },
  { names: ['BNO085', 'BNO080'], addrs: [0x4A, 0x4B], how: 'SA0 low/high' },
  { names: ['BH1750'], addrs: [0x23, 0x5C], how: 'ADDR low/high' },
  { names: ['VEML7700', 'VEML6070'], addrs: [0x10], how: 'fixed' },
  { names: ['TSL2561'], addrs: [0x39, 0x29, 0x49], how: 'ADDR float/GND/VDD' },
  { names: ['TSL2591'], addrs: [0x29], how: 'fixed' },
  { names: ['APDS9960'], addrs: [0x39], how: 'fixed' },
  { names: ['MAX17048', 'MAX17043'], addrs: [0x36], how: 'fixed' },
  { names: ['AS5600'], addrs: [0x36], how: 'fixed (AS5600L: programmable)' },
  { names: ['BQ27441', 'BQ27220'], addrs: [0x55], how: 'fixed' },
  { names: ['SGP30'], addrs: [0x58], how: 'fixed' },
  { names: ['SGP40', 'SGP41'], addrs: [0x59], how: 'fixed' },
  { names: ['SCD30'], addrs: [0x61], how: 'fixed' },
  { names: ['SCD40', 'SCD41', 'SCD4X'], addrs: [0x62], how: 'fixed' },
  { names: ['CCS811'], addrs: [0x5A, 0x5B], how: 'ADDR low/high' },
  { names: ['ENS160'], addrs: [0x52, 0x53], how: 'ADDR low/high' },
  { names: ['MCP4725'], addrs: range(0x60, 0x67), how: 'A0 pin plus the A0/A1/A2/A3 order code' },
  { names: ['MCP4728'], addrs: range(0x60, 0x67), how: 'programmed into EEPROM (0x60 from the factory)' },
  { names: ['HMC5883L'], addrs: [0x1E], how: 'fixed' },
  { names: ['QMC5883L'], addrs: [0x0D], how: 'fixed' },
  { names: ['MAX30102', 'MAX30105'], addrs: [0x57], how: 'fixed' },
  { names: ['DS2482'], addrs: [0x18, 0x19, 0x1A, 0x1B], how: 'AD1, AD0 pins' },
  { names: ['FT6206', 'FT6236', 'FT5X06'], addrs: [0x38], how: 'fixed' },
  { names: ['GT911'], addrs: [0x5D, 0x14], how: 'INT level during reset' },
  { names: ['STUSB4500'], addrs: [0x28, 0x29, 0x2A, 0x2B], how: 'ADDR1, ADDR0 pins' },
  { names: ['SI5351'], addrs: [0x60, 0x61], how: 'fixed per order code (A0)' },
  { names: ['PCA9632'], addrs: [0x62], how: 'fixed (8-pin); 0x70 ALLCALL' },
  { names: ['DRV2605'], addrs: [0x5A], how: 'fixed' },
  { names: ['MPR121'], addrs: [0x5A, 0x5B, 0x5C, 0x5D], how: 'ADDR to GND/VDD/SDA/SCL' },
  { names: ['LTC4151'], addrs: range(0x66, 0x6F), how: 'ADR1, ADR0 (three-state)' },
  { names: ['TCA6408', 'TCA6408A'], addrs: [0x20, 0x21], how: 'ADDR low/high' },
  { names: ['PCAL6416', 'TCA6416'], addrs: [0x20, 0x21], how: 'ADDR low/high' },
];
/** Every part name the tool knows, for the page's add-a-device list. */
export const PART_NAMES = DEVICES.flatMap((d) => d.names);

const norm = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
const INDEX = new Map();
for (const d of DEVICES) for (const n of d.names) INDEX.set(norm(n), d);

function findDevice(token) {
  const t = norm(token);
  if (!t) return null;
  if (INDEX.has(t)) return INDEX.get(t);
  // "BME280-breakout", "SSD1306 128x64": the longest known name the token starts with
  let best = null, bl = 0;
  for (const [k, d] of INDEX) if (t.startsWith(k) && k.length > bl && k.length >= 4) { best = d; bl = k.length; }
  return best;
}

const reserved = (a) => a <= 0x07 || a >= 0x78;
const RESERVED_WHY = (a) => (a === 0 ? 'general call' : a === 1 ? 'CBUS' : a === 2 ? 'other bus formats' : a === 3 ? 'future use'
  : a <= 7 ? 'Hs-mode master code' : a <= 0x7B ? '10-bit addressing' : 'device ID / future use');

// An i2cdetect -y grid: "40: -- -- 42 -- UU ..."
function parseDetect(lines) {
  const found = [];
  let isGrid = false;
  for (const l of lines) {
    const m = /^\s*([0-7]0):\s+(.*)$/.exec(l);
    if (!m) continue;
    isGrid = true;
    const base = parseInt(m[1], 16);
    const cells = m[2].trim().split(/\s+/);
    // the first row starts at 0x03 on i2cdetect's default range: align from the right of 16 columns
    const offset = base === 0 && cells.length < 16 ? 16 - cells.length : 0;
    cells.forEach((c, i) => {
      if (/^[0-9a-f]{2}$/i.test(c) || c === 'UU') found.push({ addr: base + offset + i, busy: c === 'UU' });
    });
  }
  return isGrid ? found : null;
}

function parseAddr(tok, eight) {
  let m = /^0x([0-9a-f]{1,2})$/i.exec(tok) || /^([0-9a-f]{1,2})h$/i.exec(tok);
  let v = m ? parseInt(m[1], 16) : null;
  if (v == null && /^(?:addr|address|@)=?(\d{1,3})$/i.test(tok)) v = Number(/(\d{1,3})$/.exec(tok)[1]);
  if (v == null) return null;
  return eight ? v >> 1 : v;
}

export function run({ list, format, bus }) {
  const warnings = [], notes = [];
  const eight = format === '8bit';
  const lines = String(list || '').split(/\r?\n/);
  const detect = parseDetect(lines);
  const devices = [], unparsed = [];

  if (detect) {
    for (const f of detect) {
      const could = DEVICES.filter((d) => d.addrs.includes(f.addr)).sort((a, b) => a.addrs.length - b.addrs.length).map((d) => d.names[0]);
      devices.push({ name: f.busy ? `${hx(f.addr)} (in use by a driver)` : `${hx(f.addr)} (found on scan)`, addr: f.addr, fixed: true, allowed: null, line: 0, scan: true,
        how: could.length ? `could be ${could.slice(0, 5).join(', ')}${could.length > 5 ? ' …' : ''}` : 'no common part known here' });
    }
    notes.push(`Read as an i2cdetect grid: ${detect.length} responding addresses.`);
  } else {
    lines.forEach((raw, li) => {
      const line = raw.replace(/(#|\/\/).*$/, '').trim();
      if (!line) return;
      const toks = line.split(/[\s,;:=]+/).filter(Boolean);
      let addr = null, count = 1, dev = null;
      const nameToks = [];
      for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        if (/^(?:addr|address)$/i.test(t)) continue;
        const a = parseAddr(t, eight);
        if (a != null && addr == null) { addr = a; continue; }
        const c = /^[x×*](\d{1,2})$/i.exec(t) || /^(\d{1,2})[x×]$/i.exec(t);
        if (c) { count = Math.max(1, Number(c[1])); continue; }
        if (!dev) dev = findDevice(t);
        nameToks.push(t);
      }
      if (!dev) dev = findDevice(nameToks.join(''));
      const name = nameToks.join(' ') || (addr != null ? 'device' : '');
      if (!name && addr == null) { unparsed.push(`line ${li + 1}: "${raw.trim()}"`); return; }
      if (!dev && addr == null) { unparsed.push(`line ${li + 1}: "${raw.trim()}" (unknown part and no address; add it as "name 0x48")`); return; }
      for (let k = 0; k < count; k++) {
        devices.push({ name: count > 1 ? `${name} #${k + 1}` : name, addr: k === 0 ? addr : null, fixed: k === 0 && addr != null, allowed: dev ? dev.addrs : null, how: dev?.how, line: li + 1,
          base: name, k, count, part: dev ? dev.names[0] : null });
      }
      if (addr != null && addr > 0x7F) warnings.push(`Line ${li + 1}: ${hx(addr)} is not a 7-bit address. If it is the 8-bit (R/W) form, set "Addresses are" to 8-bit.`);
    });
  }

  // Place devices: fixed ones first, then each auto device on its first free allowed address.
  const used = new Map(); // addr -> [device]
  const put = (d) => { if (!used.has(d.addr)) used.set(d.addr, []); used.get(d.addr).push(d); };
  for (const d of devices) if (d.fixed) put(d);
  for (const d of devices) {
    if (d.fixed) continue;
    const free = d.allowed.find((a) => !used.has(a) && !reserved(a));
    d.addr = free ?? d.allowed[0];
    d.auto = true;
    put(d);
  }

  const rows = [];
  let conflicts = 0;
  for (const d of devices) {
    const same = used.get(d.addr) || [];
    let status = 'ok';
    const alts = d.allowed ? d.allowed.filter((a) => a !== d.addr && !used.has(a) && !reserved(a)) : [];
    if (d.addr > 0x7F) status = 'not 7-bit';
    else if (reserved(d.addr)) status = `reserved (${RESERVED_WHY(d.addr)})`;
    else if (same.length > 1) status = `CONFLICT with ${same.filter((x) => x !== d).map((x) => x.name).join(', ')}`;
    else if (d.allowed && !d.allowed.includes(d.addr)) status = `not an address this part can take (${d.allowed.map(hx).join(', ')})`;
    if (same.length > 1) conflicts++;
    d.status = status; d.alts = alts;
    rows.push([hx(d.addr), d.name, d.scan ? 'scan' : d.auto ? 'default/auto' : 'given', status,
      d.allowed ? (d.allowed.length === 1 ? 'none (fixed address)' : alts.length ? alts.slice(0, 6).map(hx).join(' ') + (alts.length > 6 ? ' …' : '') : 'none free') : '–',
      d.how || (d.allowed ? '' : 'unknown part: check its datasheet')]);
  }
  rows.sort((a, b) => parseInt(a[0], 16) - parseInt(b[0], 16));

  // Conflict advice
  for (const [a, ds] of used) {
    if (ds.length < 2) continue;
    const movable = ds.find((d) => d.allowed && d.allowed.some((x) => !used.has(x) && !reserved(x)));
    if (movable) {
      const to = movable.allowed.find((x) => !used.has(x) && !reserved(x));
      warnings.push(`${hx(a)} is taken by ${ds.map((d) => d.name).join(' and ')}. Move ${movable.name} to ${hx(to)} (${movable.how}).`);
    } else {
      const soft = ds.find((d) => /software/.test(d.how || ''));
      warnings.push(`${hx(a)} is taken by ${ds.map((d) => d.name).join(' and ')} and none can move to a free address by its pins. ${soft ? `${soft.name}: ${soft.how}; otherwise p` : 'P'}ut one behind an I2C mux (TCA9548A, 0x70–0x77) or on a second bus.`);
    }
  }
  if (devices.some((d) => /PCA9685/i.test(d.name)) && used.has(0x70) && used.get(0x70).some((d) => !/PCA9685/i.test(d.name))) {
    warnings.push('A PCA9685 answers its ALLCALL address 0x70 by default, which clashes with the device at 0x70 (often a TCA9548A). Clear ALLCALL in MODE1 at start-up.');
  }
  for (const d of devices) if (reserved(d.addr)) warnings.push(`${d.name} at ${hx(d.addr)} is on a reserved address (${RESERVED_WHY(d.addr)}); it may clash with general call, Hs-mode or 10-bit traffic.`);
  if (unparsed.length) warnings.push(`Could not read ${unparsed.length} line(s): ${unparsed.join('; ')}.`);
  if (!devices.length) return { warnings: warnings.length ? warnings : ['List one device per line, e.g. "BME280 0x76" or "INA219 x3", or paste an i2cdetect grid.'] };

  // i2cdetect-style picture of the bus
  const grid = ['     0  1  2  3  4  5  6  7  8  9  a  b  c  d  e  f'];
  for (let r = 0; r < 8; r++) {
    let l = `${(r * 16).toString(16).padStart(2, '0')}: `;
    for (let c = 0; c < 16; c++) {
      const a = r * 16 + c;
      const ds = used.get(a);
      l += (ds ? (ds.length > 1 ? '!!' : a.toString(16).padStart(2, '0')) : reserved(a) ? '  ' : '--') + ' ';
    }
    grid.push(l.trimEnd());
  }
  const busName = String(bus || '').trim() || 'bus';
  notes.push('Addresses are 7-bit; the byte on the wire is address << 1 | R/W. "!!" in the map marks a conflict.');
  notes.push('Unknown parts are placed only where you give an address; the alternatives column comes from the built-in list of common parts.');

  const free = range(0x08, 0x77).filter((a) => !used.has(a)).length;
  // the map for the page: every device where it sits, what it could move to, and why
  const map = {
    bus: busName, eight, scan: !!detect,
    devices: devices.map((d, i) => ({ i, name: d.name, base: d.base ?? d.name, part: d.part ?? null, addr: d.addr, line: d.line, k: d.k ?? 0, count: d.count ?? 1,
      from: d.scan ? 'scan' : d.auto ? 'auto' : 'given', allowed: d.allowed || null, how: d.how || '', status: d.status,
      conflict: (used.get(d.addr) || []).length > 1, reserved: reserved(d.addr), alts: d.alts })),
    reserved: [...range(0x00, 0x07), ...range(0x78, 0x7F)].map((a) => ({ addr: a, why: RESERVED_WHY(a) })),
  };
  return {
    map,
    values: [
      { label: 'Devices', value: devices.length },
      { label: 'Conflicts', value: conflicts, tone: conflicts ? 'bad' : 'ok', hint: conflicts ? 'devices sharing an address' : 'none' },
      { label: 'Free addresses', value: free, hint: 'of 112 (0x08–0x77)' },
    ],
    warnings,
    tables: [{ title: `Address map: ${busName}`, columns: ['Address', 'Device', 'Address from', 'Status', 'Free alternatives', 'Set by'], rows }],
    texts: [
      { title: 'Bus map', body: grid.join('\n') + '\n' },
      { title: 'C defines', lang: 'c', body: devices.map((d) => `#define I2C_ADDR_${detect ? hx(d.addr).slice(2) : (norm(d.name.replace(/\s*#(\d+)$/, 'N$1')).replace(/N(\d+)$/, '_$1').replace(/^(\d)/, '_$1') || 'DEV')} ${hx(d.addr)}  /* ${d.name}${d.how ? ', ' + d.how : ''} */`).join('\n') + '\n' },
    ],
    notes,
  };
}
