/**
 * Every run leaves a folder. Ported from `DevHubKit/Runs.swift`.
 *
 * An agent session is a terminal, and a terminal is gone when you close it.
 * What it worked out — which files own the ticket, what was ambiguous, what
 * six reviewers caught — was the expensive part.
 *
 * **There is no database. The directory layout *is* the index** —
 * `<ticket>/<timestamp>/`, or `<repo>#<number>/<timestamp>/` when the pull
 * request names no ticket. An agent that writes a file there has already
 * registered it, with no API to call and nothing to keep in sync. The cost is
 * that reading the list stats a few directories; measured against a JSON index
 * that disagrees with the disk, that is not a cost.
 *
 * Application Support rather than the clone: a screenshot is not source, it
 * must survive a branch switch and a `git clean`, and writing megabytes of PNG
 * into a working tree is how you end up with a `.gitignore` entry apologising
 * for your own app.
 */

import { mkdir, readdir, readFile, writeFile, stat } from 'node:fs/promises';
import * as path from 'node:path';

export type RunKind = 'implement' | 'review' | 'unblock' | 'verify';

export const RUN_KIND_LABEL: Record<RunKind, string> = {
  implement: 'Implementation',
  review: 'Review',
  unblock: 'Unblock',
  verify: 'Check'
};

/**
 * What "Check it shipped" concluded, in the prompt's own four words
 * (`VERDICTS` in `@baton/core`'s prompts).
 */
export type Verdict = 'unknown' | 'implemented' | 'partly' | 'not-implemented' | 'unchecked';

export interface RunFile {
  /** Relative to the run directory — stable, and doubles as a React key. */
  path: string;
  name: string;
  size: number;
  /**
   * When the file was last written, ISO 8601. For a screenshot that is when
   * it was taken — the agent writes it once and never touches it again.
   */
  modifiedAt: string;
}

export interface AgentRun {
  /** The run's directory, which is unique and is also how it is deleted. */
  id: string;
  directory: string;
  /** The ticket key, or `repo#number` when the pull request names no ticket. */
  subject: string;
  /**
   * The pull request this run was started from, which is not the same as the
   * subject: a ticket folder collects runs from every pull request that carried
   * its key, and a row that cannot say which one it came from is unactionable.
   */
  pull: string;
  startedAt: number;
  kind: RunKind;
  verdict: Verdict;
  /** What the agent scored its own work, when asked. */
  confidence?: number;
  promptPath?: string;
  reportPath?: string;
  /** Absolute paths, in the order the agent numbered them. */
  shots: string[];
}

/** The environment variables every run is given, and the prompts name. */
export const RUN_ENV = {
  report: 'BATON_REPORT',
  shots: 'BATON_SHOTS',
  ticket: 'BATON_TICKET'
} as const;

/**
 * A subject as a directory name.
 *
 * Slashes and colons cannot appear in a path component, and `repo#number`
 * contains one of each.
 */
export function subjectSlug(subject: string): string {
  return subject.replace(/[/\\:]/g, '_');
}

export class RunStore {
  constructor(private readonly root: string) {}

  /**
   * Whether a path is actually something this store wrote — the guard before
   * an IPC handler reads a path the renderer hands it back. Every
   * `reportPath`/`promptPath`/shot only ever came from here in the first
   * place, but the check costs nothing and means a future caller cannot turn
   * "read this run's report" into "read any file on disk" by mistake.
   */
  owns(file: string): boolean {
    const resolved = path.resolve(file);
    const rootWithSep = path.resolve(this.root) + path.sep;
    return resolved.startsWith(rootWithSep);
  }

  /**
   * `BATON_RUNS_ROOT` moves the store, which is what the tests use. Read from
   * the environment rather than exposed as a setter: a global the app could
   * assign is a global the app eventually does assign, and then a bug puts
   * somebody's screenshots in /tmp.
   */
  static rootFor(stateDir: string): string {
    return process.env['BATON_RUNS_ROOT'] ?? path.join(stateDir, 'runs');
  }

  /** Creates the folder for a new run and returns it, ready to be filled. */
  async begin(options: {
    subject: string;
    pull: string;
    kind: RunKind;
    prompt: string;
  }): Promise<AgentRun> {
    const startedAt = Date.now();
    // Sortable, filesystem-safe, and readable at a glance in Finder.
    const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-');
    const directory = path.join(this.root, subjectSlug(options.subject), stamp);

    const shots = path.join(directory, 'shots');
    await mkdir(shots, { recursive: true });

    const promptPath = path.join(directory, 'prompt.md');
    await writeFile(promptPath, options.prompt, 'utf8');

    // The metadata the folder cannot express: which pull request, and why.
    await writeFile(
      path.join(directory, 'run.json'),
      JSON.stringify(
        { subject: options.subject, pull: options.pull, kind: options.kind, startedAt },
        null,
        2
      ),
      'utf8'
    );

    return {
      id: directory,
      directory,
      subject: options.subject,
      pull: options.pull,
      startedAt,
      kind: options.kind,
      verdict: 'unknown',
      promptPath,
      shots: []
    };
  }

