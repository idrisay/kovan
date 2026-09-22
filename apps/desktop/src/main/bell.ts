/**
 * Telling a real terminal bell apart from the one that is just punctuation.
 *
 * A CLI agent finishing its turn rings the bell (`\x07`), which is the signal
 * every one of them shares and the one iTerm and tmux already color a tab
 * for. But BEL is also the legal terminator of an OSC string — and setting
 * the window title, which most shells do on *every* prompt redraw, is an OSC
 * string: `ESC ] 0 ; some title BEL`. Measured through a real pty, not
 * assumed: a naive `data.includes('\x07')` marks a session as waiting on you
 * every single time a command finishes, which is the same as never marking it
 * at all.
 *
 * OSC can also be closed by ST (`ESC \`), and a sequence can be split across
 * two chunks from the pty, so the caller carries the state between calls.
 */

export interface BellScan {
  /** A bell that was not an OSC terminator. */
  bell: boolean;
  /** Whether the stream ended mid-OSC — pass back in on the next chunk. */
  inOsc: boolean;
}

export function scanForBell(data: string, inOsc: boolean): BellScan {
  let bell = false;
  for (let i = 0; i < data.length; i += 1) {
    const ch = data[i];
    if (inOsc) {
      if (ch === '\x07') {
        inOsc = false;
      } else if (ch === '\x1b' && data[i + 1] === '\\') {
        inOsc = false;
        i += 1;
      }
      continue;
    }
    if (ch === '\x1b' && data[i + 1] === ']') {
      inOsc = true;
      i += 1;
    } else if (ch === '\x07') {
      bell = true;
    }
  }
  return { bell, inOsc };
}
