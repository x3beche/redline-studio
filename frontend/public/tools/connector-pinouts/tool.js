// Connector pinout library: pin maps of common board connectors, filtered by
// connector and by a text search over pins, signals and notes.
// Each map is transcribed from the standard or the de-facto owner's document
// named in its `src`. Pin 1 and the view (looking into the receptacle vs at
// the header) are stated per connector, because that is where mistakes happen.

const CONNECTORS = {
  usbc: {
    name: 'USB Type-C receptacle (24 pins, full-featured)', pitch: '0.5 mm, two rows A/B',
    view: 'Receptacle front view: row A runs A1…A12 and row B runs the other way, so B12 sits opposite A1 (that is what makes the plug reversible).',
    src: 'USB Type-C Cable and Connector Specification R2.x, table 3-4',
    pins: [
      ['A1', 'GND', 'Ground'], ['A2', 'TX1+', 'SuperSpeed TX pair 1 +'], ['A3', 'TX1-', 'SuperSpeed TX pair 1 -'], ['A4', 'VBUS', 'Bus power'],
      ['A5', 'CC1', 'Configuration channel 1'], ['A6', 'D+', 'USB 2.0 data +'], ['A7', 'D-', 'USB 2.0 data -'], ['A8', 'SBU1', 'Sideband use 1'],
      ['A9', 'VBUS', 'Bus power'], ['A10', 'RX2-', 'SuperSpeed RX pair 2 -'], ['A11', 'RX2+', 'SuperSpeed RX pair 2 +'], ['A12', 'GND', 'Ground'],
      ['B1', 'GND', 'Ground'], ['B2', 'TX2+', 'SuperSpeed TX pair 2 +'], ['B3', 'TX2-', 'SuperSpeed TX pair 2 -'], ['B4', 'VBUS', 'Bus power'],
      ['B5', 'CC2', 'Configuration channel 2'], ['B6', 'D+', 'USB 2.0 data + (tie to A6)'], ['B7', 'D-', 'USB 2.0 data - (tie to A7)'], ['B8', 'SBU2', 'Sideband use 2'],
      ['B9', 'VBUS', 'Bus power'], ['B10', 'RX1-', 'SuperSpeed RX pair 1 -'], ['B11', 'RX1+', 'SuperSpeed RX pair 1 +'], ['B12', 'GND', 'Ground'],
    ],
    notes: ['A device (sink) needs its own 5.1 kΩ Rd from CC1 and from CC2 to GND, one per pin; sharing one resistor breaks detection by chargers.',
      'Tie A6 to B6 and A7 to B7 so the plug works both ways round.'],
  },
  usbc2: {
    name: 'USB Type-C receptacle, USB 2.0 only (16 pins)', pitch: '0.5 mm, two rows A/B',
    view: 'Receptacle, looking into the opening. The SuperSpeed pins are absent.',
    src: 'USB Type-C Specification R2.x, section 3.2 (USB 2.0 Type-C receptacle)',
    pins: [
      ['A1/B12', 'GND', 'Ground'], ['A4/B9', 'VBUS', 'Bus power'], ['A5', 'CC1', '5.1 kΩ to GND for a sink'], ['A6', 'D+', 'USB 2.0 data +'],
      ['A7', 'D-', 'USB 2.0 data -'], ['A8', 'SBU1', 'Often not connected'], ['B1/A12', 'GND', 'Ground'], ['B4/A9', 'VBUS', 'Bus power'],
      ['B5', 'CC2', '5.1 kΩ to GND for a sink (separate resistor)'], ['B6', 'D+', 'Tie to A6'], ['B7', 'D-', 'Tie to A7'], ['B8', 'SBU2', 'Often not connected'],
    ],
    notes: ['Two separate 5.1 kΩ Rd resistors, one on each CC pin.'],
  },
  usba: {
    name: 'USB Type-A (USB 2.0 and 3.x)', pitch: '2.5 mm (USB 2.0 contacts)',
    view: 'Receptacle, looking into it with the contacts on top: pin 1 at the left.',
    src: 'USB 2.0 Specification table 6-1; USB 3.2 Specification table 5-1',
    pins: [
      ['1', 'VBUS', '+5 V'], ['2', 'D-', 'USB 2.0 data -'], ['3', 'D+', 'USB 2.0 data +'], ['4', 'GND', 'Ground'],
      ['5', 'SSRX-', 'USB 3.x only: SuperSpeed receive -'], ['6', 'SSRX+', 'USB 3.x only: SuperSpeed receive +'], ['7', 'GND_DRAIN', 'USB 3.x only: signal ground'],
      ['8', 'SSTX-', 'USB 3.x only: SuperSpeed transmit -'], ['9', 'SSTX+', 'USB 3.x only: SuperSpeed transmit +'],
    ],
    notes: ['On a host receptacle SSRX is the host receive pair; the names are from the side the connector is on.'],
  },
  usbmicro: {
    name: 'USB Micro-B / Mini-B (5 pins)', pitch: '0.65 mm (Micro-B), 0.8 mm (Mini-B)',
    view: 'Receptacle, looking into it with the wide side up: pin 1 at the left.',
    src: 'USB 2.0 Micro-USB Cables and Connectors Specification rev. 1.01, table 4-1',
    pins: [['1', 'VBUS', '+5 V'], ['2', 'D-', 'Data -'], ['3', 'D+', 'Data +'], ['4', 'ID', 'OTG ID: GND on an A-plug, open on a B-plug; leave open on a device'], ['5', 'GND', 'Ground']],
    notes: ['Shell to chassis or to GND through an RC or ferrite, not left floating.'],
  },
  swd10: {
    name: 'ARM Cortex Debug, 10-pin 1.27 mm (SWD / JTAG)', pitch: '1.27 mm, 2×5',
    view: 'Header on the target, top view. Odd pins in one row; pin 7 is the key (removed).',
    src: 'ARM CoreSight / Keil "Cortex Debug connector (10-pin)" and ARM DUI 0499',
    pins: [
      ['1', 'VTref', 'Target I/O voltage (sense for the probe)'], ['2', 'SWDIO / TMS', 'SWD data / JTAG mode select'], ['3', 'GND', 'Ground'],
      ['4', 'SWCLK / TCK', 'SWD clock / JTAG clock'], ['5', 'GND', 'Ground'], ['6', 'SWO / TDO', 'Trace output / JTAG data out'],
      ['7', 'KEY', 'No pin (keying)'], ['8', 'NC / TDI', 'JTAG data in (not used in SWD)'], ['9', 'GNDDetect', 'Tie to GND'], ['10', 'nRESET', 'Target reset, active low'],
    ],
    notes: ['Put a 10 kΩ pull-up on nRESET only if the MCU has none; SWDIO often wants 10–100 kΩ pull-up per the MCU datasheet.'],
  },
  jtag20: {
    name: 'ARM JTAG 20-pin 2.54 mm (ST-LINK, J-Link)', pitch: '2.54 mm, 2×10, boxed',
    view: 'Header on the target, top view; pin 1 by the key notch side marking.',
    src: 'ARM Multi-ICE / RealView ICE 20-pin JTAG interface (ARM DUI 0517) and SEGGER UM08001',
    pins: [
      ['1', 'VTref', 'Target I/O voltage'], ['2', 'NC / Vsupply', 'Not connected (some probes: supply)'], ['3', 'nTRST', 'JTAG reset, active low'], ['4', 'GND', 'Ground'],
      ['5', 'TDI', 'JTAG data in'], ['6', 'GND', 'Ground'], ['7', 'TMS / SWDIO', 'Mode select / SWD data'], ['8', 'GND', 'Ground'],
      ['9', 'TCK / SWCLK', 'Clock'], ['10', 'GND', 'Ground'], ['11', 'RTCK', 'Returned clock (adaptive clocking)'], ['12', 'GND', 'Ground'],
      ['13', 'TDO / SWO', 'JTAG data out / trace output'], ['14', 'GND', 'Ground'], ['15', 'nSRST', 'System reset, active low'], ['16', 'GND', 'Ground'],
      ['17', 'DBGRQ', 'Not used (NC)'], ['18', 'GND', 'Ground'], ['19', 'DBGACK / 5V', 'NC, or 5 V supply on some probes'], ['20', 'GND', 'Ground'],
    ],
    notes: ['Keep pin 19 off your 3.3 V rail: some probes drive 5 V on it.'],
  },
  tc2030: {
    name: 'Tag-Connect TC2030 (6-pin, Cortex SWD mapping)', pitch: 'footprint only, 1.27 mm pads',
    view: 'Pads on the target, top view, as in the Tag-Connect footprint drawing.',
    src: 'Tag-Connect TC2030-CTX datasheet (ARM Cortex 10-pin adapter mapping)',
    pins: [['1', 'VCC', 'Target voltage (VTref)'], ['2', 'SWDIO', 'SWD data'], ['3', 'nRESET', 'Reset, active low'], ['4', 'SWCLK', 'SWD clock'], ['5', 'GND', 'Ground'], ['6', 'SWO', 'Trace output']],
    notes: ['Other TC2030 cables (AVR ISP, Microchip ICSP) map pins differently: check the cable you own.'],
  },
  avrisp: {
    name: 'AVR ISP 6-pin 2.54 mm', pitch: '2.54 mm, 2×3',
    view: 'Header on the target, top view.',
    src: 'Microchip (Atmel) AVR910 / Atmel-ICE user guide, ISP connector',
    pins: [['1', 'MISO', 'Data from target'], ['2', 'VCC', 'Target supply (sense)'], ['3', 'SCK', 'Clock'], ['4', 'MOSI', 'Data to target'], ['5', 'RESET', 'Reset, active low'], ['6', 'GND', 'Ground']],
    notes: [],
  },
  ftdi6: {
    name: 'FTDI TTL-232R serial cable, 6-pin 2.54 mm', pitch: '2.54 mm, 1×6',
    view: 'Pin 1 is the black wire (GND).',
    src: 'FTDI DS_TTL-232R_CABLES, table 2.1',
    pins: [['1', 'GND', 'Black'], ['2', 'CTS#', 'Brown, input to the cable'], ['3', 'VCC', 'Red, 5 V from USB (3.3 V on -3V3 cables)'], ['4', 'TXD', 'Orange, output from the cable: goes to the target RX'], ['5', 'RXD', 'Yellow, input to the cable: from the target TX'], ['6', 'RTS#', 'Green, output from the cable (Arduino auto-reset via 100 nF)']],
    notes: ['Names are from the cable side: cable TXD connects to your MCU RX.'],
  },
  qwiic: {
    name: 'Qwiic / STEMMA QT (JST SH 4-pin, 1.0 mm)', pitch: '1.0 mm, JST SH',
    view: 'Pin 1 is the black wire.',
    src: 'SparkFun Qwiic connect system specification; Adafruit STEMMA QT',
    pins: [['1', 'GND', 'Black'], ['2', '3.3V', 'Red'], ['3', 'SDA', 'Blue'], ['4', 'SCL', 'Yellow']],
    notes: ['I2C at 3.3 V only; boards carry their own pull-ups, often with a jumper to cut them.'],
  },
  grove: {
    name: 'Seeed Grove (4-pin 2.0 mm)', pitch: '2.0 mm',
    view: 'Pin 1 is the yellow wire.',
    src: 'Seeed Studio Grove system documentation',
    pins: [['1', 'SCL / D0 / RX', 'Yellow: I2C clock, digital D0, or UART RX'], ['2', 'SDA / D1 / TX', 'White: I2C data, digital D1, or UART TX'], ['3', 'VCC', 'Red: 3.3 V or 5 V'], ['4', 'GND', 'Black']],
    notes: ['The signal on pins 1 and 2 depends on the port type (I2C, digital, analog, UART).'],
  },
  rpi40: {
    name: 'Raspberry Pi 40-pin GPIO header (IDC 2×20)', pitch: '2.54 mm, 2×20',
    view: 'Top view with the header at the top edge: pin 1 (square pad) nearest the corner; odd pins on the inner row.',
    src: 'Raspberry Pi documentation, "GPIO and the 40-pin header"',
    pins: [
      ['1', '3V3', 'Power'], ['2', '5V', 'Power'], ['3', 'GPIO2', 'SDA1 (1.8 kΩ pull-up on board)'], ['4', '5V', 'Power'],
      ['5', 'GPIO3', 'SCL1 (1.8 kΩ pull-up on board)'], ['6', 'GND', 'Ground'], ['7', 'GPIO4', 'GPCLK0'], ['8', 'GPIO14', 'UART TXD'],
      ['9', 'GND', 'Ground'], ['10', 'GPIO15', 'UART RXD'], ['11', 'GPIO17', ''], ['12', 'GPIO18', 'PCM_CLK / PWM0'],
      ['13', 'GPIO27', ''], ['14', 'GND', 'Ground'], ['15', 'GPIO22', ''], ['16', 'GPIO23', ''],
      ['17', '3V3', 'Power'], ['18', 'GPIO24', ''], ['19', 'GPIO10', 'SPI0 MOSI'], ['20', 'GND', 'Ground'],
      ['21', 'GPIO9', 'SPI0 MISO'], ['22', 'GPIO25', ''], ['23', 'GPIO11', 'SPI0 SCLK'], ['24', 'GPIO8', 'SPI0 CE0'],
      ['25', 'GND', 'Ground'], ['26', 'GPIO7', 'SPI0 CE1'], ['27', 'GPIO0', 'ID_SD (HAT EEPROM I2C)'], ['28', 'GPIO1', 'ID_SC (HAT EEPROM I2C)'],
      ['29', 'GPIO5', ''], ['30', 'GND', 'Ground'], ['31', 'GPIO6', ''], ['32', 'GPIO12', 'PWM0'],
      ['33', 'GPIO13', 'PWM1'], ['34', 'GND', 'Ground'], ['35', 'GPIO19', 'PCM_FS / SPI1 MISO'], ['36', 'GPIO16', 'SPI1 CE2'],
      ['37', 'GPIO26', ''], ['38', 'GPIO20', 'PCM_DIN / SPI1 MOSI'], ['39', 'GND', 'Ground'], ['40', 'GPIO21', 'PCM_DOUT / SPI1 SCLK'],
    ],
    notes: ['All GPIO are 3.3 V and not 5 V tolerant.', 'Pins 27/28 are reserved for the HAT ID EEPROM.'],
  },
  pmod: {
    name: 'Digilent Pmod 12-pin (type 2A, SPI)', pitch: '2.54 mm, 2×6 right-angle',
    view: 'Host receptacle, looking into it: pins 1–6 on the top row, 7–12 below.',
    src: 'Digilent Pmod Interface Specification v1.3.1',
    pins: [
      ['1', 'CS', 'SPI chip select (type 2A)'], ['2', 'MOSI', 'SPI data to the module'], ['3', 'MISO', 'SPI data from the module'], ['4', 'SCK', 'SPI clock'],
      ['5', 'GND', 'Ground'], ['6', 'VCC', '3.3 V'], ['7', 'INT', 'Interrupt (type 2A)'], ['8', 'RESET', 'Reset (type 2A)'],
      ['9', 'I/O', 'Not specified'], ['10', 'I/O', 'Not specified'], ['11', 'GND', 'Ground'], ['12', 'VCC', '3.3 V'],
    ],
    notes: ['Other types (GPIO, UART type 3/4, I2C type 6) reuse pins 1–4 and 7–10 differently.'],
  },
  rj45: {
    name: 'RJ45 Ethernet (T568A / T568B)', pitch: '1.02 mm, 8P8C',
    view: 'Plug with the latch down, contacts facing you: pin 1 at the left.',
    src: 'TIA-568 (T568A/B wire colours); IEEE 802.3 clauses 25 and 40 (pair use)',
    pins: [
      ['1', 'TX+ / BI_DA+', 'T568B white-orange; T568A white-green'], ['2', 'TX- / BI_DA-', 'T568B orange; T568A green'],
      ['3', 'RX+ / BI_DB+', 'T568B white-green; T568A white-orange'], ['4', 'BI_DC+', 'Blue (1000BASE-T; unused in 10/100)'],
      ['5', 'BI_DC-', 'White-blue (1000BASE-T)'], ['6', 'RX- / BI_DB-', 'T568B green; T568A orange'],
      ['7', 'BI_DD+', 'White-brown (1000BASE-T)'], ['8', 'BI_DD-', 'Brown (1000BASE-T)'],
    ],
    notes: ['TX/RX names are for an MDI device (NIC); a switch port (MDI-X) swaps them. Auto-MDIX PHYs do not care.',
      'Pairs: 1-2, 3-6, 4-5, 7-8. Route each as a 100 Ω differential pair.'],
  },
  db9rs232: {
    name: 'DE-9 RS-232 (DTE, PC side)', pitch: 'D-sub shell size E',
    view: 'Male connector on the PC, looking at the pins: pin 1 top left, 1–5 on the wide row.',
    src: 'TIA-574 (EIA-232 on a 9-pin connector)',
    pins: [['1', 'DCD', 'Data carrier detect, in'], ['2', 'RXD', 'Receive data, in'], ['3', 'TXD', 'Transmit data, out'], ['4', 'DTR', 'Data terminal ready, out'], ['5', 'GND', 'Signal ground'], ['6', 'DSR', 'Data set ready, in'], ['7', 'RTS', 'Request to send, out'], ['8', 'CTS', 'Clear to send, in'], ['9', 'RI', 'Ring indicator, in']],
    notes: ['A DCE (modem) swaps the directions; a null-modem cable crosses 2-3, 7-8 and 4-6.'],
  },
  db9can: {
    name: 'DE-9 CAN (CiA 303-1)', pitch: 'D-sub shell size E',
    view: 'Male connector on the device, looking at the pins.',
    src: 'CiA 303-1 Cabling and connector pin assignment',
    pins: [['1', 'Reserved', ''], ['2', 'CAN_L', 'Bus low'], ['3', 'CAN_GND', 'Ground'], ['4', 'Reserved', ''], ['5', 'CAN_SHLD', 'Optional shield'], ['6', 'GND', 'Optional ground'], ['7', 'CAN_H', 'Bus high'], ['8', 'Reserved', ''], ['9', 'CAN_V+', 'Optional supply']],
    notes: ['120 Ω termination at each end of the bus, not on every node.'],
  },
  hdmi: {
    name: 'HDMI Type A (19 pins)', pitch: '0.5 mm, staggered',
    view: 'Two staggered rows: odd pins on one row, even pins on the other. Check where pin 1 is on the drawing of the exact receptacle.',
    src: 'HDMI Specification 1.4, section 4.1.8 (Type A pin assignment)',
    pins: [
      ['1', 'TMDS Data2+', ''], ['2', 'TMDS Data2 Shield', 'Ground'], ['3', 'TMDS Data2-', ''], ['4', 'TMDS Data1+', ''], ['5', 'TMDS Data1 Shield', 'Ground'],
      ['6', 'TMDS Data1-', ''], ['7', 'TMDS Data0+', ''], ['8', 'TMDS Data0 Shield', 'Ground'], ['9', 'TMDS Data0-', ''], ['10', 'TMDS Clock+', ''],
      ['11', 'TMDS Clock Shield', 'Ground'], ['12', 'TMDS Clock-', ''], ['13', 'CEC', 'Consumer electronics control'], ['14', 'Reserved / HEAC+', 'Utility'],
      ['15', 'SCL', 'DDC clock (EDID)'], ['16', 'SDA', 'DDC data (EDID)'], ['17', 'DDC/CEC GND', 'Ground'], ['18', '+5V', 'Power from the source, ≥ 55 mA'], ['19', 'HPD', 'Hot plug detect'],
    ],
    notes: ['DDC lines need pull-ups (source: 1.5–2 kΩ to 5 V) and usually a level shifter to the SoC.'],
  },
  microsd: {
    name: 'microSD card (SD and SPI mode)', pitch: '1.1 mm',
    view: 'Card contacts facing you, pins numbered from the left.',
    src: 'SD Association Physical Layer Simplified Specification, microSD pin assignment',
    pins: [['1', 'DAT2', 'SD: data 2; SPI: not used'], ['2', 'CD/DAT3', 'SD: data 3 / card detect; SPI: CS'], ['3', 'CMD', 'SD: command; SPI: DI (MOSI)'], ['4', 'VDD', '2.7–3.6 V'], ['5', 'CLK', 'Clock (SCLK)'], ['6', 'VSS', 'Ground'], ['7', 'DAT0', 'SD: data 0; SPI: DO (MISO)'], ['8', 'DAT1', 'SD: data 1; SPI: not used']],
    notes: ['10–100 kΩ pull-ups on CMD and DAT0–3 (the card has a 50 kΩ on DAT3).'],
  },
};

