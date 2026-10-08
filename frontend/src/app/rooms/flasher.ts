/// <reference types="w3c-web-serial" />
/** Flashing and the serial monitor, in the browser (Web Serial).
 *
 *  Nothing is plugged into the server: the board is on the person's own
 *  computer, and Chrome or Edge talk to it over Web Serial. The server
 *  hands out the image - every file of the last good build and where it
 *  goes (GET /api/firmware/{id}/flash-manifest, backend/flashing.py) - and
 *  esptool-js, Espressif's own esptool in JavaScript, writes it:
 *
 *    bootloader.bin @0x1000, partitions.bin @0x8000, boot_app0.bin @0xe000,
 *    firmware.bin @0x10000 (the offsets come from the manifest)
 *
 *  at 921600 baud (115200 if that fails), each file checked by MD5 against
 *  what the flash holds afterwards, then a hard reset. The board's CH340
 *  and its two transistors (DTR/RTS -> EN/IO0) put it into the bootloader
 *  by themselves; when they cannot, the person holds BOOT and taps RST.
 *
 *  What can be tested without a board is in pure functions here (md5,
 *  fileArray, LineSplitter, webSerialSupport, quickCommands, plainError) -
 *  flasher.spec.ts.
 */

// ---------------------------------------------------------------- what the server says

export interface FlashFile { name: string; offset: number; size: number; sha256: string; md5?: string | null; url: string }
export interface FlashManifest {
  firmware: string; title: string; chip: string; board: string; mcu: string;
  build_job: string; built_at: string; version: number; files: FlashFile[];
  baud: number; fallback_baud: number; monitor_baud: number;
}
export interface FlashRecord {
  ok: boolean | null; at?: string; build_job?: string; build_at?: string | null; version?: number;
  chip?: string | null; mac?: string | null; secs?: number | null; error?: string | null;
}

export const BAUDS = [9600, 19200, 38400, 57600, 74880, 115200, 230400, 460800, 921600] as const;

// ---------------------------------------------------------------- pure logic

/** MD5 of bytes, as hex - what esptool-js compares with the flash's own
 *  MD5 after writing (it wants a function; the browser has no MD5). */
export function md5(data: Uint8Array): string {
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
             5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21,
             6, 10, 15, 21, 6, 10, 15, 21];
  const K = new Int32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) | 0;
  const n = data.length;
  const total = (((n + 8) >>> 6) + 1) << 6;
  const buf = new Uint8Array(total);
  buf.set(data);
  buf[n] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(total - 8, (n * 8) >>> 0, true);
  view.setUint32(total - 4, Math.floor(n / 0x20000000), true);
  let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
  const M = new Int32Array(16);
  for (let off = 0; off < total; off += 64) {
    for (let j = 0; j < 16; j++) M[j] = view.getInt32(off + j * 4, true);
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const tmp = d;
      d = c;
      c = b;
      const x = (a + f + K[i] + M[g]) | 0;
      b = (b + ((x << S[i]) | (x >>> (32 - S[i])))) | 0;
      a = tmp;
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
  }
  let out = '';
  for (const w of [a0, b0, c0, d0]) for (let k = 0; k < 4; k++) out += ((w >>> (8 * k)) & 0xff).toString(16).padStart(2, '0');
  return out;
}

export function hexOf(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}

/** The manifest and the downloaded files, as esptool-js's fileArray: in
 *  offset order, every file there and of the size the manifest says, and
 *  no two overlapping. Throws with what is wrong. */
export function fileArray(m: FlashManifest, blobs: Record<string, Uint8Array>): { name: string; address: number; data: Uint8Array }[] {
  if (!m.files?.length) throw new Error('the manifest lists no files');
  const rows = [...m.files].sort((x, y) => x.offset - y.offset).map(f => {
    const data = blobs[f.name];
    if (!data) throw new Error(`${f.name} was not downloaded`);
    if (data.length !== f.size) throw new Error(`${f.name}: ${data.length} bytes, the build says ${f.size}`);
    return { name: f.name, address: f.offset, data };
  });
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    if (prev.address + prev.data.length > rows[i].address)
      throw new Error(`${prev.name} runs into ${rows[i].name} (0x${rows[i].address.toString(16)})`);
  }
  return rows;
}

