import { describe, expect, it } from 'vitest';
import {
  agentKind,
  agentState,
  findAgents,
  formatIdle,
  hostApp,
  isHelperCommand,
  parseClock,
  parseCwds,
  parseListening,
  parsePs,
  processKey,
  sameProcess
} from '../src/processes';

// Real `ps` lines from this Mac, trimmed, plus a server a Claude session started.
const PS = [
  '23971     1 Wed Sep 23 09:40:12 2026   1:00.00 200000 ??       /Applications/Visual Studio Code.app/Contents/MacOS/Electron',
  '24319 23971 Wed Sep 23 09:40:12 2026   0:10.00  90000 ??       /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin) --type=utility',
  '24806 24319 Wed Sep 23 09:40:12 2026   0:03.53  17600 ??       /Users/me/.vscode/extensions/openai.chatgpt/bin/macos-aarch64/codex -c features.code_mode_host=true app-server',
  '24320 23971 Wed Sep 23 09:40:12 2026   0:10.00  90000 ??       /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper --type=utility',
  '16758 24320 Wed Sep 23 09:40:12 2026   0:01.00   5000 ttys001  /opt/homebrew/bin/zsh -il',
  '42781 16758 Wed Sep 23 09:40:12 2026   4:02.74 318128 ttys001  claude',
  '50552 42781 Wed Sep 23 09:40:12 2026   0:00.10   4000 ttys001  /opt/homebrew/bin/zsh -c npm run dev',
  '50553 50552 Wed Sep 23 09:40:12 2026   0:05.00  80000 ttys001  node /repo/node_modules/.bin/vite',
  '60000 16758 Wed Sep 23 09:40:12 2026   0:30.00  50000 ttys002  node /opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js',
  '60001 60000 Wed Sep 23 09:40:12 2026   0:30.00  60000 ttys002  /opt/homebrew/lib/node_modules/@openai/codex/vendor/codex-aarch64-apple-darwin/codex',
  '50063 50036 Wed Sep 23 09:40:12 2026   0:00.17  16384 ??       /Users/me/.local/bin/claude --chrome-native-host',
  'garbage line'
].join('\n');

describe('ps', () => {
  it('parses elapsed and cpu clocks', () => {
    expect(parseClock('01:38:50')).toBe(5930);
    expect(parseClock('1-02:03:04')).toBe(93784);
    expect(parseClock('4:02.74')).toBeCloseTo(242.74);
    expect(parseClock('nope')).toBeUndefined();
  });

  it('parses rows, keeping commands with spaces whole', () => {
    const rows = parsePs(PS);
    expect(rows).toHaveLength(11);
    const plugin = rows.find((r) => r.pid === 24319)!;
    expect(plugin.command).toContain('Code Helper (Plugin) --type=utility');
    expect(plugin.tty).toBeUndefined();
    expect(rows.find((r) => r.pid === 42781)).toMatchObject({ tty: 'ttys001', rss: 318128, started: Date.parse('Wed Sep 23 09:40:12 2026') });
  });
});

