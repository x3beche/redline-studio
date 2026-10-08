import { FlashManifest, LineSplitter, NEEDS_COMPUTER, fileArray, macTail, md5, plainError, quickCommands,
         webSerialSupport } from './flasher';

/** What flashing does that needs no board (flasher.ts): the MD5 esptool-js
 *  checks the flash against, the manifest turned into esptool-js's file
 *  list, a serial stream cut into lines, and who may flash at all. */
const enc = (s: string) => new TextEncoder().encode(s);

describe('md5', () => {
  it('matches the reference digests', () => {
    expect(md5(enc(''))).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5(enc('abc'))).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5(enc('The quick brown fox jumps over the lazy dog'))).toBe('9e107d9d372bb6826bd81d3542a419d6');
    // 55, 56 and 64 bytes: where the padding spills into a second block
    expect(md5(enc('a'.repeat(55)))).toBe('ef1772b6dff9a122358552954ad0df65');
    expect(md5(enc('a'.repeat(56)))).toBe('3b0c8ac703f828b04c6c197006d17218');
    expect(md5(enc('a'.repeat(64)))).toBe('014842d480b571495a4a0363793f7367');
  });
});

describe('fileArray', () => {
  const m = (files: [string, number, number][]): FlashManifest => ({
    firmware: 'f', title: 'U2 ESP32', chip: 'ESP32', board: 'b', mcu: 'U2', build_job: 'j', built_at: '',
    version: 1, baud: 921600, fallback_baud: 115200, monitor_baud: 115200,
    files: files.map(([name, offset, size]) => ({ name, offset, size, sha256: '', url: '' })),
  });
  const blob = (n: number) => new Uint8Array(n);

  it('puts the four files at their offsets, in order', () => {
    const got = fileArray(m([['firmware.bin', 0x10000, 300], ['bootloader.bin', 0x1000, 100],
                             ['partitions.bin', 0x8000, 3072], ['boot_app0.bin', 0xe000, 8192]]),
                          { 'firmware.bin': blob(300), 'bootloader.bin': blob(100), 'partitions.bin': blob(3072),
                            'boot_app0.bin': blob(8192) });
    expect(got.map(f => [f.name, f.address])).toEqual([
      ['bootloader.bin', 0x1000], ['partitions.bin', 0x8000], ['boot_app0.bin', 0xe000], ['firmware.bin', 0x10000]]);
  });

  it('refuses a missing file, a wrong size and an overlap', () => {
    expect(() => fileArray(m([['a.bin', 0, 4]]), {})).toThrowError(/not downloaded/);
    expect(() => fileArray(m([['a.bin', 0, 4]]), { 'a.bin': blob(3) })).toThrowError(/3 bytes/);
    expect(() => fileArray(m([['a.bin', 0, 0x2000], ['b.bin', 0x1000, 4]]), { 'a.bin': blob(0x2000), 'b.bin': blob(4) }))
      .toThrowError(/runs into b.bin/);
  });
});

describe('LineSplitter', () => {
  it('cuts lines anywhere a chunk ends, \\r\\n split across chunks too', () => {
    const s = new LineSplitter();
    expect(s.push('[sta')).toEqual([]);
    expect(s.push('tus] fan on\r')).toEqual(['[status] fan on']);
    expect(s.push('\n[fan] off\nbo')).toEqual(['[fan] off']);
    expect(s.pending).toBe('bo');
    expect(s.push('ot\r\n\r\n')).toEqual(['boot', '']);
    expect(s.push('tail')).toEqual([]);
    expect(s.flush()).toEqual(['tail']);
    expect(s.flush()).toEqual([]);
  });
});

describe('who can flash', () => {
  it('is Chromium on a computer, over https', () => {
    expect(webSerialSupport({ serial: true, secure: true, mobile: false }).ok).toBeTrue();
    expect(webSerialSupport({ serial: false, secure: true, mobile: false }).why).toBe(NEEDS_COMPUTER);
    expect(webSerialSupport({ serial: true, secure: true, mobile: true }).why).toBe(NEEDS_COMPUTER);
    expect(webSerialSupport({ serial: true, secure: false, mobile: false }).ok).toBeFalse();
  });
});

describe('the console', () => {
  it('offers the commands the code compares against', () => {
    const src = 'if (!strcmp(cmd, "fan") && !strcmp(arg, "on")) ...; if (!strcmp(arg, "off")); ' +
                'if (!strcmp(cmd, "leds") && !strcmp(arg, "test")); else if (!strcmp(cmd, "status"))';
    expect(quickCommands(src)).toEqual(['status', 'fan on', 'fan off', 'leds test']);
    expect(quickCommands('Serial.println("up");')).toEqual([]);
  });

  it('keeps three bytes of the MAC and says errors plainly', () => {
    expect(macTail('24:6f:28:aa:bb:cc')).toBe('aa:bb:cc');
    expect(macTail('')).toBeNull();
    expect(plainError(new Error('Failed to connect with the device')).boot).toBeTrue();
    expect(plainError({ name: 'InvalidStateError', message: 'The port is already open.' }).text).toBe('The port is in use.');
    expect(plainError(new Error('MD5 of file does not match data in flash!')).slower).toBeTrue();
  });
});
