import { seedFullLine, seedLine } from './agent-status';

/** The line Settings > Agent tokens prints: this server's own installer of the
 *  seed (backend/installsh.py), which already carries the address the script
 *  would otherwise need - so the token is all the person types; and, behind a
 *  button, the same line without the installer. */
describe('seedLine', () => {
  const api = 'https://wb.example.com';

  it('is the installer line', () => {
    expect(seedLine(api, 'unix', 'rlat_x')).toBe(
      'curl -fsSL https://wb.example.com/api/public/install.sh | bash -s -- --token rlat_x');
    expect(seedLine(api, 'unix')).toContain('--token <your-token>');
    expect(seedLine(api, 'windows', 'rlat_x')).toContain(
      'wsl bash -c "curl -fsSL https://wb.example.com/api/public/install.sh');
    expect(seedLine(api + '/', 'unix', 'rlat_x')).not.toContain('//api/public');
  });

  it('adds the runner and the service', () => {
    expect(seedLine(api, 'unix', 'rlat_x', { runner: 'opencode' })).toMatch(/--token rlat_x --runner opencode$/);
    expect(seedLine(api, 'unix', 'rlat_x', { runner: 'opencode', service: true })).toMatch(/--runner opencode --service$/);
    expect(seedLine(api, 'unix', 'rlat_x', { service: true })).toMatch(/--token rlat_x --service$/);
    expect(seedLine(api, 'unix', 'rlat_x', { runner: 'claude' })).not.toContain('--runner');
  });
});

describe('seedFullLine', () => {
  const seed = 'https://github.com/x3beche/redline-agent-seed', api = 'https://wb.example.com';

  it('is the same without the installer', () => {
    expect(seedFullLine(seed, api, 'unix', 'rlat_x')).toBe(
      'git clone https://github.com/x3beche/redline-agent-seed; cd redline-agent-seed && ./start.sh --api https://wb.example.com --token rlat_x');
    expect(seedFullLine(seed, api, 'windows')).toContain('-Token <your-token>');
    expect(seedFullLine(seed, api, 'unix', 'rlat_x', { runner: 'opencode', service: true }))
      .toMatch(/--runner opencode --service$/);
  });
});
