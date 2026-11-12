/**
 * Starting an agent on a piece of work.
 *
 * This is the join between four things that are separately testable and
 * deliberately kept apart: which agents exist (`@kovan/agent`), what to say to
 * one (`@kovan/core`'s prompts), where to run it (`@kovan/git`), and the folder
 * that records it (`RunStore`).
 */

import { app, shell } from 'electron';
import { openLink } from './external';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
  DEFAULTISSUETEMPLATE,
  DEFAULTREVIEWTEMPLATE,
  DEFAULTUPDATETEMPLATE,
  DEFAULTVERIFYTEMPLATE,
  renderVerifyPrompt,
  testingClause,
  renderIssuePrompt,
  renderPullPrompt,
  renderGroupReviewPrompt,
  type GroupReviewPull,
  renderSentryPrompt,
  ticketKeyInTitle,
  TICKET_RECENT_COMMENTS,
  type Conventions,
  type JiraIssue,
  type PullSummary,
  type SentryFrame,
  type SentryIssue,
  extraDirArgs,
  foldersPromptSection,
  modArgs,
  modEnv,
  promptReviewers,
  modGoal,
  runPageUrl
} from '@kovan/core';
import { isAppFrame, resolveFrame } from '@kovan/core/node';
import { AgentLimitsReader } from './agentLimits';
import { AgentStatus } from './agentStatus';
import { claudeModDir, claudeModOpenDir } from './claudeMod';
import { RunStore, available, writeSettingsFile, type RunKind, type Runner } from '@kovan/agent';
import { findClones, runTargets, type RunTarget } from '@kovan/git';
import { HttpClient, JiraClient, SentryClient, type RawSentryFrame } from '@kovan/providers';
import type { DesktopHost } from './host';
import type { Sessions } from './sessions';
import type { QuickModel } from './quick';
import { TestEnvironments, type TestSelection } from './testEnvironments';

/**
 * Jira attachments arrive already inlined as base64 data URIs — that is for
 * the ticket pane's own rendering, not for an agent. Left as-is, every run
 * would carry whatever screenshots are pasted into the ticket straight into
 * `ticket.md`, which the prompts tell the agent to read first, every time,
 * whether or not the task has anything to do with what the image shows.
 */
const INLINE_IMAGE_PATTERN = /!\[([^\]]*)\]\((data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+)\)/g;

/**
 * Swaps each inlined image for a real file on disk plus a pointer to it, so
 * the agent's context stays text-sized but the image is still one `Read`
 * away if the task actually needs it.
 */
async function externalizeImages(markdown: string, directory: string): Promise<string> {
  const matches = [...markdown.matchAll(INLINE_IMAGE_PATTERN)];
  if (matches.length === 0) {
    return markdown;
  }

  const attachmentsDir = path.join(directory, 'attachments');
  await mkdir(attachmentsDir, { recursive: true });

  const replacements = new Map<string, string>();
  let index = 0;
  for (const [whole, alt, dataUrl] of matches) {
    if (replacements.has(whole)) continue;
    const parsed = /^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl);
    if (!parsed) continue;
    index += 1;
    const ext = parsed[1] === 'jpeg' ? 'jpg' : parsed[1];
    const file = path.join(attachmentsDir, `image-${index}.${ext}`);
    await writeFile(file, Buffer.from(parsed[2], 'base64'));
    replacements.set(whole, `_(image "${alt || `image-${index}`}" — open ${file} if you need to see it)_`);
  }

  return markdown.replace(INLINE_IMAGE_PATTERN, (whole) => replacements.get(whole) ?? whole);
}

