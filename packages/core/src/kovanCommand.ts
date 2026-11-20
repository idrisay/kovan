/**
 * The `kovan` shell command (item 178): `kovan <file>` or `kovan <folder>`
 * from any terminal opens it in Kovan, as `code` does for VS Code.
 *
 * The command is a small script Kovan writes onto your PATH from Settings ›
 * Text & terminal. It starts the Kovan app with `--kovan-open`; the running
 * Kovan gets that through Electron's `second-instance` (the new instance
 * exits at once), or, when Kovan wasn't running, the new instance is Kovan
 * and reads its own arguments. The pure parts live here.
 */

/** Marks the arguments as an open request, so a plain launch is never mistaken for one. */
export const KOVAN_OPEN_FLAG = '--kovan-open';

/** Written into the script, so Kovan only ever replaces or removes its own. */
export const KOVAN_COMMAND_MARKER = '# kovan-command v1';

export interface CommandLineOpen {
  /** The terminal's folder, which relative paths are read against. */
  cwd?: string;
  paths: string[];
}

/**
 * The open request in a process's arguments: `… --kovan-open --cwd <dir> -- a b`.
 * Undefined when the flag isn't there. Everything after `--` is a path, even
 * one that starts with a dash.
 */
export function commandLineOpen(argv: readonly string[]): CommandLineOpen | undefined {
  const flag = argv.indexOf(KOVAN_OPEN_FLAG);
  if (flag < 0) return undefined;
  const rest = argv.slice(flag + 1);
  const dashes = rest.indexOf('--');
  const options = dashes < 0 ? rest : rest.slice(0, dashes);
  const paths = dashes < 0 ? [] : rest.slice(dashes + 1);
  const at = options.indexOf('--cwd');
  const cwd = at >= 0 ? options[at + 1] : undefined;
  return { ...(cwd ? { cwd } : {}), paths: paths.filter((p) => p.length > 0) };
}

export interface OpenCandidate {
  path: string;
  line?: number;
  column?: number;
}

/**
 * What a typed or pasted path may mean, most literal first, for main to try
 * against the disk in order:
 * - as written (a file may really be called `notes.md.`);
 * - without sentence punctuation pasted along with it (`improvements.md.`,
 *   `file.ts,`, `(file.ts)`);
 * - with a `:line` or `:line:column` suffix read as a place in the file, as
 *   compilers print it and as ⌘P takes it.
 */
export function openCandidates(raw: string): OpenCandidate[] {
  const out: OpenCandidate[] = [];
  const add = (c: OpenCandidate) => {
    if (c.path && !out.some((o) => o.path === c.path && o.line === c.line && o.column === c.column)) out.push(c);
  };
  const trimmed = raw.trim();
  add({ path: trimmed });
  const bare = trimmed.replace(/^[('"`]+/, '').replace(/[)'"`.,;!?]+$/, '');
  add({ path: bare });
  for (const text of [trimmed, bare]) {
    const m = /^(.*?):(\d+)(?::(\d+))?$/.exec(text);
    if (m && m[1]) add({ path: m[1], line: Number(m[2]), ...(m[3] ? { column: Number(m[3]) } : {}) });
  }
  return out;
}

/** `'it'\''s'`: one word for sh, whatever it holds. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The script itself. It checks each path exists before starting anything, so
 * a typo is reported in the terminal where it was typed, and Kovan only ever
 * gets paths that were there a moment ago.
 *
 * - macOS: `open -n -a <Kovan.app> --args …`. LaunchServices starts it
 *   detached from the terminal; `-n` makes a new instance even while Kovan
 *   runs, which is what hands the arguments to the running one.
 * - Linux: the executable itself (the AppImage when there is one), detached
 *   with nohup so closing the terminal doesn't close Kovan.
 */
export function kovanCommandScript(target: { platform: 'darwin' | 'linux'; app: string }): string {
  const launch = target.platform === 'darwin'
    ? `open -n -a ${shellQuote(target.app)} --args ${KOVAN_OPEN_FLAG} --cwd "$PWD" -- "$@"`
    : `nohup ${shellQuote(target.app)} ${KOVAN_OPEN_FLAG} --cwd "$PWD" -- "$@" >/dev/null 2>&1 &`;
  const bringForward = target.platform === 'darwin'
    ? `open -a ${shellQuote(target.app)}`
    : `nohup ${shellQuote(target.app)} >/dev/null 2>&1 &`;
  return `#!/bin/sh
${KOVAN_COMMAND_MARKER}
# Opens files and folders in Kovan, as \`code\` does for VS Code:
#   kovan notes/improvements.md      the file, in Kovan's editor
#   kovan src/main.ts:42             at line 42
#   kovan .                          this folder, as a workspace
# Installed by Kovan (Settings > Text & terminal), which can also remove it.

case "$1" in
  -h|--help)
    echo "usage: kovan <file[:line[:column]] | folder>..."
    exit 0 ;;
esac

if [ $# -eq 0 ]; then
  ${bringForward}
  exit 0
fi

exists() {
  p=$1
  [ -e "$p" ] && return 0
  q=$(printf '%s' "$p" | sed -e 's/^(*//' -e 's/[).,;!?]*$//')
  [ -e "$q" ] && return 0
  for c in "$p" "$q"; do
    r=\${c%:*}; [ "$r" != "$c" ] && [ -e "$r" ] && return 0
    r=\${r%:*}; [ "$r" != "$c" ] && [ -e "$r" ] && return 0
  done
  return 1
}

missing=0
for p in "$@"; do
  if ! exists "$p"; then
    echo "kovan: no such file or folder: $p" >&2
    missing=1
  fi
done
[ $missing -eq 0 ] || exit 1

${launch}
`;
}

/** Whether a file on disk is a script Kovan wrote (and so may replace or remove). */
export function isKovanCommandScript(text: string): boolean {
  return text.startsWith('#!/bin/sh\n') && text.includes(KOVAN_COMMAND_MARKER);
}

/** The `.app` bundle an executable lives in: `/Applications/Kovan.app/Contents/MacOS/Kovan` → `/Applications/Kovan.app`. */
export function appBundleOf(executable: string): string | undefined {
  const m = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(executable);
  return m?.[1];
}

/** The app path a script launches, read back to tell whether it still points at this Kovan. */
export function scriptTarget(text: string): string | undefined {
  const m = /(?:open -n -a|nohup) '((?:[^']|'\\'')*)' (?:--args )?--kovan-open/.exec(text);
  return m ? m[1]!.replace(/'\\''/g, "'") : undefined;
}