/** A serial stream cut into lines. Chunks end anywhere - in the middle of
 *  a line, between \r and \n - so what is left is kept for the next one.
 *  \r\n, \n and a lone \r each end a line. */
export class LineSplitter {
  private carry = '';
  private sawCr = false;

  push(text: string): string[] {
    const out: string[] = [];
    for (const ch of text) {
      if (ch === '\n') {
        if (this.sawCr) { this.sawCr = false; continue; }
        out.push(this.carry); this.carry = '';
      } else if (ch === '\r') {
        this.sawCr = true;
        out.push(this.carry); this.carry = '';
      } else {
        this.sawCr = false;
        this.carry += ch;
      }
    }
    // A board that prints without ever ending the line still shows.
    if (this.carry.length > 4096) { out.push(this.carry); this.carry = ''; }
    return out;
  }

  /** What is left, as a line of its own (on disconnect). */
  flush(): string[] {
    const rest = this.carry;
    this.carry = '';
    this.sawCr = false;
    return rest ? [rest] : [];
  }

  get pending(): string { return this.carry; }
}

export const NEEDS_COMPUTER = 'Flashing needs Chrome or Edge on a computer';

/** Whether this browser can flash: Web Serial is Chromium on a desktop, on
 *  https (or localhost). */
export function webSerialSupport(env: { serial: boolean; secure: boolean; mobile: boolean }): { ok: boolean; why: string } {
  if (env.mobile) return { ok: false, why: NEEDS_COMPUTER };
  if (!env.serial) return { ok: false, why: NEEDS_COMPUTER };
  if (!env.secure) return { ok: false, why: 'Flashing needs the site over https' };
  return { ok: true, why: '' };
}

export function browserEnv(): { serial: boolean; secure: boolean; mobile: boolean } {
  const ua = navigator.userAgent || '';
  const uaData = (navigator as unknown as { userAgentData?: { mobile?: boolean } }).userAgentData;
  const mobile = !!uaData?.mobile || /Android|iPhone|iPad|iPod|Mobile/i.test(ua)
    || (matchMedia?.('(pointer: coarse)').matches && matchMedia?.('(max-width: 768px)').matches);
  return { serial: 'serial' in navigator, secure: !!globalThis.isSecureContext, mobile: !!mobile };
}

/** The board's own console commands worth a button: those whose words the
 *  firmware's code compares against ("fan" and "on" both string literals). */
export const QUICK = ['status', 'fan on', 'fan off', 'leds test'];
export function quickCommands(source: string, candidates: readonly string[] = QUICK): string[] {
  const literals = new Set<string>();
  for (const m of source.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) {
    for (const w of m[1].toLowerCase().split(/[\s|]+/)) if (w) literals.add(w);
  }
  return candidates.filter(c => c.split(/\s+/).every(w => literals.has(w.toLowerCase())));
}

/** The last three bytes of a MAC: all the server keeps. */
export function macTail(mac: string | null | undefined): string | null {
  const pairs = (mac || '').toLowerCase().match(/[0-9a-f]{2}/g);
  return pairs && pairs.length >= 3 ? pairs.slice(-3).join(':') : null;
}

export interface Plain { text: string; hint?: string; boot?: boolean; slower?: boolean }