export interface StartRequest {
  kind: RunKind;
  /** A `repo#number` for a pull request, or a ticket key. */
  subjectId: string;
  runnerId: string;
  /** Working directory. Defaults to the best guess for the subject. */
  cwd?: string;
  /**
   * More folders the work spans, beside `cwd`. Opened to the agent with
   * `--add-dir` where its CLI has it, and named in the prompt either way.
   */
  extraCwds?: string[];
  /** Lets the user edit the prompt before it is sent. */
  prompt?: string;
  /**
   * The model to run with, chosen in the run sheet. Left unset, `runnerFor()`
   * falls back to its own default (Sonnet, for the `claude` runner) — an
   * explicit choice here always wins over that default, never the other way
   * around.
   */
  model?: string;
  /**
   * The environment to check on and the accounts to sign in as, from the run
   * sheet. Verify always has one (the default environment when unset); for
   * the other kinds it is opt-in, and absent means the prompt says nothing
   * about where to test.
   */
  test?: TestSelection;
}

/** Everything a run can be started against. Every field is optional because
 *  each caller only ever has one of them. */
export interface Subject {
  pull?: PullSummary;
  issue?: JiraIssue;
  sentry?: { issue: SentryIssue; frames: SentryFrame[] };
  /**
   * A review of several pull requests for one ticket (item 171): the others
   * reviewed with `pull`, and merged ones read for context. Only on a review.
   */
  together?: { key: string; pulls: GroupReviewPull[]; context: PullSummary[] };
}

/** Where the last list of agents is kept between launches (item 172). */
const RUNNERS_FOUND = 'runner.found';
/** How long a list of agents is trusted before a look behind it. */
const RUNNERS_FRESH_MS = 60_000;

export class Agents {
  private readonly store: RunStore;
  private readonly http: HttpClient;
  private cachedTargets?: RunTarget[];
  /** The folder list `cachedTargets` was found from; a change rescans. */
  private cachedFor?: string;

  readonly testEnvironments: TestEnvironments;

  /** Plan limits, from what the agents write themselves (item 108). */
  readonly limits = new AgentLimitsReader(app.getPath('userData'));
  readonly status = new AgentStatus(app.getPath('userData'));

  constructor(
    private readonly host: DesktopHost,
    private readonly sessions: Sessions,
    private readonly quick?: QuickModel
  ) {
    this.store = new RunStore(RunStore.rootFor(host.files.stateDir()));
    this.http = new HttpClient(host.log);
    this.testEnvironments = new TestEnvironments(host);
  }

  /**
   * The agents on this machine (item 172). Finding them asks a login shell
   * what each name is, which took 0.9 s, and 3.7 s the first time after
   * launch, every time a run sheet opened. Now the last list answers at once
   * and a fresh look runs behind it, at most once a minute, for next time. The
   * list is kept in settings so the first sheet after a restart is quick too.
   * A change to your own agents in Settings looks again straight away.
   */
  runners(): Promise<Runner[]> {
    const custom = this.host.config.get('runner.custom', []) as Runner[];
    const key = JSON.stringify(custom);
    if (!this.runnerCache) {
      const kept = this.host.config.get<{ key?: string; list?: Runner[] } | undefined>(RUNNERS_FOUND, undefined);
      if (kept?.key === key && Array.isArray(kept.list) && kept.list.length > 0) {
        this.runnerCache = { key, list: kept.list, at: 0 };
      }
    }
    const cached = this.runnerCache;
    if (cached && cached.key === key) {
      if (Date.now() - cached.at > RUNNERS_FRESH_MS) void this.findRunners(custom, key).catch(() => undefined);
      return Promise.resolve(cached.list);
    }
    return this.findRunners(custom, key);
  }

  private runnerCache?: { key: string; list: Runner[]; at: number };
  private runnerLook?: Promise<Runner[]>;

  private findRunners(custom: Runner[], key: string): Promise<Runner[]> {
    this.runnerLook ??= available(custom)
      .then(async (list) => {
        this.runnerCache = { key, list, at: Date.now() };
        await this.host.config.set(RUNNERS_FOUND, { key, list });
        return list;
      })
      .finally(() => { this.runnerLook = undefined; });
    return this.runnerLook;
  }

