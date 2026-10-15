import { seedLine } from './agent-status';

/** The seed's one line (agent-status.ts): Claude Code by default, OpenCode and the
 *  service as the seed's own options, on both platforms. */
describe('seedLine', () => {
  const seed = 'https://github.com/x3beche/redline-agent-seed', api = 'https://wb.example.com';

  it('is the plain line by default', () => {
    expect(seedLine(seed, api, 'unix', 'rlat_x')).toBe(
      'git clone https://github.com/x3beche/redline-agent-seed; cd redline-agent-seed && ./start.sh --api https://wb.example.com --token rlat_x');
    expect(seedLine(seed, api, 'windows')).toContain('-Token <your-token>');
    expect(seedLine(seed, api, 'unix', null, { runner: 'claude' })).not.toContain('--runner');
  });

  it('adds the runner and the service', () => {
    expect(seedLine(seed, api, 'unix', 'rlat_x', { runner: 'opencode' })).toMatch(/--token rlat_x --runner opencode$/);
    expect(seedLine(seed, api, 'unix', 'rlat_x', { runner: 'opencode', service: true })).toMatch(/--runner opencode --service$/);
    expect(seedLine(seed, api, 'windows', 'rlat_x', { runner: 'opencode', service: true })).toMatch(/-Token rlat_x -Runner opencode -Service$/);
    expect(seedLine(seed, api, 'unix', 'rlat_x', { service: true })).toMatch(/--token rlat_x --service$/);
  });
});