// Generic families whose pin numbers carry no standard meaning: answer the
// question honestly instead of inventing a pinout.
const GENERIC = /\b(jst|ph|xh|zh|gh|sh|idc|molex|picoblade|micro-?fit|dupont|header)\b/i;

export function run({ connector, filter }) {
  const warnings = [];
  const f = String(filter || '').trim().toLowerCase();
  const ids = connector && connector !== 'all' ? [connector] : Object.keys(CONNECTORS);
  const known = ids.filter((id) => CONNECTORS[id]);
  if (!known.length) return { warnings: [`Unknown connector "${connector}". Pick one from the list or "all".`] };
  const multi = known.length > 1;
  const rows = [];
  for (const id of known) {
    const c = CONNECTORS[id];
    for (const [pin, sig, fn] of c.pins) {
      const hay = `${pin} ${sig} ${fn} ${c.name}`.toLowerCase();
      if (f && !hay.includes(f)) continue;
      rows.push(multi ? [c.name, pin, sig, fn] : [pin, sig, fn]);
    }
  }
  const notes = [];
  const values = [];
  if (!multi) {
    const c = CONNECTORS[known[0]];
    values.push(
      { label: 'Pins', value: String(c.pins.length), hint: c.pitch },
      { label: 'Matching', value: `${rows.length} of ${c.pins.length}`, hint: f ? `filter "${filter}"` : 'no filter' },
    );
    notes.push(`View: ${c.view}`, ...c.notes, `Source: ${c.src}.`);
  } else {
    values.push({ label: 'Pins matching', value: String(rows.length), hint: ((n) => `in ${n} connector${n === 1 ? '' : 's'}`)(new Set(rows.map((r) => r[0])).size) });
    if (!f) notes.push('Showing every connector. Type a signal name (e.g. SWDIO, VBUS, SDA) in the filter to search across them.');
  }
  if (f && !rows.length) warnings.push(`No pin matches "${filter}"${multi ? '' : ' on this connector'}. Try a shorter name (e.g. "sda" instead of "i2c sda") or "All connectors".`);
  if (f && GENERIC.test(f)) warnings.push('JST, Molex, IDC and plain pin headers are numbered housings, not pinouts: pin 1 is marked on the housing and the signals are whatever your schematic says. Standard maps that use them are listed here (Qwiic on JST SH, Raspberry Pi on IDC 2×20, ARM debug on 1.27 mm headers).');
  notes.push('Always check pin 1 against the footprint drawing of the exact part: a mirrored footprint (top vs bottom, plug vs receptacle) is the most common connector error.');
  return {
    values,
    warnings,
    tables: [{ title: multi ? 'Pins' : CONNECTORS[known[0]].name, columns: multi ? ['Connector', 'Pin', 'Signal', 'Function / notes'] : ['Pin', 'Signal', 'Function / notes'], rows }],
    notes,
  };
}