  /** Where a run can be started, from the watched folders and their clones. */
  async targets(force = false): Promise<RunTarget[]> {
    // The folders from Settings and every folder added in the Workspace tab.
    // Only `repos.folders` used to count, and nothing in the app writes it
    // any more — so a run sheet opened with an empty Folder list even though
    // the Workspace tab had the clones right there.
    const folders = [...new Set([
      ...this.host.config.get('repos.folders', [] as string[]),
      ...this.host.config.get<{ folders?: string[] }[]>('workspaces', []).flatMap((w) => w.folders ?? [])
    ])];
    const key = folders.join('\n');
    if (this.cachedTargets && !force && key === this.cachedFor) {
      return this.cachedTargets;
    }
    this.cachedFor = key;
    this.cachedTargets = runTargets(await findClones(folders), folders);
    return this.cachedTargets;
  }

  private conventions(): Conventions {
    return this.host.config.get('prompt.conventions', {
      baseBranch: 'main',
      checks: [],
      untouchable: [],
      pullRequestReviewers: []
    }) as Conventions;
  }

  /** The prompt a given piece of work would be started with. */
  async buildPrompt(kind: RunKind, subject: Subject, test?: TestSelection): Promise<string> {
    const base = await this.basePrompt(kind, subject, test);
    if (kind === 'verify' || !test || !base) return base;
    const resolved = await this.testEnvironments.resolve(test);
    return resolved ? `${base}\n\n${testingClause(resolved.environment, resolved.accounts)}` : base;
  }

  private async basePrompt(kind: RunKind, subject: Subject, test?: TestSelection): Promise<string> {
    const reviewers = this.host.config.get('runner.reviewers', [] as string[]);
    const conventions = this.conventions();

    if (kind === 'implement' && subject.sentry) {
      return renderSentryPrompt(subject.sentry.issue, subject.sentry.frames, {
        template: this.host.config.get('prompt.template.sentry', '') || undefined,
        reviewers,
        conventions
      });
    }
    if (kind === 'implement' && subject.issue) {
      return renderIssuePrompt(subject.issue, {
        template: this.host.config.get('prompt.template.implement', '') || undefined,
        reviewers,
        conventions
      });
    }
    if (!subject.pull) {
      return '';
    }
    if (kind === 'verify') {
      // Its own renderer: the verify template needs ${env}, ${site},
      // ${verdicts} and ${basicAuth}, none of which renderPullPrompt knows —
      // and `substitute` leaves an unknown placeholder alone, so through the
      // general path all four reached the agent as literal text.
      const resolved = await this.testEnvironments.resolve(test ?? {});
      return renderVerifyPrompt(
        this.host.config.get('prompt.template.verify', '') || DEFAULTVERIFYTEMPLATE,
        subject.pull,
        {
          name: resolved?.environment.name ?? '',
          site: resolved?.environment.site ?? '',
          hasBasicAuth: resolved?.environment.basicAuth ?? false,
          accounts: resolved?.accounts ?? []
        },
        { reviewers, conventions }
      );
    }

    if (kind === 'review' && subject.together && subject.together.pulls.length > 0) {
      const own = subject.together.pulls.find((p) => p.pull.repo === subject.pull!.repo && p.pull.number === subject.pull!.number);
      return renderGroupReviewPrompt(subject.together.key, [own ?? { pull: subject.pull }, ...subject.together.pulls.filter((p) => p !== own)], {
        context: subject.together.context,
        reviewers
      });
    }

    const template =
      kind === 'review'
        ? this.host.config.get('prompt.template.review', '') || DEFAULTREVIEWTEMPLATE
        : this.host.config.get('prompt.template.unblock', '') || DEFAULTUPDATETEMPLATE;

    return renderPullPrompt(template, subject.pull, { reviewers, conventions });
  }

