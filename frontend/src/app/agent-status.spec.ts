import { seedFullLine, seedLine } from './agent-status';

/** The line Settings > Agent tokens prints: this server's own installer of the
 *  seed (backend/installsh.py), which already carries the address the script
 *  would otherwise need - so the token is the one thing the person types; and,
 *  behind a button, the same without the installer. Which runner, which model,
 *  the tmux session and the service are not on it: that script asks them on the
 *  person's own computer, where those answers live. */
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

  it('leaves the choices to the script on the person\'s computer', () => {
    const line = seedLine(api, 'unix', 'rlat_x');
    expect(line).not.toContain('--runner');
    expect(line).not.toContain('--service');
    expect(line).not.toContain('--model');
  });
});

describe('seedFullLine', () => {
  const seed = 'https://github.com/x3beche/redline-agent-seed', api = 'https://wb.example.com';

  it('is the same without the installer', () => {
    expect(seedFullLine(seed, api, 'unix', 'rlat_x')).toBe(
      'git clone https://github.com/x3beche/redline-agent-seed; cd redline-agent-seed && ./start.sh --api https://wb.example.com --token rlat_x');
    expect(seedFullLine(seed, api, 'windows')).toContain('-Token <your-token>');
    expect(seedFullLine(seed, api, 'windows')).toContain('-Api https://wb.example.com');
  });
});
