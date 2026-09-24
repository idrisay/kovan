import { describe, expect, it } from 'vitest';
import { scanForBell, scanForTitles } from '../src/main/bell';

const BEL = '\x07';
/** What a shell writes on nearly every prompt redraw: `ESC ] 0 ; title BEL`. */
const title = (text: string) => `\x1b]0;${text}${BEL}`;

describe('scanForBell', () => {
  it('sees a bell an agent actually rang', () => {
    expect(scanForBell(`done${BEL}`, false)).toEqual({ bell: true, inOsc: false });
  });

  it('ignores the BEL that only terminates a window title', () => {
    // The bug this exists for: a shell setting its title on every prompt made
    // every finished command look like an agent waiting on a reply.
    expect(scanForBell(`${title('zsh')}idrisay@mac ~ %`, false)).toEqual({
      bell: false, inOsc: false
    });
  });

  it('still sees a real bell printed alongside a title sequence', () => {
    expect(scanForBell(`${title('claude')}${BEL}`, false)).toEqual({ bell: true, inOsc: false });
  });

  it('carries an unterminated title across chunks, so its BEL never counts', () => {
    const first = scanForBell('\x1b]0;a very long ti', false);
    expect(first).toEqual({ bell: false, inOsc: true });
    expect(scanForBell(`tle${BEL}`, first.inOsc)).toEqual({ bell: false, inOsc: false });
  });

  it('accepts ST as the other legal end of an OSC string', () => {
    // Ends with ESC \ rather than BEL, so a bell after it is the agent's.
    expect(scanForBell(`\x1b]0;title\x1b\\${BEL}`, false)).toEqual({ bell: true, inOsc: false });
  });

  it('leaves ordinary output alone', () => {
    expect(scanForBell('Read 1 file, listed 1 directory\r\n', false)).toEqual({
      bell: false, inOsc: false
    });
  });
});

describe('scanForTitles', () => {
  it('reads the titles a program sets', () => {
    expect(scanForTitles('\x1b]0;✳ Fix the retry\x07out\x1b]2;Second\x1b\\').titles).toEqual(['✳ Fix the retry', 'Second']);
  });

  it('ignores other OSC strings', () => {
    expect(scanForTitles('\x1b]8;;https://x\x07link\x1b]8;;\x07').titles).toEqual([]);
  });

  it('carries a title split across chunks', () => {
    const first = scanForTitles('\x1b]0;Investigate AC');
    expect(first).toEqual({ titles: [], carry: '0;Investigate AC' });
    expect(scanForTitles('ME-2409\x07', first.carry)).toEqual({ titles: ['Investigate ACME-2409'], carry: undefined });
  });
});