  /**
   * The runner to actually invoke, with a per-kind model swapped in.
   *
   * Every kind defaults to Sonnet on the built-in `claude` runner — one
   * consistent, deliberate choice instead of the old two-tier setup, where
   * "review"/"verify" silently defaulted to Haiku (cheap but noticeably worse
   * judgment) while "implement"/"unblock" had no default at all and fell back
   * to whatever the CLI itself defaults to. Opus stays one click away in the
   * run sheet any time you want it for something hard; it just isn't the
   * silent default for routine work. A model name is never assumed for any
   * other runner, since its model names aren't Claude's.
   */
  private runnerFor(runner: Runner, kind: RunKind, explicitModel?: string): Runner {
    const overrides = this.host.config.get('runner.models', {} as Record<string, string>);
    const defaults: Record<string, string> =
      runner.id === 'claude' ? { implement: 'sonnet', review: 'sonnet', unblock: 'sonnet', verify: 'sonnet' } : {};
    // A model chosen in the run sheet always wins over a settings override,
    // which in turn always wins over the built-in default.
    const model = explicitModel || overrides[kind] || defaults[kind];
    return model && runner.modelFlag ? { ...runner, model } : runner;
  }

  /**
   * The folder to start in.
   *
   * The clone matching the pull request's repository, when there is one.
   * Otherwise the first watched folder, because opening a terminal in the
   * user's home directory is never what they wanted.
   */
  async defaultCwd(repo?: string): Promise<string | undefined> {
    const targets = await this.targets();
    if (repo) {
      const match = targets.find((t) => t.label.toLowerCase() === repo.toLowerCase());
      if (match) return match.path;
    }
    return targets[0]?.path;
  }

  /**
   * Files the work under a ticket where it can find one.
   *
   * A ticket folder collects runs from every pull request that carried its key,
   * so the second time the same ticket comes round the first time is already
   * there.
   */
  subjectFor(pull?: PullSummary, issue?: JiraIssue, sentry?: SentryIssue): string {
    if (sentry) return sentry.shortId;
    if (issue) return issue.key;
    if (!pull) return 'unknown';
    return ticketKeyInTitle(pull.title) || `${pull.repo}#${pull.number}`;
  }

  async start(
    request: StartRequest,
    subject: Subject
  ): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
    const runners = await this.runners();
    const runner = runners.find((r) => r.id === request.runnerId);
    if (!runner) {
      return { ok: false, error: `No runner "${request.runnerId}". It may have been uninstalled.` };
    }

    const basePrompt = request.prompt ?? (await this.buildPrompt(request.kind, subject, request.test));
    const cwd = request.cwd ?? (await this.defaultCwd(subject.pull?.repo));
    if (!cwd) {
      return {
        ok: false,
        error: 'No folder to run in. Add a watched folder in Connections first.'
      };
    }
    // Only folders Kovan itself offered — the renderer's list is a request,
    // and these paths end up as command-line arguments.
    const targets = await this.targets();
    const folderOf = (p: string) => targets.find((t) => t.path === p) ?? { label: path.basename(p), path: p };
    const extras = [...new Set(request.extraCwds ?? [])]
      .filter((p) => p !== cwd && targets.some((t) => t.path === p))
      .map(folderOf);
    const prompt = basePrompt + foldersPromptSection(folderOf(cwd), extras);

    const subjectId = this.subjectFor(subject.pull, subject.issue, subject.sentry?.issue);
    // Where it checks, when it checks anywhere: kept with the run so its
    // viewer can offer "Open in browser" on the same site.
    const tested = request.kind === 'verify' || request.test
      ? await this.testEnvironments.resolve(request.test ?? {})
      : undefined;
    const run = await this.store.begin({
      subject: subjectId,
      pull: subject.pull ? `${subject.pull.repo}#${subject.pull.number}` : '',
      kind: request.kind,
      prompt,
      ...(tested?.environment.site ? { environment: tested.environment.name, site: tested.environment.site } : {})
    });

    // Everything already known about this ticket, so the agent does not start
    // from nothing. The prompts tell it to read this first.
    const ticketFile = await this.writeTicketFile(run.directory, subject);

