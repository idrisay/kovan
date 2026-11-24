import { describe, expect, it } from 'vitest';
import { chosenShell, orderShells, parseShells } from '../src/main/shells';

const ETC_SHELLS = `# List of acceptable shells for chpass(1).
# Ftpd will not allow users to connect who are not using
# one of these shells.

/bin/bash
/bin/csh
/bin/dash
/bin/ksh
/bin/sh
/bin/tcsh
/bin/zsh
/opt/homebrew/bin/zsh
`;

describe('parseShells', () => {
  it('reads the paths and skips comments and blank lines', () => {
    expect(parseShells(ETC_SHELLS)).toEqual([
      '/bin/bash', '/bin/csh', '/bin/dash', '/bin/ksh', '/bin/sh', '/bin/tcsh', '/bin/zsh', '/opt/homebrew/bin/zsh'
    ]);
  });
});

describe('orderShells', () => {
  const shells = orderShells(parseShells(ETC_SHELLS), '/bin/zsh');

  it('puts the login shell first, then bash and sh, then the rest by name', () => {
    expect(shells.map((s) => s.name)).toEqual(['zsh', 'bash', 'sh', 'csh', 'dash', 'ksh', 'tcsh', 'zsh (Homebrew)']);
    expect(shells[0]).toEqual({ path: '/bin/zsh', name: 'zsh', login: true });
  });

  it('keeps Homebrew zsh apart from macOS zsh by name', () => {
    expect(shells.find((s) => s.path === '/opt/homebrew/bin/zsh')?.name).toBe('zsh (Homebrew)');
  });

  it('gives a Homebrew login shell the plain name, and macOS zsh says where it is from', () => {
    const mine = orderShells(parseShells(ETC_SHELLS), '/opt/homebrew/bin/zsh');
    expect(mine.map((s) => s.name)).toEqual(['zsh', 'bash', 'sh', 'csh', 'dash', 'ksh', 'tcsh', 'zsh (macOS)']);
    expect(mine[0]).toEqual({ path: '/opt/homebrew/bin/zsh', name: 'zsh', login: true });
  });

  it('counts two paths to the same binary once', () => {
    const real = (p: string) => (p === '/usr/bin/bash' ? '/bin/bash' : p);
    expect(orderShells(['/bin/bash', '/usr/bin/bash', '/bin/zsh'], '/bin/zsh', real).map((s) => s.path)).toEqual(['/bin/zsh', '/bin/bash']);
  });

  it('still offers a login shell that is not in the file', () => {
    expect(orderShells(['/bin/bash'], '/usr/local/bin/fish')[0]).toEqual({ path: '/usr/local/bin/fish', name: 'fish', login: true });
  });
});

describe('chosenShell', () => {
  const shells = orderShells(parseShells(ETC_SHELLS), '/bin/zsh');

  it('uses a saved shell that is listed', () => {
    expect(chosenShell('/bin/bash', shells)).toBe('/bin/bash');
  });

  it('never spawns a path that is not listed', () => {
    expect(chosenShell('/tmp/evil', shells)).not.toBe('/tmp/evil');
    expect(chosenShell(42, shells)).not.toBe(42);
  });
});