describe('finding agents', () => {
  it('recognises agents, through a node wrapper and a platform binary', () => {
    expect(agentKind('claude')).toBe('claude');
    expect(agentKind('/Users/me/.local/bin/claude --resume')).toBe('claude');
    expect(agentKind('node /x/codex.js')).toBe('codex');
    expect(agentKind('/x/codex-aarch64-apple-darwin/codex')).toBe('codex');
    expect(agentKind('/opt/homebrew/bin/opencode')).toBe('opencode');
    expect(agentKind('/usr/bin/claudette')).toBeUndefined();
    expect(agentKind('node /repo/node_modules/.bin/vite')).toBeUndefined();
  });

  it('knows the helpers other apps run', () => {
    expect(isHelperCommand('/x/claude --chrome-native-host')).toBe(true);
    expect(isHelperCommand('/x/codex -c a=b app-server')).toBe(true);
    expect(isHelperCommand('claude mcp serve')).toBe(true);
    expect(isHelperCommand('claude --resume')).toBe(false);
  });

  it('keeps an agent started by another agent inside its parent', () => {
    const agents = findAgents(parsePs(PS));
    expect(agents.map((a) => a.row.pid).sort()).toEqual([24806, 42781, 50063, 60000]);
    const claude = agents.find((a) => a.row.pid === 42781)!;
    expect(claude.descendants.map((d) => d.pid)).toEqual([50552, 50553]);
    expect(hostApp(claude.ancestors.map((a) => a.command))).toBe('VS Code');
  });

  it('does not fold an agent into one above a Baton terminal', () => {
    const rows = parsePs([
      '100     1 Wed Sep 23 09:40:12 2026   0:01.00 1000 ttys001  claude',
      '200   100 Wed Sep 23 09:40:12 2026   0:01.00 1000 ttys001  /Applications/Baton.app/Contents/MacOS/Baton',
      '300   200 Wed Sep 23 09:40:12 2026   0:01.00 1000 ttys009  /bin/zsh -l',
      '400   300 Wed Sep 23 09:40:12 2026   0:01.00 1000 ttys009  claude'
    ].join('\n'));
    expect(findAgents(rows).map((a) => a.row.pid)).toEqual([100]);
    expect(findAgents(rows, new Set([300])).map((a) => a.row.pid)).toEqual([100, 400]);
  });

  it('names the app a terminal belongs to', () => {
    expect(hostApp(['/bin/zsh', '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal'])).toBe('Terminal');
    expect(hostApp(['/bin/zsh', '/Applications/iTerm.app/Contents/MacOS/iTerm2'])).toBe('iTerm');
    expect(hostApp(['/bin/zsh', 'tmux new -s a'])).toBe('tmux');
    expect(hostApp(['/bin/zsh'])).toBeUndefined();
  });

  it('tells a reused pid from the process it was', () => {
    const row = parsePs(PS).find((r) => r.pid === 42781)!;
    const key = processKey(row);
    expect(sameProcess(key, { ...row })).toBe(true);
    expect(sameProcess(key, { ...row, started: row.started + 60_000 })).toBe(false);
  });

  it('reads a single-digit day padded with a space', () => {
    const [row] = parsePs('  7   1 Thu Sep  3 08:00:00 2026   0:00.01   100 ??  claude');
    expect(row?.started).toBe(Date.parse('Thu Sep 3 08:00:00 2026'));
  });
});

describe('lsof', () => {
  it('reads listening ports per pid', () => {
    const out = ['p50553', 'cnode', 'f20', 'n127.0.0.1:5173', 'f21', 'n[::1]:5173', 'p609', 'cnginx', 'f8', 'n127.0.0.1:80'].join('\n');
    const ports = parseListening(out);
    expect(ports.get(50553)).toEqual([{ port: 5173, name: 'node' }]);
    expect(ports.get(609)).toEqual([{ port: 80, name: 'nginx' }]);
  });

  it('reads working directories', () => {
    expect(parseCwds('p42781\nfcwd\nn/Users/me/app\np1\nfcwd\nn/').get(42781)).toBe('/Users/me/app');
  });
});

describe('state', () => {
  const hour = 3_600_000;
  it('is working, waiting or idle by how long it has been quiet', () => {
    expect(agentState(1000, 1000 + 10_000, hour)).toBe('working');
    expect(agentState(0, 5 * 60_000, hour)).toBe('waiting');
    expect(agentState(0, hour, hour)).toBe('idle');
    expect(agentState(undefined, hour * 5, hour)).toBe('waiting');
  });

  it('formats durations', () => {
    expect(formatIdle(42_000)).toBe('42s');
    expect(formatIdle(4 * 60_000)).toBe('4m');
    expect(formatIdle(130 * 60_000)).toBe('2h 10m');
    expect(formatIdle(27 * hour)).toBe('1d 3h');
  });
});