/** An error from Web Serial or esptool-js, in plain words with what to do. */
export function plainError(e: unknown): Plain {
  const name = (e as { name?: string })?.name ?? '';
  const msg = String((e as { message?: string })?.message ?? e ?? '');
  const low = msg.toLowerCase();
  if (name === 'NotFoundError' || /no port selected/.test(low))
    return { text: 'No port was chosen.', hint: 'Press Connect and pick the board - USB-SERIAL CH340 or USB2.0-Serial.' };
  if (name === 'InvalidStateError' || /already open|failed to open serial port|port is open/.test(low))
    return { text: 'The port is in use.', hint: 'Close the serial monitor, the Arduino IDE or another tab using it, then try again.' };
  if (name === 'NetworkError' || /device has been lost|disconnected|device lost/.test(low))
    return { text: 'The board went away.', hint: 'Check the USB cable (a charge-only cable has no data lines) and plug it in again.' };
  if (/md5 of file does not match/.test(low))
    return { text: 'Verify failed: what is in the flash is not what was sent.', hint: 'Try again - it will go at the slower speed. If it fails again, try another USB cable or port.', slower: true };
  if (/failed to connect|wrong boot mode|timeout|timed out|invalid head|no serial data/.test(low))
    return { text: 'The chip did not answer.', hint: 'Hold BOOT, tap RST (EN), let go of BOOT - then press Try again.', boot: true };
  if (/doesn't fit|does not fit/.test(low))
    return { text: 'The image does not fit in this board\'s flash.', hint: msg };
  return { text: msg || 'Something went wrong.', hint: 'Unplug the board, plug it in again and try again.' };
}

// ---------------------------------------------------------------- the port, for the session

/** The port chosen this session: Connect and the monitor use it again
 *  without asking (navigator.serial.getPorts() lists what was granted). */
let chosen: SerialPort | null = null;

export async function rememberedPort(): Promise<SerialPort | null> {
  if (chosen) return chosen;
  try {
    const ports = await navigator.serial.getPorts();
    if (ports.length === 1) chosen = ports[0];
  } catch { /* not allowed here */ }
  return chosen;
}

/** Ask for a port - only from a click (the browser insists). Every port
 *  is offered: the board's CH340 is "USB-SERIAL CH340" or "USB2.0-Serial". */
export async function choosePort(): Promise<SerialPort> {
  chosen = await navigator.serial.requestPort();
  return chosen;
}

export function portLabel(p: SerialPort | null): string {
  if (!p) return '';
  const i = p.getInfo();
  const vid = i.usbVendorId, pid = i.usbProductId;
  if (vid === 0x1a86) return 'CH340 USB-serial';
  if (vid === 0x10c4) return 'CP210x USB-serial';
  if (vid === 0x0403) return 'FTDI USB-serial';
  if (vid === 0x303a) return 'Espressif USB';
  return vid != null ? `USB ${vid.toString(16).padStart(4, '0')}:${(pid ?? 0).toString(16).padStart(4, '0')}` : 'serial port';
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Pulse EN through the auto-reset transistors: RTS asserted alone pulls
 *  EN low, both released lets it run (IO0 stays high: a normal boot). */
export async function resetBoard(port: SerialPort): Promise<void> {
  await port.setSignals({ dataTerminalReady: false, requestToSend: true });
  await sleep(120);
  await port.setSignals({ dataTerminalReady: false, requestToSend: false });
}

// ---------------------------------------------------------------- flashing

export interface FlashProgress {
  phase: 'connecting' | 'flashing' | 'verifying' | 'resetting';
  file?: number;            // index into the fileArray
  written?: number; total?: number;
  baud?: number;
}
export interface FlashResult { chip: string; description: string; mac: string | null; baud: number; secs: number }

/** Thrown when the board is not the chip the firmware is built for. */
export class WrongChip extends Error {
  constructor(public found: string, public want: string) {
    super(`This board has an ${found}; the firmware is built for ${want}.`);
  }
}

/** Write the image: connect (auto-reset into the bootloader), check the
 *  chip, write every file compressed with an MD5 check after each, hard
 *  reset. At `baud`; the caller retries at the fallback. The port is
 *  closed again at the end, either way. */
export async function flashImage(port: SerialPort, m: FlashManifest, files: { name: string; address: number; data: Uint8Array }[],
                                 baud: number, onProgress: (p: FlashProgress) => void,
                                 onLog: (line: string) => void): Promise<FlashResult> {
  const { ESPLoader, Transport } = await import('esptool-js');
  const t0 = performance.now();
  const transport = new Transport(port, false);
  const terminal = { clean: () => {}, writeLine: (s: string) => onLog(s), write: (s: string) => onLog(s) };
  const loader = new ESPLoader({ transport, baudrate: baud, romBaudrate: 115200, terminal });
  try {
    onProgress({ phase: 'connecting', baud });
    const description = await loader.main('default_reset');
    const found = loader.chip.CHIP_NAME;
    if (found !== m.chip) throw new WrongChip(found, m.chip);
    let mac: string | null = null;
    try { mac = await loader.chip.readMac(loader); } catch { /* secure download mode: no MAC */ }
    let last = -1;
    await loader.writeFlash({
      fileArray: files.map(f => ({ data: f.data, address: f.address })),
      flashMode: 'keep', flashFreq: 'keep', flashSize: 'keep', eraseAll: false, compress: true,
      reportProgress: (i, written, total) => {
        if (i !== last) last = i;
        onProgress({ phase: written >= total ? 'verifying' : 'flashing', file: i, written, total, baud });
      },
      calculateMD5Hash: (image: Uint8Array) => md5(image),
    });
    onProgress({ phase: 'resetting', baud });
    await loader.after('hard_reset');
    return { chip: found, description, mac, baud, secs: Math.round((performance.now() - t0) / 100) / 10 };
  } finally {
    try { await transport.disconnect(); } catch { /* closed already */ }
  }
}

// ---------------------------------------------------------------- the monitor

export interface SerialLine { id: number; at: number; text: string; kind: 'rx' | 'tx' | 'info' | 'error' }

/** One open port, read line by line. */
export class SerialLink {
  port: SerialPort | null = null;
  baud = 115200;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private closing = false;
  private splitter = new LineSplitter();
  private done: Promise<void> | null = null;

  constructor(private onLine: (text: string) => void, private onClosed: (why: string | null) => void) {}

  get open(): boolean { return !!this.port && !this.closing; }

  async connect(port: SerialPort, baud: number, reset = false): Promise<void> {
    await this.close();
    await port.open({ baudRate: baud, bufferSize: 64 * 1024 });
    this.port = port;
    this.baud = baud;
    this.closing = false;
    this.splitter = new LineSplitter();
    // Opening the port can leave DTR/RTS asserted; both released is "run".
    try { await port.setSignals({ dataTerminalReady: false, requestToSend: false }); } catch { /* not supported */ }
    if (reset) await resetBoard(port);
    this.done = this.pump(port);
  }

  private async pump(port: SerialPort): Promise<void> {
    const decoder = new TextDecoder();
    let why: string | null = null;
    while (port.readable && !this.closing) {
      this.reader = port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value) for (const l of this.splitter.push(decoder.decode(value, { stream: true }))) this.onLine(l);
        }
      } catch (e) {
        // A framing or parity error is survivable; a lost device is not.
        const name = (e as { name?: string })?.name;
        if (name === 'NetworkError' || name === 'NotFoundError' || !port.readable) {
          why = plainError(e).text;
          break;
        }
      } finally {
        try { this.reader.releaseLock(); } catch { /* released */ }
        this.reader = null;
      }
    }
    for (const l of this.splitter.flush()) this.onLine(l);
    if (!this.closing) {
      this.closing = true;
      try { await port.close(); } catch { /* gone */ }
      this.port = null;
      this.onClosed(why ?? 'the board went away');
    }
  }

  async send(text: string): Promise<void> {
    const port = this.port;
    if (!port?.writable) throw new Error('not connected');
    const w = port.writable.getWriter();
    try { await w.write(new TextEncoder().encode(text + '\n')); } finally { w.releaseLock(); }
  }

  async reset(): Promise<void> { if (this.port) await resetBoard(this.port); }

  async close(): Promise<void> {
    const port = this.port;
    if (!port) return;
    this.closing = true;
    try { await this.reader?.cancel(); } catch { /* closed */ }
    try { await this.done; } catch { /* ended */ }
    try { await port.close(); } catch { /* closed */ }
    this.port = null;
    this.done = null;
    this.onClosed(null);
  }
}