  /** The environment a run's agent is spawned with. */
  env(run: AgentRun, ticketFile?: string): Record<string, string> {
    const vars: Record<string, string> = {
      [RUN_ENV.report]: path.join(run.directory, 'report.md'),
      [RUN_ENV.shots]: path.join(run.directory, 'shots')
    };
    if (ticketFile) {
      vars[RUN_ENV.ticket] = ticketFile;
    }
    return vars;
  }

  /** Every run for one subject, newest first. */
  async list(subject: string): Promise<AgentRun[]> {
    const dir = path.join(this.root, subjectSlug(subject));
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return [];
    }

    const runs = await Promise.all(entries.map((entry) => this.read(path.join(dir, entry))));
    return runs
      .filter((run): run is AgentRun => run !== undefined)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Reads one run folder back. */
  async read(directory: string): Promise<AgentRun | undefined> {
    let meta: { subject?: string; pull?: string; kind?: RunKind; startedAt?: number };
    try {
      meta = JSON.parse(await readFile(path.join(directory, 'run.json'), 'utf8'));
    } catch {
      return undefined;
    }

    const reportPath = path.join(directory, 'report.md');
    const report = await readFile(reportPath, 'utf8').catch(() => undefined);

    let shots: string[] = [];
    try {
      shots = (await readdir(path.join(directory, 'shots')))
        .filter((name) => /\.(png|jpe?g|gif|webp)$/i.test(name))
        .sort()
        .map((name) => path.join(directory, 'shots', name));
    } catch {
      // No shots directory is normal for a review.
    }

    const promptPath = path.join(directory, 'prompt.md');
    const hasPrompt = await stat(promptPath).then(() => true).catch(() => false);

    return {
      id: directory,
      directory,
      subject: meta.subject ?? path.basename(path.dirname(directory)),
      pull: meta.pull ?? '',
      startedAt: meta.startedAt ?? 0,
      kind: meta.kind ?? 'implement',
      verdict: report ? verdictFrom(report) : 'unknown',
      confidence: report ? confidenceFrom(report) : undefined,
      promptPath: hasPrompt ? promptPath : undefined,
      reportPath: report !== undefined ? reportPath : undefined,
      shots
    };
  }

  /**
   * Every file the run directory actually contains — not just the ones
   * `prompt.md`/`report.md`/`shots` already name. An agent that leaves an
   * extra note, a plan, a second screenshot folder, whatever it decided the
   * work needed, should not go invisible just because nothing here expected
   * it; the directory itself is still the only index there is.
   */
  async files(directory: string): Promise<RunFile[]> {
    const found: RunFile[] = [];

    const walk = async (dir: string, prefix: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        // Bookkeeping this store itself wrote to read `list()` back, not
        // something written *by* the run — showing it as a "file" here would
        // be showing the index as if it were part of what it indexes.
        if (prefix === '' && entry.name === 'run.json') continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(path.join(dir, entry.name), rel);
        } else {
          const info = await stat(path.join(dir, entry.name)).catch(() => undefined);
          found.push({
            path: rel,
            name: entry.name,
            size: info?.size ?? 0,
            modifiedAt: (info?.mtime ?? new Date(0)).toISOString()
          });
        }
      }
    };

    await walk(directory, '');
    return found.sort((a, b) => a.path.localeCompare(b.path));
  }
}

/**
 * The verdict, from the report's first line.
 *
 * The prompt asks the agent to put it there precisely so this does not have to
 * interpret prose. It used to look for "shipped", "missing" and "broken" —
 * words from an older prompt — while the prompt asks for "implemented",
 * "partly implemented", "not implemented" or "could not check", so every
 * verdict read as unknown. The old words still count, for old reports. The
 * longer phrases are checked first: "not implemented" contains "implemented".
 */
export function verdictFrom(report: string): Verdict {
  const first = (report.split('\n').find((line) => line.trim()) ?? '').toLowerCase();
  if (first.includes('could not check')) return 'unchecked';
  if (first.includes('partly')) return 'partly';
  if (/not implemented|not shipped|missing|broken/.test(first)) return 'not-implemented';
  if (/implemented|shipped/.test(first)) return 'implemented';
  return 'unknown';
}

/** `84/100` anywhere in the report, which is the form the prompt asks for. */
export function confidenceFrom(report: string): number | undefined {
  const match = report.match(/\b(\d{1,3})\s*\/\s*100\b/);
  if (!match) return undefined;
  const value = Number(match[1]);
  return value >= 0 && value <= 100 ? value : undefined;
}
