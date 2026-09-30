/**
 * The title a program running in a terminal gives it — what VS Code shows on
 * a terminal tab. Claude Code sets one describing its current task
 * ("✳ Investigate ACME-2409"), with a spinner glyph in front while it works.
 * Shells set one too, on every prompt ("idrisay@mac: ~/code/web", or the
 * command being run), and those say less than the name Kovan already gave
 * the session, so they are dropped rather than shown.
 */

const TITLE_LIMIT = 80;

/** Titles that name the tool rather than the work. */
const GENERIC = /^(claude( code)?|codex|opencode|zsh|bash|fish|sh|terminal)$/i;

export function usefulTerminalTitle(raw: string): string | undefined {
  // A path (`~/code/web`) is a shell's; checked before the strip below, which
  // would take its `~/` for decoration.
  if (/^\s*[~/]/.test(raw)) return undefined;
  // Spinners, ✳, emoji and the like in front: they change many times a second
  // and would make the title flicker for nothing.
  const title = raw.replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s+/g, ' ').trim();
  if (!title) return undefined;
  if (GENERIC.test(title)) return undefined;
  // A shell's own: user@host, a path, or one bare command word (`npm`, `node`).
  if (/^[\w.-]+@[\w.-]+/.test(title)) return undefined;
  if (/^[a-z0-9._-]+$/.test(title)) return undefined;
  return title.length > TITLE_LIMIT ? `${title.slice(0, TITLE_LIMIT - 1)}…` : title;
}