    const env = {
      ...this.store.env(run, ticketFile),
      // Verify always signs in somewhere; the other kinds only when the run
      // sheet picked an environment to test on.
      ...(request.kind === 'verify' || request.test ? await this.testEnvironments.env(request.test ?? {}) : {})
    };

    // A Claude session records its plan limits for the run sheet (item 108),
    // and every agent that can says Working / Input / Done (item 112).
    const base = withExtraDirs(this.runnerFor(runner, request.kind, request.model), extras.map((f) => f.path));
    const status = await this.status.forRunner(base);
    const limitSettings = await this.limits.claudeSettings(base);
    const settings = limitSettings || status.claudeSettings ? { ...limitSettings, ...status.claudeSettings } : undefined;
    // A file, not inline JSON: inline it made the typed line too long (item 141).
    // Kovan's pane beside Claude (item 147): goal, plan, changes, checks, usage.
    const extraArgs = [
      ...(settings ? ['--settings', await writeSettingsFile(settings)] : []),
      ...status.args,
      ...modArgs(base.command, claudeModDir())
    ];
    const goalEnv = modArgs(base.command, claudeModDir()).length
      ? {
          ...modEnv(modGoal(subject)),
          KOVAN_OPEN_DIR: claudeModOpenDir(),
          // The pane lists each folder's changes under its own name (item 152).
          KOVAN_FOLDERS: JSON.stringify([cwd, ...extras.map((f) => f.path)]),
          // And the external reviewers this prompt asks for, with how each is
          // getting on (item 167): only those the prompt names.
          KOVAN_REVIEWERS: JSON.stringify(promptReviewers(this.host.config.get('runner.reviewers', [] as string[]), prompt))
        }
      : {};
    const result = await this.sessions.run({
      runner: extraArgs.length ? { ...base, leadingArgs: [...base.leadingArgs, ...extraArgs] } : base,
      prompt,
      cwd,
      title: `${request.kind} · ${subjectId}`,
      run,
      env: { ...env, ...status.env, ...goalEnv },
      statusSource: status.source
    });

