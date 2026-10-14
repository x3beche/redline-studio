import { build, enter, isStep, parse } from './nav-url';

/** The address and what is on screen (nav-url.ts): every place there and back, the old
 *  ?ws= links read as the same place, and which changes are a step in the history. */
describe('nav-url', () => {
  const q = (o: Record<string, string>) => new URLSearchParams(o);
  const obj = (p: URLSearchParams) => Object.fromEntries([...p.entries()].sort());
  const read = (href: string) => { const u = new URL(href, 'http://x'); return obj(parse(u.pathname, u.search)); };

  const places: [Record<string, string>, string][] = [
    [{ ws: 'cad' }, '/3d'],
    [{ ws: 'cad', model: 'iot/box' }, '/3d/iot/box'],
    [{ ws: 'cad', model: 'stand', rev: 'r1' }, '/3d/stand?rev=r1'],
    [{ ws: 'pcb', board: 'ctl', tab: 'layout' }, '/pcb/ctl?tab=layout'],
    [{ ws: 'firmware', fw: 'fan' }, '/firmware/fan'],
    [{ ws: 'notes', note: '65a1' }, '/notes/65a1'],
    [{ ws: 'taste', palette: 'p1' }, '/taste/p1'],
    [{ ws: 'taste', run: 'j1' }, '/taste/run/j1'],
    [{ ws: 'mfr' }, '/parts'],
    [{ ws: 'mfr', sub: 'stock', sq: 'm3' }, '/parts/stock?sq=m3'],
    [{ ws: 'mfr', sub: 'orphans' }, '/parts/orphans'],
    [{ ws: 'mfr', m: 'lcsc' }, '/parts/lcsc'],
    [{ ws: 'mfr', m: 'lcsc', p: 'C123', pm: 'lcsc' }, '/parts/lcsc/C123'],
    [{ ws: 'mfr', m: 'acme', p: 'C9', pm: 'lcsc' }, '/parts/acme/product/lcsc/C9'],
    [{ ws: 'mfr', p: 'x 1', pm: 'acme' }, '/parts/product/acme/x%201'],
    [{ ws: 'mfr', sub: 'stock', p: 'C1', pm: 'lcsc' }, '/parts/stock/product/lcsc/C1'],
    [{ ws: 'mfr', run: 'j2' }, '/parts/run/j2'],
    [{ ws: 'mfr', q: 'nut', cat: 'M3', view: 'table' }, '/parts?q=nut&cat=M3&view=table'],
    [{ ws: 'commandcode' }, '/chat'],
    [{ ws: 'commandcode', chat: 'k1' }, '/chat/k1'],
    [{ ws: 'commandcode', thread: 'pcb' }, '/chat/thread/pcb'],
    [{ ws: 'commandcode', dm: 'd1' }, '/dm/d1'],
    [{ ws: 'files' }, '/files'],
    [{ ws: 'files', dir: 'f1', file: 'a2' }, '/files/mine/f1?file=a2'],
    [{ ws: 'files', dir: 'v:projects' }, '/files/app/projects'],
    [{ ws: 'files', dir: 'v:projects:iot/box' }, '/files/app/projects:iot/box'],
    [{ ws: 'files', dir: '~storage' }, '/files/storage'],
    [{ ws: 'files', dir: '~trash' }, '/files/deleted'],
    [{ ws: 'tools', tool: 'crc-calc' }, '/basic-tools/crc-calc'],
    [{ ws: 'settings', section: 'appearance' }, '/settings/appearance'],
    [{ ws: 'analyze', range: '30d', project: 'iot-fan' }, '/analytics?range=30d&project=iot-fan'],
    [{ ws: 'wiki' }, '/wiki'],
    [{ ws: 'wiki', project: 'iot-fan' }, '/wiki/iot-fan'],
    [{ ws: 'wiki', project: 'iot-fan', page: 'open-questions' }, '/wiki/iot-fan/open-questions'],
    [{ ws: 'cad', theme: 'light' }, '/3d?theme=light'],
  ];
  for (const [v, href] of places) {
    it(`writes ${JSON.stringify(v)} as ${href}, and reads it back`, () => {
      expect(build(q(v))).toBe(href);
      expect(read(href)).toEqual(obj(q(v)));
    });
  }

  it('reads the old addresses as the same places', () => {
    expect(build(parse('/', '?ws=pcb&board=ctl'))).toBe('/pcb/ctl');
    expect(build(parse('/', '?ws=chat&chat=k1'))).toBe('/chat/k1');
    expect(build(parse('/', '?ws=chat&thread=cad'))).toBe('/chat/thread/cad');
    expect(build(parse('/', '?ws=commandcode'))).toBe('/chat');
    expect(build(parse('/', '?ws=catalog&m=m1&run=j1'))).toBe('/parts/run/j1');
    expect(build(parse('/', '?ws=catalog&m=lcsc&p=C1&pm=lcsc'))).toBe('/parts/lcsc/C1');
    expect(build(parse('/', '?ws=supply'))).toBe('/parts');
    expect(build(parse('/', '?ws=inventory&item=i1'))).toBe('/parts/stock?item=i1');
    expect(build(parse('/', '?ws=firmware&fw=fan'))).toBe('/firmware/fan');
    expect(build(parse('/', '?ws=notes&rev=r1'))).toBe('/notes?rev=r1');
    expect(build(parse('/', '?ws=analyze&range=7d'))).toBe('/analytics?range=7d');
    expect(build(parse('/', '?ws=tools'))).toBe('/basic-tools');
    expect(build(parse('/', '?dm=d1'))).toBe('/dm/d1');
  });

  it('takes a link with a model or a revision and no room for the 3D room (Telegram, render.py)', () => {
    expect(build(parse('/', '?model=iot/box&rev=r1'))).toBe('/3d/iot/box?rev=r1');
    expect(build(parse('/', '?rev=r1&shot=1028x690'))).toBe('/3d?rev=r1&shot=1028x690');
  });

  it('leaves an address that is not the app\'s alone', () => {
    expect(read('/?signin=1')).toEqual({ signin: '1' });
    expect(read('/elsewhere/x')).toEqual({});
    expect(build(q({ reset: 'k' }))).toBe('/?reset=k');
  });

  it('keeps an id\'s odd characters in one segment', () => {
    const v = q({ ws: 'notes', note: 'a/b c?d' });
    expect(build(v)).toBe('/notes/a%2Fb%20c%3Fd');
    expect(read(build(v))).toEqual(obj(v));
  });

  it('leaves the other rooms\' values behind when a room is opened', () => {
    const v = enter(q({ ws: 'mfr', m: 'lcsc', q: 'nut', run: 'j1', theme: 'light' }), 'taste');
    expect(obj(v)).toEqual({ theme: 'light', ws: 'taste' });
    expect(obj(enter(q({ ws: 'mfr', m: 'lcsc' }), 'mfr'))).toEqual({ m: 'lcsc', ws: 'mfr' });
  });

  it('makes a step of another room or another place, not of a filter', () => {
    expect(isStep(q({ ws: 'cad', model: 'a' }), q({ ws: 'pcb' }))).toBeTrue();
    expect(isStep(q({ ws: 'cad', model: 'a' }), q({ ws: 'cad', model: 'b' }))).toBeTrue();
    expect(isStep(q({ ws: 'mfr' }), q({ ws: 'mfr', m: 'lcsc' }))).toBeTrue();
    expect(isStep(q({ ws: 'mfr', m: 'lcsc' }), q({ ws: 'mfr', m: 'lcsc', q: 'nut' }))).toBeFalse();
    expect(isStep(q({ ws: 'mfr', m: 'lcsc' }), q({ ws: 'mfr', m: 'lcsc', p: 'C1', pm: 'lcsc' }))).toBeFalse();
    expect(isStep(q({ ws: 'files' }), q({ ws: 'files', dir: 'f1' }))).toBeTrue();
  });

  it('lets a room fill in its first choice without a step', () => {
    expect(isStep(q({ ws: 'notes' }), q({ ws: 'notes', note: 'n1' }))).toBeFalse();
    expect(isStep(q({ ws: 'cad' }), q({ ws: 'cad', model: 'a' }))).toBeFalse();
    expect(isStep(q({ ws: 'notes', note: 'n1' }), q({ ws: 'notes' }))).toBeTrue();
    // Nothing named yet (the first write after a load): never a step.
    expect(isStep(q({}), q({ ws: 'notes' }))).toBeFalse();
  });
});