    if ('error' in result) {
      return { ok: false, error: result.error };
    }
    this.host.log.info(`started ${request.kind} on ${subjectId} in ${cwd}${extras.length ? ` (+${extras.length} more)` : ''}`);
    return { ok: true, sessionId: result.id };
  }

  private async writeTicketFile(directory: string, subject: Subject): Promise<string | undefined> {
    const lines: string[] = [];
    if (subject.sentry) {
      const { issue, frames } = subject.sentry;
      lines.push(`# ${issue.shortId} — ${issue.title}`, '');
      lines.push(`Level: ${issue.level} · Culprit: ${issue.culprit || '(unknown)'}`);
      lines.push(`Seen ${issue.count} times, ${issue.userCount} users affected.`);
      lines.push(`First seen ${issue.firstSeen || 'unknown'}, last seen ${issue.lastSeen || 'unknown'}.`);
      lines.push(issue.permalink, '', '## Stack trace (outermost first, throw site last)', '');
      if (frames.length === 0) {
        lines.push('(no stack trace was available for the latest event)');
      } else {
        frames.forEach((f, i) => {
          const tag = f.inApp ? '' : '(dependency) ';
          const at = f.resolvedPath ?? f.filename ?? '(unknown file)';
          const line = f.lineNo && (f.resolvedPath ?? f.filename) ? `:${f.lineNo}` : '';
          const fn = f.function ? ` — ${f.function}` : '';
          lines.push(`${i + 1}. ${tag}${at}${line}${fn}`);
        });
      }
    }
    if (subject.issue) {
      lines.push(`# ${subject.issue.key} — ${subject.issue.summary}`, '');
      lines.push(`Status: ${subject.issue.status} · Type: ${subject.issue.issueType}`);
      lines.push(`URL: ${subject.issue.url}`, '', '## What was asked', '');
      lines.push(await externalizeImages(subject.issue.description || '(no description)', directory));
      if (subject.issue.comments.length > 0) {
        lines.push('', '## Comments', '');
        // Same cap as "Earlier runs" below: the last N, not the whole
        // history — a long-running ticket's early back-and-forth stops being
        // relevant, but every run against it used to pay to read it again.
        const recent = subject.issue.comments.slice(-TICKET_RECENT_COMMENTS);
        const omitted = subject.issue.comments.length - recent.length;
        // What "Condense" on the ticket pane made of the omitted ones, if
        // anybody clicked it. It covers the first `condensed` comments; any
        // that arrived after it was made are still just counted. Not when
        // Condense is turned off in Settings (item 124): off means unused.
        const condenseOn = this.host.config.get<boolean>('buttons.condense', true);
        const condensed = omitted > 0 && condenseOn ? await this.quick?.result('ticket-condense', subject.issue.key) : undefined;
        const covered = Math.min(condensed?.basis['condensed'] ?? 0, omitted);
        if (condensed && covered > 0) {
          lines.push('### Earlier discussion', '');
          lines.push(
            `_(${covered} earlier comment${covered === 1 ? '' : 's'}, condensed by a quick model (${condensed.model}) ` +
              'and may miss detail — the originals are on the ticket)_',
            '',
            condensed.text,
            ''
          );
          if (omitted > covered) {
            const rest = omitted - covered;
            lines.push(`_(${rest} further comment${rest === 1 ? '' : 's'} omitted)_`, '');
          }
          lines.push(`### Latest ${recent.length}`, '');
        } else if (omitted > 0) {
          lines.push(`_(${omitted} earlier comment${omitted === 1 ? '' : 's'} omitted)_`, '');
        }
        for (const c of recent) {
          lines.push(`**${c.author}** (${c.created})`, '', await externalizeImages(c.body, directory), '');
        }
      }
    }
    if (subject.pull) {
      lines.push('', `## Pull request ${subject.pull.repo}#${subject.pull.number}`, '');
      lines.push(subject.pull.title, subject.pull.url);
    }
    if (lines.length === 0) {
      return undefined;
    }

    const history = await this.store.list(this.subjectFor(subject.pull, subject.issue, subject.sentry?.issue));
    if (history.length > 0) {
      lines.push('', '## Earlier runs', '');
      for (const run of history.slice(0, 10)) {
        const when = new Date(run.startedAt).toISOString().slice(0, 16).replace('T', ' ');
        lines.push(`- ${when} · ${run.kind}${run.confidence ? ` · ${run.confidence}/100` : ''}`);
      }
    }

    const file = path.join(directory, 'ticket.md');
    await writeFile(file, lines.join('\n'), 'utf8');
    return file;
  }

  history(subject: string) {
    return this.store.list(subject);
  }

  /** Every file a run's directory actually contains, for the in-app viewer. */
  async runFiles(directory: string) {
    if (!this.store.owns(directory)) {
      throw new Error('Not a run directory.');
    }
    return this.store.files(directory);
  }

  /** Whether a path is inside the runs store — for the run folder watcher. */
  ownsRun(file: string): boolean {
    return this.store.owns(file);
  }

  /**
   * Opens the site a run checked on in the default browser (item 90, D).
   * The URL comes from the run's own run.json, never from the renderer, and
   * only http(s) is opened.
   */
  /**
   * Opens the page a run's agent was looking at (item 109) — the one in the
   * screenshot on screen when given, see `runPageUrl` — rather than the
   * environment's base address, which redirects a signed-in visitor to the
   * dashboard.
   */
  async openRunSite(directory: string, shot?: string): Promise<void> {
    if (!this.store.owns(directory)) throw new Error('Not a run directory.');
    const run = await this.store.read(directory);
    const site = run?.site;
    if (!site || !/^https?:\/\//i.test(site)) throw new Error('This run has no site to open.');
    const readOr = (file: string) => readFile(path.join(directory, file), 'utf8').catch(() => '');
    const url = runPageUrl({ site, pages: await readOr('pages.txt'), report: await readOr('report.md'), ...(shot ? { shot } : {}) });
    await openLink(url, (m) => this.host.log.warn(m));
  }

  /**
   * Shows a run's file (or folder) selected in Finder. Only inside the runs
   * store, like every other run IPC: the renderer names a path, and this must
   * not become a way to open Finder anywhere.
   */
  revealRunFile(file: string): void {
    if (!this.store.owns(file)) {
      throw new Error('Not a run file.');
    }
    shell.showItemInFolder(file);
  }

  /** A run's own report.md or prompt.md, read for the in-app viewer. */
  async readRunText(file: string): Promise<string> {
    if (!this.store.owns(file)) {
      throw new Error('Not a run file.');
    }
    return readFile(file, 'utf8');
  }

  /** A run's own screenshot, as a data URL the renderer can put straight in an `<img>`. */
  async readRunImage(file: string): Promise<string> {
    if (!this.store.owns(file)) {
      throw new Error('Not a run file.');
    }
    const bytes = await readFile(file);
    const ext = path.extname(file).slice(1).toLowerCase();
    const mime = ext === 'jpg' ? 'jpeg' : ext || 'png';
    return `data:image/${mime};base64,${bytes.toString('base64')}`;
  }

  private async sentryClient(): Promise<SentryClient> {
    const token = await this.host.secrets.get('sentry');
    const organization = this.host.config.get('sentry.organization', '');
    if (!token || !organization) {
      throw new Error('Sentry is not connected.');
    }
    return new SentryClient(this.http, this.host.config.get('sentry.baseUrl', 'https://sentry.io'), organization, token);
  }

  /**
   * One issue's latest stack trace, each frame placed on disk where possible.
   * `repoRoot` is the first watched folder — the same fallback `defaultCwd()`
   * uses, since a Sentry issue carries no repository hint of its own to match
   * a clone against.
   */
  async sentryFrames(issueId: string): Promise<SentryFrame[]> {
    const client = await this.sentryClient();
    const raw = await client.getLatestFrames(issueId);
    const repoRoot = await this.defaultCwd();
    return raw.map((f: RawSentryFrame) => {
      const resolvedPath =
        repoRoot && f.filename
          ? resolveFrame(f.filename, { repoRoot, mappings: [] })
          : undefined;
      return {
        filename: f.filename,
        function: f.function,
        lineNo: f.lineNo,
        colNo: f.colNo,
        inApp: isAppFrame(f),
        resolvedPath: resolvedPath && existsSync(resolvedPath) ? resolvedPath : undefined
      };
    });
  }

  /**
   * Files a Jira ticket from a Sentry issue — the other action the tab
   * offers besides starting an agent. Needs a default project, which is not
   * part of `CREDENTIAL_FIELDS.jira` (only "create ticket" needs it, so an
   * already-working Jira connection with no project set stays "connected").
   */
  async createTicketFromSentry(issue: SentryIssue): Promise<{ key: string; url: string }> {
    const projectKey = this.host.config.get('jira.projectKey', '');
    if (!projectKey) {
      throw new Error('No default Jira project set. Add one in Settings → Jira.');
    }
    const token = await this.host.secrets.get('jira');
    const site = this.host.config.get('jira.baseUrl', '');
    const email = this.host.config.get('jira.email', '');
    if (!token || !site || !email) {
      throw new Error('Jira is not connected.');
    }
    const description =
      `${issue.permalink}\n\n` +
      `Level: ${issue.level} · Culprit: ${issue.culprit || '(unknown)'}\n` +
      `Seen ${issue.count} times, ${issue.userCount} users affected.`;
    return new JiraClient(this.http, site, email, token).createIssue(
      projectKey,
      `[Sentry] ${issue.title}`,
      description
    );
  }
}

/** The runner with `--add-dir=<path>` per extra folder, when its CLI takes it. */
function withExtraDirs(runner: Runner, paths: string[]): Runner {
  const args = extraDirArgs(runner.command, paths);
  return args.length ? { ...runner, leadingArgs: [...runner.leadingArgs, ...args] } : runner;
}
